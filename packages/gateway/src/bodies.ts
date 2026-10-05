// SPDX-License-Identifier: MIT
/**
 * A call's request and reply for an opt-in export (Magpie's OTLP `bodies`,
 * #538), so a tool such as Langfuse shows what was asked and answered. Off
 * unless the handler's `calls.bodies()` says so; never written to the
 * ledger. Both are masked by the handler's redactor (its known secrets and
 * the user's rules, whether or not outbound redaction is on) and cut at
 * {@link BODY_LIMIT} bytes each, as Magpie cuts its captures.
 */
import type { ModelCallEntry } from "@harnesshub/core/model-plane";
import type { RedactionRule } from "@harnesshub/core/gateway-features";
import type { HttpWriter } from "./output.js";
import type { Redactor } from "./redaction.js";

/** How much of a request, and of a reply as written, is kept: Magpie's 256 KiB. */
export const BODY_LIMIT = 256 * 1024;

/** Ends a body the gateway kept only the start of. */
export const BODY_CUT = "\n… (cut here by HarnessHub)";

/** A call's bodies as an export sends them; the caller must treat both as prompt content. */
export interface CallBodies {
  /** The client's request, masked; JSON is written again after masking. */
  request: string;
  /** A streamed reply's text put together from its events, or the reply as it came; masked. */
  reply: string;
}

/**
 * Sees each call the ledger accepted (the daemon's OTLP export). Must not
 * throw or wait; a failure is logged and dropped.
 */
export interface CommittedCalls {
  /** Read once as each model call starts: whether to keep its request and reply. */
  bodies(): boolean;
  /**
   * One entry the ledger accepted, once. With bodies kept, called after the
   * call's response closed, so the reply is whole; otherwise right after the
   * commit. Entries the ledger rejected are never handed over.
   */
  committed(entry: ModelCallEntry, bodies?: CallBodies): void;
}

/** What a committed call's bodies are read from: its request and its tapped writer. */
export interface BodySource {
  bytes: Buffer;
  writer: HttpWriter;
  /** Resolves when the response ended or the connection went away. */
  closed: Promise<void>;
}

/**
 * `text` cut to {@link BODY_LIMIT} bytes and marked, also when it was cut
 * before (`alreadyCut`); a character broken by the cut is left out.
 */
function cut(text: string, alreadyCut = false): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= BODY_LIMIT && !alreadyCut) return text;
  const kept = bytes.subarray(0, BODY_LIMIT).toString("utf8");
  return `${kept.replace(/�+$/, "")}${BODY_CUT}`;
}

/** The deltas' text of one server-sent event of any inbound protocol, or undefined. */
function eventText(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const event = data as Record<string, unknown>;
  let text = "";
  // Chat Completions: choices[].delta.content.
  if (Array.isArray(event.choices))
    for (const choice of event.choices) {
      const content = (choice as { delta?: { content?: unknown } } | null)
        ?.delta?.content;
      if (typeof content === "string") text += content;
    }
  // Responses: response.output_text.delta; Anthropic: content_block_delta's text.
  if (
    event.type === "response.output_text.delta" &&
    typeof event.delta === "string"
  )
    text += event.delta;
  if (event.type === "content_block_delta") {
    const delta = event.delta as { text?: unknown } | null;
    if (typeof delta?.text === "string") text += delta.text;
  }
  // Gemini: candidates[].content.parts[].text, thoughts left out.
  if (Array.isArray(event.candidates))
    for (const candidate of event.candidates) {
      const parts = (candidate as { content?: { parts?: unknown } } | null)
        ?.content?.parts;
      if (Array.isArray(parts))
        for (const part of parts) {
          const value = part as { text?: unknown; thought?: unknown } | null;
          if (typeof value?.text === "string" && value.thought !== true)
            text += value.text;
        }
    }
  return text || undefined;
}

/**
 * A streamed reply's text put together from its events (Magpie's
 * `otelReplyText`, plus Gemini), so a trace shows what the model wrote
 * rather than hundreds of events. A reply that is not a stream, or a stream
 * with no text (only tool calls), is returned as it came.
 */
export function replyText(body: string): string {
  if (!body.includes("data:")) return body;
  let text = "";
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    let data: unknown;
    try {
      data = JSON.parse(trimmed.slice(5).trim());
    } catch {
      continue;
    }
    text += eventText(data) ?? "";
  }
  return text || body;
}

/**
 * The bodies of a committed call: its request masked (as JSON when it is
 * JSON), its reply's text masked, each cut at {@link BODY_LIMIT}.
 */
export function callBodies(
  source: BodySource,
  redactor: Redactor,
  rules: readonly RedactionRule[],
): CallBodies {
  const raw = source.bytes.toString("utf8");
  let request: string;
  try {
    request = JSON.stringify(
      redactor.maskJson(JSON.parse(raw) as unknown, rules).value,
    );
  } catch {
    request = redactor.mask(raw, rules).text;
  }
  const tapped = source.writer.tapped;
  const reply = tapped
    ? redactor.mask(replyText(tapped.body.toString("utf8")), rules).text
    : "";
  return {
    request: cut(request),
    reply: cut(reply, tapped?.cut === true),
  };
}
