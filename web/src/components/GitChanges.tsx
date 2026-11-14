import { ChevronRight, ChevronsDownUp, ChevronsUpDown, GitBranch, RefreshCw } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { errorMessage } from "../api.js";
import { cn } from "../lib/cn.js";
import { workspacePath } from "../lib/format.js";
import { parseUnifiedDiff, type DiffFile } from "../lib/turn.js";
import { Collapsible } from "../ui/motion.js";
import { Menu } from "../ui/overlay.js";
import { Spinner } from "../ui/primitives.js";
import { DiffBody, type DiffRemark } from "./DiffBody.js";
import { FileMark, FilePath, Lines } from "./FileBits.js";

/*
 * The workspace's changes as Git sees them (2026-11-14, after the scopes of T3 Code's diff panel): what is not committed, one commit, or everything the branch changed
 * since it left another one — beside the Hub's own record of what each Turn changed. The files are listed first and a file's diff is read when it is opened; spaces can
 * be left out of the comparison. Read-only.
 */

export type GitScope = { readonly kind: "uncommitted" } | { readonly kind: "commit"; readonly sha: string; readonly subject?: string } | { readonly kind: "branch"; readonly base?: string };
export interface GitChangedFile { readonly path: string; readonly oldPath?: string; readonly status: string; readonly added?: number; readonly removed?: number; readonly binary?: boolean }
export interface GitCommit { readonly sha: string; readonly short: string; readonly subject: string; readonly author?: string; readonly at?: number }
export interface GitAccess {
  readonly changes: (scope: GitScope, whitespace: boolean, signal: AbortSignal) => Promise<{ readonly files: readonly GitChangedFile[]; readonly base?: { readonly ref: string; readonly sha: string } | undefined }>;
  readonly diff: (scope: GitScope, path: string, whitespace: boolean, signal: AbortSignal) => Promise<{ readonly diff: string; readonly binary?: boolean }>;
  readonly log: (before: string | undefined, signal: AbortSignal) => Promise<{ readonly commits: readonly GitCommit[]; readonly next: string | null }>;
  readonly branches: (signal: AbortSignal) => Promise<{ readonly current: string | null; readonly defaultBranch: string | null }>;
}

/** What a scope is called, as its menu and its heading say it. */
export function scopeName(scope: GitScope): string {
  return scope.kind === "uncommitted" ? "未提交的改动" : scope.kind === "branch" ? "相对 " + (scope.base ?? "默认分支") + " 的全部改动" : "提交 " + scope.sha.slice(0, 7) + (scope.subject ? " · " + scope.subject : "");
}

/**
 * The Git scopes offered beside the Hub's: what is not committed, the branch against the default one (when it is another), and the latest commits, read when the menu
 * is opened. The button names the scope shown, and is pressed while one is.
 */
export function GitScopeMenu({ access, scope, onScope }: { readonly access: GitAccess; readonly scope: GitScope | null; readonly onScope: (scope: GitScope) => void }) {
  const [commits, setCommits] = useState<readonly GitCommit[] | null>(null), [branch, setBranch] = useState<{ readonly current: string | null; readonly defaultBranch: string | null } | null>(null);
  const read = (open: boolean) => {
    if (!open) return;
    const controller = new AbortController();
    access.log(undefined, controller.signal).then(page => setCommits(page.commits), () => setCommits([]));
    access.branches(controller.signal).then(setBranch, () => setBranch({ current: null, defaultBranch: null }));
  };
  const items = [
    { label: "未提交的改动", checked: scope?.kind === "uncommitted", onSelect: () => onScope({ kind: "uncommitted" }) },
    ...(branch?.defaultBranch && branch.defaultBranch !== branch.current ? [{ label: "相对 " + branch.defaultBranch + " 的全部改动", checked: scope?.kind === "branch", onSelect: () => onScope({ kind: "branch", base: branch.defaultBranch! }) }] : []),
    { separator: true as const }, { heading: commits === null ? "正在读取提交…" : commits.length === 0 ? "还没有提交" : "最近的提交" },
    ...(commits ?? []).map(commit => ({ label: commit.short + " " + commit.subject, checked: scope?.kind === "commit" && scope.sha === commit.sha, onSelect: () => onScope({ kind: "commit", sha: commit.sha, subject: commit.subject }) })),
  ];
  return <Menu align="end" onOpenChange={read} items={items} trigger={<button type="button" className={cn("btn btn-ghost btn-sm flex-none gap-1 px-2", scope !== null && "bg-subtle text-fg")} aria-label="Git 的改动范围" aria-pressed={scope !== null}>
    <GitBranch size={13} strokeWidth={2} aria-hidden="true"/><span className="max-w-[160px] truncate">{scope === null ? "Git" : scope.kind === "uncommitted" ? "未提交" : scope.kind === "branch" ? "相对 " + (scope.base ?? "默认分支") : scope.sha.slice(0, 7)}</span></button>}/>;
}

/** One file of a Git scope: its row, and under it — when opened — its diff, read then. */
function GitFile({ file, scope, access, workspace, whitespace, wrap, split, open, generation, onToggle, onRemark }: { readonly file: GitChangedFile; readonly scope: GitScope; readonly access: GitAccess; readonly workspace: string;
  readonly whitespace: boolean; readonly wrap: boolean; readonly split: boolean; readonly open: boolean; readonly generation: number; readonly onToggle: () => void; readonly onRemark?: ((remark: DiffRemark) => void) | undefined }) {
  const panel = useId(), [read, setRead] = useState<{ readonly key: string; readonly files: readonly DiffFile[]; readonly binary: boolean } | { readonly key: string; readonly problem: string } | null>(null);
  // What is compared (kept on the screen while it is read again), and each reading of it.
  const what = JSON.stringify([scope, file.path, whitespace]), key = what + "#" + generation;
  useEffect(() => {
    if (!open || read?.key === key) return;
    const controller = new AbortController();
    access.diff(scope, file.path, whitespace, controller.signal).then(answer => { if (!controller.signal.aborted) setRead({ key, files: answer.diff ? parseUnifiedDiff(answer.diff, file.path) : [], binary: answer.binary === true }); },
      (failure: unknown) => { if (!controller.signal.aborted) setRead({ key, problem: errorMessage(failure) }); });
    return () => controller.abort();
  }, [open, key]);
  const shown = workspacePath(file.path, workspace), current = read !== null && read.key.slice(0, read.key.lastIndexOf("#")) === what ? read : null;
  return <li className="flex min-w-0 flex-col" data-path={file.path}>
    <button type="button" className="row flex h-8 w-full min-w-0 items-center gap-2 border-none bg-transparent px-2 text-left text-ui-sm text-fg hover:bg-subtle" aria-expanded={open} aria-controls={panel} onClick={onToggle} title={file.oldPath ? file.oldPath + " → " + file.path : file.path}>
      <ChevronRight size={12} strokeWidth={2.2} aria-hidden="true" className={cn("flex-none text-fg-3 motion-rotate", open && "rotate-90")}/>
      <FileMark created={file.status === "added" || file.status === "untracked"} removed={file.status === "deleted"}/><FilePath path={file.path} workspace={workspace}/>
      {file.status === "untracked" ? <span className="flex-none text-caption text-fg-3">未跟踪</span> : file.status === "renamed" ? <span className="flex-none text-caption text-fg-3">改名</span> : null}
      <Lines add={file.added ?? 0} del={file.removed ?? 0}/>
    </button>
    <Collapsible open={open} id={panel}>
      <section className="mt-0.5 mb-2 min-w-0 overflow-hidden rounded-block bg-surface shadow-hairline" aria-label={"差异：" + shown}>
        {current === null ? <p className="m-0 flex items-center gap-2 px-3 py-2 text-caption text-fg-3"><Spinner size={12} label=""/>正在读取差异</p>
          : "problem" in current ? <p className="m-0 px-3 py-2 text-caption text-red">{current.problem}</p>
          : current.binary || file.binary ? <p className="m-0 px-3 py-2 text-caption text-fg-3">二进制文件，没有文本差异</p>
          : current.files.length === 0 ? <p className="m-0 px-3 py-2 text-caption text-fg-3">{whitespace ? "除了空白没有别的改动" : "没有差异文本"}</p>
          : current.files.map((diff, index) => <div key={index} className={cn(index > 0 && "hairline-t")}><DiffBody file={{ ...diff, path: shown }} wrap={wrap} split={split} onRemark={onRemark}/></div>)}
      </section>
    </Collapsible>
  </li>;
}

/** The files of a Git scope, with what the comparison is against and the lines they gained and lost; a short list is open whole, a long one at its first file. */
export function GitChanges({ access, scope, workspace, wrap, split, whitespace, stamp, onRemark }: { readonly access: GitAccess; readonly scope: GitScope; readonly workspace: string; readonly wrap: boolean; readonly split: boolean;
  readonly whitespace: boolean;
  /** Changes when the conversation changed something (a Turn ended, files were edited): the scope is read again. */
  readonly stamp: string;
  readonly onRemark?: ((remark: DiffRemark) => void) | undefined }) {
  const [read, setRead] = useState<{ readonly key: string; readonly files: readonly GitChangedFile[]; readonly base?: { readonly ref: string; readonly sha: string } | undefined; readonly reading: number }
    | { readonly key: string; readonly problem: string } | null>(null);
  const [chosen, setChosen] = useState<ReadonlySet<string> | null>(null), list = useRef<HTMLUListElement>(null), readings = useRef(0);
  // Read again when the conversation changed something, when the page comes back to the front (the files may have been edited elsewhere) and when asked; what was
  // read stays on the screen meanwhile, and the files opened stay open.
  const [generation, setGeneration] = useState(0), [reading, setReading] = useState(false), lastRead = useRef(0);
  useEffect(() => {
    const again = () => { if (document.visibilityState === "visible" && Date.now() - lastRead.current > 2000) setGeneration(value => value + 1); };
    window.addEventListener("focus", again); document.addEventListener("visibilitychange", again);
    return () => { window.removeEventListener("focus", again); document.removeEventListener("visibilitychange", again); };
  }, []);
  const key = JSON.stringify([scope, whitespace]);
  useEffect(() => { setChosen(null); }, [key]);
  useEffect(() => {
    const controller = new AbortController();
    setReading(true); lastRead.current = Date.now();
    access.changes(scope, whitespace, controller.signal).then(answer => { if (!controller.signal.aborted) setRead({ key, files: answer.files, ...(answer.base === undefined ? {} : { base: answer.base }), reading: ++readings.current }); },
      (failure: unknown) => { if (!controller.signal.aborted) setRead({ key, problem: errorMessage(failure) }); }).finally(() => { if (!controller.signal.aborted) setReading(false); });
    return () => controller.abort();
  }, [key, stamp, generation]);
  const current = read?.key === key ? read : null;
  const files = current !== null && "files" in current ? current.files : [];
  const open = useMemo(() => chosen ?? new Set(files.length <= 3 ? files.map(file => file.path) : files.slice(0, 1).map(file => file.path)), [chosen, files]);
  const every = files.length > 0 && files.every(file => open.has(file.path));
  const add = files.reduce((sum, file) => sum + (file.added ?? 0), 0), del = files.reduce((sum, file) => sum + (file.removed ?? 0), 0);
  const toggle = (path: string) => { const next = new Set(open); if (!next.delete(path)) next.add(path); setChosen(next); };
  return <div className="git-changes flex flex-col">
    <div className="flex min-h-8 items-center gap-2 px-[18px] pb-1 text-caption text-fg-3">
      <span className="min-w-0 flex-1 truncate" title={current !== null && "base" in current && current.base ? current.base.ref + " @ " + current.base.sha.slice(0, 7) : undefined}>{scopeName(scope)}{current !== null && "base" in current && current.base ? "（自 " + current.base.sha.slice(0, 7) + " 起）" : ""}</span>
      <button type="button" className="icon-btn size-7 flex-none text-fg-3" aria-label="重新读取" title="重新读取" disabled={reading} onClick={() => setGeneration(value => value + 1)}>
        <RefreshCw size={13} strokeWidth={2} className={cn(reading && "animate-spin")} aria-hidden="true"/></button>
      {files.length > 0 ? <><span className="flex items-center gap-1.5"><Lines add={add} del={del}/></span>
        <button type="button" className="icon-btn size-7 text-fg-3" aria-label={every ? "全部收起" : "全部展开"} title={every ? "全部收起" : "全部展开"} onClick={() => setChosen(every ? new Set() : new Set(files.map(file => file.path)))}>
          {every ? <ChevronsDownUp size={14} strokeWidth={2}/> : <ChevronsUpDown size={14} strokeWidth={2}/>}</button></> : null}
    </div>
    {current === null ? <p className="m-0 flex items-center gap-2 px-[18px] py-3 text-caption text-fg-3"><Spinner size={12} label=""/>正在读取</p>
      : "problem" in current ? <p className="m-0 px-[18px] py-3 text-caption text-red">{current.problem}</p>
      : files.length === 0 ? <p className="m-0 px-[18px] py-3 text-caption text-fg-3">{scope.kind === "uncommitted" ? "没有未提交的改动" : "这里没有改动"}</p>
      : <ul ref={list} className="m-0 flex list-none flex-col gap-px px-2.5 pb-2" aria-label="改动的文件">{files.map(file => <GitFile key={file.status + ":" + file.path} file={file} scope={scope} access={access} workspace={workspace}
        whitespace={whitespace} wrap={wrap} split={split} open={open.has(file.path)} generation={current !== null && "reading" in current ? current.reading : 0} onToggle={() => toggle(file.path)} onRemark={onRemark}/>)}</ul>}
  </div>;
}
