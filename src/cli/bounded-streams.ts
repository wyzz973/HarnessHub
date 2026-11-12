import type { Writable } from "node:stream";
import { SessionError } from "../contracts/session.js";

export const MAX_CLI_OUTPUT_BYTES = 16 * 1024 * 1024;

/** Synchronous publication may queue only a bounded amount; a slow receiver never creates an unlimited queue. */
export function boundedWrite(stream: Writable, text: string): void {
  const bytes = Buffer.byteLength(text, "utf8");
  if (stream.destroyed || stream.writableEnded) throw new SessionError("PUBLICATION_FAILED", "output stream is closed");
  if (bytes > MAX_CLI_OUTPUT_BYTES || stream.writableLength + bytes > MAX_CLI_OUTPUT_BYTES)
    throw new SessionError("OUTPUT_LIMIT", "CLI output buffer byte budget exhausted; committed history remains queryable");
  stream.write(text);
}
