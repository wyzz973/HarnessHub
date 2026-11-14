import { AlertCircle, BookOpen, Check, ChevronDown, ChevronRight, CircleCheck, Download, Eye, History, Menu as MenuIcon, PanelLeft, Pencil, Plug, Plus, Puzzle, RefreshCw, RotateCcw, ScrollText, Search, SquareSlash, Trash2, Users, Webhook, X,
  type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { LOCAL_SKILL_SOURCE, type SkillTextView, type CapabilitiesView, type CapabilityChangeView, type CapabilityDrift, type CapabilityDriftState, type CapabilityEdge, type CapabilityEntry, type CapabilityFacts, type CapabilityHistory,
  type CapabilityKind, type CapabilityMechanism, type CapabilityOrphan, type CapabilityOwner, type CapabilityStatus, type CapabilityWarning, type HarnessCapabilityReads, type SkillUpdateView } from "../../../src/contracts/capabilities.js";
import { errorMessage, type GatewayApi } from "../api.js";
import { cn } from "../lib/cn.js";
import { ariaKeys, keyText } from "../lib/keys.js";
import { useMedia } from "../lib/prefs.js";
import { Collapsible, FloatingBar } from "../ui/motion.js";
import { Badge, EmptyState, Fact, Notice, Spinner, Tabs, Tip } from "../ui/primitives.js";
import { BrandIcon } from "./BrandIcon.js";
import { ChangeDialog, RestoreDialog, UndoDialog, WriteDialog, filesOf, type ChangeRequest, type CheckState, type SwitchRequest, type WriteItem, type Written } from "./CapabilityChangeDialog.js";
import { McpInventoryPanel } from "./McpInventoryPanel.js";
import { InstructionsPanel } from "./InstructionsPanel.js";
import { SubagentsPanel } from "./SubagentsPanel.js";
import { SkillTextDialog } from "./SkillTextDialog.js";
import { SkillAddDialog } from "./SkillAddDialog.js";

/** The categories by the Capabilities board's names, wherever a category is named: its list, its tabs, its heading. */
export const KIND_LABEL: Readonly<Record<CapabilityKind, string>> = { skill: "技能", mcp: "MCP 服务器", instructions: "指令", subagent: "子 Agent", command: "命令", hook: "Hooks", plugin: "插件" };
/**
 * The categories in the order of the Capabilities board (ADR-054 §5). Commands, which the board leaves out because the
 * Agents now fold them into skills, are listed last and only while some Agent still has any: a fact is never hidden.
 */
const KIND_ORDER: readonly CapabilityKind[] = ["skill", "mcp", "instructions", "subagent", "plugin", "hook", "command"];
const KIND_ICON: Readonly<Record<CapabilityKind, LucideIcon>> = { skill: BookOpen, mcp: Plug, instructions: ScrollText, subagent: Users, plugin: Puzzle, hook: Webhook, command: SquareSlash };
/** What the first column of a category's matrix names. */
const KIND_HEAD: Readonly<Record<CapabilityKind, string>> = { skill: "技能 · 来源", mcp: "服务器 · 位置", instructions: "指令文件", subagent: "子 Agent · 位置", plugin: "插件 · 来源", hook: "Hook · 位置", command: "命令 · 位置" };
/** One line under a category's title: what it shows, then what the user can do there (results first, ADR-054 F11). */
const KIND_HINT: Readonly<Record<CapabilityKind, string>> = { skill: "各 Harness 读到的技能，以及经由哪里读到。", mcp: "各 Harness 读到的 MCP 服务器；读取时不启动它们。下方的统一清单可以按每家的写法写入。",
  instructions: "各 Harness 读的用户级指令文件。下方可以写一份共享指令，以带标记的区块写进去。", subagent: "各 Harness 读到的子 Agent。下方的统一清单可以按每家的格式写进去。",
  plugin: "各 Harness 装的插件；这里只读。", hook: "各 Harness 在用户级配置里登记的 Hooks；这里只读。", command: "各 Harness 的自定义命令；这里只读。" };
const PICK_HINT = "点格子启用，写入前先给你看改动。";
const MECHANISM_LABEL: Readonly<Record<CapabilityMechanism, string>> = { "native-shared": "共享目录", linked: "链接", "own-copy": "自有目录", "compat-root": "兼容读取", "external-dir": "外加目录",
  plugin: "插件", bundled: "内置", synced: "账户同步", config: "配置" };
const STATUS_LABEL: Readonly<Record<CapabilityStatus, string>> = { active: "生效", disabled: "已停用", shadowed: "被覆盖", duplicate: "重复", rejected: "被跳过", "broken-link": "链接失效", invalid: "无效" };
/** A cell's state in words; "已生效" is the board's word for an entry in use. */
const CELL_STATUS: Readonly<Record<CapabilityStatus, string>> = { ...STATUS_LABEL, active: "已生效" };
const OWNER_LABEL: Readonly<Record<CapabilityOwner, string>> = { user: "用户", harnesshub: "HarnessHub", "skills-cli": "vercel skills", "cc-switch": "cc-switch", magpie: "Magpie", clawhub: "ClawHub",
  "hermes-hub": "Hermes Hub", plugin: "插件", bundled: "随程序安装", synced: "账户同步" };
const CHANGE_LABEL: Readonly<Record<CapabilityChangeView["kind"], string>> = { "skill-switch": "技能开关", "shared-dir": "共享目录", "skill-link": "放置技能", "link-cleanup": "清理链接", "link-undo": "撤销", restore: "恢复",
  "skill-add": "添加技能", "skill-update": "更新技能", "skill-delete": "删除技能", "skill-undo": "撤销", "skill-create": "新建技能", "skill-edit": "编辑技能", "mcp-sync": "写入 MCP", "mcp-remove": "移除 MCP", "mcp-claim": "认领 MCP",
  "instructions-sync": "写入指令", "instructions-remove": "移除指令", "instructions-claim": "认领指令", "subagent-sync": "写入子 Agent", "subagent-remove": "移除子 Agent", "subagent-claim": "认领子 Agent", "plugin-switch": "插件开关" };
type SkillUpdate = SkillUpdateView["skills"][number];
/** A skill folder's name in the shared directory, from where the view shows it. */
function folderName(entry: CapabilityEntry): string | null { return entry.shared ? entry.shared.folder.split("/").filter(Boolean).at(-1) ?? null : null; }
const DRIFT_LABEL: Readonly<Record<CapabilityDriftState, string>> = { removed: "已被外部移除", changed: "已被外部改动", unreadable: "文件无法读取，无法核对" };
const WARNING_LABEL: Readonly<Record<CapabilityWarning["kind"], string>> = { duplicate: "重复", shadow: "遮蔽", cross: "交叉", invisible: "不可见", literal: "明文", redundant: "多余" };
/** Status colors say only what ADR-054 lets them: blue for in use, red for what fails, grey for the rest. */
const STATUS_TONE: Readonly<Record<CapabilityStatus, string>> = { active: "text-accent-text", disabled: "text-fg-3", shadowed: "text-fg-3", duplicate: "text-fg-2", rejected: "text-fg-3", "broken-link": "text-red", invalid: "text-red" };
/** The page switches to its side-by-side layout (category list beside the content) from this width of its own. */
const WIDE_PAGE = 880;
/**
 * The matrix as the board draws it: 70 px per Agent, the names at least 220 px (150 on phones), rows inset 16 px from
 * both sides of the card. The name cell's own padding (16 + 12) and the last column's 16 px inset are on top of those.
 */
const MATRIX_COLUMN = 70, MATRIX_NAME = 220, MATRIX_NAME_NARROW = 150, MATRIX_NAME_PADDING = 28, MATRIX_INSET = 16;

function size(bytes: number): string { return bytes < 1024 ? bytes + " B" : bytes < 1024 * 1024 ? (bytes / 1024).toFixed(1) + " KB" : (bytes / 1024 / 1024).toFixed(1) + " MB"; }
function factsText(facts: CapabilityFacts): string {
  switch (facts.kind) {
    case "skill": return facts.files + " 个文件 · " + size(facts.bytes);
    case "mcp": return [facts.transport === "unknown" ? "传输方式未知" : facts.transport, facts.program, facts.host, facts.variables.length ? "变量 " + facts.variables.join("、") : null,
      facts.headers.length ? "请求头 " + facts.headers.join("、") : null, facts.references ? facts.references + " 处变量引用" : null, facts.literal ? facts.literal + " 处明文值" : null, facts.enabled ? null : "已停用"].filter(Boolean).join(" · ");
    case "instructions": return size(facts.bytes) + (facts.managedBlocks.length ? " · 含 " + facts.managedBlocks.join("、") + " 管理的区块" : "");
    case "subagent": case "command": return facts.format === "toml" ? "TOML" : "Markdown";
    case "hook": return [facts.event, facts.matcher ? "匹配 " + facts.matcher : null, facts.program ? "运行 " + facts.program : null].filter(Boolean).join(" · ");
    case "plugin": return [facts.version || null, facts.enabled === null ? "启停未知" : facts.enabled ? "已启用" : "已停用"].filter(Boolean).join(" · ");
  }
}
/** A column's short name, as the board shows it (Claude, Hermes, DeepSeek): the product name without its generic last word. */
function shortName(name: string): string { return name.replace(/\s+(?:Code|Agent|Harness|CLI)$/u, "") || name; }
/** A repository address as a reader knows it: "owner/repo" for GitHub, the host and path otherwise. */
function repository(source: string): string {
  try {
    const url = new URL(source), path = url.pathname.replace(/^\/+|\/+$/gu, "").replace(/\.git$/u, "");
    return url.hostname === "github.com" || url.hostname === "www.github.com" ? path : url.hostname + (path ? "/" + path : "");
  } catch { return source; }
}
/**
 * Where an entry comes from, in one line (Capabilities board): where it lives (the shared directory, a plugin, an
 * Agent's own place), where it was installed from, and the tool that manages it when that is not the user or HarnessHub.
 */
function sourceLine(entry: CapabilityEntry, harnesses: readonly HarnessCapabilityReads[]): string {
  if (entry.source === LOCAL_SKILL_SOURCE) return "你新建的技能";
  const owner = entry.edges[0] ? harnesses.find(harness => harness.harnessId === entry.edges[0]!.harnessId)?.name ?? null : null;
  const where = entry.kind === "skill" ? entry.shared ? "共享目录" : entry.owner === "plugin" ? (owner ? owner + " 的插件自带" : "插件自带") : entry.owner === "bundled" ? (owner ? owner + " 自带" : "随程序安装")
    : entry.owner === "synced" ? "账户同步" : entry.location : entry.location;
  const origin = entry.source ? repository(entry.source) : entry.kind === "skill" && entry.shared ? "本地" : null;
  const manager = entry.owner === "user" || entry.owner === "harnesshub" || entry.owner === "plugin" || entry.owner === "bundled" || entry.owner === "synced" ? null : OWNER_LABEL[entry.owner] + " 管理";
  // An instructions file is named by its path already.
  return [where, origin, manager].filter(item => item && item !== entry.name).join(" · ");
}

/** One change a selected cell asks for: turning a skill on in an Agent's own switch, placing it by a link, or turning a plugin on. */
type Plan = { readonly kind: "skill-switch"; readonly harnessId: string; readonly name: string; readonly via: string | null; readonly copy: string | null }
  | { readonly kind: "skill-link"; readonly harnessId: string; readonly name: string } | { readonly kind: "plugin-switch"; readonly harnessId: string; readonly id: string };
/** A cell the user picked, with the changes it takes (Codex turns each copy on by its path). */
interface Pick { readonly cell: string; readonly entry: CapabilityEntry; readonly harness: HarnessCapabilityReads; readonly plans: readonly Plan[] }
/** One cell of the matrix: in use, can be turned on (selectable), a state worth its own word, or nothing to show. */
type Cell = { readonly kind: "on"; readonly label: string } | { readonly kind: "open"; readonly label: string; readonly pick: Pick }
  | { readonly kind: "chip"; readonly label: string; readonly text: string; readonly failed: boolean } | { readonly kind: "none"; readonly label: string; readonly glyph: "—" | "?" };
const planId = (plan: Plan): string => JSON.stringify(plan);
const cellKey = (entry: CapabilityEntry, harnessId: string): string => entry.key + "\u0000" + harnessId;
function planTitle(plan: Plan, harnessName: string): string {
  return plan.kind === "skill-switch" ? "启用 " + plan.name + (plan.copy ? "（" + plan.copy + "）" : "") : plan.kind === "skill-link" ? "把 " + plan.name + " 放到 " + harnessName : "启用插件 " + plan.id;
}
/** How one Agent sees one entry, in words: the state and the way, edge by edge where they differ. */
function edgesText(edges: readonly CapabilityEdge[]): string {
  const statuses = new Set(edges.map(edge => edge.status));
  if (statuses.size === 1) return CELL_STATUS[edges[0]!.status] + " · " + [...new Set(edges.map(edge => MECHANISM_LABEL[edge.mechanism]))].join("、");
  return edges.map(edge => CELL_STATUS[edge.status] + " · " + MECHANISM_LABEL[edge.mechanism]).join("；");
}
/**
 * What an Agent can be asked to do so that it uses an entry it does not use now (ADR-045 §4): a skill it has turned off,
 * through its own switch (Codex: each copy by its path); a shared skill Claude Code does not see, by a link of its own;
 * a plugin it has turned off, where HarnessHub can switch plugins. Null when there is nothing to turn on.
 */
function picksOf(entry: CapabilityEntry, harness: HarnessCapabilityReads, edges: readonly CapabilityEdge[]): Pick | null {
  const cell = cellKey(entry, harness.harnessId);
  if (entry.kind === "skill") {
    if (harness.skillSwitch !== null && edges.length && edges.every(edge => edge.status === "disabled")) return { cell, entry, harness,
      plans: harness.harnessId === "codex" ? edges.map(edge => ({ kind: "skill-switch", harnessId: harness.harnessId, name: entry.name, via: edge.via, copy: edges.length > 1 ? MECHANISM_LABEL[edge.mechanism] : null }))
        : [{ kind: "skill-switch", harnessId: harness.harnessId, name: entry.name, via: null, copy: null }] };
    const sees = edges.some(edge => edge.status !== "broken-link" && edge.status !== "invalid");
    if (harness.shared.placeable === "skill-link" && entry.shared && !sees && !entry.shared.placed.some(path => path.includes("/." + harness.harnessId + "/")))
      return { cell, entry, harness, plans: [{ kind: "skill-link", harnessId: harness.harnessId, name: entry.name }] };
  }
  if (entry.kind === "plugin" && harness.pluginSwitch !== null && !edges.some(edge => edge.status === "active")
    && edges.some(edge => edge.facts?.kind === "plugin" && edge.facts.switchable && edge.facts.enabled === false)) return { cell, entry, harness, plans: [{ kind: "plugin-switch", harnessId: harness.harnessId, id: entry.name }] };
  return null;
}
function cellOf(entry: CapabilityEntry, harness: HarnessCapabilityReads): Cell {
  const support = harness.kinds[entry.kind];
  if (support === "unsupported") return { kind: "none", glyph: "—", label: "没有这类能力" };
  if (support === "invisible") return { kind: "none", glyph: "?", label: "保存在磁盘之外，无法读取" };
  const edges = entry.edges.filter(edge => edge.harnessId === harness.harnessId);
  if (edges.some(edge => edge.status === "active")) return { kind: "on", label: edgesText(edges) };
  const pick = picksOf(entry, harness, edges);
  if (pick) return { kind: "open", pick, label: harness.name + "：" + (edges.length ? edgesText(edges) : "看不到") + "，可以启用" };
  if (!edges.length) return { kind: "none", glyph: "—", label: entry.kind === "skill" && entry.shared && harness.shared.placeable === "shared-dir" && harness.shared.reads !== "external-dir"
    ? "不读共享目录；可以在下方“共享技能目录”里让它读取" : "看不到" };
  const status = (["broken-link", "invalid", "duplicate", "shadowed", "rejected", "disabled"] as const).find(item => edges.some(edge => edge.status === item)) ?? "disabled";
  return { kind: "chip", text: CELL_STATUS[status], failed: status === "broken-link" || status === "invalid", label: edgesText(edges) };
}

/** Buttons on an opened entry's grey block: outlined, so they stand out from it; quiet ones darken on hover. */
const DETAIL_BUTTON = "btn btn-outline btn-sm", DETAIL_GHOST = "btn btn-ghost btn-sm hover:bg-hover";
/** A circle of the matrix (28 px), the legend's 18 px, both as the board draws them. */
const CIRCLE = "inline-flex flex-none items-center justify-center rounded-full";
/**
 * The names column stays in place while the matrix scrolls sideways; once it has, a line marks the column's edge. It is
 * the cell's own inset shadow, which moves with the sticky cell (a collapsed border would stay with the table) and is
 * a whole pixel, so it shows at any pixel density.
 */
const NAME_EDGE = "group-data-[scrolled]/matrix:shadow-[inset_-1px_0_0_var(--border-strong)]";
/**
 * One cell. A selectable one is a toggle: picked, its ring turns blue in 120 ms and a plus pops from half size with the
 * overshoot curve in 300 ms while it fades in over 120 ms; unpicked, both go back the same way (Motion board #34). From
 * the keyboard, and with reduced motion, both change at once. The plus is always there, transparent until picked, so it
 * moves only when the choice changes: never again when the row is drawn anew or the motion setting changes. The rest are
 * images named by their state, so the table reads the same to a screen reader as it looks.
 */
function CellMark({ cell, picked, raised, onPick, describedBy }: { readonly cell: Cell; readonly picked: boolean;
  /** On an opened row's grey: fills that are grey themselves take the surface color. */ readonly raised: boolean; readonly onPick: (pick: Pick) => void; readonly describedBy: string }) {
  switch (cell.kind) {
    case "on": return <span role="img" aria-label={cell.label} title={cell.label} className={cn(CIRCLE, "size-7 bg-accent-soft text-accent dark:text-accent-text")}><Check size={14} strokeWidth={2.4} aria-hidden="true"/></span>;
    case "open": return <button type="button" aria-pressed={picked} aria-label={cell.label} aria-describedby={describedBy} title={cell.label} onClick={() => onPick(cell.pick)}
      className={cn(CIRCLE, "capability-cell size-7 p-0 [transition:scale_300ms_var(--ease-overshoot),background-color_120ms_var(--ease-standard),box-shadow_120ms_var(--ease-standard)] active:scale-90 motion-reduce:active:scale-100 keyboard:[transition:none] keyboard:active:scale-100",
        picked ? "bg-surface text-accent-text shadow-[inset_0_0_0_1.5px_var(--accent-text)]" : "bg-transparent shadow-[inset_0_0_0_1px_var(--border-strong)] hover:bg-subtle")}>
      <Plus size={14} strokeWidth={2.4} aria-hidden="true" className={cn("[transition:scale_300ms_var(--ease-overshoot),opacity_120ms_var(--ease-standard)] keyboard:[transition:none]",
        picked ? "scale-100 opacity-100" : "scale-50 opacity-0")}/></button>;
    case "chip": return <span role="img" aria-label={cell.label} title={cell.label} className={cn("inline-flex h-5 items-center rounded-full px-2 text-[11px] leading-4 font-medium whitespace-nowrap", cell.failed ? "bg-red-soft text-red-on-tint" : raised ? "bg-surface text-fg-2 shadow-hairline" : "bg-subtle text-fg-2")}>{cell.text}</span>;
    case "none": return <span role="img" aria-label={cell.label} title={cell.label} className="text-ui-sm text-fg-3">{cell.glyph}</span>;
  }
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
  return <div className="skill-switches flex flex-wrap gap-1.5">{buttons.map(button => <button key={button.harness.harnessId + (button.via ?? "")} type="button" className={DETAIL_BUTTON}
    onClick={() => onSwitch({ harnessId: button.harness.harnessId, harnessName: button.harness.name, name: entry.name, enabled: button.off, via: button.via })}>
    {(button.off ? "在 " + button.harness.name + " 中启用" : "在 " + button.harness.name + " 中停用") + (button.which ? "（" + button.which + "）" : "")}</button>)}</div>;
}
/** Turning one plugin off or on in one Harness's own file. */
interface PluginSwitch { readonly harnessId: string; readonly harnessName: string; readonly id: string; readonly enabled: boolean }
/**
 * The switches of one plugin (ADR-045 step 6a): per Harness HarnessHub can switch it in (Claude Code, Codex), off or back
 * on there. A state the Harness's rules leave unknown (Codex without `enabled`) offers both.
 */
function PluginSwitches({ entry, harnesses, onSwitch }: { readonly entry: CapabilityEntry; readonly harnesses: readonly HarnessCapabilityReads[]; readonly onSwitch: (request: PluginSwitch) => void }) {
  const buttons = entry.edges.flatMap(edge => {
    const harness = harnesses.find(item => item.harnessId === edge.harnessId && item.pluginSwitch !== null);
    if (harness === undefined || edge.facts?.kind !== "plugin" || !edge.facts.switchable) return [];
    return (edge.facts.enabled === null ? [false, true] : [!edge.facts.enabled]).map(enabled => ({ harness, enabled }));
  });
  if (!buttons.length) return null;
  return <div className="plugin-switches flex flex-wrap gap-1.5">{buttons.map(button => <button key={button.harness.harnessId + String(button.enabled)} type="button" className={DETAIL_BUTTON}
    onClick={() => onSwitch({ harnessId: button.harness.harnessId, harnessName: button.harness.name, id: entry.name, enabled: button.enabled })}>
    {"在 " + button.harness.name + (button.enabled ? " 中启用" : " 中停用")}</button>)}</div>;
}
/** Which Harnesses' plugins HarnessHub can switch, and why it only reads the others'. */
function PluginSupport({ harnesses }: { readonly harnesses: readonly HarnessCapabilityReads[] }) {
  const switching = harnesses.filter(harness => harness.pluginSwitch !== null), reading = harnesses.filter(harness => harness.pluginReason !== null);
  return <section className="plugin-support card px-4 py-3.5 text-ui-sm" aria-label="插件开关">
    <h3 className="m-0 text-ui font-semibold">插件开关</h3>
    <p className="m-0 mt-1 text-fg-2">{switching.length ? switching.map(harness => harness.name).join("、") + " 的插件可以在这里停用或启用：点空着的格子启用，展开插件可以停用；都先显示要改的那一行，确认后才写入，并保留备份。" : "这里列出的插件都只读。"}
      <span className="text-fg-3">安装与卸载还没有提供。</span></p>
    {reading.length ? <ul className="m-0 mt-2 flex list-none flex-col gap-1 p-0 text-caption text-fg-2">{reading.map(harness => <li key={harness.harnessId}><span className="font-medium text-fg">{harness.name}</span>：{harness.pluginReason}</li>)}</ul> : null}
  </section>;
}
/** Placing a shared skill in Claude Code by a link of its own, or removing a link HarnessHub placed there. */
function ClaudePlacement({ api, entry, harnesses, onChange }: { readonly api: GatewayApi; readonly entry: CapabilityEntry; readonly harnesses: readonly HarnessCapabilityReads[]; readonly onChange: (request: ChangeRequest) => void }) {
  const claude = harnesses.find(harness => harness.harnessId === "claude" && harness.shared.placeable === "skill-link");
  if (!claude || !entry.shared) return null;
  const sees = entry.edges.some(edge => edge.harnessId === "claude" && edge.status !== "broken-link" && edge.status !== "invalid");
  const placed = entry.shared.placed.find(path => path.startsWith("~/.claude/") || path.includes("/.claude/"));
  if (placed) return <button type="button" className={DETAIL_BUTTON} onClick={() => onChange({ title: "从 " + claude.name + " 移除 " + entry.name, verb: "移除", on: null, done: "已从 " + claude.name + " 移除 " + entry.name,
    load: () => api.checkSkillLink("claude", entry.name, false) })}>从 {claude.name} 移除（HarnessHub 放置的）</button>;
  if (sees) return null;
  return <button type="button" className={DETAIL_BUTTON} onClick={() => onChange({ title: "把 " + entry.name + " 放到 " + claude.name, verb: "放置", on: null, done: "已把 " + entry.name + " 放到 " + claude.name,
    load: () => api.checkSkillLink("claude", entry.name, true) })}>放到 {claude.name}</button>;
}
/**
 * Updating a shared skill from its source, when a newer version is known, and deleting it from the shared directory; both
 * go through the usual confirmation, which keeps a snapshot of the folder first.
 */
function SkillLifecycle({ api, entry, update, onChange, onEdit }: { readonly api: GatewayApi; readonly entry: CapabilityEntry; readonly update: SkillUpdate | undefined; readonly onChange: (request: ChangeRequest) => void;
  readonly onEdit: (name: string) => void }) {
  const folder = folderName(entry);
  if (folder === null) return null;
  return <>
    {entry.owner === "harnesshub" && entry.source === LOCAL_SKILL_SOURCE ? <button type="button" className={DETAIL_BUTTON} onClick={() => onEdit(folder)}><Pencil size={13}/>编辑</button> : null}
    {update?.state === "available" ? <button type="button" className={DETAIL_BUTTON} onClick={() => onChange({ title: "更新 " + folder, verb: "更新", on: null, icon: "update", done: "已更新 " + folder, load: () => api.checkSkillUpdate(folder, false) })}>
      <RefreshCw size={13}/>更新</button> : null}
    {update?.state === "available" && update.modified !== false ? <button type="button" className={DETAIL_GHOST} onClick={() => onChange({ title: "覆盖本地改动并更新 " + folder, verb: "覆盖并更新", on: null, icon: "update",
      done: "已更新 " + folder, load: () => api.checkSkillUpdate(folder, true) })}>覆盖本地改动并更新</button> : null}
    <button type="button" className={DETAIL_GHOST} onClick={() => onChange({ title: "删除 " + folder, verb: "删除", on: null, icon: "delete", done: "已删除 " + folder, load: () => api.checkSkillDelete(folder) })}><Trash2 size={13}/>删除</button>
  </>;
}
/** An entry opened under its row: its facts, how each Agent sees it and why, the warnings, and what can be changed (each through its check). */
function EntryDetail({ api, entry, harnesses, update, onSwitch, onPlugin, onChange, onEdit }: { readonly api: GatewayApi; readonly entry: CapabilityEntry; readonly harnesses: readonly HarnessCapabilityReads[]; readonly update: SkillUpdate | undefined;
  readonly onSwitch: (request: SwitchRequest) => void; readonly onPlugin: (request: PluginSwitch) => void; readonly onChange: (request: ChangeRequest) => void; readonly onEdit: (name: string) => void }) {
  const name = (id: string | null) => id === null ? null : harnesses.find(harness => harness.harnessId === id)?.name ?? id;
  const switches = entry.kind === "skill" ? <><SkillSwitches entry={entry} harnesses={harnesses} onSwitch={onSwitch}/><ClaudePlacement api={api} entry={entry} harnesses={harnesses} onChange={onChange}/>
    <SkillLifecycle api={api} entry={entry} update={update} onChange={onChange} onEdit={onEdit}/></> : entry.kind === "plugin" ? <PluginSwitches entry={entry} harnesses={harnesses} onSwitch={onPlugin}/> : null;
  return <div className="capability-detail flex flex-col gap-3 px-4 pt-1 pb-4 text-ui-sm">
    {entry.description ? <p className="m-0 max-w-reading text-fg-2">{entry.description}</p> : null}
    <dl className="m-0 grid grid-cols-[56px_minmax(0,1fr)] gap-x-3 gap-y-1 text-caption">
      {entry.location ? <Fact label="位置"><code className="break-all">{entry.location}</code></Fact> : null}
      <Fact label="归属">{OWNER_LABEL[entry.owner]}{entry.source ? <span className="text-fg-3"> · 来源 <span className="break-all">{entry.source}</span></span> : null}</Fact>
      {update ? <Fact label="更新">{UPDATE_LABEL[update.state]}{update.modified ? "；本地改过" : ""}{update.reason ? <span className="text-fg-3"> · {update.reason}</span> : null}</Fact> : null}
      {entry.facts && entry.kind !== "plugin" ? <Fact label="内容">{factsText(entry.facts)}</Fact> : null}
    </dl>
    {entry.edges.length ? <ul className="m-0 flex list-none flex-col overflow-hidden rounded-block bg-surface p-0 shadow-[inset_0_0_0_1px_var(--border)]">{entry.edges.map((edge, index) =>
      <li key={index} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-3 py-2 [&+&]:hairline-t">
        <strong className="font-medium">{name(edge.harnessId)}</strong><span className={STATUS_TONE[edge.status]}>{STATUS_LABEL[edge.status]}</span><span className="text-fg-3">{MECHANISM_LABEL[edge.mechanism]}</span>
        <code className="min-w-0 text-caption break-all text-fg-2">{edge.via}</code>{edge.reason ? <span className="w-full text-fg-2">{edge.reason}</span> : null}
        {edge.facts && (entry.kind === "mcp" || entry.kind === "plugin") ? <span className="w-full text-fg-3">{factsText(edge.facts)}</span> : null}</li>)}</ul> : null}
    {entry.warnings.length ? <ul className="m-0 flex list-none flex-col gap-1.5 p-0">{entry.warnings.map((warning, index) => <li key={index} className="flex items-start gap-2">
      <Badge tone={warning.kind === "literal" ? "amber" : "neutral"} className={cn("flex-none", warning.kind !== "literal" && "bg-surface shadow-hairline")}>{WARNING_LABEL[warning.kind]}</Badge><span className="text-fg-2">{warning.text}</span></li>)}</ul> : null}
    {switches ? <div className="flex flex-wrap gap-1.5">{switches}</div> : null}
  </div>;
}
const READS: Readonly<Record<HarnessCapabilityReads["shared"]["reads"], string>> = { native: "自己读取", "external-dir": "经 skills.external_dirs 读取", links: "经自己目录里的链接", no: "不读取" };
const UPDATE_LABEL: Readonly<Record<SkillUpdate["state"], string>> = { current: "已是最新", available: "有新版本", gone: "仓库里已没有", unknown: "无法检查", unsupported: "HarnessHub 不更新这类来源" };
/**
 * How each Harness reads the shared `~/.agents/skills`, with what HarnessHub can change: make Hermes read it, place single
 * skills in Claude Code, and remove the links a Harness no longer needs; and whether skills with a known source have newer versions.
 */
function SharedDirectory({ api, harnesses, updates, checking, updateProblem, onAdd, onCheckUpdates, onChange }: { readonly api: GatewayApi; readonly harnesses: readonly HarnessCapabilityReads[];
  readonly updates: SkillUpdateView | null; readonly checking: boolean; readonly updateProblem: string | null; readonly onAdd: () => void; readonly onCheckUpdates: () => void; readonly onChange: (request: ChangeRequest) => void }) {
  const available = updates?.skills.filter(item => item.state === "available").length ?? 0, unknown = updates?.skills.filter(item => item.state === "unknown").length ?? 0;
  return <section className="shared-directory card px-4 py-3.5 text-ui-sm" aria-label="共享技能目录">
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
      <div className="flex min-w-0 flex-col gap-0.5"><h3 className="m-0 text-ui font-semibold">共享技能目录 <code className="text-caption font-normal text-fg-2">~/.agents/skills</code></h3>
        <span className="text-caption text-fg-3">技能放在这里一份，各 Harness 按自己的方式读取。</span></div>
      <span className="flex flex-wrap gap-1.5"><button type="button" className="btn btn-sm" onClick={onAdd}><Download size={13}/>从 GitHub 添加技能</button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={checking} onClick={onCheckUpdates}>{checking ? <Spinner size={13} label=""/> : <RefreshCw size={13}/>}检查更新</button></span>
    </div>
    {updates || updateProblem ? <p className="m-0 mt-2 text-caption">
      {updates ? <span className="skill-update-summary text-fg-2">{available ? available + " 个技能有新版本（展开后更新）" : "已知来源的技能都是最新的"}{unknown ? "；" + unknown + " 个无法检查" : ""} · 检查于 {new Date(updates.checkedAt).toLocaleTimeString()}</span> : null}
      {updateProblem ? <span className="text-red">{updateProblem}</span> : null}</p> : null}
    <ul className="m-0 mt-3 flex list-none flex-col p-0">{harnesses.map(harness => <li key={harness.harnessId} className="flex flex-wrap items-center gap-x-2.5 gap-y-1 py-2 [&+&]:hairline-t">
      <BrandIcon brand={harness.harnessId} name={harness.name} size={18}/>
      <span className="min-w-[96px] font-medium">{harness.name}</span><span className="min-w-0 flex-1 text-fg-2">{READS[harness.shared.reads]}{harness.shared.links ? "；自己目录里有 " + harness.shared.links + " 个指向它的链接" + (harness.shared.redundant ? "，其中 " + harness.shared.redundant + " 个多余" : "") : ""}</span>
      {harness.shared.placeable === "shared-dir" ? harness.shared.reads === "external-dir"
        ? <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange({ title: "让 " + harness.name + " 停止读取共享目录", verb: "停止读取", on: false, done: harness.name + " 已停止读取共享目录", load: () => api.checkSharedDir(harness.harnessId, false) })}>停止读取</button>
        : <button type="button" className="btn btn-sm" onClick={() => onChange({ title: "让 " + harness.name + " 读取共享目录", verb: "读取", on: true, done: harness.name + " 已读取共享目录", load: () => api.checkSharedDir(harness.harnessId, true) })}>让 {harness.name} 读取共享目录</button>
        : harness.shared.placeable === "skill-link" ? <span className="text-caption text-fg-3">逐个放置：在上方表格里点它的空格</span> : null}
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
    <ul className="m-0 mt-2 flex list-none flex-col gap-1.5 p-0">{drift.map(item => <li key={item.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-fg">
      <strong className="font-medium">{harnesses.find(harness => harness.harnessId === item.harnessId)?.name ?? item.harnessId} · {item.kind === "mcp" ? "MCP" : item.kind === "instructions" ? "指令区块" : item.kind === "subagent" ? "子 Agent" : item.kind === "plugin" ? "插件" : CHANGE_LABEL[item.kind]} · {item.subject}</strong>
      <Badge tone="amber">{item.kind === "mcp" && item.harnessId === "claude" && item.state === "removed" ? "写入丢失（可能被运行中的 Claude Code 会话冲掉）" : DRIFT_LABEL[item.state]}</Badge><code className="text-caption break-all text-fg-2">{item.file}</code>
      <span className="flex gap-1.5"><button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => onChange({ title: "重新应用：" + item.subject, verb: "重新应用", on: item.kind === "skill-switch" ? false : item.kind === "shared-dir" ? true : null,
        done: "已重新应用：" + item.subject, load: () => api.checkReapply(item.id) })}>重新应用</button>
      <button type="button" className="btn btn-ghost btn-sm" disabled={busy !== null} title="HarnessHub 不再把它算作自己写的；文件不变" onClick={() => forget(item.id)}>{busy === item.id ? <Spinner size={13} label=""/> : null}不再跟踪</button></span>
    </li>)}</ul>
    {failure ? <p className="m-0 mt-1 text-red">{failure}</p> : null}
  </Notice>;
}
/**
 * Switch settings HarnessHub wrote for skills their Harness no longer has (usually deleted): they do nothing now and take
 * effect again if a skill of that name comes back. Each can be cleared through the usual switch check.
 */
function OrphanNotice({ api, orphans, harnesses, onChange }: { readonly api: GatewayApi; readonly orphans: readonly CapabilityOrphan[]; readonly harnesses: readonly HarnessCapabilityReads[]; readonly onChange: (request: ChangeRequest) => void }) {
  const skills = orphans.some(item => item.kind === "skill"), plugins = orphans.some(item => item.kind === "plugin");
  return <Notice tone="neutral" className="capability-orphans" title={"孤立的停用设置（" + (skills && plugins ? "技能已删除或插件已卸载" : plugins ? "插件已卸载" : "技能已删除") + "）" + orphans.length + " 项"}>
    <p className="m-0">{skills && plugins ? "HarnessHub 写的这些停用设置还在，技能已经不在或插件已经卸载：现在不起作用，以后再出现同名的技能或插件时会再次生效。"
      : plugins ? "HarnessHub 为这些插件写的停用设置还在，插件已经卸载：现在不起作用，以后再装同名插件时会再次生效。" : "HarnessHub 为这些技能写的停用设置还在，技能已经不在了：现在不起作用，以后添加同名技能时会再次生效。"}</p>
    <ul className="m-0 mt-2 flex list-none flex-col gap-1.5 p-0">{orphans.map(item => <li key={item.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-fg">
      <strong className="font-medium">{harnesses.find(harness => harness.harnessId === item.harnessId)?.name ?? item.harnessId} · {skills && plugins ? (item.kind === "plugin" ? "插件 · " : "技能 · ") : ""}{item.subject}</strong><code className="text-caption break-all text-fg-2">{item.file}</code>
      <button type="button" className="btn btn-sm" onClick={() => onChange({ title: "清除停用设置：" + item.subject, verb: "清除", on: true, done: "已清除 " + item.subject + " 的停用设置", load: () => api.checkOrphanClear(item.id) })}>清除</button>
    </li>)}</ul>
  </Notice>;
}
/** A section that opens in place on the page: a card whose title row is the native disclosure. */
const DISCLOSURE = "card group/more text-ui-sm [&>summary]:flex [&>summary]:cursor-pointer [&>summary]:list-none [&>summary]:items-center [&>summary]:gap-2 [&>summary]:rounded-card [&>summary]:px-4 [&>summary]:py-3 [&>summary::-webkit-details-marker]:hidden [&>summary]:outline-offset-[-2px]";
function DisclosureChevron() { return <ChevronRight size={15} aria-hidden="true" className="motion-rotate flex-none text-fg-3 group-open/more:rotate-90"/>; }
/** HarnessHub's own changes to the Harnesses' files, newest first, and the backups it keeps (the newest ten per file). */
function ChangeHistory({ api, history, onRestore, onChange }: { readonly api: GatewayApi; readonly history: CapabilityHistory; readonly onRestore: (backupId: string) => void; readonly onChange: (request: ChangeRequest) => void }) {
  return <details className={cn("capability-history", DISCLOSURE)}><summary><DisclosureChevron/><History size={15} className="flex-none text-fg-3" aria-hidden="true"/><span className="font-medium">修改与备份</span>
    <span className="min-w-0 trunc text-caption text-fg-3">{history.changes.length} 次修改 · {history.backups.length} 份备份{history.snapshots.count ? " · " + history.snapshots.count + " 份技能快照（" + size(history.snapshots.bytes) + "）" : ""}</span></summary>
    <div className="flex flex-col gap-2 px-4 pb-4">
      <p className="m-0 text-caption text-fg-3">技能的添加、更新和删除会先存快照；只保留最近 {history.snapshots.keep} 次修改用到的快照，更早的修改无法撤销。</p>
      {history.changes.length === 0 ? <p className="m-0 text-fg-3">HarnessHub 还没有改过任何 Harness 的配置。</p> : <ul className="m-0 flex list-none flex-col overflow-hidden rounded-block p-0 shadow-[inset_0_0_0_1px_var(--border)]">{history.changes.map(change =>
        <li key={change.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 [&+&]:hairline-t">
          <span className="text-caption text-fg-3">{new Date(change.at).toLocaleString()}</span><strong className="font-medium">{CHANGE_LABEL[change.kind]} · {change.subject}</strong>
          <Badge tone={change.status === "applied" ? "accent" : "red"}>{change.status === "applied" ? "已完成" : "失败"}</Badge><code className="min-w-0 text-caption break-all text-fg-2">{change.file}</code>
          {change.links?.length ? <span className="text-caption text-fg-3">{change.links.filter(link => link.action === "create").length ? "新建 " + change.links.filter(link => link.action === "create").length + " 个链接 " : ""}{change.links.filter(link => link.action === "remove").length ? "删除 " + change.links.filter(link => link.action === "remove").length + " 个链接" : ""}</span> : null}
          {change.skills?.length ? <span className="text-caption text-fg-3">{change.skills.length} 个技能文件夹</span> : null}
          {(change.links?.length && change.kind !== "skill-undo") || ((change.kind === "skill-add" || change.kind === "skill-update" || change.kind === "skill-delete" || change.kind === "skill-create" || change.kind === "skill-edit") && change.status === "applied")
            ? <button type="button" className="btn btn-ghost btn-sm ml-auto" onClick={() => onChange({ title: "撤销：" + change.subject, verb: "撤销", on: null, icon: "undo", done: "已撤销：" + change.subject, load: () => api.checkUndo(change.id) })}><RotateCcw size={13}/>撤销</button> : null}
          {change.error ? <span className="w-full text-red">{change.error.message}</span> : null}</li>)}</ul>}
      {history.backups.length ? <><p className="m-0 mt-1 font-medium">备份</p><ul className="m-0 flex list-none flex-col overflow-hidden rounded-block p-0 shadow-[inset_0_0_0_1px_var(--border)]">{history.backups.map(backup =>
        <li key={backup.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 [&+&]:hairline-t"><code className="min-w-0 text-caption break-all">{backup.file}</code><span className="text-caption text-fg-3">{new Date(backup.createdAt).toLocaleString()} · {backup.subject} 之前</span>
          <span className="flex-1"/><button type="button" className="btn btn-ghost btn-sm" onClick={() => onRestore(backup.id)}><RotateCcw size={13}/>恢复</button></li>)}</ul></> : null}
    </div>
  </details>;
}

/** The categories as the board's list beside the content: arrow keys, Home and End move and choose (automatic activation). */
function KindNav({ kinds, value, counts, onChange }: { readonly kinds: readonly CapabilityKind[]; readonly value: CapabilityKind; readonly counts: Readonly<Record<CapabilityKind, number>>; readonly onChange: (kind: CapabilityKind) => void }) {
  const list = useRef<HTMLDivElement>(null);
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    const index = kinds.indexOf(value), step = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 0;
    const next = event.key === "Home" ? kinds[0] : event.key === "End" ? kinds.at(-1) : step !== 0 ? kinds[(Math.max(index, 0) + step + kinds.length) % kinds.length] : undefined;
    if (next === undefined) return;
    event.preventDefault(); onChange(next); list.current?.querySelector<HTMLElement>(`[data-key="${next}"]`)?.focus();
  };
  return <div ref={list} role="tablist" aria-label="能力类别" aria-orientation="vertical" className="flex flex-col gap-0.5" onKeyDown={move}>
    {kinds.map(item => { const Icon = KIND_ICON[item], selected = item === value;
      return <button key={item} type="button" role="tab" id={"capability-tab-" + item} data-key={item} aria-selected={selected} aria-controls="capability-tabpanel" tabIndex={selected ? 0 : -1}
        data-selected={selected} className={cn("nav-row w-full text-ui-sm", selected ? "text-fg" : "text-fg-2 hover:bg-subtle")} onClick={() => onChange(item)}>
        <Icon size={16} aria-hidden="true" className={selected ? "text-accent dark:text-accent-text" : "text-fg-3"}/>
        <span className="min-w-0 flex-1 trunc">{KIND_LABEL[item]}</span><span className="text-caption font-normal text-fg-3">{counts[item]}</span>
      </button>; })}
  </div>;
}
/** The inner width an element has now, following resizes; null while it is not mounted or not yet measured (before the first paint). */
function useWidth(node: HTMLElement | null): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!node) { setWidth(null); return; }
    const measure = () => setWidth(node.clientWidth); measure();
    const observer = new ResizeObserver(measure); observer.observe(node);
    return () => observer.disconnect();
  }, [node]);
  return width;
}

/**
 * One entry's row and, while it is open, the row of its details. The details open in 200 ms, height and fade on the
 * expand curve (Motion board #13), and close at once, so that what is gone can no longer be clicked or read.
 */
function MatrixRow({ entry, columns, expanded, onToggle, badges, source, picked, onPick, frame, children }: {
  readonly entry: CapabilityEntry; readonly columns: readonly HarnessCapabilityReads[]; readonly expanded: boolean; readonly onToggle: () => void; readonly badges: (expanded: boolean) => ReactNode; readonly source: string;
  readonly picked: ReadonlySet<string>; readonly onPick: (pick: Pick) => void; readonly frame: number | null; readonly children: ReactNode;
}) {
  const header = useId(), shown = expanded;
  return <>
    <tr className={shown ? "bg-subtle" : "hairline-b"}>
      <th scope="row" id={header} className={cn("sticky left-0 z-[1] h-[68px] py-1.5 pr-3 pl-4 text-left font-normal", NAME_EDGE, shown ? "bg-subtle" : "bg-surface")}>
        <button type="button" className="group/name flex w-full min-w-0 flex-col items-start gap-px border-0 bg-transparent p-0 text-left" aria-expanded={expanded} onClick={onToggle}>
          <span className="flex max-w-full min-w-0 items-center gap-2"><span className="min-w-0 trunc font-mono text-code font-medium">{entry.name}</span>{badges(shown)}
            <ChevronRight size={14} aria-hidden="true" className={cn("motion-rotate flex-none text-fg-3", expanded ? "rotate-90" : "opacity-0 group-hover/name:opacity-100 group-focus-visible/name:opacity-100")}/></span>
          <span className="max-w-full trunc text-caption leading-5 text-fg-3">{source}</span>
        </button>
      </th>
      {columns.map((harness, index) => { const cell = cellOf(entry, harness);
        return <td key={harness.harnessId} className={cn("h-[68px] p-0 text-center", index === columns.length - 1 && "pr-4")}><span className="flex items-center justify-center">
          <CellMark cell={cell} picked={cell.kind === "open" && picked.has(cell.pick.cell)} raised={shown} onPick={onPick} describedBy={header}/></span></td>; })}
    </tr>
    {shown ? <tr className="capability-detail-row hairline-b bg-subtle"><td colSpan={columns.length + 1} className="p-0">
      <Collapsible open className="starting:grid-rows-[0fr] starting:opacity-0"><div className="sticky left-0" style={frame === null ? undefined : { width: frame }}>{children}</div></Collapsible>
    </td></tr> : null}
  </>;
}

/**
 * The capability page (ADR-045, ADR-054 §5, the Capabilities board): what each installed Agent reads besides its model,
 * per category as an entry × Agent matrix. A cell says whether the Agent uses the entry, can turn it on, or does not read
 * it. Picking empty cells raises a bar that counts them and the files they change; "预览写入" shows every file's lines
 * before anything is written, and a written batch can be undone. Other changes go through their own confirmation.
 */
export function CapabilitiesPage({ api, initialHarness, hidden, onMenu, sidebarHidden, onExpandSidebar }: {
  readonly api: GatewayApi; readonly initialHarness: string | null;
  /** The Harnesses the columns, the Harness list and the per-Harness notes leave out (ADR-050): frozen ones unless shown. */
  readonly hidden: ReadonlySet<string>;
  readonly onMenu: () => void; readonly sidebarHidden: boolean; readonly onExpandSidebar: () => void;
  /** Kept for the shell's page props; the sidebar is the way back to a conversation (Capabilities board). */
  readonly onChat: () => void;
}) {
  const [view, setView] = useState<CapabilitiesView | null>(null), [loading, setLoading] = useState(true), [problem, setProblem] = useState<string | null>(null);
  const [kind, setKind] = useState<CapabilityKind>("skill"), [harness, setHarness] = useState<string | null>(initialHarness), [query, setQuery] = useState(""), [onlyWarnings, setOnlyWarnings] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [changing, setChanging] = useState<ChangeRequest | null>(null), [restoring, setRestoring] = useState<string | null>(null), [history, setHistory] = useState<CapabilityHistory | null>(null);
  const change = (request: ChangeRequest) => setChanging(request);
  const switchSkill = (request: SwitchRequest) => change({ title: "在 " + request.harnessName + " 中" + (request.enabled ? "启用 " : "停用 ") + request.name, verb: request.enabled ? "启用" : "停用", on: request.enabled,
    done: "已在 " + request.harnessName + " 中" + (request.enabled ? "启用 " : "停用 ") + request.name, load: () => api.checkSkillSwitch(request.harnessId, request.name, request.enabled, request.via) });
  const switchPlugin = (request: PluginSwitch) => change({ title: "在 " + request.harnessName + " 中" + (request.enabled ? "启用插件 " : "停用插件 ") + request.id, verb: request.enabled ? "启用" : "停用", on: request.enabled,
    done: "已在 " + request.harnessName + " 中" + (request.enabled ? "启用 " : "停用 ") + request.id, load: () => api.checkPluginSwitch(request.harnessId, request.id, request.enabled) });
  type Result = { readonly kind: "one"; readonly view: CapabilityChangeView; readonly title: string } | { readonly kind: "batch"; readonly written: readonly Written[] } | { readonly kind: "undo"; readonly views: readonly CapabilityChangeView[]; readonly failure: string | null };
  const [result, setResult] = useState<Result | null>(null);
  const [adding, setAdding] = useState(false), [updates, setUpdates] = useState<SkillUpdateView | null>(null), [checkingUpdates, setCheckingUpdates] = useState(false), [updateProblem, setUpdateProblem] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0), [notice, setNotice] = useState<{ readonly text: string; readonly failed: boolean } | null>(null);
  // A skill written from text: new (`name` null) or one HarnessHub wrote, opened with its texts as they are now.
  const [writing, setWriting] = useState<{ readonly name: string | null; readonly text: SkillTextView } | null>(null);
  const editSkill = (name: string) => api.skillText(name).then(text => text === null ? setNotice({ text: name + " 的 SKILL.md 读不出说明和正文，没法在这里编辑。", failed: true }) : setWriting({ name, text }),
    error => setNotice({ text: errorMessage(error), failed: true }));
  const writeSkill = (name: string, text: SkillTextView) => {
    const creating = writing?.name === null;
    setWriting(null);
    change(creating ? { title: "新建技能 " + name, verb: "新建", on: null, icon: "add", done: "已新建技能 " + name, load: () => api.checkSkillCreate(name, text) }
      : { title: "编辑技能 " + name, verb: "改写", on: null, icon: "update", done: "已改写技能 " + name, load: options => api.checkSkillEdit(name, text, options.includes("overwrite")) });
  };
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

  // The cells picked for writing (Capabilities board) and the check prepared for each of their changes. A change is
  // prepared once, as soon as its cell is picked, so the bar can say how many files a write changes; whatever writes a
  // file drops every prepared check (they were read before it), and the picked changes are prepared again.
  const [picked, setPicked] = useState<ReadonlyMap<string, Pick>>(new Map()), [checks, setChecks] = useState<ReadonlyMap<string, CheckState>>(new Map());
  const [previewing, setPreviewing] = useState(false), [batch, setBatch] = useState<readonly Written[] | null>(null), [undoing, setUndoing] = useState<readonly Written[] | null>(null);
  // Each change being prepared holds a token; forgetting the checks drops the tokens, so an answer read before a write never lands.
  const preparing = useRef(new Map<string, number>()), generation = useRef(0), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const loadPlan = useCallback((plan: Plan) => plan.kind === "skill-switch" ? api.checkSkillSwitch(plan.harnessId, plan.name, true, plan.via)
    : plan.kind === "skill-link" ? api.checkSkillLink(plan.harnessId, plan.name, true) : api.checkPluginSwitch(plan.harnessId, plan.id, true), [api]);
  const setCheck = useCallback((id: string, state: CheckState) => setChecks(current => new Map(current).set(id, state)), []);
  const forgetChecks = () => { preparing.current.clear(); setChecks(new Map()); };
  useEffect(() => {
    for (const pick of picked.values()) for (const plan of pick.plans) {
      const id = planId(plan);
      if (checks.has(id) || preparing.current.has(id)) continue;
      const token = ++generation.current;
      preparing.current.set(id, token);
      setCheck(id, { state: "loading" });
      const settle = (state: CheckState) => {
        if (preparing.current.get(id) !== token || !mounted.current) return;
        preparing.current.delete(id); setChecks(current => current.has(id) ? new Map(current).set(id, state) : current);
      };
      loadPlan(plan).then(check => settle({ state: "ready", check }), error => settle({ state: "failed", message: errorMessage(error) }));
    }
  }, [picked, checks, loadPlan, setCheck]);
  // A new reading of the Agents keeps a picked cell only while it can still be turned on.
  useEffect(() => {
    if (view === null) return;
    setPicked(current => {
      if (!current.size) return current;
      const next = new Map<string, Pick>();
      for (const [key, pick] of current) {
        const entry = view.entries.find(item => item.key === pick.entry.key), reads = view.harnesses.find(item => item.harnessId === pick.harness.harnessId);
        const cell = entry && reads ? cellOf(entry, reads) : null;
        if (cell?.kind === "open") next.set(key, cell.pick);
      }
      return next;
    });
  }, [view]);
  // When what had the focus goes away with the bar (清除, 写入, 撤销), the focus moves on instead of falling to the page.
  const heading = useRef<HTMLHeadingElement>(null), undoButton = useRef<HTMLButtonElement>(null), previewButton = useRef<HTMLButtonElement>(null), rescue = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keepFocus = (target: () => HTMLElement | null) => {
    if (rescue.current) clearTimeout(rescue.current);
    // After the bar and the dialog have left (200 ms each); only if the focus was lost, so a pointer elsewhere keeps its place.
    // A target that cannot take the focus now (gone, or disabled while its check is prepared again) leaves it to the heading.
    rescue.current = setTimeout(() => {
      rescue.current = null; const active = document.activeElement;
      if (active !== null && active !== document.body) return;
      const wanted = target(); (wanted !== null && !wanted.matches(":disabled") ? wanted : heading.current)?.focus({ preventScroll: true });
    }, 260);
  };
  useEffect(() => () => { if (rescue.current) clearTimeout(rescue.current); }, []);
  const togglePick = (pick: Pick) => { setBatch(null); setPicked(current => { const next = new Map(current); if (next.has(pick.cell)) next.delete(pick.cell); else next.set(pick.cell, pick); return next; }); };
  const items = useMemo((): readonly WriteItem[] => [...picked.values()].flatMap(pick => pick.plans.map(plan => ({ id: planId(plan), title: planTitle(plan, pick.harness.name), harnessId: pick.harness.harnessId,
    harnessName: pick.harness.name, load: () => loadPlan(plan), check: checks.get(planId(plan)) ?? { state: "loading" } }))), [picked, checks, loadPlan]);
  const files = filesOf(items), waiting = items.some(item => item.check.state === "loading");
  const refused = [...picked.values()].filter(pick => pick.plans.every(plan => { const state = checks.get(planId(plan)); return state?.state === "failed" || (state?.state === "ready" && state.check.blocked !== null); })).length;
  const preview = () => {
    // A check that would expire within a minute is prepared again before it is shown.
    const soon = Date.now() + 60_000;
    setChecks(current => new Map([...current].filter(([, state]) => state.state !== "ready" || Date.parse(state.check.expiresAt) > soon)));
    setPreviewing(true);
  };
  const reread = () => { forgetChecks(); load(); loadHistory(); setReloads(value => value + 1); };
  const finished = (changed: CapabilityChangeView, title: string) => {
    setChanging(null); setRestoring(null); setResult({ kind: "one", view: changed, title }); reread();
    // A change of skill folders makes the known update states stale.
    if (changed.skills?.length) setUpdates(null);
  };
  const wrote = (written: readonly Written[], complete: boolean) => {
    setPreviewing(false);
    // Closed without writing: the bar is back, and so is the focus, on its 预览写入 (the one that opened the preview left with the bar).
    if (!written.length) { keepFocus(() => previewButton.current); return; }
    // Only what the Gateway wrote leaves the selection; a change it could not complete stays picked, ready to try again.
    const done = new Set(written.filter(item => item.view.status === "applied").map(item => item.id));
    setPicked(current => complete ? new Map() : new Map([...current].filter(([, pick]) => !pick.plans.every(plan => done.has(planId(plan))))));
    setBatch(written); setResult({ kind: "batch", written }); reread(); keepFocus(() => undoButton.current ?? previewButton.current);
  };
  const undone = (views: readonly CapabilityChangeView[], failure: string | null) => { setUndoing(null); setBatch(null); setResult({ kind: "undo", views, failure }); reread(); keepFocus(() => heading.current); };
  useEffect(() => setHarness(initialHarness), [initialHarness]);

  // The Harnesses this page lists (ADR-050): hidden ones stay out unless the page is on one of them. Entries only they
  // see stay out with them; an entry no Harness sees stays in. Details and notices still name every Harness.
  const away = useMemo(() => new Set([...hidden].filter(id => id !== harness)), [hidden, harness]);
  const shown = useMemo(() => view?.harnesses.filter(item => !away.has(item.harnessId)) ?? [], [view, away]);
  const columns = useMemo(() => shown.filter(item => harness === null || item.harnessId === harness), [shown, harness]);
  const listed = useMemo(() => (view?.entries ?? []).filter(entry => !entry.edges.length || entry.edges.some(edge => !away.has(edge.harnessId))), [view, away]);
  const counts = useMemo(() => Object.fromEntries(KIND_ORDER.map(item => [item, listed.filter(entry => entry.kind === item && (harness === null || entry.edges.some(edge => edge.harnessId === harness))).length])) as Record<CapabilityKind, number>, [listed, harness]);
  const kinds = useMemo(() => KIND_ORDER.filter(item => item !== "command" || counts.command > 0 || kind === "command"), [counts, kind]);
  const rows = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return listed.filter(entry => entry.kind === kind && (harness === null || entry.edges.some(edge => edge.harnessId === harness))
      && (!onlyWarnings || entry.warnings.some(warning => harness === null || warning.harnessId === null || warning.harnessId === harness) || entry.edges.some(edge => edge.status !== "active"))
      && (!needle || [entry.name, entry.description ?? "", entry.location ?? ""].some(value => value.toLocaleLowerCase().includes(needle))));
  }, [listed, kind, harness, query, onlyWarnings]);
  const warningCount = (entry: CapabilityEntry) => entry.warnings.filter(warning => harness === null || warning.harnessId === null || warning.harnessId === harness).length;
  const choose = (next: CapabilityKind) => { setKind(next); setOpen(null); };
  // The marks the matrix shows now ("—" and "?" apart), so the key under it explains exactly those.
  const states = useMemo(() => new Set(rows.flatMap(entry => columns.map(item => { const cell = cellOf(entry, item); return cell.kind === "none" ? cell.glyph : cell.kind; }))), [rows, columns]);
  const pickedCells = useMemo(() => new Set(picked.keys()), [picked]);

  const [root, setRoot] = useState<HTMLElement | null>(null), [frame, setFrame] = useState<HTMLDivElement | null>(null), width = useWidth(root), frameWidth = useWidth(frame);
  // Whether the matrix is scrolled sideways (phones), so the names column shows its edge over the cells passing under it.
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => setScrolled((frame?.scrollLeft ?? 0) > 0), [frame]);
  const wide = width === null || width >= WIDE_PAGE, narrowScreen = useMedia("(max-width: 759px)");
  const shellButton = narrowScreen ? <button type="button" className="icon-btn navigation-toggle" onClick={onMenu} aria-label="打开导航"><MenuIcon size={18}/></button>
    : sidebarHidden ? <Tip label={"展开侧栏 " + keyText("sidebar")}><button type="button" className="icon-btn" aria-label="展开侧栏" aria-keyshortcuts={ariaKeys("sidebar")} onClick={onExpandSidebar}><PanelLeft size={16}/></button></Tip> : null;
  const reload = <Tip label="重新读取"><button type="button" className="icon-btn" aria-label="重新读取" onClick={() => load()} disabled={loading}>{loading ? <Spinner size={15} label=""/> : <RefreshCw size={16}/>}</button></Tip>;
  const title = <h1 id="capabilities-title" className="m-0 min-w-0 flex-1 trunc text-[22px] leading-[30px] font-semibold tracking-[-0.02em]">能力</h1>;
  const ready = view !== null && view.harnesses.length > 0;
  const tabItems = kinds.map(item => ({ id: item, label: KIND_LABEL[item], count: counts[item] }));
  const pickable = states.has("open");
  const writtenFiles = batch === null ? 0 : new Set(batch.filter(item => item.view.status === "applied").map(item => item.view.file)).size, failedWrites = batch?.filter(item => item.view.status !== "applied").length ?? 0;

  const resultNotice = result === null ? null : result.kind === "one" ? <Notice tone={result.view.status === "applied" ? "green" : "red"} className="capability-result" onDismiss={() => setResult(null)}
      title={result.view.status === "applied" ? result.title : result.title + "没有完成"}
      action={result.view.backupId ? <button type="button" className="btn btn-sm" onClick={() => setRestoring(result.view.backupId)}><RotateCcw size={13}/>恢复修改前的文件</button> : null}>
      {result.view.error ? result.view.error.message + "。" : null}{result.view.notes.join(" ")}</Notice>
    : result.kind === "batch" ? (() => { const failed = result.written.filter(item => item.view.status !== "applied"), notes = [...new Set(result.written.flatMap(item => item.view.notes))];
      return <Notice tone={failed.length ? "red" : "green"} className="capability-result" onDismiss={() => setResult(null)}
        title={failed.length ? failed.length + " 处没有写入完成" : "已写入 " + new Set(result.written.map(item => item.view.file)).size + " 个文件"}
        action={result.written.some(item => item.view.status === "applied") ? <button type="button" className="btn btn-sm" onClick={() => setUndoing(result.written)}><RotateCcw size={13}/>撤销这次写入</button> : null}>
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0">{result.written.map(item => <li key={item.id}>{item.harnessName} · {item.title}{item.view.status === "applied" ? "" : "：" + (item.view.error?.message ?? "没有完成")}</li>)}</ul>
        {notes.length ? <ul className="m-0 mt-1.5 flex list-none flex-col gap-0.5 p-0 text-fg-2">{notes.map(note => <li key={note}>{note}</li>)}</ul> : null}</Notice>; })()
    : (() => { const back = new Set(result.views.filter(item => item.status === "applied").map(item => item.file)).size, complete = result.failure === null && result.views.every(item => item.status === "applied");
      // A step that failed is said with its reason, and the title says the undo is not complete, never that the batch was undone.
      return <Notice tone={complete ? "green" : "red"} className="capability-result" onDismiss={() => setResult(null)}
        title={(complete ? "已撤销这次写入，改回了 " : "撤销没有全部完成，改回了 ") + back + " 个文件"}>
        {[...new Set([...result.views.flatMap(item => item.error ? [item.error.message] : item.notes), ...(result.failure === null ? [] : [result.failure])])].join(" ") || null}</Notice>; })();

  const content = <>
    <div className="flex flex-wrap items-end gap-3">
      <div className="flex min-w-[min(260px,100%)] flex-1 flex-col gap-1">
        <h2 ref={heading} tabIndex={-1} className="m-0 text-section outline-none">{KIND_LABEL[kind]} <span className="font-normal text-fg-3">{counts[kind]}</span></h2>
        <p className="m-0 text-ui-sm text-pretty text-fg-2">{pickable ? PICK_HINT : KIND_HINT[kind]}</p>
      </div>
      <label className={cn("flex h-[34px] items-center gap-2 rounded-control bg-surface px-2.5 text-fg-3 shadow-[inset_0_0_0_1px_var(--border-strong)] focus-within:shadow-[inset_0_0_0_1px_var(--accent),0_0_0_3px_var(--accent-soft)]", wide ? "w-[220px]" : "min-w-[160px] flex-1")}>
        <Search size={15} aria-hidden="true" className="flex-none"/>
        <input className="h-full min-w-0 flex-1 border-0 bg-transparent p-0 text-ui-sm text-fg outline-none placeholder:text-placeholder" aria-label="搜索能力" placeholder={"搜索" + (/^[A-Za-z]/u.test(KIND_LABEL[kind]) ? " " : "") + KIND_LABEL[kind]} value={query} onChange={event => setQuery(event.target.value)}/>
      </label>
      {kind === "skill" ? <button type="button" className="btn flex-none" onClick={() => setWriting({ name: null, text: { description: "", body: "" } })}><Plus size={15}/>新建技能</button> : null}
    </div>
    {problem ? <Notice tone="red" action={<button type="button" className="btn btn-sm" onClick={() => load()}>重试</button>}>{problem}</Notice> : null}
    {resultNotice}
    {notice ? <Notice tone={notice.failed ? "red" : "green"} className="capability-notice" onDismiss={() => setNotice(null)}>{notice.text}</Notice> : null}
    {view && history?.drift.length ? <DriftNotice api={api} drift={history.drift} harnesses={view.harnesses} onChange={change} onForgotten={() => loadHistory()}/> : null}
    {view && history?.orphans.length ? <OrphanNotice api={api} orphans={history.orphans} harnesses={view.harnesses} onChange={change}/> : null}
    {view?.truncated ? <Notice tone="neutral">条目太多，只显示前一部分。</Notice> : null}
    {view && view.unreadable.length ? <Notice tone="amber" title="有文件无法读取，其中的内容没有显示">
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">{view.unreadable.map((item, index) => <li key={index}><code className="text-caption">{item.file}</code>：{item.reason}</li>)}</ul></Notice> : null}
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-ui-sm">
      <span className="relative inline-flex">
        <select className="field h-[30px] w-auto appearance-none py-0 pr-8 pl-2.5" aria-label="只看一个 Harness" value={harness ?? ""} onChange={event => setHarness(event.target.value || null)}>
          <option value="">全部 Harness</option>{shown.map(item => <option key={item.harnessId} value={item.harnessId}>{item.name}</option>)}</select>
        <ChevronDown size={14} aria-hidden="true" className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-fg-3"/></span>
      <label className="flex items-center gap-2 text-fg-2"><input type="checkbox" className="size-3.5 accent-accent" checked={onlyWarnings} onChange={event => setOnlyWarnings(event.target.checked)}/>只看有提示或未生效的</label>
    </div>
    {rows.length ? <>
      <div ref={setFrame} className="capability-matrix group/matrix card overflow-x-auto" data-scrolled={scrolled ? "" : undefined} onScroll={event => setScrolled(event.currentTarget.scrollLeft > 0)}>
        <table className="w-full table-fixed border-collapse text-left" style={{ minWidth: (wide ? MATRIX_NAME : MATRIX_NAME_NARROW) + MATRIX_NAME_PADDING + columns.length * MATRIX_COLUMN + MATRIX_INSET }}>
          <colgroup><col/>{columns.map((item, index) => <col key={item.harnessId} style={{ width: MATRIX_COLUMN + (index === columns.length - 1 ? MATRIX_INSET : 0) }}/>)}</colgroup>
          <thead><tr className="hairline-b">
            <th scope="col" className={cn("sticky left-0 z-[1] bg-surface pt-3.5 pr-3 pb-2.5 pl-4 align-bottom text-caption leading-5 font-normal text-fg-3", NAME_EDGE)}>{KIND_HEAD[kind]}</th>
            {columns.map((item, index) => <th key={item.harnessId} scope="col" className={cn("pt-3.5 pb-2.5 pl-0.5 align-bottom font-normal", index === columns.length - 1 ? "pr-4" : "pr-0.5")} title={item.name + " · " + (item.version || "版本未知")}>
              <span className="relative flex flex-col items-center gap-1.5"><BrandIcon brand={item.harnessId} name={item.name} size={26}/>
                <span aria-hidden="true" className="max-w-[66px] trunc text-[11px] leading-5 text-fg-2">{shortName(item.name)}</span>
                <span className="sr-only">{item.name} {item.version || "版本未知"}</span></span></th>)}
          </tr></thead>
          <tbody className="[&>tr:last-child]:border-b-0">{rows.map(entry => { const warnings = warningCount(entry), update = updateOf(entry);
            return <MatrixRow key={entry.key} entry={entry} columns={columns} expanded={open === entry.key} onToggle={() => setOpen(current => current === entry.key ? null : entry.key)}
              source={sourceLine(entry, view?.harnesses ?? [])} picked={pickedCells} onPick={togglePick} frame={frameWidth}
              badges={opened => { const literal = entry.warnings.some(warning => warning.kind === "literal");
                return <>{update?.state === "available" ? <Badge tone="accent" className="flex-none">可更新</Badge> : null}
                  {warnings ? <Badge tone={literal ? "amber" : "neutral"} className={cn("flex-none", opened && !literal && "bg-surface shadow-hairline")}>{warnings} 条提示</Badge> : null}</>; }}>
              <EntryDetail api={api} entry={entry} harnesses={view?.harnesses ?? []} update={update} onSwitch={switchSkill} onPlugin={switchPlugin} onChange={change} onEdit={editSkill}/>
            </MatrixRow>; })}</tbody>
        </table>
      </div>
      {states.has("on") || states.has("open") || states.has("—") || states.has("?") ? <div className="capability-legend flex flex-wrap items-center gap-x-[18px] gap-y-2 text-caption text-fg-3">
        {states.has("on") ? <span className="flex items-center gap-1.5"><span className={cn(CIRCLE, "size-[18px] bg-accent-soft text-accent dark:text-accent-text")}><Check size={10} strokeWidth={3} aria-hidden="true"/></span>已生效</span> : null}
        {pickable ? <span className="flex items-center gap-1.5"><span className={cn(CIRCLE, "size-[18px] shadow-[inset_0_0_0_1px_var(--border-strong)]")}/>可以启用</span> : null}
        {states.has("—") ? <span className="flex items-center gap-1.5"><span className="w-[18px] text-center" aria-hidden="true">—</span>这个 Harness 不读它</span> : null}
        {states.has("?") ? <span className="flex items-center gap-1.5"><span className="w-[18px] text-center" aria-hidden="true">?</span>保存在磁盘之外，无法读取</span> : null}
      </div> : null}
    </> : <EmptyState title={query || onlyWarnings ? "没有匹配的条目" : "这一类还没有条目"}>{columns.some(item => item.kinds[kind] !== "read") ? "部分 Harness 没有这类能力，或保存在磁盘之外。" : "各 Harness 的用户级配置里没有这一类。"}</EmptyState>}
    {/* Placed against the page, but right after the matrix in the reading and Tab order, so the bar is the next stop after the
      * cells. Sized as on the Capabilities board: 52 px tall with 13 px words and the 34 px buttons; the result bar 46 px. */}
    <FloatingBar open={picked.size > 0 && !previewing} label="已选的格子" className="absolute bottom-6 z-30 min-h-[52px] gap-2.5 pl-[18px] text-ui-sm">
      <span className="min-w-0 py-1.5 whitespace-normal" role="status"><span className="whitespace-nowrap">已选 <strong className="font-semibold">{picked.size}</strong> 处</span>{" · "}
        <span className="whitespace-nowrap">{waiting ? "正在核对要改的文件" : "会改 " + files.length + " 个文件"}</span>{!waiting && refused ? <>{" · "}<span className="whitespace-nowrap">{refused} 处不能写入</span></> : null}</span>
      <span className="flex flex-none items-center gap-2.5">
        <button type="button" className="btn btn-ghost" onClick={() => { setPicked(new Map()); keepFocus(() => heading.current); }}>清除</button>
        <button ref={previewButton} type="button" className="btn btn-primary" disabled={waiting || files.length === 0} onClick={preview}>预览写入</button></span>
    </FloatingBar>
    <FloatingBar open={batch !== null && picked.size === 0 && !previewing && undoing === null} label="写入结果" className="capability-written absolute bottom-6 z-30 min-h-[46px] gap-2.5 pl-3.5 text-ui-sm">
      {/* What the Gateway did, file by file: a change it reports as not done is never counted as written. */}
      {failedWrites ? <AlertCircle size={16} aria-hidden="true" className="flex-none text-red"/> : <CircleCheck size={16} aria-hidden="true" className="flex-none text-accent-text"/>}
      <span className="min-w-0 trunc">{failedWrites ? failedWrites + " 处没有写入完成" + (writtenFiles ? "，已写入 " + writtenFiles + " 个文件" : "") : "已写入 " + writtenFiles + " 个文件"}</span>
      <span className="flex flex-none items-center gap-0.5">
        {writtenFiles ? <button ref={undoButton} type="button" className="btn btn-ghost h-8 px-2.5 text-accent-text hover:text-accent-text" onClick={() => setUndoing(batch)}>撤销</button> : null}
        <button type="button" className="icon-btn icon-btn-sm" aria-label="关闭" onClick={() => { setBatch(null); keepFocus(() => heading.current); }}><X size={14}/></button></span>
    </FloatingBar>
    {kind === "skill" && view ? <SharedDirectory api={api} harnesses={columns} updates={updates} checking={checkingUpdates} updateProblem={updateProblem} onAdd={() => setAdding(true)} onCheckUpdates={checkUpdates} onChange={change}/> : null}
    {kind === "mcp" ? <McpInventoryPanel api={api} harness={harness} reload={reloads} onChange={change} onNotice={(text, failed) => setNotice({ text, failed })}/> : null}
    {kind === "instructions" ? <InstructionsPanel api={api} harness={harness} reload={reloads} onChange={change} onNotice={(text, failed) => setNotice({ text, failed })}/> : null}
    {kind === "subagent" ? <SubagentsPanel api={api} harness={harness} reload={reloads} onChange={change} onNotice={(text, failed) => setNotice({ text, failed })}/> : null}
    {kind === "plugin" ? <PluginSupport harnesses={columns}/> : null}
    {view ? <details className={DISCLOSURE}><summary><DisclosureChevron/><Eye size={15} className="flex-none text-fg-3" aria-hidden="true"/><span className="font-medium">各 Harness 的读取规则与说明</span></summary>
      <div className="flex flex-col gap-3 px-4 pb-4">
        <ul className="m-0 flex list-none flex-col gap-2.5 p-0">{shown.map(item => <li key={item.harnessId} className="flex flex-col gap-0.5">
          <span className="flex items-center gap-2"><BrandIcon brand={item.harnessId} name={item.name} size={18}/><strong className="font-medium">{item.name}</strong>
            <span className="text-caption text-fg-3">{item.version || "版本未知"} · 读取规则见说明</span></span>
          {item.notes.length ? <ul className="m-0 list-disc pl-[46px] text-fg-2 marker:text-fg-3">{item.notes.map((note, index) => <li key={index}>{note}</li>)}</ul> : null}</li>)}</ul>
        <p className="m-0 text-caption text-fg-3">读取时间 {new Date(view.checkedAt).toLocaleString()}。只显示名字与数量，不显示任何环境变量、请求头或参数的值。</p>
      </div></details> : null}
    {history ? <ChangeHistory api={api} history={history} onRestore={setRestoring} onChange={change}/> : null}
  </>;

  return <section ref={setRoot} className="capabilities-page relative flex h-full min-h-0 min-w-0 flex-1 bg-app" aria-labelledby="capabilities-title">
    {wide ? <nav aria-label="能力分类" className="flex w-[214px] flex-none flex-col overflow-y-auto hairline-r pt-10 pr-3 pb-6 pl-3.5">
      {/* 16 px below the title and the list's own 2 px gap, as on the board */}
      <div className={cn("mb-[18px] flex min-w-0 items-center gap-1", shellButton ? "ml-0" : "ml-2.5")}>{shellButton}{title}{reload}</div>
      {ready ? <KindNav kinds={kinds} value={kind} counts={counts} onChange={choose}/> : null}
      <span className="min-h-6 flex-1"/>
    </nav> : null}
    <div className="flex min-w-0 flex-1 flex-col">
      {wide ? null : <header className="flex h-14 flex-none items-center gap-2 pr-3.5 pl-3 sm:pl-[18px]">{shellButton}{title}{reload}</header>}
      {/* The narrow category row scrolls sideways when the kinds do not fit (on a 390 px phone the last one comes in by
          scrolling); its padding scrolls with it, so the last tab keeps its 16 px from the edge, 16 px from the one before. */}
      {!wide && ready ? <div className="flex-none overflow-x-auto hairline-b"><Tabs items={tabItems} value={kind} onChange={choose} label="能力类别" idPrefix="capability-tab" panelId="capability-tabpanel" className="h-11 w-max px-4 [&>.tab]:h-11 [&>.tab+.tab]:ml-4"/></div> : null}
      {/* Not a positioned box here: the floating bar inside is placed against the page (the section), so it stays put while this scrolls. */}
      <div className="scroll-area !static min-h-0 flex-1">
        <div className={cn("flex w-full max-w-[1040px] flex-col gap-5", wide ? "px-9 pt-10 pb-[120px]" : "px-4 pt-5 pb-[120px]")}>
          {view === null ? <>
            {problem ? <Notice tone="red" action={<button type="button" className="btn btn-sm" onClick={() => load()}>重试</button>}>{problem}</Notice> : null}
            {loading ? <p className="m-0 flex items-center gap-2 text-ui-sm text-fg-2" role="status"><Spinner size={14} label=""/>正在读取各 Harness 的配置</p> : null}
          </> : !ready ? <EmptyState title="没有找到官网安装的 Harness">在 Harness 页安装或重新检测后，这里会列出它们读取的能力。</EmptyState>
            : <div role="tabpanel" id="capability-tabpanel" aria-labelledby={"capability-tab-" + kind} className="flex flex-col gap-5">{content}</div>}
        </div>
      </div>
    </div>
    <WriteDialog api={api} open={previewing} items={items} onCheck={setCheck} onClose={wrote}/>
    <UndoDialog api={api} written={undoing} onClose={() => { setUndoing(null); keepFocus(() => undoButton.current); }} onDone={undone}/>
    <ChangeDialog api={api} request={changing} onClose={() => setChanging(null)} onDone={finished}/>
    <SkillAddDialog api={api} open={adding} onClose={() => setAdding(false)} onChange={change}/>
    <SkillTextDialog editing={writing} onClose={() => setWriting(null)} onSubmit={writeSkill}/>
    <RestoreDialog api={api} backupId={restoring} onClose={() => setRestoring(null)} onDone={restored => finished(restored, "已恢复 " + restored.file)}/>
  </section>;
}
