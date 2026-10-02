import { createHash } from "node:crypto";
import {
  parseArguments,
  record,
  type ChatResult,
  type ReasoningField,
} from "./protocol.js";

const ENCODED = "hh-r1.";

/**
 * Encode reasoning text so it can travel through an engine-owned opaque field
 * (Responses `encrypted_content`, Google `thoughtSignature`) and come back.
 * This is an encoding, not encryption: it only carries text the engine already received.
 */
export function encodeReasoning(text: string): string {
  return ENCODED + Buffer.from(text, "utf8").toString("base64url");
}
/** Decode a value produced by {@link encodeReasoning}; foreign values are ignored. */
export function decodeReasoning(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith(ENCODED)) return undefined;
  const text = Buffer.from(value.slice(ENCODED.length), "base64url").toString(
    "utf8",
  );
  return text || undefined;
}
/** Deterministic Anthropic thinking signature; the thinking text itself travels in the block. */
export function thinkingSignature(text: string): string {
  return (
    "hh-sig." +
    createHash("sha256").update(text, "utf8").digest("base64url").slice(0, 43)
  );
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 40);
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  const object = record(value);
  if (!object) return value;
  return Object.fromEntries(
    Object.keys(object)
      .sort()
      .map((key) => [key, canonical(object[key])]),
  );
}
/** Cache keys for one Chat tool call: its id and a hash of its name and canonical arguments. */
export function callKeys(call: {
  id?: string;
  name: string;
  arguments: string;
}): string[] {
  const parsed = parseArguments(call.arguments);
  const args =
    parsed === undefined
      ? call.arguments.trim()
      : JSON.stringify(canonical(parsed));
  return [
    ...(call.id ? [`id:${call.id}`] : []),
    `call:${hash(`${call.name}\u0000${args}`)}`,
  ];
}
/** Cache key for assistant text, ignoring surrounding whitespace. */
export function textKey(text: string): string | undefined {
  const trimmed = text.trim();
  return trimmed ? `text:${hash(trimmed)}` : undefined;
}
/** Keys under which a finished completion's reasoning is remembered. */
export function resultKeys(result: ChatResult): string[] {
  const keys = result.calls.flatMap(callKeys);
  const key = textKey(result.text);
  return key ? [...keys, key] : keys;
}

interface Entry {
  text: string;
  bytes: number;
  keys: string[];
}
/**
 * Session-local LRU of upstream reasoning text, bounded by entry count and
 * UTF-8 bytes. One entry is reachable through several keys (tool call ids,
 * tool call signatures and the assistant text hash). Not persisted.
 */
export class ReasoningCache {
  #entries = new Map<number, Entry>();
  #keys = new Map<string, number>();
  #next = 0;
  #bytes = 0;
  constructor(
    readonly maxEntries = 256,
    readonly maxBytes = 4 * 1024 * 1024,
  ) {}
  get size(): number {
    return this.#entries.size;
  }
  get bytes(): number {
    return this.#bytes;
  }
  /** Remember text under keys; texts larger than the byte bound are not cached. */
  remember(text: string, keys: readonly string[]): void {
    const bytes = Buffer.byteLength(text, "utf8");
    if (!text || !keys.length || bytes > this.maxBytes) return;
    for (const key of keys) {
      const previous = this.#keys.get(key);
      if (previous !== undefined) this.#dropKey(key, previous);
    }
    const id = this.#next++;
    this.#entries.set(id, { text, bytes, keys: [...keys] });
    for (const key of keys) this.#keys.set(key, id);
    this.#bytes += bytes;
    for (const [oldest] of this.#entries) {
      if (this.#entries.size <= this.maxEntries && this.#bytes <= this.maxBytes)
        break;
      this.#evict(oldest);
    }
  }
  /** Return the text of the first known key and mark it recently used. */
  lookup(keys: readonly string[]): string | undefined {
    for (const key of keys) {
      const id = this.#keys.get(key);
      const entry = id === undefined ? undefined : this.#entries.get(id);
      if (id === undefined || !entry) continue;
      this.#entries.delete(id);
      this.#entries.set(id, entry);
      return entry.text;
    }
    return undefined;
  }
  #dropKey(key: string, id: number): void {
    this.#keys.delete(key);
    const entry = this.#entries.get(id);
    if (!entry) return;
    entry.keys = entry.keys.filter((value) => value !== key);
    if (!entry.keys.length) this.#evict(id);
  }
  #evict(id: number): void {
    const entry = this.#entries.get(id);
    if (!entry) return;
    this.#entries.delete(id);
    this.#bytes -= entry.bytes;
    for (const key of entry.keys)
      if (this.#keys.get(key) === id) this.#keys.delete(key);
  }
}

function toolCalls(
  message: Record<string, unknown>,
): { id?: string; name: string; arguments: string }[] {
  if (!Array.isArray(message.tool_calls)) return [];
  return message.tool_calls.flatMap((raw) => {
    const call = record(raw),
      fn = record(call?.function);
    if (!call || !fn || typeof fn.name !== "string") return [];
    return [
      {
        ...(typeof call.id === "string" ? { id: call.id } : {}),
        name: fn.name,
        arguments: typeof fn.arguments === "string" ? fn.arguments : "",
      },
    ];
  });
}
function assistantText(message: Record<string, unknown>): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((part) => {
      const value = record(part);
      return typeof value?.text === "string" ? value.text : "";
    })
    .join("\n");
}
/**
 * Put reasoning back on assistant history messages before the upstream call.
 * Existing reasoning is kept and moved to `field`; missing reasoning is looked
 * up by tool call id, tool call signature, then assistant text. Returns the
 * number of restored messages. Mutates the given message objects.
 */
export function restoreReasoning(
  messages: readonly Record<string, unknown>[],
  cache: ReasoningCache,
  field: ReasoningField,
): number {
  const other: ReasoningField =
    field === "reasoning_content" ? "reasoning" : "reasoning_content";
  let restored = 0;
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const own = [message[field], message[other]].find(
      (value): value is string => typeof value === "string" && value !== "",
    );
    if (typeof message[other] === "string") delete message[other];
    if (own) {
      message[field] = own;
      continue;
    }
    const keys = toolCalls(message).flatMap(callKeys);
    const key = textKey(assistantText(message));
    const text = cache.lookup(key ? [...keys, key] : keys);
    if (text) {
      message[field] = text;
      restored++;
    }
  }
  return restored;
}
/** `compatibility.reasoning: strip`: no reasoning text crosses the gateway in either direction. */
export function stripReasoning(
  messages: readonly Record<string, unknown>[],
): void {
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    delete message.reasoning_content;
    delete message.reasoning;
  }
}
