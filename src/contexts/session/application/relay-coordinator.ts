import { createHash, createHmac, randomBytes } from "node:crypto";
import type { CommandClass, ContextEffect } from "../../../contracts/control.js";
import {
  CONTEXT_EFFECTS, EPHEMERAL_KEY_ID, ITEM_KINDS, RELAY_MAX_RUNS, RELAY_MAX_SEQ, RELAY_PREF_DEFAULTS, RelayError, hmacDigest, parseExecutedOn, redactionTag, relayPacketId,
  type BindingRelayState, type ContinuityLevel, type DeliveryRecord, type ExecutedOn, type Fingerprint, type HmacDigest, type RedactionTag, type RelayAttention, type RelayCapabilities, type RelayDecision,
  type RelayDeliveryWrite, type RelayIndexRow, type RelayKeyPort, type RelayPacket, type RelayPacketId, type RelayPrefKey, type RunRelay, type RunRelayRequest, type SourceRange,
} from "../../../contracts/relay.js";
import { SessionError, type PublicRun, type RunId, type SessionEvent, type SessionId, type SessionSnapshot } from "../../../contracts/session.js";
import { commandOutcome, dispatched } from "../domain/relay/advance.js";
import { commandTurnEvent, nothingOwed, owed, settledOutcome, step, type PacketRef, type RelayFact, type RelayEvent, type TurnPlan } from "../domain/relay/delivery.js";
import type { RelayRecord } from "../domain/relay/packet.js";
import { terminal } from "../domain/state.js";

/**
 * The relay coordinator (ADR-055 §3.2, §6.1, §7; slim.md): what the Runtime asks of the relay at each point of a Turn, kept out of
 * runtime.ts so that it only calls these hooks. It holds the facts a binding owes and the delivery rows (the read path), the
 * request's relay choice, the choice of what a Turn sends and how that is recorded (`decisionRecord`), the packet manifest and
 * delivery row a carrying Turn writes before it is dispatched, E1 (`recordedStep`), the settlement written with `run.ended`
 * (`settleTurn`) and what a binding asks the user to look at (`attentionOf`). The state machine itself is domain/relay/delivery.ts.
 * Every function here is synchronous and pure over what it is given, except the ledger, which pages the Session's events through
 * the reader it was built with; the Runtime does the I/O (the Driver, the store) and commits.
 *
 * What the relay never does (the owner's decisions of 2026-11-10 and 2026-11-11): refuse or fail a message because of the history
 * it would carry. A matter of the packet alone — it cannot be prepared, it does not fit, the record could not be recovered, an
 * unconfirmed packet has had its one resend — sends the input as typed and says why in the Run's `relay.decision`. Only a packet
 * the user asked for ("attach") that cannot be prepared fails the Run, with RELAY_PREPARE_FAILED.
 */

// ---------------------------------------------------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------------------------------------------------

/** A Driver's relay declaration as the coordinator reads it; the most conservative value wherever a Driver declares none. */
export interface RelayDeclaration {
  /** Whether the Driver declares anything at all. */
  readonly declared: boolean;
  /** Whether a normal end of a Turn means the input was received. */
  readonly successProvesRecorded: boolean;
  /**
   * Whether a send to this Driver can ever be confirmed: it reports the input as an event (`live`), or a completed Turn proves
   * the input recorded. False for a Driver that declares nothing: its packets are sent once and never sent again by themselves.
   */
  readonly canConfirm: boolean;
  readonly execution: "process" | "gateway";
  /** How its packets go: as a text block of their own, or flattened into one text with the user's words (singleText). */
  readonly channel: DeliveryRecord["channel"];
  readonly capabilities: RelayCapabilities | null;
}
/**
 * The declaration of `capabilities`, or the most conservative one without it: no proof of delivery from success, a gateway's
 * execution (no "continue the original session" after an unknown Turn).
 */
export function relayDeclaration(capabilities: RelayCapabilities | null | undefined): RelayDeclaration {
  if (capabilities === null || capabilities === undefined) return { declared: false, successProvesRecorded: false, canConfirm: false, execution: "gateway", channel: "single_text", capabilities: null };
  return { declared: true, successProvesRecorded: capabilities.delivery.successProvesRecorded, canConfirm: capabilities.delivery.live !== "none" || capabilities.delivery.successProvesRecorded,
    execution: capabilities.execution, channel: capabilities.placement.parts === "multiple" ? "text_block" : "single_text", capabilities };
}

// ---------------------------------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The relay's one setting with its default applied: `attach` "auto" hands the earlier conversation to a Harness that was not
 * in it by itself; "off" does not (the user may still attach it to a message by choosing so).
 */
export interface RelaySettings { readonly attach: "auto" | "off" }
/** The settings of a Store's stored preferences (RelayLogPort.relayPrefs): a missing or unreadable value is the default. */
export function relaySettings(prefs: Readonly<Partial<Record<RelayPrefKey, string>>>): RelaySettings {
  return { attach: (prefs["relay.attach"] ?? RELAY_PREF_DEFAULTS["relay.attach"]) === "off" ? "off" : "auto" };
}

// ---------------------------------------------------------------------------------------------------------------------
// The request's choice
// ---------------------------------------------------------------------------------------------------------------------

/**
 * What a request chose for the relay: `attach` "none" sends the input alone ("只发这条消息"); "full" attaches the whole history
 * once, below a clear boundary too ("附上交接单"). Anything else is no choice.
 */
export interface RelayChoices { readonly attach?: "full" | "none" }
/** The request's relay choice, checked; undefined when it makes none ("auto" is none). INVALID_INPUT for anything else. */
export function parseRelayChoices(value: unknown): RelayChoices | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new SessionError("INVALID_INPUT", "relay choices must be an object");
  const item = value as Readonly<Record<string, unknown>>;
  if (Object.keys(item).some(key => key !== "attach")) throw new SessionError("INVALID_INPUT", "unsupported relay choice");
  if (item.attach !== undefined && item.attach !== "auto" && item.attach !== "full" && item.attach !== "none") throw new SessionError("INVALID_INPUT", "relay attach must be auto, full or none");
  return item.attach === "full" || item.attach === "none" ? { attach: item.attach } : undefined;
}
/** Whether the request asked for the history itself: what the user chose this way is never rewritten, so when it cannot be done the Run fails. */
export function explicitChoice(choices: RelayChoices): boolean { return choices.attach === "full"; }
/** PublicRun.relayRequest for a request's choice: the choice and its HMAC as canonical JSON under the Session's subkey; undefined when it made none. */
export function runRelayRequest(session: SessionId, choices: RelayChoices | undefined, keys: RelayKeyPort): RunRelayRequest | undefined {
  if (choices === undefined) return undefined;
  return { ...(choices.attach === undefined ? {} : { attach: choices.attach }), fingerprint: keys.requestFingerprint(session, JSON.stringify({ attach: choices.attach ?? null })) };
}
/** The choices a `message.accepted` event recorded (its `relay`); none when it recorded none or something else. */
export function acceptedChoices(data: Readonly<Record<string, unknown>> | undefined): RelayChoices {
  try { return parseRelayChoices(data?.relay) ?? {}; } catch { return {}; }
}

// ---------------------------------------------------------------------------------------------------------------------
// The read path: facts
// ---------------------------------------------------------------------------------------------------------------------

type EventReader = (id: SessionId, afterSeq: number, limit: number) => readonly SessionEvent[];
/**
 * The public facts of each Session as its events place them: the fact seq of each finished Run (its `run.ended`, or the
 * `session.recovered` that ended it) and the Runs that were native commands, with the effect each had on the native context (the
 * one its end settled, else the one it was read with): a command is a fact only when it entered the context like a message (keep).
 * Events are append-only, so each Session's are read once, from where the last read stopped; a new owner reads them again from the start.
 */
export class RelayLedger {
  private readonly sessions = new Map<SessionId, { after: number; readonly ended: Map<string, number>; readonly commands: Map<string, ContextEffect | undefined>; readonly settled: Map<string, ContextEffect> }>();
  constructor(private readonly events: EventReader) {}
  private scan(state: SessionSnapshot): { readonly ended: ReadonlyMap<string, number>; readonly commands: ReadonlyMap<string, ContextEffect | undefined>; readonly settled: ReadonlyMap<string, ContextEffect> } {
    let known = this.sessions.get(state.id);
    if (known === undefined || known.after > state.lastSeq) { known = { after: 0, ended: new Map(), commands: new Map(), settled: new Map() }; this.sessions.set(state.id, known); }
    while (known.after < state.lastSeq) {
      const page = this.events(state.id, known.after, 100);
      if (!page.length) break;
      for (const item of page) {
        const data = item.data, run = typeof data.runId === "string" ? data.runId : null;
        if (item.type === "run.ended" && run !== null && !known.ended.has(run)) {
          known.ended.set(run, item.seq);
          const effect = contextEffectOf(data.contextEffect);
          if (effect !== undefined) known.settled.set(run, effect);
        }
        else if (item.type === "run.native_command" && run !== null) known.commands.set(run, contextEffectOf(data.contextEffect));
        else if (item.type === "session.recovered")
          for (const id of [...strings(data.unknownRunIds), ...strings(data.cancelledRunIds)]) if (!known.ended.has(id)) known.ended.set(id, item.seq);
      }
      known.after = page.at(-1)!.seq;
    }
    return known;
  }
  /** The fact seq of a finished Run, when its events place it. */
  endedSeq(state: SessionSnapshot, run: RunId): number | undefined { return this.scan(state).ended.get(run); }
  /**
   * The public facts of the Session foreign to `binding` (its Harness control in its current native epoch): each finished,
   * dispatched Run that did not run there, with its fact seq and where it ran — the Run's own `relay.executedOn` (v13), else the
   * migration's index row (`index`), else null, which makes it foreign to every binding (a conservative reading: it may be sent again,
   * never lost). A native command is a fact when it entered the context like a message (a skill, a custom command: the effect keep) and
   * none when it did not (it left the history alone, compacted, rewound or cleared it, had an unknown effect, or never ran): the others
   * put nothing into the conversation, or were settled by the binding that ran them. Only the facts a binding may owe are read: the events
   * are paged only when there is a foreign Run to place, so a single-Harness conversation reads none.
   */
  facts(state: SessionSnapshot, index: readonly RelayIndexRow[], binding: { readonly harnessId: string; readonly controlId: string; readonly nativeEpoch: number }): readonly RelayFact[] {
    const rows = new Map<string, Readonly<Record<string, unknown>>>();
    for (const row of index) if (!rows.has(row.runId)) rows.set(row.runId, row.index);
    const candidates: { readonly run: PublicRun; readonly row: Readonly<Record<string, unknown>> | undefined; readonly executedOn: ExecutedOn | null }[] = [];
    for (const run of state.runs) {
      if (!terminal(run.status) || !dispatched(run)) continue;
      const row = rows.get(run.id);
      // A Run from before v13 that the migration found to be a command (its effect is in its index row) is a fact only when it kept.
      if (run.relay === undefined && row?.commandEffect != null && row.commandEffect !== "keep") continue;
      const executedOn = run.relay !== undefined ? run.relay.executedOn : executedOf(row?.executedOn);
      if (executedOn !== null && executedOn.harnessId === binding.harnessId && executedOn.controlId === binding.controlId && executedOn.nativeEpoch === binding.nativeEpoch) continue;
      candidates.push({ run, row, executedOn });
    }
    if (candidates.length === 0) return [];
    const scanned = this.scan(state), facts: RelayFact[] = [];
    for (const { run, row, executedOn } of candidates) {
      // A command Turn is a fact only when it kept: its effect is the index row's for a Run from before v13, else the one its end settled
      // (a keep that never ran is none), else the one it was read with (a Turn that a recovery ended).
      if (scanned.commands.has(run.id) && (run.relay === undefined ? row?.commandEffect : scanned.settled.get(run.id) ?? scanned.commands.get(run.id)) !== "keep") continue;
      const indexed = typeof row?.seq === "number" && Number.isSafeInteger(row.seq) && row.seq >= 0 && row.seq <= RELAY_MAX_SEQ ? row.seq : undefined;
      facts.push({ runId: run.id, seq: scanned.ended.get(run.id) ?? indexed ?? state.lastSeq, executedOn });
    }
    return facts;
  }
  forget(id: SessionId): void { this.sessions.delete(id); }
}
function strings(value: unknown): readonly string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
/** A stored context effect, or undefined for anything else. */
function contextEffectOf(value: unknown): ContextEffect | undefined { return typeof value === "string" && (CONTEXT_EFFECTS as readonly string[]).includes(value) ? value as ContextEffect : undefined; }
function executedOf(value: unknown): ExecutedOn | null {
  if (value === null || value === undefined) return null;
  try { return parseExecutedOn(value); } catch { return null; }
}
/**
 * Whether a binding's native session holds nothing the relay counts on it holding, so that a new native session may take its place
 * when its Driver refuses to open it as a session it does not have: nothing known (mark −1), nothing pending, never dispatched
 * into (`throughRunId`), and no Turn of its Harness control dispatched in an epoch it holds, nor one the relay cannot place. A
 * binding that opens a new native session anyway (opensNew) resumes nothing, so it is never asked.
 */
export function holdsNothing(state: SessionSnapshot, binding: { readonly harnessId: string; readonly controlId: string; readonly throughRunId: RunId | null; readonly opensNew?: true; readonly relay?: BindingRelayState }): boolean {
  const relay = binding.relay;
  if (relay === undefined || relay.mark >= 0 || relay.pending !== null || relay.resendAll || binding.throughRunId !== null || binding.opensNew === true) return false;
  return !state.runs.some(run => run.selection.provider === undefined && run.selection.harnessId === binding.harnessId && run.selection.controlId === binding.controlId && dispatched(run)
    && (run.relay?.executedOn == null || run.relay.executedOn.nativeEpoch >= relay.epoch));
}
/**
 * Whether a binding's native session holds exactly the conversation through `through` (ADR-055 §7.5), for a native fork: `through`
 * ran in its current native epoch, nothing waits for confirmation or is to be sent again, and nothing foreign up to `through`'s
 * fact (`endedSeq`, the seq of its end) is owed to it. A binding without relay state is never exact. `endedSeq` and `facts` (those
 * foreign to it) are read only when the cheaper conditions hold: they page the Session's events.
 */
export function nativeExactAt(state: SessionSnapshot, binding: { readonly harnessId: string; readonly controlId: string; readonly relay?: BindingRelayState }, through: PublicRun, endedSeq: () => number | undefined,
    facts: (on: { readonly harnessId: string; readonly controlId: string; readonly nativeEpoch: number }) => readonly RelayFact[]): boolean {
  const relay = binding.relay;
  if (relay === undefined || relay.pending !== null || relay.resendAll || through.relay?.executedOn?.nativeEpoch !== relay.epoch) return false;
  const seq = endedSeq();
  if (seq === undefined) return false;
  const need = owed(relay, binding.harnessId, binding.controlId, facts({ harnessId: binding.harnessId, controlId: binding.controlId, nativeEpoch: relay.epoch }).filter(fact => fact.seq <= seq), { originHistory: (state.origin?.history.length ?? 0) > 0 });
  return nothingOwed(need);
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading an input
// ---------------------------------------------------------------------------------------------------------------------

/**
 * How a Driver that declares nothing (WorkBuddy, Pi: `relayCapabilities` absent) is taken to read an input: it cannot say what its
 * native side reads as a command — its catalog, when it has one, may not list a command the native side runs — so a first
 * character that is a slash makes a command of unknown effect, whatever the catalog says: the input goes as typed and carries
 * nothing (a packet put before it would turn the command into words), and what is owed waits for the next ordinary message.
 * Null for any other input.
 */
export function undeclaredReading(text: string): Extract<CommandClass, { kind: "command" }> | null {
  if (!text.startsWith("/")) return null;
  const name = text.slice(1).split(/\s/u)[0]!;
  return name === "" ? null : { kind: "command", name, args: text.slice(1 + name.length).trim(), effect: "unknown" };
}

// ---------------------------------------------------------------------------------------------------------------------
// What the Turn sends, and how that is recorded
// ---------------------------------------------------------------------------------------------------------------------

/** The causes a decision of the policy answers (contracts/relay.ts DECISION_CAUSES). */
export type DecisionCause = NonNullable<RelayDecision["cause"]>;
/**
 * What a content Turn does with what its binding is owed: the domain's plan (domain/relay/delivery.ts `plan`), or an input the
 * policy sends alone because something concerning the packet could not be done (`aloneFor`).
 */
export type TurnDecision = Exclude<TurnPlan, { readonly kind: "alone" }> | { readonly kind: "alone"; readonly by: "user" | "policy"; readonly cause?: DecisionCause; readonly reason?: string };
/** The policy's send alone for something concerning the packet (`reason` for a failed preparation or a limit). */
export function aloneFor(cause: DecisionCause, reason?: string): TurnDecision { return { kind: "alone", by: "policy", cause, ...(reason === undefined ? {} : { reason }) }; }
/**
 * What a Turn records of its decision in `run.context_prepared.data.relay.decision` (contracts RelayDecision): the kind, who decided
 * and what for. An ordinary Turn that owes nothing records none (it has no `relay` at all); one the user asked to attach the
 * history to, with none to attach, says the user asked. A packet that sent a pending one again says how (`resend`).
 */
export function decisionRecord(decision: TurnDecision | null): RelayDecision | null {
  if (decision === null) return null;
  switch (decision.kind) {
    case "carry": return { kind: "carry", by: decision.by, ...(decision.cause === undefined ? {} : { cause: decision.cause }), ...(decision.resend === null ? {} : { resend: decision.resend }) };
    case "alone": return { kind: "alone", by: decision.by, ...(decision.cause === undefined ? {} : { cause: decision.cause }), ...(decision.reason === undefined ? {} : { reason: decision.reason }) };
    case "plain": return decision.nothingToAttach ? { kind: "plain", by: "user" } : null;
  }
}
/**
 * Whether a failure concerns the packet only, so that the policy sends the input alone instead of failing the Run: the cause it
 * is recorded under, and the reason. Null when it does not: a request that asked for the history itself (it fails, the draft stays),
 * and a failure of anything but the packet (ownership, the Store, a cancellation).
 */
export function policyAloneOf(error: unknown, choices: RelayChoices): { readonly cause: DecisionCause; readonly reason?: string } | null {
  if (explicitChoice(choices)) return null;
  if (error instanceof RelayError) return error.reason === "input_limit" ? { cause: "input_limit", reason: error.reason } : { cause: "prepare_failed", reason: error.reason };
  // The known secrets could not be read (relaySecretsOf): no packet can be redacted, so none is sent (fail closed).
  if (error instanceof SessionError && error.code === "RELAY_PREPARE_FAILED") return { cause: "prepare_failed", reason: "redaction_failed" };
  return null;
}
/** The error a packet the user asked for fails the Run with when it does not fit the target (even the smallest, or the placed Turn over its bound). */
export function inputLimit(target: { readonly harnessId: string; readonly controlId: string }): RelayError {
  return new RelayError({ code: "RELAY_PREPARE_FAILED", reason: "input_limit" }, "这条消息和交接单合起来超过了这个 Harness 能收的大小。可以只发这条消息（不附交接单），或把消息拆短；这条消息没有发出，草稿已保留。",
    { harnessId: target.harnessId, controlId: target.controlId });
}

/** What `attentionOf` reads of one binding. */
export interface AttentionInput {
  readonly relay: BindingRelayState;
  /** How many of the conversation's Turns the binding owes now (owed()): the foreign facts above its mark and floor, and the Turns of the history the Session started from when that is owed too. */
  readonly owedRuns: number;
  /** How many Turns attaching the whole history would carry, when the conversation was cleared and the binding's new native session has run nothing yet; 0 otherwise. */
  readonly attachableRuns: number;
}
/**
 * What a binding asks the user to look at (`GET …/relay` gives it per binding), from the state of the conversation as it is now: a
 * packet sent and not confirmed, or a conversation cleared whose earlier part can still be attached to the next message. A banner
 * stays while its cause does and goes the moment it ends. Never a block: the next input goes anyway. Null when the binding needs
 * nothing. `key` names the episode: the same cause within one wait is the same key, so a banner shown once and closed does not come back.
 * `counts.packets` is how many times the unconfirmed packet went and nothing confirmed it: once, or twice when the one automatic
 * resend was spent (the page says "sent twice" from it).
 */
export function attentionOf(input: AttentionInput): RelayAttention | null {
  const { relay } = input;
  if (relay.pending !== null) return { cause: "delivery_unconfirmed", options: ["attach_full"], counts: { runs: input.owedRuns, packets: 1 + relay.pending.autoResends }, key: "delivery_unconfirmed:" + relay.pending.packetId };
  if (input.attachableRuns > 0) return { cause: "attach_available", options: ["attach_full"], counts: { runs: input.attachableRuns, packets: 0 }, key: "attach_available:" + relay.epoch };
  return null;
}
/** The Runs of what is owed, in conversation order, each a finished fact whose input came before the current one's. */
export function needRuns(state: SessionSnapshot, current: PublicRun, need: { readonly facts: readonly RelayFact[] }): readonly RunId[] {
  const seqOf = (run: PublicRun) => state.messages.find(message => message.id === run.userMessageId)?.seq ?? Number.MAX_SAFE_INTEGER;
  const before = seqOf(current), owedRuns = new Set<string>(need.facts.map(fact => fact.runId));
  return state.runs.filter(run => owedRuns.has(run.id) && run.id !== current.id && terminal(run.status) && seqOf(run) < before).map(run => run.id);
}
const NO_RANGE: SourceRange = { fromSeq: 0, throughSeq: 0, fromRun: 0, throughRun: 0 };
/** The facts of `need` its Runs cover (the ones a packet of `runs` carries), and their range (§4 SourceRange). */
export function rangeOf(state: SessionSnapshot, need: { readonly facts: readonly RelayFact[]; readonly origin: boolean }, runs: readonly RunId[]): SourceRange {
  const carried = need.facts.filter(fact => runs.includes(fact.runId)), index = (run: RunId) => state.runs.findIndex(row => row.id === run);
  const seqs = [...carried.map(fact => fact.seq), ...(need.origin ? [0] : [])], indexes = carried.map(fact => index(fact.runId)).filter(value => value >= 0);
  if (seqs.length === 0) return NO_RANGE;
  return { fromSeq: Math.min(...seqs), throughSeq: Math.max(...seqs), fromRun: indexes.length ? Math.min(...indexes) : 0, throughRun: indexes.length ? Math.max(...indexes) : 0 };
}
/** The packet a range makes, as the state machine names it. */
export function packetRef(id: RelayPacketId, range: SourceRange): PacketRef { return { id, fromSeq: range.fromSeq, throughSeq: range.throughSeq }; }
/**
 * The snapshot the packet renderer reads (packet.ts decides between a whole packet and an update by the target binding's native
 * position): an update goes only to a native session known to hold part of the conversation, so the position is shown as none when
 * the packet must be a whole one (`whole`: the binding holds nothing, or the packet carries everything again).
 */
export function renderView(state: SessionSnapshot, harnessId: string, controlId: string, whole: boolean): SessionSnapshot {
  if (!whole) return state;
  return { ...state, ...(state.nativeBindings === undefined ? {} : { nativeBindings: state.nativeBindings.map(binding =>
    binding.harnessId === harnessId && binding.controlId === controlId && binding.status !== "archived" ? { ...binding, throughRunId: null } : binding) }) };
}
/** The relay policy the v13 manifest names: the contract's `relay/<n>`; the renderer's own version stays in `run.context_prepared`. */
export const MANIFEST_POLICY = "relay/1" as const;
/**
 * A packet manifest (§4 RelayPacket) for a packet the renderer made (its record and text): who it went to, the facts and Runs it
 * carries, what it left out by kind (the record's ledger), how it was budgeted and what is known of its text. The Store checks it
 * with the text in the same transaction.
 */
export function packetManifest(input: { readonly state: SessionSnapshot; readonly run: PublicRun; readonly relay: BindingRelayState; readonly record: RelayRecord; readonly body: string;
    readonly range: SourceRange; readonly runs: readonly RunId[]; readonly attachOverride: boolean; readonly supersedes: RelayPacketId | null;
    readonly firstLineOmitted: RelayPacket["firstLineOmitted"]; readonly clamped?: readonly ("window" | "input_limit")[] }): RelayPacket {
  const { state, run, record } = input;
  const indexes = input.runs.map(id => state.runs.findIndex(row => row.id === id)).filter(index => index >= 0);
  const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex") as Fingerprint;
  return {
    id: relayPacketId(record.packetId), kind: record.kind, tier: record.tier,
    target: { harnessId: run.selection.harnessId, controlId: run.selection.controlId, model: run.selection.nativeModel ?? null, nativeEpoch: input.relay.epoch },
    range: input.range, runs: indexes.slice(0, RELAY_MAX_RUNS), supersedes: input.supersedes, policyVersion: MANIFEST_POLICY, language: record.language, repeat: record.repeat,
    attachOverride: input.attachOverride, firstLineOmitted: input.firstLineOmitted, redactions: record.redactions,
    body: { sha256: sha(input.body), bytes: Buffer.byteLength(input.body, "utf8"), estTokens: record.tokens },
    budget: { capTokens: record.budget.cap, window: record.budget.window, windowSource: record.budget.windowSource, clampedBy: [...new Set(input.clamped ?? [])] },
    omissions: ITEM_KINDS.flatMap(kind => record.items[kind].omitted > 0 ? [{ kind, count: record.items[kind].omitted }] : []),
  };
}
/** How a Turn continued its context (§12.2), for its `relay`. */
export function continuityOf(decision: TurnDecision | null, record: RelayRecord | null, runs: number): ContinuityLevel {
  if (decision?.kind !== "carry" || record === null) return { kind: "native_resume" };
  return record.kind === "delta" ? { kind: "native_resume_delta", tier: record.tier, runs: Math.max(1, Math.min(RELAY_MAX_RUNS, runs)) } : { kind: "rehydrate", tier: record.tier, complete: record.complete };
}
export function runRelayOf(packet: RelayPacket | null, continuity: ContinuityLevel, executedOn: ExecutedOn | null): RunRelay {
  return { packetId: packet?.id ?? null, kind: packet === null ? null : packet.kind, continuity, executedOn };
}
/**
 * The keyed digests of a Runtime composed without the installation's relay key (SessionRuntimeOptions.relayKeys; the Gateway's
 * own entries always give one): HMACs under a key made for this owner and never kept, with a subkey per Session as the
 * installation key derives them, so the rows hold nothing anyone can check a guessed input against; they identify nothing across
 * owners either. Their rows name the reserved key identity EPHEMERAL_KEY_ID: no reader can check them.
 */
export class UnkeptRelayKeys implements RelayKeyPort {
  readonly #key = randomBytes(32);
  readonly keyId = EPHEMERAL_KEY_ID;
  private subkey(session: SessionId): Buffer { return createHmac("sha256", this.#key).update("relay-tag/1\0" + session, "utf8").digest(); }
  inputHmac(session: SessionId, text: string): HmacDigest { return hmacDigest(createHmac("sha256", this.subkey(session)).update("input\0" + text, "utf8").digest("hex")); }
  setTag(session: SessionId, secrets: readonly string[]): RedactionTag {
    const hmac = createHmac("sha256", this.subkey(session)).update("secret-set\0", "utf8");
    for (const value of [...new Set(secrets)].sort()) hmac.update(value + "\0", "utf8");
    return redactionTag(hmac.digest("hex").slice(0, 8));
  }
  requestFingerprint(session: SessionId, canonical: string): HmacDigest { return hmacDigest(createHmac("sha256", this.subkey(session)).update("request\0" + canonical, "utf8").digest("hex")); }
}
/** The delivery row inserted with a carrying Turn (§4, §6.1): in flight, with the handoff log row it rests on and whether it is the one automatic resend. */
export function deliveryRow(input: { readonly runId: RunId; readonly packetId: RelayPacketId; readonly declaration: RelayDeclaration; readonly autoResend: boolean;
    readonly inputHmac: DeliveryRecord["inputHmac"]; readonly setTag: DeliveryRecord["redaction"]["setHmac"]; readonly rulesVersion: string; readonly keyId: string;
    /** The handoff log row of the first handoff to the target's Harness. */
    readonly handoffLogSeq: number | null }): DeliveryRecord {
  return { runId: input.runId, packetId: input.packetId, channel: input.declaration.channel, outcome: { kind: "in_flight" }, handoffLogSeq: input.handoffLogSeq, inputHmac: input.inputHmac,
    redaction: { rulesVersion: input.rulesVersion.slice(0, 64), keyId: input.keyId, setHmac: input.setTag }, autoResend: input.autoResend };
}

// ---------------------------------------------------------------------------------------------------------------------
// E1 and the settlement
// ---------------------------------------------------------------------------------------------------------------------

/** The packet a carrying Turn sent, as its settlement needs it. */
export interface CarriedTurn {
  readonly runId: RunId;
  readonly packet: PacketRef;
  /** The packet was the one automatic resend of the binding's pending packet. */
  readonly autoResend: boolean;
}
/** E1: the native side recorded the Turn's input: the packet reached the binding. */
export function recordedStep(relay: BindingRelayState, turn: CarriedTurn): BindingRelayState { return step(relay, { kind: "recorded", packet: turn.packet }); }
/** What a Turn was authorized to do, as its settlement reads it. */
export type SettledTurn =
  | { readonly kind: "none" }
  | ({ readonly kind: "carry"; readonly recorded: boolean } & CarriedTurn)
  /** A content Turn that carried nothing because nothing was owed: the last seq of the conversation before it, and whether the agent answered (evidence that the native side heard the input). */
  | { readonly kind: "plain"; readonly contextThroughSeq: number; readonly agentOutput: boolean }
  | { readonly kind: "alone" }
  | { readonly kind: "command"; readonly declared: ContextEffect };
export interface SettleInput {
  readonly relay: BindingRelayState;
  readonly runId: RunId;
  readonly turn: SettledTurn;
  readonly dispatched: boolean;
  readonly status: "completed" | "cancelled" | "failed" | null;
  /** What the Driver knew of the input reaching the native history (BackendResult.input). */
  readonly input: "recorded" | "not_recorded" | undefined;
  readonly noop: boolean;
  /** BackendResult.native: the Driver ran the Hub's clear this Turn (it gave the native session up) and the Turn's native state is confirmed. A report is taken as certain: a clear is the Hub opening a new native session. */
  readonly cleared: boolean;
  readonly declaration: RelayDeclaration;
  /** The Turn ended unknown, its process group is confirmed ended, and its native session is continued. */
  readonly unknownTurn: boolean;
  /** The seq of `run.ended`. */
  readonly endedSeq: number;
  readonly time: number;
}
export interface Settled {
  /** The binding's relay state after the Turn; with `replaced`, the archived binding keeps its own and the new one takes this. */
  readonly relay: BindingRelayState;
  /** The Turn cleared the native session: the binding is archived and its successor opens a new one. */
  readonly replaced: boolean;
  readonly deliveries: readonly RelayDeliveryWrite[];
  /** `run.ended.delivery` of a carrying Turn: its packet and outcome. */
  readonly delivery: Readonly<Record<string, unknown>> | null;
  readonly binding: Readonly<Record<string, unknown>>;
}
/**
 * The relay part of `run.ended` (§6.1, §7.2): a carrying Turn's delivery by evidence (E1 already decided it; else the Turn's result,
 * settledOutcome) and the binding with it — the packet recorded, or pending when nothing confirmed it, or as it was when it is known
 * not to have been sent; a command Turn's effect (commandTurnEvent); a clear the Driver reported, whatever the Turn was; and an
 * unknown Turn continued (everything is sent again).
 */
export function settleTurn(input: SettleInput): Settled {
  let relay = input.relay, replaced = false, delivery: Record<string, unknown> | null = null;
  const deliveries: RelayDeliveryWrite[] = [], before = relay;
  const apply = (event: RelayEvent): void => {
    if (event.kind === "cleared") replaced = true;
    relay = step(relay, event);
  };
  const turn = input.turn;
  switch (turn.kind) {
    case "none": case "alone": break;
    case "plain": {
      // The native side evidently heard it: the Driver says so, a normal end proves it, or the agent answered. Its own Turns then count as what it holds.
      const heard = input.input === "recorded" || input.status === "completed" && input.declaration.successProvesRecorded || input.input !== "not_recorded" && turn.agentOutput;
      if (input.dispatched && heard) apply({ kind: "ran", throughSeq: turn.contextThroughSeq });
      break;
    }
    case "carry": {
      if (turn.recorded) { delivery = { packetId: turn.packet.id, outcome: "recorded", evidence: "E1", mark: relay.mark }; break; }
      const outcome = settledOutcome({ dispatched: input.dispatched, status: input.status, input: input.input, successProvesRecorded: input.declaration.successProvesRecorded }, { seq: input.endedSeq, time: input.time });
      deliveries.push({ kind: "outcome", runId: turn.runId, outcome });
      if (outcome.kind === "recorded") apply({ kind: "recorded", packet: turn.packet });
      else if (outcome.kind === "unknown") apply({ kind: "unconfirmed", packet: turn.packet, autoResend: turn.autoResend });
      delivery = { packetId: turn.packet.id, outcome: outcome.kind, ...(outcome.kind === "recorded" ? { evidence: outcome.evidence, mark: relay.mark } : { reason: outcome.reason }) };
      break;
    }
    case "command": {
      const outcome = commandOutcome(input.dispatched, input.status, !input.dispatched ? "not_recorded" : input.input ?? "unknown", input.noop);
      const event = commandTurnEvent(turn.declared, outcome, { cleared: input.cleared && input.dispatched, seq: input.endedSeq });
      if (event !== null) apply(event);
      break;
    }
  }
  // A clear the Driver confirmed is a clear whatever the Turn was: on a pending packet its delivery is no longer pursued.
  if (turn.kind !== "command" && input.cleared && input.dispatched) apply({ kind: "cleared", seq: input.endedSeq });
  if (input.unknownTurn && !replaced) apply({ kind: "rewound" });
  return { relay, replaced, deliveries, delivery,
    binding: { epoch: relay.epoch, mark: relay.mark, floor: relay.floor, pending: relay.pending !== null, resendAll: relay.resendAll, ...(before.epoch !== relay.epoch ? { cleared: true } : {}), ...(replaced ? { replaced: true } : {}) } };
}
