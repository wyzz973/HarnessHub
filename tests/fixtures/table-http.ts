import { createServer, type Server } from "node:http";
import { SessionError } from "../../src/contracts/session.js";
import { TableApi, type TableApiOptions } from "../../src/web/table-routes.js";

/*
 * The context table's HTTP API mounted on a loopback port of its own, as the web server mounts it (src/web/server.ts) but with the conversations read from rows: for the tests that hold
 * the table to what the build before the cut said of it, and to what a Harness's tool process reads. Nothing here is the web server's.
 */
export interface MountedTable { readonly origin: string; close(): Promise<void> }
export async function mountTable(options: Omit<TableApiOptions, "http">): Promise<MountedTable> {
  const api = new TableApi({ ...options, http: {
    json: (response, status, value) => { response.statusCode = status; response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(value)); },
    queries: (url, allowed) => { for (const key of url.searchParams.keys()) if (!allowed.includes(key)) throw new SessionError("INVALID_INPUT", "unknown query " + key); },
  } });
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    api.handle(request, response, url, request.method ?? "GET").then(handled => { if (!handled) { response.statusCode = 404; response.end("{}"); } }, error => {
      // The web server's own mapping (publicFailure in src/web/server.ts), as far as the table uses it.
      const code = error instanceof SessionError ? error.code : "INTERNAL";
      response.statusCode = code.includes("NOT_FOUND") ? 404 : code === "INVALID_INPUT" ? 400 : code.includes("UNAVAILABLE") ? 409 : 502;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ code, message: error instanceof Error ? error.message : "failed" }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address !== "object") throw new Error("the table's fixture server has no port");
  return { origin: "http://127.0.0.1:" + address.port, close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }) };
}
