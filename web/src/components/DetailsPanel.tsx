import { FileText, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { ContentRef } from "../../../src/contracts/content.js";
import { cancelledLabel, type PublicRun } from "../../../src/contracts/session.js";
import type { HarnessView, NativeResumeView, SessionView } from "../../../src/contracts/web.js";
import type { ProviderView } from "../../../src/contracts/provider.js";
import { errorMessage, runStatusLabel, type ToolDetailView } from "../api.js";
import { cn } from "../lib/cn.js";
import { duration, folderName, homePath } from "../lib/format.js";
import { useNow } from "../lib/prefs.js";
import { editTools, finished, parseUnifiedDiff, toolSummary, type DiffFile } from "../lib/turn.js";
import { EmptyState, Fact, Spinner } from "../ui/primitives.js";
import { ACTIVITY_KIND, ACTIVITY_STATUS, DiffView, PlanView, ToolList, usageFacts, type ToolDetailLoader } from "./Activity.js";
import { NativeResume } from "./NativeResume.js";

export type PanelTab = "changes" | "process" | "plan" | "background" | "run";
const TABS: readonly { readonly id: PanelTab; readonly label: string }[] = [{ id: "changes", label: "改动" }, { id: "process", label: "过程" }, { id: "plan", label: "计划" }, { id: "background", label: "后台" }, { id: "run", label: "执行" }];

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
  return <div className="run-diagnostics flex flex-col gap-2">
    <div className="flex flex-wrap items-center gap-3"><button type="button" className="btn btn-sm diagnostics-copy" disabled={state === "busy"} onClick={() => void copy()}>{state === "busy" ? "正在准备诊断信息…" : "复制诊断信息"}</button>
      <label className="flex items-center gap-1.5 text-[12.5px] text-fg-2"><input type="checkbox" className="accent-[var(--accent)]" checked={content} onChange={event => { setContent(event.target.checked); setState("idle"); }}/>包含这一轮的提示词与回复</label></div>
    <p className="m-0 text-[12px] text-fg-3" role="status">{state === "copied" ? `已复制诊断信息（${content ? "含" : "不含"}对话内容）。` : state === "failed" ? "无法复制诊断信息，请稍后再试。"
      : "包含版本、各阶段耗时、结束原因、清理状态与本回合 stderr 的最后 4 KiB；已隐去路径、环境变量值和密钥样式的字符串。默认不含对话内容。"}</p>
  </div>;
}

interface PanelProps {
  readonly session: SessionView; readonly harnesses: readonly HarnessView[]; readonly providers: readonly ProviderView[];
  readonly tab: PanelTab; readonly onTab: (tab: PanelTab) => void; readonly runId: string | null; readonly onRun: (id: string) => void;
  readonly describe: (run: PublicRun) => string; readonly loadToolDetail?: ToolDetailLoader | undefined;
  readonly loadDiagnostics?: ((runId: string, includeContent: boolean) => Promise<string>) | undefined;
  readonly loadNativeResume?: ((signal: AbortSignal) => Promise<NativeResumeView | null>) | undefined;
  readonly onEndProcess?: (() => void) | undefined; readonly busy: boolean; readonly onClose?: (() => void) | undefined;
}
/** The conversation's details beside it (ADR-042): file changes, a Turn's steps, the plan, background work and execution facts. */
export function DetailsPanel(props: PanelProps) {
  const { session, tab } = props;
  const runs = session.runs;
  const selected = runs.find(run => run.id === props.runId) ?? runs.at(-1) ?? null;
  const edits = useMemo(() => runs.flatMap(run => editTools(run)), [runs]);
  const plan = [...runs].reverse().find(run => run.plan?.entries.length)?.plan;
  const kept = session.retention?.process ?? null;
  const background = runs.flatMap(run => (run.activities ?? []).filter(activity => activity.kind === "task" || activity.kind === "subagent").map(activity => ({ run, activity })));
  const counts: Partial<Record<PanelTab, string>> = { ...(edits.length ? { changes: String(edits.length) } : {}), ...(plan ? { plan: `${plan.entries.filter(entry => entry.status === "completed").length}/${plan.entries.length}` } : {}),
    ...(kept || background.some(item => item.activity.status === "running") ? { background: String((kept ? 1 : 0) + background.filter(item => item.activity.status === "running").length) } : {}) };
  return <div className="details-panel flex h-full min-h-0 flex-col">
    <div className="flex h-[46px] flex-none items-end gap-0.5 border-b border-line px-3" role="tablist" aria-label="详情">
      {TABS.map(item => <button key={item.id} type="button" role="tab" id={`details-tab-${item.id}`} aria-selected={tab === item.id} aria-controls="details-tabpanel" className="tab" onClick={() => props.onTab(item.id)}>
        {item.label}{counts[item.id] ? <span className="text-[11px] font-normal text-fg-3">{counts[item.id]}</span> : null}</button>)}
      <span className="flex-1"/>
      {props.onClose ? <button type="button" className="icon-btn icon-btn-sm mb-2" aria-label="关闭详情栏" onClick={props.onClose}><X size={15}/></button> : null}
    </div>
    <div className="scroll-area min-h-0 flex-1" role="tabpanel" id="details-tabpanel" aria-labelledby={`details-tab-${tab}`}>
      {tab === "changes" ? <Changes edits={edits} load={props.loadToolDetail} sessionId={session.id}/>
        : tab === "process" ? selected ? <Process run={selected} runs={runs} onRun={props.onRun} describe={props.describe} loadToolDetail={props.loadToolDetail} harnesses={props.harnesses}/> : <Empty>这个对话还没有执行记录。</Empty>
        : tab === "plan" ? plan ? <div className="p-3.5"><p className="mt-0 mb-2.5 text-[12.5px] text-fg-2">{props.harnesses.find(row => row.id === [...runs].reverse().find(run => run.plan === plan)?.selection.harnessId)?.name ?? "Harness"} 报告的计划</p><PlanView plan={plan}/></div> : <Empty>原程序报告计划后会显示在这里。</Empty>
        : tab === "background" ? <Background session={session} kept={kept} items={background} busy={props.busy} onEndProcess={props.onEndProcess} harnesses={props.harnesses}/>
        : selected ? <RunFacts {...props} run={selected} runs={runs}/> : <Empty>发出第一条消息后，这里会显示执行者、阶段耗时与用量。</Empty>}
    </div>
  </div>;
}
function Empty({ children }: { readonly children: ReactNode }) { return <p className="m-0 px-4 py-10 text-center text-[12.5px] text-fg-3">{children}</p>; }
function RunPicker({ runs, run, onRun }: { readonly runs: readonly PublicRun[]; readonly run: PublicRun; readonly onRun: (id: string) => void }) {
  if (runs.length < 2) return null;
  return <label className="flex items-center gap-2 text-[12.5px] text-fg-2"><span className="flex-none">回合</span>
    <select className="field h-8 min-w-0 flex-1 py-0 text-[12.5px]" value={run.id} onChange={event => onRun(event.target.value)} aria-label="选择回合">
      {runs.map((item, index) => <option key={item.id} value={item.id}>第 {index + 1} 轮 · {[...item.input].slice(0, 24).join("")}{[...item.input].length > 24 ? "…" : ""}</option>)}
    </select></label>;
}

/** Each edited file of the conversation, with its diff as the program reported it. Read-only: nothing here undoes a change. */
function Changes({ edits, load, sessionId }: { readonly edits: readonly NonNullable<PublicRun["tools"]>[number][]; readonly load: ToolDetailLoader | undefined; readonly sessionId: string }) {
  const [details, setDetails] = useState<ReadonlyMap<string, ToolDetailView | string>>(new Map());
  const [selected, setSelected] = useState<string | null>(null);
  // Each stored detail is read once per conversation view, however often the conversation's facts change meanwhile.
  const inflight = useRef(new Set<string>()), owner = useRef(sessionId);
  useEffect(() => { owner.current = sessionId; inflight.current = new Set(); setDetails(new Map()); setSelected(null); }, [sessionId]);
  useEffect(() => {
    if (!load) return;
    const missing = edits.slice(-40).filter(tool => tool.detail !== undefined && !details.has(tool.detail.id) && !inflight.current.has(tool.detail.id));
    if (!missing.length) return;
    const session = sessionId;
    for (const tool of missing) inflight.current.add(tool.detail!.id);
    void Promise.all(missing.map(tool => load(tool.detail as ContentRef).then(value => [tool.detail!.id, value] as const, error => [tool.detail!.id, errorMessage(error)] as const))).then(rows => {
      if (owner.current !== session) return;
      for (const [id] of rows) inflight.current.delete(id);
      setDetails(previous => { const next = new Map(previous); for (const [id, value] of rows) next.set(id, value); return next; });
    });
  }, [edits, load, details, sessionId]);
  const files = useMemo(() => {
    const result = new Map<string, { path: string; add: number; del: number; diffs: DiffFile[] }>();
    for (const tool of edits.slice(-40)) {
      const detail = tool.detail ? details.get(tool.detail.id) : undefined;
      if (detail === undefined || typeof detail === "string" || !detail.diff) continue;
      for (const file of parseUnifiedDiff(detail.diff, detail.locations?.[0] ?? tool.title)) {
        const entry = result.get(file.path) ?? { path: file.path, add: 0, del: 0, diffs: [] };
        entry.add += file.add; entry.del += file.del; entry.diffs.push(file); result.set(file.path, entry);
      }
    }
    return [...result.values()];
  }, [edits, details]);
  if (!edits.length) return <EmptyState icon={<FileText size={22}/>} title="还没有改动">原程序在这个对话里编辑文件后，改动会按文件列在这里，只读，不提供撤销。</EmptyState>;
  const loading = edits.slice(-40).some(tool => tool.detail !== undefined && !details.has(tool.detail.id));
  const failures = [...details.values()].filter(value => typeof value === "string");
  const current = files.find(file => file.path === selected) ?? files[0];
  const add = files.reduce((sum, file) => sum + file.add, 0), del = files.reduce((sum, file) => sum + file.del, 0);
  return <div className="flex flex-col">
    <div className="flex items-center justify-between px-3.5 pt-3 pb-1.5 text-[12.5px] text-fg-2"><span>本对话改动 {files.length} 个文件</span><span className="mono"><span className="text-add">+{add}</span> <span className="text-del">−{del}</span></span></div>
    <ul className="m-0 flex list-none flex-col gap-px px-2 pb-2">{files.map(file => <li key={file.path}><button type="button" onClick={() => setSelected(file.path)} aria-pressed={current?.path === file.path}
      className={cn("flex w-full items-center gap-2 rounded-[7px] border-none px-2 py-1.5 text-left hover:bg-hover", current?.path === file.path ? "bg-subtle" : "bg-transparent")}>
      <FileText size={14} className="flex-none text-fg-3" aria-hidden="true"/><span className="mono min-w-0 flex-1 truncate text-[12.5px]" title={file.path}>{homePath(file.path)}</span>
      <span className="mono flex-none text-[12px]"><span className="text-add">{file.add ? "+" + file.add : ""}</span> <span className="text-del">{file.del ? "−" + file.del : ""}</span></span></button></li>)}</ul>
    {loading ? <p className="m-0 flex items-center gap-1.5 px-4 pb-3 text-[12.5px] text-fg-3"><Spinner size={12}/> 正在读取改动…</p> : null}
    {failures.length ? <p className="m-0 px-4 pb-3 text-[12.5px] text-red">{failures.length} 处改动读取失败：{String(failures[0])}</p> : null}
    {current ? <div className="mx-3 mb-3.5 overflow-hidden rounded-[10px] border border-line">
      <div className="mono flex items-center justify-between gap-2 bg-subtle px-2.5 py-2 text-[12px] text-fg-2"><span className="truncate" title={current.path}>{homePath(current.path)}</span><span className="flex-none"><span className="text-add">+{current.add}</span> <span className="text-del">−{current.del}</span></span></div>
      {current.diffs.map((diff, index) => <DiffView key={index} className="rounded-none border-0 border-t border-line first:border-t-0" text={diff.lines.map(line => line.kind === "add" ? "+" + line.text : line.kind === "remove" ? "-" + line.text : line.kind === "context" ? " " + line.text : line.text).join("\n")} fallback={current.path}/>)}
    </div> : !loading && !failures.length ? <p className="m-0 px-4 pb-4 text-[12.5px] text-fg-3">这些工具没有返回差异文本。</p> : null}
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
  return <div className="flex flex-col gap-2"><span className="text-[12.5px] text-fg-2">本轮阶段</span>
    {visible.map(([label, from, to]) => { const span = to! - from!; return <div key={label} className="grid grid-cols-[minmax(0,1fr)_76px] items-center gap-2.5">
      <span className="flex flex-col gap-1"><span className="text-[12.5px]">{label}</span><span className="h-[5px] overflow-hidden rounded-full bg-subtle"><span className={cn("block h-full rounded-full", label === "回复与工具" ? "bg-accent" : "bg-fg-3")} style={{ width: Math.max(2, Math.round(span / total * 100)) + "%" }}/></span></span>
      <span className="mono text-right text-[12px] text-fg-2">{duration(span)}</span></div>; })}
  </div>;
}
function Process({ run, runs, onRun, describe, loadToolDetail, harnesses }: { readonly run: PublicRun; readonly runs: readonly PublicRun[]; readonly onRun: (id: string) => void; readonly describe: (run: PublicRun) => string; readonly loadToolDetail: ToolDetailLoader | undefined; readonly harnesses: readonly HarnessView[] }) {
  const active = !finished(run.status), at = (time: number | undefined) => time === undefined ? null : new Date(time).toLocaleTimeString("zh-CN", { hour12: false });
  const steps: [string, number | undefined][] = [["收到消息", run.timing?.acceptedAt], ["开始启动原程序", run.timing?.preparingAt], ["原生会话就绪", run.timing?.readyAt], ["发给原程序", run.timing?.dispatchedAt], ["首个输出", run.timing?.firstOutputAt], [run.status === "cancelled" ? cancelledLabel(run) : runStatusLabel(run.status), run.timing?.endedAt]];
  const summary = run.tools?.length ? toolSummary(run.tools, active).text : "";
  return <div className="flex flex-col gap-3 p-3.5">
    <RunPicker runs={runs} run={run} onRun={onRun}/>
    <p className="m-0 text-[12.5px] text-fg-2">{harnesses.find(row => row.id === run.selection.harnessId)?.name ?? run.selection.harnessId} · {describe(run) || "本机配置"}{summary ? " · " + summary : ""}</p>
    <ol className="m-0 flex list-none flex-col gap-2 p-0">{steps.filter(([, time]) => time !== undefined).map(([label, time]) => <li key={label} className="grid grid-cols-[64px_minmax(0,1fr)] items-baseline gap-2.5 text-[12.5px]"><span className="mono text-[11.5px] text-fg-3">{at(time)}</span><span>{label}</span></li>)}</ol>
    {run.activities?.length ? <div className="flex flex-col gap-1.5"><span className="text-[12.5px] text-fg-2">原生活动</span>{run.activities.map(activity => <div key={activity.id} className="flex items-center gap-2 text-[12.5px]"><span className="flex-1">{ACTIVITY_KIND[activity.kind]} · {activity.title}</span><span className="text-fg-3">{ACTIVITY_STATUS[activity.status]}</span></div>)}</div> : null}
    {run.tools?.length ? <div className="flex flex-col gap-1.5"><span className="text-[12.5px] text-fg-2">工具（按调用顺序）</span><div className="-mx-1.5"><ToolList tools={run.tools} active={active} loadDetail={loadToolDetail}/></div></div> : <p className="m-0 text-[12.5px] text-fg-3">这一轮没有调用工具。</p>}
  </div>;
}
function Background({ session, kept, items, busy, onEndProcess, harnesses }: { readonly session: SessionView; readonly kept: NonNullable<SessionView["retention"]>["process"] | null; readonly items: readonly { readonly run: PublicRun; readonly activity: NonNullable<PublicRun["activities"]>[number] }[]; readonly busy: boolean; readonly onEndProcess?: (() => void) | undefined; readonly harnesses: readonly HarnessView[] }) {
  const now = useNow(kept !== null), name = harnesses.find(row => row.id === kept?.harnessId)?.name ?? "原程序";
  return <div className="flex flex-col gap-3 p-3.5">
    {kept ? <div className="kept-panel flex flex-col gap-2 rounded-[10px] border border-line p-3">
      <div className="flex items-center gap-2"><span className="pulse h-[7px] w-[7px] rounded-full bg-accent" aria-hidden="true"/><strong className="text-[13px] font-semibold">原生进程保留中</strong></div>
      <p className="m-0 text-[12.5px] text-fg-2">回合之间不关闭 {name}，它在后台运行的任务可以继续，下一条消息也不必重新启动。空闲 30 分钟后结束。</p>
      <div className="flex flex-wrap items-center gap-3 text-[12px] text-fg-3"><span>后台活动 {kept.backgroundUpdates} 条</span><span>{Math.max(1, Math.round((kept.idleEndsAt - now) / 60000))} 分钟后结束</span></div>
      {onEndProcess ? <button type="button" className="btn btn-sm self-start" disabled={busy} onClick={onEndProcess}>结束后台进程</button> : null}
    </div> : <div className="rounded-[10px] border border-dashed border-line-strong p-3 text-[12.5px] text-fg-2">{session.retention?.enabled ? "已开启保持原生进程：下一轮结束后原程序会留在后台。" : "回合结束时原程序随之关闭。需要它在后台继续运行任务时，在输入框的高级配置里开启“保持原生进程”。"}</div>}
    {session.retention?.outside ? <p className="m-0 rounded-lg bg-amber-soft px-3 py-2 text-[12.5px] text-amber">原程序的后台任务可能仍在运行（{session.retention.outside.count} 个进程）：它们已离开原程序的进程组，HarnessHub 没有结束它们。</p> : null}
    <span className="text-[12.5px] text-fg-2">后台任务与子 Agent</span>
    {items.length ? <ul className="m-0 flex list-none flex-col gap-1.5 p-0">{items.map(({ activity }) => <li key={activity.id} className="flex items-center gap-2.5 rounded-[9px] border border-line px-3 py-2 text-[13px]">
      {activity.status === "running" ? <span className="pulse h-1.5 w-1.5 flex-none rounded-full bg-accent" aria-hidden="true"/> : <span className="h-1.5 w-1.5 flex-none rounded-full bg-line-strong" aria-hidden="true"/>}
      <span className="min-w-0 flex-1"><span className="text-fg-3">{ACTIVITY_KIND[activity.kind]} · </span>{activity.title}</span><span className="flex-none text-[12px] text-fg-3">{ACTIVITY_STATUS[activity.status]}</span></li>)}</ul>
      : <p className="m-0 text-[12.5px] text-fg-3">原程序没有报告后台任务。</p>}
  </div>;
}
function RunFacts(props: PanelProps & { readonly run: PublicRun; readonly runs: readonly PublicRun[] }) {
  const { run, session } = props, status = run.status, terminal = finished(status);
  const harness = props.harnesses.find(row => row.id === run.selection.harnessId), provider = props.providers.find(row => row.id === run.selection.provider?.providerId);
  const version = harness?.management.programVersion ?? harness?.management.installedVersion, adapter = harness && harness.management.programVersion && harness.management.installedVersion && harness.management.programVersion !== harness.management.installedVersion ? harness.management.installedVersion : null;
  const nativeState = session.nativeStates?.find(state => state.harnessId === session.selection.harnessId && state.controlId === session.selection.controlId);
  const options = Object.entries(run.selection.nativeOptions ?? {});
  return <div className="execution-details flex flex-col gap-4 p-3.5 text-[13px]">
    <RunPicker runs={props.runs} run={run} onRun={props.onRun}/>
    <dl className="m-0 grid grid-cols-[96px_minmax(0,1fr)] gap-x-3 gap-y-2">
      <Fact label="执行者">{harness?.name ?? run.selection.harnessId}{version ? ` ${version}` : ""}{adapter ? ` · 接入口 ${adapter}` : ""}</Fact>
      <Fact label="模型连接">{provider?.name ?? (run.selection.provider ? "Provider" : "Harness 原生连接")}</Fact>
      {run.selection.provider ? <><Fact label="模型">{run.selection.provider.model}</Fact><Fact label="配置版本">v{run.selection.provider.revision}</Fact></>
        : <Fact label="模型">{run.selection.nativeModel ? <code className="text-[12px]">{run.selection.nativeModel}</code> : "本机默认"}</Fact>}
      {options.length ? <Fact label="原生选项">{options.map(([id, value]) => `${id} ${value}`).join("、")}</Fact> : null}
      <Fact label="控制入口"><code className="text-[12px]">{run.selection.controlId}</code></Fact>
      <Fact label="工作区"><span className="mono text-[12.5px]" title={session.workspace}>{homePath(session.workspace) || folderName(session.workspace)}</span></Fact>
      <Fact label="执行状态">{status === "cancelled" ? cancelledLabel(run) : runStatusLabel(status)}</Fact>
      <Fact label="执行标识"><code className="text-[12px] break-all">{run.id}</code></Fact>
      {run.timing?.readyAt !== undefined && run.timing.preparingAt !== undefined ? <Fact label="启动原程序">{duration(run.timing.readyAt - run.timing.preparingAt)}{run.reused ? "（复用保留的进程）" : ""}</Fact> : null}
      {run.timing?.firstOutputAt !== undefined && run.timing.dispatchedAt !== undefined ? <Fact label="发送后首个输出">{duration(run.timing.firstOutputAt - run.timing.dispatchedAt)}</Fact> : null}
      {run.usage ? usageFacts(run.usage).map(([label, value]) => <Fact key={label} label={label}>{value}</Fact>) : null}
      {run.error ? <Fact label="错误代码"><code className="text-[12px]">{run.error.code}</code></Fact> : null}
    </dl>
    <Phases run={run}/>
    {status === "unknown" ? <p className="m-0 rounded-lg bg-amber-soft px-3 py-2 text-[12.5px] text-amber">请先核实执行结果。这个请求不会自动重新执行。</p> : status === "completed" ? <p className="m-0 text-[12.5px] text-fg-3">本轮执行已结束，结果仍需由你确认。</p> : null}
    {props.loadDiagnostics && terminal ? <RunDiagnostics key={run.id} runId={run.id} load={props.loadDiagnostics}/> : null}
    {nativeState && run.id === props.runs.at(-1)?.id ? <section className="flex flex-col gap-2 border-t border-line pt-3.5">
      <span className="text-[12.5px] font-medium text-fg-2">原生会话 · {nativeState.status === "ready" ? "继续已有会话" : nativeState.status === "forking" ? "正在建立分支副本" : "状态待确认"}</span>
      {nativeState.status === "ready" && props.loadNativeResume ? <NativeResume key={session.id + ":" + nativeState.harnessId + ":" + nativeState.controlId} load={props.loadNativeResume}/> : null}
    </section> : null}
  </div>;
}
