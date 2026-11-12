import type { ContentPort } from "../../../contracts/content.js";
import type { WorkspaceWatch } from "../../../contracts/workspace.js";
import { detailJson } from "../domain/detail-json.js";
import type { PlaceInput } from "../domain/items-place.js";

/**
 * The Hub's record of what a Turn changed in its workspace, made when the Turn ends (completed, failed, stopped or unknown alike): the watch
 * begun with the Turn is finished, the diff is stored as the record's detail (a stored tool detail the page and the context table read like
 * any other), and what comes back is the placement of the Turn's `workspace` item; null when the Turn never reached its Harness, nothing
 * changed or nothing could be compared. Never rejects: a record that cannot be made leaves the Turn as it is.
 */
export async function workspacePlacement(watch: WorkspaceWatch, dispatched: boolean, content: ContentPort | undefined, workspace: string, at: () => number): Promise<Extract<PlaceInput, { kind: "workspace" }> | null> {
  const record = await watch.finish().catch(() => null);
  if (!dispatched || record === null || record.changes.length === 0) return null;
  let detail;
  if (record.diff !== null && content !== undefined) {
    try {
      detail = await content.storeOutput({ workspace, name: "workspace-changes.json", mediaType: "application/json",
        data: detailJson("workspace", { kind: "edit", name: "HarnessHub", diff: record.diff, locations: record.changes.map(change => change.path) }) });
    } catch { detail = undefined; }
  }
  return { kind: "workspace", changes: record.changes, shared: record.shared, ...(detail === undefined ? {} : { detail }), at: at() };
}
