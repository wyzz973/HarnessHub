// SPDX-License-Identifier: MIT
/**
 * Conversation compaction (Magpie `gw/compacting.go` and the compaction part
 * of `gw/codex_backend.go`).
 *
 * - Agents compact a conversation by asking a model to summarize it with a
 *   prompt of their own; {@link isCompactionRequest} recognizes those prompts.
 * - Codex asks its backend for a compaction with a `compaction_trigger` input
 *   item and gets back a `compaction` item whose `encrypted_content` only that
 *   backend can read. For a HarnessHub model the gateway serves it: the
 *   trigger becomes Codex's own compaction prompt ({@link codexInput}), and
 *   the model's summary goes back as a `compaction` item marked as
 *   HarnessHub's (`hh1:` and the summary in base64, {@link CompactionReply}),
 *   which later requests turn back into the summary's text.
 * - Reasoning and compactions that one account or vendor sealed cannot be
 *   read by another: the gateway never relays what it encoded itself
 *   ({@link withoutOwnReasoning}), and a request whose sealed items an
 *   upstream refuses is sent to it again without them ({@link unsealed}).
 */
import { randomBytes } from "node:crypto";
import type { WireProtocol } from "@harnesshub/core/model-plane";
import { sse } from "./output.js";
import { SseSegmenter } from "./passthrough.js";
import { record } from "./protocol.js";
import { isEncodedReasoning } from "./reasoning.js";
import type { OutputTransform } from "./restore.js";

type Json = Record<string, unknown>;

/** The system prompts (or their start) of agents' compaction requests. */
export const COMPACT_SYSTEMS: readonly string[] = [
  // Claude Code 2.1, and OpenCode before its own compaction agent
  "You are a helpful AI assistant tasked with summarizing conversations.",
  // OpenCode's compaction agent (agent/prompt/compaction.txt)
  "You are a context summarization agent.",
  // Pi
  "You are a context summarization assistant.",
  // Gemini CLI
  "You are a specialized system component responsible for distilling chat history into a structured XML <state_snapshot>",
  // Qwen Code
  "You are the component that summarizes a conversation when its context window is about to overflow.",
];

/** Text in the last user message of agents' compaction requests. */
export const COMPACT_ASKS: readonly string[] = [
  // Claude Code's /compact and auto-compact
  "Your task is to create a detailed summary of the conversation so far",
  // Codex, and the gateway's own prompt for a Codex compaction_trigger
  "You are performing a CONTEXT CHECKPOINT COMPACTION.",
  // Kimi Code (prompts/compact.md)
  "You are now given a task to compact this conversation context",
];

/** Codex's compaction prompt (openai/codex, Apache-2.0, prompts/templates/compact). */
export const CODEX_COMPACT_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.`;

/** What precedes a compaction's summary when Codex resumes from it (openai/codex, Apache-2.0). */
export const CODEX_SUMMARY_PREFIX =
  "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:";

/** Why `/responses/compact` fails for a HarnessHub model (Magpie's wording). */
export const COMPACT_UNSUPPORTED =
  "/responses/compact is not supported for HarnessHub models; use a compaction_trigger on /responses";

/** Marks a compaction item the gateway made: its summary, which only the gateway reads. */
export const HH_COMPACTION = "hh1:";

/** Text of a message's content: a string, or the `text` of its parts. */
function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      const text = record(part)?.text;
      return typeof text === "string" ? text : "";
    })
    .join("\n");
}

function list(value: unknown): Json[] {
  return Array.isArray(value)
    ? value.map(record).filter((item): item is Json => item !== undefined)
    : [];
}

/** System text and last user message text of a request, by protocol. */
function compactionView(
  protocol: WireProtocol,
  raw: Json,
): { system: string[]; ask: string } {
  const system: string[] = [];
  let messages: Json[];
  let content: (message: Json) => unknown;
  let user: (message: Json) => boolean;
  switch (protocol) {
    case "chat":
      messages = list(raw.messages);
      content = (message) => message.content;
      user = (message) => message.role === "user";
      for (const message of messages)
        if (message.role === "system" || message.role === "developer")
          system.push(contentText(message.content));
      break;
    case "responses":
      if (typeof raw.input === "string")
        return {
          system: [contentText(raw.instructions)],
          ask: raw.input,
        };
      messages = list(raw.input).filter(
        (item) => (item.type ?? "message") === "message",
      );
      content = (message) => message.content;
      user = (message) => message.role === "user";
      system.push(contentText(raw.instructions));
      for (const message of messages)
        if (message.role === "system" || message.role === "developer")
          system.push(contentText(message.content));
      break;
    case "anthropic":
      messages = list(raw.messages);
      content = (message) => message.content;
      user = (message) => message.role === "user";
      system.push(contentText(raw.system));
      // Claude Code 2.1.2xx sends part of its system prompt inside messages.
      for (const message of messages)
        if (message.role === "system")
          system.push(contentText(message.content));
      break;
    case "gemini": {
      messages = list(raw.contents);
      content = (message) => message.parts;
      user = (message) => message.role === undefined || message.role === "user";
      const instruction = record(
        raw.systemInstruction ?? raw.system_instruction,
      );
      if (instruction) system.push(contentText(instruction.parts));
      break;
    }
  }
  const last = messages.findLast(user);
  return { system, ask: last ? contentText(content(last)) : "" };
}

/**
 * Whether `raw`, a request body of the inbound `protocol`, is an agent
 * compacting its conversation: its system prompt is (or starts like) one of
 * {@link COMPACT_SYSTEMS} (Claude Code, OpenCode, Pi, Gemini CLI, Qwen Code),
 * its last user message holds one of {@link COMPACT_ASKS} (Claude Code's
 * `/compact`, Codex, Kimi Code), or it is Codex's `compaction_trigger`. Pure;
 * a body of an unexpected shape is not one.
 */
export function isCompactionRequest(
  protocol: WireProtocol,
  raw: Json,
): boolean {
  if (
    protocol === "responses" &&
    list(raw.input).some((item) => item.type === "compaction_trigger")
  )
    return true;
  const { system, ask } = compactionView(protocol, raw);
  return (
    COMPACT_SYSTEMS.some((prompt) =>
      system.some((text) => text.includes(prompt)),
    ) || COMPACT_ASKS.some((prompt) => ask.includes(prompt))
  );
}

function userMessage(text: string): Json {
  return {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
  };
}

/** A Codex request as {@link codexInput} rewrote it. */
export interface CodexInput {
  raw: Json;
  /** A `compaction_trigger` became a request for a summary. */
  summary: boolean;
  /** Compaction items the gateway made, turned back into their summary. */
  restored: number;
}

/**
 * A Codex Responses request with the compactions the gateway made (`hh1:`)
 * turned back into a user message with the summary, after
 * {@link CODEX_SUMMARY_PREFIX}; other compactions stay as they are. With
 * `serve` (the model is HarnessHub's), a `compaction_trigger` becomes a user
 * message with {@link CODEX_COMPACT_PROMPT} and the request goes without its
 * tools, tool choice and parallel tool setting, since a tool call would be
 * no summary; the answer must then pass through {@link CompactionReply}.
 * Undefined when nothing changed.
 */
export function codexInput(raw: Json, serve: boolean): CodexInput | undefined {
  if (!Array.isArray(raw.input)) return undefined;
  let restored = 0;
  let summary = false;
  const input: unknown[] = [];
  for (const value of raw.input) {
    const item = record(value);
    const sealed = item?.encrypted_content;
    if (
      (item?.type === "compaction" || item?.type === "compaction_summary") &&
      typeof sealed === "string" &&
      sealed.startsWith(HH_COMPACTION)
    ) {
      restored++;
      const text = Buffer.from(
        sealed.slice(HH_COMPACTION.length),
        "base64",
      ).toString("utf8");
      if (text) input.push(userMessage(`${CODEX_SUMMARY_PREFIX}\n${text}`));
      continue;
    }
    if (serve && item?.type === "compaction_trigger") {
      summary = true;
      input.push(userMessage(CODEX_COMPACT_PROMPT));
      continue;
    }
    input.push(value);
  }
  if (!restored && !summary) return undefined;
  const next: Json = { ...raw, input };
  if (summary) {
    delete next.tools;
    delete next.tool_choice;
    delete next.parallel_tool_calls;
  }
  return { raw: next, summary, restored };
}

const MESSAGE_TEXT = new Set(["output_text", "text"]);

/** The text of the message items among Responses output items. */
function summaryText(items: readonly unknown[]): string {
  return list(items)
    .filter((item) => item.type === "message")
    .flatMap((item) => list(item.content))
    .filter((part) => MESSAGE_TEXT.has(String(part.type)))
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("");
}

/** The `compaction` item of a summary, its id after the response's. */
function compactionItem(responseId: unknown, summary: string): Json {
  const id =
    typeof responseId === "string" && responseId
      ? responseId.replace(/^resp_/, "")
      : `hh_${randomBytes(12).toString("hex")}`;
  return {
    type: "compaction",
    id: `cmp_${id}`,
    encrypted_content:
      HH_COMPACTION + Buffer.from(summary, "utf8").toString("base64"),
  };
}

/** Why a compaction the gateway serves fails when its model wrote no summary. */
export const COMPACTION_EMPTY = "compaction: the model wrote no summary";

/** The JSON data of one SSE event, or undefined. */
function eventData(raw: string): Json | undefined {
  const data = raw
    .split(/\r\n|\r|\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""));
  if (!data.length) return undefined;
  try {
    return record(JSON.parse(data.join("\n")));
  } catch {
    return undefined;
  }
}

/**
 * The summary in the answer to a compaction the gateway serves: the text of
 * the message items of its `response.output_item.done` events, else of the
 * terminal response's `output` (`response.completed`, `response.incomplete`
 * or a JSON response). The gateway reads the upstream's answer with it before
 * the call is recorded, and {@link CompactionReply} the client's.
 */
export class SummaryReader {
  #items: string[] = [];
  #output: unknown[] = [];

  /** One parsed Responses event, or a whole response. */
  take(value: Json): void {
    switch (value.type) {
      case "response.output_item.done": {
        const item = record(value.item);
        if (item?.type === "message") this.#items.push(summaryText([item]));
        return;
      }
      case "response.completed":
      case "response.incomplete":
        this.#output = list(record(value.response)?.output);
        return;
      case undefined:
        if (Array.isArray(value.output)) this.#output = value.output;
    }
  }

  /** One SSE event as it was sent, or a JSON response body. */
  read(text: string): void {
    let value: Json | undefined;
    if (text.trimStart().startsWith("{"))
      try {
        value = record(JSON.parse(text));
      } catch {
        value = undefined;
      }
    else value = eventData(text);
    if (value) this.take(value);
  }

  /** The summary read so far; blank when the model wrote none. */
  get text(): string {
    return this.#items.join("") || summaryText(this.#output);
  }
}

/**
 * The answer to a compaction the gateway serves ({@link codexInput}), as
 * ChatGPT's Codex backend answers it: the model's summary, read from its
 * message items, becomes one `compaction` item ({@link HH_COMPACTION} and
 * the summary in base64) in `response.output_item.added`,
 * `response.output_item.done` and `response.completed` with the model's
 * usage. In a stream, `response.created`, `response.in_progress`, failures
 * and comments pass at once and the model's own items are held back; a JSON
 * answer gets the item as its `output`. An answer that is not a Responses
 * stream or response (an error body) passes unchanged. The gateway fails a
 * call whose answer has no summary text before it is recorded (502
 * `compaction_empty`), so the client gets that failure, not an answer;
 * should one reach this transform all the same, it ends failed too.
 */
export class CompactionReply implements OutputTransform {
  #segmenter: SseSegmenter | undefined;
  #body = "";
  #decoder = new TextDecoder();
  #summary = new SummaryReader();
  #id: unknown;
  #terminal: Json | undefined;
  #events = 0;
  #failed = false;
  #sequence = 0;

  constructor(framing: "sse" | "json") {
    // Limits are the writer's own; upstream events are bounded already.
    if (framing === "sse") this.#segmenter = new SseSegmenter(64 * 1024 * 1024);
  }

  push(chunk: string | Uint8Array): string {
    if (!this.#segmenter) {
      this.#body +=
        typeof chunk === "string"
          ? chunk
          : this.#decoder.decode(chunk, { stream: true });
      return "";
    }
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    return this.#segmenter
      .push(bytes)
      .map((segment) => this.#event(segment.text))
      .join("");
  }

  end(): string {
    if (!this.#segmenter)
      return this.#json(this.#body + this.#decoder.decode());
    const rest = this.#segmenter
      .end()
      .map((segment) => this.#event(segment.text))
      .join("");
    if (this.#failed || this.#events === 0) return rest;
    const text = this.#summary.text;
    if (!text.trim())
      return (
        rest +
        this.#emit("response.failed", {
          response: {
            ...this.#terminal,
            ...(this.#id === undefined ? {} : { id: this.#id }),
            object: "response",
            status: "failed",
            output: [],
            error: { code: "server_error", message: COMPACTION_EMPTY },
          },
        })
      );
    const item = compactionItem(this.#id, text);
    return (
      rest +
      this.#emit("response.output_item.added", { output_index: 0, item }) +
      this.#emit("response.output_item.done", { output_index: 0, item }) +
      this.#emit("response.completed", {
        response: {
          ...this.#terminal,
          ...(this.#id === undefined ? {} : { id: this.#id }),
          object: "response",
          status: "completed",
          output: [item],
          error: null,
          incomplete_details: null,
        },
      })
    );
  }

  #emit(type: string, fields: Json): string {
    return sse({ type, sequence_number: this.#sequence++, ...fields }, type);
  }

  /** One SSE event: what passes now ("" while held). */
  #event(raw: string): string {
    const value = eventData(raw);
    if (!value) return raw;
    this.#events++;
    this.#summary.take(value);
    if (
      typeof value.sequence_number === "number" &&
      value.sequence_number >= this.#sequence
    )
      this.#sequence = value.sequence_number + 1;
    const response = record(value.response);
    if (response?.id !== undefined) this.#id = response.id;
    switch (value.type) {
      case "response.created":
      case "response.in_progress":
      case "response.queued":
        return raw;
      case "response.failed":
      case "error":
        this.#failed = true;
        return raw;
      case "response.completed":
      case "response.incomplete":
        this.#terminal = response;
        return "";
      default:
        return "";
    }
  }

  #json(body: string): string {
    let value: Json | undefined;
    try {
      value = record(JSON.parse(body));
    } catch {
      return body;
    }
    if (!value || !Array.isArray(value.output) || record(value.error))
      return body;
    this.#summary.take(value);
    const text = this.#summary.text;
    if (!text.trim())
      return JSON.stringify({
        ...value,
        status: "failed",
        output: [],
        error: { code: "server_error", message: COMPACTION_EMPTY },
      });
    return JSON.stringify({
      ...value,
      status: "completed",
      output: [compactionItem(value.id, text)],
      incomplete_details: null,
    });
  }
}

/**
 * What upstreams say when they cannot read reasoning or a compaction another
 * account or vendor sealed (OpenAI's `invalid_encrypted_content`, xAI's
 * "Could not decrypt the provided encrypted_content").
 */
const FOREIGN_SEAL =
  /invalid_encrypted_content|encrypted[ _]content.{0,80}could not be (?:verified|decrypted)|could not (?:decrypt|verify).{0,40}encrypted[ _]content/i;

/** Whether an upstream's error text refuses sealed reasoning or a compaction as another's. */
export function refusesSeal(text: string): boolean {
  return FOREIGN_SEAL.test(text);
}

const COMPACTION_KINDS = new Set(["compaction", "compaction_summary"]);

/**
 * A Responses request without the sealed items an upstream refused
 * ({@link refusesSeal}), for asking the same upstream again: at `step` 0 its
 * reasoning items, and refused again (or with no reasoning) its sealed
 * compactions. What was said and done stays; the model's notes to itself,
 * then the summary of earlier turns, go. Undefined when nothing is left to
 * take out; `step` of the result is the next call's.
 */
export function unsealed(
  raw: Json,
  step: number,
): { raw: Json; step: number; kind: "reasoning" | "compaction" } | undefined {
  if (!Array.isArray(raw.input)) return undefined;
  const without = (drop: (item: Json) => boolean) => {
    const input = raw.input as unknown[];
    const kept = input.filter((value) => {
      const item = record(value);
      return !item || !drop(item);
    });
    return kept.length < input.length ? { ...raw, input: kept } : undefined;
  };
  if (step === 0) {
    const next = without((item) => item.type === "reasoning");
    if (next) return { raw: next, step: 1, kind: "reasoning" };
  }
  if (step <= 1) {
    const next = without(
      (item) =>
        COMPACTION_KINDS.has(String(item.type)) &&
        typeof item.encrypted_content === "string" &&
        item.encrypted_content !== "",
    );
    if (next) return { raw: next, step: 2, kind: "compaction" };
  }
  return undefined;
}

/**
 * A Responses request body without the reasoning items whose
 * `encrypted_content` the gateway encoded itself (a translated answer's
 * reasoning, ./reasoning.js): no upstream sealed them, so one that checks
 * its seals refuses them. Undefined when there are none.
 */
export function withoutOwnReasoning(
  body: Buffer,
): { body: Buffer; dropped: number } | undefined {
  if (!body.includes('"hh-r1.')) return undefined;
  let request: Json | undefined;
  try {
    request = record(JSON.parse(body.toString("utf8")));
  } catch {
    return undefined;
  }
  if (!request || !Array.isArray(request.input)) return undefined;
  const input = request.input.filter((value) => {
    const item = record(value);
    return !(
      item?.type === "reasoning" && isEncodedReasoning(item.encrypted_content)
    );
  });
  const dropped = request.input.length - input.length;
  return dropped
    ? { body: Buffer.from(JSON.stringify({ ...request, input })), dropped }
    : undefined;
}
