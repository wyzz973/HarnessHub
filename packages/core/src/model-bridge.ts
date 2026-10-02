// SPDX-License-Identifier: MIT
/**
 * The contract between engine configuration and the Session model gateway
 * (ADR 0013). Configuration preparation receives a gateway factory through
 * `PreparationHooks.startModelGateway`, so it never depends on the gateway
 * implementation; the Worker and the composition root inject it.
 */
import type { ModelCompatibility } from "./engine-configuration.js";

/** Engine-facing wire protocol of one model call. */
export type InboundProtocol =
  "openai-completions" | "openai-responses" | "anthropic" | "google";

/** Resolved configuration of one Session's gateway. Secrets are values, never references. */
export interface ModelGatewayOptions {
  upstream: {
    protocol: "openai-completions";
    /** Upstream base URL including an optional `/v1` or path prefix; the gateway appends `/chat/completions`. */
    baseUrl: string;
    /** Resolved secret; sent as `Authorization: Bearer`, never logged or returned. */
    apiKey?: string;
    /** Resolved request headers, possibly secret; applied after the API key. */
    headers?: Record<string, string>;
  };
  /** The only upstream model; requested model names are recorded but ignored. */
  model: string;
  /** Model id shown to engines by `/v1/models` and in responses without a requested model. */
  alias: string;
  contextWindow?: number;
  /** Larger engine output limits are clamped to this value; absent limits stay absent. */
  maxOutputTokens?: number;
  compatibility?: ModelCompatibility;
  /** Called once per model call, after the engine response ended. Exceptions are ignored. */
  onCall?: (call: ModelCallRecord) => void;
  /**
   * Debug-only observer, called just before `onCall` with 2 KiB excerpts of the
   * upstream request body and of the answer (or failure). Unlike the call record
   * it contains prompt and completion text: the receiver must redact it and keep
   * it in private diagnostics. Exceptions are ignored.
   */
  onPayload?: (
    callId: string,
    payload: { request: string | null; response: string },
  ) => void;
}

/**
 * One engine model call. Contains no prompt, completion text or secret.
 * `status` is the HTTP status returned to the engine, or for a failure after
 * the 200 headers were committed (a stream, or a Gemini answer committed
 * early), the status that failure would have had; 499 marks a call cancelled
 * by the engine disconnecting or by the Run ending. Keepalives never change it.
 */
export interface ModelCallRecord {
  id: string;
  inbound: InboundProtocol;
  stream: boolean;
  requestedModel?: string;
  upstreamModel: string;
  status: number;
  ok: boolean;
  durationMs: number;
  finishReason?: string;
  usage?: {
    input?: number;
    output?: number;
    total?: number;
    reasoning?: number;
  };
  toolCalls: number;
  /** Sanitized, at most 500 characters. */
  error?: { code: string; message: string };
  /** Inbound request path without its query (which may carry the Session token). */
  path?: string;
  /** Milliseconds from the call start to the first upstream body chunk. */
  firstByteMs?: number;
  /**
   * Assistant tool-call messages in the upstream history: how many got their
   * reasoning text back from the gateway cache, and how many still had none
   * (reasoning models such as DeepSeek reject those). Absent when reasoning is stripped.
   */
  reasoning?: { restored: number; missing: number };
  /** Top-level request fields removed (`-name`) or added (`+name`) by normalization. */
  adjusted?: string[];
}

/**
 * A Session-owned, authenticated loopback model gateway. Model calls are only
 * forwarded while a Run is active; `/v1/models` and token counting need none.
 */
export interface ModelGateway {
  /** `http://127.0.0.1:<port>`, without `/v1`. */
  readonly baseUrl: string;
  /** Random local token accepted as Bearer, `x-api-key`, `x-goog-api-key` or `?key=`. */
  readonly token: string;
  /**
   * Start the only active Run scope and clear `runErrors()`. Aborting `signal`
   * aborts its upstream requests. Throws when a Run is active or the gateway closed.
   */
  beginRun(signal: AbortSignal): void;
  /** Abort the Run's outstanding calls and resolve after all of them ended. Idempotent. */
  endRun(): Promise<void>;
  /**
   * Failed calls of the current Run in completion order (copies). Cleared by
   * `beginRun`; still readable after `endRun`. Cancelled calls are excluded.
   */
  runErrors(): ModelCallRecord[];
  /** Stop listening, end the Run and close connections. Idempotent and awaitable. */
  close(): Promise<void>;
}
