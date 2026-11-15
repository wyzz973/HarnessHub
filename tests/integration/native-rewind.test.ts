import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CodexControl } from "../../src/adapters/control/codex.js";
import { codexFlavor } from "../../src/adapters/flavors/codex.js";
import type { CleanupEvidence } from "../../src/contracts/control.js";
import { SessionError, type HarnessSelection, type PreparedSessionBinding, type SelectionRequest, type SessionBindingFactory, type SessionConfiguration, type SessionId } from "../../src/contracts/session.js";
import { SessionRuntime } from "../../src/contexts/session/application/runtime.js";
import { SqliteWorkspaceLeaseProvider } from "../../src/infrastructure/session/workspace-lease.js";
import { appStore } from "../fixtures/runtime-store.js";
import { oldShape } from "../fixtures/old-shape.js";

const peer = fileURLToPath(new URL("../../../tests/fixtures/control-peer.mjs", import.meta.url));
const NOW = new Date("2026-11-15T00:00:00Z");

/** The Codex fixture behind real workspace leases; `revert` lets it list and cut its turns (thread/turns/list, thread/revert). */
class Factory implements SessionBindingFactory {
  readonly prepared: { readonly trace: string; closed: boolean }[] = [];
  private readonly lease: SqliteWorkspaceLeaseProvider;
  constructor(private readonly root: string, private readonly revert: boolean) { this.lease = new SqliteWorkspaceLeaseProvider(join(root, "leases")); }
  async validate(request: SelectionRequest): Promise<HarnessSelection> {
    if (request.harnessId !== "alpha") throw new SessionError("HARNESS_UNAVAILABLE", "fixture target is unavailable");
    return { harnessId: "alpha", controlId: "alpha-codex" };
  }
  async prepare(_selected: HarnessSelection, configuration: SessionConfiguration, session: SessionId, run: string): Promise<PreparedSessionBinding> {
    const lease = this.lease.acquire(configuration.workspace, session, run), trace = join(this.root, "trace-" + this.prepared.length + ".ndjson");
    const entry = { trace, closed: false }; this.prepared.push(entry);
    const env = { FIXTURE_TRACE: trace, FIXTURE_THREAD_ID: "thread-fixture-" + session, LANG: "C.UTF-8", ...(this.revert ? { FIXTURE_REVERT: "1" } : {}) };
    const control = new CodexControl({ protocol: "codex-app-server", executable: process.execPath, args: [peer, "codex-app-server", "basic"], env },
      { cwd: configuration.workspace, env, requestTimeoutMs: 2000, runTimeoutMs: 5000, maxFrameBytes: 2 * 1024 * 1024, maxDiagnosticBytes: 4096, closeGraceMs: 120 });
    let close: Promise<CleanupEvidence> | null = null;
    return { control, workspace: configuration.workspace, assertOwned: () => lease.assertOwned(), close: () => {
      close ??= (async () => { let evidence: CleanupEvidence | null = null; try { evidence = await control.close(); return evidence; } finally { lease.release(evidence?.closed === true); entry.closed = true; } })();
      return close;
    } };
  }
}
async function setup(t: test.TestContext, revert: boolean) {
  const root = await mkdtemp(join(tmpdir(), "harness-native-rewind-")), store = appStore(join(root, "data")), factory = new Factory(root, revert);
  let id = 0;
  // The fixture Harness declares what Codex does: its process is kept between Turns and it takes Turns off its own thread.
  const app = new SessionRuntime(store, factory, { id: () => String(++id), now: () => NOW, publish: () => {}, fingerprint: value => createHash("sha256").update(value).digest("hex"),
    flavor: () => ({ ...codexFlavor, harnessId: "alpha" }) });
  t.after(async () => { try { await app.close(); } finally { store.close(); await rm(root, { recursive: true, force: true }); } });
  const path = join(root, "work"); await mkdir(path, { recursive: true });
  const configuration: SessionConfiguration = { workspace: path, manifestPath: null, manifestSha256: null, configHome: null, packageRoots: [], searchDirs: [], pathOnly: true };
  const methods = async (index: number) => (await readFile(factory.prepared[index]!.trace, "utf8")).trim().split("\n").map(line => (JSON.parse(line) as { method?: string }).method ?? "");
  const events = (session: SessionId, type: string) => store.events(session, 0).filter(event => event.type === type).map(event => event.data as Record<string, unknown>);
  return { app, factory, configuration, methods, events };
}
async function twoTurns(app: SessionRuntime, configuration: SessionConfiguration) {
  const session = await app.create(configuration, { harnessId: "alpha" }, "create");
  app.send(session.id, "first", "first"); await app.wait(session.id);
  app.send(session.id, "second", "second"); await app.wait(session.id);
  return { id: session.id, second: oldShape(app, session.id).runs[1]! };
}

test("a message edited and sent again goes on in the same native session: the kept process takes the Turns after it off its thread", async t => {
  const { app, factory, configuration, methods, events } = await setup(t, true);
  const { id, second } = await twoTurns(app, configuration);
  assert.equal(second.retained, true, "the process is kept between Turns by default");
  app.send(id, "edited", "edited", [], undefined, second.id); await app.wait(id);
  const state = oldShape(app, id), edited = state.runs[1]!;
  assert.equal(state.runs.length, 2); assert.equal(edited.status, "completed"); assert.equal(edited.reused, true);
  assert.equal(factory.prepared.length, 1, "no program was started again");
  assert.deepEqual(events(id, "conversation.branched")[0]?.rewound, [{ harnessId: "alpha", controlId: "alpha-codex", turns: 1 }]);
  assert.deepEqual(events(id, "native.rolled_back").map(data => data.turns), [1]);
  assert.equal((await methods(0)).filter(method => method === "thread/revert").length, 1);
  assert.equal(edited.relay?.packetId ?? null, null, "nothing is handed over: the native session holds the path");
  const binding = state.nativeBindings?.find(row => row.status !== "archived");
  assert.equal(binding?.rewind, undefined); assert.equal(binding?.throughRunId, edited.id); assert.equal(state.nativeBindings?.length, 1);
});

test("where the Harness cannot take them off, its session is given up for a new one handed the path, and the Turns left stay in the record", async t => {
  const { app, factory, configuration, events } = await setup(t, false);
  const { id, second } = await twoTurns(app, configuration);
  app.send(id, "edited", "edited", [], undefined, second.id); await app.wait(id);
  const state = oldShape(app, id), edited = state.runs[1]!;
  assert.equal(edited.status, "completed");
  assert.equal(events(id, "native.rollback_failed").length, 1);
  assert.deepEqual(events(id, "native.binding_reseated").map(data => data.reason), ["rewind"]);
  assert.equal(factory.prepared.length, 2, "the program was started again for the new session");
  assert.notEqual(edited.relay?.packetId ?? null, null, "the new native session is handed the path");
  assert.equal(state.nativeBindings?.filter(row => row.status !== "archived").length, 1);
});

test("a process opened ahead of a conversation not made yet is the one its first Turn runs on, and one never taken is closed with the runtime", async t => {
  const { app, factory, configuration, events } = await setup(t, true);
  assert.deepEqual(await app.warmNew(configuration, { harnessId: "alpha" }, "create-warm"), { warming: true });
  await app.warmNew(configuration, { harnessId: "alpha" }, "never-made");
  for (let i = 0; i < 100 && factory.prepared.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 20));
  const session = await app.create(configuration, { harnessId: "alpha" }, "create-warm");
  app.send(session.id, "first", "first"); await app.wait(session.id);
  const run = oldShape(app, session.id).runs[0]!;
  assert.equal(run.status, "completed"); assert.equal(run.reused, true);
  assert.equal(factory.prepared.length, 2, "the first Turn started no program of its own");
  assert.deepEqual(events(session.id, "native.process_reused").map(data => [data.previousRunId, data.opened]), [[null, "ahead"]]);
  assert.equal(events(session.id, "run.protocol").length, 1, "its handshake is still said, once");
  await app.close();
  assert.equal(factory.prepared.every(entry => entry.closed), true);
});
