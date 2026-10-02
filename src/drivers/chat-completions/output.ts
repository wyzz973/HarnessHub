// SPDX-License-Identifier: MIT
import type { ServerResponse } from "node:http";
import type { ChatResult, ReasoningField } from "./protocol.js";

/** A classified call failure with a public, sanitized message (≤ 500 characters). */
export interface Failure {
  status: number;
  code: string;
  message: string;
  contextOverflow: boolean;
}

/** The engine closed its connection or the Run owning the request ended. */
export class ClientClosed extends Error {
  constructor() {
    super("Model gateway client closed the connection");
  }
}

/**
 * Serializes writes to one engine response, applies socket backpressure and
 * tracks when the engine last received bytes, so keepalives can be paced.
 */
export class HttpWriter {
  #writes = 0;
  #lastWrite = performance.now();
  #pending = 0;
  constructor(private readonly response: ServerResponse) {}
  /** True once the status line was sent; later failures must be in-band. */
  get sent(): boolean {
    return this.response.headersSent;
  }
  /** Count of header commits and body writes so far; grows whenever the engine is sent bytes. */
  get writes(): number {
    return this.#writes;
  }
  /** `performance.now()` of the latest header commit or body write, or of construction. */
  get lastWrite(): number {
    return this.#lastWrite;
  }
  /** True while a body write waits for the socket (backpressure). */
  get busy(): boolean {
    return this.#pending > 0;
  }
  /** True once the response ended or the connection closed; writes now fail. */
  get closed(): boolean {
    return this.response.destroyed || this.response.writableEnded;
  }
  /**
   * Commit a streaming answer: send the status line and headers to the engine
   * now instead of with the first body byte, because some clients (Gemini:
   * 60 s) time out waiting for headers while the model is still working.
   * No-op once committed; the status can never change afterwards.
   */
  begin(status: number, contentType: string): void {
    if (this.response.headersSent) return;
    this.#head(status, contentType);
    this.response.flushHeaders();
    this.#mark();
  }
  async write(text: string): Promise<void> {
    if (this.closed) throw new ClientClosed();
    this.#mark();
    this.#pending++;
    try {
      await new Promise<void>((resolve, reject) =>
        this.response.write(text, (error) =>
          error ? reject(new ClientClosed()) : resolve(),
        ),
      );
    } finally {
      this.#pending--;
    }
  }
  async end(text = ""): Promise<void> {
    if (this.closed) throw new ClientClosed();
    this.#mark();
    await new Promise<void>((resolve) => this.response.end(text, resolve));
  }
  /**
   * Send a complete JSON response, or after a commit by {@link begin} only
   * the body; `status` then no longer applies.
   */
  async json(status: number, value: unknown): Promise<void> {
    if (!this.response.headersSent) this.#head(status, "application/json");
    await this.end(JSON.stringify(value));
  }
  #head(status: number, contentType: string): void {
    this.response.writeHead(status, {
      "content-type": contentType,
      "cache-control": "no-cache",
    });
  }
  #mark(): void {
    this.#writes++;
    this.#lastWrite = performance.now();
  }
}

/** Server-sent event text; `event` is written only for protocols that name events. */
export function sse(data: unknown, event?: string): string {
  return `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`;
}

/** Everything a sink needs besides the translated request. */
export interface SinkContext {
  /** Model id shown to the engine. */
  model: string;
  /** Forward upstream reasoning (`compatibility.reasoning` is `passthrough`). */
  reasoning: boolean;
  /** Estimated prompt tokens, for protocols that require usage up front. */
  promptEstimate: number;
  /** Unique id suffix for this call. */
  id: string;
  created: number;
}

/**
 * Protocol writer for one engine request. Stream sinks emit incrementally;
 * non-stream sinks write the aggregated body in `finish`. The gateway calls
 * `start` before any other content event and never calls anything after
 * `finish` or `fail`.
 */
export interface OutputSink {
  start(): Promise<void>;
  reasoning(text: string, field: ReasoningField): Promise<void>;
  text(text: string): Promise<void>;
  toolStart(call: { index: number; id: string; name: string }): Promise<void>;
  toolArgs(index: number, text: string): Promise<void>;
  finish(result: ChatResult): Promise<void>;
  /** Report a failure after headers were sent, then end the response. */
  fail(failure: Failure): Promise<void>;
  /**
   * Write one protocol-native keepalive. It carries no content: the response
   * the engine assembles, the usage and the call record stay as without it.
   * Called only after the headers were committed and never after `finish` or
   * `fail`; rejects with {@link ClientClosed} when the engine is gone.
   */
  keepalive(): Promise<void>;
  /**
   * Commit the success headers before the first upstream chunk, for clients
   * that time out waiting for headers. Implemented only by protocols that
   * need it (Gemini); the gateway calls it at most once, while not yet sent.
   */
  commit?(): void;
}
