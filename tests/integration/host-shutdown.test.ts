import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { application } from "../../src/cli/session-application.js";
import type { ControlOptions } from "../../src/contracts/control.js";
import { resolveHostBudgets } from "../../src/contracts/native-host.js";
import { ControlError, JsonRpcProcess } from "../../src/infrastructure/control/json-rpc-process.js";
import { prepareConfiguration } from "../../src/infrastructure/session/binding-factory.js";

// The close chain of ADR-056 §4.11 (G085-C01) on real child processes: the input closes first, the group is signalled only
// after the grace (resolveHostBudgets' own, 1.5 s), and the chain records how far it went and how long it took. Three tests
// run Turns through the formal composition, where the binding factory takes the same grace: what that grace and the close
// mean for the Turn's end, the next Turn and a stop pressed after the reply.

const budgets = resolveHostBudgets({ physicalMemoryBytes: totalmem() });
/**
 * A JSON-RPC peer that answers initialize and then leaves PEER_EXIT_AFTER_EOF_MS after its input closes ("never": it stays),
 * writing every SIGTERM, SIGINT or SIGHUP it gets to PEER_SIGNALS with the time since its input closed. On SIGTERM it leaves
 * at once, unless PEER_ON_TERM is "ignore".
 */
const PEER = `import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const after = process.env.PEER_EXIT_AFTER_EOF_MS, ignore = process.env.PEER_ON_TERM === "ignore";
let eofAt = null;
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => {
  appendFileSync(process.env.PEER_SIGNALS, JSON.stringify({ signal, afterEofMs: eofAt === null ? null : Date.now() - eofAt }) + "\\n");
  if (signal !== "SIGTERM" || !ignore) process.exit(0);
});
setInterval(() => {}, 1000);
createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } }) + "\\n");
});
process.stdin.on("end", () => { eofAt = Date.now(); if (after !== "never") setTimeout(() => process.exit(0), Number(after)); });
`;
async function root(t: test.TestContext, name: string): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), name)));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
async function signals(path: string): Promise<readonly { readonly signal: string; readonly afterEofMs: number | null }[]> {
  try { return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { signal: string; afterEofMs: number | null }); }
  catch (error) { if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return []; throw error; }
}

test("G085-C01 a program that leaves 0.3 s or 1.2 s after its input closes gets no signal; one still running after the 1.5 s grace gets SIGTERM, and one that ignores it SIGKILL", async t => {
  const directory = await root(t, "harness-host-shutdown-"), peer = join(directory, "peer.mjs"); await writeFile(peer, PEER);
  assert.equal(budgets.closeGraceMs, 1_500, "the production grace");
  const options: ControlOptions = { cwd: directory, env: {}, requestTimeoutMs: 2_000, runTimeoutMs: 5_000, maxFrameBytes: 4_096, maxDiagnosticBytes: 1_024,
    closeGraceMs: budgets.closeGraceMs, closeOutsideWaitMs: budgets.closeOutsideWaitMs };
  const cases = [
    { name: "leaves 0.3 s after EOF", after: "300", onTerm: "exit", stage: "eof" },
    { name: "leaves 1.2 s after EOF", after: "1200", onTerm: "exit", stage: "eof" },
    { name: "would leave 2.5 s after EOF, leaves on SIGTERM", after: "2500", onTerm: "exit", stage: "sigterm" },
    { name: "never leaves and ignores SIGTERM", after: "never", onTerm: "ignore", stage: "sigkill" },
  ] as const;
  const results = await Promise.all(cases.map(async (item, index) => {
    const marks = join(directory, "signals-" + index + ".ndjson");
    const rpc = new JsonRpcProcess({ protocol: "acp-v1", executable: process.execPath, args: [peer], env: { PEER_EXIT_AFTER_EOF_MS: item.after, PEER_ON_TERM: item.onTerm, PEER_SIGNALS: marks } },
      options, { notification: () => {}, request: () => { throw new ControlError("METHOD_NOT_FOUND", "unsupported"); }, failure: () => {} });
    t.after(async () => { const pid = rpc.processGroup; if (pid !== null && alive(pid)) process.kill(-pid, "SIGKILL"); });
    await rpc.request("initialize", {});
    const pid = rpc.processGroup!, evidence = await rpc.closeEvidence();
    return { item, pid, evidence, cleanup: await rpc.close(), received: await signals(marks), again: rpc.close() === rpc.close() };
  }));
  for (const { item, pid, evidence, cleanup, received, again } of results) {
    assert.equal(evidence.cleanup.stage, item.stage, item.name);
    assert.equal(alive(pid), false, item.name + ": the program is gone");
    // The close time is the chain's own evidence; a Run keeps exactly the four cleanup fields it always kept.
    assert.deepEqual(Object.keys(cleanup).sort(), ["closed", "exitCode", "protocolFailure", "signal"], item.name);
    assert.deepEqual(cleanup, { closed: true, exitCode: evidence.cleanup.exitCode, signal: evidence.cleanup.signal, protocolFailure: null }, item.name);
    assert.equal(again, true, item.name + ": close() stays one promise");
    // Nothing left the group, which the chain enumerated (zero, not unknown).
    assert.deepEqual(evidence.outside, { state: "enumerated", found: 0, remaining: 0, commands: [] }, item.name);
    if (item.stage === "eof") {
      assert.deepEqual(received, [], item.name + ": no signal at all");
      assert.ok(evidence.cleanup.closeMs >= Number(item.after) && evidence.cleanup.closeMs < budgets.closeGraceMs + 400, item.name + " took " + evidence.cleanup.closeMs + " ms");
      assert.equal(cleanup.exitCode, 0); assert.equal(cleanup.signal, null);
    } else {
      assert.equal(received[0]?.signal, "SIGTERM", item.name);
      assert.ok((received[0]?.afterEofMs ?? 0) >= budgets.closeGraceMs - 60, item.name + ": SIGTERM only after the grace, at " + received[0]?.afterEofMs + " ms");
      assert.equal(received.length, 1, item.name + ": SIGTERM once, nothing else it could see");
    }
    if (item.stage === "sigterm") assert.ok(evidence.cleanup.closeMs >= budgets.closeGraceMs && evidence.cleanup.closeMs < 2_500, item.name + " took " + evidence.cleanup.closeMs + " ms");
    if (item.stage === "sigkill") {
      assert.equal(cleanup.signal, "SIGKILL", item.name);
      assert.ok(evidence.cleanup.closeMs >= 2 * budgets.closeGraceMs, item.name + " took " + evidence.cleanup.closeMs + " ms");
    }
  }
});

test("G085-C01 a program never started has nothing to close: no stage, no time, nothing enumerated", async () => {
  const rpc = new JsonRpcProcess({ protocol: "acp-v1", executable: process.execPath, args: ["-e", ""], env: {} },
    { cwd: process.cwd(), env: {}, requestTimeoutMs: 1_000, runTimeoutMs: 1_000, maxFrameBytes: 4_096, maxDiagnosticBytes: 128, closeGraceMs: budgets.closeGraceMs },
    { notification: () => {}, request: () => {}, failure: () => {} });
  assert.deepEqual(await rpc.closeEvidence(), { cleanup: { closed: true, exitCode: null, signal: null, protocolFailure: null, stage: null, closeMs: 0 }, outside: { state: "unknown" } });
  assert.deepEqual(await rpc.close(), { closed: true, exitCode: null, signal: null, protocolFailure: null });
});

test("G085-C01 a Turn through the formal composition closes its program with the 1.5 s grace: one leaving 1.2 s after EOF is never signalled, and the Run keeps its cleanup as before", async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "harness-host-shutdown-turn-"))), workspace = join(directory, "workspace"), peer = join(directory, "peer.mjs"), trace = join(directory, "trace.ndjson"), marks = join(directory, "signals.ndjson");
  await mkdir(workspace);
  await writeFile(peer, `import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
let eofAt = null;
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => { appendFileSync(process.env.PEER_SIGNALS, JSON.stringify({ signal, afterEofMs: eofAt === null ? null : Date.now() - eofAt }) + "\\n"); process.exit(0); });
appendFileSync(process.env.PEER_TRACE, JSON.stringify({ kind: "spawn", pid: process.pid }) + "\\n");
setInterval(() => {}, 1000);
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\\n");
createInterface({ input: process.stdin }).on("line", line => {
  const m = JSON.parse(line);
  if (m.method === "initialize") send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [], agentInfo: { name: "host-peer", version: "1.0" } } });
  else if (m.method === "session/new") send({ id: m.id, result: { sessionId: "native-" + process.pid } });
  else if (m.method === "session/prompt") {
    send({ method: "session/update", params: { sessionId: "native-" + process.pid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } } } });
    send({ id: m.id, result: { stopReason: "end_turn" } });
  }
});
process.stdin.on("end", () => { eofAt = Date.now(); setTimeout(() => process.exit(0), 1200); });
`);
  const manifest = join(directory, "catalog.json"), definition = { id: "host-peer", name: "Host peer", aliases: [], binaryNames: [], configHints: [], controls: [{ id: "host-peer-acp", protocol: "acp-v1",
    executableNames: ["host-peer"], args: [peer], env: { PEER_TRACE: trace, PEER_SIGNALS: marks }, requiredExecutables: [], package: null, distribution: null,
    source: { repository: "fixture", revision: "shutdown", upstreamId: "host-peer", url: "https://example.invalid/host-peer" } }] };
  await writeFile(manifest, JSON.stringify({ version: 2, definitions: [definition], overrides: { "host-peer-acp": { executable: process.execPath } } }));
  const app = application(join(directory, "data"), () => {}, { installations: "any", workspaceLockRoot: join(directory, "locks") });
  // The application closes before its directories go.
  t.after(async () => { try { await app.runtime.close(); await app.management.shutdown(); await app.providers.shutdown(); app.store.close(); } finally { await rm(directory, { recursive: true, force: true }); } });
  const configuration = await prepareConfiguration({ workspace, manifestPath: manifest, pathOnly: true });
  const session = await app.runtime.create(configuration, { harnessId: "host-peer" }, "create");
  app.runtime.send(session.id, "hello", "first"); await app.runtime.wait(session.id);
  const run = app.runtime.read(session.id).runs[0]!;
  assert.equal(run.status, "completed", JSON.stringify(run.error));
  assert.deepEqual(await signals(marks), [], "the program left on its own within the grace");
  // The snapshot keeps the cleanup in the shape it always had: no stage or time of the close chain.
  assert.deepEqual(run.cleanup, { closed: true, exitCode: 0, signal: null, protocolFailure: null });
  const ended = app.store.events(session.id, 0).find(event => event.type === "run.ended");
  assert.deepEqual(ended?.data.cleanup, run.cleanup);
  const spawned = (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { pid: number });
  assert.equal(spawned.length, 1); assert.equal(alive(spawned[0]!.pid), false);
});

test("G085-C01 a descendant that never leaves the program's group holds up neither the Turn's end, the next queued Turn, nor makes a stop after the reply cancel it", async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "harness-host-shutdown-lingering-"))), workspace = join(directory, "workspace"), peer = join(directory, "peer.mjs"),
    trace = join(directory, "trace.ndjson"), outsiders = join(directory, "outsiders.txt");
  await mkdir(workspace); await writeFile(outsiders, "");
  // Every program leaves a descendant in a process group of its own that never exits (a background job, an MCP server), and
  // leaves itself as soon as its input closes.
  await writeFile(peer, `import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
const mark = value => appendFileSync(process.env.PEER_TRACE, JSON.stringify({ pid: process.pid, at: Date.now(), ...value }) + "\\n");
mark({ kind: "spawn" });
const stays = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });
stays.unref(); appendFileSync(process.env.PEER_OUTSIDERS, stays.pid + "\\n");
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\\n");
createInterface({ input: process.stdin }).on("line", line => {
  const m = JSON.parse(line);
  if (m.method === "initialize") send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [], agentInfo: { name: "host-peer", version: "1.0" } } });
  else if (m.method === "session/new") send({ id: m.id, result: { sessionId: "native-" + process.pid } });
  else if (m.method === "session/prompt") {
    send({ method: "session/update", params: { sessionId: m.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } } } });
    mark({ kind: "answered" });
    send({ id: m.id, result: { stopReason: "end_turn" } });
  }
});
process.stdin.on("end", () => process.exit(0));
`);
  const manifest = join(directory, "catalog.json"), definition = { id: "host-peer", name: "Host peer", aliases: [], binaryNames: [], configHints: [], controls: [{ id: "host-peer-acp", protocol: "acp-v1",
    executableNames: ["host-peer"], args: [peer], env: { PEER_TRACE: trace, PEER_OUTSIDERS: outsiders }, requiredExecutables: [], package: null, distribution: null,
    source: { repository: "fixture", revision: "lingering", upstreamId: "host-peer", url: "https://example.invalid/host-peer" } }] };
  await writeFile(manifest, JSON.stringify({ version: 2, definitions: [definition], overrides: { "host-peer-acp": { executable: process.execPath } } }));
  const ended: number[] = [];
  const app = application(join(directory, "data"), event => { if (event.type === "run.ended") ended.push(Date.now()); }, { installations: "any", workspaceLockRoot: join(directory, "locks") });
  t.after(async () => {
    try { await app.runtime.close(); await app.management.shutdown(); await app.providers.shutdown(); app.store.close(); }
    finally {
      for (const pid of (await readFile(outsiders, "utf8")).split("\n").filter(Boolean).map(Number)) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
      await rm(directory, { recursive: true, force: true });
    }
  });
  const marks = async () => (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { pid: number; at: number; kind: string });
  const configuration = await prepareConfiguration({ workspace, manifestPath: manifest, pathOnly: true });
  const session = await app.runtime.create(configuration, { harnessId: "host-peer" }, "create");
  app.runtime.send(session.id, "first", "first"); app.runtime.send(session.id, "second", "second");
  await app.runtime.wait(session.id);
  assert.deepEqual(app.runtime.read(session.id).runs.map(run => run.status), ["completed", "completed"]);
  const seen = await marks(), answered = seen.filter(mark => mark.kind === "answered").map(mark => mark.at), spawned = seen.filter(mark => mark.kind === "spawn").map(mark => mark.at);
  const bound = budgets.closeGraceMs + 500;
  for (const [index, at] of ended.entries()) assert.ok(at - answered[index]! < bound, "the Turn ended " + (at - answered[index]!) + " ms after its reply");
  assert.ok(spawned[1]! - answered[0]! < bound, "the next Turn's program started " + (spawned[1]! - answered[0]!) + " ms after the first reply");
  // A stop pressed shortly after the reply finds the Turn already ended: it stays completed.
  app.runtime.send(session.id, "third", "third");
  for (let i = 0; i < 500 && (await marks()).filter(mark => mark.kind === "answered").length < 3; i++) await new Promise(resolve => setTimeout(resolve, 10));
  await new Promise(resolve => setTimeout(resolve, 300));
  app.runtime.cancel(session.id, "stop-after-reply"); await app.runtime.wait(session.id);
  const third = app.runtime.read(session.id).runs[2]!;
  assert.equal(third.status, "completed"); assert.equal(third.backend?.status, "completed");
  // Every program left its descendant behind, still running: it was never signalled.
  for (const pid of (await readFile(outsiders, "utf8")).split("\n").filter(Boolean).map(Number)) assert.doesNotThrow(() => process.kill(pid, 0), "descendant " + pid + " still runs");
});

test("G085-C01 a close that cannot be confirmed, asked for through closeEvidence() alone, rejects for that caller and leaves no rejection unhandled; close() gets the same rejection", async t => {
  const directory = await root(t, "harness-host-shutdown-unconfirmed-"), leader = join(directory, "leader.mjs"), pids = join(directory, "pids.txt");
  // A descendant in a group of its own holds the program's stdout open, so the stream's close is never seen and the group's
  // end cannot be confirmed: the chain gives up after SIGKILL with CLEANUP_FAILED.
  await writeFile(leader, `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { detached: true, stdio: ["ignore", "inherit", "ignore"] });
holder.unref(); writeFileSync(process.env.PEER_PIDS, String(holder.pid));
createInterface({ input: process.stdin }).on("line", line => { const m = JSON.parse(line); if (m.method === "initialize") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1 } }) + "\\n"); });
process.stdin.on("end", () => process.exit(0));
`);
  const unhandled: unknown[] = [], listener = (reason: unknown) => { unhandled.push(reason); };
  process.on("unhandledRejection", listener);
  t.after(async () => { process.off("unhandledRejection", listener); try { process.kill(Number(await readFile(pids, "utf8")), "SIGKILL"); } catch { /* already gone */ } });
  // A short grace keeps the test short; the chain is the same at any grace.
  const rpc = new JsonRpcProcess({ protocol: "acp-v1", executable: process.execPath, args: [leader], env: { PEER_PIDS: pids } },
    { cwd: directory, env: {}, requestTimeoutMs: 2_000, runTimeoutMs: 5_000, maxFrameBytes: 4_096, maxDiagnosticBytes: 1_024, closeGraceMs: 100, closeOutsideWaitMs: 1_000 },
    { notification: () => {}, request: () => { throw new ControlError("METHOD_NOT_FOUND", "unsupported"); }, failure: () => {} });
  await rpc.request("initialize", {});
  const failure = await rpc.closeEvidence().then(() => null, (error: unknown) => error);
  assert.ok(failure instanceof ControlError && failure.code === "CLEANUP_FAILED", String(failure));
  // Well past the turn of the event loop in which an unhandled rejection is reported.
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(unhandled, [], "no rejection is left unhandled");
  assert.equal(await rpc.close().then(() => null, (error: unknown) => error), failure, "close() gets the same rejection");
});

test("G085-C01 a stop pressed after the reply, while the program still takes a second to leave after EOF, is recorded and changes nothing: the Turn ends completed and its native session goes on", async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "harness-host-shutdown-stop-"))), workspace = join(directory, "workspace"), peer = join(directory, "peer.mjs"),
    trace = join(directory, "trace.ndjson"), marks = join(directory, "signals.ndjson");
  await mkdir(workspace);
  // Like Claude with a session or Codex: it leaves on its own about a second after its input closes.
  await writeFile(peer, `import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const mark = value => appendFileSync(process.env.PEER_TRACE, JSON.stringify({ pid: process.pid, at: Date.now(), ...value }) + "\\n");
let eofAt = null;
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => { appendFileSync(process.env.PEER_SIGNALS, JSON.stringify({ signal, afterEofMs: eofAt === null ? null : Date.now() - eofAt }) + "\\n"); process.exit(0); });
mark({ kind: "spawn" });
setInterval(() => {}, 1000);
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\\n");
createInterface({ input: process.stdin }).on("line", line => {
  const m = JSON.parse(line);
  if (m.method === "initialize") send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } }, authMethods: [], agentInfo: { name: "host-peer", version: "1.0" } } });
  else if (m.method === "session/new") { mark({ kind: "new" }); send({ id: m.id, result: { sessionId: "native-1" } }); }
  else if (m.method === "session/resume") { mark({ kind: "resume", sessionId: m.params.sessionId }); send({ id: m.id, result: {} }); }
  else if (m.method === "session/prompt") {
    send({ method: "session/update", params: { sessionId: m.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } } } });
    mark({ kind: "answered" });
    send({ id: m.id, result: { stopReason: "end_turn" } });
  }
});
process.stdin.on("end", () => { eofAt = Date.now(); mark({ kind: "eof" }); setTimeout(() => process.exit(0), 1000); });
`);
  const manifest = join(directory, "catalog.json"), definition = { id: "host-peer", name: "Host peer", aliases: [], binaryNames: [], configHints: [], controls: [{ id: "host-peer-acp", protocol: "acp-v1",
    executableNames: ["host-peer"], args: [peer], env: { PEER_TRACE: trace, PEER_SIGNALS: marks }, requiredExecutables: [], package: null, distribution: null,
    source: { repository: "fixture", revision: "stop-after-reply", upstreamId: "host-peer", url: "https://example.invalid/host-peer" } }] };
  await writeFile(manifest, JSON.stringify({ version: 2, definitions: [definition], overrides: { "host-peer-acp": { executable: process.execPath } } }));
  const app = application(join(directory, "data"), () => {}, { installations: "any", workspaceLockRoot: join(directory, "locks") });
  t.after(async () => { try { await app.runtime.close(); await app.management.shutdown(); await app.providers.shutdown(); app.store.close(); } finally { await rm(directory, { recursive: true, force: true }); } });
  const seen = async () => { try { return (await readFile(trace, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { pid: number; at: number; kind: string }); } catch { return []; } };
  const configuration = await prepareConfiguration({ workspace, manifestPath: manifest, pathOnly: true });
  const session = await app.runtime.create(configuration, { harnessId: "host-peer" }, "create");
  app.runtime.send(session.id, "first", "first");
  for (let i = 0; i < 500 && !(await seen()).some(mark => mark.kind === "answered"); i++) await new Promise(resolve => setTimeout(resolve, 10));
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(app.runtime.read(session.id).runs[0]!.status, "settling", "the stop comes while the program is still leaving");
  app.runtime.cancel(session.id, "stop-after-reply"); await app.runtime.wait(session.id);
  const first = app.runtime.read(session.id).runs[0]!;
  assert.equal(first.status, "completed", JSON.stringify(first.error)); assert.equal(first.backend?.status, "completed"); assert.equal(first.cancelRequested, false);
  assert.deepEqual(first.cleanup, { closed: true, exitCode: 0, signal: null, protocolFailure: null }, "the program left on its own");
  assert.deepEqual(await signals(marks), [], "and got no signal");
  assert.ok(app.store.events(session.id, 0).some(event => event.type === "run.cancel_requested" && event.data.runId === first.id), "the stop is recorded");
  assert.deepEqual(app.runtime.read(session.id).nativeBindings?.map(binding => [binding.status, binding.throughRunId]), [["ready", first.id]], "the native session went through this Turn");
  // The next Turn goes on in the same native session.
  app.runtime.send(session.id, "second", "second"); await app.runtime.wait(session.id);
  const second = app.runtime.read(session.id).runs[1]!;
  assert.equal(second.status, "completed", JSON.stringify(second.error));
  assert.deepEqual((await seen()).filter(mark => mark.kind === "new" || mark.kind === "resume").map(mark => mark.kind), ["new", "resume"], "the second Turn resumed the first one's native session");
  assert.deepEqual(app.runtime.read(session.id).nativeBindings?.map(binding => binding.throughRunId), [second.id]);
});
