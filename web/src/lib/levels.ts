import type { NativeOption, NativeOptions } from "../../../src/contracts/control.js";
import { EFFORT_KEY, levelOf, levelOptions, nativeLevels, nativeOnly, PERMISSION_KEY, selectedEffort, selectedLevels, selectedPermission, SPEED_KEY, type HarnessFlavor, type NativeLevels } from "../../../src/contracts/flavor.js";
import { closestLevel, EFFORT_WORDS, PERMISSION_WORDS } from "../../../src/contracts/levels.js";
import { PERMISSION_LEVELS, type EffortLevel, type PermissionLevel } from "../../../src/contracts/protocol.js";

/**
 * The composer's permission and effort lists, drawn from what the Harness's adapter declares (its flavor, sent with its catalog) and nothing
 * else: the page knows no Harness by name. The draft names a level by the Hub's keys alone (hub_permission, hub_effort); the Gateway's adapter
 * makes them the Harness's native values when the session opens (contracts/flavor.ts levelOptions), so the page never writes those values.
 * `current` is the level in effect: the one the draft names (for effort, the nearest the model has when it lacks it), "custom" when the draft
 * names native values the levels set without naming a level (changed in the Harness's own options), or null for the Harness's own setting.
 */
export interface LevelState {
  readonly levels: NativeLevels;
  readonly permission: PermissionLevel | "custom" | null;
  readonly effort: EffortLevel | "custom" | null;
  /** The speed the draft names (the Hub's name: standard, fast or a Harness's own tier), or null for the Harness's own setting (2026-11-14, after T3 Code's Standard | Fast). */
  readonly speed: string | null;
  /** The ids of the native options the levels set: changed through the levels, and shown whole only among the Harness's own options. */
  readonly ids: ReadonlySet<string>;
  /** The native values the draft's levels come to on this catalog, as the adapter will apply them: what the Harness's own options show for them. */
  readonly applied: NativeOptions;
}
const sorted = (values: Record<string, string>): NativeOptions => Object.fromEntries(Object.entries(values).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
function ids(levels: NativeLevels): { readonly permission: ReadonlySet<string>; readonly effort: ReadonlySet<string>; readonly speed: ReadonlySet<string> } {
  return { permission: new Set([...levels.permission.flatMap(entry => Object.keys(nativeOnly(entry.options) ?? {})), ...Object.keys(levels.permissionNeutral ?? {})]),
    effort: new Set(levels.effort.flatMap(entry => Object.keys(entry.options))), speed: new Set(levels.speed.flatMap(entry => Object.keys(entry.options))) };
}
export function levelState(flavor: HarnessFlavor | undefined, options: readonly NativeOption[], chosen: NativeOptions): LevelState {
  const levels = nativeLevels(flavor, options), governed = ids(levels);
  // A native value the draft names for an option the levels set, other than the neutral one (which only undoes a level): the Harness's own option, changed.
  const named = (set: ReadonlySet<string>) => [...set].some(id => chosen[id] !== undefined && chosen[id] !== levels.permissionNeutral?.[id]);
  const permission = selectedPermission(chosen) ?? (named(governed.permission) ? "custom" : null);
  const effortKey = selectedEffort(chosen), effortEntry = effortKey === undefined ? undefined : levels.effort.find(entry => entry.level === effortKey);
  // A selection written before the effort key named the model's own value: read as the level it is.
  const effortValues = Object.fromEntries([...governed.effort].map(id => [id, chosen[id] ?? options.find(option => option.id === id)?.currentValue ?? ""]));
  const effort = effortKey !== undefined ? effortEntry?.near ?? effortKey : named(governed.effort) ? levelOf(levels.effort, effortValues) ?? "custom" : null;
  const applied = levelOptions(flavor, options, {}, selectedLevels(chosen)) ?? {};
  const speed = chosen[SPEED_KEY] !== undefined && levels.speed.some(entry => entry.level === chosen[SPEED_KEY]) ? chosen[SPEED_KEY]! : null;
  return { levels, permission, effort, speed, ids: new Set([...governed.permission, ...governed.effort, ...governed.speed]), applied };
}
/**
 * The draft with a permission level (the Hub's key alone), or with none: the Harness's own setting back. The native values the levels set are
 * left to the adapter; leaving a level for the Harness's own setting names the neutral's values for what that level set (a thread keeps its mode).
 */
export function withPermission(state: LevelState, chosen: NativeOptions, level: PermissionLevel | null): NativeOptions {
  const governed = ids(state.levels).permission, before = state.levels.permission.find(entry => entry.level === selectedPermission(chosen));
  const kept = Object.fromEntries(Object.entries(chosen).filter(([id]) => id !== PERMISSION_KEY && !governed.has(id)));
  const undone = level !== null ? {} : Object.fromEntries(Object.entries(state.levels.permissionNeutral ?? {}).filter(([id]) => before?.options[id] !== undefined || chosen[id] !== undefined));
  return sorted({ ...kept, ...undone, ...(level === null ? {} : { [PERMISSION_KEY]: level }) });
}
/** The draft with an effort level (the Hub's key), the one the model runs for it: a level it lacks is the nearest it has, as the list says. */
export function withEffort(state: LevelState, chosen: NativeOptions, level: EffortLevel | null): NativeOptions {
  const governed = ids(state.levels).effort;
  const kept = Object.fromEntries(Object.entries(chosen).filter(([id]) => id !== EFFORT_KEY && !governed.has(id)));
  const used = level === null ? null : state.levels.effort.find(entry => entry.level === level)?.near ?? level;
  return sorted({ ...kept, ...(used === null ? {} : { [EFFORT_KEY]: used }) });
}
/** The draft with a speed (the Hub's key), or with none: the Harness's own setting. The native value is the adapter's to apply. */
export function withSpeed(state: LevelState, chosen: NativeOptions, speed: string | null): NativeOptions {
  const governed = ids(state.levels).speed;
  const kept = Object.fromEntries(Object.entries(chosen).filter(([id]) => id !== SPEED_KEY && !governed.has(id)));
  return sorted({ ...kept, ...(speed === null ? {} : { [SPEED_KEY]: speed }) });
}
/**
 * A native option changed in the Harness's own options. Changing one a level sets leaves that level: the draft then names the native value,
 * shown as "custom", and the Harness runs it (the adapter's levels would otherwise win over it).
 */
export function withNativeOption(state: LevelState, chosen: NativeOptions, id: string, value: string): NativeOptions {
  const governed = ids(state.levels), choices: Record<string, string> = { ...chosen };
  if (value) choices[id] = value; else delete choices[id];
  if (governed.permission.has(id)) delete choices[PERMISSION_KEY];
  if (governed.effort.has(id)) delete choices[EFFORT_KEY];
  if (governed.speed.has(id)) delete choices[SPEED_KEY];
  return sorted(choices);
}
/**
 * Carries the levels of the Harness left to the one chosen: every permission level is there on every Harness, so it goes as it is (only one its
 * declaration calls impossible gives way to the nearest, said in `notes`); a new conversation's permission defaults to auto. Effort goes to the
 * same level where the model has it, else to the nearest, said too; to a Harness with no thinking option it does not go.
 */
export function carryLevels(state: LevelState, chosen: NativeOptions, wanted: { readonly permission?: PermissionLevel; readonly effort?: EffortLevel }, harness: string): { readonly options: NativeOptions; readonly notes: readonly string[] } {
  let options = chosen; const notes: string[] = [];
  if (wanted.permission !== undefined) {
    const possible = state.levels.permission.filter(entry => entry.impossible === undefined);
    const used = closestLevel(PERMISSION_LEVELS, possible, wanted.permission, "plan");
    options = withPermission(state, options, used);
    if (used !== wanted.permission) notes.push(harness + " 做不到「" + PERMISSION_WORDS[wanted.permission] + "」，" + (used === null ? "按它自己的权限设置运行。" : "已用最接近的「" + PERMISSION_WORDS[used] + "」。"));
  }
  if (wanted.effort !== undefined) {
    if (state.levels.effort.length === 0) options = withEffort(state, options, null);
    else {
      options = withEffort(state, options, wanted.effort);
      const used = selectedEffort(options);
      if (used !== wanted.effort) notes.push(harness + " 没有「" + EFFORT_WORDS[wanted.effort] + "」这一档思考强度，" + (used === undefined ? "按它自己的默认。" : "已用最接近的「" + EFFORT_WORDS[used] + "」。"));
    }
  }
  return { options, notes };
}
