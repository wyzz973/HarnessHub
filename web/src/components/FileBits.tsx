import { SquareDot, SquareMinus, SquarePlus } from "lucide-react";
import { workspacePath } from "../lib/format.js";

/** What happened to a file, as a mark before its name: made new, removed, or changed (after the diff panel of T3 Code). */
export function FileMark({ created, removed = false }: { readonly created: boolean; readonly removed?: boolean }) {
  return created ? <SquarePlus size={14} strokeWidth={1.9} className="flex-none text-add-on-tint" role="img" aria-label="新建"/>
    : removed ? <SquareMinus size={14} strokeWidth={1.9} className="flex-none text-del-on-tint" role="img" aria-label="删除"/>
    : <SquareDot size={14} strokeWidth={1.9} className="flex-none text-fg-3" role="img" aria-label="修改"/>;
}
/** A file's place in the workspace: the folders quiet, the name plain. */
export function FilePath({ path, workspace }: { readonly path: string; readonly workspace: string }) {
  const shown = workspacePath(path, workspace), cut = shown.lastIndexOf("/") + 1;
  return <span className="min-w-0 flex-1 trunc"><span className="text-fg-3">{shown.slice(0, cut)}</span>{shown.slice(cut)}</span>;
}
/** The lines a file, or several, gained and lost; a side that is nothing is not written. */
export function Lines({ add, del }: { readonly add: number; readonly del: number }) {
  return <>{add ? <span className="flex-none font-mono text-[11px] text-add-on-tint tabular-nums">+{add}</span> : null}{del ? <span className="flex-none font-mono text-[11px] text-del-on-tint tabular-nums">−{del}</span> : null}</>;
}
