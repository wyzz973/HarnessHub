import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { application } from "../../src/cli/session-application.js";
import type { PublicRun, SessionId, SessionSnapshot } from "../../src/contracts/session.js";
import { prepareConfiguration } from "../../src/infrastructure/session/binding-factory.js";
import { captureNativeEnvironment } from "../../src/infrastructure/session/native-environment.js";
import { describeGuard, evidenceHeader, guardTargets, recheck, snapshot, type EvidenceHeader, type GuardCheck } from "./guard.js";

/**
 * Relay on the user's installed Harnesses (ADR-055, the relay packet on v12): the first Harness makes up a five-digit number, the
 * second is asked for that number plus one, and the first, back on its own native session, is asked what the second answered.
 * The first number exists only in the first Harness's reply (not in the user's words, not in the workspace), so the second can
 * know it only from the relay packet, and the first can know the second's answer only from the delta. What each step expects is
 * computed from the replies actually given, so a model's slip in one step is not taken for a relay failure. No tool is needed. HH_REAL_HARNESSES names
 * the pair (for example "claude,codex") and HH_REAL_MODEL_<ID> a native model; missing prerequisites fail, nothing is a skipped pass. A Turn that runs past five
 * minutes is cancelled and fails the run; one that reports more than 150,000 tokens stops it. Evidence holds statuses, digits,
 * counts and sizes, never checkpoints, environment values, packet text or reply text beyond the digits.
 */
const harnesses = (process.env.HH_REAL_HARNESSES ?? "").split(",").map(value => value.trim()).filter(Boolean);
const evidencePath = process.env.HH_REAL_EVIDENCE;
/** A development manifest (HH_REAL_MANIFEST) names non-official entries, which only the development policy reads (ADR-044). */
const realInstallations = process.env.HH_REAL_MANIFEST ? "any" as const : "official" as const;
const TURN_LIMIT_MS = 5 * 60 * 1000, TOKEN_LIMIT = 150_000;
/** HH_REAL_MODEL_<ID> picks a Harness's native model, as in the other suites (for example HH_REAL_MODEL_CLAUDE=haiku). */
function selection(harnessId: string): { readonly harnessId: string; readonly nativeModel?: string } {
  const requested = process.env["HH_REAL_MODEL_" + harnessId.toUpperCase()];
  return { harnessId, ...(requested === undefined ? {} : { nativeModel: requested }) };
}
/** The user's home and environment as the Harness runs with them; the shared guard (./guard.ts) snapshots its configuration from them. */
const environment = captureNativeEnvironment();
type App = ReturnType<typeof application>;
async function closeApp(app: App): Promise<void> {
  try { await app.runtime.close(); } finally { try { await app.management.shutdown(); } finally { try { await app.providers.shutdown(); } finally { app.store.close(); } } }
}
function reply(state: SessionSnapshot, run: PublicRun): string {
  return state.messages.filter(message => message.runId === run.id && message.role === "assistant").map(message => message.text).join("");
}
function digits(text: string): readonly string[] { return text.match(/\d{3,}/gu) ?? []; }
/** What the Turn's own run.context_prepared recorded of the packet it handed over, or null when it owed nothing. */
function relayOf(app: App, id: SessionId, run: PublicRun): Record<string, unknown> | null {
  const events = app.store.events(id, 0, 100), prepared = events.find(event => event.type === "run.context_prepared" && event.data.runId === run.id);
  assert.ok(prepared, "the Turn recorded what it prepared");
  const relay = prepared.data.relay;
  return relay !== null && typeof relay === "object" && !Array.isArray(relay) ? relay as Record<string, unknown> : null;
}
function tokens(run: PublicRun): number | null {
  const turn = run.usage?.turn;
  return turn === undefined ? null : turn.total ?? ((turn.input ?? 0) + (turn.output ?? 0));
}
function summary(app: App, id: SessionId, state: SessionSnapshot, run: PublicRun): Record<string, unknown> {
  const relay = relayOf(app, id, run), text = reply(state, run);
  return { harness: run.selection.harnessId, status: run.status, error: run.error?.code ?? null, carried: run.sourceRunIds.length, digits: digits(text), replyBytes: Buffer.byteLength(text), tokens: tokens(run),
    relay: relay === null ? null : { kind: relay.kind, language: relay.language, tokens: relay.tokens, budget: relay.budget, complete: relay.complete, units: relay.units, userWords: relay.userWords, redactions: relay.redactions } };
}

test("installed Harnesses hand a conversation over and back: the second knows the first's answer, the first knows the second's", { timeout: 20 * 60 * 1000 }, async () => {
  assert.equal(harnesses.length, 2, "set HH_REAL_HARNESSES to two installed Harness identities, for example claude,codex");
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
      const state = app.runtime.read(id), run = state.runs.at(-1)!;
      turns.push(summary(app, id, state, run));
      const used = tokens(run);
      if (used !== null && used > TOKEN_LIMIT) throw new Error("Turn " + turns.length + " reported " + used + " tokens, past the " + TOKEN_LIMIT + " stop line");
      return { state, run, relay: relayOf(app, id, run) };
    };
    const switchTo = async (harnessId: string): Promise<void> => {
      app.runtime.switch(id, selection(harnessId), "switch-" + randomUUID()); await settle("the switch to " + harnessId);
      assert.equal(app.runtime.read(id).selection.harnessId, harnessId, "the switch to " + harnessId + " took effect");
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
    const three = await ask("另一个 Harness 刚才回复了哪个数字？只回复那个数字本身，不要调用任何工具，不要别的字。");
    assert.equal(three.run.status, "completed", "the first Harness's return turn completes: " + JSON.stringify(three.run.error));
    assert.ok(three.run.sourceRunIds.length > 0, "the return turn carried what happened while the first Harness was away");
    assert.equal(three.relay?.kind, "delta", "back on its own native session, the first Harness receives only what it missed");
    // The second's answer differs from the first's own number, so the first can know it only from the delta.
    assert.ok(says(reply(three.state, three.run)), "back on its own native session, the first Harness knows the second's answer from the delta");
    assert.ok(three.state.nativeBindings?.some(binding => binding.harnessId === first && binding.status === "ready"), "the first Harness's native binding is ready again");
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
