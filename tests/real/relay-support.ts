import assert from "node:assert/strict";
import { loadBuiltinCatalog } from "../../src/adapters/catalog.js";
import { application } from "../../src/cli/session-application.js";
import type { PublicRun, SessionId, SessionSnapshot } from "../../src/contracts/session.js";
import { catalogTarget } from "../../src/infrastructure/catalog/platform.js";

/*
 * What the real relay suites share (relay-conformance.real.ts, relay-task.real.ts): driving a Session through the Hub's
 * formal Runtime and reading back, from the Store, what the relay decided around one Turn. Shapes and verdicts only: nothing
 * here returns a packet's text, and `reply` is the one function that returns a Harness's words.
 */

/** A Turn that runs past five minutes is cancelled and fails the run; one that reports more than 150,000 tokens stops it. */
export const TURN_LIMIT_MS = 5 * 60 * 1000, TOKEN_LIMIT = 150_000;
export const list = (value: string | undefined): readonly string[] => (value ?? "").split(",").map(item => item.trim()).filter(Boolean);
/** HH_REAL_MODEL_<ID> picks a Harness's native model, as in the other suites (for example HH_REAL_MODEL_CLAUDE=haiku). */
export function selection(harnessId: string): { readonly harnessId: string; readonly nativeModel?: string } {
  const requested = process.env["HH_REAL_MODEL_" + harnessId.toUpperCase()];
  return { harnessId, ...(requested === undefined ? {} : { nativeModel: requested }) };
}
export type App = ReturnType<typeof application>;
/** What reading a Turn back needs: the Runtime and the Store of a composed application (or of fixtures built from the same classes). */
export type Hub = Pick<App, "runtime" | "store">;
export async function closeApp(app: App): Promise<void> {
  try { await app.runtime.close(); } finally { try { await app.management.shutdown(); } finally { try { await app.providers.shutdown(); } finally { app.store.close(); } } }
}
/** A Harness's display name as the relay packet names it (the built-in catalog, as the application's harnessName reads it). */
export const displayNames = ((): ReadonlyMap<string, string> => {
  try { return new Map(loadBuiltinCatalog(catalogTarget()).map(definition => [definition.id, definition.name])); } catch { return new Map(); }
})();
export function displayName(harnessId: string): string { return displayNames.get(harnessId) ?? harnessId; }
export function reply(state: SessionSnapshot, run: PublicRun): string {
  return state.messages.filter(message => message.runId === run.id && message.role === "assistant").map(message => message.text).join("");
}
export function digits(text: string): readonly string[] { return text.match(/\d{3,}/gu) ?? []; }
/** Every event of the Session, read a page at a time (the Store reads at most 100 at once). */
export function everyEvent(app: Hub, id: SessionId): ReturnType<App["store"]["events"]>[number][] {
  const all: ReturnType<App["store"]["events"]>[number][] = [];
  for (let after = 0; ; ) { const page = app.store.events(id, after, 100); all.push(...page); if (page.length < 100) return all; after = page.at(-1)!.seq; }
}
/** What the Turn's own run.context_prepared recorded of the packet it handed over, or null when it owed nothing. */
export function relayOf(app: Hub, id: SessionId, run: PublicRun): Record<string, unknown> | null {
  const events = everyEvent(app, id), prepared = events.find(event => event.type === "run.context_prepared" && event.data.runId === run.id);
  assert.ok(prepared, "the Turn recorded what it prepared");
  const relay = prepared.data.relay;
  return relay !== null && typeof relay === "object" && !Array.isArray(relay) ? relay as Record<string, unknown> : null;
}
export function tokens(run: PublicRun): number | null {
  const turn = run.usage?.turn;
  return turn === undefined ? null : turn.total ?? ((turn.input ?? 0) + (turn.output ?? 0));
}
/**
 * What the relay did around one Turn, as the Store holds it (slim.md: nothing is read back from the native side): its decision
 * (`decision`: carry, alone or plain, who decided and why), the first-handoff trace (`handoff`), the live evidence the Driver gave
 * (`live`: the input recorded as an event), the native title it set, the delivery row (outcome, evidence E1/E3, reason, whether it
 * was the one automatic resend), what the Driver knew of the input and of the command's effect, every live binding's state
 * afterwards (`epoch`, `mark`, whether a packet is `pending`, `resendAll`) and the milliseconds spent preparing and running.
 * Shapes and verdicts only, never a packet or a reply.
 */
export function ledger(app: Hub, id: SessionId, state: SessionSnapshot, run: PublicRun): Record<string, unknown> {
  const mine = everyEvent(app, id).filter(event => event.data.runId === run.id || event.data.observedInRun === run.id);
  const pick = (type: string) => mine.filter(event => event.type === type).map(event => event.data as Record<string, unknown>);
  const prepared = pick("run.context_prepared")[0], relay = prepared?.relay as Record<string, unknown> | null | undefined, ended = pick("run.ended")[0];
  const row = app.store.relayDeliveries(id).find(delivery => delivery.runId === run.id), timing = run.timing;
  return {
    decision: relay?.decision ?? null, handoff: relay?.handoff ?? null,
    live: pick("relay.input_recorded").map(event => event.live ?? "recorded_event"), title: pick("relay.title_set").map(event => event.outcome ?? event.result ?? "set"),
    input: ended?.input ?? null, contextEffect: ended?.contextEffect ?? null,
    delivery: row === undefined ? null : { outcome: row.outcome.kind, evidence: "evidence" in row.outcome ? row.outcome.evidence : null, reason: "reason" in row.outcome ? row.outcome.reason : null, handoffLogged: row.handoffLogSeq !== null, autoResend: row.autoResend },
    bindings: (state.nativeBindings ?? []).filter(binding => binding.status !== "archived").map(binding => ({ harness: binding.harnessId, status: binding.status, epoch: binding.relay?.epoch ?? null, mark: binding.relay?.mark ?? null,
      pending: binding.relay?.pending != null, resendAll: binding.relay?.resendAll ?? null })),
    prepareMs: timing?.dispatchedAt !== undefined && timing.preparingAt !== undefined ? timing.dispatchedAt - timing.preparingAt : null,
    turnMs: timing?.endedAt !== undefined && timing.dispatchedAt !== undefined ? timing.endedAt - timing.dispatchedAt : null,
  };
}
export function summary(app: Hub, id: SessionId, state: SessionSnapshot, run: PublicRun): Record<string, unknown> {
  const relay = relayOf(app, id, run), text = reply(state, run);
  return { harness: run.selection.harnessId, status: run.status, error: run.error?.code ?? null, carried: run.sourceRunIds.length, digits: digits(text), replyBytes: Buffer.byteLength(text), tokens: tokens(run), ledger: ledger(app, id, state, run),
    relay: relay === null ? null : { kind: relay.kind, language: relay.language, tokens: relay.tokens, budget: relay.budget, complete: relay.complete, tier: relay.tier, items: relay.items, turns: relay.turns, repeat: relay.repeat, redactions: relay.redactions } };
}
