import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TABLE_ENV } from "../../src/contracts/table.js";
import { WatchedMount } from "../real/ruler/mount.js";
import { openWebHub } from "../real/ruler/web.js";
import { oldShape } from "../fixtures/old-shape.js";

// The ruler's Hub for a run with the context table mounted (HH_REAL_TABLE=1, tests/real/ruler/web.ts) in front of a Harness that is a
// fixture: the Hub's own web server on a random loopback port, over the application the ruler composes, whose Runtime the ruler drives.
// The Harness is an ACP peer that reads the conversation back over HTTP with the environment it was started with, as the Hub's tool
// program does for a real one.

const PEER = `import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const native = "native-" + process.pid, send = value => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\\n");
createInterface({ input: process.stdin }).on("line", async line => {
  const m = JSON.parse(line);
  if (m.method === "initialize") send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } }, authMethods: [], agentInfo: { name: "web-peer", version: "1.0" } } });
  else if (m.method === "session/new") send({ id: m.id, result: { sessionId: native } });
  else if (m.method === "session/resume") send({ id: m.id, result: {} });
  else if (m.method === "session/prompt") {
    let seen;
    try {
      const reply = await fetch(process.env.${TABLE_ENV.url} + "/api/table/turns", { headers: { Authorization: "Bearer " + process.env.${TABLE_ENV.session} } });
      seen = { status: reply.status, body: await reply.json() };
    } catch (error) { seen = { error: String(error) }; }
    appendFileSync(process.env.PEER_TRACE, JSON.stringify({ url: process.env.${TABLE_ENV.url} ?? null, seen }) + "\\n");
    send({ method: "session/update", params: { sessionId: m.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } } } });
    send({ id: m.id, result: { stopReason: "end_turn" } });
  }
});
`;

test("the ruler's web Hub gives a native process the table: its token is good at the Hub's own server for its own conversation, and the evidence knows the process had it", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ruler-web-"))), peer = join(root, "peer.mjs"), trace = join(root, "trace.ndjson"), manifest = join(root, "catalog.json");
  let hub: Awaited<ReturnType<typeof openWebHub>> | undefined;
  t.after(async () => { await hub?.close(); await rm(root, { recursive: true, force: true }); });
  await writeFile(peer, PEER);
  const definition = { id: "web-peer", name: "Web peer", aliases: [], binaryNames: [], configHints: [], controls: [{ id: "web-peer-acp", protocol: "acp-v1", executableNames: ["web-peer"], args: [peer], env: { PEER_TRACE: trace },
    requiredExecutables: [], package: null, distribution: null, source: { repository: "fixture", revision: "web", upstreamId: "web-peer", url: "https://example.invalid/web-peer" } }] };
  await writeFile(manifest, JSON.stringify({ version: 2, definitions: [definition], overrides: { "web-peer-acp": { executable: process.execPath } } }));
  const workspace = join(root, "workspace"), data = join(root, "data"), home = join(root, "home");
  await mkdir(workspace); await mkdir(home);
  const mount = new WatchedMount();
  // A private home and a PATH that holds none of this computer's Harnesses: the Hub's start-up discovery finds the fixture only.
  hub = await openWebHub({ workspace, data }, { mount, installations: "any", locks: join(root, "locks"), budgets: { executionBudgetMs: 60_000 }, manifest, environment: { home, values: { HOME: home, PATH: "/usr/bin:/bin" } } });
  assert.match(mount.url ?? "", /^http:\/\/127\.0\.0\.1:[0-9]{1,5}$/u, "the server gave the mount its address");
  assert.ok(hub.table !== undefined, "the cell's Hub says it has a mount to ask");

  const id = (await hub.runtime.create(hub.configuration, { harnessId: "web-peer" }, "create")).id;
  const sent = Date.now();
  hub.runtime.send(id, "hello from the ruler", "send-1"); await hub.runtime.wait(id);
  const ended = Date.now(), run = oldShape(hub.runtime, id).runs.at(-1)!;
  assert.equal(run.status, "completed");
  const [seen] = (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { url: string; seen: { status?: number; error?: string; body?: { total: number; lines: { n: number; status: string; user: string }[] } } });
  assert.equal(seen!.url, mount.url);
  assert.equal(seen!.seen.error, undefined, "the process reached the server");
  assert.equal(seen!.seen.status, 200, "and its token was accepted");
  assert.deepEqual([seen!.seen.body!.total, seen!.seen.body!.lines[0]!.n, seen!.seen.body!.lines[0]!.user], [1, 1, "hello from the ruler"], "it reads its own conversation: the Turn it is running");
  // The evidence: the process had the table's environment during the step; the fixture is no installed Claude Code or Codex, so no tool entry is in its configuration.
  assert.equal(hub.table!.carried(id, "web-peer", sent, ended), true);
  assert.equal(hub.table!.carried(id, "other", sent, ended), false);
  assert.equal(await hub.table!.hasTools("web-peer"), false);
  await hub.close(); hub = undefined;
  assert.equal(mount.url, null, "a Hub that stopped has no address to give");
  assert.equal(await mount.hasTools("web-peer"), false);
});
