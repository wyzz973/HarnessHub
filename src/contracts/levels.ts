import type { NativeOption, NativeOptions } from "./control.js";
import { EFFORT_LEVELS, PERMISSION_LEVELS, type EffortLevel, type PermissionLevel } from "./protocol.js";

/**
 * The Hub's one way of saying how much a Harness may do and how hard its model thinks (docs/proposals/protocol/hub-protocol.html §9, the protocol's
 * step 5): five permission levels and five effort levels, each Harness's levels declared here as the native values they are. A level a Harness
 * does not have is not there (the page greys it out with the reason, and never sends another one in its place unseen); a mapping that is not
 * sure is left out. What each Harness offers is read from its own catalog when its session opens (its modes and config options, its model's
 * reasoning levels): a level is offered only when every native value it needs is in that catalog.
 */

export const PERMISSION_WORDS: Readonly<Record<PermissionLevel, string>> = { plan: "只规划", ask: "每步询问", auto_edit: "自动改文件", auto: "自动执行", full: "完全放行" };
export const PERMISSION_MEANINGS: Readonly<Record<PermissionLevel, string>> = { plan: "只读，只出方案", ask: "改文件和跑命令都先问", auto_edit: "改文件不问，跑命令问", auto: "都不问，仍受沙箱限制", full: "不问，不设限" };
export const EFFORT_WORDS: Readonly<Record<EffortLevel, string>> = { off: "关", low: "低", medium: "中", high: "高", max: "最高" };

/** One native value a level needs: an option of the catalog, by its id when known (one of `ids`) or else by its category, set to `value`. */
interface Want { readonly ids?: readonly string[]; readonly category: string; readonly value: string }
interface PermissionTable {
  readonly levels: Partial<Record<PermissionLevel, readonly Want[]>>;
  /**
   * What undoes a level's native value that the next level does not name: the Harness's own setting back in force (OpenCode's build agent,
   * Codex's default collaboration mode), so a level left behind does not stay. Set only where a value was named before (page lib/levels.ts).
   */
  readonly neutral?: readonly Want[];
  /** Why a level is not there, said in the list beside it. */
  readonly missing: string;
}
const MODE = (value: string, ids: readonly string[] = ["__mode", "mode"]): Want => ({ ids, category: "mode", value });
// Codex's collaboration mode is named for plan only: naming it needs the app-server's experimental API, which an older Codex lacks. Leaving plan
// sets it back to default (the table's neutral), since a thread keeps the mode it was last given.
const CODEX = (approval: string, sandbox: string, plan = false): readonly Want[] => [
  ...(plan ? [{ ids: ["collaboration_mode"], category: "mode", value: "plan" }] : []), { ids: ["approval_policy"], category: "permission", value: approval }, { ids: ["sandbox"], category: "permission", value: sandbox }];

/**
 * Each Harness's permission levels (the native values named are those its catalog reports):
 * - Claude Code (claude-agent-acp modes, docs/verification/native-capability-matrix.md): plan, default, acceptEdits, auto, bypassPermissions.
 * - Codex (thread settings approval_policy and sandbox, and the collaboration mode): plan with on-request and read-only; untrusted, on-request
 *   and never with workspace-write; never with danger-full-access. The proposal's mapping, not yet checked level by level on a real Codex.
 * - OpenCode (its agents as modes): plan only; build follows OpenCode's own permission configuration, which no level can promise.
 * - Hermes (the gateway viewer's modes, v0.22.5): default, accept_edits, dont_ask. Hermes has no sandbox, so dont_ask is full and there is no auto.
 * - DeepSeek Harness (no mode over ACP: its preset is its own), OpenClaw (its exec rights are its Gateway's) and Pi: none.
 */
export const PERMISSION_TABLES: Readonly<Record<string, PermissionTable>> = {
  claude: { levels: { plan: [MODE("plan")], ask: [MODE("default")], auto_edit: [MODE("acceptEdits")], auto: [MODE("auto")], full: [MODE("bypassPermissions")] }, missing: "这个版本的 Claude Code 没有报这一档" },
  codex: { levels: { plan: CODEX("on-request", "read-only", true), ask: CODEX("untrusted", "workspace-write"), auto_edit: CODEX("on-request", "workspace-write"),
    auto: CODEX("never", "workspace-write"), full: CODEX("never", "danger-full-access") }, neutral: [{ ids: ["collaboration_mode"], category: "mode", value: "default" }], missing: "这个版本的 Codex 没有报这一档需要的设置" },
  opencode: { levels: { plan: [MODE("plan")] }, neutral: [MODE("build")], missing: "OpenCode 的权限按它自己的配置走，只有“只规划”能由 Hub 选" },
  hermes: { levels: { ask: [MODE("default")], auto_edit: [MODE("accept_edits")], full: [MODE("dont_ask")] }, missing: "Hermes 没有这一档（它没有沙箱，不问就是不设限）" },
  dsh: { levels: {}, missing: "DeepSeek Harness 的权限按它自己的预设，Hub 选不了" },
  openclaw: { levels: {}, missing: "OpenClaw 的执行权限是它 Gateway 的设置，Hub 不映射" },
  pi: { levels: {}, missing: "Pi 没有权限档位" },
};

/** One level as the native values it is in a Harness's catalog. */
export interface LevelValues<L extends string> { readonly level: L; readonly options: NativeOptions }
/** What a Harness's catalog offers of the levels (sent with its catalog, NativeModelCatalog.levels). */
export interface NativeLevels {
  readonly permission: readonly LevelValues<PermissionLevel>[];
  /** The native values of "no level" (the Harness's own setting), when choosing a level it lacks must undo one it has. */
  readonly permissionNeutral?: NativeOptions;
  readonly permissionMissing: string;
  readonly effort: readonly LevelValues<EffortLevel>[];
  readonly effortMissing: string;
}

function resolve(options: readonly NativeOption[], wants: readonly Want[]): NativeOptions | null {
  const out: Record<string, string> = {};
  for (const want of wants) {
    const option = options.find(row => (want.ids ? want.ids.includes(row.id) : false) && row.values.some(value => value.value === want.value))
      ?? options.find(row => row.category === want.category && (want.ids === undefined || want.ids.includes(row.id)) && row.values.some(value => value.value === want.value));
    if (option === undefined) return null;
    out[option.id] = want.value;
  }
  return out;
}
/** The effort level a native reasoning value is, by its name; null for one that is none of them (adaptive, auto, default). */
export function effortOfValue(value: string): EffortLevel | null {
  const name = value.trim().toLowerCase();
  if (["off", "none", "disabled", "no"].includes(name)) return "off";
  if (["minimal", "min", "low", "lite"].includes(name)) return "low";
  if (["medium", "med", "normal"].includes(name)) return "medium";
  if (name === "high") return "high";
  if (["xhigh", "x-high", "max", "maximum", "highest", "ultra"].includes(name)) return "max";
  return null;
}
/** The native value an effort level is among several that map to it: the one named like the level first (low before minimal, max before xhigh). */
const EFFORT_PREFERENCE: Readonly<Record<EffortLevel, readonly string[]>> = { off: ["off", "none"], low: ["low", "minimal"], medium: ["medium"], high: ["high"], max: ["max", "xhigh", "ultra"] };

/** What a Harness's catalog offers of the levels. */
export function nativeLevels(harnessId: string, options: readonly NativeOption[]): NativeLevels {
  const table = PERMISSION_TABLES[harnessId] ?? { levels: {}, missing: "这一家没有统一的权限档位" };
  const permission = PERMISSION_LEVELS.flatMap(level => { const wants = table.levels[level]; const resolved = wants === undefined ? null : resolve(options, wants); return resolved === null ? [] : [{ level, options: resolved }]; });
  const neutral = table.neutral === undefined ? null : resolve(options, table.neutral);
  const thought = options.find(option => option.category === "thought_level");
  const effort = thought === undefined ? [] : EFFORT_LEVELS.flatMap(level => {
    const candidates = thought.values.filter(value => effortOfValue(value.value) === level).map(value => value.value);
    if (candidates.length === 0) return [];
    const chosen = EFFORT_PREFERENCE[level].find(name => candidates.some(value => value.toLowerCase() === name)) ?? candidates[0]!;
    return [{ level, options: { [thought.id]: candidates.find(value => value.toLowerCase() === chosen.toLowerCase()) ?? chosen } }];
  });
  return { permission, ...(neutral === null ? {} : { permissionNeutral: neutral }), permissionMissing: table.missing, effort, effortMissing: thought === undefined ? "这一家没有思考强度可选" : "这个模型没有这一档" };
}
/** The level `values` (native option values) are among `offered`, or null when they are none of them. */
export function levelOf<L extends string>(offered: readonly LevelValues<L>[], values: NativeOptions): L | null {
  return offered.find(entry => Object.entries(entry.options).every(([id, value]) => values[id] === value))?.level ?? null;
}
/**
 * The level a Run ran with, from the native values its selection named, read by the table alone (no catalog at hand): its permission level when
 * the values are one of its Harness's levels, and its effort level from a reasoning value it named. Absent when the selection named none: the
 * Harness then ran on its own setting, which is not claimed to be any level.
 */
export function selectionLevels(harnessId: string, values: NativeOptions | undefined): { readonly permission?: PermissionLevel; readonly effort?: EffortLevel } {
  if (values === undefined) return {};
  const table = PERMISSION_TABLES[harnessId];
  let permission: PermissionLevel | undefined;
  for (const level of PERMISSION_LEVELS) {
    const wants = table?.levels[level];
    if (wants !== undefined && wants.every(want => Object.entries(values).some(([id, value]) => value === want.value && (want.ids === undefined || want.ids.includes(id))))) { permission = level; break; }
  }
  const effortKey = Object.keys(values).find(id => /effort|thought|thinking|reasoning/u.test(id) && !/reasoning_level/u.test(id));
  const effort = effortKey === undefined ? null : effortOfValue(values[effortKey]!);
  return { ...(permission === undefined ? {} : { permission }), ...(effort === null ? {} : { effort }) };
}
/**
 * The level used in place of `wanted` where a Harness lacks it: the nearest it has, the wider of two as near (the product's direction: let
 * work go on), and never "plan" unless that is what was wanted (it would stop a Harness from working); null when none fits, the Harness's own
 * setting then stands (its neutral values, when it declares them).
 */
export function closestLevel<L extends string>(order: readonly L[], offered: readonly LevelValues<L>[], wanted: L, keep?: L): L | null {
  if (offered.some(entry => entry.level === wanted)) return wanted;
  const at = order.indexOf(wanted);
  let best: L | null = null, distance = Infinity;
  for (const entry of offered) {
    if (keep !== undefined && entry.level === keep && wanted !== keep) continue;
    const gap = Math.abs(order.indexOf(entry.level) - at);
    if (gap < distance || (gap === distance && best !== null && order.indexOf(entry.level) > order.indexOf(best))) { best = entry.level; distance = gap; }
  }
  return best;
}
