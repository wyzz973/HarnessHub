import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { resolveHostBudgets } from "../../src/contracts/native-host.js";
import type { OutsideProcess } from "../../src/contracts/session.js";
import { POSIX_SHUTDOWN_PROBES, confirmOutside, quiesce, type ClosingGroup } from "../../src/infrastructure/control/host-shutdown.js";
import { ControlError, JsonRpcProcess } from "../../src/infrastructure/control/json-rpc-process.js";
import { PosixProcessGroups } from "../../src/infrastructure/control/process-group.js";

// What leaves a host's process group (ADR-056 §4.11, ADR-030 supplement; G085-C02), on macOS's own process table: found
// before the input closes, looked at again by pid and start time once the group is empty, waited for, never signalled.
// Only a host's close evidence waits for them; close() itself, which every Turn waits for, never does.

const budgets = resolveHostBudgets({ physicalMemoryBytes: totalmem() });
const darwinOnly = { skip: process.platform === "darwin" ? false : "process groups and ps are verified on macOS only (ADR-044)" };
/** A node program in a process group of its own that marks every signal it sees and its own exit in `marks`. */
function marked(marks: string, code: string): string {
  return "const { appendFileSync } = require('node:fs'); const mark = value => appendFileSync(" + JSON.stringify(marks) + ", JSON.stringify({ pid: process.pid, ...value }) + '\\n');" +
    "for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => { mark({ kind: 'signal', signal }); process.exit(0); });" + code;
}
async function marksOf(path: string): Promise<readonly { readonly pid: number; readonly kind: string; readonly signal?: string; readonly why?: string }[]> {
  try { return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { pid: number; kind: string; signal?: string; why?: string }); }
  catch (error) { if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return []; throw error; }
}
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
async function until(check: () => boolean, ms = 5_000): Promise<boolean> { for (const end = Date.now() + ms; !check() && Date.now() < end;) await new Promise(resolve => setTimeout(resolve, 20)); return check(); }
/**
 * A JSON-RPC leader that starts, outside its own group, the descendants `codes` describe (one reading an input the leader
 * holds for it when its code mentions stdin) and writes their pids to PEER_PIDS; it leaves as soon as its input closes.
 */
function leaderScript(codes: readonly string[]): string {
  return `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const child = code => spawn(process.execPath, ["-e", code], { detached: true, stdio: code.includes("stdin") ? ["pipe", "ignore", "ignore"] : "ignore" });
const started = ${JSON.stringify(codes)}.map(child);
for (const one of started) if (one.stdin === null) one.unref();
writeFileSync(process.env.PEER_PIDS, JSON.stringify(started.map(one => one.pid)));
setInterval(() => {}, 1000);
createInterface({ input: process.stdin }).on("line", line => { const m = JSON.parse(line); if (m.method === "initialize") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1 } }) + "\\n"); });
process.stdin.on("end", () => process.exit(0));
`;
}
async function leader(t: test.TestContext, directory: string, name: string, codes: readonly string[], outsideWaitMs: number): Promise<{ readonly rpc: JsonRpcProcess; readonly descendants: readonly number[] }> {
  const script = join(directory, name + ".mjs"), pids = join(directory, name + ".json"); await writeFile(script, leaderScript(codes));
  const rpc = new JsonRpcProcess({ protocol: "acp-v1", executable: process.execPath, args: [script], env: { PEER_PIDS: pids } },
    { cwd: directory, env: {}, requestTimeoutMs: 2_000, runTimeoutMs: 10_000, maxFrameBytes: 4_096, maxDiagnosticBytes: 1_024, closeGraceMs: budgets.closeGraceMs, closeOutsideWaitMs: outsideWaitMs },
    { notification: () => {}, request: () => { throw new ControlError("METHOD_NOT_FOUND", "unsupported"); }, failure: () => {} });
  await rpc.request("initialize", {});
  const descendants = JSON.parse(await readFile(pids, "utf8")) as number[];
  t.after(() => { for (const pid of descendants) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } } });
  return { rpc, descendants };
}

test("G085-C02 two descendants in groups of their own: the one leaving with the input and the one living 3 s are found, waited for, recorded as gone, and never signalled; close() did not wait for them", darwinOnly, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "harness-host-outsiders-"))), marks = join(directory, "marks.ndjson");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { rpc, descendants } = await leader(t, directory, "leader", [
    marked(marks, "process.stdin.resume(); process.stdin.on('end', () => { mark({ kind: 'exit', why: 'eof' }); process.exit(0); }); setInterval(() => {}, 1000);"),
    marked(marks, "setTimeout(() => { mark({ kind: 'exit', why: 'timer' }); process.exit(0); }, 3000);")], budgets.closeOutsideWaitMs);
  const [eof, timed] = descendants as [number, number], group = rpc.processGroup!;
  assert.ok(alive(eof) && alive(timed), "both run when the host is closed");
  const started = performance.now(), evidence = rpc.closeEvidence(), cleanup = await rpc.close(), quiet = performance.now() - started;
  // The group is empty, so close() is done, while the 3 s one still runs.
  assert.equal(alive(group), false); assert.equal(alive(timed), true, "close() resolved before the descendant left");
  assert.ok(quiet < budgets.closeGraceMs, "close() took " + Math.round(quiet) + " ms");
  assert.deepEqual(cleanup, { closed: true, exitCode: 0, signal: null, protocolFailure: null });
  const whole = await evidence, waited = performance.now() - started;
  assert.equal(whole.cleanup.stage, "eof"); assert.equal(whole.cleanup.signal, null); assert.ok(whole.cleanup.closeMs <= quiet + 50, "closeMs is the group's end, not the wait");
  assert.deepEqual(whole.outside, { state: "enumerated", found: 2, remaining: 0, commands: ["node"] });
  assert.ok(waited >= 2_000 && waited < budgets.closeOutsideWaitMs, "the evidence waited " + Math.round(waited) + " ms, until the 3 s one left");
  assert.equal(alive(eof), false); assert.equal(alive(timed), false);
  const seen = await marksOf(marks);
  assert.deepEqual(seen.filter(mark => mark.kind === "signal"), [], "nothing outside the group was signalled");
  assert.deepEqual(seen.filter(mark => mark.kind === "exit").map(mark => [mark.pid, mark.why]).sort(), [[eof, "eof"], [timed, "timer"]].sort(), "each left on its own");
});

test("G085-C02 a descendant that never leaves: close() returns at once, the evidence records it as remaining after its wait, an abort ends the wait with it unknown, and it is never signalled", darwinOnly, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "harness-host-lingering-"))), marks = join(directory, "marks.ndjson");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stays = marked(marks, "setInterval(() => {}, 1000);");
  // Waited for, to the end of a 1 s wait.
  const waited = await leader(t, directory, "waited", [stays], 1_000);
  let started = performance.now();
  const evidence = waited.rpc.closeEvidence();
  await waited.rpc.close();
  assert.ok(performance.now() - started < budgets.closeGraceMs, "close() did not wait for it");
  assert.deepEqual((await evidence).outside, { state: "enumerated", found: 1, remaining: 1, commands: ["node"] });
  assert.ok(performance.now() - started >= 1_000, "the evidence waited the whole second");
  // Cut short: the wait is aborted, as a shutting-down owner does.
  const aborted = await leader(t, directory, "aborted", [stays], budgets.closeOutsideWaitMs), controller = new AbortController();
  started = performance.now();
  const cut = aborted.rpc.closeEvidence(controller.signal);
  await aborted.rpc.close(); controller.abort();
  assert.deepEqual((await cut).outside, { state: "enumerated", found: 1, remaining: null, commands: ["node"] });
  assert.ok(performance.now() - started < budgets.closeGraceMs + 500, "the abort ended the wait");
  // A close started by close() read nothing of what left the group.
  const plain = await leader(t, directory, "plain", [stays], 1_000);
  await plain.rpc.close();
  assert.deepEqual((await plain.rpc.closeEvidence()).outside, { state: "unknown" });
  for (const pid of [...waited.descendants, ...aborted.descendants, ...plain.descendants]) assert.equal(alive(pid), true, "never signalled");
  assert.deepEqual(await marksOf(marks), []);
});

/** A detached leader that leaves when its input closes, driven as the close chain's group. */
function leaderGroup(): { readonly child: ChildProcess; readonly target: ClosingGroup; readonly closed: Promise<unknown> } {
  const child = spawn(process.execPath, ["-e", "process.stdin.resume(); process.stdin.on('end', () => process.exit(0)); setInterval(() => {}, 1000);"], { detached: true, stdio: ["pipe", "ignore", "ignore"] });
  let exited = false;
  const closed = once(child, "close").then(() => { exited = true; });
  const groupAlive = () => { try { process.kill(-child.pid!, 0); return true; } catch { return false; } };
  return { child, closed, target: { group: child.pid!, leaderRunning: () => child.exitCode === null && child.signalCode === null, endInput: () => { child.stdin!.end(); },
    quiescent: () => exited && !groupAlive(), signal: signal => { try { process.kill(-child.pid!, signal); } catch { /* already gone */ } } } };
}
test("G085-C02 a pid that now names another program is told apart by its start time: not counted, not waited for, never signalled", darwinOnly, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "harness-host-reused-"))), marks = join(directory, "marks.ndjson");
  // Another program, in a group of its own, holding the pid the chain sampled earlier.
  const other = spawn(process.execPath, ["-e", marked(marks, "setInterval(() => {}, 1000);")], { detached: true, stdio: "ignore" });
  t.after(async () => { try { process.kill(other.pid!, "SIGKILL"); } catch { /* already gone */ } await rm(directory, { recursive: true, force: true }); });
  await new Promise(resolve => setTimeout(resolve, 200));
  const startedAt = Number(await new PosixProcessGroups().identify(other.pid!));
  assert.ok(Number.isFinite(startedAt) && alive(other.pid!));
  const sampleWith = (record: OutsideProcess) => async (group: number) => [...(await POSIX_SHUTDOWN_PROBES.outsiders(group)) ?? [], record];
  // Sampled an hour before this program started: its pid was reused since.
  const reused = leaderGroup();
  const first = await quiesce(reused.target, budgets.closeGraceMs, sampleWith({ pid: other.pid!, startedAt: startedAt - 3_600, command: "node" }));
  await reused.closed;
  assert.equal(first.quiescent, true); assert.equal(first.stage, "eof"); assert.equal(first.found?.length, 1);
  let started = performance.now();
  assert.deepEqual(await confirmOutside(first.found, budgets.closeOutsideWaitMs), { state: "enumerated", found: 1, remaining: 0, commands: ["node"] }, "the reused pid is not what was found");
  assert.ok(performance.now() - started < 1_000, "no wait for a process that is gone");
  // The same pid with its own start time is still running, so it is waited for and then recorded as remaining.
  const same = leaderGroup();
  const second = await quiesce(same.target, budgets.closeGraceMs, sampleWith({ pid: other.pid!, startedAt, command: "node" }));
  await same.closed;
  started = performance.now();
  assert.deepEqual(await confirmOutside(second.found, 1_000), { state: "enumerated", found: 1, remaining: 1, commands: ["node"] });
  assert.ok(performance.now() - started >= 1_000, "it was waited for");
  assert.equal(alive(other.pid!), true, "neither close signalled it");
  assert.deepEqual(await marksOf(marks), []);
});

test("G085-C02 once the leader has left before the close, what it started can no longer be told apart: unknown, not zero", darwinOnly, async () => {
  const gone = leaderGroup();
  gone.child.stdin!.end(); await gone.closed; assert.equal(await until(() => !gone.target.leaderRunning()), true);
  let sampled = false;
  const outcome = await quiesce(gone.target, budgets.closeGraceMs, async group => { sampled = true; return POSIX_SHUTDOWN_PROBES.outsiders(group); });
  assert.deepEqual(outcome, { quiescent: true, stage: "eof", closeMs: outcome.closeMs, found: null });
  assert.deepEqual(await confirmOutside(outcome.found, budgets.closeOutsideWaitMs), { state: "unknown" });
  assert.equal(sampled, false, "nothing is read for a leader that is gone");
});
