import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { application } from "../../src/cli/session-application.js";
import { TABLE_ENV } from "../../src/contracts/table.js";
import type { SessionConfiguration, SessionId } from "../../src/contracts/session.js";
import { prepareConfiguration } from "../../src/infrastructure/session/binding-factory.js";
import { TableMount } from "../../src/infrastructure/table/mount.js";
import { oldShape } from "../fixtures/old-shape.js";

// The context table's mount (docs/decisions/LOG.md, 2026-11-11), through the formal composition: application(), a real store
// and workspace leases, and an ACP peer that records the table variables it was started with. Only the Harness is a fixture.

const URL_OF_HUB = "http://127.0.0.1:4317";
const PEER = `import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const native = "native-" + process.pid, send = value => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\\n");
appendFileSync(process.env.PEER_TRACE, JSON.stringify({ pid: process.pid, tmpdir: process.env.TMPDIR, url: process.env.${TABLE_ENV.url} ?? null, session: process.env.${TABLE_ENV.session} ?? null }) + "\\n");
createInterface({ input: process.stdin }).on("line", line => {
  const m = JSON.parse(line);
  if (m.method === "initialize") send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } }, authMethods: [], agentInfo: { name: "table-peer", version: "1.0" } } });
  else if (m.method === "session/new") send({ id: m.id, result: { sessionId: native } });
  else if (m.method === "session/resume") send({ id: m.id, result: {} });
  else if (m.method === "session/prompt") {
    send({ method: "session/update", params: { sessionId: m.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } } } });
    send({ id: m.id, result: { stopReason: "end_turn" } });
  }
});
`;
interface Spawn { readonly pid: number; readonly tmpdir: string; readonly url: string | null; readonly session: string | null }
type App = ReturnType<typeof application>;
async function fixture(t: test.TestContext, table?: TableMount) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "harness-table-mount-"))), peer = join(root, "peer.mjs"), trace = join(root, "trace.ndjson"), manifest = join(root, "catalog.json");
  let app: App | null = null;
  t.after(async () => {
    if (app !== null) { await app.runtime.close(); await app.management.shutdown(); await app.providers.shutdown(); app.store.close(); }
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(peer, PEER);
  const definition = { id: "table-peer", name: "Table peer", aliases: [], binaryNames: [], configHints: [], controls: [{ id: "table-peer-acp", protocol: "acp-v1", executableNames: ["table-peer"],
    args: [peer], env: { PEER_TRACE: trace }, requiredExecutables: [], package: null, distribution: null,
    source: { repository: "fixture", revision: "table", upstreamId: "table-peer", url: "https://example.invalid/table-peer" } }] };
  await writeFile(manifest, JSON.stringify({ version: 2, definitions: [definition], overrides: { "table-peer-acp": { executable: process.execPath } } }));
  app = application(join(root, "data"), () => {}, { installations: "any", workspaceLockRoot: join(root, "locks"), ...(table === undefined ? {} : { table }) });
  const running = app;
  const configuration = async (name: string): Promise<SessionConfiguration> => {
    const workspace = join(root, name); await mkdir(workspace, { recursive: true });
    return prepareConfiguration({ workspace, manifestPath: manifest, pathOnly: true });
  };
  const create = async (name: string) => (await running.runtime.create(await configuration(name), { harnessId: "table-peer" }, "create-" + name)).id;
  const turn = async (session: SessionId, text: string) => {
    running.runtime.send(session, text, "send-" + text.replace(/[^a-z0-9]+/giu, "-")); await running.runtime.wait(session);
    return oldShape(running.runtime, session).runs.at(-1)!;
  };
  const spawns = async (): Promise<readonly Spawn[]> => { try { return (await readFile(trace, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as Spawn); } catch { return []; } };
  return { app: running, create, turn, spawns };
}

test("a native process starts with the Hub's address and a token that is its Session's, still good while the Hub keeps the process and gone with it", async t => {
  const mount = new TableMount(); mount.listening(URL_OF_HUB);
  const f = await fixture(t, mount), a = await f.create("a"), b = await f.create("b");
  f.app.runtime.setRetention(a, true, "keep-a"); f.app.runtime.setRetention(b, true, "keep-b");
  assert.equal((await f.turn(a, "first in a")).status, "completed"); assert.equal((await f.turn(b, "first in b")).status, "completed");
  const [inA, inB] = await f.spawns();
  assert.ok(inA && inB);
  assert.deepEqual([inA.url, inB.url], [URL_OF_HUB, URL_OF_HUB]);
  assert.ok(inA.session && inB.session && inA.session !== inB.session, "a token per process");
  // Each token says which conversation, Harness and entry it serves.
  assert.deepEqual(mount.grants.resolve(inA.session), { sessionId: a, harnessId: "table-peer", controlId: "table-peer-acp" });
  assert.deepEqual(mount.grants.resolve(inB.session), { sessionId: b, harnessId: "table-peer", controlId: "table-peer-acp" });
  // The kept process serves the next Turn with the token it has; nothing starts, nothing is minted.
  assert.equal((await f.turn(a, "second in a")).status, "completed");
  assert.equal((await f.spawns()).length, 2, "the kept process took the Turn");
  assert.equal(mount.grants.resolve(inA.session)?.sessionId, a);
  // Closing one conversation ends its process and its token; the other's stays good.
  await f.app.runtime.closeSession(a, "close-a");
  assert.equal(mount.grants.resolve(inA.session), null);
  assert.equal(mount.grants.resolve(inB.session)?.sessionId, b);
  await f.app.runtime.closeSession(b, "close-b");
  assert.equal(mount.grants.resolve(inB.session), null);
  assert.equal(mount.grants.resolve("not-a-token"), null);
});

test("each Turn without a kept process is a new process with a new token, the old one gone, and the tokens do not make a host class of each Turn", async t => {
  const mount = new TableMount(); mount.listening(URL_OF_HUB);
  const f = await fixture(t, mount), session = await f.create("one");
  assert.equal((await f.turn(session, "first")).status, "completed"); assert.equal((await f.turn(session, "second")).status, "completed");
  const [first, second] = await f.spawns();
  assert.ok(first?.session && second?.session && first.session !== second.session, "a resumed native session gets a process, and so a token, of its own");
  assert.deepEqual([mount.grants.resolve(first.session), mount.grants.resolve(second.session)], [null, null], "the processes ended, and their tokens with them");
  assert.equal(first.tmpdir, second.tmpdir, "the host class, and its TMPDIR, is the same whatever the token");
});

test("a Hub that does not listen, or has no mount, starts its processes without the table", async t => {
  const silent = new TableMount();
  const quiet = await fixture(t, silent), one = await quiet.create("one");
  assert.equal((await quiet.turn(one, "hello")).status, "completed");
  assert.deepEqual((await quiet.spawns()).map(spawn => [spawn.url, spawn.session]), [[null, null]]);
  const bare = await fixture(t), two = await bare.create("two");
  assert.equal((await bare.turn(two, "hello")).status, "completed");
  assert.deepEqual((await bare.spawns()).map(spawn => [spawn.url, spawn.session]), [[null, null]]);
});
