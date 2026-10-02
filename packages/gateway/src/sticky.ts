// SPDX-License-Identifier: MIT
/**
 * Route stickiness (03 section 5): a conversation stays on the credential
 * that answered it, so upstream prompt caches stay warm and reasoning
 * signatures stay valid. In memory, owned by one gateway handler.
 */
import { createHash } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { Stickiness, WireProtocol } from "@harnesshub/core/model-plane";
import { record } from "./protocol.js";
import type { Candidate } from "./routing.js";

/** A conversation as the gateway recognizes it from one request. */
export interface Conversation {
  /** Opaque key, unique per Gateway Key. */
  key: string;
  /** Where the key came from. */
  source: "header" | "client" | "hash";
  /** The request returns tool results: the client is inside a turn. */
  withinTurn: boolean;
}

function hash(parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}
function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** The client's own conversation or cache id, when its protocol has one. */
function clientId(
  protocol: WireProtocol,
  raw: Record<string, unknown>,
): string | undefined {
  if (protocol === "chat" || protocol === "responses") {
    const id = raw.prompt_cache_key;
    return typeof id === "string" && id ? id : undefined;
  }
  if (protocol === "anthropic") {
    // Claude Code: `user_<hash>_account_<uuid>_session_<uuid>`; only the session part identifies a conversation.
    const user = record(raw.metadata)?.user_id;
    const session =
      typeof user === "string" ? /session_([0-9a-zA-Z-]+)/.exec(user) : null;
    return session?.[1];
  }
  return undefined;
}

/** System text and first user message, the stable start of a conversation. */
function opening(
  protocol: WireProtocol,
  raw: Record<string, unknown>,
): [unknown, unknown] {
  switch (protocol) {
    case "chat": {
      const messages = list(raw.messages).map(record);
      return [
        messages.find(
          (message) =>
            message?.role === "system" || message?.role === "developer",
        )?.content,
        messages.find((message) => message?.role === "user")?.content,
      ];
    }
    case "responses": {
      const input =
        typeof raw.input === "string"
          ? raw.input
          : list(raw.input)
              .map(record)
              .find(
                (item) =>
                  (item?.type ?? "message") === "message" &&
                  item?.role === "user",
              )?.content;
      return [raw.instructions, input];
    }
    case "anthropic":
      return [
        raw.system,
        list(raw.messages)
          .map(record)
          .find((message) => message?.role === "user")?.content,
      ];
    case "gemini":
      return [
        raw.systemInstruction,
        list(raw.contents)
          .map(record)
          .find((content) => (content?.role ?? "user") === "user")?.parts,
      ];
  }
}

/** Whether the request's last item returns tool results. */
function returnsToolResults(
  protocol: WireProtocol,
  raw: Record<string, unknown>,
): boolean {
  switch (protocol) {
    case "chat":
      return record(list(raw.messages).at(-1))?.role === "tool";
    case "responses": {
      const type = record(list(raw.input).at(-1))?.type;
      return (
        type === "function_call_output" || type === "custom_tool_call_output"
      );
    }
    case "anthropic": {
      const last = record(list(raw.messages).at(-1));
      return (
        last?.role === "user" &&
        list(last.content).some(
          (block) => record(block)?.type === "tool_result",
        )
      );
    }
    case "gemini":
      return list(record(list(raw.contents).at(-1))?.parts).some(
        (part) => record(part)?.functionResponse !== undefined,
      );
  }
}

/**
 * The conversation of a request: the `x-hh-conversation` header, else the
 * client's own id (`prompt_cache_key`; the session in Anthropic
 * `metadata.user_id`), else a hash of the system text and first user
 * message. Every key is scoped to the Gateway Key.
 */
export function conversationOf(
  protocol: WireProtocol,
  raw: Record<string, unknown>,
  headers: IncomingHttpHeaders,
  keyId: string,
): Conversation {
  const withinTurn = returnsToolResults(protocol, raw);
  const header = headers["x-hh-conversation"];
  if (typeof header === "string" && header.trim())
    return {
      key: hash([keyId, "h", header.trim()]),
      source: "header",
      withinTurn,
    };
  const id = clientId(protocol, raw);
  if (id) return { key: hash([keyId, "c", id]), source: "client", withinTurn };
  return {
    key: hash([keyId, "o", protocol, ...opening(protocol, raw)]),
    source: "hash",
    withinTurn,
  };
}

/** Across turns, `auto` stays only on a warm cache: at least this many cached tokens… */
export const CACHE_WORTH_TOKENS = 1024;
/** …read by a call less than this long ago. */
export const CACHE_COLD_MS = 5 * 60_000;
/** Conversations remembered, and for how long. */
export const STICKY_ENTRIES = 512;
export const STICKY_TTL_MS = 24 * 3_600_000;

interface Remembered {
  requested: string;
  candidate: string;
  at: number;
  cacheRead: number;
}

function identity(candidate: Candidate): string {
  return `${candidate.provider.id}\u0000${candidate.credential.id}\u0000${candidate.ref}`;
}

/**
 * The last credential per conversation, for at most {@link STICKY_ENTRIES}
 * conversations and {@link STICKY_TTL_MS}. Kept in memory only: a daemon
 * restart starts every conversation afresh.
 */
export class StickyRoutes {
  #entries = new Map<string, Remembered>();
  constructor(private readonly clock: () => number) {}

  /**
   * Put the conversation's last candidate first when `mode` says to stay.
   * Returns the candidates and the patch that records the decision:
   * `sticky:hit`, `sticky:miss:<reason>` or `sticky:broken:<reason>`;
   * no patch with mode `off` or a single candidate, where there is no choice.
   */
  apply(
    conversation: Conversation,
    requested: string,
    mode: Stickiness,
    candidates: Candidate[],
    blocked: (candidate: Candidate) => boolean,
  ): { candidates: Candidate[]; patch?: string } {
    if (mode === "off" || candidates.length < 2) return { candidates };
    const now = this.clock();
    const last = this.#entries.get(conversation.key);
    if (!last || now - last.at > STICKY_TTL_MS)
      return { candidates, patch: "sticky:miss:new" };
    if (last.requested !== requested)
      return { candidates, patch: "sticky:miss:model_changed" };
    const warm =
      last.cacheRead >= CACHE_WORTH_TOKENS && now - last.at < CACHE_COLD_MS;
    const stay =
      mode === "session" ||
      conversation.withinTurn ||
      (mode === "auto" && warm);
    if (!stay)
      return {
        candidates,
        patch: `sticky:miss:${mode === "turn" ? "new_turn" : "cache_cold"}`,
      };
    const index = candidates.findIndex(
      (candidate) => identity(candidate) === last.candidate,
    );
    if (index < 0) return { candidates, patch: "sticky:broken:unavailable" };
    const chosen = candidates[index]!;
    if (blocked(chosen)) return { candidates, patch: "sticky:broken:breaker" };
    return {
      candidates: [chosen, ...candidates.filter((_, at) => at !== index)],
      patch: "sticky:hit",
    };
  }

  /** The conversation was answered by `candidate`, which read `cacheRead` cached tokens. */
  remember(
    conversation: Conversation,
    requested: string,
    candidate: Candidate,
    cacheRead: number,
  ): void {
    this.#entries.delete(conversation.key);
    this.#entries.set(conversation.key, {
      requested,
      candidate: identity(candidate),
      at: this.clock(),
      cacheRead,
    });
    for (const oldest of this.#entries.keys()) {
      if (this.#entries.size <= STICKY_ENTRIES) break;
      this.#entries.delete(oldest);
    }
  }
}
