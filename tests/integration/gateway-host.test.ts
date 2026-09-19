import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startHub } from "../../src/main.js";

/** GET through 127.0.0.1 with an explicit Host header, as a remote judge would send it. */
function get(
  port: number,
  route: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      { host: "127.0.0.1", port, path: route, method: "GET", headers },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (body += chunk));
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, body }),
        );
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}

void test("loopback binding rejects a remote Host; an explicit non-loopback binding accepts it but still rejects cross-origin browsers", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hh-host-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const local = await startHub({
    dataDir: path.join(root, "local"),
    demo: true,
    cwd: root,
    port: 0,
    host: "127.0.0.1",
  });
  t.after(() => local.server.close());
  const localPort = Number(new URL(local.url).port);
  const refused = await get(localPort, "/health/live", {
    host: `10.1.2.3:${localPort}`,
  });
  assert.equal(refused.status, 403);
  assert.match(refused.body, /LOCAL_ACCESS_REQUIRED/);

  const shared = await startHub({
    dataDir: path.join(root, "shared"),
    demo: true,
    cwd: root,
    port: 0,
    host: "0.0.0.0",
  });
  t.after(() => shared.server.close());
  const sharedPort = Number(new URL(shared.url).port);
  const accepted = await get(sharedPort, "/health/live", {
    host: `10.1.2.3:${sharedPort}`,
  });
  assert.equal(accepted.status, 200);
  const browser = await get(sharedPort, "/health/live", {
    host: `10.1.2.3:${sharedPort}`,
    origin: "http://attacker.example",
  });
  assert.equal(browser.status, 403);
});
