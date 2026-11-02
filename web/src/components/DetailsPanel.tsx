import { ChevronRight, Clock, File, FileText, ListChecks, X } from "lucide-react";
import { Fragment, useEffect, useId, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { PublicRun } from "../../../src/contracts/session.js";
import type { HarnessView, NativeResumeView, SessionView } from "../../../src/contracts/web.js";
import type { ProviderView } from "../../../src/contracts/provider.js";
import { errorMessage } from "../api.js";
import { cn } from "../lib/cn.js";
import { duration, elapsed, folderName, homePath, workspacePath } from "../lib/format.js";
import { useNow } from "../lib/prefs.js";
import { askingStep, cancelledWords, changeCount, editTools, finished, knownToolDetail, parseUnifiedDiff, readToolDetail, RUN_STATE, runDuration, spentText, toolSummary, type DiffFile } from "../lib/turn.js";
import { Collapsible } from "../ui/motion.js";
import { EmptyState, Fact, Segmented, Spinner, StatusDot, Tabs } from "../ui/primitives.js";
import { ACTIVITY_KIND, ACTIVITY_STATUS, DiffLines, PlanView, ToolList, usageFacts, type ToolDetailLoader } from "./Activity.js";
import { dockedRequest } from "./Approval.js";
import { BrandIcon } from "./BrandIcon.js";
import { NativeResume } from "./NativeResume.js";

export type PanelTab = "changes" | "process" | "plan" | "background" | "run";

/** One changed file of the conversation, merged over every edit that touched it, with the Turns and Agents that did. */
export interface ChangedFile {
  readonly path: string; readonly add: number; readonly del: number;
  /** The first edit of the file created it. */
  readonly created: boolean;
  readonly diffs: readonly DiffFile[];
  readonly runIds: ReadonlySet<string>;
  /** The Harnesses whose Turns made these edits, in the order they first did. */
  readonly harnessIds: readonly string[];
}
export interface ConversationChanges {
  /** Files with a diff, merged by path, in the order they were first changed. */
  readonly files: readonly ChangedFile[];
  /** Edit steps with stored detail (at most the latest 40 are read). */
  readonly edits: number;
  /** Some details are still being read: counts are not final. */
  readonly loading: boolean;
  /** Why details could not be read, one per detail. */
  readonly failures: readonly string[];
}
/**
 * The files the conversation changed, from the diffs its edit steps reported (ADR-042: read-only, nothing here undoes a
 * change). The latest 40 edit details are read once per page, only while the panel is shown, and shared with the steps that
 * show them; a detail that could not be read is reported once and not asked for again by this view. The numbers the button,
 * the tab and the scopes show are changeCount()'s, which needs no read.
 */
export function useConversationChanges(runs: readonly PublicRun[], load: ToolDetailLoader | undefined): ConversationChanges {
  const edits = useMemo(() => runs.flatMap(run => editTools(run).map(tool => ({ run, tool }))).slice(-40), [runs]);
  const [failures, setFailures] = useState<ReadonlyMap<string, string>>(new Map());
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!load) return;
    let current = true;
    for (const { tool } of edits) {
      const content = tool.detail;
      if (!content || knownToolDetail(content.id) !== undefined || failures.has(content.id)) continue;
      readToolDetail(content, load).then(() => { if (current) setVersion(value => value + 1); },
        (error: unknown) => { if (current) setFailures(previous => new Map(previous).set(content.id, errorMessage(error))); });
    }
    return () => { current = false; };
  }, [edits, load, failures]);
  return useMemo(() => {
    const merged = new Map<string, { path: string; add: number; del: number; created: boolean; diffs: DiffFile[]; runIds: Set<string>; harnessIds: string[] }>();
    for (const { run, tool } of edits) {
      const detail = tool.detail ? knownToolDetail(tool.detail.id) : undefined;
      if (!detail?.diff) continue;
      for (const file of parseUnifiedDiff(detail.diff, detail.locations?.[0] ?? tool.title)) {
        const entry = merged.get(file.path) ?? { path: file.path, add: 0, del: 0, created: file.created, diffs: [], runIds: new Set<string>(), harnessIds: [] };
        entry.add += file.add; entry.del += file.del; entry.diffs.push(file); entry.runIds.add(run.id);
        if (!entry.harnessIds.includes(run.selection.harnessId)) entry.harnessIds.push(run.selection.harnessId);
        merged.set(file.path, entry);
      }
    }
    const loading = edits.some(({ tool }) => tool.detail !== undefined && knownToolDetail(tool.detail.id) === undefined && !failures.has(tool.detail.id));
    return { files: [...merged.values()], edits: edits.length, loading, failures: [...failures.values()] };
    // `version` changes when a detail arrives in the shared store, which this reads.
  }, [edits, failures, version]);
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
  return <section className="run-diagnostics flex flex-col gap-2 hairline-t pt-3.5" aria-label="诊断信息">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2"><button type="button" className="btn btn-sm diagnostics-copy" disabled={state === "busy"} onClick={() => void copy()}>{state === "busy" ? <><Spinner size={12} label=""/>正在准备诊断信息…</> : "复制诊断信息"}</button>
      <label className="flex items-center gap-1.5 text-caption text-fg-2"><input type="checkbox" className="accent-accent" checked={content} onChange={event => { setContent(event.target.checked); setState("idle"); }}/>包含这一轮的提示词与回复</label></div>
    <p className={cn("m-0 text-caption", state === "failed" ? "text-red" : "text-fg-3")} role="status">{state === "copied" ? `已复制诊断信息（${content ? "含" : "不含"}对话内容）。` : state === "failed" ? "无法复制诊断信息，请稍后再试。"
      : "包含版本、各阶段耗时、结束原因、清理状态与本回合 stderr 的最后 4 KiB；已隐去路径、环境变量值和密钥样式的字符串。默认不含对话内容。"}</p>
  </section>;
}

interface PanelProps {
  readonly session: SessionView; readonly harnesses: readonly HarnessView[]; readonly providers: readonly ProviderView[];
  readonly tab: PanelTab; readonly onTab: (tab: PanelTab) => void; readonly runId: string | null; readonly onRun: (id: string) => void;
  readonly describe: (run: PublicRun) => string; readonly loadToolDetail?: ToolDetailLoader | undefined;
  readonly loadDiagnostics?: ((runId: string, includeContent: boolean) => Promise<string>) | undefined;
  readonly loadNativeResume?: ((signal: AbortSignal) => Promise<NativeResumeView | null>) | undefined;
  readonly onEndProcess?: (() => void) | undefined; readonly busy: boolean; readonly onClose?: (() => void) | undefined;
}
/**
 * The conversation's details beside it (ADR-054 §5): its changed files (this Turn or the whole conversation), the plan,
 * every Turn's steps, background work and one Turn's execution facts. The tabs' underline slides to the chosen tab (Motion
 * board #24). How the panel comes in is its container's: beside the conversation, ChatPage slides the content in 60 ms after
 * the panel (#23, not when opened from the keyboard, #37); a drawer or a sheet moves by itself. The panel adds no motion of
 * its own, so its content never slides twice.
 */
export function DetailsPanel(props: PanelProps) {
  const { session, tab } = props;
  const runs = session.runs;
  const selected = runs.find(run => run.id === props.runId) ?? runs.at(-1) ?? null;
  const changes = useConversationChanges(runs, props.loadToolDetail);
  const planRun = [...runs].reverse().find(run => run.plan?.entries.length), plan = planRun?.plan;
  const kept = session.retention?.process ?? null;
  const background = runs.flatMap(run => (run.activities ?? []).filter(activity => activity.kind === "task" || activity.kind === "subagent").map(activity => ({ run, activity })));
  const running = background.filter(item => item.activity.status === "running").length + (kept ? 1 : 0);
  const name = (id: string | undefined) => props.harnesses.find(row => row.id === id)?.name ?? id ?? "Agent";
  // The header button's number, from the same summaries: shown at once, never waiting for a diff to be read.
  const total = changeCount(runs);
  // The step a Run's waiting approval asks for says what it wants to do here as in its Turn (ruling J).
  const asking = (run: PublicRun) => waitingWords(session, run) === "等你批准" ? askingStep(run.tools ?? [])?.id : undefined;
  const tabs = [
    { id: "changes" as const, label: "改动", count: total || null },
    { id: "plan" as const, label: "计划" }, { id: "process" as const, label: "过程" },
    { id: "background" as const, label: "后台", count: running || null }, { id: "run" as const, label: "执行" },
  ];
  return <div className="details-panel flex h-full min-h-0 w-full min-w-0 flex-col bg-app">
    <div className="flex h-[54px] flex-none items-stretch gap-2 pr-3 pl-[18px] hairline-b">
      <Tabs className="h-full min-w-0 flex-1 [&>.tab]:h-full" items={tabs} value={tab} onChange={props.onTab} label="详情分类" idPrefix="details-tab" panelId="details-tabpanel"/>
      {props.onClose ? <button type="button" className="icon-btn size-7 self-center text-fg-3" aria-label="关闭详情栏" title="关闭详情栏" onClick={props.onClose}><X size={14} strokeWidth={2}/></button> : null}
    </div>
    <div className="scroll-area min-h-0 flex-1" role="tabpanel" id="details-tabpanel" aria-labelledby={`details-tab-${tab}`}>
      {tab === "changes" ? <Changes changes={changes} counts={{ turn: selected ? changeCount([selected]) : 0, all: total }} selected={selected} workspace={session.workspace} name={name} sessionId={session.id}/>
        : tab === "process" ? selected ? <Process run={selected} runs={runs} onRun={props.onRun} describe={props.describe} loadToolDetail={props.loadToolDetail} name={name} asking={asking} waiting={run => waitingWords(session, run)}/> : <Empty>这个对话还没有执行记录。</Empty>
        : tab === "plan" ? plan ? <div className="px-4 pt-3 pb-4"><PlanView plan={plan} owner={name(planRun?.selection.harnessId)}/></div> : <EmptyState icon={<ListChecks size={22}/>} title="还没有计划">Agent 报告计划后会显示在这里。</EmptyState>
        : tab === "background" ? <Background session={session} kept={kept} items={background} busy={props.busy} onEndProcess={props.onEndProcess} name={name}/>
        : selected ? <RunFacts {...props} run={selected} runs={runs}/> : <Empty>发出第一条消息后，这里会显示执行者、阶段耗时与用量。</Empty>}
    </div>
  </div>;
}
function Empty({ children }: { readonly children: ReactNode }) { return <p className="m-0 px-4 py-10 text-center text-ui-sm text-fg-3">{children}</p>; }
/**
 * What a Run in progress waits for from the user, in the words the header, the sidebar and the Turn use for it (decision G):
 * 等你批准 while an approval waits in the composer's place, 等你回答 while only another request does. Null when nothing
 * waits or the Run has ended.
 */
function waitingWords(session: SessionView, run: PublicRun): "等你批准" | "等你回答" | null {
  if (finished(run.status)) return null;
  const open = (session.permissions ?? []).filter(request => request.runId === run.id && !request.decided);
  return open.length === 0 ? null : open.some(dockedRequest) ? "等你批准" : "等你回答";
}
function RunPicker({ runs, run, onRun }: { readonly runs: readonly PublicRun[]; readonly run: PublicRun; readonly onRun: (id: string) => void }) {
  if (runs.length < 2) return null;
  return <label className="flex items-center gap-2 text-caption text-fg-2"><span className="flex-none">回合</span>
    <select className="field h-8 min-w-0 flex-1 py-0 text-caption" value={run.id} onChange={event => onRun(event.target.value)} aria-label="选择回合">
      {runs.map((item, index) => <option key={item.id} value={item.id}>第 {index + 1} 轮 · {[...item.input].slice(0, 24).join("")}{[...item.input].length > 24 ? "…" : ""}</option>)}
    </select></label>;
}

/**
 * Each changed file with its diff as the program reported it (Conversation board): this Turn's files or the whole
 * conversation's, a list with lines added and removed, and the chosen file's diff, read-only, naming the Agent that made it.
 * The scopes carry the changes each holds, counted as the tab and the header's button count them.
 */
function Changes({ changes, counts, selected, workspace, name, sessionId }: { readonly changes: ConversationChanges; readonly counts: { readonly turn: number; readonly all: number }; readonly selected: PublicRun | null; readonly workspace: string; readonly name: (id: string) => string; readonly sessionId: string }) {
  const [scope, setScope] = useState<"turn" | "all">("all");
  const [chosen, setChosen] = useState<string | null>(null);
  useEffect(() => { setChosen(null); setScope("all"); }, [sessionId]);
  if (!changes.edits) return <EmptyState icon={<FileText size={22}/>} title="还没有改动">Agent 在这个对话里编辑文件后，改动会按文件列在这里，只读，不提供撤销。</EmptyState>;
  const turn = selected ? changes.files.filter(file => file.runIds.has(selected.id)) : [];
  const files = scope === "turn" ? turn : changes.files;
  const current = files.find(file => file.path === chosen) ?? files[0];
  return <div className="flex flex-col">
    {/* Conversation board: the scope sits right under the tabs, the files 10 px below it */}
    <div className="flex items-center gap-2 px-3.5 pt-1 pb-2.5">
      <Segmented label="改动范围" value={scope} onChange={setScope} options={[{ value: "turn", label: "本轮 " + counts.turn }, { value: "all", label: "整个对话 " + counts.all }]}/>
    </div>
    {files.length ? <ul className="m-0 flex list-none flex-col gap-px px-2.5 pb-2" aria-label="改动的文件">{files.map(file => {
      const shown = workspacePath(file.path, workspace), cut = shown.lastIndexOf("/") + 1;
      return <li key={file.path}><button type="button" onClick={() => setChosen(file.path)} aria-pressed={current?.path === file.path} title={file.path}
        className={cn("row flex h-8 w-full min-w-0 items-center gap-2 border-none px-2.5 text-left font-mono text-caption text-fg", current?.path === file.path ? "bg-subtle" : "bg-transparent hover:bg-subtle")}>
        <File size={15} className="flex-none text-fg-3" aria-hidden="true"/>
        <span className="min-w-0 flex-1 trunc"><span className="text-fg-3">{shown.slice(0, cut)}</span>{shown.slice(cut)}</span>
        {file.add ? <span className="flex-none text-[11px] text-add-on-tint">+{file.add}</span> : null}{file.del ? <span className="flex-none text-[11px] text-del-on-tint">−{file.del}</span> : null}
      </button></li>;
    })}</ul> : null}
    {changes.loading ? <p className="m-0 flex items-center gap-1.5 px-4 pb-3 text-caption text-fg-3"><Spinner size={12} label=""/>正在读取改动…</p> : null}
    {changes.failures.length ? <p className="m-0 px-4 pb-3 text-caption text-red">{changes.failures.length} 处改动读取失败：{changes.failures[0]}</p> : null}
    {current ? <section className="mx-3 mt-1 mb-3 min-w-0 overflow-hidden rounded-block bg-surface shadow-hairline" aria-label={"差异：" + workspacePath(current.path, workspace)}>
      <div className="flex h-9 items-center gap-2 px-3 text-caption text-fg-3 hairline-b">
        <span className="min-w-0 flex-1 trunc font-mono text-fg-2" title={current.path}>{workspacePath(current.path, workspace)}</span>
        <span className="flex-none">只读 · 来自 {current.harnessIds.map(name).join("、")}</span>
      </div>
      <div className="native-diff diff py-1.5" role="group" aria-label="差异">{current.diffs.map((diff, index) => <div key={index} className={cn(index > 0 && "hairline-t")}><DiffLines file={diff} headers={false}/></div>)}</div>
    </section>
      : !changes.loading && !changes.failures.length ? <p className="m-0 px-4 pb-4 text-caption text-fg-3">{scope === "turn" && changes.files.length ? "这一轮没有改动文件。" : "Agent 改了文件，但没有返回差异文本。"}</p> : null}
  </div>;
}

function Phases({ run }: { readonly run: PublicRun }) {
  const now = useNow(!finished(run.status)), timing = run.timing;
  if (!timing) return null;
  const end = timing.endedAt ?? now, total = Math.max(1, end - timing.acceptedAt);
  const rows: [string, number | undefined, number | undefined][] = [
    [run.reused ? "启动原程序（复用保留的进程）" : "启动原程序", timing.preparingAt, timing.readyAt],
    ["发送到首个输出", timing.dispatchedAt, timing.firstOutputAt],
    ["回复与工具", timing.firstOutputAt, timing.endedAt ?? (finished(run.status) ? undefined : now)],
  ];
  const visible = rows.filter(([, from, to]) => from !== undefined && to !== undefined);
  if (!visible.length) return null;
  return <section className="flex flex-col gap-2" aria-label="本轮阶段"><span className="text-caption text-fg-3">本轮阶段</span>
    {visible.map(([label, from, to]) => { const span = to! - from!; return <div key={label} className="grid grid-cols-[minmax(0,1fr)_76px] items-center gap-2.5">
      <span className="flex flex-col gap-1"><span className="text-ui-sm">{label}</span><span className="h-[5px] overflow-hidden rounded-full bg-subtle"><span className={cn("block h-full rounded-full", label === "回复与工具" ? "bg-accent" : "bg-fg-3")} style={{ width: Math.max(2, Math.round(span / total * 100)) + "%" }}/></span></span>
      <span className="mono text-right text-caption text-fg-2">{duration(span)}</span></div>; })}
  </section>;
}
/**
 * One Turn in the list of every Turn's steps: who ran it and what it did, opened to its timeline and tools. A Turn in
 * progress carries the blue dot of work going on; while it waits for the user (`waiting`) nothing of it runs, and its dot is
 * the amber one of waiting, named as the header names it. A Turn waiting in the queue has not started: a still grey dot,
 * 排队中 (ruling N).
 */
function RunProcess({ run, index, open, onToggle, loadToolDetail, name, describe, now, asking, waiting }: { readonly run: PublicRun; readonly index: number; readonly open: boolean; readonly onToggle: () => void; readonly loadToolDetail: ToolDetailLoader | undefined; readonly name: (id: string) => string; readonly describe: (run: PublicRun) => string; readonly now: number; readonly asking: string | undefined; readonly waiting: string | null }) {
  const active = !finished(run.status), panel = useId(), at = (time: number | undefined) => time === undefined ? null : new Date(time).toLocaleTimeString("zh-CN", { hour12: false });
  const summary = run.tools?.length ? toolSummary(run.tools, active).compact : "", total = runDuration(run);
  const time = total !== null ? spentText(total) : active && run.timing ? "已用 " + elapsed(now - run.timing.acceptedAt) : "";
  const steps: [string, number | undefined][] = [["收到消息", run.timing?.acceptedAt], ["开始启动原程序", run.timing?.preparingAt], ["原生会话就绪", run.timing?.readyAt], ["发给原程序", run.timing?.dispatchedAt], ["首个输出", run.timing?.firstOutputAt], [run.status === "cancelled" ? cancelledWords(run) : RUN_STATE[run.status], run.timing?.endedAt]];
  const model = describe(run);
  return <li className="flex min-w-0 flex-col">
    <button type="button" className="row flex min-h-9 w-full min-w-0 items-center gap-2 border-none bg-transparent px-1.5 py-1.5 text-left text-ui-sm text-fg-2 hover:bg-subtle" aria-expanded={open} aria-controls={panel} onClick={onToggle}>
      <BrandIcon brand={run.selection.harnessId} name={name(run.selection.harnessId)} size={18}/>
      {/* What the Turn did and its time stay whole: in the narrow panel the line wraps between its parts, never in a number */}
      <span className="min-w-0 flex-1 break-words"><span className="text-fg">{name(run.selection.harnessId)}</span>{[...(summary ? summary.split(" · ") : []), ...(time ? [time] : [])].map((part, index) => <Fragment key={index}> · <span className="whitespace-nowrap">{part}</span></Fragment>)}</span>
      {active ? waiting ? <StatusDot tone="wait" label={waiting}/> : run.status === "queued" ? <StatusDot tone="idle" label={RUN_STATE.queued}/> : <StatusDot tone="run" label="进行中"/> : null}
      <span className="flex-none text-caption text-fg-3">第 {index + 1} 轮</span>
      <ChevronRight size={12} strokeWidth={2.2} aria-hidden="true" className={cn("flex-none text-fg-3 motion-rotate", open && "rotate-90")}/>
    </button>
    <Collapsible open={open} id={panel}>
      <div className="mb-2 ml-[15px] flex min-w-0 flex-col gap-3 border-l border-line-strong py-1 pl-3.5">
        {model ? <p className="m-0 text-caption text-fg-3">{model}</p> : null}
        <ol className="m-0 flex list-none flex-col gap-1.5 p-0" aria-label="时间线">{steps.filter(([, time]) => time !== undefined).map(([label, time]) => <li key={label} className="grid grid-cols-[64px_minmax(0,1fr)] items-baseline gap-2.5 text-ui-sm"><span className="mono text-[11.5px] text-fg-3">{at(time)}</span><span>{label}</span></li>)}</ol>
        {run.activities?.length ? <div className="flex flex-col gap-1.5"><span className="text-caption text-fg-3">原生活动</span>{run.activities.map(activity => <div key={activity.id} className="flex items-center gap-2 text-ui-sm"><span className="min-w-0 flex-1">{ACTIVITY_KIND[activity.kind]} · {activity.title}</span><span className="flex-none text-caption text-fg-3">{ACTIVITY_STATUS[activity.status]}</span></div>)}</div> : null}
        {run.tools?.length ? <div className="-ml-1.5 flex min-w-0 flex-col"><ToolList tools={run.tools} active={active} loadDetail={loadToolDetail} asking={asking}/></div> : <p className="m-0 text-caption text-fg-3">这一轮没有调用工具。</p>}
      </div>
    </Collapsible>
  </li>;
}
/** Every Turn's steps, oldest first, the chosen one open (Conversation board: "两个 Agent 的全部步骤，按时间排列"). */
function Process({ run, runs, onRun, describe, loadToolDetail, name, asking, waiting }: { readonly run: PublicRun; readonly runs: readonly PublicRun[]; readonly onRun: (id: string) => void; readonly describe: (run: PublicRun) => string; readonly loadToolDetail: ToolDetailLoader | undefined; readonly name: (id: string) => string; readonly asking: (run: PublicRun) => string | undefined; readonly waiting: (run: PublicRun) => string | null }) {
  const [closed, setClosed] = useState<string | null>(null);
  const now = useNow(runs.some(item => !finished(item.status)));
  const agents = new Set(runs.map(item => item.selection.harnessId)).size;
  return <div className="flex flex-col gap-1 px-2.5 pt-3 pb-4">
    <p className="m-0 px-1.5 pb-1 text-caption text-fg-3">{agents > 1 ? (agents === 2 ? "两个" : agents + " 个") + " Agent 的全部步骤，按时间排列" : "这个对话的全部步骤，按时间排列"}</p>
    <ol className="m-0 flex list-none flex-col gap-px p-0">{runs.map((item, index) => <RunProcess key={item.id} run={item} index={index} open={item.id === run.id && closed !== item.id} now={now} name={name} describe={describe} loadToolDetail={loadToolDetail} asking={asking(item)} waiting={waiting(item)}
      onToggle={() => { if (item.id === run.id) setClosed(closed === item.id ? null : item.id); else { setClosed(null); onRun(item.id); } }}/>)}</ol>
  </div>;
}
function Background({ session, kept, items, busy, onEndProcess, name }: { readonly session: SessionView; readonly kept: NonNullable<SessionView["retention"]>["process"] | null; readonly items: readonly { readonly run: PublicRun; readonly activity: NonNullable<PublicRun["activities"]>[number] }[]; readonly busy: boolean; readonly onEndProcess?: (() => void) | undefined; readonly name: (id: string | undefined) => string }) {
  const now = useNow(kept !== null), keeper = kept ? name(kept.harnessId) : "原程序";
  const hint = session.retention?.enabled ? "已开启保持原生进程：下一轮结束后原程序会留在后台。" : "回合结束时原程序随之关闭。需要它在后台继续运行任务时，在 Agent 选择器（⌘J）底部打开“高级配置…”，开启“保持原生进程”。";
  return <div className="flex flex-col gap-3 px-4 pt-3 pb-4">
    {kept ? <div className="kept-panel flex flex-col gap-2 rounded-block bg-surface p-3 shadow-hairline">
      <div className="flex items-center gap-2"><StatusDot tone="run"/><strong className="text-ui-sm font-semibold">原生进程保留中</strong></div>
      <p className="m-0 text-ui-sm text-fg-2">回合之间不关闭 {keeper}，它在后台运行的任务可以继续，下一条消息也不必重新启动。空闲 30 分钟后结束。</p>
      <div className="flex flex-wrap items-center gap-3 text-caption text-fg-3"><span>后台活动 {kept.backgroundUpdates} 条</span><span>{Math.max(1, Math.round((kept.idleEndsAt - now) / 60000))} 分钟后结束</span></div>
      {onEndProcess ? <button type="button" className="btn btn-sm self-start" disabled={busy} onClick={onEndProcess}>结束后台进程</button> : null}
    </div> : null}
    {session.retention?.upgraded ? <p className="kept-upgraded m-0 rounded-block bg-subtle px-3 py-2.5 text-ui-sm text-fg-2">升级 {name(session.retention.upgraded.harnessId)} 前，HarnessHub 关闭了这个对话保留的后台进程。下一条消息会用新版本重新启动原程序。</p> : null}
    {session.retention?.outside ? <p className="m-0 rounded-block bg-subtle px-3 py-2.5 text-ui-sm text-fg-2">原程序的后台任务可能仍在运行（{session.retention.outside.count} 个进程）：它们已离开原程序的进程组，HarnessHub 没有结束它们。</p> : null}
    {items.length ? <>
      <span className="text-caption text-fg-3">后台任务与子 Agent</span>
      <ul className="m-0 flex list-none flex-col gap-px p-0">{items.map(({ activity }) => <li key={activity.id} className="flex min-h-[30px] items-center gap-2.5 px-1 text-ui-sm">
        <StatusDot tone={activity.status === "running" ? "run" : activity.status === "failed" ? "fail" : "idle"}/>
        <span className="min-w-0 flex-1"><span className="text-fg-3">{ACTIVITY_KIND[activity.kind]} · </span>{activity.title}</span><span className={cn("flex-none text-caption", activity.status === "failed" ? "text-red" : "text-fg-3")}>{ACTIVITY_STATUS[activity.status]}</span></li>)}</ul>
    </> : kept ? null : <EmptyState icon={<Clock size={22}/>} title="没有后台任务">Agent 在后台运行的命令和子 Agent 会出现在这里。</EmptyState>}
    {kept ? null : <p className="m-0 text-center text-caption text-fg-3">{hint}</p>}
  </div>;
}
function RunFacts(props: PanelProps & { readonly run: PublicRun; readonly runs: readonly PublicRun[] }) {
  const { run, session } = props, status = run.status, terminal = finished(status);
  const harness = props.harnesses.find(row => row.id === run.selection.harnessId), provider = props.providers.find(row => row.id === run.selection.provider?.providerId);
  const version = harness?.management.programVersion ?? harness?.management.installedVersion, adapter = harness && harness.management.programVersion && harness.management.installedVersion && harness.management.programVersion !== harness.management.installedVersion ? harness.management.installedVersion : null;
  const nativeState = session.nativeStates?.find(state => state.harnessId === session.selection.harnessId && state.controlId === session.selection.controlId);
  const options = Object.entries(run.selection.nativeOptions ?? {});
  return <div className="execution-details flex flex-col gap-4 px-4 pt-3.5 pb-4 text-ui-sm">
    <RunPicker runs={props.runs} run={run} onRun={props.onRun}/>
    <dl className="m-0 grid grid-cols-[96px_minmax(0,1fr)] gap-x-3 gap-y-2">
      <Fact label="执行者"><span className="inline-flex items-center gap-1.5"><BrandIcon brand={run.selection.harnessId} name={harness?.name ?? run.selection.harnessId} size={16}/>{harness?.name ?? run.selection.harnessId}{version ? ` ${version}` : ""}{adapter ? ` · 接入口 ${adapter}` : ""}</span></Fact>
      <Fact label="模型连接">{provider?.name ?? (run.selection.provider ? "Provider" : "Agent 原生连接")}</Fact>
      {run.selection.provider ? <><Fact label="模型">{run.selection.provider.model}</Fact><Fact label="配置版本">{run.selection.provider.revision}</Fact></>
        : <Fact label="模型">{run.selection.nativeModel ? <code className="text-code">{run.selection.nativeModel}</code> : "本机默认"}</Fact>}
      {options.length ? <Fact label="原生选项">{options.map(([id, value]) => `${id} ${value}`).join("、")}</Fact> : null}
      <Fact label="控制入口"><code className="text-code">{run.selection.controlId}</code></Fact>
      <Fact label="工作区"><span className="mono text-code" title={session.workspace}>{homePath(session.workspace) || folderName(session.workspace)}</span></Fact>
      <Fact label="执行状态">{status === "cancelled" ? cancelledWords(run) : waitingWords(session, run) ?? RUN_STATE[status]}</Fact>
      <Fact label="执行标识"><code className="text-code break-all">{run.id}</code></Fact>
      {run.timing?.readyAt !== undefined && run.timing.preparingAt !== undefined ? <Fact label="启动原程序">{duration(run.timing.readyAt - run.timing.preparingAt)}{run.reused ? "（复用保留的进程）" : ""}</Fact> : null}
      {run.timing?.firstOutputAt !== undefined && run.timing.dispatchedAt !== undefined ? <Fact label="发送后首个输出">{duration(run.timing.firstOutputAt - run.timing.dispatchedAt)}</Fact> : null}
      {run.usage ? usageFacts(run.usage).map(([label, value]) => <Fact key={label} label={label}>{value}</Fact>) : null}
      {run.error ? <Fact label="错误代码"><code className="text-code">{run.error.code}</code></Fact> : null}
    </dl>
    <Phases run={run}/>
    {status === "unknown" ? <p className="m-0 rounded-block bg-amber-soft px-3 py-2.5 text-ui-sm text-amber-on-tint">请先核实执行结果。这个请求不会自动重新执行。</p> : status === "completed" ? <p className="m-0 text-caption text-fg-3">本轮执行已结束，结果仍需由你确认。</p> : null}
    {props.loadDiagnostics && terminal ? <RunDiagnostics key={run.id} runId={run.id} load={props.loadDiagnostics}/> : null}
    {nativeState && run.id === props.runs.at(-1)?.id ? <section className="flex flex-col gap-2.5 hairline-t pt-3.5" aria-label="原生会话">
      <span className="text-caption font-medium text-fg-2">原生会话 · {nativeState.status === "ready" ? "继续已有会话" : nativeState.status === "forking" ? "正在建立分支副本" : "状态待确认"}</span>
      {nativeState.status === "ready" && props.loadNativeResume ? <NativeResume key={session.id + ":" + nativeState.harnessId + ":" + nativeState.controlId} load={props.loadNativeResume}/> : null}
    </section> : null}
  </div>;
}
