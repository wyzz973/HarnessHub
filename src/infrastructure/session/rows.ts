import type { BindingRow, CommandRow, HeldItem, ItemRow, RunRow, SwitchRow } from "../../contracts/conversation.js";
import { SessionError, type CommandRecord, type NativeSessionBinding, type PublicSwitch, type SessionId } from "../../contracts/session.js";

/*
 * The objects a commit is made of (`RunRow`, `ItemRow`, `BindingRow`, …): the comparison of diff.ts builds them from the conversation, and the files of session-file.ts keep
 * them. Nothing here reads or writes storage.
 */

export type Columns = Record<string, unknown>;

/** JSON with the keys of every object in order: two equal objects spelled in another key order give one text. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return item;
    const source = item as Record<string, unknown>;
    return Object.fromEntries(Object.keys(source).sort().map(key => [key, source[key]]));
  });
}
export function utf8Length(text: string): number { return Buffer.byteLength(text, "utf8"); }
/**
 * The marks of the list a conversation carries (2026-11-14: archived, pinned, put aside until a moment), as its head (`HeadJson`) and its head line keep them. A conversation
 * written before has none: it is neither archived nor pinned nor put aside.
 */
export function listMarksOf(from: { readonly archived?: true | undefined; readonly pinned?: true | undefined; readonly snoozedUntil?: number | undefined }): { readonly archived?: true; readonly pinned?: true; readonly snoozedUntil?: number } {
  return { ...(from.archived === true ? { archived: true as const } : {}), ...(from.pinned === true ? { pinned: true as const } : {}),
    ...(typeof from.snoozedUntil === "number" && Number.isSafeInteger(from.snoozedUntil) ? { snoozedUntil: from.snoozedUntil } : {}) };
}
const bit = (value: boolean): 0 | 1 => value ? 1 : 0;
/** Whether a text holds no lone surrogate. */
export function wellFormed(text: string): boolean { return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text); }
/** Whether a text ends in the first half of a surrogate pair. */
export function endsInHighSurrogate(text: string): boolean { const last = text.charCodeAt(text.length - 1); return last >= 0xd800 && last <= 0xdbff; }

/** A Run's facts as flat values, for the comparison of two versions of it (what changed, and whether a finished Run's evidence was rewritten). */
export function runColumns(row: RunRow): Columns {
  const on = row.executedOn;
  return { session_id: row.sessionId, ordinal: row.ordinal, run_id: row.runId, command_id: row.commandId, status: row.status, epoch: row.epoch, harness_id: row.harnessId, control_id: row.controlId,
    managed: bit(row.managed), accepted_at: row.acceptedAt, preparing_at: row.preparingAt, ready_at: row.readyAt, reused: bit(row.reused), user_seq: row.userSeq, ended_seq: row.endedSeq,
    dispatched: bit(row.dispatched), executed_harness_id: on?.harnessId ?? null, executed_control_id: on?.controlId ?? null, executed_epoch: on?.nativeEpoch ?? null, is_command: bit(row.isCommand),
    command_effect: row.commandEffect, settled_effect: row.settledEffect, acknowledged_by: row.acknowledgedBy, cancel_requested: bit(row.cancelRequested), stop_requested: bit(row.stopRequested),
    legacy_order: bit(row.legacyOrder), run_json: canonicalJson(row.facts) };
}
// The Run as the Runtime holds it and as its row: the domain's pair (run-row.ts), re-exported here with the rest of the objects.
export { RUN_FACT_KEYS, conversationRunOf, isDispatched, runRowOf } from "../../contexts/session/domain/run-row.js";

/** The row of a held item: not its text and not the marks a page read puts on it. */
export function itemRowOf(item: HeldItem): ItemRow {
  const { text: _text, textOmitted: _textOmitted, bodyOmitted: _bodyOmitted, ...row } = item;
  return row;
}
export function bindingRowOf(sessionId: SessionId, ordinal: number, binding: NativeSessionBinding): BindingRow {
  const relay = binding.relay;
  if (relay === undefined) throw new SessionError("INVALID_DATA", "a native binding of a converted conversation has its relay state");
  return { sessionId, ordinal, harnessId: binding.harnessId, controlId: binding.controlId, checkpoint: binding.checkpoint, status: binding.status, opensNew: binding.opensNew === true,
    throughRunId: binding.throughRunId, relayEpoch: relay.epoch, relayMark: relay.mark, relayFloor: relay.floor, binding };
}
export function commandRowOf(sessionId: SessionId, ordinal: number, command: CommandRecord): CommandRow { return { sessionId, ordinal, command }; }
/**
 * What `SwitchRow.sourceThroughOrdinal` says: `n - 1` when the `n` sources of a switch are exactly the first `n` Runs in order; null for any other set.
 */
export function sourceThroughOrdinal(sources: readonly string[], runIdAt: (index: number) => string | undefined): number | null {
  if (sources.length === 0) return null;
  for (let index = 0; index < sources.length; index++) if (runIdAt(index) !== sources[index]) return null;
  return sources.length - 1;
}
export function switchRowOf(sessionId: SessionId, ordinal: number, change: PublicSwitch, sourceThroughOrdinal: number | null): SwitchRow { return { sessionId, ordinal, sourceThroughOrdinal, switch: change }; }
