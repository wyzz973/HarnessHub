import type { PublicTool } from "../../../../contracts/session.js";

/**
 * The files a change tool made, from what its stored detail says (moved here from the relay's narration so that the relay's packet,
 * the context table and the protocol read a patch one way). Pure.
 */

/** One file a change made: where, how (created, deleted, edited, moved), and its added and removed lines when known. */
export interface FileChange { readonly path: string; readonly op: "create" | "delete" | "edit" | "move"; readonly added: number | null; readonly removed: number | null }

/** What a stored tool detail adds to the tool's own facts: its input (the command, the arguments), its diff and where it acted; `files` are a diff's files counted ahead of time (the protocol's cached head keeps these and drops the diff). */
export interface ToolDetailInput {
  readonly input?: string;
  readonly diff?: string;
  readonly locations?: readonly string[];
  readonly files?: readonly FileChange[];
}

function diffPath(header: string): string { const path = header.replace(/\t.*$/u, "").trim(); return path === "/dev/null" ? path : path.replace(/^[ab]\//u, ""); }
/**
 * A unified diff split by file (M4): a section starts at `diff --git` or at a `---` line followed by a `+++` line; each
 * section's path, operation (`--- /dev/null` created, `+++ /dev/null` deleted) and added and removed lines (headers excluded).
 */
export function diffFiles(diff: string): readonly FileChange[] {
  const sections: { old: string | null; next: string | null; added: number; removed: number; header: boolean }[] = [];
  let current: (typeof sections)[number] | null = null;
  const lines = diff.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (line.startsWith("diff --git ")) { current = { old: null, next: null, added: 0, removed: 0, header: false }; sections.push(current); continue; }
    if (line.startsWith("--- ") && lines[index + 1]?.startsWith("+++ ")) {
      if (current === null || current.header) { current = { old: null, next: null, added: 0, removed: 0, header: false }; sections.push(current); }
      current.old = diffPath(line.slice(4)); current.next = diffPath(lines[index + 1]!.slice(4)); current.header = true; index++; continue;
    }
    if (current === null) { current = { old: null, next: null, added: 0, removed: 0, header: false }; sections.push(current); }
    if (line.startsWith("+")) current.added++; else if (line.startsWith("-")) current.removed++;
  }
  return sections.filter(section => section.added + section.removed > 0 || section.header).map(section => ({
    path: section.next !== null && section.next !== "/dev/null" ? section.next : section.old ?? "",
    op: section.old === "/dev/null" ? "create" : section.next === "/dev/null" ? "delete" : "edit", added: section.added, removed: section.removed,
  }));
}
/** Whether a location and a diff's path name one file: equal once leading slashes and `./` are dropped, or one ends the other. */
function sameFile(location: string, path: string): boolean {
  const a = location.replace(/^(?:\.\/|\/)+/u, ""), b = path.replace(/^(?:\.\/|\/)+/u, "");
  return a === b || a.endsWith("/" + b) || b.endsWith("/" + a);
}
/**
 * The files one change tool made, from its read detail (M4): its diff split by file, each matched to one of its locations
 * (a patch over several files lists each); its locations alone when it has no diff; null when nothing was read or the
 * diff and the locations do not correspond, and the tool is then told by its title.
 */
export function changesFrom(tool: Pick<PublicTool, "kind">, detail: ToolDetailInput | undefined): readonly FileChange[] | null {
  if (detail === undefined) return null;
  const locations = (detail.locations ?? []).map(location => location.replace(/:\d+$/u, "")).filter(location => location !== "");
  const kindOp = tool.kind === "delete" ? "delete" : tool.kind === "move" ? "move" : null;
  const files = (detail.files ?? (detail.diff === undefined ? [] : diffFiles(detail.diff))).filter(file => file.path !== "");
  if (files.length === 0) return locations.length ? locations.slice(0, 16).map(path => ({ path, op: kindOp ?? "edit", added: null, removed: null })) : null;
  // One location and a diff of one file name the same change, whatever path the diff's headers give.
  if (locations.length === 1 && files.length === 1) return [{ ...files[0]!, path: locations[0]!, op: kindOp ?? files[0]!.op }];
  if (locations.length && !files.every(file => locations.some(location => sameFile(location, file.path)))) return null;
  return files.map(file => ({ ...file, path: locations.find(location => sameFile(location, file.path)) ?? file.path, op: kindOp ?? file.op }));
}
/** Where a tool read or acted, from its detail's first location (a trailing `:line` dropped); null without one. */
export function locationOf(detail: Pick<ToolDetailInput, "locations"> | undefined): string | null {
  const first = detail?.locations?.[0];
  return typeof first === "string" && first !== "" ? first.replace(/:\d+$/u, "") : null;
}
