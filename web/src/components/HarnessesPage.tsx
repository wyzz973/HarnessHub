import { ArrowRight, ArrowUpRight, CheckCheck, ChevronRight, CircleAlert, Clock3, Download, Package, RefreshCw, Search, ShieldCheck, Square, Terminal, X } from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { HarnessEntrySource, HarnessView, InstallationView } from "../../../src/contracts/web.js";
import type { InstallationJobView, InstallationLog } from "../../../src/contracts/management.js";
import { errorMessage, failureMessage, GatewayApi, protocolLabel } from "../api.js";
import { cn } from "../lib/cn.js";
import { Dialog } from "../ui/overlay.js";
import { Badge, EmptyState, Notice, Spinner, Tip } from "../ui/primitives.js";
import { BrandIcon } from "./BrandIcon.js";
import { PageShell } from "./PageShell.js";
import { UpgradeDialog, type UpgradeConsent } from "./UpgradeDialog.js";
import { UninstallDialog, type UninstallConsent } from "./UninstallDialog.js";
import { InstallDialog } from "./InstallDialog.js";
import { InstallationUpgradeDialog, upgradeLabel } from "./InstallationUpgradeDialog.js";

export interface UnconfirmedInstallation { harnessId: string; action: "install" | "upgrade" | "uninstall"; message: string }
function verbOf(job: InstallationJobView): string { return job.action === "upgrade" ? "升级" : job.action === "uninstall" ? "卸载" : "安装"; }
export function installationActive(job: InstallationJobView): boolean { return ["queued", "resolving", "installing", "verifying", "activating"].includes(job.status); }
/** A task's state in the user's terms: an upgrade that stopped before changing anything did not happen; it did not fail (ADR-043). */
export function installationStatus(job: InstallationJobView): string {
  if (job.cancelRequested && installationActive(job)) return "正在取消并清理";
  const verb = verbOf(job);
  switch (job.status) {
    case "queued": return "等待" + verb;
    case "resolving": return "正在检查";
    case "installing": return "正在" + verb;
    case "verifying": return "正在核实";
    case "activating": return job.native ? "正在重启后台服务" : "正在启用版本";
    case "completed": return verb + "完成";
    case "cancelled": return "已取消";
    case "unknown": return "结果待核实";
    case "failed":
      if (job.native && !job.native.dispatched) return "没有" + verb;
      if (job.native?.installation) return verb + "失败";
      if (job.native?.actualVersion) return "已" + verb + (job.error?.code === "SERVICE_NOT_READY" ? "，服务未就绪" : "，服务未恢复");
      return verb + "失败";
  }
}
/** Whether a finished task changed nothing: a native one stopped before its channel ran. */
function unchanged(job: InstallationJobView): boolean { return job.status !== "completed" && !installationActive(job) && job.native !== undefined && !job.native.dispatched; }
/** The refusal earlier versions recorded when any program of the installation ran; it told users to end a task that did not exist. */
const LEGACY_BUSY = ["本机程序仍有活动进程，请结束对应任务后再升级；其他对话可以继续。", "native program has active or unconfirmed users", "native installation has active users"];
function jobError(job: InstallationJobView): string | null {
  if (!job.error || job.status === "cancelled") return null;
  if (job.error.code === "HARNESS_BUSY" && LEGACY_BUSY.includes(job.error.message))
    return "开始前发现这个程序正在运行（例如它的后台服务），按当时的规则没有升级。现在再点升级，会先列出需要重启或关闭的程序，由你确认后再升级。";
  return /[\u4e00-\u9fff]/u.test(job.error.message) ? job.error.message : failureMessage(job.error);
}
function jobSummary(job: InstallationJobView, name: string): string {
  const verb = verbOf(job), native = job.native;
  if (native?.official) {
    if (job.status === "completed") return "已按官网方式安装 " + name + " " + job.resolvedVersion + "。" + (native.official.shellChanges.length ? "安装脚本改了 " + native.official.shellChanges.map(change => change.file).join("、") + "。" : "");
    if (unchanged(job)) return name + " 没有安装，什么都没有改动。";
    if (job.status === "unknown") return "结果尚未确认，可以核实本机结果。";
    return installationStatus(job);
  }
  if (native?.installation) {
    const facts = native.installation, what = facts.label + "里的 " + (facts.role === "adapter" ? name + " 的接入口" : name);
    if (job.status === "completed") return native.beforeVersion === job.resolvedVersion ? what + " 已是最新：" + job.resolvedVersion + "。" : "已升级" + what + "：" + (native.beforeVersion ?? "原版本") + " → " + job.resolvedVersion + "。";
    if (unchanged(job)) return what + " 没有任何改动，仍是 " + (native.beforeVersion ?? "原版本") + "。";
    if (job.status === "failed" && native.actualVersion) return "升级没有成功结束，" + what + " 现在是 " + native.actualVersion + "。";
    if (job.status === "unknown") return "结果尚未确认，可以核实本机结果。";
    return installationStatus(job);
  }
  if (job.action === "uninstall" && native?.uninstall) {
    const facts = native.uninstall, what = facts.role === "adapter" ? name + " 的接入口" : name;
    if (job.status === "completed") return "已卸载" + facts.label + "里的 " + what + (job.resolvedVersion ? " " + job.resolvedVersion : "") + (facts.stoppedServices.length ? "，已停止并注销 " + facts.stoppedServices.join("、") : "") + "，配置、登录和会话数据保留。";
    if (unchanged(job)) return facts.label + "里的 " + what + " 没有任何改动。";
    if (job.status === "unknown") return "结果尚未确认" + (facts.stoppedServices.length ? "（已停止并注销 " + facts.stoppedServices.join("、") + "）" : "") + "。";
    return installationStatus(job);
  }
  if (job.status === "completed") {
    const restarted = native?.services?.filter(service => service.outcome === "restarted").map(service => service.label) ?? [];
    return (job.resolvedVersion ? "已" + verb + "到 " + job.resolvedVersion : verb + "完成") + (restarted.length ? "，已重启 " + restarted.join("、") : "") + (native ? "，原配置保留。" : "，入口验证已完成。");
  }
  if (unchanged(job)) return name + " 没有任何改动，仍是 " + (native?.beforeVersion ?? "原版本") + "。" + (native?.closedConversations ? "升级前关闭了 " + native.closedConversations + " 个对话保留的进程，它们下次发消息时会重新连接。" : "");
  if (job.status === "failed" && native?.actualVersion) return "新版本 " + native.actualVersion + " 已安装，原配置保留。";
  if (job.status === "unknown") return "结果或清理状态尚未确认。";
  return installationStatus(job);
}
function serviceOutcome(service: NonNullable<NonNullable<InstallationJobView["native"]>["services"]>[number]): string {
  if (service.outcome === "not_running") return "当时已不在运行，没有重启";
  if (service.outcome === "not_recovered") return "重启后没有重新运行";
  return "已重启（进程 " + service.pid + "）" + (service.ready === true ? "，正在监听" : service.ready === false ? "，没有在端口上监听" : "，可用性未验证");
}
interface HarnessProps {
  api: GatewayApi; harnesses: readonly HarnessView[];
  /** The Harnesses the list leaves out (ADR-050): the frozen ones, unless the user shows them in the settings. */
  hidden: ReadonlySet<string>;
  /** Opens the settings, where the frozen Harnesses can be shown. */
  onSettings: () => void;
  installationPolicy: "official" | "any"; jobs: readonly InstallationJobView[]; scanning: boolean; checking: boolean;
  submitting: readonly string[]; cancelling: readonly string[]; error: string | null; connectionError: string | null; unconfirmed: readonly UnconfirmedInstallation[];
  onRescan: () => void; onCheckUpdates: (ids?: readonly string[]) => void; onInstall: (harness: HarnessView, action: "install" | "upgrade", consent?: UpgradeConsent) => void;
  /** Uninstalls one installation the user confirmed (ADR-044). */
  onUninstall: (harness: HarnessView, installation: InstallationView, consent: UninstallConsent) => void;
  /** Installs a missing product the official way, as the confirmed check prepared it (ADR-044). */
  onInstallOfficial: (harness: HarnessView, fingerprint: string) => void;
  /** Upgrades one installation through its channel, as the confirmed check prepared it (ADR-044). */
  onUpgradeInstallation: (harness: HarnessView, installation: InstallationView, fingerprint: string) => void;
  /** Opens a conversation, e.g. one that blocks an upgrade. */
  onOpenSession: (id: string) => void;
  onConfirm: (id: string) => void; onCancelJob: (job: InstallationJobView) => void; onDismissError: () => void; onMenu: () => void; onChoose: (harness: HarnessView) => void;
  /** Opens the capability page for one Harness (ADR-045). */
  onCapabilities: (harnessId: string) => void;
  sidebarHidden: boolean; onExpandSidebar: () => void; onChat: () => void;
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
/** Whether HarnessHub installs this product the official way here: its product is not installed and its method can run (ADR-044). */
function officialInstallable(harness: HarnessView): boolean { return harness.install?.available === true && !harness.installations.some(item => item.role === "product"); }
/** What the last update check found for one installation (ADR-044); Homebrew's answer is its local records. */
function latestNote(item: InstallationView): string {
  const latest = item.latest; if (latest === null) return "";
  if (latest.error !== null || latest.version === null) return " · 没有查到最新版本";
  const records = latest.source === "homebrew-local" ? "（Homebrew 本地记录）" : "";
  return latest.version === item.version ? " · 已是最新" + records : " · 可升级到 v" + latest.version + records;
}
function channelLabel(channel: string): string { return ({ script: "官方安装脚本", npm: "npm 全局安装", "brew-formula": "Homebrew", "brew-cask": "Homebrew", uv: "uv 工具", archive: "本机程序目录", "native-cli": "程序官方更新器" } as Record<string, string>)[channel] ?? "原安装渠道"; }

type Filter = "all" | "installed" | "missing" | "updates";
/** “我的 Agent”: the Harnesses found on this computer, their versions and sources, and maintenance through each one's own channel. */
export function HarnessesPage(props: HarnessProps) {
  const { harnesses, jobs } = props;
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showTasks, setShowTasks] = useState(false);
  const [confirming, setConfirming] = useState<{ readonly harness: HarnessView; readonly fromDetail: boolean } | null>(null);
  // Uninstalling also shows what it removes, stops and keeps first; the confirmation takes the details' place like an upgrade's.
  const [removing, setRemoving] = useState<{ readonly harness: HarnessView; readonly installation: InstallationView } | null>(null);
  // An official install shows what it runs and changes first, in the details' place like the other confirmations.
  const [installing, setInstalling] = useState<{ readonly harness: HarnessView; readonly fromDetail: boolean } | null>(null);
  // Upgrading one installation shows what it runs and changes first, in the details' place like the other confirmations.
  const [upgrading, setUpgrading] = useState<{ readonly harness: HarnessView; readonly installation: InstallationView } | null>(null);
  const installOfficial = (harness: HarnessView, fromDetail = false) => { setSelectedId(null); setInstalling({ harness, fromDetail }); };
  const selected = harnesses.find(harness => harness.id === selectedId) ?? null;
  // Upgrading an installed program first shows what it touches and asks for consent (ADR-043); installing does not. The
  // confirmation takes the details' place while it is open, and the details come back with the task once it is sent.
  const request = (harness: HarnessView, fromDetail = false) => {
    const action = actionFor(harness);
    if (action === "upgrade" && harness.management.native) { setSelectedId(null); setConfirming({ harness, fromDetail }); return; }
    setSelectedId(harness.id); props.onInstall(harness, action);
  };
  const closeConfirmation = () => { const from = confirming?.fromDetail ? confirming.harness.id : null; setConfirming(null); if (from) setSelectedId(from); };
  const active = jobs.filter(installationActive);
  // The list and its counts leave out the hidden Harnesses; details, tasks and names still find every one.
  const listed = harnesses.filter(harness => !props.hidden.has(harness.id)), hiddenCount = harnesses.length - listed.length;
  const counts = { all: listed.length, installed: listed.filter(h => !missing(h)).length, missing: listed.filter(missing).length, updates: listed.filter(h => h.management.updateStatus === "available").length };
  const visible = listed.filter(harness => (filter === "all" || filter === "installed" && !missing(harness) || filter === "missing" && missing(harness) || filter === "updates" && harness.management.updateStatus === "available") && `${harness.id} ${harness.name}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
    .sort((a, b) => Number(missing(a)) - Number(missing(b)) || a.name.localeCompare(b.name));
  return <PageShell title="我的 Agent" titleId="harnesses-title" onMenu={props.onMenu} sidebarHidden={props.sidebarHidden} onExpandSidebar={props.onExpandSidebar} onBack={props.onChat} wide bodyClassName="harness-management-body"
    description="这台电脑上的 Harness：版本、来源和维护都沿用它们自己的安装渠道。模型配置、登录状态与对话历史都保留在原程序中。"
    actions={<>
      <button type="button" className={cn("btn hidden sm:inline-flex", active.length && "text-accent-text")} onClick={() => setShowTasks(value => !value)} aria-expanded={showTasks}>{active.length ? <Spinner size={13}/> : <Clock3 size={14}/>}安装任务<span className="text-fg-3">{active.length || jobs.length}</span></button>
      <button type="button" className="btn" onClick={() => props.onCheckUpdates()} disabled={props.checking}>{props.checking ? <Spinner size={13}/> : <RefreshCw size={14}/>}<span className="hidden sm:inline">检查更新</span></button>
      <Tip label="重新检测本机入口"><button type="button" className="icon-btn" aria-label="重新检测" onClick={props.onRescan} disabled={props.scanning}>{props.scanning ? <Spinner size={15}/> : <Search size={16}/>}</button></Tip>
    </>}>
    {props.installationPolicy === "any" ? <Notice tone="amber" className="development-entries">开发模式：接受非官网安装。服务以 --allow-unofficial 启动，列表里的开发入口不是正式安装。</Notice> : null}
    {props.error ? <Notice tone="red" onDismiss={props.onDismissError}>{props.error}</Notice> : null}
    {props.connectionError ? <Notice tone="amber" className="connection-notice">{props.connectionError} · 安装状态暂时显示最后一次观察，正在重新连接，不会重跑任务。</Notice> : null}
    {props.unconfirmed.map(intent => <Notice key={intent.harnessId} tone="amber" title={`${harnesses.find(h => h.id === intent.harnessId)?.name ?? intent.harnessId} 的请求尚未确认`}
      action={<button className="btn btn-sm" onClick={() => props.onConfirm(intent.harnessId)} disabled={props.submitting.includes(intent.harnessId)}>确认上次请求</button>}>{intent.message}</Notice>)}
    {showTasks ? <div className="enter rounded-xl border border-line bg-surface p-2">
      <div className="flex items-baseline justify-between gap-2 px-2 pt-1 pb-2"><h2 className="m-0 text-[13px] font-semibold">安装任务</h2><span className="text-[12px] text-fg-3">任务独立运行，关闭详情后仍可在这里查看。</span></div>
      {jobs.length ? jobs.map(job => <button type="button" key={job.id} onClick={() => setSelectedId(job.harnessId)} className="flex w-full items-center gap-2.5 rounded-lg border-none bg-transparent px-2 py-2 text-left hover:bg-hover">
        <BrandIcon brand={job.harnessId} name={harnesses.find(h => h.id === job.harnessId)?.name ?? job.harnessId} size={22}/>
        <span className="min-w-0 flex-1"><strong className="block truncate text-[13px] font-medium">{harnesses.find(h => h.id === job.harnessId)?.name ?? job.harnessId}</strong><small className="text-[12px] text-fg-3">{job.action === "upgrade" ? "升级" : "安装"} · {job.resolvedVersion ?? "版本待解析"}</small></span>
        <Badge tone={job.status === "completed" ? "green" : job.status === "failed" || job.status === "unknown" ? "red" : installationActive(job) ? "accent" : "neutral"} dot>{installationStatus(job)}</Badge><ChevronRight size={14} className="text-fg-3"/></button>)
        : <p className="m-0 px-2 py-3 text-[12.5px] text-fg-3">暂无安装任务</p>}
    </div> : null}
    <div className="flex flex-wrap items-center gap-3">
      <div className="segmented" role="group" aria-label="Harness 过滤">{([{ id: "all", label: "全部" }, { id: "installed", label: "已安装" }, { id: "missing", label: "待安装" }, { id: "updates", label: "可更新" }] as const).map(item =>
        <button type="button" aria-pressed={filter === item.id} key={item.id} onClick={() => setFilter(item.id)}>{item.label}<span className="ml-1 text-fg-3">{counts[item.id]}</span></button>)}</div>
      <label className="flex h-9 min-w-[200px] flex-1 items-center gap-2 rounded-lg border border-line-strong bg-surface px-3"><Search size={15} className="text-fg-3" aria-hidden="true"/><input className="min-w-0 flex-1 border-none bg-transparent text-[13.5px] outline-none" aria-label="搜索 Harnesses" placeholder="搜索名称或 ID" value={query} onChange={event => setQuery(event.target.value)}/></label>
    </div>
    {visible.length ? <div className="overflow-hidden rounded-xl border border-line bg-surface shadow-sm">{visible.map((harness, index) => {
      const job = jobs.find(j => j.id === harness.management.activeJobId) ?? jobs.find(j => j.harnessId === harness.id && installationActive(j));
      const available = harness.controls.some(control => control.available);
      const busy = Boolean(job && installationActive(job)) || props.submitting.includes(harness.id);
      const installable = canManage(harness);
      const needsAction = harness.management.native ? harness.management.native.canInstall || harness.management.native.channel === "native-cli" && harness.management.native.canUpgrade || harness.management.updateStatus === "available" : missing(harness) || harness.management.updateStatus === "available";
      return <article key={harness.id} className={cn("harness-table-row flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 md:grid md:grid-cols-[minmax(0,1fr)_230px_190px]", index > 0 && "border-t border-line", selectedId === harness.id && "bg-subtle")}>
        <button type="button" onClick={() => setSelectedId(harness.id)} aria-label={`查看 ${harness.name} 详情`} className="flex min-w-[200px] flex-1 items-center gap-3 border-none bg-transparent p-0 text-left md:min-w-0">
          <BrandIcon brand={harness.id} name={harness.name} size={30}/>
          <span className="min-w-0"><span className="flex min-w-0 items-center gap-1.5"><strong className="block truncate text-[14px] font-semibold">{harness.name}</strong>
            {harness.tier === "frozen" ? <Badge tone="neutral" className="harness-frozen flex-none" title="冻结：保留适配与历史对话，不再打磨">冻结</Badge> : null}</span>
            <small className={cn("text-[12px]", available ? "text-fg-3" : "text-fg-3")}>{job ? installationStatus(job) : available ? "控制入口已解析" : harness.installed ? "需要控制适配器" : "安装后即可尝试连接"}</small></span>
        </button>
        <div className="flex min-w-[170px] flex-col text-[12.5px]">
          <span className="flex items-center gap-1.5 font-medium">{versionOf(harness) ? `v${versionOf(harness)}` : harness.installed ? "版本待检测" : "未安装"}</span>
          <span className="text-fg-3">{sourceLabel(harness)}{adapterVersion(harness) ? ` · 接入口 v${adapterVersion(harness)}` : ""}{harness.management.updateStatus === "available" && harness.management.latestVersion ? <em className="ml-1 not-italic text-accent-text">v{harness.management.latestVersion} 可用</em> : null}</span>
        </div>
        <div className="flex flex-none items-center justify-end gap-1.5">
          {busy ? <button type="button" className="btn btn-sm" onClick={() => setSelectedId(harness.id)}><Spinner size={13}/>{job ? installationStatus(job) : "提交中"}</button>
            : officialInstallable(harness) ? <button type="button" className="btn btn-sm btn-primary" onClick={() => installOfficial(harness)}><Download size={13}/>安装</button>
            : needsAction && installable ? <button type="button" className={cn("btn btn-sm", missing(harness) && "btn-primary")} onClick={() => request(harness)}>{missing(harness) ? <Download size={13}/> : <ArrowUpRight size={13}/>}{actionFor(harness) === "install" ? harness.installed ? "安装适配器" : "安装" : "升级"}</button>
            : available ? <button type="button" className="btn btn-sm" onClick={() => props.onChoose(harness)}>开始对话<ArrowRight size={13}/></button>
            : <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSelectedId(harness.id)}>查看安装方式</button>}
          <button type="button" className="icon-btn icon-btn-sm" aria-label={`${harness.name} 的详情`} onClick={() => setSelectedId(harness.id)}><ChevronRight size={15}/></button>
        </div>
      </article>;
    })}</div> : <EmptyState title={query ? "没有匹配的 Harness" : "这个分类中暂无 Harness"} action={<button className="btn" onClick={() => { setQuery(""); setFilter("all"); }}>查看全部</button>}>试试其他名称或切换分类。</EmptyState>}
    {hiddenCount > 0 ? <p className="hidden-frozen m-0 text-[12.5px] text-fg-3">已隐藏 {hiddenCount} 个冻结的 Harness，<button type="button" className="link-btn text-[12.5px]" onClick={props.onSettings}>可在设置里显示</button></p> : null}
    <p className="m-0 flex items-start gap-2 text-[12.5px] text-fg-3"><ShieldCheck size={14} className="mt-0.5 flex-none"/><span>本机安装升级沿用原渠道。执行期间暂停对应程序的新任务；模型配置、登录状态与对话历史保留。搜索目录可以在“设置 → 发现”中补充。</span></p>
    <Dialog open={selected !== null} onOpenChange={open => { if (!open) setSelectedId(null); }} title={selected ? `${selected.name} 详情` : "Harness 详情"} kind="drawer">
      {selected ? <HarnessDetail {...props} harness={selected} onClose={() => setSelectedId(null)} onRequest={harness => request(harness, true)} onInstallRequest={harness => installOfficial(harness, true)}
        onUninstallRequest={(harness, installation) => { setSelectedId(null); setRemoving({ harness, installation }); }}
        onUpgradeRequest={(harness, installation) => { if (installation.upgrade === "maintenance") { request(harness, true); return; } setSelectedId(null); setUpgrading({ harness, installation }); }}/> : null}
    </Dialog>
    <UpgradeDialog api={props.api} harness={confirming?.harness ?? null} onClose={closeConfirmation} onConfirm={(harness, consent) => { setConfirming(null); setSelectedId(harness.id); props.onInstall(harness, "upgrade", consent); }}
      onOpenSession={id => { setConfirming(null); setSelectedId(null); props.onOpenSession(id); }}/>
    <InstallDialog api={props.api} harness={installing?.harness ?? null}
      onClose={() => { const from = installing?.fromDetail ? installing.harness.id : null; setInstalling(null); if (from) setSelectedId(from); }}
      onConfirm={(harness, fingerprint) => { setInstalling(null); setSelectedId(harness.id); props.onInstallOfficial(harness, fingerprint); }}/>
    <InstallationUpgradeDialog api={props.api} harness={upgrading?.harness ?? null} installation={upgrading?.installation ?? null}
      onClose={() => { const from = upgrading?.harness.id ?? null; setUpgrading(null); if (from) setSelectedId(from); }}
      onConfirm={(harness, installation, fingerprint) => { setUpgrading(null); setSelectedId(harness.id); props.onUpgradeInstallation(harness, installation, fingerprint); }}
      onOpenSession={id => { setUpgrading(null); setSelectedId(null); props.onOpenSession(id); }}/>
    <UninstallDialog api={props.api} harness={removing?.harness ?? null} installation={removing?.installation ?? null}
      onClose={() => { const from = removing?.harness.id ?? null; setRemoving(null); if (from) setSelectedId(from); }}
      onConfirm={(harness, installation, consent) => { setRemoving(null); setSelectedId(harness.id); props.onUninstall(harness, installation, consent); }}
      onOpenSession={id => { setRemoving(null); setSelectedId(null); props.onOpenSession(id); }}/>
  </PageShell>;
}
function DetailSection({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return <section className="flex flex-col gap-2 border-t border-line px-5 py-4 first:border-t-0"><h3 className="m-0 text-[12.5px] font-semibold text-fg-2">{title}</h3>{children}</section>;
}
function HarnessDetail(props: HarnessProps & { harness: HarnessView; onClose: () => void; onRequest: (harness: HarnessView) => void; onInstallRequest: (harness: HarnessView) => void; onUninstallRequest: (harness: HarnessView, installation: InstallationView) => void;
  onUpgradeRequest: (harness: HarnessView, installation: InstallationView) => void }) {
  const { harness } = props;
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [inspecting, setInspecting] = useState(false), [inspectionError, setInspectionError] = useState<string | null>(null);
  const related = props.jobs.filter(job => job.harnessId === harness.id);
  const job = related.find(item => item.id === selectedJobId) ?? related.find(installationActive) ?? related[0] ?? null;
  const recipe = harness.management.recipe;
  const unconfirmed = props.unconfirmed.find(item => item.harnessId === harness.id);
  const available = harness.controls.some(control => control.available);
  const busy = Boolean(job && installationActive(job)) || props.submitting.includes(harness.id);
  const inspect = async () => { if (!job || inspecting) return; setInspecting(true); setInspectionError(null); try { await props.api.inspectInstallation(job.id); props.onRescan(); } catch (error) { setInspectionError(errorMessage(error)); } finally { setInspecting(false); } };
  const fact = "grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13px]";
  return <>
    <header className="flex items-center gap-3 border-b border-line px-5 py-4"><BrandIcon brand={harness.id} name={harness.name} size={34}/>
      <div className="min-w-0 flex-1"><h2 className="m-0 truncate text-[16px] font-semibold">{harness.name}</h2><p className="m-0 text-[12.5px] text-fg-2">{sourceLabel(harness)}</p></div>
      <button type="button" className="icon-btn" aria-label="关闭 Harness 详情" onClick={props.onClose}><X size={18}/></button></header>
    <div className="scroll-area min-h-0 flex-1">
      {props.error ? <div className="px-5 pt-4"><Notice tone="red" onDismiss={props.onDismissError}>{props.error}</Notice></div> : null}
      {unconfirmed ? <div className="px-5 pt-4"><Notice tone="amber">安装请求的接收结果尚未确认。确认时会沿用原请求，不新建重复任务。</Notice></div> : null}
      <DetailSection title="版本">
        <div className="grid grid-cols-2 gap-3"><div className="rounded-lg bg-subtle px-3 py-2.5"><span className="block text-[11.5px] text-fg-3">当前版本</span><strong className="text-[15px] font-semibold">{versionOf(harness) ?? (harness.installed ? "待检测" : "未安装")}</strong>{adapterVersion(harness) ? <small className="block text-[12px] text-fg-3">接入口 {adapterVersion(harness)}</small> : null}</div>
          <div className="rounded-lg bg-subtle px-3 py-2.5"><span className="block text-[11.5px] text-fg-3">最新版本</span><strong className="text-[15px] font-semibold">{harness.management.latestVersion ?? "尚未检查"}</strong></div></div>
        {harness.install?.note ? <p className="harness-install-note m-0 text-[12.5px] text-fg-2">{harness.install.note}</p> : null}
        {harness.management.source === "system" ? <p className="m-0 flex items-start gap-2 text-[12.5px] text-fg-2"><ShieldCheck size={14} className="mt-0.5 flex-none text-fg-3"/>这里管理终端使用的本机原安装，升级沿用它的原渠道。</p> : null}
      </DetailSection>
      {harness.installations.length > 0 ? <DetailSection title="本机找到的官网安装"><ul className="harness-installations m-0 flex list-none flex-col gap-1.5 p-0">{harness.installations.map((item, index) =>
        <li key={index} className="flex flex-col gap-0.5 rounded-lg border border-line px-3 py-2"><span className="flex flex-wrap items-center gap-1.5 text-[13px]"><strong className="font-medium">{item.label}</strong>
          {item.role === "adapter" ? <Badge tone="neutral">接入口 {item.command}</Badge> : null}{item.active ? <span title="按 HarnessHub 服务进程的 PATH 顺序；终端里可能不同"><Badge tone="green" dot>当前使用</Badge></span> : null}
          <span className="ml-auto flex items-center gap-1">
            {item.upgrade !== null ? <button type="button" className="btn btn-ghost btn-sm" disabled={busy} aria-label={`${upgradeLabel(item)}：${item.label}里的 ${item.command}`} onClick={() => props.onUpgradeRequest(harness, item)}>{upgradeLabel(item)}</button> : null}
            {item.canUninstall ? <button type="button" className="btn btn-ghost btn-sm btn-danger" disabled={busy} aria-label={`卸载${item.label}里的 ${item.command}`} onClick={() => props.onUninstallRequest(harness, item)}>卸载</button> : null}</span></span>
          <small className="text-[12px] text-fg-3">{item.version === null ? "版本未记录" : `v${item.version}`}{item.maintained ? "" : " · 当前版本不维护这种安装方式"}{latestNote(item)}</small></li>)}</ul>
        {harness.installations.filter(item => item.role === "product").length > 1 ? <p className="m-0 text-[12px] text-fg-2">“当前使用”按 HarnessHub 服务进程的 PATH 顺序确定；终端常被 nvm 等改动 PATH，用的可能是另一份。</p> : null}</DetailSection> : null}
      {harness.unofficial ? <DetailSection title="非官网安装"><p className="harness-unofficial m-0 text-[12.5px] text-fg-2">在{harness.unofficial.onPath ? " PATH " : "标准目录"}中发现一个非官网安装（开发目录、npm link 或其他），命令名 {harness.unofficial.command}；平台不使用也不维护它。{harness.unofficial.pathDefault ? harness.installations.some(item => item.role === "product") ? `终端里 ${harness.unofficial.command} 运行的是这份非官网安装；HarnessHub 使用的是标为“当前使用”的官网安装。` : "终端里能用的就是它。" : ""}</p></DetailSection> : null}
      {job ? <DetailSection title="安装任务">
        {related.length > 1 ? <select className="field h-8 text-[12.5px]" aria-label="选择安装任务" value={job.id} onChange={event => setSelectedJobId(event.target.value)}>{related.map(item => <option value={item.id} key={item.id}>{item.action === "upgrade" ? "升级" : "安装"} · {item.resolvedVersion ?? item.id.slice(-8)} · {installationStatus(item)}</option>)}</select> : null}
        <div className={cn("installation-state flex items-center gap-2.5 rounded-lg border px-3 py-2.5", unchanged(job) ? "border-amber-line bg-amber-soft" : job.status === "failed" || job.status === "unknown" ? "border-red-line bg-red-soft" : job.status === "completed" ? "border-line bg-green-soft" : "border-line bg-subtle")} role="status">
          {installationActive(job) ? <Spinner size={16}/> : job.status === "completed" ? <CheckCheck size={17} className="text-green"/> : unchanged(job) ? <CircleAlert size={17} className="text-amber"/> : job.status === "failed" || job.status === "unknown" ? <CircleAlert size={17} className="text-red"/> : <Square size={14} className="text-fg-3"/>}
          <div className="min-w-0"><strong className="block text-[13px] font-semibold">{installationStatus(job)}</strong><small className="text-[12px] text-fg-2">{jobSummary(job, harness.name)}</small></div></div>
        {jobError(job) ? <Notice tone={unchanged(job) ? "amber" : "red"}>{jobError(job)}</Notice> : null}
        {job.native ? <dl className={cn("m-0", fact)}><dt className="text-fg-3">本机渠道</dt><dd className="m-0">{channelLabel(job.native.channel)}</dd><dt className="text-fg-3">操作前版本</dt><dd className="m-0">{job.native.beforeVersion ?? "未安装"}</dd>
          {job.native.dispatched ? <><dt className="text-fg-3">已核实版本</dt><dd className="m-0">{job.native.actualVersion ?? "尚未核实"}</dd><dt className="text-fg-3">原配置</dt><dd className="m-0">{job.native.configurationPreserved === true ? job.native.configurationChangedByService ? "安装时没有改动；重启后服务自己改写了它" : "保留，已核实" : "尚未确认"}</dd></> : null}
          {job.native.services?.map(service => <Fragment key={service.label}><dt className="text-fg-3">后台服务</dt><dd className="m-0 break-all">{service.label}：{serviceOutcome(service)}</dd></Fragment>)}
          {job.native.closedConversations ? <><dt className="text-fg-3">空闲进程</dt><dd className="m-0">关闭了 {job.native.closedConversations} 个，下次发消息时重新连接</dd></> : null}
          {job.native.clearedRecords ? <><dt className="text-fg-3">旧记录</dt><dd className="m-0">清除了 {job.native.clearedRecords} 条</dd></> : null}
          {job.native.official ? <><dt className="text-fg-3">来源</dt><dd className="m-0 break-all">{job.native.official.source}{job.native.official.sha256 ? `（SHA-256 ${job.native.official.sha256.slice(0, 16)}…）` : ""}</dd>
            {job.native.official.shellChanges.map(change => <Fragment key={change.file}><dt className="text-fg-3">shell 配置</dt><dd className="official-shell m-0 break-all">{change.file}：{change.added.length ? "加了 " + change.added.join(" ／ ") : ""}{change.removed.length ? " 删了 " + change.removed.join(" ／ ") : ""}</dd></Fragment>)}
            {job.native.official.configChanges.map(change => <Fragment key={change.file}><dt className="text-fg-3">设置改动</dt><dd className="m-0 break-all">{change.file}：{change.keys.map(key => key.value === null ? key.path + "（值已更改，未显示）" : key.path + " = " + key.value).join("、")}</dd></Fragment>)}
            {job.native.official.blocked.length ? <><dt className="text-fg-3">被阻止</dt><dd className="official-blocked m-0 break-all">安装程序尝试写入 {job.native.official.blocked.join("、")}，已被阻止</dd></> : null}</> : null}
          {job.native.installation ? <><dt className="text-fg-3">运行</dt><dd className="m-0 break-all"><code className="text-[12px]">{job.native.installation.command}</code></dd>
            {job.native.installation.dependencies.length ? <><dt className="text-fg-3">一并处理</dt><dd className="upgrade-job-dependencies m-0 break-all">{job.native.installation.dependencies.join("、")}</dd></> : null}
            {job.native.installation.shellChanges.map(change => <Fragment key={change.file}><dt className="text-fg-3">shell 配置</dt><dd className="m-0 break-all">{change.file}：{change.added.length ? "加了 " + change.added.join(" ／ ") : ""}{change.removed.length ? " 删了 " + change.removed.join(" ／ ") : ""}</dd></Fragment>)}
            {job.native.installation.configChanges.map(change => <Fragment key={change.file}><dt className="text-fg-3">设置改动</dt><dd className="m-0 break-all">{change.file}：{change.keys.map(key => key.value === null ? key.path + "（值已更改，未显示）" : key.path + " = " + key.value).join("、")}</dd></Fragment>)}
            {job.native.installation.blocked.length ? <><dt className="text-fg-3">被阻止</dt><dd className="m-0 break-all">更新程序尝试写入 {job.native.installation.blocked.join("、")}，已被阻止</dd></> : null}</> : null}</dl> : null}
        {job.status === "unknown" ? <p className="m-0 text-[12.5px] text-amber">结果或清理状态尚未确认。不会自动重跑，也不会启用不确定的安装版本。</p> : null}
        {job.native && job.status === "unknown" ? <button type="button" className="btn btn-sm self-start" disabled={inspecting} onClick={() => void inspect()}>{inspecting ? <Spinner size={13}/> : <Search size={13}/>}核实本机结果</button> : null}
        {inspectionError ? <Notice tone="red">{inspectionError}</Notice> : null}
        {installationActive(job) || job.logCursor > 0 ? <InstallationLogs api={props.api} job={job}/> : null}
        {installationActive(job) ? <button type="button" className="btn btn-sm self-start" disabled={job.cancelRequested || props.cancelling.includes(job.id)} onClick={() => props.onCancelJob(job)}><Square size={12}/>取消安装任务</button> : null}
      </DetailSection> : null}
      {harness.management.native ? <DetailSection title="本机安装"><p className="m-0 text-[13px]">{channelLabel(harness.management.native.channel)}</p><code className="block rounded-md bg-subtle px-2.5 py-1.5 text-[12px] break-all">{harness.management.native.location}</code>{harness.management.native.reason ? <p className="m-0 text-[12.5px] text-amber">{harness.management.native.reason}</p> : null}</DetailSection> : null}
      <DetailSection title="安装来源"><dl className={cn("m-0", fact)}><dt className="text-fg-3">来源</dt><dd className="m-0">{recipe?.sourceLabel ?? "暂无受支持的安装方式"}</dd>{recipe?.packageName ? <><dt className="text-fg-3">包名</dt><dd className="m-0"><code className="text-[12px]">{recipe.packageName}</code></dd></> : null}
        <dt className="text-fg-3">状态</dt><dd className="m-0">{harness.management.updateStatus === "current" ? "当前渠道无需升级" : harness.management.updateStatus === "available" ? "有新版本" : harness.management.updateStatus === "failed" ? "版本检查失败" : harness.management.updateStatus === "checking" ? "正在检查" : "未确认更新状态"}</dd></dl>
        {recipe?.reason ? <p className="m-0 text-[12.5px] text-fg-2">{recipe.reason}</p> : !recipe ? <p className="m-0 text-[12.5px] text-fg-2">这个目录项尚无当前环境可用的受管安装配方。</p> : null}{harness.management.error ? <Notice tone="red">{harness.management.error.message}</Notice> : null}</DetailSection>
      <DetailSection title="控制入口">{harness.controls.map(control => <div key={control.id} className="flex flex-col gap-1 rounded-lg border border-line px-3 py-2.5">
        <div className="flex items-center gap-2"><Terminal size={14} className="text-fg-3"/><strong className="text-[13px] font-medium">{protocolLabel(control.protocol)}</strong><Badge tone={control.available ? "green" : "neutral"} dot>{control.available ? "已解析" : "待准备"}</Badge></div>
        <code className="text-[12px] text-fg-3">{control.id}</code>{control.entry ? <p className="m-0 text-[12px] text-fg-2">入口来源：{ENTRY_SOURCES[control.entry.source]}{control.entry.source === "custom-entry" ? "（路径以服务启动时的发现清单为准）" : ""}</p> : null}{control.reason ? <p className="m-0 text-[12px] text-amber">{control.reason}</p> : null}</div>)}</DetailSection>
      {missing(harness) && harness.install ? <DetailSection title="官方安装方式"><p className="m-0 text-[12.5px] text-fg-2">{officialInstallable(harness)
        ? `HarnessHub 可以按官网方式代为安装：点“安装”后先显示会运行什么、写到哪里，确认后才运行。`
        : harness.install.method === "terminal" ? `按 ${harness.name} 官方说明在终端安装，完成后重新检测即可使用。HarnessHub 不代为运行这条命令。` : `按 ${harness.name} 官方说明安装，完成后重新检测即可使用。`}命令于 {harness.install.checkedAt} 对照官方说明核对。</p><code className="block rounded-md bg-subtle px-2.5 py-2 text-[12px] break-all">{harness.install.command}</code><a className="text-[12.5px]" href={harness.install.docs} target="_blank" rel="noreferrer">查看官方说明</a></DetailSection> : null}
      {harness.installations.some(item => item.role === "product") ? <DetailSection title="能力"><p className="m-0 text-[12.5px] text-fg-2">{harness.name} 读取的技能、MCP、指令、子 Agent、命令、Hooks 和插件，以及各自是否生效。</p>
        <button type="button" className="btn btn-sm self-start" onClick={() => props.onCapabilities(harness.id)}>查看 {harness.name} 的能力</button></DetailSection> : null}
      <DetailSection title="模型与登录"><p className="m-0 text-[12.5px] text-fg-2">沿用 Harness 本机已有配置。统一 Provider 管理将在后续接入。</p></DetailSection>
    </div>
    <footer className="flex flex-wrap items-center gap-2 border-t border-line px-5 py-3">
      {available ? <button type="button" className="btn" onClick={() => { props.onClose(); props.onChoose(harness); }}>开始对话<ArrowRight size={14}/></button> : null}
      <span className="flex-1"/>
      {unconfirmed ? <button type="button" className="btn btn-primary" disabled={props.submitting.includes(harness.id)} onClick={() => props.onConfirm(harness.id)}>确认上次请求</button>
        : officialInstallable(harness) ? <button type="button" className="btn btn-primary" disabled={busy} onClick={() => props.onInstallRequest(harness)}>{busy ? <Spinner size={13} className="text-app"/> : <Download size={14}/>}{busy ? "任务运行中" : "按官网方式安装"}</button>
        : canManage(harness) ? <button type="button" className="btn btn-primary" disabled={busy || harness.management.source === "managed" && harness.management.updateStatus === "current"} onClick={() => props.onRequest(harness)}>
          {busy ? <Spinner size={13} className="text-app"/> : missing(harness) ? <Download size={14}/> : <ArrowUpRight size={14}/>} {busy ? props.submitting.includes(harness.id) ? "提交中" : "任务运行中" : actionFor(harness) === "install" ? harness.installed ? "安装本机适配器" : "安装 Harness" : harness.management.source === "managed" && harness.management.updateStatus === "current" ? "已是最新" : "升级 Harness"}</button> : null}
      <Tip label="检查更新"><button type="button" className="icon-btn" aria-label={`检查 ${harness.name} 更新`} disabled={props.checking} onClick={() => props.onCheckUpdates([harness.id])}><RefreshCw size={16}/></button></Tip>
    </footer>
  </>;
}
function InstallationLogs({ api, job }: { api: GatewayApi; job: InstallationJobView }) {
  const [logs, setLogs] = useState<readonly InstallationLog[]>([]), [fault, setFault] = useState<string | null>(null), [open, setOpen] = useState(false);
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
  return <div className="installation-logs">
    <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)} className="flex items-center gap-1.5 rounded-md border-none bg-transparent px-1 py-1 text-[12.5px] font-medium text-fg-2 hover:bg-hover"><ChevronRight size={12} className={cn("transition-transform duration-150", open && "rotate-90")}/><Package size={13}/>安装日志<span className="text-fg-3">{logs.length}</span></button>
    {open ? <div className="enter mt-1.5 flex flex-col gap-1.5">{fault ? <Notice tone="amber">{fault}</Notice> : null}
      <div className="log-output max-h-64 overflow-auto rounded-lg bg-subtle p-2.5" role="log" aria-label="安装日志" aria-live="off">{logs.length ? logs.map(line => <div key={line.seq} className={cn("flex gap-2.5 font-mono text-[11.5px] leading-[1.6]", line.stream === "stderr" && "text-amber")}><span className="flex-none text-fg-3">{new Date(line.time).toLocaleTimeString("zh-CN", { hour12: false })}</span><code className="break-all whitespace-pre-wrap">{line.text}</code></div>) : <p className="m-0 text-[12px] text-fg-3">暂无日志输出</p>}</div></div> : null}
  </div>;
}
