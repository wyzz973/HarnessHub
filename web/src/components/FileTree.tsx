import { ChevronRight, Folder } from "lucide-react";
import { useState, type ReactNode } from "react";
import { cn } from "../lib/cn.js";
import { workspacePath } from "../lib/format.js";
import { Lines } from "./FileBits.js";

/*
 * The changed files by folder (2026-11-14, after the file tree of T3 Code's diff panel): the folders that hold them, each with the lines its files gained and lost,
 * opened and closed by hand; a folder holding only one folder is named with it ("src/lib"). The files are drawn by the list that asks, a step further in per folder.
 */

interface FolderNode<T> { readonly kind: "folder"; readonly name: string; readonly key: string; readonly children: readonly TreeNode<T>[]; readonly add: number; readonly del: number }
interface FileNode<T> { readonly kind: "file"; readonly name: string; readonly item: T }
type TreeNode<T> = FolderNode<T> | FileNode<T>;

interface Draft<T> { readonly folders: Map<string, Draft<T>>; readonly files: { readonly name: string; readonly item: T }[] }

/** The files as folders and files, folders first, each level in the order of names; the files keep the order they came in. */
function build<T>(items: readonly T[], pathOf: (item: T) => string, linesOf: (item: T) => { readonly add: number; readonly del: number }): readonly TreeNode<T>[] {
  const root: Draft<T> = { folders: new Map(), files: [] };
  for (const item of items) {
    const parts = pathOf(item).split("/").filter(Boolean);
    let at = root;
    for (const part of parts.slice(0, -1)) { let next = at.folders.get(part); if (next === undefined) { next = { folders: new Map(), files: [] }; at.folders.set(part, next); } at = next; }
    at.files.push({ name: parts.at(-1) ?? pathOf(item), item });
  }
  const nodes = (draft: Draft<T>, prefix: string): TreeNode<T>[] => [
    ...[...draft.folders.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([name, inner]): FolderNode<T> => {
      // A folder that holds nothing but one folder is named with it.
      let label = name, key = prefix + name, held = inner;
      while (held.files.length === 0 && held.folders.size === 1) { const [only, deeper] = [...held.folders.entries()][0]!; label += "/" + only; key += "/" + only; held = deeper; }
      const children = nodes(held, key + "/");
      const sum = (list: readonly TreeNode<T>[]): { add: number; del: number } => list.reduce((total, node) => {
        const lines = node.kind === "folder" ? { add: node.add, del: node.del } : linesOf(node.item);
        return { add: total.add + lines.add, del: total.del + lines.del };
      }, { add: 0, del: 0 });
      return { kind: "folder", name: label, key, children, ...sum(children) };
    }),
    ...draft.files.map((file): FileNode<T> => ({ kind: "file", name: file.name, item: file.item })),
  ];
  return nodes(root, "");
}

/**
 * The files of a list by folder. `renderFile` draws one file at a depth (its own row and what opens under it), told the name to show (the file's own, the folders
 * being said above it).
 */
export function FileTree<T>({ items, workspace, pathOf, linesOf, renderFile }: {
  readonly items: readonly T[]; readonly workspace: string; readonly pathOf: (item: T) => string; readonly linesOf: (item: T) => { readonly add: number; readonly del: number };
  readonly renderFile: (item: T, depth: number, name: string) => ReactNode;
}) {
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const tree = build(items, item => workspacePath(pathOf(item), workspace), linesOf);
  const toggle = (key: string) => setClosed(current => { const next = new Set(current); if (!next.delete(key)) next.add(key); return next; });
  const draw = (nodes: readonly TreeNode<T>[], depth: number): ReactNode => nodes.map(node => node.kind === "file" ? renderFile(node.item, depth, node.name)
    : <li key={"folder:" + node.key} className="flex min-w-0 flex-col">
      <button type="button" className="row flex h-8 w-full min-w-0 items-center gap-2 border-none bg-transparent pr-2 text-left text-ui-sm text-fg-2 hover:bg-subtle" style={{ paddingLeft: 8 + depth * 14 }}
        aria-expanded={!closed.has(node.key)} onClick={() => toggle(node.key)} title={node.key}>
        <ChevronRight size={12} strokeWidth={2.2} aria-hidden="true" className={cn("flex-none text-fg-3 motion-rotate", !closed.has(node.key) && "rotate-90")}/>
        <Folder size={13} strokeWidth={2} aria-hidden="true" className="flex-none text-fg-3"/><span className="min-w-0 flex-1 trunc">{node.name}</span>
        <Lines add={node.add} del={node.del}/>
      </button>
      {closed.has(node.key) ? null : <ul className="m-0 flex list-none flex-col gap-px p-0">{draw(node.children, depth + 1)}</ul>}
    </li>);
  return <>{draw(tree, 0)}</>;
}

const TREE_KEY = "harnesshub:diff-tree";
/** Whether the changed files are shown by folder in this browser: as one list until the user says otherwise. */
export function readTree(): boolean { try { return localStorage.getItem(TREE_KEY) === "1"; } catch { return false; } }
export function writeTree(value: boolean): void { try { localStorage.setItem(TREE_KEY, value ? "1" : "0"); } catch { /* lasts for this page only */ } }
