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

/** Serializes writes to one engine response and applies socket backpressure. */
export class HttpWriter {
  constructor(private readonly response: ServerResponse) {}
  /** True once the status line was sent; later failures must be in-band. */
  get sent(): boolean {
    return this.response.headersSent;
  }
  begin(status: number, contentType: string): void {
    if (this.response.headersSent) return;
    this.response.writeHead(status, {
      "content-type": contentType,
      "cache-control": "no-cache",
    });
  }
  async write(text: string): Promise<void> {
    if (this.response.destroyed || this.response.writableEnded)
      throw new ClientClosed();
    await new Promise<void>((resolve, reject) =>
      this.response.write(text, (error) =>
        error ? reject(new ClientClosed()) : resolve(),
      ),
    );
  }
  async end(text = ""): Promise<void> {
    if (this.response.destroyed || this.response.writableEnded)
      throw new ClientClosed();
    await new Promise<void>((resolve) => this.response.end(text, resolve));
  }
  /** Send a complete JSON response. */
  async json(status: number, value: unknown): Promise<void> {
    this.begin(status, "application/json");
    await this.end(JSON.stringify(value));
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
 * `start` before any other event and never after `finish` or `fail`.
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
}
