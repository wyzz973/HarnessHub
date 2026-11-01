import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { ArrowLeft, ArrowRight, Check, ChevronRight, CircleAlert, CircleArrowUp, CircleCheck, CircleDashed, Clock3, Copy, Info, Menu as MenuIcon, Package, PanelLeft, RefreshCw, ScanSearch, Search, Square, Terminal, X } from "lucide-react";
import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { MouseEvent, ReactNode } from "react";
import type { HarnessEntrySource, HarnessReadinessView, HarnessView, InstallationView, NativeResumeView, SessionSummary } from "../../../src/contracts/web.js";
import type { InstallationJobView, InstallationLog } from "../../../src/contracts/management.js";
import { errorMessage, failureMessage, GatewayApi, protocolLabel } from "../api.js";
import { cn } from "../lib/cn.js";
import { ago } from "../lib/format.js";
import { useMedia } from "../lib/prefs.js";
import { Collapsible, DrawnCheck, SwapText } from "../ui/motion.js";
import { Dialog } from "../ui/overlay.js";
import { Badge, Notice, Spinner, StatusPill, Tip } from "../ui/primitives.js";
import { BrandIcon } from "./BrandIcon.js";
import { readinessStatus } from "./Composer.js";
import { UpgradeDialog, type UpgradeConsent } from "./UpgradeDialog.js";
import { UninstallDialog, type UninstallConsent } from "./UninstallDialog.js";
import { InstallDialog } from "./InstallDialog.js";
import { InstallationUpgradeDialog, upgradeLabel } from "./InstallationUpgradeDialog.js";

export interface UnconfirmedInstallation { harnessId: string; action: "install" | "upgrade" | "uninstall"; message: string }
function verbOf(job: Pick<InstallationJobView, "action">): string { return job.action === "upgrade" ? "升级" : job.action === "uninstall" ? "卸载" : "安装"; }
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
      // A sequenced upgrade (ADR-052) that stopped at a hop's Doctor installed that hop's release without migrating for it.
      if (job.error?.code === "DOCTOR_FAILED" && job.native?.actualVersion) return "已安装，Doctor 未通过";
      if (job.native?.actualVersion) return "已" + verb + (job.error?.code === "SERVICE_NOT_READY" ? "，服务未就绪" : "，服务未恢复");
      return verb + "失败";
  }
}
/** Whether a finished task changed nothing: a native one stopped before its channel ran. */
function unchanged(job: InstallationJobView): boolean { return job.status !== "completed" && !installationActive(job) && job.native !== undefined && !job.native.dispatched; }
/** Whether a task that did not finish cleanly left its new version installed, so what remains is for the user to handle. */
function installedAnyway(job: InstallationJobView): boolean { return job.status === "failed" && job.action !== "uninstall" && Boolean(job.native?.actualVersion); }
/**
 * A task's color, the same in the task list, the details and the Agent's card: blue while it runs, amber when it waits for
 * the user (a result to verify, nothing changed, a new version that is not fully up), red only when it failed (ADR-054 §1).
 */
function jobTone(job: InstallationJobView): Tone {
  if (installationActive(job)) return "accent";
  if (job.status === "unknown" || unchanged(job) || installedAnyway(job)) return "amber";
  return job.status === "failed" ? "red" : "neutral";
}
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
  // A sequenced upgrade's Doctor migrates the product's configuration (ADR-052): said instead of "原配置保留", which is then not the whole truth.
  const migrated = native?.configurationMigrated?.length ? "，" + native.configurationMigrated.join("、") + " 由 Doctor 迁移。" : null;
  if (job.status === "completed") {
    const restarted = native?.services?.filter(service => service.outcome === "restarted").map(service => service.label) ?? [];
    return (job.resolvedVersion ? "已" + verb + "到 " + job.resolvedVersion : verb + "完成") + (restarted.length ? "，已重启 " + restarted.join("、") : "") + (native ? migrated ?? "，原配置保留。" : "，入口验证已完成。");
  }
  if (unchanged(job)) return name + " 没有任何改动，仍是 " + (native?.beforeVersion ?? "原版本") + "。" + (native?.closedConversations ? "升级前关闭了 " + native.closedConversations + " 个对话保留的进程，它们下次发消息时会重新连接。" : "");
  if (job.status === "failed" && native?.actualVersion) return "新版本 " + native.actualVersion + " 已安装" + (native.hops?.some(hop => hop.doctor === "failed") ? "，它的 Doctor 没有通过，Gateway 没有启动。" : migrated ?? "，原配置保留。");
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
  /** Opens the settings, where the frozen Harnesses can be shown and discovery directories added. */
  onSettings: () => void;
  installationPolicy: "official" | "any"; jobs: readonly InstallationJobView[]; scanning: boolean; checking: boolean;
  submitting: readonly string[]; cancelling: readonly string[]; error: string | null; connectionError: string | null; unconfirmed: readonly UnconfirmedInstallation[];
  /**
   * What the latest catalog reads showed of each Harness entry (the Gateway state's `readiness`): whether it asked to be
   * signed in or its read failed. Without it the page says only what the scan found.
   */
  readiness?: readonly HarnessReadinessView[] | undefined;
  /**
   * The conversations of the Gateway state: the details offer to continue an Agent's latest one in its own program, as
   * that conversation's details do (ADR-039). Without them the details leave this out.
   */
  sessions?: readonly SessionSummary[] | undefined;
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
  sidebarHidden: boolean; onExpandSidebar: () => void;
  /** The way back to the conversation, in the page's quiet top bar. */
  onChat: () => void;
}
function missing(harness: HarnessView): boolean { return harness.management.source === "missing" || !harness.controls.some(control => control.available); }
function available(harness: HarnessView): boolean { return harness.controls.some(control => control.available); }
/** Whether the product is on this Mac: found by the scan, or installed by HarnessHub; such a Harness gets a card. */
function onMachine(harness: HarnessView): boolean { return harness.installed || harness.management.source === "managed" || harness.installations.some(item => item.role === "product"); }
const ENTRY_SOURCES: Readonly<Record<HarnessEntrySource, string>> = { path: "PATH", "standard-directory": "标准安装目录", "custom-entry": "自定义入口（发现清单）", "package-root": "包目录", managed: "HarnessHub 管理" };
function customEntry(harness: HarnessView): boolean {
  // An explicit custom entry is the user's own registration, not an installation found where comparable products look.
  const entry = harness.controls.find(control => control.id === harness.defaultControlId)?.entry ?? harness.controls.find(control => control.available)?.entry;
  return harness.management.source !== "managed" && entry?.source === "custom-entry";
}
function sourceLabel(harness: HarnessView): string {
  if (customEntry(harness)) return ENTRY_SOURCES["custom-entry"];
  return harness.management.source === "managed" ? "HarnessHub 管理" : harness.management.source === "system" ? "系统安装" : "尚未安装";
}
/** The installation HarnessHub runs for a role: the one in use, else the first one found. */
function installationOf(harness: HarnessView, role: InstallationView["role"]): InstallationView | null {
  const found = harness.installations.filter(item => item.role === role);
  return found.find(item => item.active) ?? found[0] ?? null;
}
/** The product's own version; an adapter entry in front of it keeps its own version, shown apart. */
function versionOf(harness: HarnessView): string | null { return harness.management.programVersion ?? harness.management.installedVersion ?? installationOf(harness, "product")?.version ?? null; }
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
  return latest.version === item.version ? " · 已是最新" + records : " · 可升级到 " + latest.version + records;
}
function channelLabel(channel: string): string { return ({ script: "官方安装脚本", npm: "npm 全局安装", "brew-formula": "Homebrew", "brew-cask": "Homebrew", uv: "uv 工具", archive: "本机程序目录", "native-cli": "程序官方更新器" } as Record<string, string>)[channel] ?? "原安装渠道"; }
/** An installation's place in a few words for a card ("npm（nvm）"); the details show the Gateway's own words. */
function shortPlace(item: InstallationView): string {
  switch (item.channel) {
    case "npm": {
      const inner = /（(.+)）$/u.exec(item.label)?.[1] ?? "", manager = /^(nvm|fnm|Volta|mise|asdf)\b/u.exec(inner)?.[1] ?? (inner.startsWith("Homebrew") ? "Homebrew Node" : null);
      return manager ? "npm（" + manager + "）" : "npm";
    }
    case "brew-formula": return "Homebrew";
    case "brew-cask": return "Homebrew Cask";
    case "script": return "官方脚本";
    case "uv": return "uv";
    case "pnpm": return "pnpm";
    case "bun": return "bun";
    case null: return "开发入口";
  }
}
/** Where the product is, short for a card or in the Gateway's words for the details. */
function placeOf(harness: HarnessView, long: boolean): string {
  const product = installationOf(harness, "product");
  if (product) return long ? product.label : shortPlace(product);
  if (harness.management.source === "managed") return "HarnessHub 管理";
  if (customEntry(harness)) return long ? ENTRY_SOURCES["custom-entry"] : "自定义入口";
  if (harness.management.native) return channelLabel(harness.management.native.channel);
  return harness.installed ? "本机安装" : "未安装";
}
/** A control's reason in the user's words; the Gateway's own diagnostics stay in the technical details. */
function controlReason(reason: string | null): string {
  if (reason === null) return "缺少对话需要的接入口";
  if (/[\u4e00-\u9fff]/u.test(reason)) return reason.replace(/[。.]$/u, "");
  const absent = /^Missing: (.+)$/u.exec(reason)?.[1];
  if (absent) return "缺少它需要的程序 " + absent;
  return reason === "Control Driver is not implemented" ? "HarnessHub 还不支持它的接入方式" : "缺少对话需要的接入口";
}
/** The entry readiness is read for: the default one, else the first resolved one. */
function readinessOf(harness: HarnessView, readiness: readonly HarnessReadinessView[] | undefined): HarnessReadinessView | undefined {
  const control = harness.controls.find(item => item.id === harness.defaultControlId && item.available)?.id ?? harness.controls.find(item => item.available)?.id;
  return control === undefined ? undefined : readiness?.find(item => item.harnessId === harness.id && item.controlId === control);
}
function activeJob(harness: HarnessView, jobs: readonly InstallationJobView[]): InstallationJobView | null {
  return jobs.find(job => job.id === harness.management.activeJobId && installationActive(job)) ?? jobs.find(job => job.harnessId === harness.id && installationActive(job)) ?? null;
}
/** A task's start in the user's terms: "今天 15:13", "昨天 09:02", "10月12日 13:12", or the date of an earlier year. */
function when(iso: string, now = new Date()): string {
  const at = new Date(iso); if (Number.isNaN(at.getTime())) return "";
  const time = String(at.getHours()).padStart(2, "0") + ":" + String(at.getMinutes()).padStart(2, "0");
  const day = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((day(now) - day(at)) / 86_400_000);
  if (days === 0) return "今天 " + time;
  if (days === 1) return "昨天 " + time;
  return at.getFullYear() === now.getFullYear() ? `${at.getMonth() + 1}月${at.getDate()}日 ${time}` : `${at.getFullYear()}年${at.getMonth() + 1}月${at.getDate()}日`;
}
function updateText(harness: HarnessView): string {
  const management = harness.management, current = versionOf(harness);
  switch (management.updateStatus) {
    case "available": return management.latestVersion ? "可以升级到 " + management.latestVersion : "有新版本";
    case "current": return current ? "已是最新 " + current : "已是最新";
    case "checking": return "正在检查更新…";
    case "failed": return "没有查到最新版本";
    case "unchecked": return "还没有检查更新";
    case "unsupported": return "这种安装方式不检查更新";
  }
}

type Tone = "accent" | "amber" | "red" | "neutral";
/**
 * One Agent's state, said the same way on its card, its pill and its details (Interaction board): what is happening
 * first, then why. Every clause comes from a fact the Gateway gave: a task, a request, the scan, a catalog read.
 */
interface AgentState {
  readonly kind: "busy" | "unconfirmed" | "attention" | "blocked" | "signin" | "readfail" | "update" | "ready" | "missing";
  readonly tone: Tone; readonly live: boolean; readonly pill: string; readonly title: string;
  /** The card's sentence: the result first, then why. */
  readonly summary: string;
  /** The details' sentence under the title, when the title already says the result; else the summary. */
  readonly detail?: string;
  /** The catalog read behind the state, as the picker words it ("3 分钟前读取过本机模型，已登录"). */
  readonly hint?: string | undefined;
  /** The task the state comes from; its section in the details then leaves out what the state already says. */
  readonly jobId?: string;
}
interface StateFacts { readonly jobs: readonly InstallationJobView[]; readonly unconfirmed: readonly UnconfirmedInstallation[]; readonly submitting: readonly string[]; readonly readiness: readonly HarnessReadinessView[] | undefined }
function agentState(harness: HarnessView, facts: StateFacts): AgentState {
  const name = harness.name, job = activeJob(harness, facts.jobs);
  if (job || facts.submitting.includes(harness.id)) {
    if (!job) return { kind: "busy", tone: "accent", live: true, pill: "提交中", title: "正在提交请求", summary: "请求已发出，等本机服务接收。" };
    const status = installationStatus(job);
    // The pill says where the task is; the sentence says its target and what it means meanwhile.
    const target = job.cancelRequested || !job.resolvedVersion ? "" : (job.action === "install" ? "安装 " : job.action === "upgrade" ? "升级到 " : "卸载 ") + job.resolvedVersion + "。";
    const why = job.cancelRequested ? "清理完成后结束。" : job.action === "install" ? "任务在本机服务里运行，离开这个页面也不受影响。" : `完成前不会用 ${name} 开始新的任务。`;
    return { kind: "busy", tone: "accent", live: true, pill: status, title: status, summary: target + why };
  }
  const intent = facts.unconfirmed.find(item => item.harnessId === harness.id);
  if (intent) {
    const verb = intent.action === "upgrade" ? "升级" : intent.action === "uninstall" ? "卸载" : "安装";
    return { kind: "unconfirmed", tone: "amber", live: false, pill: "请求待确认", title: verb + "请求尚未确认", summary: intent.message + " 确认时会沿用原请求，不新建重复任务。" };
  }
  if (!onMachine(harness)) return { kind: "missing", tone: "neutral", live: false, pill: "未安装", title: "还没有安装", summary: "" };
  // The latest task, when it left something for the user: a result to verify, or a new version that is not fully up.
  const latest = facts.jobs.find(item => item.harnessId === harness.id);
  if (latest?.status === "unknown") return { kind: "attention", tone: "amber", live: false, pill: "结果待核实", title: "上次" + verbOf(latest) + "的结果待核实", summary: jobSummary(latest, name), jobId: latest.id };
  if (latest && installedAnyway(latest)) {
    // In the Agent's own words when the Gateway kept them (Interaction board: failures say what the program said).
    const status = installationStatus(latest), cause = jobError(latest) ?? jobSummary(latest, name);
    return { kind: "attention", tone: "amber", live: false, pill: "需要处理", title: "需要处理", summary: "上次" + verbOf(latest) + "：" + status + "。" + cause, detail: cause, jobId: latest.id };
  }
  if (!available(harness)) {
    const reason = controlReason(harness.controls.find(control => !control.available)?.reason ?? null);
    return { kind: "blocked", tone: "amber", live: false, pill: "需要处理", title: "还不能对话", summary: `已找到 ${name}，但还不能对话：${reason}。`, detail: reason + "。" };
  }
  const seen = readinessOf(harness, facts.readiness), read = seen ? readinessStatus(harness, seen) : undefined;
  if (seen?.state === "signed_out" && read) return { kind: "signin", tone: "amber", live: false, pill: read.label, title: read.label, summary: `需要先在 ${name} 里登录或完成设置，才能用它对话。`, hint: read.title };
  if (seen?.state === "failed" && read) {
    const failure = failureMessage({ code: seen.failureCode ?? "", message: "原因未知，在对话里重新读取模型列表可以重试。" });
    return { kind: "readfail", tone: "red", live: false, pill: read.label, title: "读取模型列表失败", summary: "上次读取它的模型列表失败：" + failure, detail: failure, hint: read.title };
  }
  const signedIn = seen?.state === "ready" && seen.signedIn === true, known = readyFacts(harness), hint = read?.title;
  // The card's sentence is about the Agent itself, as on the board; a newer version is said by the pill and the upgrade button.
  const usable = (signedIn ? "已登录，可以对话。" : "可以对话。") + known;
  if (harness.management.updateStatus === "available") {
    const latestVersion = harness.management.latestVersion, current = versionOf(harness);
    return { kind: "update", tone: "accent", live: false, pill: "有更新", title: latestVersion ? "有新版本 " + latestVersion : "有新版本", summary: usable,
      detail: (current ? "当前 " + current + "。" : "") + "升级沿用它原来的安装方式，在下面的“维护”里进行。" + (signedIn ? "已登录。" : ""), ...(hint ? { hint } : {}) };
  }
  return { kind: "ready", tone: "accent", live: false, pill: "就绪", title: "可以对话", summary: usable, detail: (signedIn ? "已登录。" : "") + known, ...(hint ? { hint } : {}) };
}
/** What else is known of a ready Agent: frozen, the adapter in front of it, or who installed it. */
function readyFacts(harness: HarnessView): string {
  const adapter = installationOf(harness, "adapter"), adapterAt = adapter?.version ?? adapterVersion(harness);
  return (adapter ? "通过接入口 " + adapter.command + (adapterAt ? " " + adapterAt : "") + " 连接。" : harness.management.source === "managed" ? "由 HarnessHub 安装和维护。" : "模型和登录沿用它自己的配置。")
    + (harness.tier === "frozen" ? "已冻结：保留现有接入，不再新增能力。" : "");
}
/** How a missing product can be installed, for its row in "还可以安装" and its details. */
interface InstallWay {
  /** HarnessHub runs it: "official" after its confirmation (ADR-044), "managed" through the managed recipe or the native channel. */
  readonly runs: "official" | "managed" | null;
  /** The channel in a word or two ("npm", "官方脚本", "终端"). */
  readonly channel: string;
  readonly description: string;
}
function installWay(harness: HarnessView): InstallWay | null {
  const install = harness.install, recipe = harness.management.recipe, native = harness.management.native;
  const runs = officialInstallable(harness) ? "official" as const : canManage(harness) && actionFor(harness) === "install" ? "managed" as const : null;
  if (install === null && runs === null) return null;
  const channel = runs === "official" ? install?.method === "script" ? "官方脚本" : "npm"
    : runs === "managed" ? native ? shortChannel(native.channel) : recipe?.kind === "python" ? "uv" : recipe?.kind === "binary" ? "发布包" : "npm"
    : install?.method === "terminal" ? "终端" : install?.method === "script" ? "官方脚本" : "npm";
  // The row says what would run: the official command, or the package HarnessHub installs; a note of the official page first.
  const description = harness.tier === "frozen" ? "已冻结：不再新增能力，保留现有接入"
    : install?.note ? install.note
    : runs === "managed" ? recipeText(recipe)
    : install ? "官网命令 " + install.command : recipeText(recipe);
  return { runs, channel, description };
}
function recipeText(recipe: HarnessView["management"]["recipe"]): string {
  if (recipe?.kind === "binary") return "ACP 目录里审核过的发布包";
  return recipe?.packageName ? (recipe.kind === "python" ? "Python 包 " : "npm 包 ") + recipe.packageName : "由 HarnessHub 按目录里的方式安装";
}
function shortChannel(channel: string): string { return ({ npm: "npm", "brew-formula": "Homebrew", "brew-cask": "Homebrew Cask", script: "官方脚本", uv: "uv", archive: "发布包", "native-cli": "官方更新器" } as Record<string, string>)[channel] ?? "原渠道"; }
const TIERS: Readonly<Record<HarnessView["tier"], number>> = { focus: 0, catalog: 1, frozen: 2 };
const byTierAndName = (a: HarnessView, b: HarnessView) => TIERS[a.tier] - TIERS[b.tier] || a.name.localeCompare(b.name, "zh-CN");
/** Rows of "还可以安装" shown before "全部"; the Agents HarnessHub carries in full come first. */
const CATALOG_ROWS = 6;
/** The page width from which the details sit beside the cards; the sheet is 360 px (Agent board), the body's margin the same. */
const BESIDE_FROM = 900;

/**
 * The Agent page (ADR-054 §5): one card for each Agent on this Mac with its version and channel, its state, one sentence
 * of facts and its actions; details in a drawer, which sits beside the cards when the page is wide enough (900 px) and
 * opens over the page otherwise; and below, what can still be installed the official way. Maintenance runs through each
 * product's own channel after a confirmation (ADR-043, ADR-044); nothing here estimates a fact.
 */
export function HarnessesPage(props: HarnessProps) {
  const { harnesses, jobs } = props;
  const narrow = useMedia("(max-width: 759px)");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showTasks, setShowTasks] = useState(false);
  const [allCatalog, setAllCatalog] = useState(false);
  // The top bar draws its hairline only once the page has scrolled under it.
  const [scrolled, setScrolled] = useState(false);
  const [confirming, setConfirming] = useState<{ readonly harness: HarnessView; readonly fromDetail: boolean } | null>(null);
  // Uninstalling also shows what it removes, stops and keeps first, in a confirmation like an upgrade's.
  const [removing, setRemoving] = useState<{ readonly harness: HarnessView; readonly installation: InstallationView } | null>(null);
  // An official install shows what it runs and changes first, in a confirmation like the others.
  const [installing, setInstalling] = useState<{ readonly harness: HarnessView; readonly fromDetail: boolean } | null>(null);
  // Upgrading one installation shows what it runs and changes first, in a confirmation like the others.
  const [upgrading, setUpgrading] = useState<{ readonly harness: HarnessView; readonly installation: InstallationView; readonly fromDetail: boolean } | null>(null);
  // The details sit beside the cards when the page has room for both (Agent board): the cards make way for the sheet and
  // stay usable, so another card opens in its place. On a narrower page the details open over it as a drawer.
  const frame = useRef<HTMLElement>(null);
  const [frameWidth, setFrameWidth] = useState(0);
  useLayoutEffect(() => {
    const node = frame.current; if (!node) return;
    const measure = () => setFrameWidth(node.clientWidth);
    measure(); const observer = new ResizeObserver(measure); observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const beside = frameWidth >= BESIDE_FROM;
  // Beside the cards, a confirmation opens over the details and they stay; over the page, it takes their place until it closes.
  const makeWay = () => { if (!beside) setSelectedId(null); };
  const installOfficial = (harness: HarnessView, fromDetail = false) => { makeWay(); setInstalling({ harness, fromDetail }); };
  // The drawer keeps showing the Agent it was opened for while it slides away, instead of emptying first.
  const [shownId, setShownId] = useState<string | null>(null);
  if (selectedId !== null && selectedId !== shownId) setShownId(selectedId);
  const selected = harnesses.find(harness => harness.id === selectedId) ?? null, drawn = harnesses.find(harness => harness.id === (selectedId ?? shownId)) ?? null;
  // The cards make room for the sheet as it opens and take the width back once it has gone (after its exit transition).
  const [room, setRoom] = useState(false);
  if (beside && selected !== null && !room) setRoom(true);
  else if (!beside && room) setRoom(false);
  // Upgrading an installed program first shows what it touches and asks for consent (ADR-043); installing does not. The
  // details come back with the task once it is sent.
  const request = (harness: HarnessView, fromDetail = false) => {
    const action = actionFor(harness);
    if (action === "upgrade" && harness.management.native) { makeWay(); setConfirming({ harness, fromDetail }); return; }
    setSelectedId(harness.id); props.onInstall(harness, action);
  };
  const upgradeInstallation = (harness: HarnessView, installation: InstallationView, fromDetail = false) => {
    if (installation.upgrade === "maintenance") { request(harness, fromDetail); return; }
    makeWay(); setUpgrading({ harness, installation, fromDetail });
  };
  const closeConfirmation = () => { const from = confirming?.fromDetail ? confirming.harness.id : null; setConfirming(null); if (from) setSelectedId(from); };
  const facts: StateFacts = { jobs, unconfirmed: props.unconfirmed, submitting: props.submitting, readiness: props.readiness };
  const active = jobs.filter(installationActive);
  // The page leaves out the hidden Harnesses; details, tasks and names still find every one.
  const listed = harnesses.filter(harness => !props.hidden.has(harness.id)), hiddenCount = harnesses.length - listed.length;
  const mine = listed.filter(onMachine).sort(byTierAndName);
  const catalog = listed.flatMap(harness => { if (onMachine(harness)) return []; const way = installWay(harness); return way ? [{ harness, way }] : []; })
    .sort((a, b) => byTierAndName(a.harness, b.harness));
  /**
   * The card's own action: install its missing adapter, or upgrade it when the Gateway reports a newer version (Agent
   * board). A product whose own updater picks the version has no known newer one; its update stays in the details.
   */
  const cardAction = (harness: HarnessView, state: AgentState): { readonly label: string; readonly run: () => void } | null => {
    if (state.kind === "busy" || state.kind === "unconfirmed") return null;
    if (!available(harness) && canManage(harness) && actionFor(harness) === "install") return { label: "安装接入口", run: () => request(harness) };
    if (harness.management.updateStatus === "available") {
      const latest = harness.management.latestVersion;
      if (canManage(harness) && actionFor(harness) === "upgrade") return { label: latest ? "升级到 " + latest : "升级", run: () => request(harness) };
      const product = installationOf(harness, "product");
      if (product?.upgrade) return { label: upgradeLabel(product), run: () => upgradeInstallation(harness, product) };
    }
    return null;
  };
  const shownRow = (item: { readonly harness: HarnessView; readonly way: InstallWay }, index: number) => {
    const harness = item.harness, job = activeJob(harness, jobs), busy = job !== null || props.submitting.includes(harness.id);
    // A last install that failed is said on the row until another task replaces it; the details have the rest.
    const latest = jobs.find(entry => entry.harnessId === harness.id), failure = latest?.status === "failed" && latest.action === "install" ? jobError(latest) ?? installationStatus(latest) : null;
    return <CatalogRow key={harness.id} harness={harness} way={item.way} first={index === 0} busy={busy} status={job ? installationStatus(job) : busy ? "提交中" : null} failure={failure}
      onOpen={() => setSelectedId(harness.id)} onInstall={() => item.way.runs === "official" ? installOfficial(harness) : request(harness)}/>;
  };
  // An error is said once: in the details while they sit beside the cards (where the action was taken), else on the page.
  const pageError = beside && selected !== null ? null : props.error;
  const detailTitle = drawn ? `${drawn.name} 详情` : "Agent 详情";
  const details = drawn ? <AgentDetail {...props} key={drawn.id} harness={drawn} state={agentState(drawn, facts)} onClose={() => setSelectedId(null)} onRequest={harness => request(harness, true)} onInstallRequest={harness => installOfficial(harness, true)}
    onUninstallRequest={(harness, installation) => { makeWay(); setRemoving({ harness, installation }); }}
    onUpgradeRequest={(harness, installation) => upgradeInstallation(harness, installation, true)}/> : null;
  // The frame of the pages beside the conversation (Agent board): a quiet bar with the navigation and the way back, then
  // one scrolling body whose head is the title, what the page is, and its actions on the description's last line.
  return <section ref={frame} className="management-page flex h-full min-h-0 min-w-0 flex-1 flex-col bg-app" aria-labelledby="harnesses-title">
    <div className={cn("flex h-[52px] flex-none items-center gap-1 border-b-[0.5px] px-3 transition-[border-color] duration-120", scrolled ? "border-line" : "border-transparent")}>
      {narrow ? <button type="button" className="icon-btn navigation-toggle" onClick={props.onMenu} aria-label="打开导航"><MenuIcon size={18}/></button>
        : props.sidebarHidden ? <Tip label="展开侧栏"><button type="button" className="icon-btn" aria-label="展开侧栏" onClick={props.onExpandSidebar}><PanelLeft size={16}/></button></Tip> : null}
      <Tip label="返回对话"><button type="button" className="icon-btn" aria-label="返回对话" onClick={props.onChat}><ArrowLeft size={16}/></button></Tip>
    </div>
    {/* While the details sit beside the cards, the body (and its scrollbar) ends where the sheet begins. */}
    <div className={cn("harness-management-body scroll-area min-h-0 flex-1", room && "mr-[360px]")} onScroll={event => setScrolled(event.currentTarget.scrollTop > 0)}>
      <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-7 px-4 pt-1 pb-16 sm:px-10">
        <div className="flex flex-col">
          <header className="flex flex-wrap items-end gap-x-4 gap-y-3">
            <div className="flex min-w-[min(240px,100%)] flex-1 flex-col gap-1.5">
              <h1 id="harnesses-title" className="m-0 text-title break-words">Agent</h1>
              <p className="m-0 max-w-[720px] text-ui leading-[22px] text-fg-2">{mine.length ? `这台 Mac 上的 ${mine.length} 个 Agent。用它们原来的安装和登录；升级、卸载都按官网的方式来。`
                : "这台 Mac 上还没有找到 Agent。装好以后，HarnessHub 用它们原来的安装和登录；安装、升级、卸载都按官网的方式来。"}</p>
            </div>
            <div className="flex max-w-full flex-none flex-wrap items-center gap-2">
              {jobs.length ? <button type="button" className={cn("btn btn-ghost", active.length > 0 && "text-accent-text")} onClick={() => setShowTasks(value => !value)} aria-expanded={showTasks} aria-controls="installation-tasks">
                {active.length ? <Spinner size={14} tone="run" label=""/> : <Clock3 size={15}/>}安装任务<span className={active.length ? "" : "text-fg-3"}>{active.length || jobs.length}</span></button> : null}
              <Tip label="重新检测本机的 Agent"><button type="button" className="icon-btn" aria-label="重新检测" onClick={props.onRescan} disabled={props.scanning}>{props.scanning ? <Spinner size={15} label=""/> : <ScanSearch size={16}/>}</button></Tip>
              <button type="button" className="btn" onClick={() => props.onCheckUpdates()} disabled={props.checking}>{props.checking ? <Spinner size={14} label=""/> : <RefreshCw size={15} className="text-fg-2"/>}{props.checking ? "正在检查更新" : "检查更新"}</button>
            </div>
          </header>
          {props.installationPolicy === "any" || pageError || props.connectionError || props.unconfirmed.length ? <div className="mt-5 flex flex-col gap-2">
            {/* Amber is kept for what waits for the user (ADR-054 §1): the Gateway's mode and a lost connection are said plainly. */}
            {props.installationPolicy === "any" ? <Notice className="development-entries">开发模式：接受非官网安装。服务以 --allow-unofficial 启动，列表里的开发入口不是正式安装。</Notice> : null}
            {pageError ? <Notice tone="red" onDismiss={props.onDismissError}>{pageError}</Notice> : null}
            {props.connectionError ? <Notice className="connection-notice">{props.connectionError} · 安装状态暂时显示最后一次观察，正在重新连接，不会重跑任务。</Notice> : null}
            {props.unconfirmed.map(intent => <Notice key={intent.harnessId} tone="amber" title={`${harnesses.find(h => h.id === intent.harnessId)?.name ?? intent.harnessId} 的请求尚未确认`}
              action={<button type="button" className="btn btn-sm" onClick={() => props.onConfirm(intent.harnessId)} disabled={props.submitting.includes(intent.harnessId)}>确认上次请求</button>}>{intent.message}</Notice>)}
          </div> : null}
          {jobs.length ? <Collapsible open={showTasks} id="installation-tasks">
            <section aria-label="安装任务" className="card mt-5 p-1.5">
              <p className="m-0 px-2.5 pt-1.5 pb-1 text-caption text-fg-3">任务在本机服务里独立运行，关闭详情后仍可在这里查看。</p>
              <ul className="m-0 flex list-none flex-col p-0">{jobs.map(job => <li key={job.id}>
                <button type="button" onClick={() => setSelectedId(job.harnessId)} className="row flex w-full items-center gap-2.5 border-none bg-transparent px-2.5 py-2 text-left">
                  <BrandIcon brand={job.harnessId} name={harnesses.find(h => h.id === job.harnessId)?.name ?? job.harnessId} size={24}/>
                  <span className="min-w-0 flex-1"><span className="trunc block text-ui-sm font-medium">{harnesses.find(h => h.id === job.harnessId)?.name ?? job.harnessId}</span><span className="block text-caption text-fg-3">{verbOf(job)} · {job.resolvedVersion ?? "版本待解析"} · {when(job.createdAt)}</span></span>
                  <StatusPill tone={jobTone(job)} live={installationActive(job)}>{installationStatus(job)}</StatusPill>
                  <ChevronRight size={15} className="text-fg-3"/></button></li>)}</ul>
            </section>
          </Collapsible> : null}
        </div>
        {mine.length ? <section aria-labelledby="agents-mine-title">
          <h2 id="agents-mine-title" className="sr-only">这台 Mac 上的 Agent</h2>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(300px,100%),1fr))] gap-3.5">
            {mine.map(harness => { const state = agentState(harness, facts); return <AgentCard key={harness.id} harness={harness} state={state} action={cardAction(harness, state)} selected={selectedId === harness.id} onOpen={() => setSelectedId(harness.id)}/>; })}
          </div>
        </section> : null}
        {catalog.length ? <section aria-labelledby="agents-catalog-title" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            <h2 id="agents-catalog-title" className="m-0 text-panel">还可以安装</h2>
            <span className="text-ui-sm text-fg-3">{catalog.length} 个，按官网的方式安装</span>
            <span className="flex-1"/>
            {catalog.length > CATALOG_ROWS ? <button type="button" className="link-btn text-ui-sm" aria-expanded={allCatalog} aria-controls="agents-catalog-more" aria-label={allCatalog ? "收起" : `显示全部 ${catalog.length} 个`} onClick={() => setAllCatalog(value => !value)}>{allCatalog ? "收起" : "全部"}</button> : null}
          </div>
          <div className="card overflow-hidden">
            {catalog.slice(0, CATALOG_ROWS).map(shownRow)}
            {catalog.length > CATALOG_ROWS ? <Collapsible open={allCatalog} id="agents-catalog-more">{catalog.slice(CATALOG_ROWS).map((item, index) => shownRow(item, index + CATALOG_ROWS))}</Collapsible> : null}
          </div>
        </section> : null}
        <div className="-mt-2 flex flex-col gap-1.5 text-ui-sm text-fg-3">
          {hiddenCount > 0 ? <p className="hidden-frozen m-0">已隐藏 {hiddenCount} 个冻结的 Harness，<button type="button" className="link-btn" onClick={props.onSettings}>可在设置里显示</button></p> : null}
          <p className="m-0">没找到装在别处的 Agent？在<button type="button" className="link-btn" onClick={props.onSettings}>设置</button>的“发现”里添加它所在的目录，再重新检测。</p>
        </div>
      </div>
    </div>
    {beside
      // Beside the cards (Agent board): a sheet that leaves the page usable, without a scrim, under every floating layer;
      // it takes focus when it opens, closes with Escape or its button, and gives focus back to what opened it.
      ? <BaseDialog.Root open={selected !== null} modal={false} disablePointerDismissal onOpenChange={open => { if (!open) setSelectedId(null); }}
        onOpenChangeComplete={open => { if (!open) setRoom(false); }}>
        <BaseDialog.Portal>
          <BaseDialog.Popup className="drawer-pop z-40 w-[360px] hairline-l [box-shadow:none]">
            <BaseDialog.Title className="sr-only">{detailTitle}</BaseDialog.Title>{details}
          </BaseDialog.Popup>
        </BaseDialog.Portal>
      </BaseDialog.Root>
      : <Dialog open={selected !== null} onOpenChange={open => { if (!open) setSelectedId(null); }} title={detailTitle} kind="drawer">{details}</Dialog>}
    <UpgradeDialog api={props.api} harness={confirming?.harness ?? null} onClose={closeConfirmation} onConfirm={(harness, consent) => { setConfirming(null); setSelectedId(harness.id); props.onInstall(harness, "upgrade", consent); }}
      onOpenSession={id => { setConfirming(null); setSelectedId(null); props.onOpenSession(id); }}/>
    <InstallDialog api={props.api} harness={installing?.harness ?? null}
      onClose={() => { const from = installing?.fromDetail ? installing.harness.id : null; setInstalling(null); if (from) setSelectedId(from); }}
      onConfirm={(harness, fingerprint) => { setInstalling(null); setSelectedId(harness.id); props.onInstallOfficial(harness, fingerprint); }}/>
    <InstallationUpgradeDialog api={props.api} harness={upgrading?.harness ?? null} installation={upgrading?.installation ?? null}
      onClose={() => { const from = upgrading?.fromDetail ? upgrading.harness.id : null; setUpgrading(null); if (from) setSelectedId(from); }}
      onConfirm={(harness, installation, fingerprint) => { setUpgrading(null); setSelectedId(harness.id); props.onUpgradeInstallation(harness, installation, fingerprint); }}
      onOpenSession={id => { setUpgrading(null); setSelectedId(null); props.onOpenSession(id); }}/>
    <UninstallDialog api={props.api} harness={removing?.harness ?? null} installation={removing?.installation ?? null}
      onClose={() => { const from = removing?.harness.id ?? null; setRemoving(null); if (from) setSelectedId(from); }}
      onConfirm={(harness, installation, consent) => { setRemoving(null); setSelectedId(harness.id); props.onUninstall(harness, installation, consent); }}
      onOpenSession={id => { setRemoving(null); setSelectedId(null); props.onOpenSession(id); }}/>
  </section>;
}

/** The icon of a state, the same in the details' state box as in the task timeline. */
function StateIcon({ state, size = 16 }: { readonly state: AgentState; readonly size?: number }) {
  if (state.kind === "busy") return <Spinner size={size} tone="run" label=""/>;
  if (state.kind === "ready") return <CircleCheck size={size} aria-hidden="true"/>;
  if (state.kind === "update") return <CircleArrowUp size={size} aria-hidden="true"/>;
  if (state.kind === "missing") return <CircleDashed size={size} aria-hidden="true"/>;
  return <CircleAlert size={size} aria-hidden="true"/>;
}
const TONE_TEXT: Readonly<Record<Tone, string>> = { accent: "text-accent-text", amber: "text-amber", red: "text-red", neutral: "text-fg-2" };
const TONE_FILL: Readonly<Record<Tone, string>> = { accent: "bg-accent-soft", amber: "bg-amber-soft", red: "bg-red-soft", neutral: "bg-subtle" };

/**
 * One Agent on this Mac (Agent board): its mark, name, version · channel, state, one sentence of facts, and its actions.
 * The card opens the details; its buttons keep their own actions, and the keyboard reaches both through the buttons.
 */
function AgentCard({ harness, state, action, selected, onOpen }: {
  readonly harness: HarnessView; readonly state: AgentState; readonly action: { readonly label: string; readonly run: () => void } | null; readonly selected: boolean; readonly onOpen: () => void;
}) {
  const nameId = useId(), version = versionOf(harness), products = harness.installations.filter(item => item.role === "product").length;
  // A pointer anywhere on the card opens the details, except on its buttons or while text is being selected.
  const open = (event: MouseEvent<HTMLElement>) => { if ((event.target as Element).closest("button, a, input, select, textarea") || window.getSelection()?.toString()) return; onOpen(); };
  // When the details make the cards reflow beside them, the chosen card stays in view (at once, not scrolled smoothly).
  const self = useRef<HTMLElement>(null);
  useEffect(() => { if (selected) self.current?.scrollIntoView({ block: "nearest" }); }, [selected]);
  return <article ref={self} aria-labelledby={nameId} data-selected={selected ? "true" : "false"} className="agent-entry agent-card card card-interactive flex min-w-0 cursor-pointer flex-col gap-3 p-4 sm:p-[18px]" onClick={open}>
    <div className="flex items-start gap-2.5 sm:gap-3">
      <BrandIcon brand={harness.id} name={harness.name} size={44}/>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {/* The state sits beside the name only, so the version and channel below keep the card's whole width. */}
        <div className="flex min-w-0 items-center gap-1.5">
          <h3 id={nameId} className="trunc m-0 text-[15px] leading-[22px] font-semibold">{harness.name}</h3>
          {harness.tier === "frozen" ? <Badge tone="neutral" className="harness-frozen flex-none" title="冻结：保留适配与历史对话，不再打磨">冻结</Badge> : null}
          <StatusPill tone={state.tone} live={state.live} className="-my-px ml-auto flex-none" {...(state.hint ? { title: state.hint } : {})}><SwapText text={state.pill}/></StatusPill>
        </div>
        <span className="agent-meta trunc text-caption leading-4 text-fg-3" title={`${version ?? "版本未知"} · ${placeOf(harness, true)}`}>{version ?? "版本未知"} · {placeOf(harness, false)}</span>
      </div>
    </div>
    <p className="agent-summary m-0 line-clamp-2 min-h-10 text-ui-sm text-fg-2" title={state.summary}>{state.summary}</p>
    <div className="flex items-center gap-2 pt-0.5">
      <span className="trunc flex-1 text-caption text-fg-3">{products > 1 ? `本机有 ${products} 份安装` : ""}</span>
      {action ? <button type="button" className="btn btn-sm btn-primary" onClick={action.run}>{action.label}</button> : null}
      <button type="button" className="btn btn-sm" aria-haspopup="dialog" aria-label={`查看 ${harness.name} 详情`} onClick={onOpen}>详情</button>
    </div>
  </article>;
}

/** One product that can still be installed: its mark, name and a fact about it, the channel, and the way to install it. */
function CatalogRow({ harness, way, first, busy, status, failure, onOpen, onInstall }: {
  readonly harness: HarnessView; readonly way: InstallWay; readonly first: boolean; readonly busy: boolean; readonly status: string | null; readonly failure: string | null; readonly onOpen: () => void; readonly onInstall: () => void;
}) {
  return <div className={cn("agent-entry agent-row flex items-center gap-3 px-3.5 py-[11px]", !first && "hairline-t")}>
    <button type="button" className="flex min-w-0 flex-1 items-center gap-3 rounded-row border-none bg-transparent p-0 text-left" aria-haspopup="dialog" aria-label={`查看 ${harness.name} 详情`} onClick={onOpen}>
      <BrandIcon brand={harness.id} name={harness.name} size={32}/>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-1.5"><span className="trunc text-ui-sm font-medium">{harness.name}</span>
          {harness.tier === "frozen" ? <Badge tone="neutral" className="harness-frozen flex-none" title="冻结：保留适配与历史对话，不再打磨">冻结</Badge> : null}</span>
        <span className={cn("trunc text-caption", failure ? "text-red" : "text-fg-3")} title={failure ? "上次安装没有成功：" + failure : way.description}>{failure ? "上次安装没有成功：" + failure : way.description}</span>
      </span>
    </button>
    <span className="hidden flex-none text-caption text-fg-3 sm:inline">{way.channel}</span>
    {busy ? <button type="button" className="btn btn-sm flex-none text-accent-text" onClick={onOpen}><Spinner size={13} tone="run" label=""/>{status}</button>
      : way.runs ? <button type="button" className="btn btn-sm flex-none" onClick={onInstall}>安装</button>
      : <button type="button" className="btn btn-sm btn-ghost flex-none" aria-haspopup="dialog" onClick={onOpen}>安装方式</button>}
  </div>;
}

/** A command shown for copying, as the details show every command (board: "在原程序里继续对话"). */
function CommandBox({ command, label }: { readonly command: string; readonly label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => { if (state === "idle") return; const timer = setTimeout(() => setState("idle"), 1600); return () => clearTimeout(timer); }, [state]);
  return <div className="flex items-start gap-2 rounded-control bg-inset py-1.5 pr-1.5 pl-3">
    <code className="min-w-0 flex-1 py-[3px] text-[12px] leading-[20px] wrap-anywhere">{command}</code>
    <button type="button" className="icon-btn icon-btn-sm text-fg-3" aria-label={label} title={state === "copied" ? "已复制" : state === "failed" ? "无法使用剪贴板，可选中文本后复制" : label}
      onClick={() => { void navigator.clipboard.writeText(command).then(() => setState("copied"), () => setState("failed")); }}>{state === "copied" ? <Check size={14}/> : <Copy size={14}/>}</button>
  </div>;
}
/** A section's title in the details; beside an action (a task picker) it stays on one line and the action gives way. */
function SectionTitle({ id, children, action }: { readonly id: string; readonly children: ReactNode; readonly action?: ReactNode }) {
  return <div className="flex min-h-[26px] items-center gap-2"><h3 id={id} className={cn("m-0 flex-1 text-ui-sm font-semibold text-fg-2", action !== undefined && "whitespace-nowrap")}>{children}</h3>{action}</div>;
}
/** One step of a task as a timeline row (Agent board, "这次升级"): done, failed, waiting for you, or not reached. */
interface Step { readonly key: string; readonly mark: "done" | "fail" | "wait" | "skip"; readonly title: string; readonly note: ReactNode }
function Timeline({ steps, arrived }: { readonly steps: readonly Step[]; readonly arrived: (key: string) => boolean }) {
  return <ol className="upgrade-steps m-0 flex list-none flex-col p-0">{steps.map((step, index) => <li key={step.key} className={cn("flex gap-3", arrived(step.key) && "motion-row-in")}>
    {/* The words of each step say how it went; the mark repeats it for the eye. */}
    <div className="flex w-[18px] flex-none flex-col items-center" aria-hidden="true">
      {step.mark === "done" ? <DrawnCheck size={18} circle animate={arrived(step.key)} className="text-fg-3"/> : step.mark === "skip" ? <CircleDashed size={18} className="flex-none text-fg-3"/>
        : <CircleAlert size={18} className={cn("flex-none", step.mark === "fail" ? "text-red-dot" : "text-amber-dot")}/>}
      {index < steps.length - 1 ? <span className="my-[3px] w-[1.5px] flex-1 rounded-[1px] bg-line-strong" aria-hidden="true"/> : null}
    </div>
    <div className={cn("flex min-w-0 flex-1 flex-col gap-0.5", index < steps.length - 1 && "pb-3.5")}>
      <span className="text-ui-sm font-medium">{step.title}</span><span className="text-caption break-words text-fg-3">{step.note}</span>
    </div>
  </li>)}</ol>;
}

/**
 * An Agent's details in the drawer (Agent board): its state with the one way forward, the latest task step by step, its
 * models and sign-in, maintenance through each official installation, its capabilities, and the technical facts folded away.
 */
function AgentDetail(props: HarnessProps & { harness: HarnessView; state: AgentState; onClose: () => void; onRequest: (harness: HarnessView) => void; onInstallRequest: (harness: HarnessView) => void;
  onUninstallRequest: (harness: HarnessView, installation: InstallationView) => void; onUpgradeRequest: (harness: HarnessView, installation: InstallationView) => void }) {
  const { harness, state } = props, name = harness.name;
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [technical, setTechnical] = useState(false);
  const related = props.jobs.filter(job => job.harnessId === harness.id);
  const job = related.find(item => item.id === selectedJobId) ?? related.find(installationActive) ?? related[0] ?? null;
  const unconfirmed = props.unconfirmed.find(item => item.harnessId === harness.id);
  const busy = Boolean(job && installationActive(job)) || props.submitting.includes(harness.id);
  const here = onMachine(harness), version = versionOf(harness), seen = readinessOf(harness, props.readiness), ids = useId();
  // A running task is the state: its own section says it, so the state box is left out rather than said twice.
  const health = state.kind !== "missing" && !(state.kind === "busy" && job !== null && installationActive(job));
  return <>
    <header className="flex items-center gap-3.5 pt-5 pr-4 pb-4 pl-5">
      <BrandIcon brand={harness.id} name={name} size={52}/>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-1.5"><h2 className="trunc m-0 text-panel">{name}</h2>{harness.tier === "frozen" ? <Badge tone="neutral" title="冻结：保留适配与历史对话，不再打磨">冻结</Badge> : null}</div>
        <p className="agent-meta m-0 text-caption text-fg-3">{here ? `${version ?? "版本未知"} · ${placeOf(harness, true)}` : "未安装"}</p>
      </div>
      <button type="button" className="icon-btn self-start text-fg-3" aria-label="关闭 Harness 详情" onClick={props.onClose}><X size={15}/></button>
    </header>
    <div className="scroll-area flex min-h-0 flex-1 flex-col gap-5 px-5 pb-6">
      {props.error ? <Notice tone="red" onDismiss={props.onDismissError}>{props.error}</Notice> : null}
      {health ? <div className={cn("agent-health flex flex-col gap-1.5 rounded-block px-4 py-3.5", TONE_FILL[state.tone])}>
        <span className={cn("flex items-center gap-2 text-ui font-semibold", TONE_TEXT[state.tone])}><StateIcon state={state}/><SwapText text={state.title}/></span>
        <span className="text-ui-sm text-fg-2" {...(state.hint ? { title: state.hint } : {})}>{state.detail ?? state.summary}</span>
        {unconfirmed ? <div className="mt-1.5 flex flex-wrap gap-2"><button type="button" className="btn btn-sm btn-primary" disabled={props.submitting.includes(harness.id)} onClick={() => props.onConfirm(harness.id)}>确认上次请求</button></div>
          : available(harness) && !busy && (state.kind === "ready" || state.kind === "update" || state.kind === "signin" || state.kind === "readfail")
            ? <div className="mt-1.5 flex flex-wrap gap-2"><button type="button" className="btn btn-sm btn-outline" onClick={() => { props.onClose(); props.onChoose(harness); }}>开始对话<ArrowRight size={13}/></button></div> : null}
      </div> : null}
      {harness.install?.note ? <p className="harness-install-note m-0 text-ui-sm text-fg-2">{harness.install.note}</p> : null}
      {harness.unofficial ? <Notice className="harness-unofficial">在{harness.unofficial.onPath ? " PATH " : "标准目录"}中发现一个非官网安装（开发目录、npm link 或其他），命令名 {harness.unofficial.command}；平台不使用也不维护它。{harness.unofficial.pathDefault ? harness.installations.some(item => item.role === "product") ? `终端里 ${harness.unofficial.command} 运行的是这份非官网安装；HarnessHub 使用的是标为“当前使用”的官网安装。` : "终端里能用的就是它。" : ""}</Notice> : null}
      {!here ? <InstallSection {...props} busy={busy} titleId={ids + "install"}/> : null}
      {job ? <JobSection {...props} job={job} related={related} titleId={ids + "job"} onSelectJob={setSelectedJobId} said={state.jobId === job.id ? state.detail ?? null : null}
        stated={health && state.jobId === job.id} running={state.kind === "busy" ? state.summary : null}/> : null}
      {here ? <section aria-labelledby={ids + "models"} className="flex flex-col gap-2.5">
        <SectionTitle id={ids + "models"}>模型与登录</SectionTitle>
        <p className="m-0 text-ui-sm text-fg-2">{props.readiness === undefined ? "" : seen?.checkedAt != null ? seen.state === "ready" ? `${ago(seen.checkedAt)}读取过它的模型列表${seen.signedIn === true ? "，已登录" : ""}。`
          : seen.state === "signed_out" ? `${ago(seen.checkedAt)}读取时，它需要先登录或完成设置。`
          : seen.state === "failed" ? `${ago(seen.checkedAt)}读取它的模型列表失败。` : "" : "还没有读取过它的模型列表；在对话里选它时会读取。"}模型和登录沿用 {name} 自己的配置，HarnessHub 不复制也不修改。</p>
      </section> : null}
      {here && props.sessions !== undefined ? <ContinueSection api={props.api} name={name} titleId={ids + "continue"}
        session={props.sessions.reduce<SessionSummary | null>((latest, item) => item.selection.harnessId === harness.id && (latest === null || item.updatedSeq > latest.updatedSeq) ? item : latest, null)}
        onOpen={id => { props.onClose(); props.onOpenSession(id); }}/> : null}
      {here ? <MaintenanceSection {...props} busy={busy} titleId={ids + "maintenance"}/> : null}
      {harness.installations.some(item => item.role === "product") ? <section aria-labelledby={ids + "capabilities"} className="flex flex-col gap-2.5">
        <SectionTitle id={ids + "capabilities"}>能力</SectionTitle>
        <p className="m-0 text-ui-sm text-fg-2">{name} 读取的技能、MCP、指令、子 Agent、命令、Hooks 和插件，以及各自是否生效。</p>
        <button type="button" className="btn btn-sm self-start" onClick={() => props.onCapabilities(harness.id)}>查看 {name} 的能力</button>
      </section> : null}
      <section className="flex flex-col gap-2">
        <button type="button" className="-mx-1.5 flex items-center gap-1.5 self-start rounded-row border-none bg-transparent px-1.5 py-1 text-ui-sm font-semibold text-fg-2 hover:text-fg" aria-expanded={technical} aria-controls={ids + "technical"} onClick={() => setTechnical(value => !value)}>
          <ChevronRight size={14} className={cn("motion-rotate", technical && "rotate-90")} aria-hidden="true"/>技术细节</button>
        <Collapsible open={technical} id={ids + "technical"}><TechnicalFacts harness={harness}/></Collapsible>
      </section>
    </div>
  </>;
}

/**
 * How to continue the Agent's latest conversation in its own program (ADR-039), read once when shown: the command the
 * program's help gives, or its one-question command with what that depends on. HarnessHub only offers it for copying.
 */
function ContinueSection({ api, name, session, titleId, onOpen }: { readonly api: GatewayApi; readonly name: string; readonly session: SessionSummary | null; readonly titleId: string; readonly onOpen: (id: string) => void }) {
  const [view, setView] = useState<NativeResumeView | null | "failed" | undefined>(undefined);
  const id = session?.id ?? null;
  useEffect(() => {
    if (id === null) return;
    const controller = new AbortController(); setView(undefined);
    api.nativeResume(id, AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]))
      .then(value => { if (!controller.signal.aborted) setView(value); }, () => { if (!controller.signal.aborted) setView("failed"); });
    return () => controller.abort();
  }, [api, id]);
  const read = view === undefined || view === "failed" ? null : view, command = read?.interactive ?? read?.once ?? null;
  return <section aria-labelledby={titleId} className="flex flex-col gap-2.5">
    <SectionTitle id={titleId}>在原程序里继续对话</SectionTitle>
    {session === null ? <p className="m-0 text-ui-sm text-fg-2">还没有用 {name} 的对话。</p> : <>
      <p className="m-0 text-ui-sm text-fg-2">最近的对话<button type="button" className="link-btn font-normal" onClick={() => onOpen(session.id)}>「{session.title}」</button>
        {view === "failed" ? "：暂时读不到续接命令，可以在这个对话的详情栏里再看。" : view === null ? "还没有可以在原程序里继续的原生会话。"
          : read?.interactive ? "，在它的工作区目录中运行：" : read?.once ? "，在它的工作区目录中只问一次：" : read?.list ? "：" + read.list : read?.note === "no-command" ? "：这个程序没有可给出的续接命令。" : ""}</p>
      {command ? <CommandBox command={command} label="复制恢复命令"/> : null}
      {read && !read.interactive && read.once && read.onceNote ? <p className="m-0 text-caption text-fg-3">{read.onceNote}</p> : null}
    </>}
  </section>;
}

/** How a product that is not here is installed: by HarnessHub the official way, or by the user in a terminal (ADR-044). */
function InstallSection(props: HarnessProps & { harness: HarnessView; busy: boolean; titleId: string; onRequest: (harness: HarnessView) => void; onInstallRequest: (harness: HarnessView) => void }) {
  const { harness, busy } = props, install = harness.install, recipe = harness.management.recipe, name = harness.name;
  const official = officialInstallable(harness), managed = !official && canManage(harness) && actionFor(harness) === "install";
  const explanation = install ? official ? "HarnessHub 可以按官网方式代为安装：点“安装”后先显示会运行什么、写到哪里，确认后才运行。"
      : managed ? `HarnessHub 可以代为安装：按 ${name} 目录里的方式装入，完成后就能对话。`
      : install.method === "terminal" ? `按 ${name} 官方说明在终端安装，完成后重新检测即可使用。HarnessHub 不代为运行这条命令。` : `按 ${name} 官方说明安装，完成后重新检测即可使用。`
    : managed ? `HarnessHub 可以代为安装${recipe?.packageName ? (recipe.kind === "python" ? " Python 包 " : recipe.kind === "binary" ? "官方发布包 " : " npm 包 ") + recipe.packageName : ""}，完成后就能对话。`
    : "这个目录项还没有当前环境可用的安装方式。";
  return <section aria-labelledby={props.titleId} className="flex flex-col gap-2.5">
    <SectionTitle id={props.titleId}>安装 · 按官网的方式</SectionTitle>
    <p className="m-0 text-ui-sm text-fg-2">{explanation}{install ? `命令于 ${install.checkedAt} 对照官方说明核对。` : ""}</p>
    {install ? <CommandBox command={install.command} label="复制安装命令"/> : null}
    {install || official || managed ? <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      {official ? <button type="button" className="btn btn-primary" disabled={busy} onClick={() => props.onInstallRequest(harness)}>{busy ? <Spinner size={14} label=""/> : null}{busy ? "任务运行中" : "按官网方式安装"}</button>
        : managed ? <button type="button" className="btn btn-primary" disabled={busy} onClick={() => props.onRequest(harness)}>{busy ? <Spinner size={14} label=""/> : null}{busy ? props.submitting.includes(harness.id) ? "提交中" : "任务运行中" : "安装"}</button> : null}
      {install ? <a className="text-ui-sm" href={install.docs} target="_blank" rel="noreferrer">查看官方说明</a> : null}
    </div> : null}
  </section>;
}

/** The task shown in the details: its result first, then each step the Gateway recorded, the other facts, its log and its controls. */
function JobSection(props: HarnessProps & { harness: HarnessView; job: InstallationJobView; related: readonly InstallationJobView[]; titleId: string; onSelectJob: (id: string) => void;
  /** What the state box above already says of this task, not repeated here. */
  said: string | null;
  /** Whether the state box above is this task's outcome: the task's own status is then a plain line, not a second box. */
  stated: boolean;
  /** What a running task means meanwhile, said under its status. */
  running: string | null }) {
  const { harness, job, related } = props, native = job.native;
  const [inspecting, setInspecting] = useState(false), [inspectionError, setInspectionError] = useState<string | null>(null);
  const inspect = async () => { if (inspecting) return; setInspecting(true); setInspectionError(null); try { await props.api.inspectInstallation(job.id); props.onRescan(); } catch (error) { setInspectionError(errorMessage(error)); } finally { setInspecting(false); } };
  const latest = related[0]?.id === job.id;
  const tone = jobTone(job);
  // The steps the Gateway recorded for a native upgrade: the confirmed backup and each hop of a sequence (ADR-052), then each service.
  const steps: Step[] = [
    ...(native?.backupConfirmed ? [{ key: "backup", mark: "done" as const, title: "备份", note: "升级前你确认已经用它自己的命令备份并核对过" }] : []),
    ...(native?.hops ?? []).map((hop, index): Step => ({ key: "hop" + index, mark: hop.doctor === "failed" ? "fail" : hop.installed ? "done" : "skip", title: `第 ${index + 1} 跳`,
      note: <span className="upgrade-hop">{hop.version}：{hop.installed ? "已装入" : "没有装入"}{hop.doctor === "ok" ? "，Doctor 通过" : hop.doctor === "failed" ? "，Doctor 未通过" : hop.installed ? "，Doctor 未运行" : ""}</span> })),
    ...(native?.services ?? []).map((service): Step => ({ key: "service:" + service.label, mark: service.outcome === "not_recovered" ? "wait" : service.outcome === "not_running" ? "skip" : "done", title: "后台服务",
      note: service.label + "：" + serviceOutcome(service) })),
  ];
  const fact = "grid grid-cols-[84px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-ui-sm";
  // What was on screen when the task was first shown: steps added later arrive with motion, and a task that finishes
  // while shown draws its check (Motion #05, #06); nothing animates when the details open.
  const [shown, setShown] = useState(() => ({ id: job.id, keys: new Set(steps.map(step => step.key)) as ReadonlySet<string>, active: installationActive(job), finished: false }));
  if (shown.id !== job.id) setShown({ id: job.id, keys: new Set(steps.map(step => step.key)), active: installationActive(job), finished: false });
  else if (shown.active !== installationActive(job)) setShown({ ...shown, active: installationActive(job), finished: shown.active && job.status === "completed" });
  const arrived = (key: string) => shown.id === job.id && !shown.keys.has(key);
  return <section aria-labelledby={props.titleId} className="flex flex-col gap-3">
    <SectionTitle id={props.titleId} action={related.length > 1 ? <select className="field h-7 w-auto min-w-0 max-w-[180px] rounded-row py-0 pr-7 text-caption" aria-label="选择安装任务" value={job.id} onChange={event => props.onSelectJob(event.target.value)}>
      {related.map(item => <option value={item.id} key={item.id}>{verbOf(item)} · {item.resolvedVersion ?? item.id.slice(-8)} · {installationStatus(item)}</option>)}</select> : undefined}>
      {latest ? "这次" : ""}{verbOf(job)}{when(job.createdAt) ? " · " + when(job.createdAt) : ""}</SectionTitle>
    {/* Its icon sits in the timeline's 18 px column when it is a plain line above the steps. */}
    <div className={cn("installation-state flex items-start", props.stated ? "gap-3" : cn("gap-2.5 rounded-block px-3.5 py-3", TONE_FILL[tone]))} role="status">
      <span className={cn("mt-0.5 flex flex-none", props.stated && "w-[18px] justify-center", tone === "neutral" ? "text-accent-text" : TONE_TEXT[tone])}>
        {installationActive(job) ? <Spinner size={16} tone="run" label=""/> : job.status === "completed" ? <DrawnCheck size={16} circle animate={shown.finished}/> : job.status === "cancelled" ? <Square size={14} className="text-fg-3" aria-hidden="true"/> : <CircleAlert size={16} aria-hidden="true"/>}</span>
      <div className="min-w-0"><strong className="block text-ui-sm font-semibold"><SwapText text={installationStatus(job)} shimmer={installationActive(job)}/></strong>
        <span className="block text-caption text-fg-2">{installationActive(job) ? props.running ?? jobSummary(job, harness.name) : jobSummary(job, harness.name)}</span></div>
    </div>
    {jobError(job) && jobError(job) !== props.said ? <Notice tone={tone === "amber" ? "amber" : "red"}>{jobError(job)}</Notice> : null}
    {steps.length ? <Timeline steps={steps} arrived={arrived}/> : null}
    {native ? <dl className={cn("m-0", fact)}><Fact label="本机渠道">{channelLabel(native.channel)}</Fact><Fact label="操作前版本">{native.beforeVersion ?? "未安装"}</Fact>
      {native.dispatched ? <><Fact label="已核实版本">{native.actualVersion ?? "尚未核实"}</Fact><Fact label="原配置">{native.configurationPreserved === true ? native.configurationChangedByService ? "安装时没有改动；重启后服务自己改写了它" : native.configurationMigrated?.length ? "HarnessHub 没有写入；" + native.configurationMigrated.join("、") + " 由产品的 Doctor 迁移，原件在它的 .bak 备份里" : "保留，已核实" : "尚未确认"}</Fact></> : null}
      {native.closedConversations ? <Fact label="空闲进程">关闭了 {native.closedConversations} 个，下次发消息时重新连接</Fact> : null}
      {native.clearedRecords ? <Fact label="旧记录">清除了 {native.clearedRecords} 条</Fact> : null}
      {native.official ? <><Fact label="来源">{native.official.source}{native.official.sha256 ? `（SHA-256 ${native.official.sha256.slice(0, 16)}…）` : ""}</Fact>
        {native.official.shellChanges.map(change => <Fragment key={change.file}><Fact label="shell 配置"><span className="official-shell">{change.file}：{change.added.length ? "加了 " + change.added.join(" ／ ") : ""}{change.removed.length ? " 删了 " + change.removed.join(" ／ ") : ""}</span></Fact></Fragment>)}
        {native.official.configChanges.map(change => <Fragment key={change.file}><Fact label="设置改动">{change.file}：{change.keys.map(key => key.value === null ? key.path + "（值已更改，未显示）" : key.path + " = " + key.value).join("、")}</Fact></Fragment>)}
        {native.official.blocked.length ? <Fact label="被阻止"><span className="official-blocked">安装程序尝试写入 {native.official.blocked.join("、")}，已被阻止</span></Fact> : null}</> : null}
      {native.installation ? <><Fact label="运行"><code className="text-[12px]">{native.installation.command}</code></Fact>
        {native.installation.dependencies.length ? <Fact label="一并处理"><span className="upgrade-job-dependencies">{native.installation.dependencies.join("、")}</span></Fact> : null}
        {native.installation.shellChanges.map(change => <Fragment key={change.file}><Fact label="shell 配置">{change.file}：{change.added.length ? "加了 " + change.added.join(" ／ ") : ""}{change.removed.length ? " 删了 " + change.removed.join(" ／ ") : ""}</Fact></Fragment>)}
        {native.installation.configChanges.map(change => <Fragment key={change.file}><Fact label="设置改动">{change.file}：{change.keys.map(key => key.value === null ? key.path + "（值已更改，未显示）" : key.path + " = " + key.value).join("、")}</Fact></Fragment>)}
        {native.installation.blocked.length ? <Fact label="被阻止">更新程序尝试写入 {native.installation.blocked.join("、")}，已被阻止</Fact> : null}</> : null}
    </dl> : null}
    {job.status === "unknown" ? <p className="m-0 text-ui-sm text-amber">结果或清理状态尚未确认。不会自动重跑，也不会启用不确定的安装版本。</p> : null}
    {inspectionError ? <Notice tone="red">{inspectionError}</Notice> : null}
    {installationActive(job) || job.logCursor > 0 ? <InstallationLogs api={props.api} job={job}/> : null}
    {(job.native && job.status === "unknown") || installationActive(job) ? <div className="flex flex-wrap gap-2">
      {job.native && job.status === "unknown" ? <button type="button" className="btn btn-sm" disabled={inspecting} onClick={() => void inspect()}>{inspecting ? <Spinner size={13} label=""/> : <Search size={13}/>}核实本机结果</button> : null}
      {installationActive(job) ? <button type="button" className="btn btn-sm" disabled={job.cancelRequested || props.cancelling.includes(job.id)} onClick={() => props.onCancelJob(job)}><Square size={12}/>取消安装任务</button> : null}
    </div> : null}
  </section>;
}
function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return <><dt className="text-caption leading-5 text-fg-3">{label}</dt><dd className="m-0 min-w-0 wrap-anywhere">{children}</dd></>;
}

/**
 * Maintenance through the product's own channels (ADR-043, ADR-044): its versions, each official installation with its
 * upgrade and uninstall, and the upgrade HarnessHub runs for the Harness itself. Every action opens its confirmation first.
 */
function MaintenanceSection(props: HarnessProps & { harness: HarnessView; busy: boolean; titleId: string; onRequest: (harness: HarnessView) => void;
  onUninstallRequest: (harness: HarnessView, installation: InstallationView) => void; onUpgradeRequest: (harness: HarnessView, installation: InstallationView) => void }) {
  const { harness, busy } = props, management = harness.management, version = versionOf(harness), adapter = adapterVersion(harness);
  const products = harness.installations.filter(item => item.role === "product").length;
  const manage = canManage(harness), action = actionFor(harness);
  const managedCurrent = management.source === "managed" && management.updateStatus === "current";
  const label = busy ? props.submitting.includes(harness.id) ? "提交中" : "任务运行中"
    : action === "install" ? harness.installed ? "安装接入口" : "安装"
    : managedCurrent ? "已是最新" : management.updateStatus === "available" && management.latestVersion ? "升级到 " + management.latestVersion : "升级";
  const row = "flex items-center gap-3 px-3 py-[11px]";
  return <section aria-labelledby={props.titleId} className="flex flex-col gap-2.5">
    <SectionTitle id={props.titleId} action={<Tip label="检查更新"><button type="button" className="icon-btn icon-btn-sm" aria-label={`检查 ${harness.name} 更新`} disabled={props.checking} onClick={() => props.onCheckUpdates([harness.id])}>{props.checking ? <Spinner size={13} label=""/> : <RefreshCw size={14}/>}</button></Tip>}>维护 · 按官网的安装方式</SectionTitle>
    <div className="hairline overflow-hidden rounded-block">
      <dl className="m-0 grid grid-cols-2 gap-3 px-3 py-2.5">
        <div className="min-w-0"><dt className="text-caption text-fg-3">当前版本</dt><dd className="m-0 truncate text-ui font-semibold">{version ?? (harness.installed ? "版本未知" : "未安装")}</dd>{adapter ? <dd className="m-0 text-caption text-fg-3">接入口 {adapter}</dd> : null}</div>
        <div className="min-w-0"><dt className="text-caption text-fg-3">最新版本</dt><dd className="m-0 truncate text-ui font-semibold">{management.latestVersion ?? (management.updateStatus === "failed" ? "没有查到" : management.updateStatus === "checking" ? "正在检查…" : management.updateStatus === "unsupported" ? "不检查" : "还没有检查")}</dd>{management.checkedAt ? <dd className="m-0 text-caption text-fg-3">{ago(Date.parse(management.checkedAt))}检查</dd> : null}</div>
      </dl>
      {harness.installations.length ? <ul className="harness-installations m-0 flex list-none flex-col p-0">{harness.installations.map((item, index) => {
        const newer = item.latest !== null && item.latest.error === null && item.latest.version !== null && item.latest.version !== item.version;
        // A version upgrade whose channel already reported this version as the latest has nothing to do.
        const offer = item.upgrade !== null && !(item.upgrade === "version" && item.latest !== null && item.latest.error === null && item.latest.version === item.version) && !(item.upgrade === "maintenance" && manage);
        return <li key={index} className="flex items-start gap-3 hairline-t px-3 py-[11px]">
          <Package size={16} className="mt-0.5 flex-none text-fg-3" aria-hidden="true"/>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex flex-wrap items-center gap-1.5 text-ui-sm font-medium">{item.label}
              {item.role === "adapter" ? <Badge tone="neutral">接入口 {item.command}</Badge> : null}{item.active ? <span title="按 HarnessHub 服务进程的 PATH 顺序；终端里可能不同"><Badge tone="accent" dot>当前使用</Badge></span> : null}</span>
            <span className="text-caption text-fg-3">{item.version === null ? "版本未记录" : item.version}{item.maintained ? "" : " · HarnessHub 不维护这种安装方式"}{latestNote(item)}</span>
          </div>
          {offer || item.canUninstall ? <span className="flex flex-none items-center gap-1.5">
            {offer ? <button type="button" className={cn("btn btn-sm", newer && "btn-primary")} disabled={busy} aria-label={`${upgradeLabel(item)}：${item.label}里的 ${item.command}`} onClick={() => props.onUpgradeRequest(harness, item)}>{upgradeLabel(item)}</button> : null}
            {item.canUninstall ? <button type="button" className="btn btn-sm btn-danger" disabled={busy} aria-label={`卸载${item.label}里的 ${item.command}`} onClick={() => props.onUninstallRequest(harness, item)}>卸载…</button> : null}
          </span> : null}
        </li>; })}</ul> : null}
      {manage ? <div className={cn(row, "hairline-t")}>
        <RefreshCw size={16} className="flex-none text-fg-3" aria-hidden="true"/>
        <div className="flex min-w-0 flex-1 flex-col"><span className="text-ui-sm font-medium">{action === "install" ? harness.installed ? "接入口" : "安装" : "升级"}</span>
          <span className="text-caption text-fg-3">{action === "install" ? harness.installed ? "还没有安装它的接入口" : "还没有安装" : updateText(harness)}</span></div>
        <button type="button" className={cn("btn btn-sm flex-none", !busy && (action === "install" || management.updateStatus === "available") && "btn-primary")} disabled={busy || managedCurrent} onClick={() => props.onRequest(harness)}>{busy ? <Spinner size={13} label=""/> : null}{label}</button>
      </div> : management.native?.reason ? <div className={cn(row, "hairline-t")}><Info size={16} className="flex-none text-fg-3" aria-hidden="true"/><span className="min-w-0 flex-1 text-caption text-fg-2">{management.native.reason}</span></div> : null}
    </div>
    {products > 1 ? <p className="m-0 text-caption text-fg-2">“当前使用”按 HarnessHub 服务进程的 PATH 顺序确定；终端常被 nvm 等改动 PATH，用的可能是另一份。</p> : null}
    {harness.installations.some(item => item.canUninstall) ? <p className="m-0 text-caption text-fg-3">卸载只删除程序，保留你的数据和配置；确认前会列出要停止的服务和要删的文件。</p> : null}
    {harness.management.source === "system" && !harness.installations.length ? <p className="m-0 text-caption text-fg-3">这里管理终端使用的本机原安装，升级沿用它的原渠道。</p> : null}
  </section>;
}

/** What the scan and the catalog say about the entries, for whoever needs the internal terms (ADR-054 F11): folded by default. */
function TechnicalFacts({ harness }: { readonly harness: HarnessView }) {
  const recipe = harness.management.recipe, native = harness.management.native;
  const fact = "grid grid-cols-[84px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-ui-sm";
  return <div className="flex flex-col gap-3 pt-1">
    <dl className={cn("m-0", fact)}>
      <Fact label="来源">{sourceLabel(harness)}</Fact>
      {native ? <><Fact label="本机渠道">{channelLabel(native.channel)}</Fact><Fact label="位置"><code className="text-[12px]">{native.location}</code></Fact>{native.reason ? <Fact label="不能维护">{native.reason}</Fact> : null}</> : null}
      <Fact label="安装配方">{recipe?.sourceLabel ?? "暂无受支持的安装方式"}</Fact>
      {recipe?.packageName ? <Fact label="包名"><code className="text-[12px]">{recipe.packageName}</code></Fact> : null}
      {recipe?.reason ? <Fact label="说明">{recipe.reason}</Fact> : null}
      <Fact label="更新状态">{updateText(harness)}</Fact>
      {harness.management.error ? <Fact label="检查错误">{harness.management.error.message}</Fact> : null}
    </dl>
    <div className="flex flex-col gap-1.5">
      <span className="text-caption text-fg-3">控制入口</span>
      {harness.controls.length ? harness.controls.map(control => <div key={control.id} className="flex flex-col gap-1 rounded-block bg-subtle px-3 py-2.5">
        <div className="flex items-center gap-2"><Terminal size={14} className="text-fg-3" aria-hidden="true"/><strong className="text-ui-sm font-medium">{protocolLabel(control.protocol)}</strong><Badge tone={control.available ? "accent" : "neutral"} dot>{control.available ? "已解析" : "待准备"}</Badge></div>
        <code className="text-[12px] break-all text-fg-3">{control.id}</code>{control.entry ? <p className="m-0 text-caption text-fg-2">入口来源：{ENTRY_SOURCES[control.entry.source]}{control.entry.source === "custom-entry" ? "（路径以服务启动时的发现清单为准）" : ""}</p> : null}{control.reason ? <p className="m-0 text-caption text-amber">{control.reason}</p> : null}</div>)
        : <p className="m-0 text-ui-sm text-fg-2">目录里没有它的控制入口。</p>}
    </div>
  </div>;
}

function InstallationLogs({ api, job }: { api: GatewayApi; job: InstallationJobView }) {
  const [logs, setLogs] = useState<readonly InstallationLog[]>([]), [fault, setFault] = useState<string | null>(null), [open, setOpen] = useState(false);
  const live = useRef(job); live.current = job;
  const id = useId();
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
  return <div className="installation-logs flex flex-col">
    <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)} className="-mx-1.5 flex items-center gap-1.5 self-start rounded-row border-none bg-transparent px-1.5 py-1 text-ui-sm font-medium text-fg-2 hover:text-fg">
      <ChevronRight size={14} className={cn("motion-rotate", open && "rotate-90")} aria-hidden="true"/>安装日志<span className="text-fg-3">{logs.length}</span></button>
    <Collapsible open={open} id={id}><div className="flex flex-col gap-1.5 pt-1.5">{fault ? <Notice tone="amber">{fault}</Notice> : null}
      <div className="log-output max-h-64 overflow-auto rounded-block bg-inset p-3" role="log" aria-label="安装日志" aria-live="off">{logs.length ? logs.map(line => <div key={line.seq} className={cn("flex gap-2.5 font-mono text-[11.5px] leading-[1.6]", line.stream === "stderr" && "text-amber")}><span className="flex-none text-fg-3">{new Date(line.time).toLocaleTimeString("zh-CN", { hour12: false })}</span><code className="whitespace-pre-wrap wrap-anywhere">{line.text}</code></div>) : <p className="m-0 text-caption text-fg-3">暂无日志输出</p>}</div></div></Collapsible>
  </div>;
}
