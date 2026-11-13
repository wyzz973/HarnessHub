import type { ReadTurn } from "../../../../src/contracts/protocol-read.js";
import { workspacePath } from "../format.js";
import { editsOf, hubRecordOf } from "./runs.js";

/** One file a Turn changed: its place in the workspace, what was done to it and the lines it gained and lost, when they are known. */
export interface TurnFile { readonly path: string; readonly shown: string; readonly op: "create" | "modify" | "delete" | "rename"; readonly added: number; readonly removed: number }
/** The files a Turn changed. `shared`: another conversation's Turn worked in the same workspace meanwhile, so some of them may be that one's. */
export interface TurnChanges { readonly files: readonly TurnFile[]; readonly added: number; readonly removed: number; readonly shared: boolean }

/**
 * What a Turn changed in its workspace (2026-11-14), from what the details panel counts its changes by: the Hub's own record of the workspace where it made one
 * (compared at the Turn's start and its end, so it is the whole of it), else what its Harness reported; a file once, with its lines summed. Null when it changed nothing.
 */
export function turnChanges(turn: ReadTurn, workspace: string): TurnChanges | null {
  const record = hubRecordOf(turn), source = editsOf(turn);
  const files = new Map<string, { path: string; shown: string; op: TurnFile["op"]; added: number; removed: number }>();
  for (const item of source) for (const change of item.changes) {
    const shown = workspacePath(change.path, workspace), held = files.get(shown);
    if (held === undefined) files.set(shown, { path: change.path, shown, op: change.op as TurnFile["op"], added: change.added ?? 0, removed: change.removed ?? 0 });
    else { held.added += change.added ?? 0; held.removed += change.removed ?? 0; }
  }
  if (files.size === 0) return null;
  const list = [...files.values()];
  return { files: list, added: list.reduce((sum, file) => sum + file.added, 0), removed: list.reduce((sum, file) => sum + file.removed, 0), shared: record !== undefined && source.includes(record) && record.shared === true };
}
/** Whether two paths name one file: the same, or one the tail of the other (a Harness names a file from the disk's root, the Hub from the workspace's). */
export function samePath(left: string, right: string): boolean { return left === right || left.endsWith("/" + right) || right.endsWith("/" + left); }

/** A row of the tree of changed files: a folder (a chain of folders with one child each is one row) with what is under it, or a file. */
export type TreeRow = { readonly kind: "folder"; readonly key: string; readonly name: string; readonly depth: number; readonly added: number; readonly removed: number; readonly count: number }
  | { readonly kind: "file"; readonly key: string; readonly name: string; readonly depth: number; readonly file: TurnFile };
interface Node { readonly name: string; readonly folders: Map<string, Node>; readonly files: TurnFile[] }
const sorted = <T,>(rows: readonly T[], name: (row: T) => string): T[] => [...rows].sort((left, right) => name(left).localeCompare(name(right), undefined, { numeric: true, sensitivity: "base" }));
const totals = (node: Node): { added: number; removed: number; count: number } => {
  const own = node.files.reduce((sum, file) => ({ added: sum.added + file.added, removed: sum.removed + file.removed, count: sum.count + 1 }), { added: 0, removed: 0, count: 0 });
  for (const child of node.folders.values()) { const inner = totals(child); own.added += inner.added; own.removed += inner.removed; own.count += inner.count; }
  return own;
};
/**
 * The changed files as a tree (after the changed-files card of T3 Code): folders first, each in the order of its name, a chain of folders that hold nothing but the
 * next one as one row ("src/components/chat"), and the files of a closed folder left out. `closed`: the folders the reader closed, by their keys.
 */
export function changesTree(files: readonly TurnFile[], closed: ReadonlySet<string>): readonly TreeRow[] {
  const root: Node = { name: "", folders: new Map(), files: [] };
  for (const file of files) {
    const parts = file.shown.split("/").filter(Boolean);
    let node = root;
    // A path outside the workspace keeps its whole folder as one name: it is not walked from the root of the disk.
    const folders = file.shown.startsWith("/") || file.shown.startsWith("~") ? [parts.slice(0, -1).join("/")].filter(Boolean) : parts.slice(0, -1);
    for (const part of folders) { let next = node.folders.get(part); if (next === undefined) { next = { name: part, folders: new Map(), files: [] }; node.folders.set(part, next); } node = next; }
    node.files.push(file);
  }
  const rows: TreeRow[] = [];
  const walk = (node: Node, depth: number, prefix: string): void => {
    for (let folder of sorted([...node.folders.values()], row => row.name)) {
      let name = folder.name;
      while (folder.files.length === 0 && folder.folders.size === 1) { folder = [...folder.folders.values()][0]!; name += "/" + folder.name; }
      const key = prefix + name + "/", sum = totals(folder);
      rows.push({ kind: "folder", key, name, depth, ...sum });
      if (!closed.has(key)) walk(folder, depth + 1, key);
    }
    for (const file of sorted(node.files, row => row.shown)) rows.push({ kind: "file", key: prefix + file.shown, name: file.shown.split("/").at(-1) ?? file.shown, depth, file });
  };
  walk(root, 0, "");
  return rows;
}
