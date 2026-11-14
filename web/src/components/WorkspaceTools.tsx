import { ChevronDown, Copy, FolderOpen, GitBranch, SquareArrowOutUpRight } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { errorMessage } from "../api.js";
import { cn } from "../lib/cn.js";
import { Dialog, Menu } from "../ui/overlay.js";
import { Spinner } from "../ui/primitives.js";
import { FileMark, Lines } from "./FileBits.js";

/*
 * What the page does with the conversation's workspace beyond showing it (2026-11-14, after the thread-details card and the right panel of T3 Code): opens it in an
 * editor installed on this Mac, commits what is not committed and pushes it, and shows a file. Each is done when the user presses its control and never by itself; the
 * Gateway does the work, in the workspace, and says in Git's own words why it could not.
 */

export interface EditorChoice { readonly id: string; readonly name: string }
export interface GitFile { readonly path: string; readonly index: string; readonly worktree: string; readonly added?: number | undefined; readonly removed?: number | undefined }
export interface GitDetail { readonly branch: string | null; readonly upstream?: { readonly name: string; readonly ahead: number; readonly behind: number } | undefined; readonly remote: boolean; readonly files: readonly GitFile[] }
export interface FilePage { readonly path: string; readonly size: number; readonly offset?: number | undefined; readonly text?: string | undefined; readonly next?: number | null | undefined; readonly binary?: true | undefined }
export interface WorkspaceAccess {
  /** The editors installed on this Mac; empty or absent when none was found. */
  readonly editors?: readonly EditorChoice[] | undefined;
  readonly openIn?: ((editor: string, path?: string) => void) | undefined;
  readonly git?: ((signal: AbortSignal) => Promise<GitDetail>) | undefined;
  readonly commit?: ((message: string, paths?: readonly string[]) => Promise<{ readonly commit: string; readonly subject: string }>) | undefined;
  readonly push?: (() => Promise<{ readonly remote: string; readonly branch: string }>) | undefined;
  readonly file?: ((path: string, offset: number, signal: AbortSignal) => Promise<FilePage>) | undefined;
}

const EDITOR_KEY = "harnesshub:editor";
/** The editor the user opened something in last, in this browser, when it is still installed; else the first one found. */
export function preferredEditor(editors: readonly EditorChoice[]): EditorChoice | undefined {
  let last: string | null = null;
  try { last = localStorage.getItem(EDITOR_KEY); } catch { /* the first one */ }
  return editors.find(editor => editor.id === last) ?? editors[0];
}
function rememberEditor(id: string): void { try { localStorage.setItem(EDITOR_KEY, id); } catch { /* lasts for this page only */ } }

/**
 * "在 Cursor 里打开", as a row of the environment section: the row opens the workspace in the editor used last, and the arrow at its end lists the others. With one
 * editor installed the row has no arrow; with none it is not shown.
 */
export function EditorRow({ editors, onOpenIn, path }: { readonly editors: readonly EditorChoice[]; readonly onOpenIn: (editor: string, path?: string) => void; readonly path?: string | undefined }) {
  const [chosen, setChosen] = useState(() => preferredEditor(editors)?.id);
  const editor = editors.find(row => row.id === chosen) ?? editors[0];
  if (editor === undefined) return null;
  const open = (id: string) => { rememberEditor(id); setChosen(id); onOpenIn(id, path); };
  return <div className="editor-row -mx-2 flex min-h-7 min-w-0 items-center">
    <button type="button" className="row flex min-h-7 min-w-0 flex-1 items-center gap-2.5 border-none bg-transparent px-2 text-left text-ui-sm hover:bg-subtle" onClick={() => open(editor.id)}>
      <span className="flex size-4 flex-none items-center justify-center text-fg-3"><SquareArrowOutUpRight size={14} aria-hidden="true"/></span>
      <span className="min-w-0 flex-1 trunc text-fg-2">在 {editor.name} 里打开</span></button>
    {editors.length > 1 ? <Menu align="end" trigger={<button type="button" className="icon-btn icon-btn-sm flex-none text-fg-3" aria-label="换一个编辑器打开" title="换一个编辑器"><ChevronDown size={13} strokeWidth={2} aria-hidden="true"/></button>}
      items={editors.map(row => ({ label: row.name, checked: row.id === editor.id, onSelect: () => open(row.id) }))}/> : null}
  </div>;
}

const untracked = (file: GitFile): boolean => file.index === "?" || file.worktree === "?";
const deleted = (file: GitFile): boolean => file.index === "D" || file.worktree === "D";
/**
 * Commits what the workspace has uncommitted, and pushes it when asked: the files (all chosen until some are taken out), the message, and Git's own words when it
 * refuses. With nothing to commit and commits not yet pushed, it offers the push alone. Nothing is committed or pushed until its button is pressed.
 */
export function CommitDialog({ open, onClose, access, suggestion, onDone }: { readonly open: boolean; readonly onClose: () => void; readonly access: WorkspaceAccess; readonly suggestion: string;
  readonly onDone: (said: string) => void }) {
  const [detail, setDetail] = useState<GitDetail | null>(null), [problem, setProblem] = useState<string | null>(null), [busy, setBusy] = useState<"commit" | "push" | null>(null);
  const [left, setLeft] = useState<ReadonlySet<string>>(new Set()), [message, setMessage] = useState(""), field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!open || access.git === undefined) return;
    const controller = new AbortController();
    setDetail(null); setProblem(null); setLeft(new Set()); setMessage(suggestion);
    access.git(controller.signal).then(value => { if (!controller.signal.aborted) setDetail(value); }, (failure: unknown) => { if (!controller.signal.aborted) setProblem(errorMessage(failure)); });
    return () => controller.abort();
  }, [open]);
  const files = detail?.files ?? [], chosen = files.filter(file => !left.has(file.path));
  const add = chosen.reduce((sum, file) => sum + (file.added ?? 0), 0), del = chosen.reduce((sum, file) => sum + (file.removed ?? 0), 0);
  const ahead = detail?.upstream?.ahead ?? 0, canPush = detail !== null && access.push !== undefined && detail.branch !== null && detail.remote;
  const run = async (push: boolean) => {
    if (access.commit === undefined || message.trim() === "" || chosen.length === 0) return;
    setProblem(null); setBusy("commit");
    try {
      const made = await access.commit(message.trim(), chosen.length === files.length ? undefined : chosen.map(file => file.path));
      if (push && access.push !== undefined) { setBusy("push"); try { const sent = await access.push(); onDone("已提交 " + made.commit + "，已推送到 " + sent.remote + "/" + sent.branch); onClose(); return; }
        catch (failure: unknown) { setProblem("已提交 " + made.commit + "，但没有推送：" + errorMessage(failure)); const next = await access.git?.(new AbortController().signal).catch(() => null); if (next) setDetail(next); return; } }
      onDone("已提交 " + made.commit); onClose();
    } catch (failure: unknown) { setProblem(errorMessage(failure)); }
    finally { setBusy(null); }
  };
  const pushOnly = async () => {
    if (access.push === undefined) return;
    setProblem(null); setBusy("push");
    try { const sent = await access.push(); onDone("已推送到 " + sent.remote + "/" + sent.branch); onClose(); } catch (failure: unknown) { setProblem(errorMessage(failure)); } finally { setBusy(null); }
  };
  return <Dialog open={open} onOpenChange={next => { if (!next && busy === null) onClose(); }} title="提交改动" className="commit-dialog flex w-[min(560px,calc(100vw-32px))] flex-col" initialFocus={field}>
    <div className="flex min-h-0 flex-col gap-3 px-5 pt-3 pb-5">
      {detail === null && problem === null ? <p className="m-0 flex items-center gap-2 py-6 text-ui-sm text-fg-3"><Spinner size={13} label=""/>正在读取工作区的状态</p> : null}
      {detail !== null ? <>
        <p className="m-0 flex min-w-0 items-center gap-2 text-ui-sm text-fg-2"><GitBranch size={14} className="flex-none text-fg-3" aria-hidden="true"/><span className="mono min-w-0 trunc text-caption text-fg">{detail.branch ?? "不在分支上"}</span>
          {detail.upstream ? <span className="flex-none text-caption text-fg-3">{detail.upstream.name}{detail.upstream.ahead ? " · 领先 " + detail.upstream.ahead : ""}{detail.upstream.behind ? " · 落后 " + detail.upstream.behind : ""}</span> : null}</p>
        {files.length > 0 ? <>
          <div className="flex items-center gap-2 text-caption text-fg-3"><span>{chosen.length === files.length ? files.length + " 个文件" : "选了 " + chosen.length + " / " + files.length + " 个文件"}</span><Lines add={add} del={del}/>
            <button type="button" className="link-btn ml-auto text-caption" onClick={() => setLeft(chosen.length === files.length ? new Set(files.map(file => file.path)) : new Set())}>{chosen.length === files.length ? "全不选" : "全选"}</button></div>
          <ul className="scroll-area m-0 -mx-1.5 flex max-h-[220px] list-none flex-col gap-px p-0" aria-label="要提交的文件">{files.map(file => <li key={file.path}>
            <label className="row flex h-7 min-w-0 cursor-pointer items-center gap-2 px-1.5 text-ui-sm hover:bg-subtle">
              <input type="checkbox" className="size-3.5 flex-none accent-[var(--accent)]" checked={!left.has(file.path)} onChange={event => setLeft(current => { const next = new Set(current); if (event.target.checked) next.delete(file.path); else next.add(file.path); return next; })}/>
              <FileMark created={untracked(file) || file.index === "A"} removed={deleted(file)}/><span className="mono min-w-0 flex-1 trunc text-code" title={file.path}>{file.path}</span><Lines add={file.added ?? 0} del={file.removed ?? 0}/></label></li>)}</ul>
          <textarea ref={field} className="field min-h-[72px] w-full resize-y px-2.5 py-2 text-ui-sm leading-5" value={message} placeholder="提交说明" aria-label="提交说明" onChange={event => setMessage(event.target.value)}
            onKeyDown={event => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void run(false); } }}/>
        </> : <p className="m-0 py-2 text-ui-sm text-fg-2">没有未提交的改动{ahead > 0 ? "；有 " + ahead + " 个提交还没有推送。" : "。"}</p>}
      </> : null}
      {problem ? <p className="m-0 max-h-[120px] overflow-auto rounded-row bg-inset px-2.5 py-2 text-caption break-words whitespace-pre-wrap text-red" role="alert">{problem}</p> : null}
      <div className="flex items-center justify-end gap-2 pt-1">
        <button type="button" className="btn btn-ghost" disabled={busy !== null} onClick={onClose}>取消</button>
        {files.length === 0 ? (ahead > 0 && canPush ? <button type="button" className="btn btn-primary" disabled={busy !== null} onClick={() => void pushOnly()}>{busy === "push" ? <Spinner size={13} label=""/> : null}推送</button> : null) : <>
          {canPush ? <button type="button" className="btn" disabled={busy !== null || message.trim() === "" || chosen.length === 0} onClick={() => void run(true)}>{busy === "push" ? <Spinner size={13} label=""/> : null}提交并推送</button> : null}
          <button type="button" className="btn btn-primary" disabled={busy !== null || message.trim() === "" || chosen.length === 0} onClick={() => void run(false)}>{busy === "commit" ? <Spinner size={13} label=""/> : null}提交</button>
        </>}
      </div>
    </div>
  </Dialog>;
}

/**
 * A file of the workspace as it is on the disk now, read-only: its lines with their numbers, a page at a time (the rest is read when asked for), and what is done
 * with it — its path copied, the file shown in the Finder or opened in an editor. A file that is not text says so with its size.
 */
export function FileView({ path, access, onReveal }: { readonly path: string; readonly access: WorkspaceAccess; readonly onReveal?: ((path: string) => void) | undefined }) {
  const [pages, setPages] = useState<readonly FilePage[]>([]), [problem, setProblem] = useState<string | null>(null), [reading, setReading] = useState(false), [copied, setCopied] = useState(false);
  const read = (offset: number, signal: AbortSignal) => {
    if (access.file === undefined) return;
    setReading(true); setProblem(null);
    access.file(path, offset, signal).then(page => { if (!signal.aborted) setPages(current => offset === 0 ? [page] : [...current, page]); }, (failure: unknown) => { if (!signal.aborted) setProblem(errorMessage(failure)); })
      .finally(() => { if (!signal.aborted) setReading(false); });
  };
  useEffect(() => { const controller = new AbortController(); setPages([]); read(0, controller.signal); return () => controller.abort(); }, [path]);
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 1600); return () => clearTimeout(timer); }, [copied]);
  const first = pages[0], last = pages.at(-1), lines = useMemo(() => pages.map(page => page.text ?? "").join("").split("\n"), [pages]);
  const editor = access.editors && access.openIn ? preferredEditor(access.editors) : undefined;
  const size = first === undefined ? "" : first.size >= 1024 * 1024 ? (first.size / 1024 / 1024).toFixed(1) + " MB" : Math.max(1, Math.round(first.size / 1024)) + " KB";
  return <div className="file-view flex min-h-0 flex-col">
    <div className="flex min-h-11 items-center gap-1 pr-2.5 pl-[18px]">
      <span className="mono min-w-0 flex-1 trunc text-code text-fg-2" title={path}>{path}</span>{first ? <span className="flex-none px-1 text-caption text-fg-3 tabular-nums">{size}</span> : null}
      <button type="button" className="icon-btn size-7 text-fg-3" aria-label="复制路径" title={copied ? "已复制" : "复制路径"} onClick={() => { void navigator.clipboard.writeText(path).then(() => setCopied(true), () => undefined); }}><Copy size={13} strokeWidth={2} aria-hidden="true"/></button>
      {onReveal ? <button type="button" className="icon-btn size-7 text-fg-3" aria-label="在访达中显示" title="在访达中显示" onClick={() => onReveal(path)}><FolderOpen size={13} strokeWidth={2} aria-hidden="true"/></button> : null}
      {editor ? <button type="button" className="icon-btn size-7 text-fg-3" aria-label={"在 " + editor.name + " 里打开"} title={"在 " + editor.name + " 里打开"} onClick={() => access.openIn?.(editor.id, path)}><SquareArrowOutUpRight size={13} strokeWidth={2} aria-hidden="true"/></button> : null}
    </div>
    {problem ? <p className="m-0 px-[18px] py-3 text-ui-sm text-red" role="alert">{problem}</p>
      : first === undefined ? <p className="m-0 flex items-center gap-2 px-[18px] py-3 text-ui-sm text-fg-3"><Spinner size={12} label=""/>正在读取</p>
      : first.binary ? <p className="m-0 px-[18px] py-3 text-ui-sm text-fg-3">不是文本文件，没有显示内容。</p>
      : <div className="file-lines mx-2.5 mb-3 overflow-x-auto rounded-block bg-surface py-1.5 font-mono text-code shadow-hairline" role="group" aria-label={"文件内容：" + path}>
        {lines.map((line, index) => <div key={index} className={cn("flex min-w-max leading-5", index === lines.length - 1 && line === "" && "hidden")}>
          <span className="w-11 flex-none pr-2.5 text-right text-fg-3 select-none tabular-nums">{index + 1}</span><span className="pr-3 whitespace-pre">{line}</span></div>)}
        {last?.next !== undefined && last.next !== null ? <div className="sticky left-0 px-3 pt-2 pb-1 font-sans"><button type="button" className="btn btn-sm" disabled={reading} onClick={() => read(last.next!, new AbortController().signal)}>{reading ? "正在读取…" : "读取后面的内容"}</button></div> : null}
      </div>}
  </div>;
}
