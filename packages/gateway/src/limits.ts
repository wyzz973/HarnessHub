// SPDX-License-Identifier: MIT
/**
 * Resource limits of the shared gateway handler (03 section 6). The defaults
 * live here and only here; {@link resolveHandlerLimits} is the one resolver.
 */

/** All values are integers; byte counts are bytes, times are milliseconds. */
export interface HandlerLimits {
  /** Inbound request body after decompression; at most 256 MiB. */
  maxRequestBytes: number;
  /** Upstream request body after translation and patches. */
  maxUpstreamRequestBytes: number;
  /** Upstream response body bytes of one attempt (raw bytes, not decoded content). */
  maxResponseBytes: number;
  /** One upstream SSE event or Gemini stream element. */
  maxEventBytes: number;
  /** Request bodies held in memory by all calls together; beyond it new calls get 503 `busy`. */
  maxInflightRequestBytes: number;
  /** Deadline for receiving a whole inbound request body (408). */
  requestBodyTimeoutMs: number;
  /**
   * Deadline for inbound request headers. The handler has no listener: the
   * owner of the HTTP server applies it as `server.headersTimeout`.
   */
  requestHeadersTimeoutMs: number;
  /** Wait for upstream response headers; retried at most once on the same candidate. */
  upstreamHeaderTimeoutMs: number;
  /** Longest gap between two upstream data events; comments and blank lines do not count. */
  idleTimeoutMs: number;
  /** Client-side silence after which a protocol keepalive is written (1–30 s). */
  keepaliveGapMs: number;
  /** Keepalives stop once the upstream sent no data event for this long. */
  maxNoDataMs: number;
  /** Gemini inbound: 200 headers are committed this long after the request (not before an upstream 2xx). */
  headerCommitMs: number;
  /** Output is held before the first content event while alternatives remain, at most this long… */
  holdMs: number;
  /** …or this many upstream bytes. */
  holdBytes: number;
  /** Concurrent upstream requests per credential. */
  maxConcurrentPerCredential: number;
  /** Calls waiting for a credential slot before new ones get 429 `busy`. */
  maxQueuedPerCredential: number;
  /** Longest a call waits for a credential slot before it gets 429 `busy` (and fails over). */
  slotWaitMs: number;
  /** Reasoning replay cache per Gateway Key: entries and UTF-8 bytes. */
  reasoningEntries: number;
  reasoningBytes: number;
  /** Reasoning replay caches of all keys together. */
  reasoningTotalBytes: number;
  /**
   * Images the vision model describes for one request, newest first;
   * images with a cached description do not count, the others beyond it
   * reach the model as placeholders.
   */
  maxDescribedImages: number;
  /**
   * Model calls the gateway makes for one request on its key's behalf
   * (image descriptions, classifier questions); beyond it they are not made.
   */
  maxInternalCalls: number;
  /** Web searches the gateway runs for one answer of the model (one round)… */
  maxSearchesPerRound: number;
  /** …and for the whole request; the model is told when a search is not run. */
  maxSearchesPerRequest: number;
}

const MiB = 1024 * 1024;
export const DEFAULT_HANDLER_LIMITS: Readonly<HandlerLimits> = Object.freeze({
  maxRequestBytes: 64 * MiB,
  maxUpstreamRequestBytes: 32 * MiB,
  maxResponseBytes: 64 * MiB,
  maxEventBytes: 16 * MiB,
  maxInflightRequestBytes: 512 * MiB,
  requestBodyTimeoutMs: 120_000,
  requestHeadersTimeoutMs: 10_000,
  upstreamHeaderTimeoutMs: 300_000,
  idleTimeoutMs: 300_000,
  keepaliveGapMs: 10_000,
  maxNoDataMs: 300_000,
  headerCommitMs: 45_000,
  holdMs: 15_000,
  holdBytes: MiB,
  maxConcurrentPerCredential: 8,
  maxQueuedPerCredential: 64,
  slotWaitMs: 60_000,
  reasoningEntries: 256,
  reasoningBytes: 4 * MiB,
  reasoningTotalBytes: 64 * MiB,
  maxDescribedImages: 16,
  maxInternalCalls: 20,
  maxSearchesPerRound: 5,
  maxSearchesPerRequest: 20,
});

/** Longest delay Node timers accept. */
const MAX_TIMER_MS = 2 ** 31 - 1;
const MAX = Number.MAX_SAFE_INTEGER;
/** Accepted range per limit. Times other than the keepalive gap only need to be positive, so tests can shorten them. */
const RANGES: Readonly<Record<keyof HandlerLimits, readonly [number, number]>> =
  {
    maxRequestBytes: [1, 256 * MiB],
    maxUpstreamRequestBytes: [1, MAX],
    maxResponseBytes: [1, MAX],
    maxEventBytes: [1, MAX],
    maxInflightRequestBytes: [1, MAX],
    requestBodyTimeoutMs: [1, MAX_TIMER_MS],
    requestHeadersTimeoutMs: [1, MAX_TIMER_MS],
    upstreamHeaderTimeoutMs: [1, MAX_TIMER_MS],
    idleTimeoutMs: [1, MAX_TIMER_MS],
    keepaliveGapMs: [1_000, 30_000],
    maxNoDataMs: [1, MAX_TIMER_MS],
    // Leaves at least 5 s below the 60 s after which Gemini clients give up.
    headerCommitMs: [1, 55_000],
    holdMs: [1, MAX_TIMER_MS],
    holdBytes: [1, MAX],
    maxConcurrentPerCredential: [1, MAX],
    maxQueuedPerCredential: [0, MAX],
    slotWaitMs: [1, MAX_TIMER_MS],
    reasoningEntries: [0, MAX],
    reasoningBytes: [0, MAX],
    reasoningTotalBytes: [0, MAX],
    maxDescribedImages: [0, MAX],
    maxInternalCalls: [0, MAX],
    maxSearchesPerRound: [0, MAX],
    maxSearchesPerRequest: [0, MAX],
  };

/**
 * Resolve `gateway.limits`: `undefined` gives the defaults; an object
 * overrides the named limits. Throws a `RangeError` naming the first unknown
 * field or the first value that is not an integer in its accepted range.
 */
export function resolveHandlerLimits(
  input: unknown = undefined,
): Readonly<HandlerLimits> {
  if (input === undefined) return DEFAULT_HANDLER_LIMITS;
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new RangeError("Gateway limits must be an object");
  const limits: HandlerLimits = { ...DEFAULT_HANDLER_LIMITS };
  for (const [name, value] of Object.entries(input)) {
    if (!Object.hasOwn(RANGES, name))
      throw new RangeError(`Unknown gateway limit ${name.slice(0, 64)}`);
    const key = name as keyof HandlerLimits;
    const [min, max] = RANGES[key];
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < min ||
      value > max
    )
      throw new RangeError(
        `Gateway limit ${name} must be an integer from ${min} to ${max}`,
      );
    limits[key] = value;
  }
  return Object.freeze(limits);
}
