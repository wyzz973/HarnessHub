import type { NativeModelCatalog, NativeOption, NativeOptions } from "../../../contracts/control.js";
import { levelOptions, type ChosenLevels, type HarnessFlavor } from "../../../contracts/flavor.js";
import { ControlError } from "../../../infrastructure/control/json-rpc-process.js";

/**
 * The catalog the Claude driver offers and how a selection becomes the SDK's settings: the permission mode (`mode`), the model's effort (`effort`)
 * and fast mode (`fast`), the ids claude-agent-acp gave them, so a conversation's carried values keep their meaning. Every one of them is the
 * session's own (the query's `permissionMode`, `setModel`, the flag layer of `applyFlagSettings`): nothing is written to the user's settings.
 */
export const MODE = "mode", EFFORT = "effort", FAST = "fast";
export type PermissionMode = "default" | "acceptEdits" | "plan" | "auto" | "bypassPermissions" | "dontAsk";
const MODES: readonly { readonly value: PermissionMode; readonly name: string }[] = [
  { value: "default", name: "每次询问" }, { value: "acceptEdits", name: "自动改文件" }, { value: "plan", name: "只规划" },
  { value: "auto", name: "自动" }, { value: "bypassPermissions", name: "完全放开" }, { value: "dontAsk", name: "不询问（未允许的都拒绝）" },
];
export const MODE_OPTION: NativeOption = { id: MODE, name: "权限模式", category: "mode", currentValue: "default", values: MODES };
export function isMode(value: string): value is PermissionMode { return MODES.some(mode => mode.value === value); }

/** One model as the SDK lists it (ModelInfo, read field by field: the SDK's types stay in this directory). */
export interface ModelRow {
  readonly value: string; readonly resolvedModel?: string; readonly displayName: string;
  readonly supportedEffortLevels?: readonly string[]; readonly supportsFastMode?: boolean; readonly supportsAutoMode?: boolean;
}
export function modelRows(value: unknown): readonly ModelRow[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    if (item === null || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    if (typeof row.value !== "string" || !row.value || typeof row.displayName !== "string") return [];
    const efforts = Array.isArray(row.supportedEffortLevels) ? row.supportedEffortLevels.filter((level): level is string => typeof level === "string") : undefined;
    return [{ value: row.value, displayName: row.displayName, ...(typeof row.resolvedModel === "string" ? { resolvedModel: row.resolvedModel } : {}),
      ...(efforts?.length ? { supportedEffortLevels: efforts } : {}), ...(row.supportsFastMode === true ? { supportsFastMode: true } : {}), ...(row.supportsAutoMode === true ? { supportsAutoMode: true } : {}) }];
  });
}
const EFFORT_NAMES: Readonly<Record<string, string>> = { low: "低", medium: "中", high: "高", xhigh: "很高", max: "最高" };
/** A model's own options: its effort levels (current: the session's, else high) and fast mode where it has one. */
export function modelOptions(row: ModelRow, effort?: string | null): readonly NativeOption[] {
  const efforts = row.supportedEffortLevels ?? [];
  return [
    ...(efforts.length ? [{ id: EFFORT, name: "思考强度", category: "thought_level", currentValue: effort && efforts.includes(effort) ? effort : efforts.includes("high") ? "high" : efforts[0]!,
      values: efforts.map(value => ({ value, name: EFFORT_NAMES[value] ?? value })) }] : []),
    ...(row.supportsFastMode ? [{ id: FAST, name: "快速模式", category: "model_config", currentValue: "off", values: [{ value: "off", name: "标准" }, { value: "on", name: "快速" }] }] : []),
  ];
}
/** The catalog's models: every row Claude Code lists (its `default` included), each with its options; images and files go natively. */
export function catalogModels(rows: readonly ModelRow[]): NativeModelCatalog["models"] {
  return rows.map(row => ({ id: row.value, name: row.displayName, ...(modelOptions(row).length ? { options: modelOptions(row) } : {}), inputs: { image: true, audio: false, file: true } }));
}
/** A model named by its value or by the id it resolves to. */
export function findModel(rows: readonly ModelRow[], model: string): ModelRow | undefined {
  return rows.find(row => row.value === model) ?? rows.find(row => row.resolvedModel === model);
}

/** The SDK settings a selection comes to: what the query starts with, and what the flag layer is given before the first prompt. */
export interface Settled { readonly mode?: PermissionMode; readonly effort?: string; readonly fast?: boolean }
/**
 * The permission mode alone, before the model's catalog is known (the mode option is the same for every model): the level's by the declaration,
 * else the selection's own value.
 */
export function startMode(flavor: HarnessFlavor | undefined, selected: NativeOptions | undefined, levels: ChosenLevels, restored: boolean): PermissionMode | undefined {
  const mode = levelOptions(flavor, [MODE_OPTION], selected, { ...(levels.permission === undefined ? {} : { permission: levels.permission }) }, restored)?.[MODE];
  if (mode === undefined) return undefined;
  if (!isMode(mode)) throw new ControlError("NATIVE_OPTION_UNAVAILABLE", "Claude Code has no such permission mode");
  return mode;
}
/** Everything a selection comes to on the running model's catalog; an option Claude Code does not offer for it is refused. */
export function settle(flavor: HarnessFlavor | undefined, row: ModelRow | undefined, selected: NativeOptions | undefined, levels: ChosenLevels, restored: boolean): Settled {
  const options = [MODE_OPTION, ...(row === undefined ? [] : modelOptions(row))];
  const values = levelOptions(flavor, options, selected, levels, restored) ?? {};
  const out: { mode?: PermissionMode; effort?: string; fast?: boolean } = {};
  for (const [id, value] of Object.entries(values)) {
    const option = options.find(entry => entry.id === id);
    if (option === undefined || !option.values.some(entry => entry.value === value)) throw new ControlError("NATIVE_OPTION_UNAVAILABLE", "Claude Code does not offer " + id.slice(0, 64) + " = " + value.slice(0, 64) + " for this model");
    if (id === MODE && isMode(value)) out.mode = value;
    else if (id === EFFORT) out.effort = value;
    else if (id === FAST) out.fast = value === "on";
  }
  return out;
}
