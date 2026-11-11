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
import { Fakes, declared, eventOf, fromAlpha, relayOf, turn, to } from "../fixtures/relay-fakes.js";
import { readRelayPrompt } from "../fixtures/relay-packet.js";

// The hint of the context table (docs/decisions/LOG.md, 2026-11-11): a handoff packet tells its target how to read the rest back with
// the Hub's tools exactly when the target's process has them. Two joints are tried here. The Runtime hands the renderer what the
// binding says (in-process Harnesses, a real store). The factory says it only when the process was started with the table's
// environment and the Harness's configuration holds the tool entry (the real composition, real processes, a probe in place of the
// capability service). The packet's own text is in tests/unit/relay-packet.test.ts.

const SENTENCES = /hub_turns, hub_read_turn and hub_search/u;

test("the Runtime hands the renderer the binding's fact: a packet to a process that has the Hub's tools says how to read the rest back, one to a process that does not says nothing of it", async t => {
  const { w, fakes, app, id } = await fromAlpha(t, { bravo: declared() }, "bravo");
  fakes.hubTools.add("bravo");
  const b1 = await turn(app, id, "b1 a question for bravo", "b1");
  const sent = readRelayPrompt(fakes.to("bravo")[0]!.text);
  assert.equal(sent.packet, true); assert.match(sent.body, SENTENCES); assert.equal(sent.currentInput.text, "b1 a question for bravo", "the user's words, exactly as typed, last");
  const record = eventOf(w.store, id, "run.context_prepared", b1.id)!.data.relay as Record<string, unknown>;
  assert.equal(record.hubTools, true, "the Run's record says its packet told of the tools");
  // Back on alpha, whose process has no tools: the update about bravo's Turn is the packet it always was.
  await to(app, id, "alpha", "to-alpha");
  const a2 = await turn(app, id, "a2 back on alpha", "a2");
  const back = readRelayPrompt(fakes.to("alpha").at(-1)!.text);
  assert.equal(back.kind, "delta"); assert.doesNotMatch(back.body, SENTENCES); assert.doesNotMatch(back.body, /not attached/u);
  assert.equal((eventOf(w.store, id, "run.context_prepared", a2.id)!.data.relay as Record<string, unknown>).hubTools, undefined);
  assert.equal(relayOf(app.read(id), "alpha").pending, null);
});

test("a process that has the tools on one Turn and not on the next is told so Turn by Turn: the fact is the process's, not the Session's", async t => {
  const { fakes, app, id } = await fromAlpha(t, { bravo: declared() }, "bravo");
  fakes.hubTools.add("bravo");
  await turn(app, id, "b1", "b1"); await to(app, id, "alpha", "to-alpha"); await turn(app, id, "a2", "a2");
  fakes.hubTools.delete("bravo"); await to(app, id, "bravo", "back-to-bravo"); await turn(app, id, "b2", "b2");
  assert.match(readRelayPrompt(fakes.to("bravo")[0]!.text).body, SENTENCES);
  assert.doesNotMatch(readRelayPrompt(fakes.to("bravo").at(-1)!.text).body, SENTENCES);
});

// ---------------------------------------------------------------------------------------------------------------------
// The factory: real processes, the real composition
// ---------------------------------------------------------------------------------------------------------------------

const HUB = "http://127.0.0.1:4317";
const PEER = `import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const native = "native-" + process.pid, send = value => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\\n");
appendFileSync(process.env.PEER_TRACE, JSON.stringify({ name: process.env.PEER_NAME, url: process.env.${TABLE_ENV.url} ?? null, session: process.env.${TABLE_ENV.session} ?? null }) + "\\n");
createInterface({ input: process.stdin }).on("line", line => {
  const m = JSON.parse(line);
  if (m.method === "initialize") send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } }, authMethods: [], agentInfo: { name: "hint-peer", version: "1.0" } } });
  else if (m.method === "session/new") send({ id: m.id, result: { sessionId: native } });
  else if (m.method === "session/resume") send({ id: m.id, result: {} });
  else if (m.method === "session/prompt") {
    appendFileSync(process.env.PEER_PROMPTS, JSON.stringify({ name: process.env.PEER_NAME, text: m.params.prompt.map(part => part.text ?? "").join("\\n") }) + "\\n");
    send({ method: "session/update", params: { sessionId: m.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } } } });
    send({ id: m.id, result: { stopReason: "end_turn" } });
  }
});
`;
interface Traced { readonly name: string; readonly url: string | null; readonly session: string | null }
type App = ReturnType<typeof application>;
async function fixture(t: test.TestContext, mount: TableMount) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "harness-table-hint-"))), peer = join(root, "peer.mjs"), trace = join(root, "trace.ndjson"), prompts = join(root, "prompts.ndjson"), manifest = join(root, "catalog.json");
  let app: App | null = null;
  t.after(async () => {
    if (app !== null) { await app.runtime.close(); await app.management.shutdown(); await app.providers.shutdown(); app.store.close(); }
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(peer, PEER);
  const definition = (name: string) => ({ id: name, name, aliases: [], binaryNames: [], configHints: [], controls: [{ id: name + "-acp", protocol: "acp-v1", executableNames: [name], args: [peer], env: { PEER_TRACE: trace, PEER_PROMPTS: prompts, PEER_NAME: name },
    requiredExecutables: [], package: null, distribution: null, source: { repository: "fixture", revision: "hint", upstreamId: name, url: "https://example.invalid/" + name } }] });
  await writeFile(manifest, JSON.stringify({ version: 2, definitions: [definition("hint-a"), definition("hint-b")], overrides: { "hint-a-acp": { executable: process.execPath }, "hint-b-acp": { executable: process.execPath } } }));
  app = application(join(root, "data"), () => {}, { installations: "any", workspaceLockRoot: join(root, "locks"), table: mount });
  const running = app;
  const configuration = async (name: string, configHome?: string): Promise<SessionConfiguration> => {
    const workspace = join(root, name); await mkdir(workspace, { recursive: true });
    return prepareConfiguration({ workspace, manifestPath: manifest, pathOnly: true, ...(configHome === undefined ? {} : { configHome }) });
  };
  const create = async (name: string, configHome?: string) => (await running.runtime.create(await configuration(name, configHome), { harnessId: "hint-a" }, "create-" + name)).id;
  const send = async (session: SessionId, text: string) => {
    running.runtime.send(session, text, "send-" + text.replace(/[^a-z0-9]+/giu, "-")); await running.runtime.wait(session);
    return running.runtime.read(session).runs.at(-1)!;
  };
  const switchTo = async (session: SessionId, harnessId: string) => { running.runtime.switch(session, { harnessId }, "switch-" + harnessId + "-" + Math.random().toString(36).slice(2)); await running.runtime.wait(session); };
  const lines = async <T>(file: string): Promise<readonly T[]> => { try { return (await readFile(file, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as T); } catch { return []; } };
  return { app: running, root, create, send, switchTo, spawns: () => lines<Traced>(trace), prompts: () => lines<{ name: string; text: string }>(prompts) };
}

test("the factory says a process has the Hub's tools when it carries the table and its Harness holds the tool entry; the packet that process is handed then says how to read the rest back", async t => {
  const mount = new TableMount(); mount.listening(HUB);
  const asked: string[] = [];
  mount.toolsIn(async harnessId => { asked.push(harnessId); return harnessId === "hint-b"; });
  const f = await fixture(t, mount), id = await f.create("one");
  assert.equal((await f.send(id, "first on a")).status, "completed");
  await f.switchTo(id, "hint-b");
  const second = await f.send(id, "second on b");
  assert.equal(second.status, "completed");
  const [toA, toB] = await f.prompts();
  assert.equal(toA!.text, "first on a", "nothing was owed to a");
  assert.match(toB!.text, SENTENCES, "b's process has the tools: the packet says how to read the rest back");
  assert.equal(readRelayPrompt(toB!.text).currentInput.text, "second on b");
  assert.equal((eventOf(f.app.store, id, "run.context_prepared", second.id)!.data.relay as Record<string, unknown>).hubTools, true);
  // Each process the Hub started was asked about once, for its own Harness.
  assert.deepEqual(asked, ["hint-a", "hint-b"]);
  // The process of b carried the table, so the tools it holds can read this conversation; so did a's, which holds no entry: the table is there for any Turn.
  const [inA, inB] = await f.spawns();
  assert.ok(inA!.url === HUB && inA!.session && inB!.url === HUB && inB!.session);
  // Back on a, which holds no tool entry: the update is the packet it always was.
  await f.switchTo(id, "hint-a");
  await f.send(id, "third on a");
  assert.doesNotMatch((await f.prompts()).at(-1)!.text, SENTENCES); assert.match((await f.prompts()).at(-1)!.text, /handoff update/u);
});

test("without the table's address, with a configuration home of its own, or with a Harness that does not hold the entry, the process is not said to have the tools, and the packet says nothing of them", async t => {
  // The Hub does not listen: nothing to carry, whatever the Harness holds.
  const silent = new TableMount(); silent.toolsIn(async () => true);
  const quiet = await fixture(t, silent), one = await quiet.create("one");
  await quiet.send(one, "first"); await quiet.switchTo(one, "hint-b"); await quiet.send(one, "second");
  assert.deepEqual((await quiet.spawns()).map(spawn => [spawn.url, spawn.session]), [[null, null], [null, null]]);
  assert.doesNotMatch((await quiet.prompts())[1]!.text, SENTENCES); assert.match((await quiet.prompts())[1]!.text, /HarnessHub handoff/u, "a packet was handed over all the same");

  // A configuration home of its own: the process reads another HOME than the one the Hub's tool entry was written in.
  const mount = new TableMount(); mount.listening(HUB); mount.toolsIn(async () => true);
  const home = await fixture(t, mount);
  await mkdir(join(home.root, "own-home"), { recursive: true });
  const isolated = await home.create("isolated", join(home.root, "own-home"));
  await home.send(isolated, "first"); await home.switchTo(isolated, "hint-b"); await home.send(isolated, "second");
  assert.ok((await home.spawns()).every(spawn => spawn.url === HUB && spawn.session), "the table's environment is there; the entry is in another configuration");
  assert.doesNotMatch((await home.prompts())[1]!.text, SENTENCES);

  // No Harness holds the entry, a probe that cannot tell, and no probe at all.
  for (const probe of [async () => false, async () => { throw new Error("cannot read the configuration"); }, null] as const) {
    const m = new TableMount(); m.listening(HUB); m.toolsIn(probe);
    const f = await fixture(t, m), id = await f.create("one");
    await f.send(id, "first"); await f.switchTo(id, "hint-b"); const second = await f.send(id, "second");
    assert.equal(second.status, "completed", "a probe that fails fails no Turn");
    assert.doesNotMatch((await f.prompts())[1]!.text, SENTENCES);
  }
});
