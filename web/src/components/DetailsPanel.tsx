import { BoardAdd, BoardEntries, TaskRoster, useTask, type TaskBoardAccess, type TaskSnapshot } from "./TaskBoard.js";
import { ArrowDownToLine, ArrowRightLeft, ArrowUpFromLine, Check, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Circle, CircleDollarSign, Clock, Columns2, Copy, FileText, Folder, FolderOpen, GitBranch, Plug, Plus, Shrink, Space, Timer, WrapText, X } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ITEM_STATUS_WORDS, TURN_STATUS_WORDS } from "../../../src/contracts/protocol-words.js";
import { moneyText } from "../../../src/contracts/protocol-lines.js";
import type { CommandItem, ContextEventItem, NoticeItem, RecapItem, SubagentItem } from "../../../src/contracts/protocol.js";
import type { FileChangeItem, PlanItem } from "../../../src/contracts/protocol.js";
import type { PublicRun } from "../../../src/contracts/session.js";
import type { HarnessView, SessionHeadView } from "../../../src/contracts/web.js";
import type { ConversationView } from "../lib/conversation.js";
import type { ClientConversationChanges, ClientConversationEdit } from "../lib/protocol/wire.js";
import type { ProviderView } from "../../../src/contracts/provider.js";
import { errorMessage } from "../api.js";
import { cn } from "../lib/cn.js";
import { duration, elapsed, folderName, homePath, spentText, workspacePath } from "../lib/format.js";
import { useNow } from "../lib/prefs.js";
import { editsOf, latestPlan, ownWork, planRows, stateOf, statusText } from "../lib/protocol/runs.js";
import { samePath } from "../lib/protocol/changes.js";
import { oneLine, summarizeGroup } from "../lib/protocol/work.js";
import { packetFacts } from "../lib/relay-state.js";
import { finished, knownToolDetail, parseUnifiedDiff, readToolDetail, type DiffFile } from "../lib/turn.js";
import { Collapsible } from "../ui/motion.js";
import { EmptyState, Segmented, Spinner, StatusDot, Tabs } from "../ui/primitives.js";
import { DiffLines, type ToolDetailLoader } from "./Activity.js";
import { DiffBody, type DiffRemark } from "./DiffBody.js";
import { CommitDialog, EditorRow, FileView, type WorkspaceAccess } from "./WorkspaceTools.js";
import { GitChanges, GitScopeMenu, type GitAccess, type GitScope } from "./GitChanges.js";
import { FileMark, FilePath, Lines } from "./FileBits.js";
import { dockedRequest } from "./Approval.js";
import { BrandIcon } from "./BrandIcon.js";
import { TurnSteps } from "./ProtocolTurn.js";
import { RelayDetails } from "./RelayDetails.js";
import type { RelayView } from "../relay.js";

/** The panel's pages: where the conversation stands, what it changed, what each Turn did, and what its Harness holds of it. */
export type PanelTab = "overview" | "changes" | "process" | "context";

/** One changed file of the conversation, merged over every edit that touched it, with the Turns and Agents that did. */
export interface ChangedFile {
  readonly path: string; readonly add: number; readonly del: number;
  /** The first edit of the file created it. */
  readonly created: boolean;
  readonly diffs: readonly DiffFile[];
  readonly runIds: ReadonlySet<string>;
  /** The Harnesses whose Turns made these edits, in the order they first did. */
  readonly harnessIds: readonly string[];
  /** The same, Turn by Turn: what each Turn that touched the file did to it. */
  readonly parts: readonly FilePart[];
}
export interface FilePart { readonly runId: string; readonly add: number; readonly del: number; readonly created: boolean; readonly diffs: readonly DiffFile[] }
/** A file as one Turn changed it: that Turn's lines and diffs alone. */
function fileIn(file: ChangedFile, runId: string): ChangedFile {
  const parts = file.parts.filter(part => part.runId === runId);
  return { ...file, add: parts.reduce((sum, part) => sum + part.add, 0), del: parts.reduce((sum, part) => sum + part.del, 0), created: parts.some(part => part.created), diffs: parts.flatMap(part => part.diffs), parts };
}
export interface ConversationChanges {
  /** Files with a diff, merged by path, in the order they were first changed. */
  readonly files: readonly ChangedFile[];
  /** Edit steps listed (the newest page first, one more earlier page each time `more` is asked for). */
  readonly edits: number;
  /** How many earlier edit steps the conversation has that are not listed yet; 0 when all are. */
  readonly unread: number;
  /** Lists the next earlier page of edit steps. */
  readonly more: () => void;
  /** Some details are still being read: counts are not final. */
  readonly loading: boolean;
  /** Why details could not be read, one per detail. */
  readonly failures: readonly string[];
}
/** Reads a page of the conversation's changes; `before` is the cursor the page before it gave (none for the newest). */
export type ChangesLoader = (before: string | undefined, signal: AbortSignal) => Promise<ClientConversationChanges>;
/** The plan of the newest Turn that has one with steps, whichever Turn that is. */
export interface ConversationPlan { readonly steps: PlanItem["steps"]; readonly explanation: string | undefined; readonly owner: string }
/**
 * The files the conversation changed, from the diffs its edit steps reported (ADR-042: read-only, nothing here undoes a
 * change). The edits of the whole conversation are listed by the Gateway, newest first, a page at a time: the panel reads the
 * newest page when it needs the changes (and again when the conversation has more of them) and the next older one each time `more`
 * is asked for; the edits of the Turns the page holds are known without a read. The diff of each edit is read from its stored detail, once
 * per page, only while the panel is shown, and shared with the steps that show them (every detail is a read of its own, so they are
 * read as the pages are, not all at once); a detail that could not be read is reported once and not asked for again by this view.
 * The numbers the button, the tab and the scopes show are the head's, which needs no read.
 */
interface Edit { readonly runId: string; readonly ordinal: number; readonly harnessId: string; readonly item: FileChangeItem }
const editKey = (edit: { readonly runId: string; readonly item: { readonly seq: number } }): string => edit.runId + "/" + edit.item.seq;
const sameOrder = (left: Edit, right: Edit): number => left.ordinal - right.ordinal || left.item.seq - right.item.seq;
const asEdits = (rows: readonly ClientConversationEdit[]): Edit[] => rows.flatMap(row => row.item.type === "file_change" && (row.item.detail !== undefined || (row.item as FileChangeItem).by === "hub") ? [{ runId: row.runId, ordinal: row.ordinal, harnessId: row.harnessId, item: row.item as FileChangeItem }] : []);
export function useConversationChanges(session: ConversationView, wanted: boolean, load: ToolDetailLoader | undefined, loadChanges: ChangesLoader | undefined): ConversationChanges & { readonly plan: ConversationPlan | null } {
  const reader = useRef(loadChanges); reader.current = loadChanges;
  const readable = loadChanges !== undefined, total = session.facts.changes;
  const [read, setRead] = useState<{ readonly id: string; readonly edits: ReadonlyMap<string, Edit>; readonly cursor: string | null; readonly plan: ClientConversationChanges["plan"] } | null>(null);
  const [reading, setReading] = useState(false), [problem, setProblem] = useState<string | null>(null);
  const held = useRef(read); held.current = read;
  // The newest page, when the panel needs the changes and the conversation has more than were read; with pages between it and what was read before it, those too, so that no change is missed.
  useEffect(() => {
    if (!wanted || !readable) return;
    const controller = new AbortController(), id = session.id;
    setReading(true);
    void (async () => {
      try {
        const before = held.current?.id === id ? held.current : null, known = before === null ? new Map<string, Edit>() : new Map(before.edits);
        let page = await reader.current!(undefined, controller.signal);
        const plan = page.plan, gathered = asEdits(page.edits);
        while (page.next !== null && known.size > 0 && !page.edits.some(row => known.has(row.runId + "/" + row.item.seq))) { page = await reader.current!(page.next, controller.signal); gathered.push(...asEdits(page.edits)); }
        if (controller.signal.aborted) return;
        for (const edit of gathered) known.set(editKey(edit), edit);
        setRead({ id, edits: known, cursor: before === null ? page.next : before.cursor, plan: plan === undefined ? before?.plan ?? null : plan }); setProblem(null);
      } catch (failure: unknown) { if (!controller.signal.aborted) setProblem(errorMessage(failure)); }
      finally { if (!controller.signal.aborted) setReading(false); }
    })();
    return () => controller.abort();
  }, [wanted, readable, session.id, total]);
  const more = useCallback(() => {
    const now = held.current;
    if (now === null || now.cursor === null || reader.current === undefined) return;
    const id = now.id, cursor = now.cursor;
    setReading(true);
    void reader.current(cursor, new AbortController().signal).then(page => {
      if (held.current?.id !== id) return;
      setRead(current => { if (current === null || current.id !== id || current.cursor !== cursor) return current; const edits = new Map(current.edits); for (const edit of asEdits(page.edits)) edits.set(editKey(edit), edit); return { ...current, edits, cursor: page.next }; });
    }, (failure: unknown) => setProblem(errorMessage(failure))).finally(() => setReading(false));
  }, []);
  // The edits of the Turns the page holds are known now; the rest come from the pages read.
  const every = useMemo(() => {
    const all = new Map<string, Edit>(read?.id === session.id ? read.edits : []);
    for (const run of session.runs) if (run.protocol !== undefined) for (const item of editsOf(run.protocol)) all.set(editKey({ runId: run.id, item }), { runId: run.id, ordinal: run.ordinal, harnessId: run.protocol.executor.harnessId, item });
    // A Turn is listed one way: by the Hub's record of it once there is one, else by its Harness's own edits (the rule of `editsOf`, and the Gateway's). What was read
    // while the Turn ran — its Harness's edits, before the record was made — would otherwise stay beside the record, and every file be listed twice.
    const turns = new Map<string, Edit[]>();
    for (const edit of all.values()) turns.set(edit.runId, [...(turns.get(edit.runId) ?? []), edit]);
    const kept = [...turns.values()].flatMap(edits => {
      const record = edits.find(edit => edit.item.by === "hub"), own = edits.filter(edit => edit.item.by !== "hub");
      return record === undefined || (record.item.detail === undefined && own.some(edit => edit.item.detail !== undefined)) ? own : [record];
    });
    return kept.sort(sameOrder);
  }, [read, session.runs, session.id]);
  const [failures, setFailures] = useState<ReadonlyMap<string, string>>(new Map());
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!load || !wanted) return;
    let current = true;
    for (const { item } of every) {
      const content = item.detail;
      if (!content || knownToolDetail(content.id) !== undefined || failures.has(content.id)) continue;
      readToolDetail(content, load).then(() => { if (current) setVersion(value => value + 1); },
        (error: unknown) => { if (current) setFailures(previous => new Map(previous).set(content.id, errorMessage(error))); });
    }
    return () => { current = false; };
  }, [every, load, failures, wanted]);
  const plan = useMemo((): ConversationPlan | null => {
    const found = read?.id === session.id ? read.plan : null;
    return found === null || found === undefined || found.item.type !== "plan" ? null : { steps: (found.item as PlanItem).steps, explanation: (found.item as PlanItem).explanation, owner: found.harnessId };
  }, [read, session.id]);
  return useMemo(() => {
    // A file is one row however it was named: a Harness names it from the disk's root, the Hub's record from the workspace's.
    const rows = new Map<string, { path: string; add: number; del: number; created: boolean; diffs: DiffFile[]; runIds: Set<string>; harnessIds: string[]; parts: { runId: string; add: number; del: number; created: boolean; diffs: DiffFile[] }[] }>();
    const part = (entry: NonNullable<ReturnType<typeof rows.get>>, runId: string, add: number, del: number, created: boolean, diff?: DiffFile) => {
      const held = entry.parts.find(row => row.runId === runId) ?? (() => { const made = { runId, add: 0, del: 0, created, diffs: [] as DiffFile[] }; entry.parts.push(made); return made; })();
      held.add += add; held.del += del; if (diff !== undefined) held.diffs.push(diff);
    };
    const merged = { get: (path: string) => rows.get(workspacePath(path, session.workspace)), set: (path: string, entry: NonNullable<ReturnType<typeof rows.get>>) => { rows.set(workspacePath(path, session.workspace), entry); }, values: () => rows.values() };
    for (const { runId, item, harnessId } of every) {
      const detail = item.detail ? knownToolDetail(item.detail.id) : undefined;
      // The Hub's record without a diff (a workspace that is not a repository, a binary file) still names its files and counts.
      if (item.by === "hub" && item.detail === undefined) {
        for (const change of item.changes) {
          const entry = merged.get(change.path) ?? { path: change.path, add: 0, del: 0, created: change.op === "create", diffs: [], runIds: new Set<string>(), harnessIds: [], parts: [] };
          entry.add += change.added ?? 0; entry.del += change.removed ?? 0; entry.runIds.add(runId); part(entry, runId, change.added ?? 0, change.removed ?? 0, change.op === "create");
          if (!entry.harnessIds.includes(harnessId)) entry.harnessIds.push(harnessId);
          merged.set(change.path, entry);
        }
        continue;
      }
      // An edit whose Harness gave no diff (none was reported, or its detail holds none) still names the files it changed.
      if (item.detail === undefined || detail !== undefined && !detail.diff) {
        for (const change of item.changes) {
          const entry = merged.get(change.path) ?? { path: change.path, add: 0, del: 0, created: change.op === "create", diffs: [], runIds: new Set<string>(), harnessIds: [], parts: [] };
          entry.add += change.added ?? 0; entry.del += change.removed ?? 0; entry.runIds.add(runId); part(entry, runId, change.added ?? 0, change.removed ?? 0, change.op === "create");
          if (!entry.harnessIds.includes(harnessId)) entry.harnessIds.push(harnessId);
          merged.set(change.path, entry);
        }
        continue;
      }
      if (!detail?.diff) continue;
      for (const file of parseUnifiedDiff(detail.diff, detail.locations?.[0] ?? item.changes[0]?.path ?? "改动")) {
        const entry = merged.get(file.path) ?? { path: file.path, add: 0, del: 0, created: file.created, diffs: [], runIds: new Set<string>(), harnessIds: [], parts: [] };
        entry.add += file.add; entry.del += file.del; entry.diffs.push(file); entry.runIds.add(runId); part(entry, runId, file.add, file.del, file.created, file);
        if (!entry.harnessIds.includes(harnessId)) entry.harnessIds.push(harnessId);
        merged.set(file.path, entry);
      }
    }
    const loading = reading || every.some(({ item }) => item.detail !== undefined && knownToolDetail(item.detail.id) === undefined && !failures.has(item.detail.id));
    // Counted as the head counts them (a record is its files, an edit of a Harness is one): what is not listed yet is the rest, and nothing once the Gateway has no earlier page.
    const counted = every.reduce((sum, { item }) => sum + (item.by === "hub" ? Math.max(1, item.changes.length) : 1), 0), known = read?.id === session.id ? read : null;
    const unread = known === null ? Math.max(0, total - counted) : known.cursor === null ? 0 : Math.max(1, total - counted);
    return { files: [...merged.values()], edits: every.length, unread, more, loading, failures: [...failures.values(), ...(problem === null ? [] : [problem])], plan };
    // `version` changes when a detail arrives in the shared store, which this reads.
  }, [every, more, failures, version, reading, problem, plan, total, read, session.id, session.workspace]);
}

/**
 * Copies one Turn's diagnostics (ADR-037). The Gateway assembles and scrubs the text; conversation content is in it only
 * when the user ticks the box, and it is written to the clipboard as it arrives, not kept in the page.
 */
function RunDiagnostics({ runId, load }: { readonly runId: string; readonly load: (runId: string, includeContent: boolean) => Promise<string> }) {
  const [content, setContent] = useState(false);
  const [state, setState] = useState<"idle" | "busy" | "copied" | "failed">("idle");
  const copy = async () => {
    setState("busy");
    const text = load(runId, content);
    try {
      // A clipboard item can wait for the text, so the copy stays tied to the click in browsers that require it.
      if (typeof ClipboardItem !== "undefined" && typeof navigator.clipboard?.write === "function") {
        try { await navigator.clipboard.write([new ClipboardItem({ "text/plain": text.then(value => new Blob([value], { type: "text/plain" })) })]); setState("copied"); return; }
        catch (error) { if (error instanceof Error && error.name !== "NotAllowedError" && error.name !== "TypeError") throw error; }
      }
      await navigator.clipboard.writeText(await text); setState("copied");
    } catch { void text.catch(() => {}); setState("failed"); }
  };
  return <section className="run-diagnostics flex flex-col gap-2" aria-label="诊断信息">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2"><button type="button" className="btn btn-sm diagnostics-copy" disabled={state === "busy"} title="版本、各阶段耗时、结束原因、清理状态与本回合 stderr 的最后 4 KiB；路径、环境变量值和密钥样式的字符串已隐去" onClick={() => void copy()}>{state === "busy" ? <><Spinner size={12} label=""/>正在准备…</> : state === "copied" ? "已复制" : "复制诊断信息"}</button>
      <label className="flex items-center gap-1.5 text-caption text-fg-2"><input type="checkbox" className="accent-accent" checked={content} onChange={event => { setContent(event.target.checked); setState("idle"); }}/>含对话内容</label></div>
    <p className={cn("m-0 text-caption text-red", state !== "failed" && "sr-only")} role="status">{state === "copied" ? `已复制诊断信息（${content ? "含" : "不含"}对话内容）。` : state === "failed" ? "无法复制诊断信息，请稍后再试。" : ""}</p>
  </section>;
}

interface PanelProps {
  readonly session: ConversationView; readonly harnesses: readonly HarnessView[]; readonly providers: readonly ProviderView[];
  /** Reads a page of the conversation's changes (the whole conversation's, not the Turns this page holds). */
  readonly loadChanges?: ChangesLoader | undefined;
  readonly tab: PanelTab; readonly onTab: (tab: PanelTab) => void; readonly runId: string | null; readonly onRun: (id: string) => void;
  readonly loadToolDetail?: ToolDetailLoader | undefined;
  readonly loadDiagnostics?: ((runId: string, includeContent: boolean) => Promise<string>) | undefined;
  readonly onEndProcess?: (() => void) | undefined; readonly busy: boolean; readonly onClose?: (() => void) | undefined;
  /** The conversation's relay state, when the Gateway gives one: what each Harness holds of the conversation and the packets that were sent (relay-architecture §12.1). */
  readonly relay?: { readonly view: RelayView; readonly onViewPacket: (packetId: string) => void } | undefined;
  /** The task the conversation belongs to, when the Gateway gives one: its board, read and written, and the conversations working on it. */
  readonly board?: TaskBoardAccess | undefined;
  /** Opens another conversation of the task. */
  readonly onOpenSession?: ((id: string) => void) | undefined;
  /** What the overview brings into view when it is shown: the chosen Turn's facts, asked for from the Turn itself. */
  readonly focus?: "run" | null | undefined;
  /** What the Changes page is asked to show from the conversation: a Turn's changes, or one of its files. */
  readonly want?: ChangesWant | null | undefined;
  /** Shows the workspace, or a file in it, in the Finder. */
  readonly onReveal?: ((path?: string) => void) | undefined;
  /** The workspace's changes as Git sees them (not committed, a commit, the branch against another), where it is a repository. */
  readonly git?: GitAccess | undefined;
  /** What is done with the workspace: opened in an editor, committed and pushed, a file of it shown. Each part absent where the Gateway has none of it. */
  readonly tools?: WorkspaceAccess | undefined;
  /** Says something came of an action in a corner of the page (a commit made, a push done). */
  readonly onSaid?: ((words: string) => void) | undefined;
  /** Takes a remark on some lines of a diff: it goes into the message box. Absent where no message can be written. */
  readonly onRemark?: ((remark: DiffRemark) => void) | undefined;
  /** Reads where the conversation works: its folder and, when that is a repository, its branch and how many files are not committed. */
  readonly loadWorkspace?: ((signal: AbortSignal) => Promise<WorkspaceFacts>) | undefined;
}
/** Where a conversation works, as the Gateway reads it when asked. */
export interface WorkspaceFacts { readonly path: string; readonly git?: { readonly branch: string | null; readonly dirty: number } | undefined }
/** What the Changes page is asked to show from elsewhere: a scope, a file, or both; `at` tells one asking from the next. */
export interface ChangesWant { readonly scope?: ChangesScope; readonly path?: string; readonly at: number }
export type ChangesScope = "turn" | "all" | "task";

/**
 * The conversation's details beside it. One page says where things stand — the task list and the latest wrap-up, who works on the task and what they go by, the files
 * changed, how full the Harness's window is, what runs in the background and the facts of one Turn — as sections one under the other, each leading to the page that
 * holds the whole of it: the changes with their diffs, every Turn's steps, and what each Harness holds of the conversation. A section with nothing to say is not shown.
 * The tabs' underline slides to the chosen tab (Motion board #24). How the panel comes in is its container's (ChatPage slides the content in 60 ms after the panel, #23;
 * a drawer or a sheet moves by itself): the panel adds no motion of its own, so its content never slides twice.
 */
export function DetailsPanel(props: PanelProps) {
  const { session, tab } = props;
  const runs = session.runs;
  const selected = runs.find(run => run.id === props.runId) ?? runs.at(-1) ?? null;
  const changes = useConversationChanges(session, tab === "changes" || tab === "overview", props.loadToolDetail, props.loadChanges);
  const found = latestPlan(runs);
  const planned = found !== undefined ? { steps: found.plan.steps, explanation: found.plan.explanation, owner: found.run.protocol.executor.harness, live: !finished(found.run.status) }
    : changes.plan === null ? undefined : { ...changes.plan, owner: props.harnesses.find(row => row.id === changes.plan!.owner)?.name ?? changes.plan.owner, live: false };
  const kept = session.retention?.process ?? null;
  const background = runs.flatMap(run => run.protocol === undefined ? [] : backgroundOf(run.protocol.items).map(item => ({ run, item })));
  const running = background.filter(row => row.item.status === "running").length + (kept ? 1 : 0);
  const name = useCallback((id: string | undefined) => props.harnesses.find(row => row.id === id)?.name ?? id ?? "Harness", [props.harnesses]);
  // The header button's number, from the head: shown at once, never waiting for a diff to be read.
  const total = session.facts.changes;
  const task = useTask(props.board, session.id + ":" + runs.length + ":" + (runs.at(-1)?.status ?? ""));
  const members = task.task?.members ?? [];
  const window = contextOf(runs);
  const [own, setWant] = useState<ChangesWant | null>(null);
  useEffect(() => { setWant(null); }, [session.id]);
  // The later asking of the two: the panel's own (a section of the overview), or the conversation's (a Turn's card).
  const asked = props.want ?? null, want = own === null ? asked : asked === null || own.at >= asked.at ? own : asked;
  const showChanges = (asked: Omit<ChangesWant, "at"> = {}) => { setWant({ ...asked, at: Date.now() }); props.onTab("changes"); };
  const tabs = [
    { id: "overview" as const, label: "概览" },
    { id: "changes" as const, label: "改动", count: total || null },
    { id: "process" as const, label: "过程", count: running || null },
    // With how many packets were sent, when the relay has any to tell of.
    ...(window !== null || props.relay ? [{ id: "context" as const, label: "上下文", count: props.relay?.view.packets.length || null }] : []),
  ];
  const shown: PanelTab = tabs.some(item => item.id === tab) ? tab : "overview";
  // The files opened beside the four pages (after the file tabs of T3 Code's right panel): each a tab of its own until closed; they are this conversation's, and gone with it.
  const [opened, setOpened] = useState<readonly string[]>([]), [viewing, setViewing] = useState<string | null>(null);
  useEffect(() => { setOpened([]); setViewing(null); }, [session.id]);
  const openFile = props.tools?.file === undefined ? undefined : (path: string) => { const place = workspacePath(path, session.workspace); setOpened(current => current.includes(place) ? current : [...current, place]); setViewing(place); };
  const closeFile = (path: string) => { setOpened(current => current.filter(item => item !== path)); setViewing(current => current === path ? null : current); };
  const base = (path: string): string => path.split("/").at(-1) ?? path;
  return <div className="details-panel flex h-full min-h-0 w-full min-w-0 flex-col bg-app">
    <div className="flex h-[54px] flex-none items-stretch gap-2 pr-3 pl-[18px] hairline-b">
      <div className={cn("flex h-full min-w-0 flex-1 items-stretch gap-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none]", viewing !== null && "[&_.tab[aria-selected=true]]:text-fg-2 [&_.tabs-indicator]:opacity-0")}>
        <Tabs className="h-full flex-none [&>.tab]:h-full" items={tabs} value={shown} onChange={value => { setViewing(null); props.onTab(value); }} label="详情分类" idPrefix="details-tab" panelId="details-tabpanel"/>
        {/* The files stand apart from the four pages: a hairline between, then each file's tab. */}
        {opened.length > 0 ? <span aria-hidden="true" className="mx-1.5 my-auto h-4 w-px flex-none bg-line-strong"/> : null}
        {opened.map(path => <span key={path} className={cn("file-tab group/tab my-auto flex h-7 flex-none items-center rounded-row pr-0.5 pl-2 text-ui-sm transition-colors duration-120 ease-standard", viewing === path ? "bg-subtle text-fg" : "text-fg-2 hover:bg-subtle")}>
          <button type="button" className="max-w-[140px] truncate border-none bg-transparent p-0 font-mono text-code text-inherit" title={path} aria-pressed={viewing === path} onClick={() => setViewing(path)}>{base(path)}</button>
          <button type="button" className="icon-btn ml-0.5 size-5 text-fg-3" aria-label={"关闭 " + base(path)} title="关闭" onClick={() => closeFile(path)}><X size={11} strokeWidth={2.2}/></button></span>)}
      </div>
      {props.onClose ? <button type="button" className="icon-btn size-7 self-center text-fg-3" aria-label="关闭详情栏" title="关闭详情栏" onClick={props.onClose}><X size={14} strokeWidth={2}/></button> : null}
    </div>
    <div className="scroll-area min-h-0 flex-1" role="tabpanel" id="details-tabpanel" aria-labelledby={`details-tab-${shown}`}>
      {viewing !== null && props.tools ? <FileView path={viewing} access={props.tools} onReveal={props.onReveal}/>
        : shown === "changes" ? <Changes changes={changes} selected={selected} workspace={session.workspace} name={name} sessionId={session.id}
          members={members} want={want} onOpenSession={props.onOpenSession} onReveal={props.onReveal} onRemark={props.onRemark} onOpenFile={openFile} git={props.git}/>
        : shown === "process" ? <>
          {kept || background.length || session.retention?.upgraded || session.retention?.outside ? <div className="hairline-b"><Background session={session} kept={kept} items={background} busy={props.busy} onEndProcess={props.onEndProcess} name={name}/></div> : null}
          {selected ? <Process run={selected} runs={runs} onRun={props.onRun} loadToolDetail={props.loadToolDetail} name={name} waiting={run => waitingWords(session, run)}/> : <EmptyState icon={<Clock size={22}/>} title="还没有执行记录"/>}
        </>
        : shown === "context" ? <ContextPage window={window} runs={runs} relay={props.relay} name={name}/>
        : <Overview {...props} selected={selected} planned={planned} changes={changes} total={total} task={task} members={members} window={window} kept={kept} background={background} name={name} showChanges={showChanges}/>}
    </div>
  </div>;
}
/** The work a Turn left running or ran apart from its steps: tasks it delegated and commands it started in the background. */
function backgroundOf(items: readonly { readonly type: string }[]): readonly (SubagentItem | CommandItem)[] {
  return items.filter((item): item is SubagentItem | CommandItem => item.type === "subagent" || item.type === "command" && (item as CommandItem).background === true);
}
/**
 * What a Run in progress waits for from the user, in the words the header, the sidebar and the Turn use for it (decision G):
 * 等你批准 while an approval waits in the composer's place, 等你回答 while only another request does. Null when nothing
 * waits or the Run has ended.
 */
function waitingWords(session: ConversationView, run: PublicRun): "等你批准" | "等你回答" | null {
  if (finished(run.status)) return null;
  const open = (session.permissions ?? []).filter(request => request.runId === run.id && !request.decided);
  return open.length === 0 ? null : open.some(dockedRequest) ? "等你批准" : "等你回答";
}
/** A number of tokens as a stat reads: whole below ten thousand, then in thousands with one decimal. */
function tokens(value: number): string { return value < 10_000 ? value.toLocaleString() : value < 1_000_000 ? (Math.round(value / 100) / 10).toLocaleString() + "k" : (Math.round(value / 10_000) / 100).toLocaleString() + "M"; }
/** How full the window of the conversation's Harness is, as the latest Turn that told of it did: whose window, how much is used and, when it said, how large it is. */
interface WindowUse { readonly used: number; readonly size: number | null; readonly harnessId: string; readonly harness: string; readonly n: number }
function contextOf(runs: readonly PublicRun[]): WindowUse | null {
  for (let index = runs.length - 1; index >= 0; index--) {
    const turn = runs[index]!.protocol, context = turn?.usage.context;
    if (turn !== undefined && context !== undefined) return { used: context.used, size: context.size !== undefined && context.size > 0 ? context.size : null, harnessId: turn.executor.harnessId, harness: turn.executor.harness, n: turn.n };
  }
  return null;
}
/** What happened to the context in the Turns the page holds, newest first: the Harness compacted or cleared its session, or the Hub gave it a new native session. */
interface ContextEvent { readonly n: number; readonly text: string }
function contextEvents(runs: readonly PublicRun[]): readonly ContextEvent[] {
  const events: ContextEvent[] = [];
  for (let index = runs.length - 1; index >= 0; index--) {
    const turn = runs[index]!.protocol;
    if (turn === undefined) continue;
    for (const item of turn.items) {
      if (item.type === "context_event") { const kind = (item as ContextEventItem).kind; events.push({ n: turn.n, text: turn.executor.harness + (kind === "compaction" ? " 压缩了上下文" : kind === "clear" ? " 清空了上下文" : " 回退了上下文") }); }
      else if (item.type === "notice" && (item as NoticeItem).code === "NATIVE_RESEATED") events.push({ n: turn.n, text: (item as NoticeItem).text });
    }
  }
  return events;
}

/** One section of the overview: its name, the one figure that sums it up, and — when a page holds the whole of it — the way there from its name. */
function Section({ title, heading, figure, onOpen, children, className, label }: { readonly title: string; readonly heading?: ReactNode; readonly figure?: ReactNode; readonly onOpen?: (() => void) | undefined; readonly children?: ReactNode; readonly className?: string; readonly label?: string }) {
  return <section className={cn("panel-section flex min-w-0 flex-col px-[18px] pt-3 pb-3.5 hairline-b last:border-b-0", className)} aria-label={label ?? title}>
    <header className="flex min-h-6 items-center gap-2">
      {heading !== undefined ? heading : onOpen ? <button type="button" className="group/title -ml-1.5 flex min-w-0 items-center gap-0.5 rounded-row border-none bg-transparent py-0.5 pr-1 pl-1.5 text-ui font-medium text-fg hover:bg-subtle" onClick={onOpen}>
        <span className="trunc">{title}</span><ChevronRight size={13} strokeWidth={2} aria-hidden="true" className="flex-none text-fg-3 transition-transform duration-120 ease-standard group-hover/title:translate-x-0.5"/></button>
        : <h3 className="m-0 min-w-0 trunc text-ui font-medium text-fg">{title}</h3>}
      {figure !== undefined && figure !== null ? <span className="ml-auto flex min-w-0 items-center gap-1.5 text-caption text-fg-2 tabular-nums">{figure}</span> : null}
    </header>
    {children}
  </section>;
}
/** A file row: the mark of what happened to it, its place in the workspace and the lines it gained and lost, when they are known. */
function FileRow({ path, workspace, add = 0, del = 0, created = false, onChoose }: { readonly path: string; readonly workspace: string; readonly add?: number; readonly del?: number; readonly created?: boolean; readonly onChoose?: (() => void) | undefined }) {
  const body = <><FileMark created={created}/><FilePath path={path} workspace={workspace}/><Lines add={add} del={del}/></>;
  const look = "flex h-8 w-full min-w-0 items-center gap-2 px-2 text-left text-ui-sm text-fg";
  return onChoose ? <button type="button" onClick={onChoose} title={path} className={cn("row border-none bg-transparent hover:bg-subtle", look)}>{body}</button>
    : <div className={cn("rounded-row", look)} title={path}>{body}</div>;
}
/**
 * One line of facts: a mark, what it is and, at the right, its value (after the thread-details card of T3 Code: a row a fact, nothing boxed). `wrap`: a sentence, which
 * may take more than one line.
 */
function Line({ icon, children, value, title, wrap = false }: { readonly icon: ReactNode; readonly children: ReactNode; readonly value?: ReactNode; readonly title?: string; readonly wrap?: boolean }) {
  return <div className={cn("flex min-w-0 gap-2.5 text-ui-sm", wrap ? "items-start py-1" : "min-h-7 items-center")} title={title}>
    <span className={cn("flex size-4 flex-none items-center justify-center text-fg-3", wrap && "mt-0.5")}>{icon}</span>
    <span className={cn("min-w-0 flex-1 text-fg-2", wrap ? "break-words" : "trunc")}>{children}</span>
    {value !== undefined && value !== null ? <span className="max-w-[60%] min-w-0 flex-none trunc text-fg tabular-nums">{value}</span> : null}
  </div>;
}

type Planned = { readonly steps: PlanItem["steps"]; readonly explanation: string | undefined; readonly owner: string; readonly live: boolean };
type BackgroundRow = { readonly run: PublicRun; readonly item: SubagentItem | CommandItem };
/**
 * Where the conversation stands, one section under the other (2026-11-14, after the session rail of Claude's desktop app): the task list with the latest wrap-up; the
 * task — who works on it and what they go by; the files changed; the Harness's window; what runs in the background; and the facts of one Turn.
 */
function Overview(props: PanelProps & { readonly selected: PublicRun | null; readonly planned: Planned | undefined; readonly changes: ConversationChanges; readonly total: number;
    readonly task: ReturnType<typeof useTask>; readonly members: TaskSnapshot["members"]; readonly window: WindowUse | null; readonly kept: NonNullable<SessionHeadView["retention"]>["process"] | null;
    readonly background: readonly BackgroundRow[]; readonly name: (id: string | undefined) => string; readonly showChanges: (asked?: Omit<ChangesWant, "at">) => void }) {
  const { session, selected, planned, changes, task, members, window } = props;
  const runs = session.runs, last = runs.at(-1);
  const recap = last?.protocol?.items.findLast((item): item is RecapItem => item.type === "recap");
  const others = members.filter(member => member.sessionId !== session.id && member.files.length > 0);
  const active = props.background.filter(row => row.item.status === "running");
  const facts = useRef<HTMLDivElement>(null);
  // The Turn's own "details" button asks for that Turn's facts: they are brought into view, without a slide for someone who asked for none.
  useEffect(() => {
    if (props.focus !== "run" || facts.current === null) return;
    facts.current.scrollIntoView({ block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, [props.focus, selected?.id]);
  return <div className="panel-overview flex flex-col">
    {planned !== undefined || recap !== undefined ? <ProgressSection plan={planned} recap={recap}/> : null}
    {props.board !== undefined ? <TaskSection task={task} members={members} current={session.id} name={props.name} onOpenSession={props.onOpenSession}/> : null}
    {changes.files.length > 0 || others.length > 0 || props.total > 0 ? <ChangesSection changes={changes} total={props.total} others={others} workspace={session.workspace} showChanges={props.showChanges}/> : null}
    {window !== null ? <ContextSection window={window} runs={runs} relay={props.relay?.view} name={props.name} onOpen={() => props.onTab("context")}/> : null}
    {props.kept || active.length > 0 || session.retention?.upgraded || session.retention?.outside ? <Section title="后台" figure={props.kept || active.length > 0 ? (active.length + (props.kept ? 1 : 0)) + " 项在跑" : null} onOpen={() => props.onTab("process")}>
      <div className="-mx-4 -mb-3"><Background session={session} kept={props.kept} items={active} busy={props.busy} onEndProcess={props.onEndProcess} name={props.name}/></div></Section> : null}
    <EnvironmentSection session={session} stamp={session.id + ":" + runs.length + ":" + (last?.status ?? "")} load={props.loadWorkspace} onReveal={props.onReveal} tools={props.tools} onSaid={props.onSaid} suggestion={oneLine(recap?.summary ?? session.title)}
      harness={selected ? null : <Line icon={<BrandIcon brand={session.selection.harnessId} name={props.name(session.selection.harnessId)} size={16}/>}><span className="text-fg">{props.name(session.selection.harnessId)}</span></Line>}/>
    {selected ? <div ref={facts}><RunSection {...props} run={selected} runs={runs}/></div> : null}
  </div>;
}
/**
 * Where the conversation works (after the thread-details card of T3 Code): its folder, which opens in the Finder, and — when the folder is a repository — the branch
 * it is on and how many files are not committed. Read when the panel shows it and again when a Turn begins or ends, which is when it may have changed; what was read
 * stays while the next reading is on its way.
 */
function EnvironmentSection({ session, stamp, load, onReveal, harness, tools, onSaid, suggestion }: { readonly session: ConversationView; readonly stamp: string; readonly load: PanelProps["loadWorkspace"]; readonly onReveal: PanelProps["onReveal"]; readonly harness: ReactNode;
  readonly tools: WorkspaceAccess | undefined; readonly onSaid: PanelProps["onSaid"]; readonly suggestion: string }) {
  const [read, setRead] = useState<{ readonly id: string; readonly facts: WorkspaceFacts } | null>(null), reader = useRef(load);
  // Committing is offered where there is something to commit, and reads the state again when it is done.
  const [committing, setCommitting] = useState(false), [again, setAgain] = useState(0);
  reader.current = load;
  useEffect(() => {
    if (reader.current === undefined) return;
    const controller = new AbortController(), id = session.id;
    reader.current(controller.signal).then(facts => { if (!controller.signal.aborted) setRead({ id, facts }); }, () => { /* what was read stays */ });
    return () => controller.abort();
  }, [stamp, session.id, again]);
  const git = read?.id === session.id ? read.facts.git : undefined, path = session.workspace, shown = homePath(path) || folderName(path);
  const folder = <><span className="flex size-4 flex-none items-center justify-center text-fg-3"><Folder size={14} aria-hidden="true"/></span><span className="mono min-w-0 flex-1 trunc text-caption text-fg-2">{shown}</span></>;
  return <Section title="环境"><div className="mt-1 flex flex-col">
    {harness}
    {onReveal ? <button type="button" className="row -mx-2 flex min-h-7 min-w-0 items-center gap-2.5 border-none bg-transparent px-2 text-left text-ui-sm hover:bg-subtle" title={"在访达中显示 " + path} onClick={() => onReveal()}>{folder}</button>
      : <div className="flex min-h-7 min-w-0 items-center gap-2.5 text-ui-sm" title={path}>{folder}</div>}
    {tools?.editors?.length && tools.openIn ? <EditorRow editors={tools.editors} onOpenIn={tools.openIn}/> : null}
    {git !== undefined ? <Line icon={<GitBranch size={14} aria-hidden="true"/>} value={git.dirty > 0 && tools?.commit && tools.git
      ? <button type="button" className="link-btn text-ui-sm" onClick={() => setCommitting(true)}>{git.dirty} 个文件未提交 · 提交…</button> : git.dirty > 0 ? git.dirty + " 个文件未提交" : "没有未提交的改动"}><span className="mono text-caption">{git.branch ?? "不在分支上"}</span></Line> : null}
    {tools?.commit && tools.git ? <CommitDialog open={committing} onClose={() => setCommitting(false)} access={tools} suggestion={suggestion} onDone={said => { onSaid?.(said); setAgain(value => value + 1); }}/> : null}
  </div></Section>;
}
/** The task list: a mark per step (done, in hand, to do), the steps themselves, and what the latest Turn said it came to. */
function ProgressSection({ plan, recap }: { readonly plan: Planned | undefined; readonly recap: RecapItem | undefined }) {
  const steps = plan?.steps ?? [], done = steps.filter(step => step.status === "completed").length;
  return <Section title="进度" figure={steps.length > 0 ? <span>{plan!.owner ? <span className="text-fg-3">{plan!.owner} · </span> : null}{done} / {steps.length}</span> : null}>
    {steps.length > 0 ? <>
      <div className="mt-2 flex h-[3px] gap-[3px]" role="img" aria-label={`已完成 ${done} 步，共 ${steps.length} 步`}>{steps.map((step, index) =>
        <span key={index} className={cn("h-full min-w-0 flex-1 rounded-full transition-colors duration-200 ease-standard", step.status === "completed" ? "bg-fg-3" : step.status === "in_progress" ? "bg-run" : "bg-hover")}/>)}</div>
      {plan!.explanation ? <p className="m-0 mt-2.5 text-ui-sm text-fg-2">{plan!.explanation}</p> : null}
      <ol className="native-plan m-0 mt-2.5 flex list-none flex-col gap-1.5 p-0" aria-label="计划">{planRows(steps).map((row, at) => {
        if (row.kind === "fold") return <li key={"fold" + at} className="pl-[23px] text-caption text-fg-3">另外 {row.count} 步</li>;
        const step = steps[row.index]!;
        return <li key={row.index} className="flex items-start gap-2 text-ui-sm">
          <span role="img" aria-label={step.status === "completed" ? "已完成" : step.status === "in_progress" ? "进行中" : "待办"} className={cn("mt-[2.5px] flex size-[15px] flex-none items-center justify-center", step.status === "completed" ? "text-fg-3" : step.status === "in_progress" ? "text-run" : "text-placeholder")}>
            {step.status === "completed" ? <Check size={15} strokeWidth={1.9} aria-hidden="true"/> : step.status === "in_progress" && plan!.live ? <Spinner size={14} tone="run" label=""/> : <Circle size={15} strokeWidth={1.9} aria-hidden="true"/>}
          </span>
          <span className={cn("min-w-0 flex-1 break-words", step.status === "completed" ? "text-fg-3" : step.status === "in_progress" ? "font-medium text-fg" : "text-fg-2")}>{step.text}</span>
        </li>;
      })}</ol>
    </> : null}
    {recap !== undefined ? <div className={cn("flex flex-col gap-1 border-l-2 border-line pl-2.5", steps.length > 0 ? "mt-3" : "mt-2")}>
      <p className="m-0 text-ui-sm break-words whitespace-pre-wrap text-fg-2">{recap.summary}</p>
      {recap.ask ? <p className="m-0 text-ui-sm font-medium break-words">{recap.ask}</p> : null}
    </div> : null}
  </Section>;
}
/** The task: the conversations working on it (when there is more than this one) and its board, with a way to add to the board. */
function TaskSection({ task, members, current, name, onOpenSession }: { readonly task: ReturnType<typeof useTask>; readonly members: TaskSnapshot["members"]; readonly current: string; readonly name: (id: string) => string; readonly onOpenSession?: ((id: string) => void) | undefined }) {
  const entries = task.task?.board.entries ?? [], many = members.length > 1;
  const [adding, setAdding] = useState(false);
  const harnesses = new Set(members.map(member => member.harnessId)).size;
  const add = adding ? null : <button type="button" className="icon-btn size-6 text-fg-3" aria-label="加一条所有 Harness 都要遵守的要求" title="加一条所有 Harness 都要遵守的要求" onClick={() => setAdding(true)}><Plus size={14} strokeWidth={2}/></button>;
  return <Section title="这件任务" figure={many ? <span>{members.length} 段对话{harnesses > 1 ? " · " + harnesses + " 个 Harness" : ""}</span> : add}>
    {many ? <div className="-mx-2 mt-1.5"><TaskRoster members={members} current={current} onOpen={onOpenSession}/></div> : null}
    {many ? <div className="mt-2.5 flex min-h-6 items-center gap-2"><span className="text-caption text-fg-3">都要遵守的</span><span className="ml-auto flex">{add}</span></div> : null}
    <div className={cn(!many && entries.length > 0 && "mt-1")}><BoardEntries entries={entries} busy={task.busy} onForget={id => task.change({ forget: id })} name={name}/></div>
    {adding ? <div className="mt-1.5"><BoardAdd busy={task.busy} autoFocus onClose={() => setAdding(false)} onAdd={(text, done) => task.change({ kind: "constraint", text }, () => { done(); setAdding(false); })}/></div> : null}
    {task.problem ? <p className="m-0 mt-1.5 text-caption text-red" role="alert">{task.problem}</p> : null}
  </Section>;
}
/** The files changed: the conversation's own with their lines, and how many the other conversations of the task changed. */
function ChangesSection({ changes, total, others, workspace, showChanges }: { readonly changes: ConversationChanges; readonly total: number; readonly others: TaskSnapshot["members"]; readonly workspace: string; readonly showChanges: (asked?: Omit<ChangesWant, "at">) => void }) {
  const add = changes.files.reduce((sum, file) => sum + file.add, 0), del = changes.files.reduce((sum, file) => sum + file.del, 0), most = 6;
  const elsewhere = new Set(others.flatMap(member => member.files)).size;
  return <Section title="改动" onOpen={() => showChanges()} figure={changes.files.length > 0 ? <><span>{changes.files.length} 个文件</span><Lines add={add} del={del}/></>
      : changes.loading ? <Spinner size={12} label="正在读取改动"/> : total > 0 ? <span>{total} 处</span> : null}>
    {changes.files.length > 0 ? <ul className="-mx-2 m-0 mt-1.5 flex list-none flex-col gap-px p-0" aria-label="改动的文件">{changes.files.slice(0, most).map(file =>
      <li key={file.path}><FileRow path={file.path} workspace={workspace} add={file.add} del={file.del} created={file.created} onChoose={() => showChanges({ scope: "all", path: file.path })}/></li>)}</ul> : null}
    {changes.files.length > most ? <button type="button" className="link-btn mt-1 self-start text-caption" onClick={() => showChanges({ scope: "all" })}>另外 {changes.files.length - most} 个文件</button> : null}
    {others.length > 0 ? <button type="button" className="row -mx-2 mt-1.5 flex min-w-0 items-center gap-2 border-none bg-transparent px-2 py-1.5 text-left text-ui-sm text-fg-2 hover:bg-subtle" onClick={() => showChanges({ scope: "task" })}>
      <span className="flex flex-none -space-x-1">{[...new Map(others.map(member => [member.harnessId, member])).values()].slice(0, 4).map(member => <BrandIcon key={member.harnessId} brand={member.harnessId} name={member.harness} size={16} className="ring-2 ring-app"/>)}</span>
      <span className="min-w-0 flex-1 trunc">任务里其他对话改了 {elsewhere} 个文件</span><ChevronRight size={13} strokeWidth={2} aria-hidden="true" className="flex-none text-fg-3"/>
    </button> : null}
  </Section>;
}
/** The bar of a window: how much of it is used, in the accent while there is room and in amber once four fifths are gone. */
function WindowBar({ window, className }: { readonly window: WindowUse; readonly className?: string }) {
  if (window.size === null) return null;
  const share = Math.min(1, window.used / window.size);
  return <div className={cn("h-1 overflow-hidden rounded-full bg-subtle", className)} role="img" aria-label={`上下文已用 ${Math.round(share * 100)}%`}>
    <span className={cn("block h-full rounded-full transition-[width] duration-300 ease-standard", share >= .8 ? "bg-amber-dot" : "bg-accent")} style={{ width: Math.max(share > 0 ? 1.5 : 0, share * 100) + "%" }}/>
  </div>;
}
const percent = (window: WindowUse): string | null => window.size === null ? null : (share => share > 0 && share < .01 ? "不到 1%" : Math.round(share * 100) + "%")(window.used / window.size);
/** The Harness's window: how full it is, and the latest thing that happened to what it holds (a handoff, a compaction, a new native session). */
function ContextSection({ window, runs, relay, name, onOpen }: { readonly window: WindowUse; readonly runs: readonly PublicRun[]; readonly relay: RelayView | undefined; readonly name: (id: string) => string; readonly onOpen: () => void }) {
  const packet = relay?.packets.at(-1), event = contextEvents(runs)[0];
  return <Section title="上下文" figure={percent(window)} onOpen={onOpen}>
    <WindowBar window={window} className="mt-2"/>
    <div className="mt-1.5 flex flex-col">
      <Line icon={<BrandIcon brand={window.harnessId} name={window.harness} size={16}/>}><span className="text-fg tabular-nums">{tokens(window.used)}{window.size === null ? "" : " / " + tokens(window.size)}</span> tokens</Line>
      {event ? <Line wrap icon={<Shrink size={14} aria-hidden="true"/>}>第 {event.n} 轮 · {event.text}</Line> : null}
      {packet ? <Line wrap icon={<ArrowRightLeft size={14} aria-hidden="true"/>}>交接单 #{packet.number} 交给 {name(packet.target.harnessId)} · {packetFacts(packet)}</Line> : null}
    </div>
  </Section>;
}
/**
 * What each Harness holds of the conversation: how full the window is, what happened to the context in the Turns the page holds, where each Harness stands and the
 * packets that were sent.
 */
function ContextPage({ window, runs, relay, name }: { readonly window: WindowUse | null; readonly runs: readonly PublicRun[]; readonly relay: PanelProps["relay"]; readonly name: (id: string) => string }) {
  const events = contextEvents(runs);
  return <div className="flex flex-col">
    {window !== null ? <section className="flex flex-col px-[18px] pt-4 pb-4 hairline-b" aria-label="上下文窗口">
      <div className="flex items-baseline gap-2"><span className="text-[22px] leading-7 font-medium tabular-nums">{percent(window) ?? tokens(window.used)}</span>
        <span className="text-caption text-fg-3">{window.size === null ? "tokens，这个 Harness 没有报窗口大小" : "的窗口已用"}</span></div>
      <WindowBar window={window} className="mt-2.5"/>
      <p className="m-0 mt-2.5 flex min-w-0 items-center gap-1.5 text-caption text-fg-3"><BrandIcon brand={window.harnessId} name={window.harness} size={16}/>
        <span className="min-w-0 trunc">{window.harness} 在第 {window.n} 轮报的：<span className="text-fg-2 tabular-nums">{window.used.toLocaleString()}{window.size === null ? "" : " / " + window.size.toLocaleString()}</span> tokens</span></p>
    </section> : null}
    {events.length > 0 ? <section className="flex flex-col gap-1 px-[18px] pt-3 pb-3.5 hairline-b" aria-label="上下文的变化">
      <span className="text-caption text-fg-3">发生过的</span>
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">{events.map((event, index) => <li key={index} className="flex min-w-0 items-baseline gap-2 text-ui-sm"><span className="w-[52px] flex-none text-caption text-fg-3 tabular-nums">第 {event.n} 轮</span><span className="min-w-0 break-words">{event.text}</span></li>)}</ul>
    </section> : null}
    {relay ? <RelayDetails view={relay.view} name={id => name(id)} onViewPacket={relay.onViewPacket}/> : null}
  </div>;
}

/**
 * The Turn whose facts are shown, as the section's own title: its number, and — in a conversation of several Turns — the list of them behind it (the native list, so it
 * is the platform's own control under a quiet label).
 */
function RunTitle({ runs, run, onRun }: { readonly runs: readonly PublicRun[]; readonly run: PublicRun; readonly onRun: (id: string) => void }) {
  const n = run.protocol?.n ?? runs.indexOf(run) + 1;
  if (runs.length < 2) return <h3 className="m-0 flex-none text-ui font-medium text-fg">本轮</h3>;
  return <h3 className="relative m-0 -ml-1.5 flex flex-none items-center gap-0.5 rounded-row py-0.5 pr-1 pl-1.5 text-ui font-medium text-fg focus-within:shadow-focus hover:bg-subtle">
    第 {n} 轮<ChevronDown size={13} strokeWidth={2} aria-hidden="true" className="text-fg-3"/>
    <select className="absolute inset-0 size-full cursor-pointer appearance-none opacity-0" value={run.id} onChange={event => onRun(event.target.value)} aria-label="选择回合">
      {runs.map((item, index) => <option key={item.id} value={item.id}>第 {item.protocol?.n ?? index + 1} 轮 · {[...item.input].slice(0, 28).join("")}{[...item.input].length > 28 ? "…" : ""}</option>)}
    </select>
  </h3>;
}

/**
 * One changed file: its row, and under it — when opened — its diff as the program reported it, read-only. Under the pointer, or with the keyboard on it, the row's
 * counts give their place to what is done with the file: its path copied, the file shown in the Finder.
 */
function FileDiff({ file, workspace, open, wrap, split, onToggle, name, onReveal, onRemark, onOpenFile }: { readonly file: ChangedFile; readonly workspace: string; readonly open: boolean; readonly wrap: boolean; readonly split: boolean; readonly onToggle: () => void; readonly name: (id: string) => string;
    readonly onReveal?: ((path: string) => void) | undefined; readonly onRemark?: ((remark: DiffRemark) => void) | undefined; readonly onOpenFile?: ((path: string) => void) | undefined }) {
  const panel = useId(), row = useRef<HTMLLIElement>(null), shown = workspacePath(file.path, workspace);
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 1600); return () => clearTimeout(timer); }, [copied]);
  return <li ref={row} className="group/file relative flex min-w-0 flex-col" data-path={file.path}>
    <button type="button" className="row flex h-8 w-full min-w-0 items-center gap-2 border-none bg-transparent px-2 text-left text-ui-sm text-fg hover:bg-subtle" aria-expanded={open} aria-controls={panel} onClick={onToggle} title={file.path}>
      <ChevronRight size={12} strokeWidth={2.2} aria-hidden="true" className={cn("flex-none text-fg-3 motion-rotate", open && "rotate-90")}/>
      <FileMark created={file.created}/><FilePath path={file.path} workspace={workspace}/>
      <span className="flex min-w-[52px] flex-none items-center justify-end gap-1.5 transition-opacity duration-120 ease-standard group-hover/file:opacity-0 group-has-[:focus-visible]/file:opacity-0">
        {file.harnessIds.map(id => <BrandIcon key={id} brand={id} name={name(id)} size={16}/>)}<Lines add={file.add} del={file.del}/></span>
    </button>
    <span className="absolute top-1 right-1.5 flex items-center opacity-0 transition-opacity duration-120 ease-standard group-hover/file:opacity-100 group-has-[:focus-visible]/file:opacity-100">
      <button type="button" className="icon-btn icon-btn-sm text-fg-3" aria-label={"复制路径：" + shown} title={copied ? "已复制" : "复制路径"} onClick={() => { void navigator.clipboard.writeText(shown).then(() => setCopied(true), () => undefined); }}>
        {copied ? <Check size={13} strokeWidth={2} aria-hidden="true"/> : <Copy size={13} strokeWidth={2} aria-hidden="true"/>}</button>
      {onOpenFile ? <button type="button" className="icon-btn icon-btn-sm text-fg-3" aria-label={"打开文件：" + shown} title="打开文件" onClick={() => onOpenFile(file.path)}><FileText size={13} strokeWidth={2} aria-hidden="true"/></button> : null}
      {onReveal ? <button type="button" className="icon-btn icon-btn-sm text-fg-3" aria-label={"在访达中显示：" + shown} title="在访达中显示" onClick={() => onReveal(file.path)}><FolderOpen size={13} strokeWidth={2} aria-hidden="true"/></button> : null}
    </span>
    <Collapsible open={open} id={panel}>
      <section className="mt-0.5 mb-2 min-w-0 overflow-hidden rounded-block bg-surface shadow-hairline" aria-label={"差异：" + shown}>
        {file.diffs.length > 0 ? file.diffs.map((diff, index) => <div key={index} className={cn(index > 0 && "hairline-t")}><DiffBody file={{ ...diff, path: shown }} wrap={wrap} split={split} onRemark={onRemark}/></div>)
          : <p className="m-0 px-3 py-2 text-caption text-fg-3">没有差异文本</p>}
      </section>
    </Collapsible>
  </li>;
}
const WRAP_KEY = "harnesshub:diff-wrap", SPLIT_KEY = "harnesshub:diff-split";
/** Whether a diff shows its two sides beside each other in this browser: one under the other until the user says otherwise. */
function readSplit(): boolean { try { return localStorage.getItem(SPLIT_KEY) === "1"; } catch { return false; } }
/** Whether long lines of a diff fold to the panel's width in this browser: they do until the user says otherwise (the panel is narrow). */
function readWrap(): boolean { try { return localStorage.getItem(WRAP_KEY) !== "0"; } catch { return true; } }
/**
 * The changed files, each with its diff under it (2026-11-14, after the diff panel of T3 Code): this Turn's files, the whole conversation's, or — in a task with other
 * conversations — what each of those changed. Above them the scope, the lines the shown files gained and lost, and one control that opens or closes them all; a file opens
 * to its diff, read-only, and names the Harness that made it. The scopes carry the changes each holds, counted as the tab and the header's button count them. Another
 * conversation's files are named with the way to that conversation, where their diffs are.
 */
function Changes({ changes, selected, workspace, name, sessionId, members, want, onOpenSession, onReveal, onRemark, onOpenFile, git }: { readonly changes: ConversationChanges; readonly selected: PublicRun | null;
    readonly workspace: string; readonly name: (id: string) => string; readonly sessionId: string; readonly members: TaskSnapshot["members"]; readonly want: ChangesWant | null; readonly onOpenSession?: ((id: string) => void) | undefined;
    readonly onReveal?: ((path: string) => void) | undefined; readonly onRemark?: ((remark: DiffRemark) => void) | undefined; readonly onOpenFile?: ((path: string) => void) | undefined; readonly git?: GitAccess | undefined }) {
  const [scope, setScope] = useState<ChangesScope>("all");
  // A Git scope shown in place of the Hub's (2026-11-14): what is not committed, a commit, or the branch against another; and whether spaces count in its comparison.
  const [gitScope, setGitScope] = useState<GitScope | null>(null), [whitespace, setWhitespace] = useState(false);
  const [wrap, setWrap] = useState(readWrap), [split, setSplit] = useState(readSplit);
  const beside = () => setSplit(value => { try { localStorage.setItem(SPLIT_KEY, value ? "0" : "1"); } catch { /* lasts for this page only */ } return !value; });
  const fold = () => setWrap(value => { try { localStorage.setItem(WRAP_KEY, value ? "0" : "1"); } catch { /* lasts for this page only */ } return !value; });
  // The files the user opened or closed by hand; until then a short list is open whole and a long one at its first file.
  const [chosen, setChosen] = useState<ReadonlySet<string> | null>(null);
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => { setChosen(null); setScope("all"); setGitScope(null); }, [sessionId]);
  // An asking is met once: at once for a scope, and for a file when the files are read (it names the file as its Turn does, which may be from another root).
  const met = useRef(0);
  useEffect(() => {
    if (want === null || met.current === want.at) return;
    if (want.scope !== undefined) { setScope(want.scope); setGitScope(null); }
    const asked = want.path, found = asked === undefined ? undefined : changes.files.find(file => samePath(file.path, asked));
    if (asked !== undefined && found === undefined && changes.loading) return;
    met.current = want.at;
    if (found === undefined) { if (asked !== undefined || want.scope !== undefined) setChosen(null); return; }
    const path = found.path;
    setChosen(new Set([path]));
    requestAnimationFrame(() => { for (const item of list.current?.children ?? []) if ((item as HTMLElement).dataset.path === path) item.scrollIntoView({ block: "nearest" }); });
  }, [want, changes.files, changes.loading]);
  const others = members.filter(member => member.sessionId !== sessionId && member.files.length > 0);
  if (!changes.edits && others.length === 0 && git === undefined) return <EmptyState icon={<FileText size={22}/>} title="还没有改动"/>;
  const turn = selected ? changes.files.filter(file => file.runIds.has(selected.id)).map(file => fileIn(file, selected.id)) : [];
  const shownScope: ChangesScope = scope === "task" && others.length === 0 ? "all" : scope;
  const files = shownScope === "turn" ? turn : changes.files;
  const open = chosen ?? new Set(files.length <= 3 ? files.map(file => file.path) : files.slice(0, 1).map(file => file.path));
  const every = files.length > 0 && files.every(file => open.has(file.path));
  const toggle = (path: string) => { const next = new Set(open); if (!next.delete(path)) next.add(path); setChosen(next); };
  const add = files.reduce((sum, file) => sum + file.add, 0), del = files.reduce((sum, file) => sum + file.del, 0);
  return <div className="flex flex-col">
    <div className="flex min-h-11 items-center gap-2 pr-2.5 pl-3.5">
      {/* The Hub's scopes, and Git's beside them; while a Git scope is shown, none of the Hub's is chosen. */}
      <Segmented label="改动范围" value={gitScope !== null ? "none" as unknown as ChangesScope : shownScope} onChange={value => { setGitScope(null); setScope(value); }}
        options={[{ value: "turn" as const, label: "本轮" }, { value: "all" as const, label: "这段对话" }, ...(others.length > 0 ? [{ value: "task" as const, label: "其他对话" }] : [])]}/>
      {git !== undefined ? <GitScopeMenu access={git} scope={gitScope} onScope={setGitScope}/> : null}
      {gitScope !== null ? <span className="ml-auto flex flex-none items-center gap-1">
        <button type="button" className="icon-btn size-7 text-fg-3" aria-label="忽略空白" aria-pressed={whitespace} title={whitespace ? "忽略空白：开" : "忽略空白：关"} onClick={() => setWhitespace(value => !value)}><Space size={14} strokeWidth={2}/></button>
        <button type="button" className="icon-btn size-7 text-fg-3" aria-label="并排显示" aria-pressed={split} title={split ? "并排显示：开" : "并排显示：关"} onClick={beside}><Columns2 size={14} strokeWidth={2}/></button>
        <button type="button" className="icon-btn size-7 text-fg-3" aria-label="长行折行" aria-pressed={wrap || split} disabled={split} title={split ? "并排时长行总是折行" : wrap ? "长行折行：开" : "长行折行：关"} onClick={fold}><WrapText size={14} strokeWidth={2}/></button></span>
      : shownScope !== "task" && files.length > 0 ? <span className="ml-auto flex flex-none items-center gap-1"><span className="mr-1 flex items-center gap-1.5"><Lines add={add} del={del}/></span>
        <button type="button" className="icon-btn size-7 text-fg-3" aria-label="并排显示" aria-pressed={split} title={split ? "并排显示：开" : "并排显示：关"} onClick={beside}><Columns2 size={14} strokeWidth={2}/></button>
        <button type="button" className="icon-btn size-7 text-fg-3" aria-label="长行折行" aria-pressed={wrap || split} disabled={split} title={split ? "并排时长行总是折行" : wrap ? "长行折行：开" : "长行折行：关"} onClick={fold}><WrapText size={14} strokeWidth={2}/></button>
        <button type="button" className="icon-btn size-7 text-fg-3" aria-label={every ? "全部收起" : "全部展开"} title={every ? "全部收起" : "全部展开"} onClick={() => setChosen(every ? new Set() : new Set(files.map(file => file.path)))}>
          {every ? <ChevronsDownUp size={14} strokeWidth={2}/> : <ChevronsUpDown size={14} strokeWidth={2}/>}</button></span> : null}
    </div>
    {gitScope !== null && git !== undefined ? <GitChanges access={git} scope={gitScope} workspace={workspace} wrap={wrap} split={split} whitespace={whitespace} onRemark={onRemark}
      stamp={String(changes.edits) + ":" + changes.files.length + ":" + (selected?.id ?? "") + ":" + (selected?.status ?? "")}/>
      : shownScope === "task" ? <div className="flex flex-col gap-3 px-2.5 pb-4">{others.map(member => <section key={member.sessionId} className="flex min-w-0 flex-col" aria-label={member.harness + " 改动的文件"}>
      <div className="flex min-w-0 items-center gap-2 px-2 py-1.5"><BrandIcon brand={member.harnessId} name={member.harness} size={18}/>
        <span className="flex min-w-0 flex-1 flex-col"><span className="trunc text-ui-sm">{oneLine(member.task) || member.harness}</span><span className="trunc text-caption text-fg-3">{member.harness} · {member.files.length} 个文件</span></span>
        {onOpenSession ? <button type="button" className="link-btn flex-none text-caption" onClick={() => onOpenSession(member.sessionId)}>打开这段对话</button> : null}</div>
      <ul className="m-0 flex list-none flex-col gap-px p-0">{member.files.map(path => <li key={path}><FileRow path={path} workspace={workspace}/></li>)}</ul>
    </section>)}</div> : <>
      {files.length ? <ul ref={list} className="m-0 flex list-none flex-col gap-px px-2.5 pb-2" aria-label="改动的文件">{files.map(file =>
        <FileDiff key={file.path} file={file} workspace={workspace} open={open.has(file.path)} wrap={wrap} split={split} onToggle={() => toggle(file.path)} name={name} onReveal={onReveal} onRemark={onRemark} onOpenFile={onOpenFile}/>)}</ul> : null}
      {changes.unread > 0 ? <p className="m-0 flex items-center gap-2 px-4 pb-3 text-caption text-fg-3"><button type="button" className="link-btn text-caption" onClick={changes.more}>更早的 {changes.unread} 处编辑</button></p> : null}
      {changes.loading ? <p className="m-0 flex items-center gap-1.5 px-4 pb-3 text-caption text-fg-3"><Spinner size={12} label=""/>正在读取改动…</p> : null}
      {changes.failures.length ? <p className="m-0 px-4 pb-3 text-caption text-red">{changes.failures.length} 处改动读取失败：{changes.failures[0]}</p> : null}
      {files.length === 0 && !changes.loading && !changes.failures.length ? <p className="m-0 px-4 pb-4 text-caption text-fg-3">{shownScope === "turn" && changes.files.length ? "这一轮没有改动文件" : "这段对话没有改动文件"}</p> : null}
    </>}
  </div>;
}

/** How a Turn spent its time, as one bar: starting the program, waiting for the first output, then the reply and its tools. */
function Phases({ run }: { readonly run: PublicRun }) {
  const now = useNow(!finished(run.status)), timing = run.timing;
  if (!timing) return null;
  const rows: [string, number | undefined, number | undefined, string][] = [
    ["启动", timing.preparingAt, timing.readyAt, "bg-placeholder"],
    ["等首个输出", timing.dispatchedAt, timing.firstOutputAt, "bg-fg-2"],
    ["回复与工具", timing.firstOutputAt, timing.endedAt ?? (finished(run.status) ? undefined : now), "bg-accent"],
  ];
  const visible = rows.flatMap(([label, from, to, tone]) => from !== undefined && to !== undefined ? [{ label, span: Math.max(0, to - from), tone }] : []);
  const total = visible.reduce((sum, row) => sum + row.span, 0);
  if (!visible.length || total <= 0) return null;
  return <section className="flex flex-col gap-2" aria-label="本轮阶段">
    <div className="flex h-[5px] gap-[2px] overflow-hidden rounded-full">{visible.map(row => <span key={row.label} className={cn("h-full min-w-[3px] rounded-full", row.tone)} style={{ flexGrow: Math.max(row.span, total * .012), flexBasis: 0 }}/>)}</div>
    <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-caption text-fg-2">{visible.map(row => <li key={row.label} className="flex items-center gap-1.5">
      <span className={cn("size-[7px] flex-none rounded-full", row.tone)} aria-hidden="true"/><span className="text-fg-3">{row.label}</span><span className="tabular-nums">{duration(row.span)}</span></li>)}</ul>
  </section>;
}
/**
 * One Turn in the list of every Turn's steps: what was asked, who ran it and what it did, opened to its steps. A Turn in progress
 * carries the blue dot of work going on; while it waits for the user (`waiting`) its dot is the amber one of waiting, named as the
 * header names it. A Turn waiting in the queue has not started: a still grey dot (ruling N).
 */
function RunProcess({ run, open, onToggle, loadToolDetail, name, now, waiting }: { readonly run: PublicRun; readonly open: boolean; readonly onToggle: () => void; readonly loadToolDetail: ToolDetailLoader | undefined; readonly name: (id: string) => string; readonly now: number; readonly waiting: string | null }) {
  const turn = run.protocol, active = !finished(run.status), panel = useId();
  const harness = turn?.executor.harness ?? name(run.selection.harnessId), summary = turn === undefined ? "" : summarizeGroup(ownWork(turn)).text;
  const time = turn === undefined ? "" : turn.durationMs !== undefined ? spentText(turn.durationMs) : active && turn.startedAt !== undefined ? elapsed(now - turn.startedAt) : "";
  const started = run.timing?.acceptedAt === undefined ? undefined : new Date(run.timing.acceptedAt).toLocaleString("zh-CN", { hour12: false });
  return <li className="flex min-w-0 flex-col">
    <button type="button" className="row flex w-full min-w-0 items-start gap-2.5 border-none bg-transparent px-2 py-1.5 text-left hover:bg-subtle" aria-expanded={open} aria-controls={panel} onClick={onToggle} {...(started ? { title: started } : {})}>
      <BrandIcon brand={turn?.executor.harnessId ?? run.selection.harnessId} name={harness} size={18} className="mt-px"/>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="trunc text-ui-sm text-fg">{oneLine(run.input) || harness}</span>
        <span className="trunc text-caption text-fg-3">{[harness, summary, time].filter(Boolean).join(" · ")}</span>
      </span>
      {active ? <span className="mt-[7px] flex flex-none">{waiting ? <StatusDot tone="wait" label={waiting}/> : stateOf(run) === "queued" ? <StatusDot tone="idle" label={TURN_STATUS_WORDS.queued}/> : <StatusDot tone="run" label={TURN_STATUS_WORDS.running}/>}</span> : null}
      <ChevronRight size={12} strokeWidth={2.2} aria-hidden="true" className={cn("mt-1 flex-none text-fg-3 motion-rotate", open && "rotate-90")}/>
    </button>
    <Collapsible open={open} id={panel}>
      <div className="mt-0.5 mb-2 ml-[17px] flex min-w-0 flex-col border-l border-line pl-2">
        {turn === undefined ? <p className="m-0 px-1.5 py-1 text-caption text-red">这一轮无法显示：{run.protocolProblem ?? "服务没有给出这一轮的协议数据"}</p>
          : ownWork(turn).length || turn.items.some(item => item.type === "reasoning" || item.type === "context_event") ? <TurnSteps run={run} turn={turn} loadDetail={loadToolDetail} asking={waiting === "等你批准"}/>
          : <p className="m-0 px-1.5 py-1 text-caption text-fg-3">没有调用工具</p>}
      </div>
    </Collapsible>
  </li>;
}
/** Every Turn's steps, oldest first, the chosen one open. */
function Process({ run, runs, onRun, loadToolDetail, name, waiting }: { readonly run: PublicRun; readonly runs: readonly PublicRun[]; readonly onRun: (id: string) => void; readonly loadToolDetail: ToolDetailLoader | undefined; readonly name: (id: string) => string; readonly waiting: (run: PublicRun) => string | null }) {
  const [closed, setClosed] = useState<string | null>(null);
  const now = useNow(runs.some(item => !finished(item.status)));
  return <ol className="m-0 flex list-none flex-col gap-px px-2 pt-2 pb-4">{runs.map(item => <RunProcess key={item.id} run={item} open={item.id === run.id && closed !== item.id} now={now} name={name} loadToolDetail={loadToolDetail} waiting={waiting(item)}
    onToggle={() => { if (item.id === run.id) setClosed(closed === item.id ? null : item.id); else { setClosed(null); onRun(item.id); } }}/>)}</ol>;
}
function Background({ session, kept, items, busy, onEndProcess, name }: { readonly session: ConversationView; readonly kept: NonNullable<SessionHeadView["retention"]>["process"] | null; readonly items: readonly BackgroundRow[]; readonly busy: boolean; readonly onEndProcess?: (() => void) | undefined; readonly name: (id: string | undefined) => string }) {
  const now = useNow(kept !== null), keeper = kept ? name(kept.harnessId) : "原程序";
  return <div className="flex flex-col gap-3 px-4 pt-3 pb-4">
    {kept ? <div className="kept-panel flex flex-col gap-2 rounded-block bg-surface p-3 shadow-hairline">
      <div className="flex items-center gap-2"><StatusDot tone="run"/><strong className="text-ui-sm font-medium">{keeper} 保留在后台</strong></div>
      <div className="flex flex-wrap items-center gap-3 text-caption text-fg-3"><span>后台活动 {kept.backgroundUpdates} 条</span><span>{Math.max(1, Math.round((kept.idleEndsAt - now) / 60000))} 分钟后结束</span></div>
      {onEndProcess ? <button type="button" className="btn btn-sm self-start" disabled={busy} onClick={onEndProcess}>结束后台进程</button> : null}
    </div> : null}
    {session.retention?.upgraded ? <p className="kept-upgraded m-0 rounded-block bg-subtle px-3 py-2.5 text-ui-sm text-fg-2">升级 {name(session.retention.upgraded.harnessId)} 前，HarnessHub 关闭了这个对话保留的后台进程。下一条消息会用新版本重新启动原程序。</p> : null}
    {session.retention?.outside ? <p className="m-0 rounded-block bg-subtle px-3 py-2.5 text-ui-sm text-fg-2">原程序的后台任务可能仍在运行（{session.retention.outside.count} 个进程）：它们已离开原程序的进程组，HarnessHub 没有结束它们。</p> : null}
    {items.length ? <ul className="m-0 flex list-none flex-col gap-px p-0">{items.map(({ item }) => <li key={item.id} className="flex min-h-[30px] items-center gap-2.5 px-1 text-ui-sm">
      <StatusDot tone={item.status === "running" ? "run" : item.status === "failed" ? "fail" : "idle"}/>
      <span className="min-w-0 flex-1"><span className="text-fg-3">{item.type === "subagent" ? "子任务" : "后台命令"} · </span>{item.type === "subagent" ? item.title : oneLine(item.command)}</span>
      <span className={cn("flex-none text-caption", item.status === "failed" ? "text-red" : "text-fg-3")}>{ITEM_STATUS_WORDS[item.status]}</span></li>)}</ul> : null}
  </div>;
}
/** The facts of one Turn: who ran it with which model and where, how it stands, what it took (time, tokens, money) and how the time was spent. */
function RunSection(props: PanelProps & { readonly run: PublicRun; readonly runs: readonly PublicRun[] }) {
  const { run, session } = props, turn = run.protocol, terminal = finished(run.status);
  const harnessId = turn?.executor.harnessId ?? run.selection.harnessId;
  const harness = props.harnesses.find(row => row.id === harnessId), provider = props.providers.find(row => row.id === run.selection.provider?.providerId);
  const version = harness?.management.programVersion ?? harness?.management.installedVersion;
  const model = turn?.executor.model, usage = turn?.usage, counted = usage !== undefined && (usage.completeness === "complete" || usage.completeness === "partial");
  const state = waitingWords(session, run) ?? (turn === undefined ? TURN_STATUS_WORDS[stateOf(run)] : statusText(turn));
  return <Section title="本轮" heading={<RunTitle runs={props.runs} run={run} onRun={props.onRun}/>} figure={<span className={cn("run-state min-w-0 trunc", !terminal && "text-accent-text")} title={state}>{state}</span>} className="execution-details">
    <div className="mt-1 flex flex-col">
      <Line icon={<BrandIcon brand={harnessId} name={turn?.executor.harness ?? harness?.name ?? harnessId} size={16}/>} value={model ? <span title={model.id}>{model.label}</span> : null}>
        <span className="text-fg">{turn?.executor.harness ?? harness?.name ?? harnessId}</span>{version ? <span className="text-fg-3"> {version}</span> : null}</Line>
      {provider ? <Line icon={<Plug size={14} aria-hidden="true"/>} value={<span>{provider.name}</span>}>模型连接</Line> : null}
      {turn?.durationMs !== undefined ? <Line icon={<Timer size={14} aria-hidden="true"/>} value={spentText(turn.durationMs)}>用时</Line> : null}
      {counted && usage!.input !== undefined ? <Line icon={<ArrowDownToLine size={14} aria-hidden="true"/>} title={usage!.input.toLocaleString() + " tokens" + (usage!.cachedInput !== undefined ? "，其中缓存 " + usage!.cachedInput.toLocaleString() : "")}
        value={tokens(usage!.input)}>{usage!.completeness === "complete" ? "输入" : "输入（可能不全）"}{usage!.cachedInput !== undefined && usage!.cachedInput > 0 ? <span className="text-fg-3">（其中缓存 {tokens(usage!.cachedInput)}）</span> : null}</Line> : null}
      {counted && usage!.output !== undefined ? <Line icon={<ArrowUpFromLine size={14} aria-hidden="true"/>} title={usage!.output.toLocaleString() + " tokens"} value={tokens(usage!.output)}>输出</Line> : null}
      {usage?.cost !== undefined && usage.cost.amount > 0 ? <Line icon={<CircleDollarSign size={14} aria-hidden="true"/>} value={moneyText(usage.cost)}>费用{usage.cost.scope === "turn" ? "" : <span className="text-fg-3">（{usage.cost.scope === "session" ? "原生会话累计" : "整个对话累计"}）</span>}</Line> : null}
    </div>
    {run.timing ? <div className="mt-3"><Phases run={run}/></div> : null}
    {turn === undefined ? <p className="m-0 mt-3 text-caption text-red">这一轮无法显示：{run.protocolProblem ?? "服务没有给出这一轮的协议数据"}</p> : null}
    {run.error ? <p className="m-0 mt-3 text-caption text-fg-2">错误代码 <code className="text-code">{run.error.code}</code></p> : null}
    {turn?.status === "unknown" ? <p className="m-0 mt-3 rounded-block bg-amber-soft px-3 py-2.5 text-ui-sm text-amber-on-tint">结果未知，不会自动重新执行。</p> : null}
    {props.loadDiagnostics && terminal ? <div className="mt-3.5"><RunDiagnostics key={run.id} runId={run.id} load={props.loadDiagnostics}/></div> : null}
  </Section>;
}
