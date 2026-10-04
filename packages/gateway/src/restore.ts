// SPDX-License-Identifier: MIT
/**
 * Putting redacted secrets back where a tool needs them: in what the gateway
 * writes to the client, placeholders that the model echoed into a tool
 * call's arguments become their values again, so the tool runs with the real
 * secret. Text the model writes for people keeps the placeholders. Works on
 * the client's protocol as it is written (translated or passed through):
 * Chat `tool_calls[].function.arguments`, Responses function and custom tool
 * call arguments, Anthropic `tool_use` input and `input_json_delta`, Gemini
 * `functionCall.args`.
 *
 * Streamed arguments arrive in fragments, and a placeholder may be split
 * between two; a fragment that ends in what may be the start of one is held
 * back until the next fragment of the same call, and anything still held
 * when the call ends is written before its end.
 */
import type { WireProtocol } from "@harnesshub/core/model-plane";
import { ArraySegmenter, SseSegmenter } from "./passthrough.js";
import type { Redactor } from "./redaction.js";

/** How the client's response body is framed. */
export type OutputFraming = "sse" | "array" | "json";

/** A rewrite of the bytes written to the client, chunk by chunk. */
export interface OutputTransform {
  /** What to write now for `chunk`; may hold some back. */
  push(chunk: string | Uint8Array): string;
  /** Everything still held, at the end of the body. */
  end(): string;
}

/** The longest text that may still become a placeholder. */
const MAX_PENDING = 96;
/** What may be the start of a placeholder at the end of a fragment. */
const PARTIAL = /\{(?:\{(?:H(?:H(?:_[A-Za-z0-9_]*)?)?)?)?$/;

type Json = Record<string, unknown>;
const object = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Restores tool-call arguments in one response of `protocol`. Event bodies
 * that need no change are written byte for byte.
 */
export class ToolArgumentRestorer implements OutputTransform {
  #held = new Map<string, { text: string; escape: boolean }>();
  #segmenter: SseSegmenter | ArraySegmenter | undefined;
  #body = "";
  #decoder = new TextDecoder();

  constructor(
    private readonly redactor: Redactor,
    private readonly protocol: WireProtocol,
    private readonly framing: OutputFraming,
  ) {
    // Limits are the writer's own; events from the gateway are bounded already.
    if (framing === "sse") this.#segmenter = new SseSegmenter(64 * 1024 * 1024);
    else if (framing === "array")
      this.#segmenter = new ArraySegmenter(64 * 1024 * 1024);
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
      .map((segment) =>
        this.#segment(
          segment.bytes.toString("utf8"),
          segment.text,
          segment.closing,
        ),
      )
      .join("");
  }

  end(): string {
    if (!this.#segmenter) {
      const body = this.#body + this.#decoder.decode();
      this.#body = "";
      let value: unknown;
      try {
        value = JSON.parse(body);
      } catch {
        return body;
      }
      const changed = this.#data(value, undefined, []);
      return changed ? JSON.stringify(value) : body;
    }
    return this.#segmenter
      .end()
      .map((segment) =>
        this.#segment(
          segment.bytes.toString("utf8"),
          segment.text,
          segment.closing,
        ),
      )
      .join("");
  }

  /** One SSE event or array element, rewritten when it carries arguments. */
  #segment(raw: string, text: string, closing: boolean): string {
    if (closing) return raw;
    if (this.framing === "array") {
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        return raw;
      }
      return this.#data(value, undefined, [])
        ? raw.slice(0, raw.length - text.length) + JSON.stringify(value)
        : raw;
    }
    const lines = raw.split(/\r\n|\r|\n/);
    const data = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""));
    if (!data.length) return raw;
    const name = lines
      .find((line) => line.startsWith("event:"))
      ?.slice(6)
      .trim();
    let value: unknown;
    try {
      value = JSON.parse(data.join("\n"));
    } catch {
      return raw;
    }
    const before: string[] = [];
    if (!this.#data(value, name, before)) return before.join("") + raw;
    const kept = lines.filter(
      (line) => line !== "" && !line.startsWith("data:"),
    );
    return `${before.join("")}${kept.map((line) => `${line}\n`).join("")}data: ${JSON.stringify(value)}\n\n`;
  }

  /** A fragment of a streamed call's arguments, restored up to what may still be a placeholder. */
  #fragment(key: string, fragment: string, escape: boolean): string {
    const text = (this.#held.get(key)?.text ?? "") + fragment;
    const partial = PARTIAL.exec(text.slice(-MAX_PENDING));
    const cut = partial ? text.length - partial[0].length : text.length;
    if (cut < text.length)
      this.#held.set(key, { text: text.slice(cut), escape });
    else this.#held.delete(key);
    return this.redactor.restore(text.slice(0, cut), escape).text;
  }

  /** What is held for a call, restored; the call's arguments end. */
  #flush(key: string): string {
    const held = this.#held.get(key);
    this.#held.delete(key);
    return held ? this.redactor.restore(held.text, held.escape).text : "";
  }

  #full(text: unknown, escape: boolean): unknown {
    return typeof text === "string"
      ? this.redactor.restore(text, escape).text
      : text;
  }

  /**
   * Restores arguments in one parsed body or event in place; true when
   * anything changed. `before` receives events to write before it.
   */
  #data(value: unknown, event: string | undefined, before: string[]): boolean {
    if (!object(value)) return false;
    const original = JSON.stringify(value);
    switch (this.protocol) {
      case "chat":
        this.#chat(value);
        break;
      case "responses":
        this.#responses(value, before);
        break;
      case "anthropic":
        this.#anthropic(value, event, before);
        break;
      case "gemini":
        this.#gemini(value);
        break;
    }
    return JSON.stringify(value) !== original;
  }

  #chat(value: Json): void {
    for (const choice of Array.isArray(value.choices) ? value.choices : []) {
      if (!object(choice)) continue;
      const message = object(choice.message) ? choice.message : undefined;
      for (const call of Array.isArray(message?.tool_calls)
        ? message.tool_calls
        : [])
        if (object(call) && object(call.function))
          call.function.arguments = this.#full(call.function.arguments, true);
      const delta = object(choice.delta) ? choice.delta : undefined;
      const calls = Array.isArray(delta?.tool_calls) ? delta.tool_calls : [];
      for (const call of calls)
        if (
          object(call) &&
          object(call.function) &&
          typeof call.function.arguments === "string"
        )
          call.function.arguments = this.#fragment(
            `chat:${String(choice.index)}:${String(call.index)}`,
            call.function.arguments,
            true,
          );
      if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
        const prefix = `chat:${String(choice.index)}:`;
        for (const key of [...this.#held.keys()].filter((item) =>
          item.startsWith(prefix),
        )) {
          const rest = this.#flush(key);
          if (!rest) continue;
          const target = delta ?? (choice.delta = {});
          const list = Array.isArray((target as Json).tool_calls)
            ? ((target as Json).tool_calls as unknown[])
            : (((target as Json).tool_calls = []) as unknown[]);
          list.push({
            index: Number(key.slice(prefix.length)),
            function: { arguments: rest },
          });
        }
      }
    }
  }

  #item(item: unknown): void {
    if (!object(item)) return;
    if (item.type === "function_call")
      item.arguments = this.#full(item.arguments, true);
    else if (item.type === "custom_tool_call")
      item.input = this.#full(item.input, false);
  }

  #responses(value: Json, before: string[]): void {
    const type = value.type;
    const key = `responses:${String(value.item_id)}`;
    const delta = (escape: boolean) => {
      const rest = this.#flush(key);
      if (rest)
        before.push(
          `event: ${escape ? "response.function_call_arguments.delta" : "response.custom_tool_call_input.delta"}\ndata: ${JSON.stringify(
            {
              type: escape
                ? "response.function_call_arguments.delta"
                : "response.custom_tool_call_input.delta",
              item_id: value.item_id,
              output_index: value.output_index,
              delta: rest,
            },
          )}\n\n`,
        );
    };
    switch (type) {
      case "response.function_call_arguments.delta":
      case "response.custom_tool_call_input.delta":
        if (typeof value.delta === "string")
          value.delta = this.#fragment(
            key,
            value.delta,
            type === "response.function_call_arguments.delta",
          );
        return;
      case "response.function_call_arguments.done":
        delta(true);
        value.arguments = this.#full(value.arguments, true);
        return;
      case "response.custom_tool_call_input.done":
        delta(false);
        value.input = this.#full(value.input, false);
        return;
      case "response.output_item.added":
      case "response.output_item.done":
        this.#item(value.item);
        return;
      default: {
        const response = object(value.response) ? value.response : value;
        for (const item of Array.isArray(response.output)
          ? response.output
          : [])
          this.#item(item);
      }
    }
  }

  #anthropic(value: Json, event: string | undefined, before: string[]): void {
    const type = typeof value.type === "string" ? value.type : event;
    const key = `anthropic:${String(value.index)}`;
    if (type === "content_block_delta") {
      const delta = object(value.delta) ? value.delta : undefined;
      if (
        delta?.type === "input_json_delta" &&
        typeof delta.partial_json === "string"
      )
        delta.partial_json = this.#fragment(key, delta.partial_json, true);
      return;
    }
    if (type === "content_block_stop") {
      const rest = this.#flush(key);
      if (rest)
        before.push(
          `event: content_block_delta\ndata: ${JSON.stringify({
            type: "content_block_delta",
            index: value.index,
            delta: { type: "input_json_delta", partial_json: rest },
          })}\n\n`,
        );
      return;
    }
    const blocks =
      type === "content_block_start"
        ? [value.content_block]
        : Array.isArray(value.content)
          ? value.content
          : [];
    for (const block of blocks)
      if (object(block) && block.type === "tool_use" && "input" in block)
        block.input = this.redactor.restoreJson(block.input).value;
  }

  #gemini(value: Json): void {
    const candidates = Array.isArray(value.candidates) ? value.candidates : [];
    for (const candidate of candidates) {
      const content = object(candidate) ? candidate.content : undefined;
      const parts =
        object(content) && Array.isArray(content.parts) ? content.parts : [];
      for (const part of parts)
        if (object(part) && object(part.functionCall))
          part.functionCall.args = this.redactor.restoreJson(
            part.functionCall.args,
          ).value;
    }
  }
}
