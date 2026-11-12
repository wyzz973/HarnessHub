import type { NativeOption, NativeOptions } from "../../../src/contracts/control.js";
import { levelOf, nativeLevels, PERMISSION_KEY, selectedPermission, type HarnessFlavor, type NativeLevels } from "../../../src/contracts/flavor.js";
import { closestLevel, EFFORT_WORDS, PERMISSION_WORDS } from "../../../src/contracts/levels.js";
import { EFFORT_LEVELS, PERMISSION_LEVELS, type EffortLevel, type PermissionLevel } from "../../../src/contracts/protocol.js";

/**
 * The composer's permission and effort lists, drawn from what the Harness's adapter declares (its flavor, sent with its catalog) and nothing
 * else: the page knows no Harness by name. `current` is a level, "custom" when the draft names native values that are no level (changed in the
 * Harness's own options), or null when it names none (the Harness's own setting).
 */
export interface LevelState {
  readonly levels: NativeLevels;
  readonly permission: PermissionLevel | "custom" | null;
  readonly effort: EffortLevel | "custom" | null;
  /** The ids of the native options the levels set: changed through the levels, and shown whole only among the Harness's own options. */
  readonly ids: ReadonlySet<string>;
}
const withoutKey = (values: NativeOptions): NativeOptions => Object.fromEntries(Object.entries(values).filter(([id]) => id !== PERMISSION_KEY));
export function levelState(flavor: HarnessFlavor | undefined, options: readonly NativeOption[], chosen: NativeOptions): LevelState {
  const levels = nativeLevels(flavor, options);
  const permissionIds = new Set([...levels.permission.flatMap(entry => Object.keys(withoutKey(entry.options))), ...Object.keys(levels.permissionNeutral ?? {})]);
  const effortIds = new Set(levels.effort.flatMap(entry => Object.keys(entry.options)));
  const now = (ids: ReadonlySet<string>) => Object.fromEntries([...ids].map(id => [id, chosen[id] ?? options.find(option => option.id === id)?.currentValue ?? ""]));
  const named = (ids: ReadonlySet<string>) => [...ids].some(id => chosen[id] !== undefined);
  // The level the selection names, while its native values are still that level's; a native value changed since makes it custom.
  const kept = selectedPermission(chosen), byValues = levelOf(levels.permission.map(entry => ({ ...entry, options: withoutKey(entry.options) })), now(permissionIds));
  const declared = kept === undefined ? undefined : levels.permission.find(entry => entry.level === kept);
  const permission = kept !== undefined && declared !== undefined && Object.entries(withoutKey(declared.options)).every(([id, value]) => now(permissionIds)[id] === value) ? kept
    : kept === undefined && byValues !== null && named(permissionIds) ? byValues : kept !== undefined || named(permissionIds) ? "custom" : null;
  const effort = levelOf(levels.effort, now(effortIds)) ?? (named(effortIds) ? "custom" : null);
  return { levels, permission, effort, ids: new Set([...permissionIds, ...effortIds]) };
}
function sorted(values: Record<string, string>): NativeOptions { return Object.fromEntries(Object.entries(values).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)); }
/** The draft's native values with a permission level's (its native values and the Hub's key), or none: the Harness's own setting back. */
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
/**
 * Carries the levels of the Harness left to the one chosen: every permission level is there on every Harness, so it goes as it is (only one its
 * declaration calls impossible gives way to the nearest, said in `notes`); a new conversation's permission defaults to auto. Effort goes to the
 * same level where the model has it, else to the nearest, said too.
 */
export function carryLevels(state: LevelState, chosen: NativeOptions, wanted: { readonly permission?: PermissionLevel; readonly effort?: EffortLevel }, harness: string): { readonly options: NativeOptions; readonly notes: readonly string[] } {
  let options = chosen; const notes: string[] = [];
  if (wanted.permission !== undefined) {
    const possible = state.levels.permission.filter(entry => entry.impossible === undefined);
    const used = closestLevel(PERMISSION_LEVELS, possible, wanted.permission, "plan");
    options = withPermission(state, options, used);
    if (used !== wanted.permission) notes.push(harness + " 做不到「" + PERMISSION_WORDS[wanted.permission] + "」，" + (used === null ? "按它自己的权限设置运行。" : "已用最接近的「" + PERMISSION_WORDS[used] + "」。"));
  }
  if (wanted.effort !== undefined && state.levels.effort.length > 0) {
    const used = closestLevel(EFFORT_LEVELS, state.levels.effort, wanted.effort);
    options = withEffort(state, options, used);
    if (used !== wanted.effort) notes.push(used === null ? harness + " 没有「" + EFFORT_WORDS[wanted.effort] + "」这一档思考强度，按它自己的默认。" : harness + " 没有「" + EFFORT_WORDS[wanted.effort] + "」这一档思考强度，已用最接近的「" + EFFORT_WORDS[used] + "」。");
  }
  return { options, notes };
}
