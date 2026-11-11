import type { SessionId } from "../../../src/contracts/session.js";
import type { TableGrant } from "../../../src/contracts/table.js";
import { TableMount, type TableAttachment } from "../../../src/infrastructure/table/mount.js";

/*
 * The context table's mount, watched (HH_REAL_TABLE=1; docs/verification/relay-ruler.md): the Hub's own TableMount, which also
 * remembers for each native process it gave the table to which conversation and Harness it was for and when it began and ended, so
 * that the ruler's evidence can say whether a step's process had the table's environment. It decides nothing and changes nothing
 * about what the processes are given.
 */
export class WatchedMount extends TableMount {
  private readonly seen: { readonly sessionId: SessionId; readonly harnessId: string; readonly from: number; to: number | null }[] = [];
  override attach(grant: TableGrant): TableAttachment | null {
    const attached = super.attach(grant);
    if (attached === null) return null;
    const row = { sessionId: grant.sessionId, harnessId: grant.harnessId, from: Date.now(), to: null as number | null };
    this.seen.push(row);
    return { env: attached.env, detach: () => { row.to ??= Date.now(); attached.detach(); } };
  }
  /** Whether a process of this Harness in this conversation had the table's environment at any moment from `from` to `to` (milliseconds). */
  carried(sessionId: SessionId, harnessId: string, from: number, to: number): boolean {
    return this.seen.some(row => row.sessionId === sessionId && row.harnessId === harnessId && row.from <= to && (row.to ?? Number.POSITIVE_INFINITY) >= from);
  }
}
