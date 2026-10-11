import { ArrowRight, ArrowUpRight, Check, CheckCheck, ChevronRight, CircleAlert, Clock3, Download, Layers3, Package, RefreshCw, Search, ShieldCheck, Square, Terminal, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { HarnessEntrySource, HarnessView } from "../../../src/contracts/web.js";
import type { InstallationJobView, InstallationLog } from "../../../src/contracts/management.js";
import { errorMessage, GatewayApi, protocolLabel } from "../api.js";
import { BrandIcon } from "./BrandIcon.js";
import { EmptyState, ErrorNotice, Spinner, StatusBadge } from "./common.js";
import { MobileMenu } from "./Sidebar.js";

export interface UnconfirmedInstallation { harnessId: string; action: "install" | "upgrade"; message: string }
export function installationActive(job: InstallationJobView): boolean { return ["queued", "resolving", "installing", "verifying", "activating"].includes(job.status); }
export function installationStatus(job: InstallationJobView): string {
  const labels: Record<InstallationJobView["status"], string> = { queued: "等待安装", resolving: "正在解析来源", installing: "正在安装", verifying: "正在验证入口", activating: "正在启用版本", completed: "安装完成", cancelled: "已取消", failed: "安装失败", unknown: "结果待核实" };
  return job.cancelRequested && installationActive(job) ? "正在取消并清理" : labels[job.status];
}
interface HarnessProps {
  api: GatewayApi; harnesses: readonly HarnessView[]; jobs: readonly InstallationJobView[]; scanning: boolean; checking: boolean;
  submitting: readonly string[]; cancelling: readonly string[]; error: string | null; connectionError: string | null; unconfirmed: readonly UnconfirmedInstallation[];
  onRescan: () => void; onCheckUpdates: (ids?: readonly string[]) => void; onInstall: (harness: HarnessView, action: "install" | "upgrade") => void;
  onConfirm: (id: string) => void; onCancelJob: (job: InstallationJobView) => void; onDismissError: () => void; onMenu: () => void; onChoose: (harness: HarnessView) => void;
}
function missing(harness: HarnessView): boolean { return harness.management.source === "missing" || !harness.controls.some(control => control.available); }
const ENTRY_SOURCES: Readonly<Record<HarnessEntrySource, string>> = { path: "PATH", "standard-directory": "标准安装目录", "custom-entry": "自定义入口（发现清单）", "package-root": "包目录", managed: "HarnessHub 管理" };
function sourceLabel(harness: HarnessView): string {
  // An explicit custom entry is the user's own registration, not an installation found where comparable products look.
  const entry = harness.controls.find(control => control.id === harness.defaultControlId)?.entry ?? harness.controls.find(control => control.available)?.entry;
  if (harness.management.source !== "managed" && entry?.source === "custom-entry") return ENTRY_SOURCES["custom-entry"];
  return harness.management.source === "managed" ? "HarnessHub 管理" : harness.management.source === "system" ? "系统安装" : "尚未安装";
}
/** The product's own version; an adapter entry in front of it keeps its own version, shown apart. */
function versionOf(harness: HarnessView): string | null { return harness.management.programVersion ?? harness.management.installedVersion; }
function adapterVersion(harness: HarnessView): string | null {
  const program = harness.management.programVersion, entry = harness.management.installedVersion;
  return program !== null && entry !== null && program !== entry ? entry : null;
}
function actionFor(harness: HarnessView): "install" | "upgrade" { return harness.management.native ? harness.management.native.canInstall ? "install" : "upgrade" : missing(harness) ? "install" : "upgrade"; }
function canManage(harness: HarnessView): boolean { return harness.management.native ? harness.management.native.canInstall || harness.management.native.canUpgrade : harness.management.source !== "system" && (harness.management.recipe?.canInstall ?? false); }
function channelLabel(channel: string): string { return ({npm:"npm 全局安装", "brew-formula":"Homebrew", "brew-cask":"Homebrew", uv:"uv 工具", archive:"本机程序目录", "native-cli":"程序官方更新器"} as Record<string,string>)[channel] ?? "原安装渠道"; }
export function HarnessesPage(props: HarnessProps) {
  const { harnesses, jobs } = props;
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "installed" | "missing" | "updates">("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showTasks, setShowTasks] = useState(false);
  const selected = harnesses.find(harness => harness.id === selectedId) ?? null;
  const active = jobs.filter(installationActive);
  const counts = { all: harnesses.length, installed: harnesses.filter(h => !missing(h)).length, missing: harnesses.filter(missing).length, updates: harnesses.filter(h => h.management.updateStatus === "available").length };
  const visible = harnesses.filter(harness => (filter === "all" || filter === "installed" && !missing(harness) || filter === "missing" && missing(harness) || filter === "updates" && harness.management.updateStatus === "available") && `${harness.id} ${harness.name}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
    .sort((a, b) => Number(missing(a)) - Number(missing(b)) || a.name.localeCompare(b.name));
  return <section className="management-page" aria-labelledby="harnesses-title"><header className="management-header"><MobileMenu onClick={props.onMenu}/><div className="page-breadcrumb"><Layers3 size={18} aria-hidden="true"/><span>工作空间</span><ChevronRight size={14}/><strong>Harnesses</strong></div><div className="header-actions"><button className="button secondary" onClick={() => props.onCheckUpdates()} disabled={props.checking}>{props.checking ? <Spinner/> : <RefreshCw size={15}/>}检查更新</button><button className="icon-button" aria-label="重新检测" title="重新检测本机入口" onClick={props.onRescan} disabled={props.scanning}>{props.scanning ? <Spinner/> : <Search size={17}/>}</button></div></header>
    <div className="management-body harness-management-body"><div className="management-title-row"><div><h1 id="harnesses-title">你的 Harness 工作台</h1><p>发现、安装和升级执行者，在同一个入口开始协作。</p></div><button className={`task-center-button ${active.length ? "has-active" : ""}`} onClick={() => setShowTasks(value => !value)} aria-expanded={showTasks}>{active.length ? <Spinner/> : <Clock3 size={16}/>}安装任务<span>{active.length || jobs.length}</span><ChevronRight size={14}/></button></div>
      {props.error ? <ErrorNotice message={props.error} onDismiss={props.onDismissError}/> : null}
      {props.connectionError ? <div className="connection-notice" role="status">{props.connectionError} · 安装状态暂时显示最后一次观察，正在重新连接，不会重跑任务。</div> : null}
      {props.unconfirmed.map(intent => <div className="request-unknown-notice" role="status" key={intent.harnessId}><CircleAlert size={17}/><div><strong>{harnesses.find(h => h.id === intent.harnessId)?.name ?? intent.harnessId} 的请求尚未确认</strong><p>{intent.message}</p></div><button className="button secondary" onClick={() => props.onConfirm(intent.harnessId)} disabled={props.submitting.includes(intent.harnessId)}>确认上次请求</button></div>)}
      {showTasks ? <div className="task-center-panel"><div className="panel-section-heading"><h2>安装任务</h2><span>任务独立运行，关闭详情后仍可在这里查看。</span></div>{jobs.length ? jobs.map(job => <button className={`task-center-row ${job.status}`} key={job.id} onClick={() => { setSelectedId(job.harnessId); }}><BrandIcon brand={job.harnessId} name={harnesses.find(h => h.id === job.harnessId)?.name ?? job.harnessId}/><span><strong>{harnesses.find(h => h.id === job.harnessId)?.name ?? job.harnessId}</strong><small>{job.action === "upgrade" ? "升级" : "安装"} · {job.resolvedVersion ?? "版本待解析"}</small></span><StatusBadge tone={job.status === "completed" ? "success" : job.status === "failed" || job.status === "unknown" ? "danger" : installationActive(job) ? "warning" : "neutral"}>{installationStatus(job)}</StatusBadge><ChevronRight size={14}/></button>) : <p className="no-search-results">暂无安装任务</p>}</div> : null}
      <div className="catalog-toolbar"><div className="catalog-tabs" role="group" aria-label="Harness 过滤">{([{ id: "all", label: "全部" }, { id: "installed", label: "已安装" }, { id: "missing", label: "待安装" }, { id: "updates", label: "可更新" }] as const).map(item => <button className={filter === item.id ? "selected" : ""} aria-pressed={filter === item.id} key={item.id} onClick={() => setFilter(item.id)}>{item.label}<span>{counts[item.id]}</span></button>)}</div><label className="search-field"><Search size={16} aria-hidden="true"/><input aria-label="搜索 Harnesses" placeholder="搜索名称或 ID" value={query} onChange={event => setQuery(event.target.value)}/><kbd>搜索</kbd></label></div>
      {visible.length ? <div className="harness-table"><div className="harness-table-labels"><span>Harness</span><span>版本与来源</span><span>操作</span></div>{visible.map(harness => {
        const job = jobs.find(j => j.id === harness.management.activeJobId) ?? jobs.find(j => j.harnessId === harness.id && installationActive(j));
        const available = harness.controls.some(control => control.available);
        const busy = Boolean(job && installationActive(job)) || props.submitting.includes(harness.id);
        const installable = canManage(harness);
        const needsAction = harness.management.native ? harness.management.native.canInstall || harness.management.native.channel === "native-cli" && harness.management.native.canUpgrade || harness.management.updateStatus === "available" : missing(harness) || harness.management.updateStatus === "available";
        return <article className={`harness-table-row ${selectedId === harness.id ? "selected" : ""}`} key={harness.id}><button className="harness-identity" onClick={() => setSelectedId(harness.id)} aria-label={`查看 ${harness.name} 详情`}><span className="harness-brand-tile"><BrandIcon brand={harness.id} name={harness.name} size={32}/></span><span><strong>{harness.name}</strong><small>{job ? installationStatus(job) : available ? "控制入口已解析" : harness.installed ? "需要控制适配器" : "安装后即可尝试连接"}</small></span></button>
          <div className="harness-version"><strong>{versionOf(harness) ? `v${versionOf(harness)}` : harness.installed ? "版本待检测" : "未安装"}</strong><span>{sourceLabel(harness)}{adapterVersion(harness) ? ` · 接入口 v${adapterVersion(harness)}` : ""}{harness.management.updateStatus === "available" && harness.management.latestVersion ? <em>v{harness.management.latestVersion} 可用</em> : null}</span></div><div className="harness-row-actions">
            {busy ? <button className="button secondary" onClick={() => setSelectedId(harness.id)}><Spinner/>{job ? installationStatus(job) : "提交中"}</button> : needsAction && installable ? <button className={missing(harness) ? "button primary" : "button secondary"} onClick={() => { setSelectedId(harness.id); props.onInstall(harness, actionFor(harness)); }}>{missing(harness) ? <Download size={15}/> : <ArrowUpRight size={15}/>} {actionFor(harness) === "install" ? harness.installed ? "安装适配器" : "安装" : "升级"}</button> : available ? <button className="button secondary" onClick={() => props.onChoose(harness)}>开始对话<ArrowRight size={14}/></button> : <button className="button subtle" onClick={() => setSelectedId(harness.id)}>查看安装详情</button>}
            <button className="icon-button" aria-label={`${harness.name} 的详情`} onClick={() => setSelectedId(harness.id)}><ChevronRight size={17}/></button></div></article>;
      })}</div> : <EmptyState icon={<Layers3 size={28}/>} title={query ? "没有匹配的 Harness" : "这个分类中暂无 Harness"} action={<button className="button secondary" onClick={() => { setQuery(""); setFilter("all"); }}>查看全部目录</button>}>试试其他名称或切换分类。</EmptyState>}
      <div className="management-footnote"><ShieldCheck size={16}/><span>本机安装升级沿用原渠道。执行期间暂停对应程序的新任务；模型配置、登录状态与对话历史保留。</span></div>
    </div>
    {selected ? <HarnessDrawer {...props} harness={selected} onClose={() => setSelectedId(null)}/> : null}
  </section>;
}
function HarnessDrawer(props: HarnessProps & { harness: HarnessView; onClose: () => void }) {
  const { harness } = props;
  const dialog = useRef<HTMLDialogElement>(null), titleId = useId();
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [inspecting, setInspecting] = useState(false), [inspectionError, setInspectionError] = useState<string | null>(null);
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => { element?.close(); }; }, []);
  const related = props.jobs.filter(job => job.harnessId === harness.id);
  const job = related.find(item => item.id === selectedJobId) ?? related.find(installationActive) ?? related[0] ?? null;
  const recipe = harness.management.recipe;
  const unconfirmed = props.unconfirmed.find(item => item.harnessId === harness.id);
  const available = harness.controls.some(control => control.available);
  const busy = Boolean(job && installationActive(job)) || props.submitting.includes(harness.id);
  const inspect = async () => { if (!job || inspecting) return; setInspecting(true); setInspectionError(null); try { await props.api.inspectInstallation(job.id); props.onRescan(); } catch (error) { setInspectionError(errorMessage(error)); } finally { setInspecting(false); } };
  return <dialog className="detail-dialog" ref={dialog} aria-labelledby={titleId} onCancel={props.onClose} onClick={event => { if (event.target === event.currentTarget) { const box = event.currentTarget.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) props.onClose(); } }}>
    <div className="detail-panel"><header className="detail-header"><span className="harness-brand-tile"><BrandIcon brand={harness.id} name={harness.name} size={34}/></span><div><h2 id={titleId}>{harness.name}</h2><p>{sourceLabel(harness)}</p></div><button className="icon-button" aria-label="关闭 Harness 详情" onClick={props.onClose}><X size={19}/></button></header><div className="detail-scroll">
      {props.error ? <ErrorNotice message={props.error} onDismiss={props.onDismissError}/> : null}
      {unconfirmed ? <ErrorNotice message="安装请求的接收结果尚未确认。确认时会沿用原请求，不新建重复任务。"/> : null}
      <div className="detail-version-card"><div><span>当前版本</span><strong>{versionOf(harness) ?? (harness.installed ? "待检测" : "未安装")}</strong>{adapterVersion(harness) ? <small>接入口 {adapterVersion(harness)}</small> : null}</div><div><span>最新版本</span><strong>{harness.management.latestVersion ?? "尚未检查"}</strong></div></div>
      {harness.management.source === "system" ? <div className="detail-info-note"><ShieldCheck size={16}/><p>这里管理终端使用的本机原安装，升级沿用它的原渠道。</p></div> : null}
      {harness.management.native ? <section className="detail-section"><h3>本机安装</h3><p>{channelLabel(harness.management.native.channel)}</p><code>{harness.management.native.location}</code>{harness.management.native.reason ? <p className="detail-limitation">{harness.management.native.reason}</p> : null}</section> : null}<section className="detail-section"><h3>安装来源</h3><dl><div><dt>来源</dt><dd>{recipe?.sourceLabel ?? "暂无受支持的安装方式"}</dd></div>{recipe?.packageName ? <div><dt>包名</dt><dd><code>{recipe.packageName}</code></dd></div> : null}{recipe?.referenceVersion ? <div><dt>目录参考</dt><dd>{recipe.referenceVersion}</dd></div> : null}<div><dt>状态</dt><dd>{harness.management.updateStatus === "current" ? "当前渠道无需升级" : harness.management.updateStatus === "available" ? "有新版本" : harness.management.updateStatus === "failed" ? "版本检查失败" : harness.management.updateStatus === "checking" ? "正在检查" : "未确认更新状态"}</dd></div></dl>{recipe?.reason ? <p className="detail-limitation">{recipe.reason}</p> : !recipe ? <p className="detail-limitation">这个目录项尚无当前环境可用的受管安装配方。</p> : null}{harness.management.error ? <ErrorNotice message={harness.management.error.message}/> : null}</section>
      <section className="detail-section"><h3>控制入口</h3>{harness.controls.map(control => <div className="detail-control" key={control.id}><div><Terminal size={15}/><strong>{protocolLabel(control.protocol)}</strong><StatusBadge tone={control.available ? "success" : "neutral"}>{control.available ? "已解析" : "待准备"}</StatusBadge></div><code>{control.id}</code>{control.entry ? <p className="detail-entry">入口来源：{ENTRY_SOURCES[control.entry.source]}{control.entry.source === "custom-entry" ? "（路径以服务启动时的发现清单为准）" : ""}</p> : null}{control.reason ? <p>{control.reason}</p> : null}</div>)}</section>
      {missing(harness) && harness.install ? <section className="detail-section"><h3>官方安装方式</h3><p>按 {harness.name} 官方说明在终端安装，完成后重新扫描即可使用。HarnessHub 不会替你运行安装命令。</p><code className="detail-command">{harness.install.command}</code><p><a href={harness.install.docs} target="_blank" rel="noreferrer">查看官方说明</a></p></section> : null}
      <section className="detail-section"><h3>模型与登录</h3><p className="detail-limitation">沿用 Harness 本机已有配置。统一 Provider 管理将在后续接入。</p></section>
      {job ? <section className="detail-section job-detail"><div className="panel-section-heading"><h3>安装任务</h3>{related.length > 1 ? <select aria-label="选择安装任务" value={job.id} onChange={event => setSelectedJobId(event.target.value)}>{related.map(item => <option value={item.id} key={item.id}>{item.action === "upgrade" ? "升级" : "安装"} · {item.resolvedVersion ?? item.id.slice(-8)} · {installationStatus(item)}</option>)}</select> : null}</div><div className={`job-status-card ${job.status}`} role="status">{installationActive(job) ? <Spinner/> : job.status === "completed" ? <CheckCheck size={18}/> : job.status === "failed" || job.status === "unknown" ? <CircleAlert size={18}/> : <Square size={15}/>}<div><strong>{installationStatus(job)}</strong><small>{job.status === "completed" ? `${job.resolvedVersion ? "版本 " + job.resolvedVersion + "：" : ""}安装与入口验证已完成` : installationStatus(job)}</small></div></div>{job.native ? <dl className="native-job-facts"><div><dt>本机渠道</dt><dd>{channelLabel(job.native.channel)}</dd></div><div><dt>操作前版本</dt><dd>{job.native.beforeVersion ?? "未安装"}</dd></div><div><dt>已核实版本</dt><dd>{job.native.actualVersion ?? "尚未核实"}</dd></div><div><dt>原配置</dt><dd>{job.native.configurationPreserved === true ? "保留已验证" : "尚未确认"}</dd></div></dl> : null}{job.error && job.status !== "cancelled" ? <ErrorNotice message={job.error.message}/> : null}{job.status === "unknown" ? <p className="detail-limitation">结果或清理状态尚未确认。不会自动重跑，也不会启用不确定的安装版本。</p> : null}{job.native && job.status === "unknown" ? <button className="button secondary" disabled={inspecting} onClick={() => void inspect()}>{inspecting ? <Spinner/> : <Search size={14}/>}核实本机结果</button> : null}{inspectionError ? <ErrorNotice message={inspectionError}/> : null}<InstallationLogs api={props.api} job={job}/>{installationActive(job) ? <button className="button secondary cancel-install" disabled={job.cancelRequested || props.cancelling.includes(job.id)} onClick={() => props.onCancelJob(job)}><Square size={13}/>取消安装任务</button> : null}</section> : null}
    </div><footer className="detail-footer">{available ? <button className="button secondary" onClick={() => { props.onClose(); props.onChoose(harness); }}>开始对话<ArrowRight size={14}/></button> : null}{unconfirmed ? <button className="button primary" disabled={props.submitting.includes(harness.id)} onClick={() => props.onConfirm(harness.id)}>确认上次请求</button> : canManage(harness) ? <button className="button primary" disabled={busy || harness.management.source === "managed" && harness.management.updateStatus === "current"} onClick={() => props.onInstall(harness, actionFor(harness))}>{busy ? <Spinner/> : missing(harness) ? <Download size={16}/> : <ArrowUpRight size={16}/>} {busy ? props.submitting.includes(harness.id) ? "提交中" : "任务运行中" : actionFor(harness) === "install" ? harness.installed ? "安装本机适配器" : "安装 Harness" : harness.management.source === "managed" && harness.management.updateStatus === "current" ? "已是最新" : "升级 Harness"}</button> : null}<button className="icon-button" aria-label={`检查 ${harness.name} 更新`} disabled={props.checking} onClick={() => props.onCheckUpdates([harness.id])}><RefreshCw size={17}/></button></footer></div>
  </dialog>;
}
function InstallationLogs({ api, job }: { api: GatewayApi; job: InstallationJobView }) {
  const [logs, setLogs] = useState<readonly InstallationLog[]>([]), [fault, setFault] = useState<string | null>(null);
  const live = useRef(job); live.current = job;
  useEffect(() => {
    let stopped = false, cursor = 0, bytes = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const controller = new AbortController();
    setLogs([]); setFault(null);
    const read = async () => {
      try {
        const page = await api.installationLogs(job.id, cursor, AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]));
        if (stopped) return;
        const nextBytes = page.entries.reduce((size, line) => size + new TextEncoder().encode(line.text).byteLength, bytes);
        if (nextBytes > 1024 * 1024 || page.nextSeq > 1000) { setFault("日志已达到页面显示上限；完整记录保留在网关中。"); return; }
        bytes = nextBytes; cursor = page.nextSeq;
        setLogs(current => [...current, ...page.entries.filter(line => !current.some(existing => existing.seq === line.seq))]);
        if (page.hasMore || installationActive(live.current)) timer = setTimeout(() => void read(), document.hidden ? 10_000 : 900);
      } catch (error: unknown) { if (!stopped) setFault(errorMessage(error)); }
    };
    void read();
    return () => { stopped = true; controller.abort(); if (timer !== null) clearTimeout(timer); };
  }, [api, job.id]);
  return <details className="installation-logs"><summary><Package size={14}/>安装日志<span>{logs.length}</span></summary>{fault ? <ErrorNotice message={fault}/> : null}<div className="log-output" role="log" aria-label="安装日志" aria-live="off">{logs.length ? logs.map(line => <div className={`log-line ${line.stream}`} key={line.seq}><span>{new Date(line.time).toLocaleTimeString("zh-CN", { hour12: false })}</span><code>{line.text}</code></div>) : <p>暂无日志输出</p>}</div></details>;
}
