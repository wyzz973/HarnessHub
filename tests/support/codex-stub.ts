// SPDX-License-Identifier: MIT
/**
 * A loopback stand-in for ChatGPT's Codex backend, which daemons started by
 * tests forward the Codex passthrough to (`startHub({codexBackend})`), so
 * that no test can reach chatgpt.com even when path handling regresses. It
 * records every request and answers a Responses stream for `/responses`
 * and an empty model list for `/models`.
 */
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import type { TestContext } from "node:test";

/** One request the stand-in received. */
export interface CodexStubRequest {
  method: string;
  /** The path and query under the stand-in's origin. */
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

/** A Responses stream that completes with a short message. */
export const CODEX_STUB_EVENTS = [
  {
    type: "response.created",
    sequence_number: 0,
    response: { id: "resp_stub", status: "in_progress", output: [] },
  },
  {
    type: "response.completed",
    sequence_number: 1,
    response: {
      id: "resp_stub",
      object: "response",
      status: "completed",
      model: "gpt-5.1-codex",
      output: [],
      usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
    },
  },
]
  .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  .join("");

/**
 * Starts the stand-in on 127.0.0.1 and closes it after the test. `url` is
 * the value for `startHub({codexBackend})`.
 */
export async function startCodexStub(
  t: TestContext,
): Promise<{ url: string; requests: CodexStubRequest[] }> {
  const requests: CodexStubRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const url = request.url ?? "";
      requests.push({
        method: request.method ?? "",
        url,
        headers: request.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      if (url.split("?")[0]!.endsWith("/models")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ models: [] }));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(CODEX_STUB_EVENTS);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/backend-api/codex`, requests };
}
