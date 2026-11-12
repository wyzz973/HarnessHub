import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AcpControl } from "../../src/adapters/control/acp.js";
import { relayCapabilities as declarationOf } from "../../src/adapters/control/factory.js";
import { relayEntries } from "../../src/adapters/control/relay-classify.js";
import { placeTurn, type RelayTurn } from "../../src/adapters/control/relay-turn.js";
import { application } from "../../src/cli/session-application.js";
import type { ContentKind, ControlAttachment } from "../../src/contracts/content.js";
import { contentId } from "../../src/contracts/content.js";
import { singleText, type CleanupEvidence, type ControlEvent, type ControlRun, type HarnessControl, type NativeConversationId, type NativeModelCatalog, type NativeOptions, type TurnText } from "../../src/contracts/control.js";
import { relayPacketId } from "../../src/contracts/relay.js";
import { runId, sessionId, type HarnessSelection, type PublicRun, type SessionConfiguration, type SessionId, type SessionSnapshot } from "../../src/contracts/session.js";
import { renderRelay } from "../../src/contexts/session/domain/relay/packet.js";
import { darwinExitedGroupIsQuiescent } from "../../src/infrastructure/control/process-group.js";
import { ControlError, JsonRpcProcess } from "../../src/infrastructure/control/json-rpc-process.js";
import { prepareConfiguration } from "../../src/infrastructure/session/binding-factory.js";
import { captureNativeEnvironment } from "../../src/infrastructure/session/native-environment.js";
import { conversation, tool } from "../fixtures/relay-scenarios.js";
import { describeGuard, evidenceHeader, guardTargets, recheck, snapshot, type EvidenceHeader, type GuardCheck } from "./guard.js";
import { TOKEN_LIMIT, TURN_LIMIT_MS, closeApp, digits, displayName, displayNames, list, relayOf, reply, selection, summary, tokens, type App } from "./relay-support.js";
import { oldShape, snapshotHistory } from "../fixtures/old-shape.js";

/**
 * Relay on the user's installed Harnesses (ADR-055, G074). One file, two suites, chosen by what the environment names:
 *
 * 1. The Hub-level smoke (HH_REAL_HARNESSES, two Harness identities, as before): the first Harness makes up a five-digit number,
 *    the second is asked for that number plus one, and the first, back on its own native session, is asked what the second
 *    answered. The first number exists only in the first Harness's reply, so the second can know it only from the relay packet
 *    and the first can know the second's answer only from the delta. The third question names the second Harness by its
 *    display name (the approval agent's D2): the indirect "another Harness" wording is a weak model's trap, not a relay check.
 *    What each step expects is computed from the replies actually given. No tool is needed. HH_REAL_MODEL_<ID> picks a native model;
 *    missing prerequisites fail, nothing is a skipped pass. A Turn that runs past five minutes is cancelled and fails the run;
 *    one that reports more than 150,000 tokens stops it. Evidence holds statuses, digits, counts and sizes, never checkpoints,
 *    environment values, packet text or reply text beyond the digits.
 *
 * 2. The Driver-level probes (HH_REAL_PROBE, a list of Harness identities; ADR-055 §13.3, §20): the Drivers of the installed
 *    Harnesses are driven directly, through the production binding factory, with a synthetic relay packet, and the facts the
 *    declarations only infer (RelayCapabilities cells marked "to be probed") are confirmed, refuted or reported unverified,
 *    each with its criterion. The native record is read where the Harness lets it be read (Claude Code's transcript, Codex's
 *    turn list, an ACP agent's replay); where it does not (DeepSeek Harness), the cell is reported unverified and the model is
 *    asked instead. Hermes and OpenClaw run through their own gateways, whose outbound reach the owner has not released: their
 *    probes exist but run only with HH_REAL_PROBE_GATEWAY naming them. Variables: HH_REAL_EVIDENCE (the evidence file),
 *    HH_REAL_MODEL_<ID> and HH_REAL_OPTIONS_<ID> (a JSON object of native options), HH_REAL_PROBE_ONLY (probe ids to run),
 *    HH_REAL_PROBE_PROMPTS (the prompt cap per Harness, 45 by default), HH_REAL_PROBE_READ_N (repetitions of the question probe),
 *    HH_REAL_PROBE_PEER=1 (a self-test of the script against the synthetic peer of the unit fixtures; its findings are no evidence).
 *    Evidence holds verdicts, shapes, hashes, counts, sizes and times; never a reply, a packet, a configuration value or a
 *    credential. The probes write only into a private temporary root and delete what the Harnesses wrote for it.
 */
const harnesses = list(process.env.HH_REAL_HARNESSES);
const probeTargets = list(process.env.HH_REAL_PROBE);
const evidencePath = process.env.HH_REAL_EVIDENCE;
/** A development manifest (HH_REAL_MANIFEST) names non-official entries, which only the development policy reads (ADR-044). */
const realInstallations = process.env.HH_REAL_MANIFEST ? "any" as const : "official" as const;
/** The user's home and environment as the Harness runs with them; the shared guard (./guard.ts) snapshots its configuration from them. */
const environment = captureNativeEnvironment();

if (probeTargets.length === 0) test("installed Harnesses hand a conversation over and back: the second knows the first's answer, the first knows the second's", { timeout: 20 * 60 * 1000 }, async () => {
  assert.equal(harnesses.length, 2, "set HH_REAL_HARNESSES to two installed Harness identities, for example claude,codex (or HH_REAL_PROBE for the Driver-level probes)");
  assert.ok(evidencePath, "set HH_REAL_EVIDENCE to an ignored evidence file path"); guardTargets(harnesses);
  const [first, second] = harnesses as [string, string];
  assert.notEqual(first, second, "a relay needs two different Harnesses");
  const before = await snapshot(harnesses, environment);
  const root = await realpath(await mkdtemp(join(process.env.HH_REAL_TMP ?? tmpdir(), "hh-relay-")));
  const workspace = join(root, "workspace"), data = join(root, "data"), turns: Record<string, unknown>[] = [];
  let header: EvidenceHeader | undefined, guard: GuardCheck | undefined, failure: unknown;
  await mkdir(workspace); await writeFile(join(workspace, "README.md"), "A scratch workspace for a relay check. It holds no numbers.\n");
  const app = application(data, () => {}, { installations: realInstallations, workspaceLockRoot: join(root, "locks") });
  try {
    const configuration = await prepareConfiguration({ workspace, ...(process.env.HH_REAL_MANIFEST ? { manifestPath: process.env.HH_REAL_MANIFEST } : {}) });
    header = await evidenceHeader(app, harnesses, { configuration });
    const created = await app.runtime.create(configuration, selection(first), "create-" + randomUUID()), id: SessionId = created.id;
    /** Waits for the Session to settle, at most TURN_LIMIT_MS; past that the Turn is cancelled and the run fails. */
    const settle = async (label: string): Promise<void> => {
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<"late">(resolve => { timer = setTimeout(() => resolve("late"), TURN_LIMIT_MS); });
      try {
        if (await Promise.race([app.runtime.wait(id).then(() => "settled" as const), late]) === "late") {
          app.runtime.cancel(id, "cancel-" + randomUUID()); await app.runtime.wait(id);
          throw new Error(label + " ran past " + TURN_LIMIT_MS / 60_000 + " minutes and was cancelled");
        }
      } finally { clearTimeout(timer); }
    };
    const ask = async (text: string): Promise<{ state: SessionSnapshot; run: PublicRun; relay: Record<string, unknown> | null }> => {
      app.runtime.send(id, text, "send-" + randomUUID()); await settle("Turn " + (turns.length + 1));
      const state = oldShape(app.runtime, id), run = state.runs.at(-1)!;
      turns.push(summary(app, id, state, run));
      const used = tokens(run);
      if (used !== null && used > TOKEN_LIMIT) throw new Error("Turn " + turns.length + " reported " + used + " tokens, past the " + TOKEN_LIMIT + " stop line");
      return { state, run, relay: relayOf(app, id, run) };
    };
    const switchTo = async (harnessId: string): Promise<void> => {
      app.runtime.switch(id, selection(harnessId), "switch-" + randomUUID()); await settle("the switch to " + harnessId);
      assert.equal(oldShape(app.runtime, id).selection.harnessId, harnessId, "the switch to " + harnessId + " took effect");
    };

    const one = await ask("请随便想一个五位数（不要用 12345、11111 这类有规律的数），只回复这个数字本身，不要调用任何工具，不要别的字。");
    assert.equal(one.run.status, "completed", "the first Harness's turn completes: " + JSON.stringify(one.run.error));
    assert.equal(one.relay, null, "the first Turn of a new conversation owes nothing and goes as typed");
    const made = reply(one.state, one.run).match(/\d{5}/gu) ?? [];
    assert.equal(made.length, 1, "the first Harness answers one five-digit number");
    const next = Number(made[0]) + 1, says = (text: string) => digits(text).map(Number).includes(next);

    await switchTo(second);
    const two = await ask("上一位 Harness 回复的那个五位数加 1 等于多少？只回复结果数字本身，不要调用任何工具，不要别的字。");
    assert.equal(two.run.status, "completed", "the second Harness's turn completes: " + JSON.stringify(two.run.error));
    assert.ok(two.run.sourceRunIds.length > 0, "the second Harness's turn carried the conversation it had not seen");
    assert.equal(two.relay?.kind, "packet", "a Harness new to the conversation receives the whole relay packet");
    assert.ok(says(reply(two.state, two.run)), "the second Harness knows the first's number only from the relay packet");

    await switchTo(first);
    // The question names the second Harness (D2): the delta says which Harness answered, and the check is of the relay, not of
    // a model's reading of "the other one" (the model-id dependence of that wording is the Driver probe READ's observation).
    const three = await ask(displayName(second) + " 刚才回复了哪个数字？只回复那个数字本身，不要调用任何工具，不要别的字。");
    assert.equal(three.run.status, "completed", "the first Harness's return turn completes: " + JSON.stringify(three.run.error));
    assert.ok(three.run.sourceRunIds.length > 0, "the return turn carried what happened while the first Harness was away");
    assert.equal(three.relay?.kind, "delta", "back on its own native session, the first Harness receives only what it missed");
    // The second's answer differs from the first's own number, so the first can know it only from the delta.
    assert.ok(says(reply(three.state, three.run)), "back on its own native session, the first Harness knows the second's answer from the delta");
    assert.ok(three.state.nativeBindings?.some(binding => binding.harnessId === first && binding.status === "ready"), "the first Harness's native binding is ready again");

    // HH_REAL_RELAY_WALK=1 goes on through the situations the relay has rules for, and only records what happened (each
    // Turn's ledger is the evidence): another Turn on the same Harness, a Turn stopped right after it was sent, the Turn
    // after that, a clear, and the Turn after the clear. Nothing below is asserted beyond "the Session still answers".
    if (process.env.HH_REAL_RELAY_WALK === "1") {
      const brief = "只回复一个词，不要调用任何工具。";
      await ask("再说一遍 " + displayName(second) + " 回复的那个数字。" + brief);
      await switchTo(second);
      app.runtime.send(id, "从 1 数到 3，每个数字单独一行，不要调用任何工具。", "send-" + randomUUID());
      await new Promise(resolve => setTimeout(resolve, 1500));
      app.runtime.cancel(id, "cancel-" + randomUUID()); await settle("the stopped Turn");
      { const state = oldShape(app.runtime, id), run = state.runs.at(-1)!; turns.push({ step: "stopped", ...summary(app, id, state, run) }); }
      await ask("刚才 " + displayName(first) + " 最后回复的数字是多少？" + brief);
      await ask("这段对话里你一共回答过几次？" + brief);
      await switchTo(first);
      await ask("/clear");
      // What the cleared binding offers before the next message: the earlier part, to attach once ("attach_available").
      turns.push({ step: "attention-after-clear", attention: app.runtime.relayAttention(id) });
      await ask("这段对话里最早出现的那个五位数是多少？不知道就回复“不知道”。" + brief);
      turns.push({ step: "attention", attention: app.runtime.relayAttention(id) });
    }
  } catch (error) { failure = error; }
  finally {
    try { await closeApp(app); } catch (error) { failure ??= error; }
    try { guard = await recheck(before, environment); } catch (error) { failure ??= error; }
    await writeFile(evidencePath!, JSON.stringify({ header, harnesses, turns, guard: guard === undefined ? null : { unchanged: guard.unchanged, description: describeGuard(guard) },
      failure: failure instanceof Error ? failure.message : failure === undefined ? null : String(failure) }, null, 2) + "\n", { mode: 0o600 });
    await rm(root, { recursive: true, force: true });
  }
  assert.ok(guard?.unchanged, "the user's own configuration must remain unchanged: " + (guard === undefined ? "not checked" : describeGuard(guard)));
  if (failure !== undefined) throw failure;
});

// =====================================================================================================================
// The Driver-level probes
// =====================================================================================================================

const gatewayAllowed = list(process.env.HH_REAL_PROBE_GATEWAY);
const probeOnly = list(process.env.HH_REAL_PROBE_ONLY).map(item => item.toUpperCase());
const peerMode = process.env.HH_REAL_PROBE_PEER === "1";
const GATEWAY_HARNESSES: readonly string[] = ["hermes", "openclaw"];
const PROMPT_CAP = Math.max(1, Number(process.env.HH_REAL_PROBE_PROMPTS ?? 45));
const READ_REPEATS = Math.max(1, Number(process.env.HH_REAL_PROBE_READ_N ?? 1));
/** The strings a native conversation title must not carry (ADR-055 §13.3 P13). */
const FORBIDDEN_TITLE = /HarnessHub|交接|接手|handoff|relay-|〔|ai-title/iu;

/** What a probe concluded about one cell of a declaration (or one fact the declaration only assumes). */
type Verdict = "confirmed" | "refuted" | "unverified" | "observed" | "error";
interface Finding { readonly probe: string; readonly cell: string; readonly verdict: Verdict; readonly criterion: string; readonly facts: Readonly<Record<string, unknown>> }
/** A hard stop of the run (prompt cap, time or token limit): never recorded as a finding and swallowed. */
class Abort extends Error {}

const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const short = (text: string): string => sha(text).slice(0, 12);
const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
/** The paths of the user's home written with ~, and the text cut: for what an evidence file may hold of a native error. */
function plain(text: string, limit = 200): string { return text.split(homedir()).join("~").replace(/[\0-\x1f\x7f]+/gu, " ").slice(0, limit); }
/** The keys and value types of a value, never its content. */
function shapeOf(value: unknown, depth = 3): unknown {
  if (value === null) return "null";
  if (Array.isArray(value)) return value.length === 0 ? "[]" : ["[" + value.length + "]", depth > 0 ? shapeOf(value[0], depth - 1) : "…"];
  if (typeof value === "object") return depth <= 0 ? "{…}" : Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, item]) => [key, shapeOf(item, depth - 1)]));
  return typeof value;
}
/** A native error as evidence: its classes and bounded words, with the home written as ~ (the peer's text is private). */
function failureOf(error: unknown): Record<string, unknown> {
  if (error instanceof ControlError) return { name: "ControlError", code: error.code, message: plain(error.message), remoteCode: error.remoteCode ?? null,
    remoteMessage: error.remoteMessage === undefined ? null : plain(error.remoteMessage, 160), remoteFields: error.remoteFields ?? null };
  return { name: error instanceof Error ? error.name : typeof error, message: plain(error instanceof Error ? error.message : String(error), 240) };
}
const digitsIn = (text: string): readonly string[] => text.match(/\d{5}/gu) ?? [];

/** Everything the JSON-RPC connections of this process said and heard, in order, for the probes to read afterwards (in memory only). */
interface WireEntry { readonly at: number; readonly pid: number | null; readonly dir: "out" | "in"; readonly kind: "request" | "response" | "error" | "notification" | "server-request"; readonly method: string; readonly payload: unknown }
class Wire {
  readonly entries: WireEntry[] = [];
  private restore: (() => void) | null = null;
  install(): void {
    if (this.restore !== null) return;
    type Rpc = JsonRpcProcess;
    const proto = JsonRpcProcess.prototype as unknown as { request: (this: Rpc, method: string, params: unknown, ...rest: unknown[]) => Promise<unknown>; notify: (this: Rpc, method: string, params: unknown) => Promise<void>;
      dispatch: (this: Rpc, message: Record<string, unknown>) => void };
    const { request, notify, dispatch } = proto;
    const push = (entry: Omit<WireEntry, "at">): void => { if (this.entries.length < 100_000) this.entries.push({ at: performance.now(), ...entry }); };
    proto.request = function (this: Rpc, method, params, ...rest) {
      const promise = request.call(this, method, params, ...rest);
      push({ pid: this.processGroup, dir: "out", kind: "request", method, payload: params });
      promise.then(result => push({ pid: this.processGroup, dir: "in", kind: "response", method, payload: result }), error => push({ pid: this.processGroup, dir: "in", kind: "error", method, payload: failureOf(error) }));
      return promise;
    };
    proto.notify = function (this: Rpc, method, params) {
      const promise = notify.call(this, method, params);
      push({ pid: this.processGroup, dir: "out", kind: "notification", method, payload: params });
      return promise;
    };
    proto.dispatch = function (this: Rpc, message) {
      if (typeof message.method === "string") push({ pid: this.processGroup, dir: "in", kind: message.id === undefined ? "notification" : "server-request", method: message.method, payload: message.params });
      return dispatch.call(this, message);
    };
    this.restore = () => { proto.request = request; proto.notify = notify; proto.dispatch = dispatch; };
  }
  uninstall(): void { this.restore?.(); this.restore = null; }
  get mark(): number { return this.entries.length; }
  since(mark: number, end = this.entries.length): readonly WireEntry[] { return this.entries.slice(mark, end); }
}
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** A connection to a Driver and the way its process is ended. */
interface Conn { readonly control: HarnessControl; close(): Promise<CleanupEvidence> }
/** An open native conversation on a connection, with the catalog its Driver read and the part of the wire its opening made. */
interface Open { readonly conn: Conn; readonly control: HarnessControl; readonly id: NativeConversationId; readonly catalog: NativeModelCatalog | null; readonly wireFrom: number; readonly wireTo: number }
/** One Harness under probe: how to connect to its Driver, what it has been asked, and what the probes concluded. */
class Rig {
  readonly findings: Finding[] = [];
  readonly facts: Record<string, unknown> = {};
  readonly turns: Record<string, unknown>[] = [];
  /** Native sessions the probes created (for cleanup), and Codex rollout files they were told of. */
  readonly sessions = new Set<string>();
  readonly rollouts = new Set<string>();
  /** The workspaces the probes opened conversations in (for the transcript directories Claude Code wrote for them). */
  readonly directories = new Set<string>();
  prompts = 0; tokens = 0; maxTurnTokens = 0; maxTurnMs = 0;
  /** Costs the Harnesses reported: a "turn" cost adds up, a "session" cost is cumulative per connection, so only the latest of each connection counts. */
  readonly turnCosts = new Map<string, number>();
  readonly sessionCosts = new Map<Conn, { readonly currency: string; readonly amount: number }>();
  get costs(): Record<string, number> {
    const total: Record<string, number> = Object.fromEntries(this.turnCosts);
    for (const { currency, amount } of this.sessionCosts.values()) total[currency] = (total[currency] ?? 0) + amount;
    return total;
  }
  constructor(readonly harnessId: string, readonly workspace: string, readonly model: string | undefined, readonly options: NativeOptions | undefined,
    readonly connectIn: (workspace: string) => Promise<Conn>, readonly claudeConfig: string, readonly codexHome: string, readonly root: string, readonly wire: Wire, readonly cap: number) {}
  connect(workspace = this.workspace): Promise<Conn> { return this.connectIn(workspace); }
  find(probe: string, cell: string, verdict: Verdict, criterion: string, facts: Record<string, unknown> = {}): void { this.findings.push({ probe, cell, verdict, criterion, facts }); }
  get protocol(): "codex-app-server" | "acp-v1" { return this.harnessId === "codex" ? "codex-app-server" : "acp-v1"; }
  get caps(): ReturnType<typeof declarationOf> { return declarationOf(this.harnessId, this.protocol); }
  get gateway(): boolean { return GATEWAY_HARNESSES.includes(this.harnessId); }
}
const wanted = (id: string): boolean => probeOnly.length === 0 || probeOnly.includes(id.toUpperCase());
/** One probe: whatever it throws is a finding (never a silent pass), except the hard stops, which end the run. */
async function attempt(h: Rig, id: string, body: () => Promise<void>): Promise<void> {
  if (!wanted(id)) return;
  const started = performance.now();
  try { await body(); }
  catch (error) {
    if (error instanceof Abort) throw error;
    h.find(id, "-", "error", "the probe itself failed", { ...failureOf(error), where: plain(error instanceof Error ? (error.stack ?? "").split("\n").slice(1, 3).join(" | ") : "", 300) });
  }
  h.facts["ms:" + id] = Math.round(performance.now() - started);
}

/** Connects, initializes and opens a conversation (new, or the checkpoint's) and reads the catalog the Driver classifies by. */
async function begin(h: Rig, checkpoint?: string, workspace = h.workspace): Promise<Open> {
  const wireFrom = h.wire.mark, conn = await h.connect(workspace);
  try {
    const observation = await conn.control.initialize();
    h.facts.loadSession = record(observation.capabilities).loadSession === true; h.directories.add(workspace);
    h.facts.sessionCapabilities ??= Object.keys(record(record(observation.capabilities).sessionCapabilities)).sort();
    const id = await conn.control.open(workspace, h.model, h.options, checkpoint);
    const wireTo = h.wire.mark, catalog = conn.control.models === undefined ? null : await conn.control.models().catch(() => null);
    h.sessions.add(id);
    return { conn, control: conn.control, id, catalog, wireFrom, wireTo };
  } catch (error) { await conn.close().catch(() => undefined); throw error; }
}
async function finish(open: Open | null): Promise<void> { if (open !== null) await open.conn.close().catch(() => undefined); }

// ---------------------------------------------------------------------------------------------------------------------
// Turns
// ---------------------------------------------------------------------------------------------------------------------

interface TimedEvent { readonly at: number; readonly event: ControlEvent }
type BackendOutcome = Awaited<ControlRun["result"]>;
interface TurnOptions {
  readonly attachments?: readonly ControlAttachment[];
  /** Runs beside the Turn once its prompt is on the wire (a cancel, a kill); its failure is recorded, never thrown. */
  readonly during?: (live: { readonly run: ControlRun; readonly events: readonly TimedEvent[]; readonly open: Open; readonly t0: number }) => Promise<void>;
  /** A Turn the Driver refuses without sending anything is no prompt. */
  readonly counts?: boolean;
  /** A shorter limit than the five minutes, and whether passing it only ends the Turn (soft) instead of the run. */
  readonly limitMs?: number;
  readonly soft?: boolean;
}
interface TurnRecord {
  readonly label: string;
  readonly text: TurnText;
  readonly result: BackendOutcome | null;
  readonly failure: Record<string, unknown> | null;
  readonly started: boolean;
  readonly events: readonly TimedEvent[];
  readonly wireFrom: number;
  readonly wireTo: number;
  readonly ms: number;
  readonly firstEventMs: number | null;
  readonly firstTextMs: number | null;
  readonly reply: string;
  readonly hookFailure: Record<string, unknown> | null;
  readonly timedOut: boolean;
  readonly usage: { readonly turn: Record<string, number>; readonly context: { readonly used: number; readonly size: number | null } | null; readonly cost: { readonly amount: number; readonly currency: string; readonly scope: string } | null };
}
function eventCounts(events: readonly TimedEvent[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const { event } of events) counts[event.type] = (counts[event.type] ?? 0) + 1;
  return counts;
}
/** Sends one prompt through a Driver and waits for its result, at most five minutes; past that the prompt is stopped and the run ends. */
async function turn(h: Rig, open: Open, text: TurnText, label: string, options: TurnOptions = {}): Promise<TurnRecord> {
  if (options.counts !== false) {
    if (h.prompts >= h.cap) throw new Abort("the prompt cap of " + h.cap + " is reached before " + label);
    h.prompts++;
  }
  const events: TimedEvent[] = [], t0 = performance.now(), wireFrom = h.wire.mark;
  let run: ControlRun | null = null, result: BackendOutcome | null = null, failure: Record<string, unknown> | null = null, hookFailure: Record<string, unknown> | null = null, timedOut = false;
  try { run = await open.control.startText(open.id, text, event => { events.push({ at: performance.now() - t0, event }); }, options.attachments ?? []); }
  catch (error) { failure = failureOf(error); }
  if (run !== null) {
    const live = run, during = options.during === undefined ? Promise.resolve() : options.during({ run: live, events, open, t0 }).catch(error => { hookFailure = failureOf(error); });
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<"limit">(resolve => { timer = setTimeout(() => resolve("limit"), options.limitMs ?? TURN_LIMIT_MS); });
    try {
      const settled = await Promise.race([live.result.then(value => ({ value })), limit]);
      if (settled === "limit") {
        timedOut = true; await live.requestStop().catch(() => undefined);
        result = await Promise.race([live.result, delay(30_000).then(() => null)]).catch(() => null);
      } else result = settled.value;
    } catch (error) { failure = failureOf(error); }
    finally { clearTimeout(timer); }
    await during;
  }
  const ms = performance.now() - t0, firstEvent = events[0], firstText = events.find(entry => entry.event.type === "text");
  const usage: TurnRecord["usage"] = { turn: {}, context: null, cost: null };
  for (const { event } of events) {
    if (event.type !== "usage") continue;
    for (const [key, value] of Object.entries(event.usage.turn ?? {})) if (typeof value === "number") usage.turn[key] = value;
    if (event.usage.context !== undefined) (usage as { context: TurnRecord["usage"]["context"] }).context = { used: event.usage.context.used, size: event.usage.context.size ?? null };
    if (event.usage.cost !== undefined) (usage as { cost: TurnRecord["usage"]["cost"] }).cost = { amount: event.usage.cost.amount, currency: event.usage.cost.currency, scope: event.usage.cost.scope };
  }
  const total = usage.turn.total ?? ((usage.turn.input ?? 0) + (usage.turn.output ?? 0));
  h.tokens += total; h.maxTurnTokens = Math.max(h.maxTurnTokens, total); h.maxTurnMs = Math.max(h.maxTurnMs, ms);
  if (usage.cost !== null) {
    if (usage.cost.scope === "turn") h.turnCosts.set(usage.cost.currency, (h.turnCosts.get(usage.cost.currency) ?? 0) + usage.cost.amount);
    else h.sessionCosts.set(open.conn, { currency: usage.cost.currency, amount: usage.cost.amount });
  }
  const replyText = events.flatMap(({ event }) => event.type === "text" ? [event.text] : []).join("");
  const turnRecord: TurnRecord = { label, text, result, failure, started: run !== null, events, wireFrom, wireTo: h.wire.mark, ms, firstEventMs: firstEvent === undefined ? null : Math.round(firstEvent.at), firstTextMs: firstText === undefined ? null : Math.round(firstText.at),
    reply: replyText, hookFailure, timedOut, usage };
  const recorded = events.find(entry => entry.event.type === "input_recorded");
  h.turns.push({ label, status: result?.status ?? null, reason: result?.reason ?? null, input: result?.input ?? null, errorCode: result?.error?.code ?? failure?.code ?? null, command: result?.command ?? null,
    cleared: result?.native?.cleared === true, ms: Math.round(ms), firstEventMs: turnRecord.firstEventMs, firstTextMs: turnRecord.firstTextMs,
    events: eventCounts(events), inputRecordedAtMs: recorded === undefined ? null : Math.round(recorded.at), usage: { turn: usage.turn, context: usage.context, cost: usage.cost }, replyChars: [...replyText].length,
    sentChars: [...(typeof text === "string" ? text : singleText(text))].length, packet: typeof text === "string" ? null : text.relay.packetId, hookFailure: hookFailure === null ? null : { code: (hookFailure as Record<string, unknown>).code ?? null, remoteCode: (hookFailure as Record<string, unknown>).remoteCode ?? null, remoteMessage: (hookFailure as Record<string, unknown>).remoteMessage ?? null },
    failure: failure === null ? null : { code: failure.code ?? null, remoteCode: failure.remoteCode ?? null, remoteMessage: failure.remoteMessage ?? null }, timedOut });
  if (timedOut && options.soft !== true) throw new Abort(label + " ran past five minutes and was stopped");
  if (total > TOKEN_LIMIT) throw new Abort(label + " reported " + total + " tokens, past the " + TOKEN_LIMIT + " stop line");
  return turnRecord;
}

// ---------------------------------------------------------------------------------------------------------------------
// The native record: what each Harness keeps of the user's entries, as far as it can be read
// ---------------------------------------------------------------------------------------------------------------------

/** One user entry of a native history: its text blocks and the kinds of all its blocks, in order. */
interface UserEntry { readonly texts: readonly string[]; readonly kinds: readonly string[]; readonly extra: Readonly<Record<string, unknown>> }
/** What the Harness answered after a user entry: the assistant text that follows entry number `afterUser` (counted in `entries`). */
interface AssistantText { readonly afterUser: number; readonly text: string }
interface NativeRecord { readonly source: "claude-transcript" | "codex-turns" | "acp-replay"; readonly entries: readonly UserEntry[]; readonly assistants: readonly AssistantText[]; readonly titles: readonly string[]; readonly facts: Readonly<Record<string, unknown>> }

/** A user prompt the client sent, as Claude Code's transcript keeps it (the same reading as the Driver's check). */
function claudeEntry(line: Record<string, unknown>): UserEntry | null {
  if (line.type !== "user" || line.isMeta === true || line.isCompactSummary === true || line.isSidechain === true || line.toolUseResult !== undefined) return null;
  const content = record(line.message).content;
  if (typeof content === "string") return { texts: [content], kinds: ["string"], extra: {} };
  if (!Array.isArray(content) || content.some(part => record(part).type === "tool_result")) return null;
  return { texts: content.flatMap(part => record(part).type === "text" && typeof record(part).text === "string" ? [record(part).text as string] : []), kinds: content.map(part => String(record(part).type ?? "?")), extra: {} };
}
/** Claude Code's transcript of a session (`<project>/<id>.jsonl` under its configuration directory) from a byte offset; null when it cannot be read. */
async function claudeRecord(h: Rig, stored: string, offset = 0): Promise<NativeRecord | null> {
  let data: Buffer;
  try { data = await readFile(join(h.claudeConfig, "projects", stored)); } catch { return null; }
  if (offset > data.length) return null;
  const lines = data.subarray(offset).toString("utf8").split("\n").filter(line => line.trim() !== ""), entries: UserEntry[] = [], assistants: AssistantText[] = [], titles: string[] = [], types: Record<string, number> = {}, subtypes: Record<string, number> = {};
  for (const raw of lines) {
    let value: unknown;
    try { value = JSON.parse(raw); } catch { continue; }
    const line = record(value), type = String(line.type ?? "?");
    types[type] = (types[type] ?? 0) + 1;
    if (type === "system" && typeof line.subtype === "string") subtypes[line.subtype] = (subtypes[line.subtype] ?? 0) + 1;
    const entry = claudeEntry(line);
    if (entry !== null) entries.push(entry);
    if (type === "assistant" && entries.length > 0) { const content = record(line.message).content; assistants.push({ afterUser: entries.length - 1, text: Array.isArray(content) ? content.flatMap(part => record(part).type === "text" && typeof record(part).text === "string" ? [record(part).text as string] : []).join("") : "" }); }
    if (type === "ai-title" && typeof line.aiTitle === "string") titles.push(line.aiTitle);
  }
  return { source: "claude-transcript", entries, assistants, titles, facts: { bytes: data.length, lines: lines.length, types, systemSubtypes: subtypes } };
}
/** Codex's turns of a thread, oldest first, through the Driver's own connection (`thread/turns/list`, itemsView full); null when it cannot be read. */
async function codexRecord(open: Open): Promise<NativeRecord | null> {
  const rpc = (open.control as unknown as { rpc?: JsonRpcProcess }).rpc;
  if (rpc === undefined) return null;
  const turns: Record<string, unknown>[] = [];
  let cursor: string | undefined;
  try {
    for (let page = 0; page < 6; page++) {
      const response = record(await rpc.request("thread/turns/list", { threadId: open.id, limit: 100, sortDirection: "desc", itemsView: "full", ...(cursor === undefined ? {} : { cursor }) }, 10_000, "reject"));
      if (Array.isArray(response.data)) turns.push(...response.data.map(record));
      if (typeof response.nextCursor !== "string") break;
      cursor = response.nextCursor;
    }
  } catch { return null; }
  turns.reverse();
  const entries: UserEntry[] = [], assistants: AssistantText[] = [], itemTypes: Record<string, number> = {};
  let echoed = 0, withItems = 0, userItemKeys: string[] = [];
  for (const turnRow of turns) {
    if (Array.isArray(turnRow.items)) withItems++;
    for (const raw of Array.isArray(turnRow.items) ? turnRow.items : []) {
      const item = record(raw), type = String(item.type ?? "?");
      itemTypes[type] = (itemTypes[type] ?? 0) + 1;
      if (type === "agentMessage" && entries.length > 0 && typeof item.text === "string") assistants.push({ afterUser: entries.length - 1, text: item.text });
      if (type !== "userMessage") continue;
      const content = Array.isArray(item.content) ? item.content.map(record) : [];
      userItemKeys = Object.keys(item).sort();
      if (typeof item.clientUserMessageId === "string" || typeof item.clientId === "string") echoed++;
      entries.push({ texts: content.flatMap(part => typeof part.text === "string" ? [part.text] : []), kinds: content.map(part => String(part.type ?? "?")),
        extra: { clientId: typeof item.clientUserMessageId === "string" ? item.clientUserMessageId : typeof item.clientId === "string" ? item.clientId : null } });
    }
  }
  return { source: "codex-turns", entries, assistants, titles: [], facts: { turns: turns.length, turnsWithItems: withItems, turnKeys: turns[0] === undefined ? [] : Object.keys(turns[0]).sort(), itemTypes, userItemKeys, userItemsWithClientId: echoed } };
}
/** The user entries an ACP agent replayed in a window of the wire (a session/load), grouped by the agent updates between them. */
function replayRecord(entries: readonly WireEntry[], id: string): NativeRecord {
  const messages: { texts: string[]; kinds: string[] }[] = [], assistants: AssistantText[] = [];
  let current: { texts: string[]; kinds: string[] } | null = null, other = 0;
  for (const entry of entries) {
    if (entry.dir !== "in" || entry.kind !== "notification" || entry.method !== "session/update") continue;
    const params = record(entry.payload);
    if (params.sessionId !== id) continue;
    const update = record(params.update), kind = update.sessionUpdate;
    if (kind === "user_message_chunk") {
      const content = record(update.content);
      if (current === null) { current = { texts: [], kinds: [] }; messages.push(current); }
      current.kinds.push(String(content.type ?? "?"));
      if (content.type === "text" && typeof content.text === "string") current.texts.push(content.text);
    } else if (["agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update"].includes(String(kind))) {
      current = null; other++;
      const content = record(update.content);
      if (kind === "agent_message_chunk" && messages.length > 0 && content.type === "text" && typeof content.text === "string") {
        const last = assistants.at(-1);
        if (last !== undefined && last.afterUser === messages.length - 1) assistants[assistants.length - 1] = { afterUser: last.afterUser, text: last.text + content.text };
        else assistants.push({ afterUser: messages.length - 1, text: content.text });
      }
    }
  }
  return { source: "acp-replay", entries: messages.map(message => ({ texts: message.texts, kinds: message.kinds, extra: {} })), assistants, titles: [], facts: { userEntries: messages.length, otherUpdates: other } };
}
/** Whether this Harness's native history of the user's entries can be read by a probe, and how. */
function readerOf(h: Rig): "claude" | "codex" | "replay" | "none" {
  if (h.harnessId === "claude") return "claude";
  if (h.harnessId === "codex") return "codex";
  return h.facts.loadSession === true ? "replay" : "none";
}
/** The record of an open conversation, read live: Claude Code's transcript from `offset`, or Codex's turns. An ACP agent's record is its replay (replayAfter). */
async function recordOf(h: Rig, open: Open, stored: string | null, offset = 0): Promise<NativeRecord | null> {
  const reader = readerOf(h);
  if (reader === "claude") return stored === null ? null : claudeRecord(h, stored, offset);
  if (reader === "codex") return codexRecord(open);
  return null;
}
/**
 * The path of Claude Code's transcript for an open conversation, relative to its `projects/` directory: the workspace's realpath
 * with every character but ASCII letters and digits as `-` (a character outside the BMP is two; claude-agent-acp 0.99.1
 * session-index/project-dirs.js), then `<id>.jsonl`. Null for any other Harness. The Drivers keep no position any more
 * (the decision log of 2026-11-11): the probes work the path out themselves.
 */
async function claudeStored(h: Rig, open: Open): Promise<string | null> {
  if (h.harnessId !== "claude") return null;
  return (await realpath(h.workspace).catch(() => h.workspace)).normalize("NFC").replace(/[^a-zA-Z0-9]/g, "-") + "/" + open.id + ".jsonl";
}

// ---------------------------------------------------------------------------------------------------------------------
// A synthetic packet and what is asked of it
// ---------------------------------------------------------------------------------------------------------------------

const WORDS_A = ["amber", "birch", "cedar", "dune", "ember", "fjord", "glade", "harbor", "iris", "juniper", "kelp", "lotus", "maple", "nectar", "onyx", "pebble"] as const;
const WORDS_B = ["falcon", "heron", "otter", "lynx", "wren", "badger", "marten", "osprey", "puffin", "raven", "stoat", "tern", "vole", "yak", "zebu", "ibis"] as const;
/** A codeword that only one packet carries: two words and three digits, derived from a nonce. */
function codewordOf(nonce: string): string {
  const digest = createHash("sha256").update(nonce).digest();
  return WORDS_A[digest[0]! % 16]! + "-" + WORDS_B[digest[1]! % 16]! + "-" + String(100 + digest.readUInt16BE(2) % 900);
}
interface Built { readonly turn: RelayTurn; readonly rendering: ReturnType<typeof renderRelay>; readonly codeword: string; readonly title: string; readonly end: string }
function relayTurnOf(rendering: ReturnType<typeof renderRelay>, user: string, codeword: string): Built {
  assert.ok(rendering.text.endsWith("\n" + user), "the rendering ends with the user's words");
  const body = rendering.text.slice(0, rendering.text.length - user.length - 1), lines = body.split("\n");
  const turnText: RelayTurn = { user, relay: { packetId: relayPacketId(rendering.packetId), body, firstLine: rendering.record.firstLine } };
  return { turn: turnText, rendering, codeword, title: lines.find(line => line.startsWith("〔HarnessHub ")) ?? "", end: lines.at(-1) ?? "" };
}
/** The Harness whose work the synthetic packet reports: another one than the target. */
const sourceOf = (target: string): string => target === "claude" ? "codex" : "claude";
const names = (id: string): string | null => displayNames.get(id) ?? null;
/** A complete packet for `target`: the work of another Harness (one turn, harmless synthetic facts, a codeword), then the user's words. */
function fullPacket(target: string, user: string, nonce: string, firstLine = true): Built {
  const codeword = codewordOf(nonce);
  const scenario = conversation([
    { input: "给导出文件加一个标题行，再把测试跑一遍。", harnessId: sourceOf(target), model: "synthetic-model", reply: "标题行已经加好，测试全部通过。这次核对用的暗号是 " + codeword + "。",
      tools: [tool("r1", "Read src/export.ts", "read"), tool("e1", "Edit `src/export.ts`", "edit")] },
    { input: user, harnessId: target }]);
  return relayTurnOf(renderRelay({ state: snapshotHistory(scenario.state), current: scenario.current, sources: scenario.sources, origin: false, names, firstLine }), user, codeword);
}
/**
 * A delta for `target` back on its own native session: it said `number` in its first turn (its binding stands there), another
 * Harness did the second turn and said `number + 1`, and the user now asks `question`.
 */
function deltaPacket(target: string, partner: string, number: number, question: string): Built {
  const scenario = conversation([
    { input: "Think of any five-digit number and reply with only that number.", harnessId: target, reply: String(number) },
    { input: "上一位 Harness 回复的那个五位数加 1 等于多少？只回复结果数字本身，不要调用任何工具，不要别的字。", harnessId: partner, reply: String(number + 1) },
    { input: question, harnessId: target }],
  [{ harnessId: target, controlId: target + "-acp", checkpoint: "private", throughRunId: runId("run-1"), status: "ready" }]);
  return relayTurnOf(renderRelay({ state: snapshotHistory(scenario.state), current: scenario.current, sources: scenario.sources.slice(1), origin: false, names, firstLine: true }), question, "");
}

/** The sent parts of a relay Turn by the Driver's placement (what the Driver hands the native side), as one text for comparing. */
function sentParts(h: Rig, turnText: RelayTurn): readonly string[] { return h.harnessId === "codex" ? [singleText(turnText)] : placeTurn(turnText, h.caps?.placement); }
/** Where the packet and the user's words lie in a native user entry, and whether it holds them byte for byte. */
function placementFacts(h: Rig, entry: UserEntry | undefined, built: Built): Record<string, unknown> {
  if (entry === undefined) return { found: false };
  const sent = sentParts(h, built.turn), whole = sent.join(""), lineFed = sent.join("\n"), joined = entry.texts.join(""), words = built.turn.user;
  const parts = entry.texts.length === sent.length && entry.texts.every((text, index) => text === sent[index]);
  const titleAt = joined.indexOf(built.title), wordsAt = joined.lastIndexOf(words), lines = joined.split("\n");
  // How the native side kept the text blocks: each as sent, joined as they were, or merged with a line feed between them (OpenCode).
  const joinedBy = parts ? "parts" : joined === whole ? "concat" : joined === lineFed || entry.texts.join("\n") === lineFed ? "line feed between the blocks" : "different";
  return { found: true, blockKinds: entry.kinds, textBlocks: entry.texts.length, sentBlocks: sent.length, sameBytes: joined === whole, sameParts: parts, joinedBy,
    sentSha: short(whole), recordedSha: short(joined), titleVerbatim: built.title !== "" && lines.includes(built.title), endLineVerbatim: built.end !== "" && lines.includes(built.end),
    bodyVerbatim: joined.includes(built.turn.relay.body), wordsVerbatim: wordsAt >= 0, wordsLast: joined.endsWith(words), titleBeforeWords: titleAt >= 0 && wordsAt > titleAt, sentChars: [...whole].length, recordedChars: [...joined].length };
}
/** The first user entry that carries this packet's title line (null when none does). */
function entryOf(record: NativeRecord | null, built: Built): UserEntry | undefined { return record?.entries.find(entry => entry.texts.some(text => built.title !== "" && text.split("\n").includes(built.title))); }
const placementHolds = (facts: Record<string, unknown>): boolean => facts.found === true && facts.titleVerbatim === true && facts.endLineVerbatim === true && facts.bodyVerbatim === true && facts.wordsVerbatim === true && facts.titleBeforeWords === true && facts.wordsLast === true;

/** What a Turn showed of the evidence classes (§7.1), to be set against the declaration. */
function evidenceFacts(h: Rig, rec: TurnRecord): Record<string, unknown> {
  const recorded = rec.events.find(entry => entry.event.type === "input_recorded"), firstAgent = rec.events.find(entry => ["text", "thinking", "tool"].includes(entry.event.type));
  const echo = h.wire.since(rec.wireFrom, rec.wireTo).filter(entry => entry.dir === "in" && entry.method === "session/update" && record(record(entry.payload).update).sessionUpdate === "user_message_chunk").length;
  return { status: rec.result?.status ?? null, reason: rec.result?.reason ?? null, input: rec.result?.input ?? "absent", error: rec.result?.error?.code ?? null,
    inputRecordedEvent: recorded === undefined ? null : { atMs: Math.round(recorded.at), packetId: (recorded.event as { packetId?: string }).packetId === undefined ? null : "present" },
    firstAgentOutputMs: firstAgent === undefined ? null : Math.round(firstAgent.at), userEchoChunksLive: echo };
}
/** The declaration's evidence cells against what a content Turn that carried a packet showed. */
function evidenceMismatches(h: Rig, rec: TurnRecord): readonly string[] {
  const caps = h.caps, facts = evidenceFacts(h, rec), out: string[] = [];
  if (caps === null) return ["no declaration"];
  const { live, successProvesRecorded } = caps.delivery;
  if (live === "recorded_event" && facts.inputRecordedEvent === null) out.push("live=recorded_event but no input_recorded event arrived");
  if (live !== "recorded_event" && facts.inputRecordedEvent !== null) out.push("live=" + live + " but an input_recorded event arrived");
  if (live === "agent_output" && facts.firstAgentOutputMs === null) out.push("live=agent_output but the Turn showed no agent output");
  if (rec.result?.status === "completed") {
    // A completed content Turn reports input=recorded when the declaration lets success prove it, or when it showed evidence (a live
    // event, or the agent's own output, which every ACP Driver counts); never without any (ADR-055 §7.1).
    if (successProvesRecorded && facts.input !== "recorded") out.push("successProvesRecorded=true but a completed content Turn reported input=" + String(facts.input));
    if (!successProvesRecorded && facts.input === "recorded" && facts.inputRecordedEvent === null && facts.firstAgentOutputMs === null) out.push("input=recorded without a live event, agent output or a declaration that success proves it");
    if (live === "recorded_event" && facts.inputRecordedEvent !== null && facts.input !== "recorded") out.push("a live input_recorded event arrived but the result did not report input=recorded");
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// CAT, CLS, VEND, P3 (no prompt): what the Driver declares and reads, before any model is asked
// ---------------------------------------------------------------------------------------------------------------------

const brief = (reading: { readonly kind: string; readonly name?: string; readonly effect?: string; readonly acceptsRelay?: true } | undefined): string =>
  reading === undefined ? "n/a" : reading.kind + (reading.name === undefined ? "" : ":" + reading.name) + (reading.effect === undefined ? "" : ":" + reading.effect) + (reading.acceptsRelay ? ":acceptsRelay" : "");
async function probeStatic(h: Rig): Promise<void> {
  const caps = h.caps, open = await begin(h);
  try {
    const { control, catalog } = open, observation = await control.initialize(), capabilities = record(observation.capabilities);
    h.facts.agent = { name: observation.agentName, version: observation.agentVersion, protocol: observation.protocol };
    h.facts.loadSession = capabilities.loadSession === true;
    h.facts.sessionCapabilities = Object.keys(record(capabilities.sessionCapabilities)).sort();
    h.facts.promptCapabilities = Object.fromEntries(Object.entries(record(capabilities.promptCapabilities)).filter(([, value]) => typeof value === "boolean"));
    h.facts.model = h.model ?? catalog?.defaultModel ?? null;
    h.facts.catalog = catalog === null ? null : { models: catalog.models.length, defaultModel: catalog.defaultModel, commands: catalog.commands?.length ?? null, authentication: catalog.authentication,
      commandNames: (catalog.commands ?? []).map(command => command.name).filter(name => ["compact", "clear", "export", "context", "cost", "status", "usage", "model", "init", "review"].includes(name)) };
    if (caps === null) { h.find("CAT", "declaration", "refuted", "the Harness has a relay declaration", { declared: false }); return; }
    h.facts.declaration = { delivery: caps.delivery, execution: caps.execution, placement: caps.placement, title: caps.title };
    h.find("CAT", "declaration", control.relayCapabilities === caps ? "confirmed" : "refuted", "the instance carries the same frozen declaration the factory returns without an instance", { sameObject: control.relayCapabilities === caps });
    const readsBack = ["verifyDelivered", "deliveryPosition", "relayVendor", "userTextOf"].filter(member => member in control);
    h.find("CAT", "no read-back", readsBack.length === 0 ? "confirmed" : "refuted",
      "no Driver reads its native history back or reads a configuration for a vendor: the instance has no check, no position, no vendor reading and no reader of replayed entries", { readsBack });

    // CLS: how the Hub reads a fixed set of inputs with this Harness's real catalog, by the Driver's own reading and by its declaration.
    const entries = catalog === null ? null : relayEntries(catalog.commands ?? []);
    const inputs: readonly (readonly [string, string, readonly ContentKind[]])[] = [["plain", "hello", []], ["compact", "/compact", []], ["clear", "/clear", []], ["clear after a space", " /clear", []], ["clear after U+3000", "　/clear", []],
      ["clear with a file", "/clear", ["file"]], ["clear with an image", "/clear", ["image"]], ["a path", "/Users/example/notes.txt", []], ["export", "/export", []], ["model", "/model x", []], ["unknown word", "/zzprobe-unknown arg", []], ["skill form", "/skill:example arg", []]];
    h.find("CLS", "commands.classify", "observed", "how the Driver's own reading and its declaration classify fixed inputs with the real catalog (the native truth is probed apart, SLASH)",
      { table: Object.fromEntries(inputs.map(([label, text, attachments]) => [label, { driver: brief(control.classify?.(text, catalog, attachments)), declared: brief(caps.commands.classify(text, entries, attachments)) }])) });

    // P3: a relay Turn whose words the native side reads as a command is refused whole before anything is sent and never reads as recorded.
    const probeWord = ["/compact", "/clear", "/export"].find(text => { const reading = caps.commands.classify(text, entries, []); return reading.kind === "command" && reading.acceptsRelay !== true; });
    if (probeWord === undefined) h.find("P3", "refusal before insertion", "unverified", "no input reads as a command with this Harness, so there is no refusal of a command to probe", { classification: "every input is content" });
    else {
      const built = fullPacket(h.harnessId, probeWord, randomUUID(), false), refused = await turn(h, open, built.turn, "P3: relay Turn whose words are a command", { counts: false });
      const sent = h.wire.since(refused.wireFrom, refused.wireTo).filter(entry => entry.dir === "out" && ["session/prompt", "turn/start", "thread/compact/start"].includes(entry.method));
      h.find("P3", "refusal before insertion", refused.result?.status === "failed" && refused.result.input === "not_recorded" && refused.result.error?.code === "RELAY_PREPARE_FAILED" && sent.length === 0 ? "confirmed" : "refuted",
        "the Turn fails with input=not_recorded and RELAY_PREPARE_FAILED and nothing prompt-like reaches the wire", { word: probeWord, status: refused.result?.status ?? null, input: refused.result?.input ?? null, error: refused.result?.error?.code ?? null, promptsOnWire: sent.length });
    }
    // P3 (size): a packet over the declared input bound is refused before sending, not_recorded.
    const limit = caps.placement.maxInput;
    if (limit === null) h.find("P3", "placement.maxInput", "unverified", "the declaration has no input bound to cross", { maxInput: null });
    else {
      const big = fullPacket(h.harnessId, "ok", randomUUID()), over: RelayTurn = { user: "ok", relay: { ...big.turn.relay, body: "x".repeat(limit.limit + 1) } }, refused = await turn(h, open, over, "P3: relay Turn over the input bound", { counts: false });
      const sent = h.wire.since(refused.wireFrom, refused.wireTo).filter(entry => entry.dir === "out" && ["session/prompt", "turn/start"].includes(entry.method));
      h.find("P3", "placement.maxInput", refused.result?.input === "not_recorded" && refused.result.error?.code === "RELAY_INPUT_LIMIT" && sent.length === 0 ? "confirmed" : "refuted",
        "a packet over the declared bound fails with RELAY_INPUT_LIMIT, input=not_recorded, before anything is sent (the bound itself is a documented constant, not probed against the native side)",
        { unit: limit.unit, limit: limit.limit, error: refused.result?.error?.code ?? null, input: refused.result?.input ?? null, promptsOnWire: sent.length });
    }
  } finally { await finish(open); }
}
/** EMPTY: the error with which a Harness's Driver meets a conversation that was opened and never prompted, resumed by another process. */
async function probeEmpty(h: Rig): Promise<void> {
  const first = await begin(h), checkpoint = (await first.control.checkpoint?.()) ?? first.id;
  await first.conn.close();
  const mark = h.wire.mark, conn = await h.connect();
  let outcome: Record<string, unknown>;
  try {
    await conn.control.initialize();
    const id = await conn.control.open(h.workspace, h.model, h.options, checkpoint);
    outcome = { resumed: true, sameIdentity: id === checkpoint };
  } catch (error) { outcome = { resumed: false, ...failureOf(error) }; }
  finally { await conn.close().catch(() => undefined); }
  const refusal = h.wire.since(mark).find(entry => entry.kind === "error");
  h.find("EMPTY", "open(checkpoint) of a session that never took a prompt", "observed", "the error (if any) a second process gets when it resumes a conversation that was opened and never prompted; the relay maps only NATIVE_SESSION_NOT_FOUND to a fresh native session",
    { ...outcome, wireMethod: refusal?.method ?? null, wireError: refusal === undefined ? null : refusal.payload, mapsToSessionNotFound: outcome.code === "NATIVE_SESSION_NOT_FOUND" });
}

// ---------------------------------------------------------------------------------------------------------------------
// P1, P2 and P13
// ---------------------------------------------------------------------------------------------------------------------

/** The public title the Hub would set on a conversation a handoff created: it carries a preset keyword and none of the forbidden strings. */
const PUBLIC_TITLE = "导出核对示例";
/** A small text attachment in the probes' private root, as a Driver is handed one. */
async function attachmentOf(h: Rig, name: string, text: string): Promise<ControlAttachment> {
  const directory = join(h.root, "attachments"), path = join(directory, name), data = Buffer.from(text, "utf8");
  await mkdir(directory, { recursive: true }); await writeFile(path, data, { mode: 0o400 }).catch(async () => { await rm(path, { force: true }); await writeFile(path, data, { mode: 0o400 }); });
  return { id: contentId("content-probe-" + short(name + text)), name, mediaType: "text/plain", kind: "file", bytes: data.length, sha256: sha(text), path };
}
/** What a Harness's own thread says of itself (Codex: name, preview, rollout path); null when it cannot be read. */
async function codexThread(open: Open): Promise<Record<string, unknown> | null> {
  const rpc = (open.control as unknown as { rpc?: JsonRpcProcess }).rpc;
  if (rpc === undefined) return null;
  try { return record(record(await rpc.request("thread/read", { threadId: open.id, includeTurns: false }, 10_000, "reject")).thread); } catch { return null; }
}
/** The Codex facts E1 and E3 ask for: whether the user message item echoes the client identity, under which key, and when. */
function codexEchoFacts(h: Rig, rec: TurnRecord): Record<string, unknown> {
  const wire = h.wire.since(rec.wireFrom, rec.wireTo), start = wire.find(entry => entry.dir === "out" && entry.method === "turn/start"), sent = record(start?.payload);
  const reply = wire.find(entry => entry.kind === "response" && entry.method === "turn/start");
  const users = wire.filter(entry => entry.dir === "in" && entry.kind === "notification" && (entry.method === "item/started" || entry.method === "item/completed") && record(record(entry.payload).item).type === "userMessage");
  const firstAgent = wire.find(entry => entry.dir === "in" && entry.kind === "notification" && ["item/agentMessage/delta", "item/reasoning/summaryTextDelta"].includes(entry.method));
  return { turnStartSentClientId: typeof sent.clientUserMessageId === "string", turnStartParamKeys: Object.keys(sent).sort(), turnStartResponseMs: reply === undefined || start === undefined ? null : Math.round(reply.at - start.at),
    userMessageNotifications: users.map(entry => { const item = record(record(entry.payload).item); return { method: entry.method, atMs: start === undefined ? null : Math.round(entry.at - start.at), itemKeys: Object.keys(item).sort(),
      echoKeys: ["clientUserMessageId", "clientId"].filter(key => typeof item[key] === "string"), echoMatchesSent: ["clientUserMessageId", "clientId"].some(key => item[key] === sent.clientUserMessageId), contentTypes: Array.isArray(item.content) ? item.content.map(part => String(record(part).type ?? "?")) : null }; }),
    firstAgentOutputAfterUserMessage: firstAgent === undefined || users[0] === undefined ? null : users[0].at <= firstAgent.at };
}
/** Where a file attachment lies in a native user entry, against the user's words. */
function landingFacts(entry: UserEntry | undefined, user: string, name: string): Record<string, unknown> {
  if (entry === undefined) return { found: false };
  const joined = entry.texts.join(""), lastText = entry.kinds.lastIndexOf("text") >= 0 ? entry.kinds.lastIndexOf("text") : entry.kinds.lastIndexOf("string");
  return { found: true, blockKinds: entry.kinds, wordsIn: joined.includes(user), nameInText: joined.includes(name), nameAfterWords: joined.lastIndexOf(name) > joined.lastIndexOf(user) && joined.includes(name),
    nonTextBlockAfterText: entry.kinds.length > 0 && entry.kinds.some((kind, index) => index > lastText && kind !== "text" && kind !== "string") };
}
/**
 * P1 placement, P2 evidence, P13 titles: a relay Turn with a packet and the user's words, a second one with a file, a close, and a
 * new process that resumes the conversation and lists it. (The check of delivery afterwards, the position and P11's window logic
 * went with them from the Drivers, the decision log of 2026-11-11.)
 */
async function probePlacement(h: Rig): Promise<void> {
  const caps = h.caps;
  if (caps === null) throw new Error("this Harness has no relay declaration");
  const user1 = "上面记录里写的核对暗号是什么？只回复暗号本身，不要调用任何工具，不要别的字。", built1 = fullPacket(h.harnessId, user1, randomUUID());
  const user2 = "附件的文件名是什么？只回复文件名，不要调用任何工具，不要别的字。", built2 = fullPacket(h.harnessId, user2, randomUUID());
  const first = await begin(h);
  let checkpoint: string | null = null, stored: string | null = null, titles: Record<string, unknown> = {};
  try {
    if (caps.title === "set" && first.control.setTitle !== undefined) {
      try { await first.control.setTitle(first.id, PUBLIC_TITLE); h.facts.setTitle = "accepted"; } catch (error) { h.facts.setTitle = failureOf(error); }
    }
    stored = await claudeStored(h, first);
    const t1 = await turn(h, first, built1.turn, "P1: relay Turn (packet and words)");
    const mismatches = evidenceMismatches(h, t1);
    h.find("P2", "delivery.live / successProvesRecorded", mismatches.length === 0 && t1.result?.status === "completed" ? "confirmed" : "refuted",
      "a completed content Turn that carried a packet shows the evidence the declaration names (live event, input)", { ...evidenceFacts(h, t1), mismatches });
    if (h.harnessId === "codex") {
      const echo = codexEchoFacts(h, t1), user = (echo.userMessageNotifications as { echoKeys: string[]; echoMatchesSent: boolean }[])[0];
      h.find("E1", "codex clientUserMessageId echo", user !== undefined && user.echoMatchesSent ? "confirmed" : "refuted", "turn/start carries clientUserMessageId and the userMessage item of the thread echoes it (under which key), before any agent output", echo);
    }
    h.find("P1", "packet visible to the model", t1.reply.includes(built1.codeword) ? "confirmed" : "refuted", "the reply carries the codeword that only the packet holds", { codewordInReply: t1.reply.includes(built1.codeword), replyChars: [...t1.reply].length });
    const live = readerOf(h) === "claude" || readerOf(h) === "codex";
    const rec1 = live ? await recordOf(h, first, stored) : null, facts1 = placementFacts(h, entryOf(rec1, built1), built1);
    if (!live) { /* an ACP agent's record is its replay at a resume: read below, in the second process */ }
    else if (rec1 === null) h.find("P1", "placement (title line, words, order)", "unverified", "the native record of the user's entry cannot be read for this Harness", { reader: readerOf(h) });
    else h.find("P1", "placement (title line, words, order)", placementHolds(facts1) ? "confirmed" : "refuted", "the native user entry holds the title line verbatim, the whole packet verbatim, then the user's words verbatim, in that order", { ...facts1, reader: rec1.source });
    if (h.harnessId === "codex" && rec1 !== null) h.find("E3", "itemsView full", rec1.facts.turnsWithItems === rec1.facts.turns && (rec1.facts.userItemsWithClientId as number) > 0 ? "confirmed" : "refuted",
      "thread/turns/list with itemsView=full returns the items of every turn, user messages with their client identity", rec1.facts);
    // Where no native record can be read (DeepSeek Harness), the model is asked to quote what it received: weaker than a record, and never a refutation.
    if (readerOf(h) === "none") {
      const title = await turn(h, first, "你收到的上一条用户消息里，以“〔HarnessHub”开头的那一行是什么？逐字回复那一行，不要调用任何工具，不要别的字。", "P1: ask the model to quote the title line");
      const last = await turn(h, first, "那条消息的最后一行是什么？逐字回复那一行，不要调用任何工具，不要别的字。", "P1: ask the model to quote the last line");
      h.find("P1", "placement (model-reported)", title.reply.includes(built1.title) && last.reply.trim() === user1 ? "confirmed" : "observed", "no native record can be read, so the model is asked to quote the title line and the last line of the message it received (confirmed when both are verbatim; a model's misquote proves nothing)",
        { titleLineVerbatim: title.reply.includes(built1.title), lastLineIsTheWords: last.reply.trim() === user1, titleReplyChars: [...title.reply].length, lastReplyChars: [...last.reply].length });
    }
    // The second Turn: a packet and a file attachment, where the pointer lands.
    const file = await attachmentOf(h, "notes.txt", "synthetic attachment for the placement probe\n");
    const t2 = await turn(h, first, built2.turn, "P1: relay Turn with a file", { attachments: [file] });
    const rec2 = live ? await recordOf(h, first, stored) : null, entry2 = entryOf(rec2, built2), landing = landingFacts(entry2, user2, file.name);
    if (live) h.find("P1", "attachments after the user's words", rec2 === null ? "unverified" : entry2 === undefined ? "refuted" : landing.nameAfterWords === true || landing.nonTextBlockAfterText === true ? "confirmed" : "observed",
      "the attachment (a pointer in the text, or a block) lies after the user's words in the same native user entry", { ...landing, status: t2.result?.status ?? null, input: t2.result?.input ?? null, ...(entry2 === undefined ? {} : { placement: placementFacts(h, entry2, built2) }) });
    // P13: the titles the native side gave this conversation.
    await delay(2000);
    if (h.harnessId === "codex") { const thread = await codexThread(first); titles = { name: thread?.name ?? null, preview: typeof thread?.preview === "string" ? plain(thread.preview, 80) : null }; if (typeof thread?.path === "string") h.rollouts.add(thread.path); }
    else if (readerOf(h) === "claude" && stored !== null) { const record = await claudeRecord(h, stored); titles = { aiTitles: (record?.titles ?? []).map(title => plain(title, 80)) }; }
    checkpoint = (await first.control.checkpoint?.()) ?? first.id;
  } finally { await finish(first); }

  // The second process: resume the conversation and list it, for the titles ACP agents give.
  const second = await begin(h, checkpoint ?? undefined);
  try {
    // P13 for ACP agents that list their sessions: the title they give the conversation.
    if (second.control.nativeSessions !== undefined && readerOf(h) !== "claude") {
      try { const page = await second.control.nativeSessions(h.workspace), row = page.sessions.find(item => item.id === second.id); titles = { ...titles, listed: row !== undefined, listTitle: row?.title === undefined || row.title === null ? null : plain(row.title, 80) }; } catch (error) { titles = { ...titles, listFailure: failureOf(error) }; }
    }
    const strings = [titles.name, titles.preview, titles.listTitle, ...(Array.isArray(titles.aiTitles) ? titles.aiTitles : [])].filter((value): value is string => typeof value === "string");
    h.find("P13", "native title", strings.length === 0 ? "unverified" : strings.some(value => FORBIDDEN_TITLE.test(value)) ? "refuted" : "confirmed",
      "no native title (name, preview, listed or generated) carries HarnessHub, 交接, 接手, handoff, relay-, 〔 or ai-title", { titles, declaredTitle: caps.title, publicTitleSet: h.facts.setTitle ?? null, titleEqualsPublic: titles.name === PUBLIC_TITLE });
  } finally { await finish(second); }
  // The record of an ACP agent that replays its history: read by another process after the second one closed.
  if (readerOf(h) === "replay" || readerOf(h) === "none") {
    const rec = readerOf(h) === "replay" && checkpoint !== null ? await replayAfter(h, checkpoint) : null;
    if (rec === null) {
      h.find("P1", "placement (title line, words, order)", "unverified", "this Harness replays no history to a reader, so its native record of the user's entry cannot be read", { loadSession: h.facts.loadSession === true, replayFailure: h.facts.replayFailure ?? null });
      h.find("P1", "placement.pointersAfterUser", "unverified", "no readable native record (see P1 placement)", {});
    } else {
      const facts = placementFacts(h, entryOf(rec, built1), built1), landing = landingFacts(entryOf(rec, built2), user2, "notes.txt");
      h.find("P1", "placement (title line, words, order)", placementHolds(facts) ? "confirmed" : "refuted", "the replayed user entry holds the title line, the packet and the user's words verbatim, in that order", { ...facts, reader: rec.source, replay: rec.facts });
      h.find("P1", "attachments after the user's words", entryOf(rec, built2) === undefined ? "refuted" : landing.nameAfterWords === true || landing.nonTextBlockAfterText === true ? "confirmed" : "observed", "the attachment lies after the user's words in the replayed entry", { ...landing });
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// SLASH: what a slash word really does, against the declaration and the classification
// ---------------------------------------------------------------------------------------------------------------------

/**
 * What an ACP agent replays of a conversation to a process that reads it (session/load through the Driver's importSession; a
 * Harness that only resumes replays nothing, and Hermes replays at every open): the user entries with their block kinds, from the
 * wire. Null when the agent replays no history. The connection is closed after.
 */
async function replayAfter(h: Rig, checkpoint: string): Promise<NativeRecord | null> {
  const conn = await h.connect(), mark = h.wire.mark;
  try {
    await conn.control.initialize();
    if (conn.control.importSession === undefined) return null;
    const imported = await conn.control.importSession(checkpoint, h.workspace);
    return imported.historyRead ? replayRecord(h.wire.since(mark), checkpoint) : null;
  } catch (error) { h.facts.replayFailure = failureOf(error); return null; }
  finally { await conn.close().catch(() => undefined); }
}
const modelCalled = (rec: TurnRecord): boolean | null => {
  const total = rec.usage.turn.total ?? (rec.usage.turn.input === undefined && rec.usage.turn.output === undefined ? undefined : (rec.usage.turn.input ?? 0) + (rec.usage.turn.output ?? 0));
  return total === undefined ? null : total > 0;
};
async function probeSlash(h: Rig): Promise<void> {
  const caps = h.caps;
  if (caps === null) throw new Error("this Harness has no relay declaration");
  const open = await begin(h);
  try {
    const stored = await claudeStored(h, open), word = "/zzprobe-unlisted hello";
    const unlisted = await turn(h, open, word, "SLASH: an unlisted slash word as a plain prompt");
    let rec: NativeRecord | null;
    if (readerOf(h) === "replay") { const id = (await open.control.checkpoint?.()) ?? open.id; await finish(open); rec = await replayAfter(h, id); } else rec = await recordOf(h, open, stored);
    const recordedAs = rec === null ? null : rec.entries.some(entry => entry.texts.join("") === word), called = modelCalled(unlisted);
    // What the 2026-11-10 probe found: every Driver's native side takes an unlisted slash word as text, Hermes's viewer runs it.
    const unlistedSlash = h.harnessId === "hermes" ? "executed" : "text";
    const verdict: Verdict = unlistedSlash === "text" ? (called === true || recordedAs === true ? "confirmed" : called === false || recordedAs === false ? "refuted" : unlisted.reply.length > 0 ? "observed" : "unverified")
      : (called === false ? "confirmed" : called === true ? "refuted" : "unverified");
    h.find("SLASH", "an unlisted slash word", verdict, "text: the model is asked / the entry is recorded as typed; executed: the native side consumes it without asking the model",
      { expected: unlistedSlash, status: unlisted.result?.status ?? null, reason: unlisted.result?.reason ?? null, input: unlisted.result?.input ?? "absent", modelCalled: called, recordedAsTyped: recordedAs, replyChars: [...unlisted.reply].length, tokens: unlisted.usage.turn });
    if (h.harnessId !== "claude") return;
    // Claude Code: with a file attached, a listed local command reads as content (the CLI looks for a command in the last block only).
    const local = ["context", "cost", "status", "usage"].find(name => open.catalog?.commands?.some(command => command.name === name));
    if (local === undefined) { h.find("SLASH", "claudeReadsSlash(attachments)", "unverified", "the catalog lists none of the local commands context, cost, status, usage", {}); return; }
    const control = await turn(h, open, "/" + local, "SLASH: a local command without an attachment"), file = await attachmentOf(h, "slash.txt", "synthetic attachment for the slash probe\n");
    const withFile = await turn(h, open, "/" + local, "SLASH: the same command with a file attached", { attachments: [file] });
    const after = await recordOf(h, open, stored), typed = after?.entries.filter(entry => entry.texts.some(text => text.includes("/" + local))) ?? [];
    const controlCalled = modelCalled(control), fileCalled = modelCalled(withFile);
    h.find("SLASH", "claudeReadsSlash(attachments)", controlCalled === false && fileCalled === true ? "confirmed" : controlCalled === null || fileCalled === null ? "unverified" : "refuted",
      "the command alone is consumed without the model (a valid control), and the same words with a file attached are sent to the model as content",
      { command: local, aloneModelCalled: controlCalled, withFileModelCalled: fileCalled, aloneReplyChars: [...control.reply].length, withFileReplyChars: [...withFile.reply].length, entriesNamingTheCommand: typed.map(entry => entry.kinds), driverReadsContentWithFile: caps.commands.classify("/" + local, relayEntries(open.catalog?.commands ?? []), ["file"]).kind === "content" });
    // The same command after a leading space and after a leading U+3000: the Driver reads both as words (claudeCommand: the slash must
    // be the first character, since the probe of 2026-11-10, F1, found the CLI runs no command after either and asks the model).
    const lead: Record<string, boolean | null> = {};
    for (const [label, prefix] of [["a leading space", " "], ["a leading U+3000", "\u3000"]] as const) lead[label] = modelCalled(await turn(h, open, prefix + "/" + local, "SLASH: the command after " + label));
    h.find("SLASH", "leading whitespace before a slash command (VF1-06)", controlCalled !== false || Object.values(lead).some(called => called === null) ? "unverified" : Object.values(lead).every(called => called === true) ? "confirmed" : "refuted",
      "the CLI runs no command after a leading space or U+3000 and asks the model with the text, as the Driver's reading says (a valid control: the same command alone is consumed without the model)", { command: local, modelCalledAfter: lead, aloneModelCalled: controlCalled,
      driverReads: ["", " ", "\u3000"].map(prefix => brief(caps.commands.classify(prefix + "/" + local, relayEntries(open.catalog?.commands ?? []), []))) });
  } finally { await finish(open); }
}

// ---------------------------------------------------------------------------------------------------------------------
// P6: clear (Claude Code's Driver synthesizes it; the other four Harnesses have no clear command)
// ---------------------------------------------------------------------------------------------------------------------

async function probeClear(h: Rig): Promise<void> {
  const caps = h.caps;
  if (caps === null) throw new Error("this Harness has no relay declaration");
  if (h.harnessId !== "claude") {
    h.find("P6", "clear", "unverified", "the Hub's clear on this Harness (/clear, /new, /reset: not sent, the native session given up) is tested against its protocol with a synthetic peer, not on the real Harness; this probe runs for Claude Code only", {});
    return;
  }
  const word = codewordOf(randomUUID()), first = await begin(h), stored = await claudeStored(h, first);
  const checkpoint = first.id, projectDirectory = stored === null ? null : join(h.claudeConfig, "projects", stored.split("/")[0]!);
  const files = async (): Promise<readonly string[]> => projectDirectory === null ? [] : (await readdir(projectDirectory).catch(() => [])).filter(name => name.endsWith(".jsonl")).sort();
  const launch = (first.control as unknown as { claudeLaunch?: ConstructorParameters<typeof AcpControl>[0] }).claudeLaunch, settings = (first.control as unknown as { claudeOptions?: ConstructorParameters<typeof AcpControl>[1] }).claudeOptions;
  let remembered: TurnRecord;
  try { remembered = await turn(h, first, "请记住这个暗号：" + word + "。只回复“记住了”，不要调用任何工具。", "P6: remember a codeword"); } finally { await first.conn.close().catch(() => undefined); }
  const filesBefore = await files(), sizeBefore = stored === null ? null : (await claudeRecord(h, stored))?.facts.bytes ?? null;
  // (1) The CLI's own /clear, sent raw through the generic ACP driver on Claude Code's launch: does the adapter adopt the new conversation?
  if (launch === undefined || settings === undefined) h.find("P6", "the CLI's own /clear", "unverified", "the Claude Driver did not expose its launch for a raw ACP connection", {});
  else {
    const raw = new AcpControl(launch, settings);
    try {
      await raw.initialize();
      const rawId = await raw.open(h.workspace, h.model, h.options, checkpoint), rawOpen: Open = { conn: { control: raw, close: () => raw.close() }, control: raw, id: rawId, catalog: null, wireFrom: h.wire.mark, wireTo: h.wire.mark };
      const sent = await turn(h, rawOpen, "/clear", "P6: the CLI's own /clear, sent raw");
      h.facts.rawClear = { status: sent.result?.status ?? null, reason: sent.result?.reason ?? null, input: sent.result?.input ?? "absent", modelCalled: modelCalled(sent), replyChars: [...sent.reply].length, tokens: sent.usage.turn };
    } finally { await raw.close().catch(() => undefined); }
  }
  const filesAfterRaw = await files(), sizeAfterRaw = stored === null ? null : (await claudeRecord(h, stored))?.facts.bytes ?? null;
  // (2) Resume the old identity in a new process: does it still hold the conversation from before the clear?
  const resumed = await begin(h, checkpoint);
  let afterNative: TurnRecord, synthetic: TurnRecord, wiped: TurnRecord, again: TurnRecord;
  try {
    afterNative = await turn(h, resumed, "上面让你记住的暗号是什么？只回复暗号本身；如果你不知道，只回复“不知道”。不要调用任何工具。", "P6: after the CLI's /clear, resumed by the old identity");
    h.find("P6", "the CLI's own /clear, adopted by the adapter?", "observed", "after a raw /clear, a new process that resumes the old identity still answers the codeword (the adapter did not adopt the CLI's new conversation) — the ground of the Driver's synthetic clear",
      { rawClear: h.facts.rawClear ?? null, oldIdentityStillHoldsTheConversation: afterNative.reply.includes(word), transcriptFilesBefore: filesBefore.length, transcriptFilesAfterRaw: filesAfterRaw.length, newTranscriptFile: filesAfterRaw.some(name => !filesBefore.includes(name)), bytesBefore: sizeBefore, bytesAfterRaw: sizeAfterRaw });
    // (3) The Driver's own clear: nothing is sent, the old conversation is given up, the next Turn is a new native session.
    const mark = h.wire.mark, sizeBeforeSynthetic = stored === null ? null : (await claudeRecord(h, stored))?.facts.bytes ?? null;
    synthetic = await turn(h, resumed, "/clear", "P6: the Driver's synthetic clear", { counts: false });
    const prompts = h.wire.since(mark).filter(entry => entry.dir === "out" && entry.method === "session/prompt"), sizeAfterSynthetic = stored === null ? null : (await claudeRecord(h, stored))?.facts.bytes ?? null;
    const cleared = synthetic.result?.native;
    h.find("P6", "synthetic clear", synthetic.result?.status === "completed" && synthetic.result.input === "not_recorded" && cleared?.cleared === true && prompts.length === 0 && sizeBeforeSynthetic === sizeAfterSynthetic ? "confirmed" : "refuted",
      "the Driver answers a /clear with native.cleared, input=not_recorded, sends no prompt, and leaves the old transcript as it was", { status: synthetic.result?.status ?? null, input: synthetic.result?.input ?? "absent", cleared: cleared?.cleared ?? null, promptsOnWire: prompts.length, transcriptBytesBefore: sizeBeforeSynthetic, transcriptBytesAfter: sizeAfterSynthetic });
    // (3b) The same connection opens the next native session (the Runtime's next Turn): it must not know the codeword.
    const idAfter = await resumed.control.open(h.workspace, h.model, h.options), next: Open = { ...resumed, id: idAfter };
    h.sessions.add(idAfter);
    wiped = await turn(h, next, "之前让你记住的暗号是什么？你不知道就只回复“不知道”。不要调用任何工具。", "P6: the first Turn after the synthetic clear");
    h.find("P6", "a new native session after a clear", idAfter !== checkpoint && !wiped.reply.includes(word) ? "confirmed" : "refuted", "the Turn after the clear runs in a new native session that does not hold the codeword", { newIdentity: idAfter !== checkpoint, codewordInReply: wiped.reply.includes(word) });
  } finally { await resumed.conn.close().catch(() => undefined); }
  // (4) The old conversation is still resumable after the synthetic clear.
  const old = await begin(h, checkpoint);
  try {
    again = await turn(h, old, "上面让你记住的暗号是什么？只回复暗号本身；如果你不知道，只回复“不知道”。不要调用任何工具。", "P6: the old identity resumed again after the synthetic clear");
    h.find("P6", "the old transcript is still resumable after a clear", again.reply.includes(word) ? "confirmed" : "refuted", "a new process that resumes the old identity after the synthetic clear still holds the conversation (the clear gave up the session, it did not delete it)", { codewordInReply: again.reply.includes(word) });
  } finally { await old.conn.close().catch(() => undefined); }
}

// ---------------------------------------------------------------------------------------------------------------------
// LATE: a cancelled prompt whose input may still arrive
// ---------------------------------------------------------------------------------------------------------------------

async function lateOnce(h: Rig, variant: "at once" | "after the first output"): Promise<void> {
  const caps = h.caps!, built = fullPacket(h.harnessId, "请从 1 数到 80，每行一个数字，不要调用任何工具。", randomUUID()), open = await begin(h);
  const stored = await claudeStored(h, open);
  let checkpoint: string | null = null;
  const samples: { when: string; present: boolean | null }[] = [];
  const present = async (live: Open | null, when: string): Promise<void> => {
    const rec = live === null ? null : await recordOf(h, live, stored);
    samples.push({ when, present: rec === null ? null : entryOf(rec, built) !== undefined });
  };
  let cancelled: TurnRecord, followUp: TurnRecord | null = null;
  try {
    // The prompt is cancelled the moment it is on the wire, or once the model has begun to answer.
    cancelled = await turn(h, open, built.turn, "LATE (" + variant + "): relay Turn cancelled", { during: async ({ run, events }) => {
      if (variant === "after the first output") for (let waited = 0; waited < 20_000 && !events.some(entry => ["text", "thinking", "tool"].includes(entry.event.type)); waited += 20) await delay(20);
      await run.requestStop();
    } });
    checkpoint = (await open.control.checkpoint?.()) ?? open.id;
    const live = readerOf(h) === "claude" || readerOf(h) === "codex";
    if (live) { await present(open, "at the result"); await delay(3000); await present(open, "3 s later"); }
    // What the Runtime does after a cancel: the next input goes on. A prompt the native side had queued would show up behind it.
    if (variant === "at once" && open.control.healthy?.() !== false && cancelled.result !== null) {
      try { followUp = await turn(h, open, "只回复：好", "LATE (at once): a plain follow-up Turn after the cancelled one"); } catch (error) { if (error instanceof Abort) throw error; }
      if (live && followUp !== null) await present(open, "after the follow-up Turn");
    }
  } finally { await finish(open); }
  // After the close, by another process: the replay (OpenCode) or the file (Claude Code) or the turn list (Codex).
  await delay(2000);
  let reopenFailure: Record<string, unknown> | null = null;
  try {
    if (readerOf(h) === "replay" && checkpoint !== null) { const rec = await replayAfter(h, checkpoint); samples.push({ when: "after a close, read by another process", present: rec === null ? null : entryOf(rec, built) !== undefined }); }
    else { const reopened = await begin(h, checkpoint ?? undefined); try { await present(reopened, "after a close and a resume"); } finally { await finish(reopened); } }
  } catch (error) { reopenFailure = failureOf(error); samples.push({ when: "after a close and a resume", present: null }); }
  const known = samples.filter(sample => sample.present !== null), lateSeen = known.some((sample, index) => sample.present === true && known.slice(0, index).some(earlier => earlier.present === false));
  const everSeen = known.some(sample => sample.present === true), result = cancelled.result;
  // What the 2026-11-10 probe found: OpenCode and OpenClaw take a cancelled prompt's input later (the declaration no longer says it: nothing reads it).
  const expectedLate = h.harnessId === "opencode" || h.harnessId === "openclaw";
  h.find("LATE", "a cancelled prompt's late delivery (" + variant + ")", lateSeen ? (expectedLate ? "confirmed" : "refuted") : "observed",
    "a late delivery is seen when the input is absent from the native record at the result and present later; one timing cannot prove its absence, so no late arrival is only an observation",
    { expected: expectedLate, status: result?.status ?? null, reason: result?.reason ?? null, input: result?.input ?? "absent", cancelAtMs: cancelled.firstEventMs, samples, everRecorded: everSeen, replyChars: [...cancelled.reply].length, readable: known.length > 0, followUp: followUp === null ? null : { status: followUp.result?.status ?? null, input: followUp.result?.input ?? "absent" },
      reopenFailure, noNativeSessionLeft: reopenFailure !== null && reopenFailure.remoteCode === -32002 });
}
async function probeLate(h: Rig): Promise<void> {
  if (h.caps === null) throw new Error("this Harness has no relay declaration");
  await lateOnce(h, "at once");
  await lateOnce(h, "after the first output");
}

// ---------------------------------------------------------------------------------------------------------------------
// P16: a process killed in the middle of a Turn, a read-only resume, and the next input
// ---------------------------------------------------------------------------------------------------------------------

async function groupGone(group: number | null, waitMs: number): Promise<boolean | null> {
  if (group === null) return null;
  for (const deadline = performance.now() + waitMs; performance.now() < deadline;) {
    try { process.kill(-group, 0); }
    catch (error) {
      // macOS answers EPERM for a group whose members have all exited but are not yet reaped.
      if (record(error).code === "ESRCH" || record(error).code === "EPERM" && darwinExitedGroupIsQuiescent(group)) return true;
      if (record(error).code !== "EPERM") return null;
    }
    await delay(50);
  }
  return false;
}
async function probeKill(h: Rig): Promise<void> {
  const caps = h.caps;
  if (caps === null) throw new Error("this Harness has no relay declaration");
  const first = await begin(h), stored = await claudeStored(h, first);
  let checkpoint: string, group: number | null = null, killed: TurnRecord, gone: boolean | null = null;
  try {
    await turn(h, first, "只回复：就绪", "P16: a first Turn (the session exists on the native side)");
    checkpoint = (await first.control.checkpoint?.()) ?? first.id; group = first.control.processGroup?.() ?? null;
    killed = await turn(h, first, "请从 1 数到 200，每行一个数字，数完就停，不要调用任何工具。", "P16: a Turn whose process group is killed mid-way", { during: async ({ events }) => {
      for (let waited = 0; waited < 20_000 && !events.some(entry => entry.event.type === "text" || entry.event.type === "thinking"); waited += 25) await delay(25);
      if (group !== null) process.kill(-group, "SIGKILL");
    } });
    gone = await groupGone(group, 5000);
  } finally { await first.conn.close().catch(() => undefined); }
  // A Harness whose sessions run in a service of its own (OpenCode 2) goes on with the Turn without its client: give it time to finish what it would.
  await delay(15_000);
  const mark = h.wire.mark, sizeBefore = readerOf(h) === "claude" && stored !== null ? (await claudeRecord(h, stored))?.facts.bytes ?? null : null;
  // The read-only resume: another process opens the conversation and does nothing else.
  const second = await begin(h, checkpoint);
  try {
    await delay(1500);
    const sizeAfter = readerOf(h) === "claude" && stored !== null ? (await claudeRecord(h, stored))?.facts.bytes ?? null : null;
    const opening = h.wire.since(mark, second.wireTo), later = h.wire.since(second.wireTo);
    const outbound = [...new Set(opening.filter(entry => entry.dir === "out" && entry.kind === "request").map(entry => entry.method))].sort();
    const turnSigns = later.filter(entry => entry.dir === "in" && (entry.method === "turn/started" || ["agent_message_chunk", "agent_thought_chunk", "tool_call"].includes(String(record(record(entry.payload).update).sessionUpdate)))).length;
    const prompted = opening.some(entry => entry.dir === "out" && ["session/prompt", "turn/start"].includes(entry.method));
    const killedRecord = await recordOf(h, second, stored);
    h.find("P16", "read-only resume after the process group was killed", gone === true && !prompted && turnSigns === 0 && (sizeBefore === null || sizeBefore === sizeAfter) ? "confirmed" : "refuted",
      "the killed Turn's process group is gone, another process resumes the conversation, and neither the open nor 1.5 s after it sends a prompt, shows a turn, or writes to the transcript",
      { group: group === null ? null : "known", groupGone: gone, killedStatus: killed.result?.status ?? null, killedFailure: killed.failure, outboundAtOpen: outbound, promptOnWire: prompted, turnSignsAfterOpen: turnSigns, transcriptBytesBefore: sizeBefore, transcriptBytesAfter: sizeAfter, hadText: killed.reply.length > 0,
        killedEntryRecorded: killedRecord === null ? null : killedRecord.entries.some(entry => entry.texts.join("").includes("从 1 数到 200")) });
    const typed = "只回复：完成-" + short(randomUUID()).slice(0, 6), next = await turn(h, second, typed, "P16: the next input after the resume");
    let afterRecord: NativeRecord | null;
    if (readerOf(h) === "replay") { const id = (await second.control.checkpoint?.()) ?? second.id; await finish(second); afterRecord = await replayAfter(h, id); }
    else afterRecord = await recordOf(h, second, stored);
    const last = afterRecord?.entries.at(-1);
    const killedAt = afterRecord === null ? -1 : afterRecord.entries.findIndex(entry => entry.texts.join("").includes("从 1 数到 200"));
    const killedReply = afterRecord === null || killedAt < 0 ? null : afterRecord.assistants.filter(item => item.afterUser === killedAt).map(item => item.text).join("");
    h.find("P16", "the killed Turn does not go on without its client", killedReply === null ? "unverified" : /(^|\n)200(\n|$)/u.test(killedReply) ? "refuted" : "confirmed",
      "15 s after the process group was killed in the middle of a count to 200, the native record holds no reply that reached 200 (a Harness that runs sessions in a service of its own would have finished it): the declaration's execution=process", { declared: caps.execution, killedPromptInRecord: killedAt >= 0, killedReplyChars: killedReply === null ? null : [...killedReply].length, reachedTheEnd: killedReply === null ? null : /(^|\n)200(\n|$)/u.test(killedReply), reader: readerOf(h) });
    h.find("P16", "the next input after the resume goes as typed", next.result?.status !== "completed" ? "refuted" : afterRecord === null ? "unverified" : last !== undefined && last.texts.join("") === typed ? "confirmed" : "refuted",
      "the Turn after the resume completes and the last user entry of the native record equals what was typed, byte for byte", { status: next.result?.status ?? null, input: next.result?.input ?? "absent", verbatim: last === undefined ? null : last.texts.join("") === typed, reader: readerOf(h), recordedChars: last === undefined ? null : [...last.texts.join("")].length });
  } finally { await finish(second); }
}

// ---------------------------------------------------------------------------------------------------------------------
// READ: the question after an A -> B -> A relay (the approval agent's D2)
// ---------------------------------------------------------------------------------------------------------------------

async function readOnce(h: Rig, partner: string, variant: "nominated" | "indirect"): Promise<void> {
  const first = await begin(h), stored = await claudeStored(h, first);
  let number = 0, checkpoint: string;
  try {
    const base = await turn(h, first, "请随便想一个五位数（不要用 12345、11111 这类有规律的数），只回复这个数字本身，不要调用任何工具，不要别的字。", "READ " + variant + ": the first Turn");
    const made = digitsIn(base.reply);
    if (made.length !== 1) { h.find("READ", variant, "unverified", "the first Turn did not answer exactly one five-digit number", { digits: made.length, status: base.result?.status ?? null }); return; }
    number = Number(made[0]); checkpoint = (await first.control.checkpoint?.()) ?? first.id;
    // The first request of a fresh conversation with a tiny prompt: what the Harness reads before the user says anything (the fixed prefix, plus a few dozen tokens).
    if (h.facts.firstRequestTokens === undefined) h.facts.firstRequestTokens = { input: base.usage.turn.input ?? null, cachedInput: base.usage.turn.cachedInput ?? null, cacheWrite: base.usage.turn.cacheWrite ?? null, total: base.usage.turn.total ?? null, contextUsed: base.usage.context?.used ?? null, contextSize: base.usage.context?.size ?? null };
  } finally { await first.conn.close().catch(() => undefined); }
  const question = variant === "nominated" ? displayName(partner) + " 刚才回复了哪个数字？只回复那个数字本身，不要调用任何工具，不要别的字。" : "另一个 Harness 刚才回复了哪个数字？只回复那个数字本身，不要调用任何工具，不要别的字。";
  const built = deltaPacket(h.harnessId, partner, number, question), second = await begin(h, checkpoint);
  let delivered: Record<string, unknown> = { reader: readerOf(h) }, answer: TurnRecord;
  try {
    answer = await turn(h, second, built.turn, "READ " + variant + ": the delta Turn");
    const rec = await recordOf(h, second, stored);
    if (rec !== null) delivered = { ...delivered, ...placementFacts(h, entryOf(rec, built), built) };
  } finally { await second.conn.close().catch(() => undefined); }
  if (readerOf(h) === "replay") {
    const rec = await replayAfter(h, checkpoint);
    if (rec !== null) delivered = { ...delivered, ...placementFacts(h, entryOf(rec, built), built) };
  }
  const said = digitsIn(answer.reply), knowsPartner = said.includes(String(number + 1)), saidOwn = said.includes(String(number)), model = h.model ?? (h.facts.model as string | null) ?? null;
  const intact = delivered.found === true && delivered.joinedBy !== undefined && delivered.joinedBy !== "different";
  if (variant === "nominated") {
    h.find("READ", "delivered text equals the native entry", delivered.found === undefined ? "unverified" : intact ? "confirmed" : "refuted", "the sha256 of the text handed to the Driver equals that of the native user entry (the join of its blocks)", { ...delivered, model });
    h.find("READ", "nominated question", answer.result?.status === "completed" && knowsPartner && !saidOwn ? "confirmed" : "refuted", "the question names the other Harness by its display name and the reply is that Harness's number", { model, knowsPartner, saidOwnNumber: saidOwn, status: answer.result?.status ?? null, partner: displayName(partner) });
  } else h.find("READ", "indirect question (observation)", "observed", "the question refers to the other Harness only as 'another Harness' (a weak model answers its own number); recorded as a model observation, not as a check of the relay", { model, knowsPartner, saidOwnNumber: saidOwn, status: answer.result?.status ?? null, delivered: intact });
}
async function probeRead(h: Rig): Promise<void> {
  const partner = h.harnessId === "codex" ? "claude" : "codex";
  for (let round = 0; round < READ_REPEATS; round++) for (const variant of ["nominated", "indirect"] as const) await readOnce(h, partner, variant);
}

// ---------------------------------------------------------------------------------------------------------------------
// P15: zero injection (plain Turns arrive byte for byte)
// ---------------------------------------------------------------------------------------------------------------------

const SHAPES: readonly (readonly [string, string])[] = [
  ["ascii", "Reply with only the word OK. (zero-injection check one)"],
  ["outer spaces", "  Reply with only OK, and keep the two spaces before and after this sentence.  "],
  ["blank lines", "Reply with only OK.\n\n\nTwo blank lines are above this one and a newline follows it.\n"],
  ["tabs", "Reply with only OK.\tA tab sits inside this line.\t"],
  ["U+3000 lead", "　只回复 OK。这一条以一个全角空格开头。"],
  ["CRLF", "Reply with only OK.\r\nThis line follows a Windows line break.\r\n"],
  ["fence and path", "Reply with only OK. Shapes only: ```sh\nls /Users/example/notes\n``` and the path /tmp/example-path."],
  ["emoji and CJK", "只回复 OK。这一条有表情 😀、汉字和组合字符 é。"],
  ["title look-alike", "〔HarnessHub 交接单 relay-aaaaaaaaaaaaaaaaaaaa〕 Reply with only OK. A user typed this look-alike of a title line."],
  ["long line", "Reply with only OK. " + "padding ".repeat(400)],
];
async function probeZero(h: Rig): Promise<void> {
  if (h.harnessId !== "claude" && h.harnessId !== "codex") { h.find("P15", "zero injection", "unverified", "P15 runs on Claude Code and Codex only (ADR-055 §13.3), the two with a native record a probe can read", { reader: readerOf(h) }); return; }
  const open = await begin(h), stored = await claudeStored(h, open), statuses: (string | null)[] = [];
  try {
    for (const [label, text] of SHAPES) { const sent = await turn(h, open, text, "P15: " + label); statuses.push(sent.result?.status ?? null); }
    const rec = await recordOf(h, open, stored);
    if (rec === null) { h.find("P15", "zero injection", "unverified", "the native record cannot be read", { reader: readerOf(h) }); return; }
    const entries = rec.entries.slice(-SHAPES.length);
    const rows = SHAPES.map(([label, text], index) => {
      const entry = entries[index], joined = entry === undefined ? null : entry.texts.join("");
      return { label, identical: joined === text, blocks: entry?.texts.length ?? null, sentChars: [...text].length, recordedChars: joined === null ? null : [...joined].length, sentSha: short(text), recordedSha: joined === null ? null : short(joined), trimmed: joined !== null && joined !== text && joined === text.trim(), crlfChanged: joined !== null && text.includes("\r") && !joined.includes("\r") };
    });
    h.find("P15", "zero injection", rows.every(row => row.identical) && entries.length === SHAPES.length ? "confirmed" : "refuted", "each plain Turn's user entry in the native record equals what was typed, byte for byte (ten shapes, one conversation)",
      { turns: SHAPES.length, userEntriesRead: rec.entries.length, statuses, rows, reader: rec.source });
  } finally { await finish(open); }
}

// ---------------------------------------------------------------------------------------------------------------------
// P14: the endpoint a Harness really honours, against the layers its Driver reads
// ---------------------------------------------------------------------------------------------------------------------

/** The workspace layer file that redirects each Harness's model endpoint to a closed local port, and where it goes. */
const REDIRECTS: Readonly<Record<string, readonly [path: string, text: string]>> = {
  claude: [".claude/settings.json", JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:9" } }) + "\n"],
  codex: [".codex/config.toml", 'openai_base_url = "http://127.0.0.1:9"\n'],
  dsh: [".env", "DEEPSEEK_BASE_URL=http://127.0.0.1:9\n"],
  opencode: ["opencode.json", JSON.stringify({ provider: { opencode: { options: { baseURL: "http://127.0.0.1:9" } } } }) + "\n"],
};
async function probeRedirect(h: Rig): Promise<void> {
  const caps = h.caps, redirect = REDIRECTS[h.harnessId];
  if (caps === null) throw new Error("this Harness has no relay declaration");
  if (redirect === undefined) { h.find("P14", "endpoint layers", "unverified", "no workspace-layer redirect is defined for this Harness", {}); return; }
  // On 2026-11-10 a Codex thread started in a workspace that held `.codex/config.toml` made Codex add that workspace to the user's own
  // ~/.codex/config.toml (a [projects."…"] stanza with trust_level = "trusted"), which the configuration guard caught. Codex's fixture is therefore never
  // written; the others write a file in the private workspace only, and run only when asked for (HH_REAL_PROBE_LAYERS=1).
  if (h.harnessId === "codex") { h.find("P14", "workspace layer honoured by the Harness", "unverified", "not run: a workspace-level .codex/config.toml made Codex record the workspace in the user's own ~/.codex/config.toml (caught by the guard on 2026-11-10); the fixture is no longer written", { incident: "codex-config-touched" }); return; }
  if (process.env.HH_REAL_PROBE_LAYERS !== "1" && !peerMode) { h.find("P14", "workspace layer honoured by the Harness", "unverified", "not run: it writes a project-level configuration file in the private workspace, which a Harness may answer by recording the workspace in its own global configuration; set HH_REAL_PROBE_LAYERS=1 to run it", { optIn: "HH_REAL_PROBE_LAYERS" }); return; }
  const directory = join(h.root, h.harnessId + "-redirect"), file = join(directory, redirect[0]);
  await mkdir(join(file, ".."), { recursive: true }); await writeFile(join(directory, "README.md"), "A scratch workspace for the endpoint layer probe.\n"); await writeFile(file, redirect[1]);
  let open: Open;
  try { open = await begin(h, undefined, directory); }
  catch (error) { h.find("P14", "workspace layer honoured by the Harness", "observed", "the Harness refused to start with the layer file present (the layer is read by the Driver, and the Harness rejects it): recorded as it is", { layer: redirect[0], refused: true, ...failureOf(error) }); return; }
  try {
    const mark = open.control.diagnosticMark?.() ?? 0, stored = await claudeStored(h, open);
    const sent = await turn(h, open, "只回复：好", "P14: a Turn with the workspace layer pointing at a closed port", { limitMs: 45_000, soft: true });
    const tail = stored !== null ? await claudeRecord(h, stored) : null;
    const diagnostics = open.control.diagnosticsSince?.(mark) ?? "", mentions = /127\.0\.0\.1[:\s]*9\b|ECONNREFUSED/u.test(diagnostics);
    const replied = sent.reply.trim().length > 0 && sent.result?.status === "completed";
    h.find("P14", "workspace layer honoured by the Harness", replied ? "refuted" : sent.result?.status === "failed" || sent.timedOut || mentions ? "confirmed" : "observed",
      "with the endpoint set in the workspace layer to a closed local port, the Harness cannot reach its model (the layer is honoured); a normal reply means the layer is ignored (no Driver reads the layer any more: this is what the Harness itself does)",
      { layer: redirect[0], status: sent.result?.status ?? null, error: sent.result?.error?.code ?? sent.failure?.code ?? null, replied, timedOutAfter45s: sent.timedOut, diagnosticsMentionThePort: mentions, transcriptLineTypes: tail?.facts.types ?? null, transcriptSystemSubtypes: tail?.facts.systemSubtypes ?? null });
  } finally { await finish(open); }
}

// ---------------------------------------------------------------------------------------------------------------------
// The gateway Harnesses (written, not run without the owner's release): Hermes and OpenClaw
// ---------------------------------------------------------------------------------------------------------------------

/** Hermes: /title writes no history row (B10), the replay holds every user entry, and /clear's fixed receipt confirms a clear. */
async function probeHermes(h: Rig): Promise<void> {
  const first = await begin(h);
  let checkpoint: string;
  try {
    await turn(h, first, "只回复：好", "HERMES: a first Turn"); checkpoint = (await first.control.checkpoint?.()) ?? first.id;
    await turn(h, first, "只回复：好", "HERMES: a second Turn");
  } finally { await first.conn.close().catch(() => undefined); }
  const before = await begin(h, checkpoint);
  let titled: unknown, rowsBefore: NativeRecord;
  try {
    rowsBefore = replayRecord(h.wire.since(before.wireFrom, before.wireTo), before.id);
    const mark = h.wire.mark;
    try { if (before.control.setTitle === undefined) titled = "no setTitle"; else { await before.control.setTitle(before.id, PUBLIC_TITLE); titled = "accepted"; } } catch (error) { titled = failureOf(error); }
    const sent = h.wire.since(mark).filter(entry => entry.dir === "out" && entry.method === "session/prompt").length;
    h.facts.titlePrompts = sent;
  } finally { await finish(before); }
  const after = await begin(h, checkpoint);
  try {
    const rowsAfter = replayRecord(h.wire.since(after.wireFrom, after.wireTo), after.id);
    h.find("HERMES", "replay completeness", rowsBefore.entries.length === 2 ? "confirmed" : "refuted", "the replay of a resumed session holds one user entry per prompt sent (two)", { entries: rowsBefore.entries.length, otherUpdates: rowsBefore.facts.otherUpdates });
    h.find("HERMES", "/title writes no history row (B10)", titled === "accepted" && rowsAfter.entries.length === rowsBefore.entries.length && rowsAfter.facts.otherUpdates === rowsBefore.facts.otherUpdates ? "confirmed" : "refuted",
      "after /title the replay holds the same user entries and the same other updates as before it (no history row, no gateway turn)", { titled, before: rowsBefore.entries.length, after: rowsAfter.entries.length, otherBefore: rowsBefore.facts.otherUpdates, otherAfter: rowsAfter.facts.otherUpdates, titlePrompts: h.facts.titlePrompts ?? null });
    // The Hub's clear: nothing is sent to the viewer or the gateway, and the gateway's session keeps its history.
    const mark = h.wire.mark, cleared = await turn(h, after, "/clear", "HERMES: /clear (the Hub's)");
    const sentToViewer = h.wire.since(mark).filter(entry => entry.dir === "out" && (entry.method === "session/prompt" || entry.method === "session/close")).length;
    h.find("HERMES", "the Hub's clear", cleared.result?.native?.cleared === true && cleared.result.input === "not_recorded" && sentToViewer === 0 ? "confirmed" : "refuted",
      "/clear is not sent (no prompt, no close), and is reported as native.cleared", { status: cleared.result?.status ?? null, cleared: cleared.result?.native?.cleared ?? null, input: cleared.result?.input ?? "absent", sentToViewer });
  } finally { await finish(after); }
  const kept = await begin(h, checkpoint);
  try {
    const rows = replayRecord(h.wire.since(kept.wireFrom, kept.wireTo), kept.id);
    h.find("HERMES", "the gateway's session keeps its history after the Hub's clear", rows.entries.length === 2 ? "confirmed" : "refuted", "the replay of the old session after the Hub's /clear still holds the two user entries", { entries: rows.entries.length });
  } finally { await finish(kept); }
}
/**
 * OpenClaw: the Hub's clear. `/new` is not sent to the bridge and the Gateway is asked for nothing; the Driver lets go of the
 * session key, so the next open starts a session under a new key. (The Gateway call timing for the check and the incarnation
 * read of `/new`, B7, went with the check from the Driver, the decision log of 2026-11-11.)
 */
async function probeOpenClaw(h: Rig): Promise<void> {
  const open = await begin(h), inner = open.control as unknown as { sessionKey: string | null };
  try {
    await turn(h, open, "只回复：好", "OPENCLAW: a first Turn");
    const key = inner.sessionKey;
    if (key === null) throw new Error("the OpenClaw Driver holds no session key");
    const mark = h.wire.mark, fresh = await turn(h, open, "/new", "OPENCLAW: /new (the Hub's)");
    const sentToBridge = h.wire.since(mark).filter(entry => entry.dir === "out" && (entry.method === "session/prompt" || entry.method === "session/close")).length;
    h.find("OPENCLAW", "the Hub's clear", fresh.result?.native?.cleared === true && fresh.result.input === "not_recorded" && sentToBridge === 0 && inner.sessionKey === null ? "confirmed" : "refuted",
      "/new is not sent (no prompt, no close), is reported as native.cleared, and the Driver holds no session key afterwards", { status: fresh.result?.status ?? null, cleared: fresh.result?.native?.cleared ?? null, input: fresh.result?.input ?? "absent", sentToBridge, keyLetGo: inner.sessionKey === null });
  } finally { await finish(open); }
}

// ---------------------------------------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------------------------------------

async function runHarness(h: Rig): Promise<void> {
  await attempt(h, "CAT", () => probeStatic(h));
  await attempt(h, "EMPTY", () => probeEmpty(h));
  await attempt(h, "P1", () => probePlacement(h));
  // A gateway Harness runs only what its outbound reach was released for: its own probes and the placement round trip.
  if (h.gateway && !peerMode) {
    await attempt(h, h.harnessId === "hermes" ? "HERMES" : "OPENCLAW", () => h.harnessId === "hermes" ? probeHermes(h) : probeOpenClaw(h));
    return;
  }
  await attempt(h, "SLASH", () => probeSlash(h));
  await attempt(h, "P6", () => probeClear(h));
  await attempt(h, "LATE", () => probeLate(h));
  await attempt(h, "P16", () => probeKill(h));
  await attempt(h, "READ", () => probeRead(h));
  await attempt(h, "P15", () => probeZero(h));
  await attempt(h, "P14", () => probeRedirect(h));
  if (h.harnessId === "hermes") await attempt(h, "HERMES", () => probeHermes(h));
  if (h.harnessId === "openclaw") await attempt(h, "OPENCLAW", () => probeOpenClaw(h));
}
/** Claude Code's project directory name for a workspace, as the CLI and its adapter compute it (the realpath, every other character a dash). */
const projectNameOf = (path: string): string => path.normalize("NFC").replace(/[^a-zA-Z0-9]/g, "-");
/**
 * Deletes what the Harnesses wrote for the probes' temporary workspaces: Claude Code's transcript directory of each, and the
 * sessions the probes created where the Harness has a way to delete one (Codex `thread/delete`, ACP `session/delete`).
 */
async function cleanNative(h: Rig): Promise<Record<string, unknown>> {
  const report: Record<string, unknown> = { sessions: h.sessions.size };
  try {
    if (h.harnessId === "claude") {
      const removed: string[] = [];
      for (const directory of h.directories) {
        const name = projectNameOf(await realpath(directory).catch(() => directory));
        if (!name.includes("hh-relay-probe-")) continue;
        await rm(join(h.claudeConfig, "projects", name), { recursive: true, force: true }); removed.push("~/" + name.slice(0, 24) + "…");
      }
      report.transcriptDirectoriesRemoved = removed.length;
    } else if (h.harnessId === "codex" || (h.facts.sessionCapabilities as string[] | undefined)?.includes("delete")) {
      // Codex answers a delete with a notification about the thread, which its Driver accepts only for the thread it holds: so each
      // thread is resumed first and deleted on its own connection. An ACP agent deletes any session on one connection.
      const codex = h.harnessId === "codex", method = codex ? "thread/delete" : "session/delete", key = codex ? "threadId" : "sessionId", failures: unknown[] = [];
      let deleted = 0;
      const deleteOn = async (ids: readonly string[], resume: boolean): Promise<void> => {
        const conn = await h.connect();
        try {
          await conn.control.initialize();
          if (resume) await conn.control.open(h.workspace, h.model, h.options, ids[0]);
          const rpc = (conn.control as unknown as { rpc?: JsonRpcProcess }).rpc;
          if (rpc === undefined) throw new Error("no connection to delete through");
          for (const id of ids) { try { await rpc.request(method, { [key]: id }, 10_000, "reject"); deleted++; } catch (error) { failures.push(failureOf(error)); } }
        } catch (error) { failures.push(failureOf(error)); } finally { await conn.close().catch(() => undefined); }
      };
      if (codex) for (const id of h.sessions) await deleteOn([id], true); else await deleteOn([...h.sessions], false);
      report.deleted = deleted; report.deleteFailures = failures.slice(0, 3); report.method = method;
    } else report.note = "this Harness has no session deletion; what it wrote for the temporary workspaces stays in its own storage";
  } catch (error) { report.failure = failureOf(error); }
  return report;
}

if (probeTargets.length > 0) test("RelayConformance Driver probes: the declared cells of " + probeTargets.join(", ") + " are confirmed, refuted or reported unverified", { timeout: 150 * 60 * 1000 }, async t => {
  assert.ok(evidencePath, "set HH_REAL_EVIDENCE to an ignored evidence file path");
  const known = ["claude", "codex", "opencode", "dsh", "hermes", "openclaw"];
  for (const id of probeTargets) {
    assert.ok(known.includes(id), "unknown Harness for the probes: " + id);
    if (GATEWAY_HARNESSES.includes(id) && !peerMode) assert.ok(gatewayAllowed.includes(id), id + " runs through its own gateway, whose outbound reach the owner has not released: set HH_REAL_PROBE_GATEWAY=" + id + " to run it");
  }
  if (!peerMode) guardTargets(probeTargets);
  const before = peerMode ? null : await snapshot(probeTargets, environment);
  const root = await realpath(await mkdtemp(join(process.env.HH_REAL_TMP ?? tmpdir(), "hh-relay-probe-")));
  const wire = new Wire(); wire.install();
  const app: App | null = peerMode ? null : application(join(root, "data"), () => {}, { installations: realInstallations, workspaceLockRoot: join(root, "locks") });
  const reports: Record<string, unknown>[] = [], rigs: Rig[] = [];
  let header: EvidenceHeader | null = null, guard: GuardCheck | null = null, failure: unknown;
  const startedAt = new Date().toISOString(), script = createHash("sha256").update(await readFile(fileURLToPath(import.meta.url))).digest("hex").slice(0, 16);
  try {
    if (app !== null) header = await evidenceHeader(app, probeTargets, { configuration: await prepareConfiguration({ workspace: root, ...(process.env.HH_REAL_MANIFEST ? { manifestPath: process.env.HH_REAL_MANIFEST } : {}) }) });
    for (const harnessId of probeTargets) {
      const upper = harnessId.toUpperCase(), requested = process.env["HH_REAL_MODEL_" + upper], optionsText = process.env["HH_REAL_OPTIONS_" + upper];
      const options = optionsText === undefined ? undefined : JSON.parse(optionsText) as NativeOptions;
      let workspace: string, connectIn: (workspace: string) => Promise<Conn>, claudeConfig: string, codexHome: string, rigRoot = root;
      if (app !== null) {
        workspace = join(root, harnessId + "-workspace"); await mkdir(workspace); await writeFile(join(workspace, "README.md"), "A scratch workspace for the relay conformance probes. It holds nothing.\n");
        const selections = new Map<string, { readonly configuration: SessionConfiguration; readonly selected: HarnessSelection }>();
        connectIn = async dir => {
          let ready = selections.get(dir);
          if (ready === undefined) {
            const configuration = await prepareConfiguration({ workspace: dir, ...(process.env.HH_REAL_MANIFEST ? { manifestPath: process.env.HH_REAL_MANIFEST } : {}) });
            ready = { configuration, selected: await app.factory.validate({ harnessId, ...(requested === undefined ? {} : { nativeModel: requested }), ...(options === undefined ? {} : { nativeOptions: options }) }, configuration) };
            selections.set(dir, ready);
          }
          const prepared = await app.factory.prepare(ready.selected, ready.configuration, sessionId("session-" + randomUUID()), "probe-" + randomUUID().slice(0, 8));
          return { control: prepared.control, close: () => prepared.close() };
        };
        claudeConfig = environment.values.CLAUDE_CONFIG_DIR ?? join(environment.home, ".claude"); codexHome = environment.values.CODEX_HOME ?? join(environment.home, ".codex");
      } else {
        const fixtures = await import("../fixtures/relay-drivers.js"), peer = await fixtures.peerRoot(t);
        const withTranscript = { ...peer, env: { ...peer.env, RELAY_TRANSCRIPT: peer.env.CLAUDE_CONFIG_DIR!, ...(harnessId === "hermes" ? { RELAY_HERMES: "1" } : {}), ...(harnessId === "openclaw" ? { RELAY_OPENCLAW: "1" } : {}) } };
        workspace = peer.workspace; claudeConfig = peer.env.CLAUDE_CONFIG_DIR!; codexHome = peer.env.CODEX_HOME!; rigRoot = peer.root;
        connectIn = async () => { const control = fixtures.driver(t, harnessId as "claude", withTranscript); return { control, close: () => control.close() }; };
      }
      const rig = new Rig(harnessId, workspace, requested, options, connectIn, claudeConfig, codexHome, rigRoot, wire, PROMPT_CAP);
      rigs.push(rig);
      try { await runHarness(rig); }
      finally {
        const cleanup = peerMode ? { note: "peer mode: nothing was written outside the fixture root" } : await cleanNative(rig);
        reports.push({ harnessId, model: requested ?? (rig.facts.model as string | null) ?? null, options: options === undefined ? null : Object.keys(options), prompts: rig.prompts, promptCap: rig.cap, tokens: rig.tokens, maxTurnTokens: rig.maxTurnTokens, maxTurnMs: Math.round(rig.maxTurnMs),
          costs: rig.costs, facts: rig.facts, findings: rig.findings, turns: rig.turns, cleanup });
        if (evidencePath) await writeFile(evidencePath, JSON.stringify({ mode: peerMode ? "peer self-test (no evidence)" : "driver probes", script, startedAt, header, partial: true, reports }, null, 2) + "\n", { mode: 0o600 });
      }
    }
  } catch (error) { failure = error; }
  finally {
    wire.uninstall();
    if (app !== null) { try { await closeApp(app); } catch (error) { failure ??= error; } }
    if (before !== null) { try { guard = await recheck(before, environment); } catch (error) { failure ??= error; } }
    await writeFile(evidencePath!, JSON.stringify({ mode: peerMode ? "peer self-test (no evidence)" : "driver probes", script, startedAt, finishedAt: new Date().toISOString(), header, harnesses: probeTargets, onlyProbes: probeOnly, guard: guard === null ? null : { unchanged: guard.unchanged, description: describeGuard(guard) },
      failure: failure instanceof Error ? failure.message : failure === undefined ? null : String(failure), reports }, null, 2) + "\n", { mode: 0o600 });
    if (!peerMode) await rm(root, { recursive: true, force: true });
  }
  if (!peerMode) assert.ok(guard?.unchanged, "the user's own configuration must remain unchanged: " + (guard === null ? "not checked" : describeGuard(guard)));
  if (failure !== undefined) throw failure;
  const errors = rigs.flatMap(rig => rig.findings.filter(finding => finding.verdict === "error").map(finding => rig.harnessId + " " + finding.probe));
  assert.deepEqual(errors, [], "probes that failed themselves (their findings are in the evidence)");
});
