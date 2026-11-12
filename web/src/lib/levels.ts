import type { NativeOption, NativeOptions } from "../../../src/contracts/control.js";
import { closestLevel, EFFORT_WORDS, levelOf, nativeLevels, PERMISSION_WORDS, type NativeLevels } from "../../../src/contracts/levels.js";
import { EFFORT_LEVELS, PERMISSION_LEVELS, type EffortLevel, type PermissionLevel } from "../../../src/contracts/protocol.js";

/**
 * The composer's unified permission and effort lists (src/contracts/levels.ts): what the selected Harness's catalog offers, which level the
 * draft's native values are now, and the native values a level is. `current` is a level, "custom" when the draft names native values that are
 * none of them (changed in the Harness's own options), or null when it names none (the Harness's own setting).
 */
export interface LevelState {
  readonly levels: NativeLevels;
  readonly permission: PermissionLevel | "custom" | null;
  readonly effort: EffortLevel | "custom" | null;
  /** The ids of the native options the levels set: they are changed through the levels, and shown whole only among the Harness's own options. */
  readonly ids: ReadonlySet<string>;
}
export function levelState(harnessId: string, options: readonly NativeOption[], chosen: NativeOptions): LevelState {
  const levels = nativeLevels(harnessId, options);
  const permissionIds = new Set([...levels.permission.flatMap(entry => Object.keys(entry.options)), ...Object.keys(levels.permissionNeutral ?? {})]);
  const effortIds = new Set(levels.effort.flatMap(entry => Object.keys(entry.options)));
  const now = (ids: ReadonlySet<string>) => Object.fromEntries([...ids].map(id => [id, chosen[id] ?? options.find(option => option.id === id)?.currentValue ?? ""]));
  const named = (ids: ReadonlySet<string>) => [...ids].some(id => chosen[id] !== undefined);
  const permission = levelOf(levels.permission, now(permissionIds)) ?? (named(permissionIds) ? "custom" : null);
  const effort = levelOf(levels.effort, now(effortIds)) ?? (named(effortIds) ? "custom" : null);
  return { levels, permission, effort, ids: new Set([...permissionIds, ...effortIds]) };
}
/** The draft's native values with a permission level's (or none, the Harness's own setting back: its neutral values, else nothing named). */
export function withPermission(state: LevelState, chosen: NativeOptions, level: PermissionLevel | null): NativeOptions {
  const ids = new Set([...state.levels.permission.flatMap(entry => Object.keys(entry.options)), ...Object.keys(state.levels.permissionNeutral ?? {})]);
  const kept = Object.fromEntries(Object.entries(chosen).filter(([id]) => !ids.has(id)));
  const values = level === null ? {} : state.levels.permission.find(entry => entry.level === level)?.options ?? {};
  // A native value the level before named and this one does not is set back to the Harness's own (its neutral), never left as it was.
  const undone = Object.fromEntries(Object.entries(state.levels.permissionNeutral ?? {}).filter(([id]) => values[id] === undefined && chosen[id] !== undefined));
  return sorted({ ...kept, ...undone, ...values });
}
export function withEffort(state: LevelState, chosen: NativeOptions, level: EffortLevel | null): NativeOptions {
  const ids = new Set(state.levels.effort.flatMap(entry => Object.keys(entry.options)));
  const kept = Object.fromEntries(Object.entries(chosen).filter(([id]) => !ids.has(id)));
  return sorted({ ...kept, ...(level === null ? {} : state.levels.effort.find(entry => entry.level === level)?.options ?? {}) });
}
function sorted(values: Record<string, string>): NativeOptions { return Object.fromEntries(Object.entries(values).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)); }
/**
 * Carries the levels of the Harness left to the one chosen: the same level where it has it, else the nearest (said in `notes`), and the
 * permission level of a new conversation defaults to "auto" (the product's direction: let it work), the widest it has short of "plan" where it
 * has no auto. Effort stays the Harness's own unless carried.
 */
export function carryLevels(state: LevelState, chosen: NativeOptions, wanted: { readonly permission?: PermissionLevel; readonly effort?: EffortLevel }, harness: string): { readonly options: NativeOptions; readonly notes: readonly string[] } {
  let options = chosen; const notes: string[] = [];
  if (wanted.permission !== undefined && state.levels.permission.length > 0) {
    const used = closestLevel(PERMISSION_LEVELS, state.levels.permission, wanted.permission, "plan");
    options = withPermission(state, options, used);
    if (used !== wanted.permission) notes.push(used === null ? harness + " 没有「" + PERMISSION_WORDS[wanted.permission] + "」这一档，按它自己的权限设置运行。" : harness + " 没有「" + PERMISSION_WORDS[wanted.permission] + "」这一档，已用最接近的「" + PERMISSION_WORDS[used] + "」。");
  } else if (wanted.permission !== undefined && wanted.permission !== "auto") notes.push(harness + " 没有统一的权限档位，按它自己的权限设置运行。");
  if (wanted.effort !== undefined && state.levels.effort.length > 0) {
    const used = closestLevel(EFFORT_LEVELS, state.levels.effort, wanted.effort);
    options = withEffort(state, options, used);
    if (used !== wanted.effort) notes.push(used === null ? harness + " 没有「" + EFFORT_WORDS[wanted.effort] + "」这一档思考强度，按它自己的默认。" : harness + " 没有「" + EFFORT_WORDS[wanted.effort] + "」这一档思考强度，已用最接近的「" + EFFORT_WORDS[used] + "」。");
  }
  return { options, notes };
}
