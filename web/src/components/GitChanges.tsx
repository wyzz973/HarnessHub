import { ChevronRight, ChevronsDownUp, ChevronsUpDown, GitBranch, RefreshCw } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { errorMessage } from "../api.js";
import { cn } from "../lib/cn.js";
import { workspacePath } from "../lib/format.js";
import { parseUnifiedDiff, type DiffFile } from "../lib/turn.js";
import { Collapsible } from "../ui/motion.js";
import { Spinner } from "../ui/primitives.js";
import { DiffBody, type DiffRemark } from "./DiffBody.js";
import { FileMark, FilePath, Lines } from "./FileBits.js";
import { SearchPicker, type PickerOption } from "./SearchPicker.js";
import { FileTree } from "./FileTree.js";

/*
 * The workspace's changes as Git sees them (2026-11-14, after the scopes of T3 Code's diff panel): what is not committed, one commit, or everything the branch changed
 * since it left another one — beside the Hub's own record of what each Turn changed. The files are listed first and a file's diff is read when it is opened; spaces can
 * be left out of the comparison. Read-only.
 */

export type GitScope = { readonly kind: "uncommitted" } | { readonly kind: "commit"; readonly sha: string; readonly subject?: string } | { readonly kind: "branch"; readonly base?: string }
  /** What one Turn changed, from the snapshots the Gateway took of the workspace before and after it (its ordinal, from 0). */
  | { readonly kind: "turn"; readonly ordinal: number };
/** A Turn whose workspace was captured before it (and after it, once it ended). */
export interface GitCheckpoint { readonly ordinal: number; readonly before?: string | undefined; readonly after?: string | undefined }
export interface GitChangedFile { readonly path: string; readonly oldPath?: string; readonly status: string; readonly added?: number; readonly removed?: number; readonly binary?: boolean }
/** The current branch, the default one a branch is compared with, and the others by name (local, then remote-tracking). */
export interface GitBranches { readonly current: string | null; readonly defaultBranch: string | null; readonly local?: readonly string[]; readonly remote?: readonly string[] }
export interface GitCommit { readonly sha: string; readonly short: string; readonly subject: string; readonly author?: string; readonly at?: number }
export interface GitAccess {
  readonly changes: (scope: GitScope, whitespace: boolean, signal: AbortSignal) => Promise<{ readonly files: readonly GitChangedFile[]; readonly base?: { readonly ref: string; readonly sha: string } | undefined }>;
  readonly diff: (scope: GitScope, path: string, whitespace: boolean, signal: AbortSignal) => Promise<{ readonly diff: string; readonly binary?: boolean }>;
  readonly log: (before: string | undefined, signal: AbortSignal) => Promise<{ readonly commits: readonly GitCommit[]; readonly next: string | null }>;
  readonly branches: (signal: AbortSignal) => Promise<GitBranches>;
  /** The Turns captured before and after them, newest first, a page at a time (`before` an ordinal); absent where the Gateway takes none. */
  readonly checkpoints?: ((before: number | undefined, signal: AbortSignal) => Promise<{ readonly checkpoints: readonly GitCheckpoint[]; readonly next: number | null }>) | undefined;
}

/** What a scope is called, as its menu and its heading say it. */
export function scopeName(scope: GitScope): string {
  return scope.kind === "uncommitted" ? "未提交的改动" : scope.kind === "branch" ? "相对 " + (scope.base ?? "默认分支") + " 的全部改动" : scope.kind === "turn" ? "第 " + (scope.ordinal + 1) + " 轮改了什么"
    : "提交 " + scope.sha.slice(0, 7) + (scope.subject ? " · " + scope.subject : "");
}

/**
 * The Git scopes offered beside the Hub's, in one list that can be searched (after T3 Code's scope menu and its base branch chooser): what is not committed, the branch
 * against the default one (when it is another) or against any branch, and the commits of the branch, read a page at a time — all read when the list opens. The button
 * names the scope shown, and is pressed while one is.
 */
export function GitScopeMenu({ access, scope, onScope }: { readonly access: GitAccess; readonly scope: GitScope | null; readonly onScope: (scope: GitScope) => void }) {
  const [open, setOpen] = useState(false), [commits, setCommits] = useState<readonly GitCommit[] | null>(null), [next, setNext] = useState<string | null>(null);
  const [branch, setBranch] = useState<GitBranches | null>(null), [reading, setReading] = useState(false), [turns, setTurns] = useState<readonly GitCheckpoint[]>([]);
  const opened = (value: boolean) => {
    setOpen(value);
    if (!value) return;
    const controller = new AbortController();
    access.log(undefined, controller.signal).then(page => { setCommits(page.commits); setNext(page.next); }, () => { setCommits([]); setNext(null); });
    access.branches(controller.signal).then(setBranch, () => setBranch({ current: null, defaultBranch: null }));
    access.checkpoints?.(undefined, controller.signal).then(page => setTurns(page.checkpoints.filter(turn => turn.before !== undefined)), () => setTurns([]));
  };
  const more = () => {
    if (next === null || reading) return;
    setReading(true);
    access.log(next, new AbortController().signal).then(page => { setCommits(current => [...(current ?? []), ...page.commits.filter(commit => !(current ?? []).some(known => known.sha === commit.sha))]); setNext(page.next); }, () => undefined)
      .finally(() => setReading(false));
  };
  const others = branch === null ? [] : [...new Set([...(branch.local ?? []), ...(branch.remote ?? [])])].filter(name => name !== branch.current && name !== branch.defaultBranch);
  const options: PickerOption[] = [
    { value: "uncommitted", label: "未提交的改动", group: "范围" },
    ...(branch?.defaultBranch && branch.defaultBranch !== branch.current ? [{ value: "branch:" + branch.defaultBranch, label: "相对 " + branch.defaultBranch + " 的全部改动", group: "范围" }] : []),
    ...others.map(name => ({ value: "branch:" + name, label: "相对 " + name, group: "相对别的分支" })),
    // What each Turn changed, from the snapshots before and after it (after T3 Code's per-Turn diff).
    ...turns.map(turn => ({ value: "turn:" + turn.ordinal, label: "第 " + (turn.ordinal + 1) + " 轮", ...(turn.after === undefined ? { description: "进行中" } : {}), group: "每一轮改了什么" })),
    ...(commits ?? []).map(commit => ({ value: "commit:" + commit.sha, label: commit.short + " " + commit.subject, ...(commit.author ? { description: commit.author } : {}), group: "这个分支的提交" })),
  ];
  const value = scope === null ? "" : scope.kind === "uncommitted" ? "uncommitted" : scope.kind === "branch" ? "branch:" + (scope.base ?? branch?.defaultBranch ?? "") : scope.kind === "turn" ? "turn:" + scope.ordinal : "commit:" + scope.sha;
  const choose = (chosen: string) => {
    if (chosen === "uncommitted") onScope({ kind: "uncommitted" });
    else if (chosen.startsWith("branch:")) onScope({ kind: "branch", base: chosen.slice("branch:".length) });
    else if (chosen.startsWith("turn:")) onScope({ kind: "turn", ordinal: Number(chosen.slice("turn:".length)) });
    else if (chosen.startsWith("commit:")) { const sha = chosen.slice("commit:".length), subject = commits?.find(commit => commit.sha === sha)?.subject; onScope({ kind: "commit", sha, ...(subject ? { subject } : {}) }); }
  };
  const footer = commits === null ? <span className="text-caption text-fg-3">正在读取分支和提交…</span>
    : next !== null ? <button type="button" className="link-btn text-caption" disabled={reading} onClick={more}>{reading ? "正在读取…" : "读更早的提交"}</button> : undefined;
  return <SearchPicker label="选择 Git 改动范围" value={value} placeholder="Git" options={options} open={open} onOpenChange={opened} onChange={choose} side="bottom" align="end" wide
    chevron={false} footer={footer} className={cn("btn btn-ghost btn-sm h-7 flex-none gap-1 px-2", scope !== null && "bg-subtle text-fg")}
    trigger={() => <><GitBranch size={13} strokeWidth={2} aria-hidden="true"/><span className="max-w-[160px] truncate">{scope === null ? "Git" : scope.kind === "uncommitted" ? "未提交" : scope.kind === "branch" ? "相对 " + (scope.base ?? "默认分支") : scope.kind === "turn" ? "第 " + (scope.ordinal + 1) + " 轮" : scope.sha.slice(0, 7)}</span></>}/>;
}

/** One file of a Git scope: its row, and under it — when opened — its diff, read then. */
function GitFile({ file, scope, access, workspace, whitespace, wrap, split, open, generation, onToggle, onRemark, depth = 0, label }: { readonly file: GitChangedFile; readonly scope: GitScope; readonly access: GitAccess; readonly workspace: string;
  readonly whitespace: boolean; readonly wrap: boolean; readonly split: boolean; readonly open: boolean; readonly generation: number; readonly onToggle: () => void; readonly onRemark?: ((remark: DiffRemark) => void) | undefined;
  /** How far in it stands under its folders, and the name shown there in place of its path (the list by folder). */
  readonly depth?: number; readonly label?: string | undefined }) {
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
    {/* The file's row stays at the top of the panel while its diff scrolls under it. */}
    <button type="button" className="row sticky top-0 z-[2] flex h-8 w-full min-w-0 items-center gap-2 border-none bg-app pr-2 text-left text-ui-sm text-fg hover:bg-subtle" style={{ paddingLeft: 8 + depth * 14 }} aria-expanded={open} aria-controls={panel} onClick={onToggle} title={file.oldPath ? file.oldPath + " → " + file.path : file.path}>
      <ChevronRight size={12} strokeWidth={2.2} aria-hidden="true" className={cn("flex-none text-fg-3 motion-rotate", open && "rotate-90")}/>
      <FileMark created={file.status === "added" || file.status === "untracked"} removed={file.status === "deleted"}/>{label === undefined ? <FilePath path={file.path} workspace={workspace}/> : <span className="min-w-0 flex-1 trunc">{label}</span>}
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
export function GitChanges({ access, scope, workspace, wrap, split, whitespace, tree, stamp, onRemark }: { readonly access: GitAccess; readonly scope: GitScope; readonly workspace: string; readonly wrap: boolean; readonly split: boolean;
  readonly whitespace: boolean;
  /** The files by folder, rather than as one list. */
  readonly tree: boolean;
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
  const current = read?.key === key ? read : null, generation_ = current !== null && "reading" in current ? current.reading : 0;
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
      : <ul ref={list} className="m-0 flex list-none flex-col gap-px px-2.5 pb-2" aria-label="改动的文件">{tree
        ? <FileTree items={files} workspace={workspace} pathOf={file => file.path} linesOf={file => ({ add: file.added ?? 0, del: file.removed ?? 0 })} renderFile={(file, depth, label) => <GitFile key={file.status + ":" + file.path} file={file} scope={scope} access={access}
          workspace={workspace} whitespace={whitespace} wrap={wrap} split={split} open={open.has(file.path)} generation={generation_} onToggle={() => toggle(file.path)} onRemark={onRemark} depth={depth} label={label}/>}/>
        : files.map(file => <GitFile key={file.status + ":" + file.path} file={file} scope={scope} access={access} workspace={workspace}
        whitespace={whitespace} wrap={wrap} split={split} open={open.has(file.path)} generation={generation_} onToggle={() => toggle(file.path)} onRemark={onRemark}/>)}</ul>}
  </div>;
}
