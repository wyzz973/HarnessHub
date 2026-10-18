import { ChevronDown, ChevronRight, Download, Eye, History, RefreshCw, RotateCcw, Search, Trash2 } from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { CAPABILITY_KINDS, type CapabilitiesView, type CapabilityChangeView, type CapabilityDrift, type CapabilityDriftState, type CapabilityEdge, type CapabilityEntry, type CapabilityFacts, type CapabilityHistory,
  type CapabilityKind, type CapabilityMechanism, type CapabilityOrphan, type CapabilityOwner, type CapabilityStatus, type CapabilityWarning, type HarnessCapabilityReads, type SkillUpdateView } from "../../../src/contracts/capabilities.js";
import { errorMessage, type GatewayApi } from "../api.js";
import { cn } from "../lib/cn.js";
import { Badge, EmptyState, Notice, Spinner, Tip } from "../ui/primitives.js";
import { BrandIcon } from "./BrandIcon.js";
import { ChangeDialog, RestoreDialog, type ChangeRequest, type SwitchRequest } from "./CapabilityChangeDialog.js";
import { PageShell } from "./PageShell.js";
import { McpInventoryPanel } from "./McpInventoryPanel.js";
import { InstructionsPanel } from "./InstructionsPanel.js";
import { SkillAddDialog } from "./SkillAddDialog.js";

export const KIND_LABEL: Readonly<Record<CapabilityKind, string>> = { skill: "技能", mcp: "MCP", instructions: "指令", subagent: "子 Agent", command: "命令", hook: "Hooks", plugin: "插件" };
const MECHANISM_LABEL: Readonly<Record<CapabilityMechanism, string>> = { "native-shared": "共享目录", linked: "链接", "own-copy": "自有目录", "compat-root": "兼容读取", "external-dir": "外加目录",
  plugin: "插件", bundled: "内置", synced: "账户同步", config: "配置" };
const STATUS_LABEL: Readonly<Record<CapabilityStatus, string>> = { active: "生效", disabled: "已停用", shadowed: "被覆盖", duplicate: "重复", rejected: "被跳过", "broken-link": "链接失效", invalid: "无效" };
const OWNER_LABEL: Readonly<Record<CapabilityOwner, string>> = { user: "用户", harnesshub: "HarnessHub", "skills-cli": "vercel skills", "cc-switch": "cc-switch", magpie: "Magpie", clawhub: "ClawHub",
  "hermes-hub": "Hermes Hub", plugin: "插件", bundled: "随程序安装", synced: "账户同步" };
const CHANGE_LABEL: Readonly<Record<CapabilityChangeView["kind"], string>> = { "skill-switch": "技能开关", "shared-dir": "共享目录", "skill-link": "放置技能", "link-cleanup": "清理链接", "link-undo": "撤销", restore: "恢复",
  "skill-add": "添加技能", "skill-update": "更新技能", "skill-delete": "删除技能", "skill-undo": "撤销", "mcp-sync": "写入 MCP", "mcp-remove": "移除 MCP", "mcp-claim": "认领 MCP",
  "instructions-sync": "写入指令", "instructions-remove": "移除指令", "instructions-claim": "认领指令" };
type SkillUpdate = SkillUpdateView["skills"][number];
/** A skill folder's name in the shared directory, from where the view shows it. */
function folderName(entry: CapabilityEntry): string | null { return entry.shared ? entry.shared.folder.split("/").filter(Boolean).at(-1) ?? null : null; }
const DRIFT_LABEL: Readonly<Record<CapabilityDriftState, string>> = { removed: "已被外部移除", changed: "已被外部改动", unreadable: "文件无法读取，无法核对" };
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
/**
 * The switches of one skill: per Harness that has one, turning it off or back on in that Harness's own configuration;
 * Codex switches each copy by its path. Entries a Harness cannot use have nothing to switch.
 */
function SkillSwitches({ entry, harnesses, onSwitch }: { readonly entry: CapabilityEntry; readonly harnesses: readonly HarnessCapabilityReads[]; readonly onSwitch: (request: SwitchRequest) => void }) {
  const switchable = (edge: CapabilityEdge) => edge.status === "active" || edge.status === "duplicate" || edge.status === "shadowed" || edge.status === "disabled";
  const buttons = harnesses.filter(harness => harness.skillSwitch !== null).flatMap((harness): { harness: HarnessCapabilityReads; via: string | null; off: boolean; which: string | null }[] => {
    const edges = entry.edges.filter(edge => edge.harnessId === harness.harnessId && switchable(edge));
    if (!edges.length) return [];
    if (harness.harnessId === "codex") return edges.map(edge => ({ harness, via: edge.via, off: edge.status === "disabled", which: MECHANISM_LABEL[edge.mechanism] }));
    return [{ harness, via: null, off: edges.some(edge => edge.status === "disabled"), which: null }];
  });
  if (!buttons.length) return null;
  return <div className="skill-switches flex flex-wrap gap-1.5">{buttons.map(button => <button key={button.harness.harnessId + (button.via ?? "")} type="button" className="btn btn-sm"
    onClick={() => onSwitch({ harnessId: button.harness.harnessId, harnessName: button.harness.name, name: entry.name, enabled: button.off, via: button.via })}>
    {(button.off ? "在 " + button.harness.name + " 中启用" : "在 " + button.harness.name + " 中停用") + (button.which ? "（" + button.which + "）" : "")}</button>)}</div>;
}
/** Placing a shared skill in Claude Code by a link of its own, or removing a link HarnessHub placed there. */
function ClaudePlacement({ api, entry, harnesses, onChange }: { readonly api: GatewayApi; readonly entry: CapabilityEntry; readonly harnesses: readonly HarnessCapabilityReads[]; readonly onChange: (request: ChangeRequest) => void }) {
  const claude = harnesses.find(harness => harness.harnessId === "claude" && harness.shared.placeable === "skill-link");
  if (!claude || !entry.shared) return null;
  const sees = entry.edges.some(edge => edge.harnessId === "claude" && edge.status !== "broken-link" && edge.status !== "invalid");
  const placed = entry.shared.placed.find(path => path.startsWith("~/.claude/") || path.includes("/.claude/"));
  if (placed) return <button type="button" className="btn btn-sm" onClick={() => onChange({ title: "从 " + claude.name + " 移除 " + entry.name, verb: "移除", on: null, done: "已从 " + claude.name + " 移除 " + entry.name,
    load: () => api.checkSkillLink("claude", entry.name, false) })}>从 {claude.name} 移除（HarnessHub 放置的）</button>;
  if (sees) return null;
  return <button type="button" className="btn btn-sm" onClick={() => onChange({ title: "把 " + entry.name + " 放到 " + claude.name, verb: "放置", on: null, done: "已把 " + entry.name + " 放到 " + claude.name,
    load: () => api.checkSkillLink("claude", entry.name, true) })}>放到 {claude.name}</button>;
}
/**
 * Updating a shared skill from its source, when a newer version is known, and deleting it from the shared directory; both
 * go through the usual confirmation, which keeps a snapshot of the folder first.
 */
function SkillLifecycle({ api, entry, update, onChange }: { readonly api: GatewayApi; readonly entry: CapabilityEntry; readonly update: SkillUpdate | undefined; readonly onChange: (request: ChangeRequest) => void }) {
  const folder = folderName(entry);
  if (folder === null) return null;
  return <>
    {update?.state === "available" ? <button type="button" className="btn btn-sm" onClick={() => onChange({ title: "更新 " + folder, verb: "更新", on: null, icon: "update", done: "已更新 " + folder, load: () => api.checkSkillUpdate(folder, false) })}>
      <RefreshCw size={13}/>更新</button> : null}
    {update?.state === "available" && update.modified !== false ? <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange({ title: "覆盖本地改动并更新 " + folder, verb: "覆盖并更新", on: null, icon: "update",
      done: "已更新 " + folder, load: () => api.checkSkillUpdate(folder, true) })}>覆盖本地改动并更新</button> : null}
    <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange({ title: "删除 " + folder, verb: "删除", on: null, icon: "delete", done: "已删除 " + folder, load: () => api.checkSkillDelete(folder) })}><Trash2 size={13}/>删除</button>
  </>;
}
function EntryDetail({ api, entry, harnesses, update, onSwitch, onChange }: { readonly api: GatewayApi; readonly entry: CapabilityEntry; readonly harnesses: readonly HarnessCapabilityReads[]; readonly update: SkillUpdate | undefined;
  readonly onSwitch: (request: SwitchRequest) => void; readonly onChange: (request: ChangeRequest) => void }) {
  const name = (id: string | null) => id === null ? null : harnesses.find(harness => harness.harnessId === id)?.name ?? id;
  return <div className="capability-detail flex flex-col gap-2 px-1 py-1 text-[12.5px]">
    {entry.description ? <p className="m-0 text-fg-2">{entry.description}</p> : null}
    <dl className="m-0 grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-1">
      {entry.location ? <><dt className="text-fg-3">位置</dt><dd className="m-0"><code className="text-[12px] break-all">{entry.location}</code></dd></> : null}
      <dt className="text-fg-3">归属</dt><dd className="m-0">{OWNER_LABEL[entry.owner]}{entry.source ? <span className="text-fg-3"> · 来源 <span className="break-all">{entry.source}</span></span> : null}</dd>
      {update ? <><dt className="text-fg-3">更新</dt><dd className="m-0">{UPDATE_LABEL[update.state]}{update.modified ? "；本地改过" : ""}{update.reason ? <span className="text-fg-3"> · {update.reason}</span> : null}</dd></> : null}
      {entry.facts ? <><dt className="text-fg-3">内容</dt><dd className="m-0">{factsText(entry.facts)}</dd></> : null}
    </dl>
    <ul className="m-0 flex list-none flex-col gap-1 p-0">{entry.edges.map((edge, index) => <li key={index} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded-lg border border-line px-2.5 py-1.5">
      <strong className="font-medium">{name(edge.harnessId)}</strong><span className={STATUS_TONE[edge.status]}>{STATUS_LABEL[edge.status]}</span><span className="text-fg-3">{MECHANISM_LABEL[edge.mechanism]}</span>
      <code className="text-[11.5px] break-all text-fg-2">{edge.via}</code>{edge.reason ? <span className="w-full text-fg-2">{edge.reason}</span> : null}
      {edge.facts && entry.kind === "mcp" ? <span className="w-full text-fg-3">{factsText(edge.facts)}</span> : null}</li>)}</ul>
    {entry.warnings.length ? <ul className="m-0 flex list-none flex-col gap-1 p-0">{entry.warnings.map((warning, index) => <li key={index} className="flex items-start gap-2"><Badge tone={warning.kind === "literal" ? "red" : "amber"}>{WARNING_LABEL[warning.kind]}</Badge><span className="text-fg-2">{warning.text}</span></li>)}</ul> : null}
    {entry.kind === "skill" ? <div className="flex flex-wrap gap-1.5"><SkillSwitches entry={entry} harnesses={harnesses} onSwitch={onSwitch}/><ClaudePlacement api={api} entry={entry} harnesses={harnesses} onChange={onChange}/>
      <SkillLifecycle api={api} entry={entry} update={update} onChange={onChange}/></div> : null}
  </div>;
}
const READS: Readonly<Record<HarnessCapabilityReads["shared"]["reads"], string>> = { native: "自己读取", "external-dir": "经 skills.external_dirs 读取", links: "经自己目录里的链接", no: "不读取" };
const UPDATE_LABEL: Readonly<Record<SkillUpdate["state"], string>> = { current: "已是最新", available: "有新版本", gone: "仓库里已没有", unknown: "无法检查", unsupported: "HarnessHub 不更新这类来源" };
/**
 * How each Harness reads the shared `~/.agents/skills`, with what HarnessHub can change: make Hermes read it, place single
 * skills in Claude Code, and remove the links a Harness no longer needs.
 */
function SharedDirectory({ api, harnesses, updates, checking, updateProblem, onAdd, onCheckUpdates, onChange }: { readonly api: GatewayApi; readonly harnesses: readonly HarnessCapabilityReads[];
  readonly updates: SkillUpdateView | null; readonly checking: boolean; readonly updateProblem: string | null; readonly onAdd: () => void; readonly onCheckUpdates: () => void; readonly onChange: (request: ChangeRequest) => void }) {
  const available = updates?.skills.filter(item => item.state === "available").length ?? 0, unknown = updates?.skills.filter(item => item.state === "unknown").length ?? 0;
  return <section className="shared-directory rounded-xl border border-line bg-surface px-4 py-3 text-[12.5px]" aria-label="共享技能目录">
    <div className="flex flex-wrap items-baseline justify-between gap-2"><strong className="text-[13px] font-semibold">共享技能目录 <code className="text-[12px] font-normal">~/.agents/skills</code></strong>
      <span className="text-fg-3">技能放在这里一份，各 Harness 按自己的方式读取。</span></div>
    <div className="skill-library mt-2 flex flex-wrap items-center gap-2">
      <button type="button" className="btn btn-sm" onClick={onAdd}><Download size={13}/>从 GitHub 添加技能</button>
      <button type="button" className="btn btn-ghost btn-sm" disabled={checking} onClick={onCheckUpdates}>{checking ? <Spinner size={13}/> : <RefreshCw size={13}/>}检查更新</button>
      {updates ? <span className="skill-update-summary text-fg-2">{available ? available + " 个技能有新版本（展开后更新）" : "已知来源的技能都是最新的"}{unknown ? "；" + unknown + " 个无法检查" : ""} · 检查于 {new Date(updates.checkedAt).toLocaleTimeString()}</span> : null}
      {updateProblem ? <span className="text-red">{updateProblem}</span> : null}
    </div>
    <ul className="m-0 mt-2 flex list-none flex-col gap-1 p-0">{harnesses.map(harness => <li key={harness.harnessId} className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="min-w-[110px] font-medium">{harness.name}</span><span className="text-fg-2">{READS[harness.shared.reads]}{harness.shared.links ? "；自己目录里有 " + harness.shared.links + " 个指向它的链接" + (harness.shared.redundant ? "，其中 " + harness.shared.redundant + " 个多余" : "") : ""}</span>
      {harness.shared.placeable === "shared-dir" ? harness.shared.reads === "external-dir"
        ? <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange({ title: "让 " + harness.name + " 停止读取共享目录", verb: "停止读取", on: false, done: harness.name + " 已停止读取共享目录", load: () => api.checkSharedDir(harness.harnessId, false) })}>停止读取</button>
        : <button type="button" className="btn btn-sm" onClick={() => onChange({ title: "让 " + harness.name + " 读取共享目录", verb: "读取", on: true, done: harness.name + " 已读取共享目录", load: () => api.checkSharedDir(harness.harnessId, true) })}>让 {harness.name} 读取共享目录</button>
        : harness.shared.placeable === "skill-link" ? <span className="text-fg-3">（逐个放置：展开技能后点“放到 {harness.name}”）</span> : null}
      {harness.shared.redundant && (harness.harnessId === "hermes" || harness.harnessId === "openclaw") ? <button type="button" className="btn btn-ghost btn-sm"
        onClick={() => onChange({ title: "清理 " + harness.name + " 的多余链接", verb: "清理", on: null, done: "已清理 " + harness.name + " 的多余链接", load: () => api.checkLinkCleanup(harness.harnessId) })}>清理 {harness.shared.redundant} 个多余链接</button> : null}
    </li>)}</ul>
  </section>;
}
/**
 * What HarnessHub wrote that is no longer as it wrote it (ADR-045 §10). Nothing is put back by itself: each can be
 * re-applied through its usual check, or no longer tracked, which changes no file.
 */
function DriftNotice({ api, drift, harnesses, onChange, onForgotten }: { readonly api: GatewayApi; readonly drift: readonly CapabilityDrift[]; readonly harnesses: readonly HarnessCapabilityReads[];
  readonly onChange: (request: ChangeRequest) => void; readonly onForgotten: () => void }) {
  const [busy, setBusy] = useState<string | null>(null), [failure, setFailure] = useState<string | null>(null);
  const forget = (id: string) => { setBusy(id); setFailure(null); api.forgetDrift(id).then(() => { setBusy(null); onForgotten(); }, error => { setBusy(null); setFailure(errorMessage(error)); }); };
  return <Notice tone="amber" className="capability-drift" title={"HarnessHub 写过的 " + drift.length + " 项设置已不在原处"}>
    <p className="m-0">多半是 Harness 自己重写了配置文件，或在别处改过。HarnessHub 不会自动改回：可以重新应用（先显示改动），或不再跟踪（文件不变）。</p>
    <ul className="m-0 mt-1.5 flex list-none flex-col gap-1 p-0">{drift.map(item => <li key={item.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-fg">
      <strong className="font-medium">{harnesses.find(harness => harness.harnessId === item.harnessId)?.name ?? item.harnessId} · {item.kind === "mcp" ? "MCP" : item.kind === "instructions" ? "指令区块" : CHANGE_LABEL[item.kind]} · {item.subject}</strong>
      <Badge tone="amber">{item.kind === "mcp" && item.harnessId === "claude" && item.state === "removed" ? "写入丢失（可能被运行中的 Claude Code 会话冲掉）" : DRIFT_LABEL[item.state]}</Badge><code className="text-[11.5px] break-all text-fg-2">{item.file}</code>
      <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => onChange({ title: "重新应用：" + item.subject, verb: "重新应用", on: item.kind === "skill-switch" ? false : item.kind === "shared-dir" ? true : null,
        done: "已重新应用：" + item.subject, load: () => api.checkReapply(item.id) })}>重新应用</button>
      <button type="button" className="btn btn-ghost btn-sm" disabled={busy !== null} title="HarnessHub 不再把它算作自己写的；文件不变" onClick={() => forget(item.id)}>{busy === item.id ? <Spinner size={13}/> : null}不再跟踪</button>
    </li>)}</ul>
    {failure ? <p className="m-0 mt-1 text-red">{failure}</p> : null}
  </Notice>;
}
/**
 * Switch settings HarnessHub wrote for skills their Harness no longer has (usually deleted): they do nothing now and take
 * effect again if a skill of that name comes back. Each can be cleared through the usual switch check.
 */
function OrphanNotice({ api, orphans, harnesses, onChange }: { readonly api: GatewayApi; readonly orphans: readonly CapabilityOrphan[]; readonly harnesses: readonly HarnessCapabilityReads[]; readonly onChange: (request: ChangeRequest) => void }) {
  return <Notice tone="neutral" className="capability-orphans" title={"孤立的停用设置（技能已删除）" + orphans.length + " 项"}>
    <p className="m-0">HarnessHub 为这些技能写的停用设置还在，技能已经不在了：现在不起作用，以后添加同名技能时会再次生效。</p>
    <ul className="m-0 mt-1.5 flex list-none flex-col gap-1 p-0">{orphans.map(item => <li key={item.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-fg">
      <strong className="font-medium">{harnesses.find(harness => harness.harnessId === item.harnessId)?.name ?? item.harnessId} · {item.subject}</strong><code className="text-[11.5px] break-all text-fg-2">{item.file}</code>
      <button type="button" className="btn btn-sm" onClick={() => onChange({ title: "清除停用设置：" + item.subject, verb: "清除", on: true, done: "已清除 " + item.subject + " 的停用设置", load: () => api.checkOrphanClear(item.id) })}>清除</button>
    </li>)}</ul>
  </Notice>;
}
/** HarnessHub's own changes to the Harnesses' files, newest first, and the backups it keeps (the newest ten per file). */
function ChangeHistory({ api, history, onRestore, onChange }: { readonly api: GatewayApi; readonly history: CapabilityHistory; readonly onRestore: (backupId: string) => void; readonly onChange: (request: ChangeRequest) => void }) {
  return <details className="capability-history rounded-xl border border-line bg-surface px-4 py-3 text-[12.5px]"><summary className="cursor-pointer font-medium"><History size={13} className="mr-1.5 inline" aria-hidden="true"/>修改与备份
    <span className="ml-1.5 font-normal text-fg-3">{history.changes.length} 次修改 · {history.backups.length} 份备份{history.snapshots.count ? " · " + history.snapshots.count + " 份技能快照（" + size(history.snapshots.bytes) + "）" : ""}</span></summary>
    <p className="m-0 mt-2 text-fg-3">技能的添加、更新和删除会先存快照；只保留最近 {history.snapshots.keep} 次修改用到的快照，更早的修改无法撤销。</p>
    {history.changes.length === 0 ? <p className="m-0 mt-2 text-fg-3">HarnessHub 还没有改过任何 Harness 的配置。</p> : <ul className="m-0 mt-2 flex list-none flex-col gap-1.5 p-0">{history.changes.map(change =>
      <li key={change.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded-lg border border-line px-2.5 py-1.5">
        <span className="text-fg-3">{new Date(change.at).toLocaleString()}</span><strong className="font-medium">{CHANGE_LABEL[change.kind]} · {change.subject}</strong>
        <Badge tone={change.status === "applied" ? "green" : "red"}>{change.status === "applied" ? "已完成" : "失败"}</Badge><code className="text-[11.5px] break-all text-fg-2">{change.file}</code>
        {change.links?.length ? <span className="text-fg-3">{change.links.filter(link => link.action === "create").length ? "新建 " + change.links.filter(link => link.action === "create").length + " 个链接 " : ""}{change.links.filter(link => link.action === "remove").length ? "删除 " + change.links.filter(link => link.action === "remove").length + " 个链接" : ""}</span> : null}
        {change.skills?.length ? <span className="text-fg-3">{change.skills.length} 个技能文件夹</span> : null}
        {(change.links?.length && change.kind !== "skill-undo") || ((change.kind === "skill-add" || change.kind === "skill-update" || change.kind === "skill-delete") && change.status === "applied")
          ? <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange({ title: "撤销：" + change.subject, verb: "撤销", on: null, icon: "undo", done: "已撤销：" + change.subject, load: () => api.checkUndo(change.id) })}><RotateCcw size={13}/>撤销</button> : null}
        {change.error ? <span className="w-full text-red">{change.error.message}</span> : null}</li>)}</ul>}
    {history.backups.length ? <><p className="m-0 mt-3 font-medium">备份</p><ul className="m-0 mt-1 flex list-none flex-col gap-1.5 p-0">{history.backups.map(backup =>
      <li key={backup.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5"><code className="text-[11.5px] break-all">{backup.file}</code><span className="text-fg-3">{new Date(backup.createdAt).toLocaleString()} · {backup.subject} 之前</span>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => onRestore(backup.id)}><RotateCcw size={13}/>恢复</button></li>)}</ul></> : null}
  </details>;
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
  const [changing, setChanging] = useState<ChangeRequest | null>(null), [restoring, setRestoring] = useState<string | null>(null), [history, setHistory] = useState<CapabilityHistory | null>(null);
  const change = (request: ChangeRequest) => setChanging(request);
  const switchSkill = (request: SwitchRequest) => change({ title: "在 " + request.harnessName + " 中" + (request.enabled ? "启用 " : "停用 ") + request.name, verb: request.enabled ? "启用" : "停用", on: request.enabled,
    done: "已在 " + request.harnessName + " 中" + (request.enabled ? "启用 " : "停用 ") + request.name, load: () => api.checkSkillSwitch(request.harnessId, request.name, request.enabled, request.via) });
  const [result, setResult] = useState<{ readonly view: CapabilityChangeView; readonly title: string } | null>(null);
  const [adding, setAdding] = useState(false), [updates, setUpdates] = useState<SkillUpdateView | null>(null), [checkingUpdates, setCheckingUpdates] = useState(false), [updateProblem, setUpdateProblem] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0), [notice, setNotice] = useState<{ readonly text: string; readonly failed: boolean } | null>(null);
  const updateOf = (entry: CapabilityEntry): SkillUpdate | undefined => { const folder = folderName(entry); return folder === null ? undefined : updates?.skills.find(item => item.name === folder); };
  const checkUpdates = () => {
    setCheckingUpdates(true); setUpdateProblem(null);
    api.skillUpdates(true).then(value => { setCheckingUpdates(false); setUpdates(value); }, error => { setCheckingUpdates(false); setUpdateProblem(errorMessage(error)); });
  };
  const load = useCallback((signal?: AbortSignal) => {
    setLoading(true); setProblem(null);
    api.capabilities(signal).then(next => { setView(next); setLoading(false); }, failure => { if (signal?.aborted) return; setProblem(errorMessage(failure)); setLoading(false); });
  }, [api]);
  const loadHistory = useCallback((signal?: AbortSignal) => { api.capabilityHistory(signal).then(setHistory, () => { if (!signal?.aborted) setHistory(null); }); }, [api]);
  useEffect(() => { const controller = new AbortController(); load(controller.signal); loadHistory(controller.signal); return () => controller.abort(); }, [load, loadHistory]);
  const finished = (view: CapabilityChangeView, title: string) => {
    setChanging(null); setRestoring(null); setResult({ view, title }); load(); loadHistory(); setReloads(value => value + 1);
    // A change of skill folders makes the known update states stale.
    if (view.skills?.length) setUpdates(null);
  };
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
    description="各 Harness 除模型外还会读取的技能、MCP、指令、子 Agent、命令、Hooks 和插件，按各自的规则显示谁能看到、经由哪里、是否生效。技能可以从 GitHub 添加到共享目录、按来源更新、删除，也可以在各 Harness 中停用或启用：先显示要改的内容，确认后才写入，并保留备份或快照。读取不启动 MCP 服务器。"
    actions={<Tip label="重新读取"><button type="button" className="icon-btn" aria-label="重新读取" onClick={() => load()} disabled={loading}>{loading ? <Spinner size={15}/> : <RefreshCw size={16}/>}</button></Tip>}>
    {problem ? <Notice tone="red" action={<button type="button" className="btn btn-sm" onClick={() => load()}>重试</button>}>{problem}</Notice> : null}
    {result ? <Notice tone={result.view.status === "applied" ? "green" : "red"} className="capability-result" onDismiss={() => setResult(null)} title={result.view.status === "applied" ? result.title : result.title + "没有完成"}
      action={result.view.backupId ? <button type="button" className="btn btn-sm" onClick={() => setRestoring(result.view.backupId)}><RotateCcw size={13}/>恢复修改前的文件</button> : null}>
      {result.view.error ? result.view.error.message + "。" : null}{result.view.notes.join(" ")}</Notice> : null}
    {notice ? <Notice tone={notice.failed ? "red" : "green"} className="capability-notice" onDismiss={() => setNotice(null)}>{notice.text}</Notice> : null}
    {view && history?.drift.length ? <DriftNotice api={api} drift={history.drift} harnesses={view.harnesses} onChange={change} onForgotten={() => loadHistory()}/> : null}
    {view && history?.orphans.length ? <OrphanNotice api={api} orphans={history.orphans} harnesses={view.harnesses} onChange={change}/> : null}
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
      <div role="tabpanel" id="capability-tabpanel" aria-labelledby={"capability-tab-" + kind} className="flex flex-col gap-3">
      {kind === "skill" ? <SharedDirectory api={api} harnesses={view.harnesses.filter(item => harness === null || item.harnessId === harness)} updates={updates} checking={checkingUpdates} updateProblem={updateProblem}
        onAdd={() => setAdding(true)} onCheckUpdates={checkUpdates} onChange={change}/> : null}
      {kind === "mcp" ? <McpInventoryPanel api={api} harness={harness} reload={reloads} onChange={change} onNotice={(text, failed) => setNotice({ text, failed })}/> : null}
      {kind === "instructions" ? <InstructionsPanel api={api} harness={harness} reload={reloads} onChange={change} onNotice={(text, failed) => setNotice({ text, failed })}/> : null}
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
                    <span className="mt-0.5 flex flex-wrap items-center gap-1"><span className="text-[11.5px] text-fg-3">{OWNER_LABEL[entry.owner]}</span>{warnings ? <Badge tone="amber">{warnings} 条提示</Badge> : null}
                      {updateOf(entry)?.state === "available" ? <Badge tone="accent">有新版本</Badge> : null}</span></span></button></th>
              {columns.map(item => <td key={item.harnessId} className="px-2 py-2"><Cell edges={entry.edges.filter(edge => edge.harnessId === item.harnessId)} support={item.kinds[kind]}/></td>)}
            </tr>{expanded ? <tr className="border-b border-line bg-subtle"><td colSpan={columns.length + 1} className="px-3 pb-3"><EntryDetail api={api} entry={entry} harnesses={view.harnesses} update={updateOf(entry)} onSwitch={switchSkill} onChange={change}/></td></tr> : null}</Fragment>; })}</tbody>
        </table></div>
        : <EmptyState title={query || onlyWarnings ? "没有匹配的条目" : "这一类还没有条目"}>{columns.some(item => item.kinds[kind] !== "read") ? "部分 Harness 没有这类能力，或保存在磁盘之外。" : "各 Harness 的用户级配置里没有这一类。"}</EmptyState>}
      </div>
      <details className="rounded-xl border border-line bg-surface px-4 py-3 text-[12.5px]"><summary className="cursor-pointer font-medium"><Eye size={13} className="mr-1.5 inline" aria-hidden="true"/>各 Harness 的读取规则与说明</summary>
        <ul className="m-0 mt-2 flex list-none flex-col gap-2 p-0">{view.harnesses.map(item => <li key={item.harnessId}><strong className="font-medium">{item.name}</strong>
          <span className="ml-1.5 text-fg-3">{item.version ? "v" + item.version : "版本未知"} · {item.table === "verified" ? "规则已按这个版本核实" : "规则未按这个版本核实"}</span>
          <ul className="m-0 mt-0.5 list-disc pl-5 text-fg-2">{item.notes.map((note, index) => <li key={index}>{note}</li>)}</ul></li>)}</ul>
        <p className="m-0 mt-2 text-fg-3">读取时间 {new Date(view.checkedAt).toLocaleString()}。只显示名字与数量，不显示任何环境变量、请求头或参数的值。</p></details>
      {history ? <ChangeHistory api={api} history={history} onRestore={setRestoring} onChange={change}/> : null}
    </>}
    <ChangeDialog api={api} request={changing} onClose={() => setChanging(null)} onDone={finished}/>
    <SkillAddDialog api={api} open={adding} onClose={() => setAdding(false)} onChange={change}/>
    <RestoreDialog api={api} backupId={restoring} onClose={() => setRestoring(null)} onDone={change => finished(change, "已恢复 " + change.file)}/>
  </PageShell>;
}
