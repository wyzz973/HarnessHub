// SPDX-License-Identifier: MIT
import type { IncomingMessage } from "node:http";
import type { Transform } from "node:stream";
import {
  createBrotliDecompress,
  createGunzip,
  createInflate,
  createZstdDecompress,
} from "node:zlib";
import type { Failure } from "./output.js";
import { GatewayError } from "./protocol.js";

/** A classified failure with `contextOverflow` false. */
export function failure(
  status: number,
  code: string,
  message: string,
): Failure {
  return { status, code, message, contextOverflow: false };
}

/** Up to `maxBytes` of an upstream error body as text; the rest is not read. */
export async function readLimited(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  if (response.body)
    for await (const chunk of response.body) {
      chunks.push(chunk);
      bytes += chunk.byteLength;
      if (bytes >= maxBytes) break;
    }
  return Buffer.concat(chunks).subarray(0, maxBytes).toString("utf8");
}

/**
 * Admission of upstream requests to `limit` at once, with up to `queue`
 * waiting; a full queue rejects with 429 `busy` and `busyMessage`. A slot
 * that comes free goes to the waiting call of the owner (a Gateway Key)
 * holding the fewest slots, the earliest of those, so that one key's calls
 * cannot keep another's waiting behind all of them. A call leaves the queue
 * when aborted, or with 429 `busy` after `waitMs` without a slot (security
 * review L7); without `waitMs` it waits until aborted.
 */
export class Slots {
  #active = 0;
  /** Slots each owner holds. */
  #held = new Map<string, number>();
  #waiting: { owner: string; admit: () => void }[] = [];
  constructor(
    private limit: number,
    private queue: number,
    private readonly busyMessage: string,
    private waitMs?: number,
  ) {}
  /**
   * New limits, for the next call (a provider's own were changed): a higher
   * limit admits callers already waiting; a lower one lets the calls out
   * finish and admits no more until fewer are out.
   */
  configure(limit: number, queue: number, waitMs?: number): void {
    this.limit = limit;
    this.queue = queue;
    this.waitMs = waitMs;
    while (this.#active < this.limit && this.#waiting.length) {
      this.#active++;
      this.#admit(this.#next()!);
    }
  }
  /** Calls holding a slot plus calls waiting for one. */
  get load(): number {
    return this.#active + this.#waiting.length;
  }
  /** Takes a slot for `owner`; the caller gives it back with {@link release}. */
  acquire(signal: AbortSignal, owner = ""): Promise<void> {
    signal.throwIfAborted();
    if (this.#active < this.limit) {
      this.#active++;
      this.#hold(owner, 1);
      return Promise.resolve();
    }
    if (this.#waiting.length >= this.queue)
      return Promise.reject(new GatewayError(this.busyMessage, 429, "busy"));
    const waitMs = this.waitMs;
    return new Promise<void>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const leave = () => {
        this.#waiting = this.#waiting.filter((other) => other !== waiter);
        signal.removeEventListener("abort", abort);
        clearTimeout(timer);
      };
      const waiter = {
        owner,
        admit: () => {
          signal.removeEventListener("abort", abort);
          clearTimeout(timer);
          resolve();
        },
      };
      const abort = () => {
        leave();
        reject(signal.reason);
      };
      if (waitMs !== undefined)
        timer = setTimeout(() => {
          leave();
          reject(
            new GatewayError(
              `${this.busyMessage}: no slot came free within ${Math.ceil(waitMs / 1000)} s`,
              429,
              "busy",
            ),
          );
        }, waitMs);
      signal.addEventListener("abort", abort, { once: true });
      this.#waiting.push(waiter);
    });
  }
  /** Gives back a slot `owner` took. */
  release(owner = ""): void {
    this.#hold(owner, -1);
    // Above a lowered limit, a finished call's slot is not handed on.
    const next = this.#active <= this.limit ? this.#next() : undefined;
    if (next) this.#admit(next);
    else this.#active--;
  }
  /** The waiting call of the owner holding the fewest slots, the earliest of those. */
  #next(): { owner: string; admit: () => void } | undefined {
    let best = -1;
    let fewest = Infinity;
    for (const [index, waiter] of this.#waiting.entries()) {
      const held = this.#held.get(waiter.owner) ?? 0;
      if (held < fewest) {
        best = index;
        fewest = held;
      }
    }
    return best < 0 ? undefined : this.#waiting.splice(best, 1)[0];
  }
  #admit(waiter: { owner: string; admit: () => void }): void {
    this.#hold(waiter.owner, 1);
    waiter.admit();
  }
  #hold(owner: string, change: number): void {
    const held = (this.#held.get(owner) ?? 0) + change;
    if (held > 0) this.#held.set(owner, held);
    else this.#held.delete(owner);
  }
}

/** A fetch failure without an HTTP response, or `undefined` for other errors. */
export function networkFailure(error: unknown): Failure | undefined {
  if (!(error instanceof TypeError) || error.cause === undefined)
    return undefined;
  const cause = error.cause as { code?: unknown; message?: unknown };
  const code =
    typeof cause.code === "string"
      ? cause.code
      : typeof cause.message === "string" && /redirect/i.test(cause.message)
        ? "redirect refused"
        : "network error";
  return failure(
    502,
    "upstream_unreachable",
    error.message === "terminated"
      ? `Upstream connection closed before the response completed (${code})`
      : `Upstream model request failed (${code})`,
  );
}

/**
 * `signal`, aborted as well after `ms`, with a cleanup the caller runs when
 * the guarded work ends. Use it instead of `AbortSignal.any` over
 * `AbortSignal.timeout`: Node 24 keeps every timeout signal passed to
 * `AbortSignal.any` alive, with its timer, until it fires, so a per-request
 * deadline held each request's signals for the whole deadline. The timer
 * does not keep the process alive.
 */
export function deadline(
  signal: AbortSignal,
  ms: number,
): { signal: AbortSignal; expired(): boolean; dispose(): void } {
  const controller = new AbortController();
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    controller.abort(
      new DOMException(
        "The operation was aborted due to timeout",
        "TimeoutError",
      ),
    );
  }, ms);
  timer.unref();
  return {
    signal: AbortSignal.any([signal, controller.signal]),
    expired: () => expired,
    dispose: () => clearTimeout(timer),
  };
}

/** Process-wide budget of request body bytes held in memory at once. */
export class MemoryBudget {
  #used = 0;
  constructor(readonly limit: number) {}
  get used(): number {
    return this.#used;
  }
  /** Reserve `bytes`; false (and nothing reserved) when the budget would be exceeded. */
  take(bytes: number): boolean {
    if (this.#used + bytes > this.limit) return false;
    this.#used += bytes;
    return true;
  }
  give(bytes: number): void {
    this.#used = Math.max(0, this.#used - bytes);
  }
}

/** Limits and ownership of one inbound body read. */
export interface BodyReadOptions {
  /** Decompressed bytes accepted. */
  maxBytes: number;
  /** Whole-body receive deadline. */
  timeoutMs: number;
  signal: AbortSignal;
  /** Bytes read are reserved here; the caller gives back `bytes` of the result. */
  memory: MemoryBudget;
}

function decoder(encoding: string): Transform {
  switch (encoding) {
    case "gzip":
    case "x-gzip":
      return createGunzip();
    case "deflate":
      return createInflate();
    case "br":
      return createBrotliDecompress();
    case "zstd":
      return createZstdDecompress();
    default:
      throw new GatewayError(
        `Unsupported request content encoding: ${encoding.slice(0, 32)}`,
        415,
        "unsupported_encoding",
      );
  }
}

/**
 * Read an inbound request body, decompressing gzip, deflate, br or zstd. The
 * decompressed size counts against `maxBytes` (413 `request_too_large`) and
 * against the shared memory budget (503 `busy`). Rejects with 408
 * `request_timeout` after `timeoutMs`, and with `signal.reason` when aborted.
 * On success the caller owns the reservation of `bytes.length` and must give
 * it back; on failure nothing stays reserved.
 */
export async function readBody(
  request: IncomingMessage,
  options: BodyReadOptions,
): Promise<Buffer> {
  const encoding = (request.headers["content-encoding"] ?? "identity")
    .trim()
    .toLowerCase();
  const tooLarge = () =>
    new GatewayError(
      `Model request exceeds the gateway size limit of ${options.maxBytes} bytes`,
      413,
      "request_too_large",
    );
  if (
    encoding === "identity" &&
    Number(request.headers["content-length"]) > options.maxBytes
  )
    throw tooLarge();
  const inflate = encoding === "identity" ? undefined : decoder(encoding);
  // pipe() does not forward source errors; a reset request must end the read.
  if (inflate) request.once("error", (error) => inflate.destroy(error));
  const source: AsyncIterable<unknown> = inflate
    ? request.pipe(inflate)
    : request;
  const timeout = deadline(options.signal, options.timeoutMs);
  const signal = timeout.signal;
  const chunks: Buffer[] = [];
  let bytes = 0;
  const stop = () => {
    inflate?.destroy();
    request.destroy();
  };
  signal.addEventListener("abort", stop, { once: true });
  try {
    for await (const value of source) {
      signal.throwIfAborted();
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
      bytes += chunk.length;
      if (bytes > options.maxBytes) throw tooLarge();
      if (!options.memory.take(chunk.length)) {
        bytes -= chunk.length;
        throw new GatewayError(
          "The model gateway is holding too many request bodies; retry later",
          503,
          "busy",
        );
      }
      chunks.push(chunk);
    }
    signal.throwIfAborted();
    return Buffer.concat(chunks, bytes);
  } catch (error) {
    options.memory.give(bytes);
    if (timeout.expired() && !options.signal.aborted)
      throw new GatewayError(
        "Model request body was not received in time",
        408,
        "request_timeout",
      );
    if (options.signal.aborted) throw options.signal.reason;
    if (error instanceof GatewayError) throw error;
    throw new GatewayError(
      encoding === "identity"
        ? "Model request body could not be read"
        : `Model request body is not valid ${encoding} data`,
      400,
      "invalid_request",
    );
  } finally {
    timeout.dispose();
    signal.removeEventListener("abort", stop);
  }
}

/** Parse a UTF-8 JSON request body; 400 for invalid UTF-8 or JSON. */
export function parseJsonBody(bytes: Buffer): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new GatewayError("Model request is not valid UTF-8");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new GatewayError("Model request is not valid JSON");
  }
}
