import type { DatabaseSync } from "node:sqlite";
import { SessionError, type SessionSnapshot } from "../../contracts/session.js";
import { parseSession } from "./legacy/state.js";
import { reasonOf, type UpgradeFault } from "./upgrade-check.js";
import { all, one } from "./statements.js";

/*
 * One native session in two conversations (review of the cut, finding 3). The old store let two conversations hold the same native session (continuing one native session
 * twice, or two copies of one history); the tables of v14 do not (`bindings_held`: one holder in the whole store, as the Harness's own session can be continued from one
 * place only). A v13 database that has such a pair cannot be converted as it is, and the upgrade must not stop at the second conversation with a database that is half
 * converted and refused by the build that made it.
 *
 * THE RULE, decided once in the first transaction of the upgrade and kept in the bookkeeping (`migration_v14_moves`), so that a resumed upgrade and the check that runs
 * before it give the same answer in any order of conversion:
 *   - the holder that USED the native session last keeps it. "Used" is the time of the end (else of the input) of the last Run dispatched into it (the binding's native
 *     position, `throughRunId`); a holder with no such Run is taken at its conversation's latest update. Ties go to the later update, then to the conversation made first.
 *   - every other holder's binding is archived: the same state a native reset leaves it in (`status` "archived", nothing else of it changed). Its conversation's next Turn
 *     finds no live binding of that Harness control, opens a new native session, and the relay carries it the whole history (a new binding's mark is below everything). Nothing
 *     of the conversation is lost or rewritten: its Runs, messages and events are as they were, and the old native session stays with the conversation that kept it.
 *   - a holder that is converted already (an upgrade stopped by an earlier build) keeps its native session whatever the others did.
 *
 * What is told of it is the pair of conversations, the Harness control and the binding's ordinal, never the native session's reference.
 */

/** A native session a conversation holds live: ready or unconfirmed, and one it can resume (not a binding that opens a new one). */
export interface Holding {
  readonly sessionId: string;
  /** The order the conversations were made in (the row's position), for a tie. */
  readonly position: number;
  readonly ordinal: number;
  readonly harnessId: string;
  readonly controlId: string;
  readonly checkpoint: string;
  /** The conversation is converted already: its rows hold the binding, and the unique key is held. */
  readonly converted: boolean;
}
/** A binding the upgrade archives because another conversation used its native session more recently. */
export interface NativeMove { readonly sessionId: string; readonly ordinal: number; readonly harnessId: string; readonly controlId: string; readonly keptBy: string }
/** When a holder used its native session, and when its conversation was last changed (milliseconds; `usedAt` null when no Run was dispatched into it). */
export interface Usage { readonly usedAt: number | null; readonly updatedAt: number }

export const MOVES_DDL = "CREATE TABLE migration_v14_moves(session_id TEXT NOT NULL, ordinal INTEGER NOT NULL, harness_id TEXT NOT NULL, control_id TEXT NOT NULL, kept_by TEXT NOT NULL, PRIMARY KEY(session_id, ordinal)) STRICT, WITHOUT ROWID";

const instant = (value: unknown): number | null => { const parsed = typeof value === "string" ? Date.parse(value) : NaN; return Number.isFinite(parsed) ? parsed : null; };

/**
 * The live native sessions of the conversations that are not converted (read from the JSON of their snapshot, in `column`: `snapshot` before the first transaction of
 * the upgrade, `head` after it) and of those that are (the rows of `bindings`; only after it).
 */
export function liveHoldings(db: DatabaseSync, column: "snapshot" | "head"): readonly Holding[] {
  const holdings: Holding[] = all(db, "SELECT s.id AS id, s.rowid AS position, CAST(b.key AS INTEGER) AS ordinal, json_extract(b.value,'$.harnessId') AS harness_id, json_extract(b.value,'$.controlId') AS control_id,"
    + " json_extract(b.value,'$.checkpoint') AS checkpoint FROM sessions s, json_each(s." + column + ",'$.nativeBindings') b WHERE " + (column === "head" ? "s.format<14" : "1=1")
    + " AND json_extract(b.value,'$.status') IN ('ready','unconfirmed') AND COALESCE(json_extract(b.value,'$.opensNew'),0)=0 ORDER BY s.rowid, ordinal")
    .map(row => ({ sessionId: String(row.id), position: Number(row.position), ordinal: Number(row.ordinal), harnessId: String(row.harness_id), controlId: String(row.control_id), checkpoint: String(row.checkpoint), converted: false }));
  if (column === "head") {
    for (const row of all(db, "SELECT b.session_id AS id, s.rowid AS position, b.ordinal AS ordinal, b.harness_id AS harness_id, b.control_id AS control_id, b.checkpoint AS checkpoint FROM bindings b JOIN sessions s ON s.id=b.session_id"
      + " WHERE s.format=14 AND b.status IN('ready','unconfirmed') AND b.opens_new=0")) {
      holdings.push({ sessionId: String(row.id), position: Number(row.position), ordinal: Number(row.ordinal), harnessId: String(row.harness_id), controlId: String(row.control_id), checkpoint: String(row.checkpoint), converted: true });
    }
  }
  return holdings;
}

/** Who gives up what: every group of holdings of one native session is left with one holder, the converted one, else the one used last. `usage` is asked only of the holders of a group. */
export function decideMoves(holdings: readonly Holding[], usage: (holding: Holding) => Usage): readonly NativeMove[] {
  const groups = new Map<string, Holding[]>();
  for (const holding of holdings) {
    const key = holding.harnessId + "\u0000" + holding.controlId + "\u0000" + holding.checkpoint, group = groups.get(key);
    if (group === undefined) groups.set(key, [holding]); else group.push(holding);
  }
  const moves: NativeMove[] = [];
  for (const group of groups.values()) {
    if (group.length < 2 || group.every(holding => holding.converted)) continue;
    const ranked = group.map(holding => { const used = holding.converted ? null : usage(holding); return { holding, time: holding.converted ? Infinity : used!.usedAt ?? used!.updatedAt, updatedAt: used?.updatedAt ?? Infinity }; });
    ranked.sort((left, right) => (left.time === right.time ? 0 : right.time > left.time ? 1 : -1) || (left.updatedAt === right.updatedAt ? 0 : right.updatedAt > left.updatedAt ? 1 : -1)
      || left.holding.position - right.holding.position || left.holding.ordinal - right.holding.ordinal);
    const keeper = ranked[0]!.holding;
    for (const loser of ranked.slice(1)) moves.push({ sessionId: loser.holding.sessionId, ordinal: loser.holding.ordinal, harnessId: loser.holding.harnessId, controlId: loser.holding.controlId, keptBy: keeper.sessionId });
  }
  return moves.sort((left, right) => left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1 : left.ordinal - right.ordinal);
}

/** How many native sessions are held by more than one conversation. */
export function heldTwice(holdings: readonly Holding[]): number {
  const holders = new Map<string, Set<string>>();
  for (const holding of holdings) {
    const key = holding.harnessId + "\u0000" + holding.controlId + "\u0000" + holding.checkpoint, set = holders.get(key);
    if (set === undefined) holders.set(key, new Set([holding.sessionId])); else set.add(holding.sessionId);
  }
  return [...holders.values()].filter(set => set.size > 1).length;
}

/** When a holder used its native session, from the events of the database that holds its conversation (the conversation as a v13 snapshot, its events beside it). */
export function usageOf(db: DatabaseSync, state: SessionSnapshot, ordinal: number): Usage {
  const binding = state.nativeBindings?.[ordinal];
  const stamp = (seq: number): number | null => instant(one(db, "SELECT json_extract(event_json,'$.timestamp') AS at FROM events WHERE session_id=? AND seq=?", state.id, seq)?.at);
  let usedAt: number | null = null;
  if (binding !== undefined && binding.throughRunId !== null) {
    const run = state.runs.find(item => item.id === binding.throughRunId);
    const ended = instant(one(db, "SELECT json_extract(event_json,'$.timestamp') AS at FROM events WHERE session_id=? AND json_extract(event_json,'$.type')='run.ended' AND json_extract(event_json,'$.data.runId')=? ORDER BY seq LIMIT 1", state.id, binding.throughRunId)?.at);
    const accepted = run === undefined ? undefined : state.messages.find(message => message.id === run.userMessageId)?.seq;
    usedAt = ended ?? (accepted === undefined ? null : stamp(accepted));
  }
  return { usedAt, updatedAt: stamp(state.lastSeq) ?? 0 };
}

/**
 * The moves of a database: the rule above, applied to every native session held twice. In the first transaction's state (`head`: the conversations as snapshots after the ladder, some
 * perhaps converted) it is what the upgrade decides; on a database before the upgrade (`snapshot`) it is what the upgrade WILL decide, which `sessions check-upgrade` tells: the
 * rule reads nothing the ladder changes (a binding's status and native position, a Run's message, the events).
 */
export function resolveSharedSessions(db: DatabaseSync, column: "snapshot" | "head" = "head"): readonly NativeMove[] {
  const states = new Map<string, SessionSnapshot>(), unreadable = new Map<string, string>();
  const load = (id: string): SessionSnapshot | null => {
    const known = states.get(id);
    if (known !== undefined) return known;
    if (unreadable.has(id)) return null;
    try {
      const state = parseSession(JSON.parse(String(one(db, "SELECT " + column + " AS text FROM sessions WHERE id=?", id)?.text)) as unknown);
      states.set(id, state);
      return state;
    } catch (error) { unreadable.set(id, reasonOf(error)); return null; }
  };
  // A conversation that cannot be read cannot be asked when it used its native session: it is told, with the others like it, and nothing is decided.
  const moves = decideMoves(liveHoldings(db, column), holding => { const state = load(holding.sessionId); return state === null ? { usedAt: null, updatedAt: 0 } : usageOf(db, state, holding.ordinal); });
  if (unreadable.size > 0) throw new UnreadableHolders([...unreadable].map(([sessionId, reason]) => ({ sessionId, reason })));
  return moves;
}
/** Conversations that hold a native session another conversation holds too and cannot be read, so that which of them used it last cannot be told. */
export class UnreadableHolders extends Error {
  constructor(readonly faults: readonly UpgradeFault[]) { super(faults.length + " conversation" + (faults.length === 1 ? "" : "s") + " holding a native session another conversation holds cannot be read: " + faults.map(fault => fault.sessionId + " (" + fault.reason + ")").join("; ")); this.name = "UnreadableHolders"; }
}

export function recordMoves(db: DatabaseSync, moves: readonly NativeMove[]): void {
  const insert = db.prepare("INSERT INTO migration_v14_moves(session_id,ordinal,harness_id,control_id,kept_by) VALUES(?,?,?,?,?)");
  for (const move of moves) insert.run(move.sessionId, move.ordinal, move.harnessId, move.controlId, move.keptBy);
}
/** The moves the upgrade decided (all of them, whether or not their conversations are converted yet); none when the bookkeeping has no such table. */
export function recordedMoves(db: DatabaseSync): readonly NativeMove[] {
  if (one(db, "SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name='migration_v14_moves'") === undefined) return [];
  return all(db, "SELECT session_id, ordinal, harness_id, control_id, kept_by FROM migration_v14_moves ORDER BY session_id, ordinal")
    .map(row => ({ sessionId: String(row.session_id), ordinal: Number(row.ordinal), harnessId: String(row.harness_id), controlId: String(row.control_id), keptBy: String(row.kept_by) }));
}

/**
 * The conversation as the upgrade writes it: its snapshot with the bindings it gives up archived, and nothing else changed. A move that does not name a binding that holds
 * a native session is a mistake of the program, not something to write.
 */
export function withMoves(state: SessionSnapshot, ordinals: ReadonlySet<number>): SessionSnapshot {
  if (ordinals.size === 0) return state;
  const bindings = state.nativeBindings ?? [];
  for (const ordinal of ordinals) {
    const binding = bindings[ordinal];
    if (binding === undefined || (binding.status !== "ready" && binding.status !== "unconfirmed") || binding.opensNew === true)
      throw new SessionError("MIGRATION_MISMATCH", "conversation " + state.id + ": the upgrade was to archive native binding " + ordinal + ", which holds no native session");
  }
  return { ...state, nativeBindings: bindings.map((binding, ordinal) => ordinals.has(ordinal) ? { ...binding, status: "archived" as const } : binding) };
}
/** The ordinals of a conversation's bindings the upgrade archives (none when the bookkeeping has none). */
export function movedOrdinals(db: DatabaseSync, id: string): ReadonlySet<number> {
  if (one(db, "SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name='migration_v14_moves'") === undefined) return new Set();
  return new Set(all(db, "SELECT ordinal FROM migration_v14_moves WHERE session_id=?", id).map(row => Number(row.ordinal)));
}
