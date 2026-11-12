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
  /** The conversation's native bindings, archived ones too, in the order they were made. */
  bindings(id: SessionId): readonly NativeSessionBinding[] {
    return all(this.db, "SELECT * FROM bindings WHERE session_id=? ORDER BY ordinal", id).map(row => bindingRowFrom(row).binding);
  }
  /** The switch the conversation waits to take effect (`pending_switch_id`); null when none. */
  pendingSwitch(id: SessionId): PublicSwitch | null {
    const row = one(this.db, "SELECT sw.* FROM switches sw JOIN sessions s ON s.id=sw.session_id AND s.pending_switch_id=sw.switch_id WHERE s.id=?", id);
    return row === undefined ? null : switchRowFrom(row).switch;
  }
  /**
   * The history a conversation started from, as the page shows it (a branch's quoted messages, a continued native session's recent ones); null when it has none
   * or quotes its source by reference (a branch made from v14 on: the source's Turns are its history, which this does not read).
   */
  origin(id: SessionId): SessionOrigin | null {
    const stored = one(this.db, "SELECT * FROM sessions WHERE id=?", id);
    if (stored === undefined) throw new SessionError("SESSION_NOT_FOUND", "public Session was not found");
    const head = headRowFrom(stored).head;
    if (head.origin === undefined) return null;
    return originFromRows(head.origin, all(this.db, "SELECT * FROM origin_history WHERE session_id=? ORDER BY idx", id).map(originHistoryRowFrom));
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
