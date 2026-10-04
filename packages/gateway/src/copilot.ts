// SPDX-License-Identifier: MIT
/**
 * GitHub Copilot accounts ([ADR 0026](../../../docs/decisions/0026-subscription-accounts.md)):
 * the gateway answers a Chat Completions request through a session of the
 * Copilot CLI the user installed, driven by GitHub's official Copilot SDK in
 * a host process the daemon owns ({@link CopilotRuntime}). The account is
 * the user's own `copilot` login or a fine-grained token the user created;
 * HarnessHub never reads the login and copies no other client's identity.
 *
 * A Copilot session keeps its own history, while a gateway request carries
 * the whole conversation. The bridge keeps each session after its answer,
 * indexed by a hash of the messages it holds as the client will send them
 * back; a request that extends those messages continues the session (new
 * user text becomes a prompt, tool results answer the session's pending tool
 * calls), and any other request opens a session whose first prompt holds
 * the earlier messages as a transcript (patch `copilot:transcript`). The
 * caller's system prompt replaces Copilot's own, the caller's functions are
 * the only tools, and a tool call ends the answer with `tool_calls` for the
 * caller to run, as an API would.
 */
import { createHash } from "node:crypto";
import type {
  AllowanceReading,
  ProviderConfig,
  ProviderCredential,
} from "@harnesshub/core/model-plane";

/**
 * The endpoint of a Copilot candidate. It is never fetched: the bridge
 * answers instead of an HTTP upstream.
 */
export const COPILOT_ENDPOINT = "copilot://local";

/**
 * Why a Copilot account cannot serve. `signed_out` (terminal): the login or
 * token is not valid for Copilot; the user signs in again. The others mean
 * the account's client is not available on this computer right now.
 */
export type CopilotErrorCode =
  | "sdk_missing"
  | "cli_missing"
  | "cli_unsupported"
  | "signed_out"
  | "unavailable";

export class CopilotError extends Error {
  constructor(
    message: string,
    readonly code: CopilotErrorCode,
  ) {
    super(message);
    this.name = "CopilotError";
  }
  /** The account must sign in again before it serves. */
  get terminal(): boolean {
    return this.code === "signed_out";
  }
}

export const copilotReasoningEfforts = [
  "low",
  "medium",
  "high",
  "xhigh",
] as const;
export type CopilotReasoningEffort = (typeof copilotReasoningEfforts)[number];

/** A caller's function, declared to the session without a handler. */
export interface CopilotTool {
  name: string;
  description?: string;
  /** JSON Schema of the arguments. */
  parameters?: Record<string, unknown>;
}

/** An image of a prompt, base64 encoded. */
export interface CopilotAttachment {
  data: string;
  mimeType: string;
}

export interface CopilotSessionOptions {
  /** Copilot's model ID. */
  model: string;
  /** The caller's system prompt, verbatim; it replaces Copilot's own. */
  system: string;
  tools: CopilotTool[];
  reasoningEffort?: CopilotReasoningEffort;
}

export interface CopilotToolRequest {
  toolCallId: string;
  name: string;
  /** The arguments as JSON text. */
  arguments: string;
}

export interface CopilotUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
}

/**
 * What a session reports, in order. `message` ends one model answer (its
 * text was already sent as `delta`s when it streamed); `tool` is the
 * session waiting for the result of one of its tool requests; `idle` ends
 * the turn; `closed` means the session or its client is gone.
 */
export type CopilotEvent =
  | { type: "delta"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "message"; text: string; toolRequests: CopilotToolRequest[] }
  | { type: "tool"; requestId: string; toolCallId: string }
  | { type: "usage"; usage: CopilotUsage }
  | { type: "error"; message: string; status?: number; code?: string }
  | { type: "idle"; aborted: boolean }
  | { type: "closed"; message: string };

/** One open Copilot session of an account. */
export interface CopilotSession {
  /** Receives every event, starting with any that came before it was set. Set once. */
  listen(handler: (event: CopilotEvent) => void): void;
  /** Adds a user prompt; resolves once the session accepted it. */
  send(prompt: string, attachments: CopilotAttachment[]): Promise<void>;
  /** Resolves a pending tool request with the caller's result. */
  answer(
    requestId: string,
    result: { text: string } | { error: string },
  ): Promise<void>;
  /** Stops the current turn. */
  abort(): Promise<void>;
  /** Ends the session and frees it; idempotent, never rejects. */
  close(): Promise<void>;
}

/**
 * The Copilot client of each account, as the daemon provides it. Errors that
 * keep an account from serving are {@link CopilotError}s.
 */
export interface CopilotRuntime {
  /** Opens a session; rejects with CopilotError, or an AbortError when `signal` aborts. */
  open(
    provider: ProviderConfig,
    credential: ProviderCredential,
    options: CopilotSessionOptions,
    signal: AbortSignal,
  ): Promise<CopilotSession>;
  /** The account's allowance windows from Copilot's own quota report. */
  quota(
    provider: ProviderConfig,
    credential: ProviderCredential,
  ): Promise<AllowanceReading[]>;
}

/** One gateway attempt on a Copilot candidate. */
export interface CopilotRequest {
  provider: ProviderConfig;
  credential: ProviderCredential;
  /** The normalized Chat Completions request. */
  body: string;
  /** Aborts the turn while it runs; ignored once the answer ended. */
  signal: AbortSignal;
  /** Receives the account's allowance readings after an answer. */
  report(readings: AllowanceReading[]): void;
  /** Records a request patch in the ledger (`copilot:transcript`). */
  patch(name: string): void;
}

/** Request fields a Copilot session takes; the others are not sent. */
const TAKEN = new Set([
  "model",
  "messages",
  "stream",
  "stream_options",
  "tools",
  "reasoning_effort",
]);

/** Fields of a normalized Chat request that a Copilot answer ignores, for the ledger's `unmapped[]`. */
export function copilotUnmapped(body: Record<string, unknown>): string[] {
  const unmapped = Object.keys(body).filter(
    (key) => !TAKEN.has(key) && body[key] !== undefined && body[key] !== null,
  );
  // `auto` is what a session does anyway.
  return unmapped.filter(
    (key) => key !== "tool_choice" || body.tool_choice !== "auto",
  );
}

/** Idle sessions close after this long without a request. */
export const COPILOT_SESSION_IDLE_MS = 10 * 60_000;
/** Idle sessions kept per account; the least recently used closes first. */
export const COPILOT_SESSIONS_PER_ACCOUNT = 8;
/** How long an answer that ends with tool calls waits for their requests. */
const TOOL_GRACE_MS = 2_000;
/** Quota is read at most this often per account. */
const QUOTA_EVERY_MS = 60_000;

type Item =
  | { role: "user"; text: string; images: CopilotAttachment[] }
  | {
      role: "assistant";
      text: string;
      calls: CopilotToolRequest[];
    }
  | { role: "tool"; id: string; text: string };

interface Parsed {
  model: string;
  stream: boolean;
  options: CopilotSessionOptions;
  items: Item[];
}

type Out =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tools"; calls: CopilotToolRequest[] }
  | { kind: "error"; status: number; code: string; message: string }
  | { kind: "end"; finish: "stop" | "tool_calls"; usage: CopilotUsage };

interface Live {
  account: string;
  session: CopilotSession;
  queue: CopilotEvent[];
  wake: (() => void) | undefined;
  /** Hash of the options and messages the session holds; its index key when idle. */
  chain: string;
  /** Tool calls the session waits for: tool call ID to its request ID once known. */
  pending: Map<string, string | undefined>;
  /** Results that came before their request, by tool call ID. */
  early: Map<string, string>;
  dead: boolean;
  timer: NodeJS.Timeout | undefined;
}

class BadRequest extends Error {}

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const hash = (text: string) =>
  createHash("sha256").update(text).digest("base64url");

/** Keys sorted at every level, for comparing JSON values. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (object(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/** Arguments compared as JSON when they parse, else as trimmed text. */
function sameArguments(text: string): string {
  try {
    return stable(JSON.parse(text));
  } catch {
    return text.trim();
  }
}

/** The text of a message's content: a string, or its text parts joined. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      object(part) && part.type === "text" && typeof part.text === "string"
        ? part.text
        : "",
    )
    .filter(Boolean)
    .join("\n");
}

function imagesOf(content: unknown): CopilotAttachment[] {
  if (!Array.isArray(content)) return [];
  const images: CopilotAttachment[] = [];
  for (const part of content) {
    if (!object(part) || part.type !== "image_url") continue;
    const url = object(part.image_url) ? part.image_url.url : part.image_url;
    const match =
      typeof url === "string"
        ? /^data:(image\/[\w.+-]+);base64,(.+)$/s.exec(url)
        : null;
    if (!match)
      throw new BadRequest(
        "Copilot accounts take images only as base64 data URLs",
      );
    images.push({ mimeType: match[1]!, data: match[2]! });
  }
  return images;
}

/** The request as a session takes it; throws BadRequest for what it cannot. */
function parse(body: string): Parsed {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    throw new BadRequest("The request is not JSON");
  }
  if (!object(raw) || typeof raw.model !== "string" || !raw.model)
    throw new BadRequest("The request names no model");
  if (!Array.isArray(raw.messages))
    throw new BadRequest("The request has no messages");
  const system: string[] = [];
  const items: Item[] = [];
  for (const message of raw.messages) {
    if (!object(message)) throw new BadRequest("A message is not an object");
    switch (message.role) {
      case "system":
      case "developer":
        system.push(textOf(message.content));
        break;
      case "user":
        items.push({
          role: "user",
          text: textOf(message.content),
          images: imagesOf(message.content),
        });
        break;
      case "assistant": {
        const calls: CopilotToolRequest[] = [];
        for (const call of Array.isArray(message.tool_calls)
          ? message.tool_calls
          : []) {
          const fn = object(call) ? call.function : undefined;
          if (
            !object(call) ||
            typeof call.id !== "string" ||
            !object(fn) ||
            typeof fn.name !== "string"
          )
            throw new BadRequest("A tool call has no ID or name");
          calls.push({
            toolCallId: call.id,
            name: fn.name,
            arguments: typeof fn.arguments === "string" ? fn.arguments : "{}",
          });
        }
        items.push({ role: "assistant", text: textOf(message.content), calls });
        break;
      }
      case "tool":
        if (typeof message.tool_call_id !== "string")
          throw new BadRequest("A tool result has no tool_call_id");
        items.push({
          role: "tool",
          id: message.tool_call_id,
          text: textOf(message.content),
        });
        break;
      default:
        throw new BadRequest(
          `Copilot accounts do not take ${JSON.stringify(message.role)} messages`,
        );
    }
  }
  const tools: CopilotTool[] = [];
  for (const tool of Array.isArray(raw.tools) ? raw.tools : []) {
    const fn = object(tool) ? tool.function : undefined;
    if (!object(tool) || tool.type !== "function" || !object(fn)) continue;
    if (typeof fn.name !== "string") throw new BadRequest("A tool has no name");
    tools.push({
      name: fn.name,
      ...(typeof fn.description === "string"
        ? { description: fn.description }
        : {}),
      ...(object(fn.parameters) ? { parameters: fn.parameters } : {}),
    });
  }
  const effort = copilotReasoningEfforts.find(
    (value) => value === raw.reasoning_effort,
  );
  return {
    model: raw.model,
    stream: raw.stream === true,
    options: {
      model: raw.model,
      system: system.filter(Boolean).join("\n\n"),
      tools,
      ...(effort ? { reasoningEffort: effort } : {}),
    },
    items,
  };
}

/** How an item is recognized when a client sends it back. */
function fingerprint(item: Item): string {
  switch (item.role) {
    case "user":
      return stable(["u", item.text, item.images.map((i) => hash(i.data))]);
    case "assistant":
      return stable([
        "a",
        item.text.trim(),
        item.calls.map((call) => [
          call.toolCallId,
          call.name,
          sameArguments(call.arguments),
        ]),
      ]);
    case "tool":
      return stable(["t", item.id, item.text]);
  }
}

/** Earlier messages as one prompt, for a session that did not hold them. */
function transcript(items: Item[]): string {
  const lines = ["<transcript>"];
  for (const item of items)
    switch (item.role) {
      case "user":
        lines.push("<user>", item.text, "</user>");
        break;
      case "assistant":
        lines.push("<assistant>");
        if (item.text) lines.push(item.text);
        for (const call of item.calls)
          lines.push(
            `<tool_call id=${JSON.stringify(call.toolCallId)} name=${JSON.stringify(call.name)}>${call.arguments}</tool_call>`,
          );
        lines.push("</assistant>");
        break;
      case "tool":
        lines.push(
          `<tool_result id=${JSON.stringify(item.id)}>`,
          item.text,
          "</tool_result>",
        );
        break;
    }
  lines.push("</transcript>");
  return lines.join("\n");
}

/** What a turn does first on its session. */
type Action =
  | { kind: "prompt"; prompt: string; images: CopilotAttachment[] }
  | {
      kind: "results";
      results: Map<string, string>;
      prompt?: { prompt: string; images: CopilotAttachment[] };
    };

function userPrompt(items: Item[]): {
  prompt: string;
  images: CopilotAttachment[];
} {
  const users = items.filter(
    (item): item is Extract<Item, { role: "user" }> => item.role === "user",
  );
  return {
    prompt: users.map((item) => item.text).join("\n\n"),
    images: users.flatMap((item) => item.images),
  };
}

/** The action that continues a session holding everything before `delta`, or undefined. */
function continuation(live: Live, delta: Item[]): Action | undefined {
  if (!delta.length) return undefined;
  if (live.pending.size) {
    const results = new Map<string, string>();
    let index = 0;
    for (; index < delta.length; index++) {
      const item = delta[index]!;
      if (item.role !== "tool") break;
      if (!live.pending.has(item.id) || results.has(item.id)) return undefined;
      results.set(item.id, item.text);
    }
    if (results.size !== live.pending.size) return undefined;
    const rest = delta.slice(index);
    if (rest.some((item) => item.role !== "user")) return undefined;
    return {
      kind: "results",
      results,
      ...(rest.length ? { prompt: userPrompt(rest) } : {}),
    };
  }
  if (delta.some((item) => item.role !== "user")) return undefined;
  return { kind: "prompt", ...userPrompt(delta) };
}

const chunkOf = (
  id: string,
  model: string,
  created: number,
  delta: Record<string, unknown>,
  finish: string | null = null,
) => ({
  id,
  object: "chat.completion.chunk",
  created,
  model,
  choices: [{ index: 0, delta, finish_reason: finish }],
});

/**
 * Chat usage of an answer. Copilot's input and output counts are taken as
 * totals, as Chat reports them, with cache and reasoning as their parts.
 */
function chatUsage(usage: CopilotUsage) {
  const prompt = usage.input ?? 0;
  const completion = usage.output ?? 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    ...(usage.cacheRead !== undefined
      ? { prompt_tokens_details: { cached_tokens: usage.cacheRead } }
      : {}),
    ...(usage.cacheWrite !== undefined
      ? { cache_creation_input_tokens: usage.cacheWrite }
      : {}),
    ...(usage.reasoning !== undefined
      ? { completion_tokens_details: { reasoning_tokens: usage.reasoning } }
      : {}),
  };
}

const toolCalls = (calls: CopilotToolRequest[]) =>
  calls.map((call, index) => ({
    index,
    id: call.toolCallId,
    type: "function",
    function: { name: call.name, arguments: call.arguments },
  }));

function errorResponse(
  status: number,
  code: string,
  message: string,
): Response {
  return Response.json({ error: { message, type: code, code } }, { status });
}

/** The status of a session error: its own, else by its kind. */
function errorStatus(event: Extract<CopilotEvent, { type: "error" }>): number {
  if (event.status && event.status >= 400 && event.status < 600)
    return event.status;
  const kind = `${event.code ?? ""} ${event.message}`;
  if (/quota|limit|too many|exceeded|allowance/i.test(kind)) return 429;
  if (/unauthori[sz]ed|authenticat|token/i.test(kind)) return 401;
  if (/forbidden|entitle|policy|not enabled|access/i.test(kind)) return 403;
  return 502;
}

const abortError = () =>
  new DOMException("The Copilot turn was cancelled", "AbortError");

/**
 * Answers Chat Completions requests with Copilot sessions and owns them:
 * idle sessions wait for the next request of their conversation and close
 * after {@link COPILOT_SESSION_IDLE_MS}; {@link close} ends them all.
 */
export class CopilotBridge {
  #idle = new Map<string, Live>();
  #lives = new Set<Live>();
  #quotaAt = new Map<string, number>();
  #work = new Set<Promise<unknown>>();
  #closed = false;

  constructor(
    private readonly runtime: CopilotRuntime,
    private readonly clock: () => number = Date.now,
  ) {}

  /**
   * Answers one request as an OpenAI-compatible upstream would: a Chat
   * Completions SSE stream when the request streams, else a JSON
   * completion; a session error before any output is an error response
   * with its status. Rejects with CopilotError when the account cannot
   * serve, and with an AbortError when `signal` aborts first.
   */
  async complete(request: CopilotRequest): Promise<Response> {
    if (this.#closed)
      throw new CopilotError("The gateway is stopping", "unavailable");
    let parsed: Parsed;
    try {
      parsed = parse(request.body);
    } catch (error) {
      if (!(error instanceof BadRequest)) throw error;
      return errorResponse(400, "invalid_request_error", error.message);
    }
    const account = `${request.provider.id}\u0000${request.credential.id}`;
    const base = hash(stable([account, parsed.options]));
    const chains: string[] = [];
    let chain = base;
    for (const item of parsed.items)
      chains.push((chain = hash(`${chain}\n${fingerprint(item)}`)));
    let live: Live | undefined;
    let action: Action | undefined;
    for (let index = chains.length - 1; index >= 0 && !live; index--) {
      const found = this.#idle.get(chains[index]!);
      if (!found || found.dead) continue;
      action = continuation(found, parsed.items.slice(index + 1));
      if (action) {
        live = found;
        this.#take(found);
      }
    }
    if (!live) {
      const session = await this.runtime.open(
        request.provider,
        request.credential,
        parsed.options,
        request.signal,
      );
      live = this.#adopt(account, session);
      const last = parsed.items.findLastIndex((item) => item.role !== "user");
      const latest = userPrompt(parsed.items.slice(last + 1));
      const earlier = parsed.items.slice(0, last + 1);
      if (earlier.length) request.patch("copilot:transcript");
      action = {
        kind: "prompt",
        prompt: earlier.length
          ? `${transcript(earlier)}\n\n${latest.prompt || "Continue from the transcript above."}`
          : latest.prompt,
        images: latest.images,
      };
    }
    const turn = this.#turn(live, action!, request.signal);
    const created = Math.floor(this.clock() / 1000);
    const id = `chatcmpl-copilot-${hash(`${chain}${this.clock()}`).slice(0, 24)}`;
    const answer = { text: "", calls: [] as CopilotToolRequest[] };
    const settle = (finish: "stop" | "tool_calls") => {
      // The session now holds this answer too, as the client will send it back.
      live.chain = hash(
        `${chain}\n${fingerprint({ role: "assistant", ...answer })}`,
      );
      this.#park(live);
      this.#readQuota(request);
      return finish;
    };
    const first = await turn.next();
    if (first.done) throw new Error("A Copilot turn ended without output");
    if (first.value.kind === "error") {
      await turn.return(undefined);
      return errorResponse(
        first.value.status,
        first.value.code,
        first.value.message,
      );
    }
    if (!parsed.stream) {
      const reasoning: string[] = [];
      let usage: CopilotUsage = {};
      let finish: "stop" | "tool_calls" = "stop";
      for (
        let next: IteratorResult<Out, void> = first;
        !next.done;
        next = await turn.next()
      ) {
        const out = next.value;
        if (out.kind === "text") answer.text += out.text;
        else if (out.kind === "reasoning") reasoning.push(out.text);
        else if (out.kind === "tools") answer.calls.push(...out.calls);
        else if (out.kind === "error")
          return errorResponse(out.status, out.code, out.message);
        else {
          usage = out.usage;
          finish = settle(out.finish);
        }
      }
      return Response.json({
        id,
        object: "chat.completion",
        created,
        model: parsed.model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: answer.text || null,
              ...(reasoning.length
                ? { reasoning_content: reasoning.join("") }
                : {}),
              ...(answer.calls.length
                ? { tool_calls: toolCalls(answer.calls) }
                : {}),
            },
            finish_reason: finish,
          },
        ],
        usage: chatUsage(usage),
      });
    }
    const encoder = new TextEncoder();
    const data = (value: unknown) =>
      encoder.encode(`data: ${JSON.stringify(value)}\n\n`);
    let pending: IteratorResult<Out, void> | undefined = first;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          data(chunkOf(id, parsed.model, created, { role: "assistant" })),
        );
      },
      async pull(controller) {
        const next = pending ?? (await turn.next());
        pending = undefined;
        if (next.done) {
          controller.close();
          return;
        }
        const out = next.value;
        const chunk = (delta: Record<string, unknown>, finish?: string) =>
          controller.enqueue(
            data(chunkOf(id, parsed.model, created, delta, finish ?? null)),
          );
        switch (out.kind) {
          case "text":
            answer.text += out.text;
            chunk({ content: out.text });
            break;
          case "reasoning":
            chunk({ reasoning_content: out.text });
            break;
          case "tools":
            answer.calls.push(...out.calls);
            chunk({ tool_calls: toolCalls(out.calls) });
            break;
          case "error":
            controller.enqueue(
              data({
                error: {
                  message: out.message,
                  type: out.code,
                  code: out.status,
                },
              }),
            );
            controller.close();
            break;
          case "end":
            chunk({}, settle(out.finish));
            controller.enqueue(
              data({
                id,
                object: "chat.completion.chunk",
                created,
                model: parsed.model,
                choices: [],
                usage: chatUsage(out.usage),
              }),
            );
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
            break;
        }
      },
      async cancel() {
        await turn.return(undefined);
      },
    });
    return new Response(stream, {
      headers: { "content-type": "text/event-stream" },
    });
  }

  /** Track a newly opened session. */
  #adopt(account: string, session: CopilotSession): Live {
    const live: Live = {
      account,
      session,
      queue: [],
      wake: undefined,
      chain: "",
      pending: new Map(),
      early: new Map(),
      dead: false,
      timer: undefined,
    };
    this.#lives.add(live);
    session.listen((event) => {
      if (event.type === "closed") this.#bury(live);
      live.queue.push(event);
      const wake = live.wake;
      live.wake = undefined;
      wake?.();
    });
    return live;
  }

  /** Take an idle session for a request. */
  #take(live: Live): void {
    this.#idle.delete(live.chain);
    clearTimeout(live.timer);
    live.timer = undefined;
  }

  /** Index a session that answered, for the next request of its conversation. */
  #park(live: Live): void {
    if (live.dead || this.#closed) {
      this.#end(live);
      return;
    }
    const replaced = this.#idle.get(live.chain);
    if (replaced && replaced !== live) this.#end(replaced);
    this.#idle.set(live.chain, live);
    live.timer = setTimeout(() => this.#end(live), COPILOT_SESSION_IDLE_MS);
    live.timer.unref();
    const mine = [...this.#idle.values()].filter(
      (item) => item.account === live.account,
    );
    // Map order is insertion order: the first are the least recently used.
    for (const old of mine.slice(0, -COPILOT_SESSIONS_PER_ACCOUNT))
      this.#end(old);
  }

  /** The session can no longer be continued. */
  #bury(live: Live): void {
    live.dead = true;
    if (this.#idle.get(live.chain) === live) this.#end(live);
  }

  /** Close a session and forget it; a turn still waiting on it ends. */
  #end(live: Live): void {
    live.dead = true;
    clearTimeout(live.timer);
    if (this.#idle.get(live.chain) === live) this.#idle.delete(live.chain);
    if (!this.#lives.delete(live)) return;
    live.queue.push({ type: "closed", message: "The Copilot session closed" });
    const wake = live.wake;
    live.wake = undefined;
    wake?.();
    this.#own(live.session.close());
  }

  #own(work: Promise<unknown>): void {
    const tracked = work.catch(() => undefined);
    this.#work.add(tracked);
    void tracked.finally(() => this.#work.delete(tracked));
  }

  /** The next event, or undefined at `until`. Rejects when `signal` aborts. */
  #next(
    live: Live,
    signal: AbortSignal,
    until?: number,
  ): Promise<CopilotEvent | undefined> {
    const queued = live.queue.shift();
    if (queued) return Promise.resolve(queued);
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const timer =
        until === undefined
          ? undefined
          : setTimeout(
              () => done(undefined),
              Math.max(0, until - this.clock()),
            );
      const onAbort = () => {
        cleanup();
        reject(abortError());
      };
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        live.wake = undefined;
      };
      const done = (event: CopilotEvent | undefined) => {
        cleanup();
        resolve(event);
      };
      live.wake = () => done(live.queue.shift());
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  /**
   * Record a tool request, which may come before the message that made it;
   * answers it at once when its result came first.
   */
  async #requested(
    live: Live,
    event: Extract<CopilotEvent, { type: "tool" }>,
  ): Promise<void> {
    const early = live.early.get(event.toolCallId);
    if (early !== undefined) {
      live.early.delete(event.toolCallId);
      live.pending.delete(event.toolCallId);
      await live.session.answer(event.requestId, { text: early });
    } else live.pending.set(event.toolCallId, event.requestId);
  }

  /**
   * One answer: performs the action, then turns the session's events into
   * output until the turn ends or stops at tool calls. A failure or an abort
   * closes the session.
   */
  async *#turn(
    live: Live,
    action: Action,
    signal: AbortSignal,
  ): AsyncGenerator<Out, void> {
    let ended = false;
    const usage: CopilotUsage = {};
    const add = (more: CopilotUsage) => {
      for (const key of [
        "input",
        "output",
        "cacheRead",
        "cacheWrite",
        "reasoning",
      ] as const)
        if (more[key] !== undefined) usage[key] = (usage[key] ?? 0) + more[key];
    };
    try {
      if (action.kind === "results") {
        for (const [toolCallId, text] of action.results) {
          const requestId = live.pending.get(toolCallId);
          if (requestId === undefined) live.early.set(toolCallId, text);
          else {
            live.pending.delete(toolCallId);
            await live.session.answer(requestId, { text });
          }
        }
        if (action.prompt)
          await live.session.send(action.prompt.prompt, action.prompt.images);
      } else await live.session.send(action.prompt, action.images);
      let streamed = false;
      let waiting: Set<string> | undefined;
      let until: number | undefined;
      for (;;) {
        const event = await this.#next(live, signal, until);
        if (!event) break; // tool request grace over
        switch (event.type) {
          case "delta":
            streamed = true;
            if (event.text) yield { kind: "text", text: event.text };
            break;
          case "reasoning":
            if (event.text) yield { kind: "reasoning", text: event.text };
            break;
          case "message":
            if (!streamed && event.text)
              yield { kind: "text", text: event.text };
            streamed = false;
            if (event.toolRequests.length) {
              for (const call of event.toolRequests)
                if (!live.pending.has(call.toolCallId))
                  live.pending.set(call.toolCallId, undefined);
              yield { kind: "tools", calls: event.toolRequests };
              waiting = new Set(
                event.toolRequests.map((call) => call.toolCallId),
              );
              for (const [id, requestId] of live.pending)
                if (requestId !== undefined) waiting.delete(id);
              until = this.clock() + TOOL_GRACE_MS;
            }
            break;
          case "tool":
            await this.#requested(live, event);
            waiting?.delete(event.toolCallId);
            break;
          case "usage":
            add(event.usage);
            break;
          case "error":
            yield {
              kind: "error",
              status: errorStatus(event),
              code: event.code ?? "copilot_error",
              message: event.message,
            };
            return;
          case "idle":
            if (event.aborted) {
              yield {
                kind: "error",
                status: 502,
                code: "copilot_aborted",
                message: "The Copilot turn was stopped",
              };
              return;
            }
            if (live.pending.size) break; // waits for the caller's results
            ended = true;
            yield { kind: "end", finish: "stop", usage };
            return;
          case "closed":
            yield {
              kind: "error",
              status: 502,
              code: "copilot_closed",
              message: event.message,
            };
            return;
        }
        if (waiting && waiting.size === 0) break;
      }
      ended = true;
      yield { kind: "end", finish: "tool_calls", usage };
    } finally {
      if (!ended) {
        // Cancelled, failed or not read to the end: the session's state is unknown.
        live.dead = true;
        this.#own(live.session.abort());
        this.#end(live);
      }
    }
  }

  /** Read the account's quota after an answer, at most once a minute. */
  #readQuota(request: CopilotRequest): void {
    const account = `${request.provider.id}\u0000${request.credential.id}`;
    const now = this.clock();
    if (now - (this.#quotaAt.get(account) ?? -Infinity) < QUOTA_EVERY_MS)
      return;
    this.#quotaAt.set(account, now);
    this.#own(
      this.runtime
        .quota(request.provider, request.credential)
        .then((readings) => request.report(readings)),
    );
  }

  /** Close every session and wait for the work in flight. Idempotent. */
  async close(): Promise<void> {
    this.#closed = true;
    for (const live of [...this.#lives]) this.#end(live);
    while (this.#work.size) await Promise.all([...this.#work]);
  }
}
