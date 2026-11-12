import type { DatabaseSync } from "node:sqlite";
import { SessionError, type PublicMessage, type PublicRun, type SessionId, type SessionSnapshot } from "../../contracts/session.js";
import { fromItems, originFromRows } from "../../contexts/session/domain/store-conversion.js";
import { WHOLE, readItems } from "./load.js";
import { bindingRowFrom, commandRowFrom, headRowFrom, originHistoryRowFrom, runRowFrom, switchRowFrom } from "./rows.js";
import { all, one } from "./statements.js";

/*
 * A conversation kept as rows, in the shape it had when it was one snapshot (ADR-057 3.3, "the readers that have not moved to items"): each Run made again
 * from its rows by `fromItems`, its messages with it, and the rest of the head and the small tables as they were. READ-ONLY, and whole: it reads every Turn's items
 * and text, so it is for the readers that still want the old shape (the relay's brief, the context table, the export) and for the migration's own check, which holds
 * it to the snapshot the conversion started from. A branch that refers to its source instead of quoting it (made after v14) has no old shape for its history, and
 * the snapshot has no `origin` then.
 */
export function snapshotFromRows(db: DatabaseSync, id: SessionId): SessionSnapshot {
  const stored = one(db, "SELECT * FROM sessions WHERE id=?", id);
  if (stored === undefined) throw new SessionError("SESSION_NOT_FOUND", "public Session was not found");
  const head = headRowFrom(stored), json = head.head;
  const runs: PublicRun[] = [], messages: PublicMessage[] = [];
  for (const row of all(db, "SELECT * FROM runs WHERE session_id=? ORDER BY ordinal", id)) {
    const run = runRowFrom(row), old = fromItems({ row: run, items: readItems(db, run.runId, WHOLE).items, contentRefs: [] });
    runs.push(old.run); messages.push(...old.messages);
  }
  // The messages were committed in the order of their seqs, and the old validation held them to strictly increasing ones.
  messages.sort((left, right) => left.seq - right.seq);
  const bindings = all(db, "SELECT * FROM bindings WHERE session_id=? ORDER BY ordinal", id).map(row => bindingRowFrom(row).binding);
  const origin = json.origin === undefined ? null : originFromRows(json.origin, all(db, "SELECT * FROM origin_history WHERE session_id=? ORDER BY idx", id).map(originHistoryRowFrom));
  return { schemaVersion: 13, id: head.id, version: head.version, lastSeq: head.lastSeq, epoch: head.epoch, status: head.status, configuration: json.configuration, selection: json.selection,
    activeRunId: head.activeRunId, pendingSwitchId: head.pendingSwitchId, runs, messages, switches: all(db, "SELECT * FROM switches WHERE session_id=? ORDER BY ordinal", id).map(row => switchRowFrom(row).switch),
    commands: all(db, "SELECT * FROM commands WHERE session_id=? ORDER BY ordinal", id).map(row => commandRowFrom(row).command),
    ...(bindings.length === 0 ? {} : { nativeBindings: bindings }), ...(origin === null ? {} : { origin }), ...(json.retainNative === undefined ? {} : { retainNative: json.retainNative }),
    ...(json.retained === undefined ? {} : { retained: json.retained }), ...(json.relayRecoveryFailed === undefined ? {} : { relayRecoveryFailed: json.relayRecoveryFailed }) };
}
