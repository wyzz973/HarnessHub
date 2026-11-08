import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { cpus, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { nativeConversationId, type CleanupEvidence, type HarnessControl } from "../../src/contracts/control.js";
import type { CommandId, EventDraft, HarnessSelection, PreparedSessionBinding, PublicRun, SelectionRequest, SessionBindingFactory, SessionCommit, SessionConfiguration, SessionId, SessionMutation, SessionSnapshot, SessionStore } from "../../src/contracts/session.js";
import { SessionRuntime } from "../../src/contexts/session/application/runtime.js";
import { MAX_SESSION_BYTES, utf8Bytes } from "../../src/contexts/session/domain/state.js";
import { SqliteSessionStore } from "../../src/infrastructure/session/sqlite-store.js";

// G075-C01 (ADR-055 §11.2): from acceptance to dispatch on an 8 MiB snapshot, through the formal SessionRuntime and a real
// SqliteSessionStore, with R6's zero-delay in-process fake Harness (round1/r6-performance-caching.md §2.6.4) so that only
// the Hub's own work is timed; nothing here runs a Harness. Every Turn's commits, loads (SessionStore.get), Session reads
// the Store had to parse again (snapshot cache misses) and events are asserted against the baseline below. Milliseconds
// are recorded, and CI asserts none of them (relay-architecture §11.1): the 400 ms target is asserted only in a reference
// measurement on the reference machine (G075_SESSIONS=15, 300 samples), whose result goes into the verification record.

/**
 * Per Turn of the fixed flow below, before the input reaches the Harness and in all. Before G075 (6ed6901) the same flow
 * made 7 and 11 commits and 20 and 34 loads, each load and each commit reading and validating the whole snapshot again.
 * A change to the Runtime's flow that adds a commit or a load changes these on purpose, with its reason.
 */
const BASELINE = {
  beforeDispatch: { commits: 7, loads: 13, parses: 0 },
  turn: { commits: 11, loads: 23, parses: 0, events: 11, eventReads: 0 },
} as const;
/**
 * The reference target for the p95 from acceptance to dispatch (ADR-055 §11.2). CI asserts only the counts above (§11.1);
 * the target is asserted only in a reference measurement, which sets G075_SESSIONS to collect enough Turns (300 at 15).
 */
const REFERENCE_P95_MS = 400;
const TURNS_PER_SESSION = 20;
const clean: CleanupEvidence = { closed: true, exitCode: 0, signal: null, protocolFailure: null };

function sessions(): number {
  const raw = process.env.G075_SESSIONS;
  if (raw === undefined) return 1;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 50) throw new Error("G075_SESSIONS must be a whole number of conversations from 1 to 50");
  return value;
}
/** The Runtime's view of the real Store, counting what it asks for. */
class CountingStore implements SessionStore {
  loads = 0;
  commits = 0;
  eventReads = 0;
  constructor(readonly inner: SqliteSessionStore) {}
  get ownerGeneration(): number { return this.inner.ownerGeneration; }
  assertOwner(): void { this.inner.assertOwner(); }
  create(snapshot: SessionSnapshot, events: readonly EventDraft[]): SessionCommit { return this.inner.create(snapshot, events); }
  get(id: SessionId): SessionSnapshot { this.loads += 1; return this.inner.get(id); }
  findByCreateKey(key: CommandId): SessionSnapshot | null { return this.inner.findByCreateKey(key); }
  list(limit?: number): readonly SessionSnapshot[] { return this.inner.list(limit); }
  listKept(): readonly SessionSnapshot[] { return this.inner.listKept(); }
  nativeOwners(harnessId: string, controlId: string): ReadonlyMap<string, SessionId> { return this.inner.nativeOwners(harnessId, controlId); }
  transact(id: SessionId, expectedVersion: number, mutate: (current: SessionSnapshot) => SessionMutation): SessionCommit { this.commits += 1; return this.inner.transact(id, expectedVersion, mutate); }
  events(id: SessionId, afterSeq: number, limit?: number) { this.eventReads += 1; return this.inner.events(id, afterSeq, limit); }
  close(): void { this.inner.close(); }
  counts(): { readonly commits: number; readonly loads: number; readonly parses: number; readonly eventReads: number } {
    return { commits: this.commits, loads: this.loads, parses: this.inner.cacheStats().misses, eventReads: this.eventReads };
  }
}
/** A Harness whose every step completes at once and that resumes its native session; it notes when an input reached it. */
class ZeroDelayHarness implements SessionBindingFactory {
  dispatchedAt: number | null = null;
  atDispatch: ReturnType<CountingStore["counts"]> | null = null;
  constructor(private readonly store: CountingStore) {}
  async validate(request: SelectionRequest): Promise<HarnessSelection> { return { harnessId: request.harnessId, controlId: request.harnessId + "-acp" }; }
  async prepare(selected: HarnessSelection, configuration: SessionConfiguration): Promise<PreparedSessionBinding> {
    let opened = false;
    const control: HarnessControl = {
      initialize: async () => ({ protocol: "acp-v1", protocolVersion: 1, agentName: "zero-delay", agentVersion: "1", authenticationMethods: [], capabilities: {} }),
      open: async () => { opened = true; return nativeConversationId("native-" + selected.harnessId); },
      checkpoint: async () => opened ? "private-native-" + selected.harnessId : null,
      startText: async (_id, _text, output) => {
        this.dispatchedAt = performance.now(); this.atDispatch = this.store.counts();
        output({ type: "text", text: "继续好了" });
        return { result: Promise.resolve({ status: "completed", reason: "zero-delay", input: "recorded" }), requestStop: async () => ({ requested: true }) };
      },
      close: async () => clean,
    };
    return { control, workspace: configuration.workspace, assertOwned: () => {}, close: () => control.close() };
  }
}
/**
 * Writes `count` finished Turns into a conversation through the Store so that its snapshot is about `target` bytes, with
 * its Harness's native session ready at the last of them, so the next input on it carries nothing (as R6 measured). As in
 * relay-p0's seed, the last Turn is settled by its own commit, which is what lets it place the native binding.
 */
function seed(store: SqliteSessionStore, id: SessionId, count: number, target: number): void {
  const at = Date.parse("2026-11-01T00:00:00Z");
  const history = (state: SessionSnapshot, reply: number) => {
    const runs: PublicRun[] = [], messages: SessionSnapshot["messages"][number][] = [], commands: SessionSnapshot["commands"][number][] = [];
    for (let index = 0; index < count; index++) {
      const user = state.lastSeq + 1 + index * 2, run = ("run-seed-" + index) as PublicRun["id"], code = "const value" + index + " = compute(input, " + index + ");\n", last = index === count - 1;
      runs.push({ id: run, commandId: ("send-seed-" + index) as PublicRun["commandId"], input: "请继续第 " + index + " 步：" + "需".repeat(256),
        userMessageId: ("message-seed-user-" + index) as PublicRun["userMessageId"], assistantMessageId: ("message-seed-reply-" + index) as PublicRun["assistantMessageId"],
        selection: state.selection, epoch: 1, status: last ? "settling" : "completed", cancelRequested: false, contextThroughSeq: user - 1, sourceRunIds: [],
        backend: { status: "completed", reason: "seed" }, cleanup: last ? null : clean, error: null, stopRequested: false, awaitingSwitchId: null, thinking: "思".repeat(1024),
        tools: Array.from({ length: 16 }, (_, tool) => ({ id: "tool-" + index + "-" + tool, title: "Read src/module-" + tool + ".ts", status: "completed" })),
        timing: { acceptedAt: at + index * 10, preparingAt: at + index * 10 + 1, readyAt: at + index * 10 + 2, dispatchedAt: at + index * 10 + 3, firstOutputAt: at + index * 10 + 4, ...(last ? {} : { endedAt: at + index * 10 + 5 }) } });
      messages.push({ id: runs[index]!.userMessageId, runId: run, role: "user", text: runs[index]!.input, seq: user, status: runs[index]!.status },
        { id: runs[index]!.assistantMessageId, runId: run, role: "assistant", text: "```ts\n" + code.repeat(Math.ceil(reply / code.length)).slice(0, reply) + "\n```", seq: user + 1, status: runs[index]!.status });
      commands.push({ id: runs[index]!.commandId, kind: "send", fingerprint: "a".repeat(64), resultId: run });
    }
    return { ...state, activeRunId: runs.at(-1)!.id, runs, messages, commands: [...state.commands, ...commands],
      nativeBindings: [{ harnessId: "alpha", controlId: "alpha-acp", checkpoint: "private-native-alpha", throughRunId: null, status: "unconfirmed" as const }] };
  };
  const state = store.get(id), trial = 24 * 1024, size = utf8Bytes(JSON.stringify({ ...history(state, trial), version: 3, lastSeq: state.lastSeq + 2 * count + 1 }));
  const written = history(state, Math.floor(trial + (target - size) / count)), last = written.runs.at(-1)!;
  store.transact(id, state.version, () => ({ next: written, events: written.runs.flatMap(run => [{ type: "message.accepted", data: { runId: run.id } }, { type: "run.seeded", data: { runId: run.id } }]) }));
  const seeded = store.get(id);
  store.transact(id, seeded.version, current => ({ next: { ...current, activeRunId: null,
    runs: current.runs.map(run => run.id === last.id ? { ...run, status: "completed" as const, cleanup: clean, timing: { ...run.timing!, endedAt: at + count * 10 } } : run),
    messages: current.messages.map(message => message.runId === last.id ? { ...message, status: "completed" as const } : message),
    nativeBindings: [{ harnessId: "alpha", controlId: "alpha-acp", checkpoint: "private-native-alpha", throughRunId: last.id, status: "ready" }] },
    events: [{ type: "run.ended", data: { runId: last.id, status: "completed" } }] }));
}
function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!;
}

test("G075-C01 on an 8 MiB snapshot every Turn keeps the commit, load and parse baseline, and acceptance to dispatch is timed", { timeout: 900_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "g075-commit-")), workspace = join(root, "workspace"); await mkdir(workspace);
  const real = new SqliteSessionStore(join(root, "data")), store = new CountingStore(real), harness = new ZeroDelayHarness(store);
  let next = 0;
  const app = new SessionRuntime(store, harness, { id: () => String(++next), now: () => new Date(), publish: () => {}, fingerprint: value => createHash("sha256").update(value).digest("hex") });
  t.after(async () => { try { await app.close(); } finally { try { real.close(); } finally { await rm(root, { recursive: true, force: true }); } } });
  const configuration: SessionConfiguration = { workspace, manifestPath: null, manifestSha256: null, configHome: null, packageRoots: [], searchDirs: [], pathOnly: true };
  // Room for this test's own Turns under the 8 MiB limit: each adds a Run, two messages and a command (about 1.2 KB).
  const target = MAX_SESSION_BYTES - 64 * 1024, dispatch: number[] = [], accept: number[] = [], whole: number[] = [];
  let snapshotBytes = 0;
  for (let conversation = 0; conversation < sessions(); conversation++) {
    const session = await app.create(configuration, { harnessId: "alpha" }, "create-" + conversation);
    seed(real, session.id, 256 - TURNS_PER_SESSION, target);
    snapshotBytes = utf8Bytes(JSON.stringify(real.get(session.id)));
    assert.ok(snapshotBytes > MAX_SESSION_BYTES - 128 * 1024 && snapshotBytes < MAX_SESSION_BYTES - 32 * 1024, "an 8 MiB snapshot: " + snapshotBytes);
    for (let turn = 0; turn < TURNS_PER_SESSION; turn++) {
      const before = store.counts(), seq = real.get(session.id).lastSeq;
      harness.dispatchedAt = null; harness.atDispatch = null;
      const started = performance.now(), receipt = app.send(session.id, "继续下一步 " + turn, "send-" + conversation + "-" + turn), accepted = performance.now();
      await app.wait(session.id);
      const ended = performance.now(), after = store.counts(), state = real.get(session.id), run = state.runs.find(row => row.id === receipt.runId);
      assert.equal(run?.status, "completed", JSON.stringify(run?.error));
      assert.equal(run?.input, "继续下一步 " + turn);
      assert.ok(harness.dispatchedAt !== null && harness.atDispatch !== null, "the input reached the Harness");
      const delta = (from: typeof before, to: typeof before) => ({ commits: to.commits - from.commits, loads: to.loads - from.loads, parses: to.parses - from.parses });
      const label = "conversation " + conversation + ", Turn " + turn;
      assert.deepEqual(delta(before, harness.atDispatch), BASELINE.beforeDispatch, label + " before dispatch");
      assert.deepEqual({ ...delta(before, after), events: state.lastSeq - seq, eventReads: after.eventReads - before.eventReads }, BASELINE.turn, label);
      dispatch.push(harness.dispatchedAt - started); accept.push(accepted - started); whole.push(ended - started);
    }
  }
  const stats = real.cacheStats(), p95 = percentile(dispatch, 0.95);
  assert.ok(stats.bytes <= stats.maxBytes && stats.maxBytes <= 96 * 1024 * 1024, "the snapshot cache stays within its budget");
  t.diagnostic(`G075-C01 machine: ${cpus()[0]?.model ?? "unknown"}, ${cpus().length} logical cores, ${Math.round(totalmem() / 2 ** 30)} GiB; Node ${process.version}, SQLite ${process.versions.sqlite}`);
  t.diagnostic(`G075-C01 snapshot ${snapshotBytes} B (${(snapshotBytes / 2 ** 20).toFixed(2)} MiB), ${dispatch.length} Turns in ${sessions()} conversation(s)`);
  t.diagnostic(`G075-C01 acceptance→dispatch p50 ${percentile(dispatch, 0.5).toFixed(1)} ms, p95 ${p95.toFixed(1)} ms, max ${Math.max(...dispatch).toFixed(1)} ms (reference target p95 ≤ 400 ms)`);
  t.diagnostic(`G075-C01 send() (acceptance commit) p50 ${percentile(accept, 0.5).toFixed(1)} ms; whole Turn p50 ${percentile(whole, 0.5).toFixed(1)} ms, p95 ${percentile(whole, 0.95).toFixed(1)} ms`);
  t.diagnostic(`G075-C01 snapshot cache: ${JSON.stringify(stats)}`);
  if (process.env.G075_SESSIONS !== undefined) assert.ok(p95 <= REFERENCE_P95_MS, "acceptance→dispatch p95 " + p95.toFixed(1) + " ms meets the reference target");
});
