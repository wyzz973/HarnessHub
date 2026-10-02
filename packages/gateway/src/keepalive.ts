// SPDX-License-Identifier: MIT
import { ClientClosed, type HttpWriter } from "./output.js";

/** Keepalive pacing of one engine response; values come from `GatewayLimits`. */
export interface KeepalivePacing {
  /** Minimum engine-side silence before a keepalive is written. */
  gapMs: number;
  /** No keepalive once the upstream sent no data event for this long. */
  maxNoDataMs: number;
}

/**
 * Paces protocol keepalives on one committed engine response. A keepalive is
 * written only when all of these hold: the headers were sent; the upstream
 * showed activity (any body bytes, including SSE comments) since the engine
 * last received bytes; the engine has received nothing for `gapMs`; no write
 * is waiting for the socket; and the upstream sent a data event (or answered
 * with headers) within `maxNoDataMs`. Comments alone therefore keep the
 * engine alive only until `maxNoDataMs`, after which the gateway's idle
 * timeout decides. A silent upstream never causes keepalives.
 *
 * Owned by one model call, which must call {@link stop} before writing its
 * final events and on every exit path, then await {@link settled}. The only
 * timer is cleared by `stop`; no keepalive is written after it.
 */
export class Keepalive {
  #timer: NodeJS.Timeout | undefined;
  /** `writer.writes` at the latest upstream activity; equal means none was forwarded since. */
  #activityAt = -1;
  #lastData = performance.now();
  #stopped = false;
  #sending: Promise<void> = Promise.resolve();
  #failure: unknown;

  constructor(
    private readonly writer: HttpWriter,
    private readonly pacing: Readonly<KeepalivePacing>,
    private readonly send: () => Promise<void>,
  ) {}

  /** The upstream answered with response headers; the no-data window restarts. */
  answered(): void {
    this.#lastData = performance.now();
  }

  /** Upstream body bytes arrived: data, SSE comments or blank lines. */
  activity(): void {
    if (this.#stopped) return;
    this.#activityAt = this.writer.writes;
    const now = performance.now();
    if (now - this.#lastData > this.pacing.maxNoDataMs) return;
    this.#arm(this.writer.lastWrite + this.pacing.gapMs - now);
  }

  /** One upstream data event arrived (an SSE `data` line or JSON body text). */
  data(): void {
    this.#lastData = performance.now();
    this.activity();
  }

  /** Write no further keepalive. Synchronous so it can precede final events; idempotent. */
  stop(): void {
    this.#stopped = true;
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  /**
   * Resolves once a keepalive write in progress settled. A write that failed
   * because the engine disconnected is not an error here: the response's
   * close handler cancels the call. Any other write failure rejects.
   */
  async settled(): Promise<void> {
    await this.#sending;
    if (this.#failure !== undefined) throw this.#failure;
  }

  #arm(delay: number): void {
    if (this.#timer || this.#stopped) return;
    this.#timer = setTimeout(() => this.#tick(), Math.max(0, delay));
  }

  #tick(): void {
    this.#timer = undefined;
    // Without new upstream activity since the engine last got bytes, the next
    // activity re-arms the timer; a silent upstream is left to the idle timeout.
    if (this.#stopped || this.#activityAt !== this.writer.writes) return;
    if (!this.writer.sent || this.writer.closed) return;
    const now = performance.now();
    if (now - this.#lastData > this.pacing.maxNoDataMs) return;
    const wait = this.writer.lastWrite + this.pacing.gapMs - now;
    if (wait > 0 || this.writer.busy) {
      this.#arm(wait > 0 ? wait : this.pacing.gapMs);
      return;
    }
    const previous = this.#sending;
    const sent = this.send().catch((error: unknown) => {
      this.stop();
      if (!(error instanceof ClientClosed)) this.#failure ??= error;
    });
    this.#sending = Promise.all([previous, sent]).then(() => undefined);
  }
}
