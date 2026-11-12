import type { DatabaseSync } from "node:sqlite";
import type { ItemRow, RunRow } from "../../contracts/conversation.js";
import type { ItemType } from "../../contracts/protocol.js";
import { SessionError, type NativeSessionBinding, type PublicSwitch, type RunId, type SessionId, type SessionOrigin } from "../../contracts/session.js";
import { originFromRows } from "../../contexts/session/domain/store-conversion.js";
import { ITEM_COLUMNS, bindingRowFrom, headRowFrom, itemFieldsFrom, itemRowFrom, originHistoryRowFrom, runRowFrom, switchRowFrom } from "./rows.js";
import { all, one } from "./statements.js";

/*
 * The small reads a conversation's view is made with besides its pages (ADR-057 3.4): the Run before another, the last Run dispatched to a Harness control,
 * the native bindings, the switch that waits, the history a branch quotes, and which item is the Turn's answer. Each is a point query or a read of a few
 * rows by an index (`runs_dispatched`, the primary keys); none reads a Turn's items but the last few. They are what `ConversationReader` does not answer,
 * for the display layer (src/web/turn-view.ts) that makes a Turn's header, its hand-over line and the head of the view from them.
 */

/** The item types that stand beside the answer of a Turn and are not it (items-place.ts `BESIDE_THE_ANSWER`): the answer is found past them. */
const BESIDE = new Set<ItemType>(["notice", "error", "plan", "artifact", "context_event"]);

/** An edit of a conversation (a file change with a stored detail) and where it is: the Turn (its ordinal, its Run, the Harness that ran it) and the item's place in it. */
export interface EditRef { readonly ordinal: number; readonly runId: RunId; readonly harnessId: string; readonly seq: number }

/** What the Runs of a conversation say as a whole (`ConversationFacts.runSummary`). */
export interface RunSummary {
  readonly runs: number;
  /** Runs that are not over: queued, preparing, running or being closed. */
  readonly open: number;
  readonly unknown: number;
  /** One of the Runs whose result is unknown left its program unclosed (or recorded no cleanup). */
  readonly unclosed: boolean;
  readonly branchable: { readonly runId: RunId; readonly ordinal: number } | null;
  readonly ran: readonly { readonly harnessId: string; readonly controlId: string; readonly turns: number }[];
}

export class ConversationFacts {
  constructor(private readonly db: DatabaseSync) {}

  /** The Run at an ordinal of a conversation; null when it has none. */
  runAt(id: SessionId, ordinal: number): RunRow | null {
    const row = one(this.db, "SELECT * FROM runs WHERE session_id=? AND ordinal=?", id, ordinal);
    return row === undefined ? null : runRowFrom(row);
  }
  /** A Run by its identity; null when none has it. */
  runById(runId: RunId): RunRow | null {
    const row = one(this.db, "SELECT * FROM runs WHERE run_id=?", runId);
    return row === undefined ? null : runRowFrom(row);
  }
  /**
   * The last Run of the conversation handed to a Harness control (`runs_dispatched`): what the Turn that is the latest on its control shows for its model, and
   * what the native session's carried configuration reads. `native`: only a Run that ran on the Harness's own models, not on a managed Provider.
   */
  lastDispatched(id: SessionId, harnessId: string, controlId: string, options: { readonly native?: boolean } = {}): RunRow | null {
    const row = one(this.db, "SELECT * FROM runs WHERE session_id=? AND harness_id=? AND control_id=? AND dispatched=1" + (options.native === true ? " AND managed=0" : "") + " ORDER BY ordinal DESC LIMIT 1", id, harnessId, controlId);
    return row === undefined ? null : runRowFrom(row);
  }
  /** Whether a Run was handed to the control before the Run at `ordinal` (`runs_dispatched`): the Turn that is the latest of its control stops being it when the next one is dispatched. */
  dispatchedBefore(id: SessionId, harnessId: string, controlId: string, ordinal: number): boolean {
    return one(this.db, "SELECT 1 AS found FROM runs WHERE session_id=? AND harness_id=? AND control_id=? AND dispatched=1 AND ordinal<? LIMIT 1", id, harnessId, controlId, ordinal) !== undefined;
  }
  /** The conversation's native bindings, archived ones too, in the order they were made. */
  bindings(id: SessionId): readonly NativeSessionBinding[] {
    return all(this.db, "SELECT * FROM bindings WHERE session_id=? ORDER BY ordinal", id).map(row => bindingRowFrom(row).binding);
  }
  /**
   * The conversation's latest switch (`UNIQUE(session_id, ordinal)`), whatever its state: the one that waits to take effect (`pending_switch_id` names it, and at most one waits, always
   * the latest), or the last that took effect or failed. Null when the conversation never had one.
   */
  lastSwitch(id: SessionId): PublicSwitch | null {
    const row = one(this.db, "SELECT * FROM switches WHERE session_id=? ORDER BY ordinal DESC LIMIT 1", id);
    return row === undefined ? null : switchRowFrom(row).switch;
  }
  /**
   * The history a conversation started from, as the page shows it (a branch's quoted messages, a continued native session's recent ones); null when it has none. A branch that
   * refers to its source and quotes nothing (`quoted: false`: the source's Turns up to the branch point are its history) is told by where it came from and with no messages here:
   * the page names the source and the point, and the words are the source's, opened with it.
   */
  origin(id: SessionId): SessionOrigin | null {
    const stored = one(this.db, "SELECT * FROM sessions WHERE id=?", id);
    if (stored === undefined) throw new SessionError("SESSION_NOT_FOUND", "public Session was not found");
    const head = headRowFrom(stored).head;
    if (head.origin === undefined) return null;
    const quoted = originFromRows(head.origin, all(this.db, "SELECT * FROM origin_history WHERE session_id=? ORDER BY idx", id).map(originHistoryRowFrom));
    if (quoted !== null || head.origin.kind !== "fork") return quoted;
    return { kind: "fork", sessionId: head.origin.sessionId, throughRunId: head.origin.throughRunId, history: [] };
  }
  /**
   * What the Runs of a conversation say as a whole, from the columns of `runs` (and one field of `run_json`), never a Turn's items: how many Turns have no known result and
   * whether one of them left its program unclosed, how many are not over, the latest Turn that ended in a way a branch can start from, and the Turns that reached a Harness
   * and ended, by the control they ran on (the relay's `executed` columns when the Run has them, else the control it was selected on). Reads the conversation's Run rows.
   */
  runSummary(id: SessionId): RunSummary {
    const totals = one(this.db, "SELECT COUNT(*) AS runs, COALESCE(SUM(status IN ('queued','preparing','running','settling')),0) AS open, COALESCE(SUM(status='unknown'),0) AS unknown FROM runs WHERE session_id=?", id);
    const unclosed = one(this.db, "SELECT 1 AS found FROM runs WHERE session_id=? AND status='unknown' AND COALESCE(json_extract(run_json,'$.cleanup.closed'),0)<>1 LIMIT 1", id);
    const branch = one(this.db, "SELECT run_id, ordinal FROM runs WHERE session_id=? AND status IN ('completed','failed','cancelled') ORDER BY ordinal DESC LIMIT 1", id);
    const ran = all(this.db, "SELECT COALESCE(executed_harness_id, harness_id) AS harness, COALESCE(executed_control_id, control_id) AS control, COUNT(*) AS turns FROM runs WHERE session_id=? AND dispatched=1 AND status IN ('completed','failed','cancelled','unknown') GROUP BY harness, control ORDER BY MIN(ordinal)", id);
    return { runs: Number(totals?.runs ?? 0), open: Number(totals?.open ?? 0), unknown: Number(totals?.unknown ?? 0), unclosed: unclosed !== undefined,
      branchable: branch === undefined ? null : { runId: String(branch.run_id) as RunId, ordinal: Number(branch.ordinal) },
      ran: ran.map(row => ({ harnessId: String(row.harness), controlId: String(row.control), turns: Number(row.turns) })) };
  }
  /**
   * The edits of a conversation: the file changes that have a stored detail (where their diff is), oldest first. The page counts them and lists the files they changed;
   * there is no index of them, so this reads the type of every item of the conversation (not their words), and the caller keeps the answer and moves it along by the
   * commits (`src/web/conversation-changes.ts`).
   */
  edits(id: SessionId): readonly EditRef[] {
    return all(this.db, "SELECT r.ordinal, r.run_id, r.harness_id, i.seq FROM runs r JOIN items i ON i.run_id=r.run_id WHERE r.session_id=? AND i.type='file_change' AND json_extract(i.item_json,'$.detail') IS NOT NULL ORDER BY r.ordinal, i.seq", id)
      .map(row => ({ ordinal: Number(row.ordinal), runId: String(row.run_id) as RunId, harnessId: String(row.harness_id), seq: Number(row.seq) }));
  }
  /** The plan of the newest Turn that has a plan with at least one step (the Harness's own: a row), with the Turn it belongs to; null when no Turn has one. */
  latestPlan(id: SessionId): { readonly ordinal: number; readonly runId: RunId; readonly harnessId: string; readonly row: ItemRow } | null {
    const found = one(this.db, "SELECT r.ordinal, r.run_id, r.harness_id, i.seq FROM runs r JOIN items i ON i.run_id=r.run_id WHERE r.session_id=? AND i.type='plan' AND json_array_length(i.item_json,'$.steps')>0 ORDER BY r.ordinal DESC, i.seq DESC LIMIT 1", id);
    if (found === undefined) return null;
    const row = this.item(String(found.run_id) as RunId, Number(found.seq));
    return row === null ? null : { ordinal: Number(found.ordinal), runId: String(found.run_id) as RunId, harnessId: String(found.harness_id), row };
  }
  /** The plain tool calls of a Run (rows of type `tool`): the calls no protocol type reads, among which are the Harness's task-list calls. */
  plainTools(runId: RunId): readonly ItemRow[] {
    return all(this.db, "SELECT " + ITEM_COLUMNS + ", item_json FROM items WHERE run_id=? AND type='tool' AND item_id LIKE 'tool:%' ORDER BY seq", runId).map(row => itemRowFrom(row, itemFieldsFrom(row)));
  }
  /** One item's row with its fields whole and without its text; null when the Run has none at that place. */
  item(runId: RunId, seq: number): ItemRow | null {
    const row = one(this.db, "SELECT " + ITEM_COLUMNS + ", item_json FROM items WHERE run_id=? AND seq=?", runId, seq);
    return row === undefined ? null : itemRowFrom(row, itemFieldsFrom(row));
  }
  /**
   * The seq of the item that is the answer of a Turn (`phase: "final"`) once it completed: the last item that is not a notice, an error, the plan, an artifact
   * or a context event, when that is a reply segment; null when it is anything else, or the Turn has no item. Reads the last few types from the end, not the Turn.
   */
  finalSeq(runId: RunId): number | null {
    let below = Number.MAX_SAFE_INTEGER;
    for (;;) {
      const page = all(this.db, "SELECT seq, type FROM items WHERE run_id=? AND seq<? ORDER BY seq DESC LIMIT 32", runId, below);
      if (page.length === 0) return null;
      for (const row of page) {
        if (BESIDE.has(row.type as ItemType)) continue;
        return row.type === "assistant_message" ? Number(row.seq) : null;
      }
      below = Number(page[page.length - 1]!.seq);
    }
  }
}
