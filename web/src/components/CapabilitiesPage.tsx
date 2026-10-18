import { ChevronDown, ChevronRight, Eye, RefreshCw, Search } from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { CAPABILITY_KINDS, type CapabilitiesView, type CapabilityEdge, type CapabilityEntry, type CapabilityFacts, type CapabilityKind, type CapabilityMechanism, type CapabilityOwner,
  type CapabilityStatus, type CapabilityWarning, type HarnessCapabilityReads } from "../../../src/contracts/capabilities.js";
import { errorMessage, type GatewayApi } from "../api.js";
import { cn } from "../lib/cn.js";
import { Badge, EmptyState, Notice, Spinner, Tip } from "../ui/primitives.js";
import { BrandIcon } from "./BrandIcon.js";
import { PageShell } from "./PageShell.js";

export const KIND_LABEL: Readonly<Record<CapabilityKind, string>> = { skill: "技能", mcp: "MCP", instructions: "指令", subagent: "子 Agent", command: "命令", hook: "Hooks", plugin: "插件" };
const MECHANISM_LABEL: Readonly<Record<CapabilityMechanism, string>> = { "native-shared": "共享目录", linked: "链接", "own-copy": "自有目录", "compat-root": "兼容读取", "external-dir": "外加目录",
  plugin: "插件", bundled: "内置", synced: "账户同步", config: "配置" };
const STATUS_LABEL: Readonly<Record<CapabilityStatus, string>> = { active: "生效", disabled: "已停用", shadowed: "被覆盖", duplicate: "重复", rejected: "被跳过", "broken-link": "链接失效", invalid: "无效" };
const OWNER_LABEL: Readonly<Record<CapabilityOwner, string>> = { user: "用户", harnesshub: "HarnessHub", "skills-cli": "vercel skills", "cc-switch": "cc-switch", magpie: "Magpie", clawhub: "ClawHub",
  "hermes-hub": "Hermes Hub", plugin: "插件", bundled: "随程序安装", synced: "账户同步" };
const WARNING_LABEL: Readonly<Record<CapabilityWarning["kind"], string>> = { duplicate: "重复", shadow: "遮蔽", cross: "交叉", invisible: "不可见", literal: "明文", redundant: "多余" };
const STATUS_TONE: Readonly<Record<CapabilityStatus, string>> = { active: "text-green", disabled: "text-fg-3", shadowed: "text-fg-3", duplicate: "text-amber", rejected: "text-fg-3", "broken-link": "text-red", invalid: "text-amber" };

function size(bytes: number): string { return bytes < 1024 ? bytes + " B" : bytes < 1024 * 1024 ? (bytes / 1024).toFixed(1) + " KB" : (bytes / 1024 / 1024).toFixed(1) + " MB"; }
function factsText(facts: CapabilityFacts): string {
  switch (facts.kind) {
    case "skill": return facts.files + " 个文件 · " + size(facts.bytes);
    case "mcp": return [facts.transport === "unknown" ? "传输方式未知" : facts.transport, facts.program, facts.host, facts.variables.length ? "变量 " + facts.variables.join("、") : null,
      facts.headers.length ? "请求头 " + facts.headers.join("、") : null, facts.references ? facts.references + " 处变量引用" : null, facts.literal ? facts.literal + " 处明文值" : null, facts.enabled ? null : "已停用"].filter(Boolean).join(" · ");
    case "instructions": return size(facts.bytes) + (facts.managedBlocks.length ? " · 含 " + facts.managedBlocks.join("、") + " 管理的区块" : "");
    case "subagent": case "command": return facts.format === "toml" ? "TOML" : "Markdown";
    case "hook": return [facts.event, facts.matcher ? "匹配 " + facts.matcher : null, facts.program ? "运行 " + facts.program : null].filter(Boolean).join(" · ");
    case "plugin": return [facts.version ? "v" + facts.version : null, facts.enabled === null ? "启停未知" : facts.enabled ? "已启用" : "已停用"].filter(Boolean).join(" · ");
  }
}
/** One Harness's way of seeing one entry, in a matrix cell: the mechanism when it is used, the status otherwise. */
function EdgeChip({ edge }: { readonly edge: CapabilityEdge }) {
  const title = [STATUS_LABEL[edge.status], MECHANISM_LABEL[edge.mechanism], edge.via, edge.reason].filter(Boolean).join(" · ");
  return <span className={cn("capability-chip inline-flex max-w-[132px] items-center gap-1 truncate text-[12px]", STATUS_TONE[edge.status], edge.status === "rejected" && "line-through")} title={title}>
    <span aria-hidden="true">{edge.status === "active" ? "✓" : edge.status === "disabled" ? "⊘" : edge.status === "shadowed" ? "↓" : edge.status === "duplicate" ? "⧉" : edge.status === "rejected" ? "✕" : "!"}</span>
    <span className="truncate">{edge.status === "active" ? MECHANISM_LABEL[edge.mechanism] : STATUS_LABEL[edge.status]}</span></span>;
}
function Cell({ edges, support }: { readonly edges: readonly CapabilityEdge[]; readonly support: HarnessCapabilityReads["kinds"][CapabilityKind] }) {
  if (support === "unsupported") return <span className="text-fg-3" title="这个 Harness 没有这类能力">—</span>;
  if (support === "invisible") return <span className="text-fg-3" title="保存在磁盘之外，无法读取">?</span>;
  if (!edges.length) return <span className="text-fg-3" aria-label="看不到">·</span>;
  return <span className="flex flex-col items-start gap-0.5">{edges.map((edge, index) => <EdgeChip key={index} edge={edge}/>)}</span>;
}
function EntryDetail({ entry, harnesses }: { readonly entry: CapabilityEntry; readonly harnesses: readonly HarnessCapabilityReads[] }) {
  const name = (id: string | null) => id === null ? null : harnesses.find(harness => harness.harnessId === id)?.name ?? id;
  return <div className="capability-detail flex flex-col gap-2 px-1 py-1 text-[12.5px]">
    {entry.description ? <p className="m-0 text-fg-2">{entry.description}</p> : null}
    <dl className="m-0 grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-1">
      {entry.location ? <><dt className="text-fg-3">位置</dt><dd className="m-0"><code className="text-[12px] break-all">{entry.location}</code></dd></> : null}
      <dt className="text-fg-3">归属</dt><dd className="m-0">{OWNER_LABEL[entry.owner]}{entry.source ? <span className="text-fg-3"> · 来源 <span className="break-all">{entry.source}</span></span> : null}</dd>
      {entry.facts ? <><dt className="text-fg-3">内容</dt><dd className="m-0">{factsText(entry.facts)}</dd></> : null}
    </dl>
    <ul className="m-0 flex list-none flex-col gap-1 p-0">{entry.edges.map((edge, index) => <li key={index} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded-lg border border-line px-2.5 py-1.5">
      <strong className="font-medium">{name(edge.harnessId)}</strong><span className={STATUS_TONE[edge.status]}>{STATUS_LABEL[edge.status]}</span><span className="text-fg-3">{MECHANISM_LABEL[edge.mechanism]}</span>
      <code className="text-[11.5px] break-all text-fg-2">{edge.via}</code>{edge.reason ? <span className="w-full text-fg-2">{edge.reason}</span> : null}
      {edge.facts && entry.kind === "mcp" ? <span className="w-full text-fg-3">{factsText(edge.facts)}</span> : null}</li>)}</ul>
    {entry.warnings.length ? <ul className="m-0 flex list-none flex-col gap-1 p-0">{entry.warnings.map((warning, index) => <li key={index} className="flex items-start gap-2"><Badge tone={warning.kind === "literal" ? "red" : "amber"}>{WARNING_LABEL[warning.kind]}</Badge><span className="text-fg-2">{warning.text}</span></li>)}</ul> : null}
  </div>;
}

/**
 * The capability page (ADR-045 step 1): what each installed Harness reads besides its model, as an entry × Harness
 * matrix per kind with the mechanism and status of every cell and the warnings the user should know. Read-only.
 */
export function CapabilitiesPage({ api, initialHarness, onMenu, sidebarHidden, onExpandSidebar, onChat }: {
  readonly api: GatewayApi; readonly initialHarness: string | null; readonly onMenu: () => void; readonly sidebarHidden: boolean; readonly onExpandSidebar: () => void; readonly onChat: () => void;
}) {
  const [view, setView] = useState<CapabilitiesView | null>(null), [loading, setLoading] = useState(true), [problem, setProblem] = useState<string | null>(null);
  const [kind, setKind] = useState<CapabilityKind>("skill"), [harness, setHarness] = useState<string | null>(initialHarness), [query, setQuery] = useState(""), [onlyWarnings, setOnlyWarnings] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const load = useCallback((signal?: AbortSignal) => {
    setLoading(true); setProblem(null);
    api.capabilities(signal).then(next => { setView(next); setLoading(false); }, failure => { if (signal?.aborted) return; setProblem(errorMessage(failure)); setLoading(false); });
  }, [api]);
  useEffect(() => { const controller = new AbortController(); load(controller.signal); return () => controller.abort(); }, [load]);
  useEffect(() => setHarness(initialHarness), [initialHarness]);
  const columns = useMemo(() => view?.harnesses.filter(item => harness === null || item.harnessId === harness) ?? [], [view, harness]);
  const counts = useMemo(() => Object.fromEntries(CAPABILITY_KINDS.map(item => [item, view?.entries.filter(entry => entry.kind === item && (harness === null || entry.edges.some(edge => edge.harnessId === harness))).length ?? 0])) as Record<CapabilityKind, number>, [view, harness]);
  const rows = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return (view?.entries ?? []).filter(entry => entry.kind === kind && (harness === null || entry.edges.some(edge => edge.harnessId === harness))
      && (!onlyWarnings || entry.warnings.some(warning => harness === null || warning.harnessId === null || warning.harnessId === harness) || entry.edges.some(edge => edge.status !== "active"))
      && (!needle || [entry.name, entry.description ?? "", entry.location ?? ""].some(value => value.toLocaleLowerCase().includes(needle))));
  }, [view, kind, harness, query, onlyWarnings]);
  const warningCount = (entry: CapabilityEntry) => entry.warnings.filter(warning => harness === null || warning.harnessId === null || warning.harnessId === harness).length;
  return <PageShell title="能力" titleId="capabilities-title" onMenu={onMenu} sidebarHidden={sidebarHidden} onExpandSidebar={onExpandSidebar} onBack={onChat} wide
    description="各 Harness 除模型外还会读取的技能、MCP、指令、子 Agent、命令、Hooks 和插件，按各自的规则显示谁能看到、经由哪里、是否生效。现在只读：不修改任何配置，不启动 MCP 服务器。"
    actions={<Tip label="重新读取"><button type="button" className="icon-btn" aria-label="重新读取" onClick={() => load()} disabled={loading}>{loading ? <Spinner size={15}/> : <RefreshCw size={16}/>}</button></Tip>}>
    {problem ? <Notice tone="red" action={<button type="button" className="btn btn-sm" onClick={() => load()}>重试</button>}>{problem}</Notice> : null}
    {view?.truncated ? <Notice tone="amber">条目太多，只显示前一部分。</Notice> : null}
    {view && view.unreadable.length ? <Notice tone="amber" title="有文件无法读取，其中的内容没有显示">
      <ul className="m-0 mt-1 flex list-none flex-col gap-0.5 p-0">{view.unreadable.map((item, index) => <li key={index}><code className="text-[12px]">{item.file}</code>：{item.reason}</li>)}</ul></Notice> : null}
    {view === null ? loading ? <p className="m-0 flex items-center gap-2 text-[13px] text-fg-2" role="status"><Spinner size={13}/>正在读取各 Harness 的配置</p> : null
      : view.harnesses.length === 0 ? <EmptyState title="没有找到官网安装的 Harness">在“我的 Agent”中安装或重新检测后，这里会列出它们读取的能力。</EmptyState> : <>
      <div className="capability-kinds flex items-end gap-0.5 overflow-x-auto border-b border-line" role="tablist" aria-label="能力类别">{CAPABILITY_KINDS.map(item =>
        <button key={item} type="button" role="tab" id={"capability-tab-" + item} aria-selected={kind === item} aria-controls="capability-tabpanel" className="tab" onClick={() => { setKind(item); setOpen(null); }}>
          {KIND_LABEL[item]}<span className="text-[11px] font-normal text-fg-3">{counts[item]}</span></button>)}</div>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex h-9 min-w-[200px] flex-1 items-center gap-2 rounded-lg border border-line-strong bg-surface px-3"><Search size={15} className="text-fg-3" aria-hidden="true"/>
          <input className="min-w-0 flex-1 border-none bg-transparent text-[13.5px] outline-none" aria-label="搜索能力" placeholder="搜索名称、说明或位置" value={query} onChange={event => setQuery(event.target.value)}/></label>
        <select className="h-9 rounded-lg border border-line-strong bg-surface px-2.5 text-[13px]" aria-label="只看一个 Harness" value={harness ?? ""} onChange={event => setHarness(event.target.value || null)}>
          <option value="">全部 Harness</option>{view.harnesses.map(item => <option key={item.harnessId} value={item.harnessId}>{item.name}</option>)}</select>
        <label className="flex items-center gap-1.5 text-[13px] text-fg-2"><input type="checkbox" checked={onlyWarnings} onChange={event => setOnlyWarnings(event.target.checked)}/>只看有提示或未生效的</label>
      </div>
      <div role="tabpanel" id="capability-tabpanel" aria-labelledby={"capability-tab-" + kind}>
      {rows.length ? <div className="capability-matrix overflow-x-auto rounded-xl border border-line bg-surface shadow-sm">
        <table className="w-full border-collapse text-left text-[12.5px]">
          <thead><tr className="border-b border-line">
            <th scope="col" className="sticky left-0 z-[1] min-w-[220px] bg-surface px-3 py-2 font-medium text-fg-2">{KIND_LABEL[kind]}</th>
            {columns.map(item => <th key={item.harnessId} scope="col" className="min-w-[104px] px-2 py-2 align-bottom font-medium">
              <span className="flex items-center gap-1.5"><BrandIcon brand={item.harnessId} name={item.name} size={16}/><span className="truncate">{item.name}</span></span>
              <small className="block font-normal text-fg-3">{item.version ? "v" + item.version : "版本未知"}{item.table === "unverified" ? <span className="ml-1 text-amber" title="这个版本不在核实过的范围内，按最接近的规则读取">未核实</span> : null}</small></th>)}
          </tr></thead>
          <tbody>{rows.map(entry => { const expanded = open === entry.key, warnings = warningCount(entry);
            return <Fragment key={entry.key}><tr className={cn("border-b border-line align-top", expanded && "bg-subtle")}>
              <th scope="row" className={cn("sticky left-0 z-[1] px-3 py-2 font-normal", expanded ? "bg-subtle" : "bg-surface")}>
                <button type="button" className="flex w-full items-start gap-1.5 border-none bg-transparent p-0 text-left" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : entry.key)}>
                  {expanded ? <ChevronDown size={14} className="mt-0.5 flex-none text-fg-3" aria-hidden="true"/> : <ChevronRight size={14} className="mt-0.5 flex-none text-fg-3" aria-hidden="true"/>}
                  <span className="min-w-0"><span className="block font-medium break-all">{entry.name}</span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-1"><span className="text-[11.5px] text-fg-3">{OWNER_LABEL[entry.owner]}</span>{warnings ? <Badge tone="amber">{warnings} 条提示</Badge> : null}</span></span></button></th>
              {columns.map(item => <td key={item.harnessId} className="px-2 py-2"><Cell edges={entry.edges.filter(edge => edge.harnessId === item.harnessId)} support={item.kinds[kind]}/></td>)}
            </tr>{expanded ? <tr className="border-b border-line bg-subtle"><td colSpan={columns.length + 1} className="px-3 pb-3"><EntryDetail entry={entry} harnesses={view.harnesses}/></td></tr> : null}</Fragment>; })}</tbody>
        </table></div>
        : <EmptyState title={query || onlyWarnings ? "没有匹配的条目" : "这一类还没有条目"}>{columns.some(item => item.kinds[kind] !== "read") ? "部分 Harness 没有这类能力，或保存在磁盘之外。" : "各 Harness 的用户级配置里没有这一类。"}</EmptyState>}
      </div>
      <details className="rounded-xl border border-line bg-surface px-4 py-3 text-[12.5px]"><summary className="cursor-pointer font-medium"><Eye size={13} className="mr-1.5 inline" aria-hidden="true"/>各 Harness 的读取规则与说明</summary>
        <ul className="m-0 mt-2 flex list-none flex-col gap-2 p-0">{view.harnesses.map(item => <li key={item.harnessId}><strong className="font-medium">{item.name}</strong>
          <span className="ml-1.5 text-fg-3">{item.version ? "v" + item.version : "版本未知"} · {item.table === "verified" ? "规则已按这个版本核实" : "规则未按这个版本核实"}</span>
          <ul className="m-0 mt-0.5 list-disc pl-5 text-fg-2">{item.notes.map((note, index) => <li key={index}>{note}</li>)}</ul></li>)}</ul>
        <p className="m-0 mt-2 text-fg-3">读取时间 {new Date(view.checkedAt).toLocaleString()}。只显示名字与数量，不显示任何环境变量、请求头或参数的值。</p></details>
    </>}
  </PageShell>;
}
