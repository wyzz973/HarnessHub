import type { NativeOptions } from "./control.js";
import { EFFORT_KEY, effortOfValue, selectedEffort, selectedPermission, type LevelValues } from "./flavor.js";
import type { EffortLevel, PermissionLevel } from "./protocol.js";

/**
 * The Hub's one way of saying how much a Harness may do and how hard its model thinks (docs/proposals/protocol/hub-protocol.html §9): five
 * permission levels and five effort levels. How each Harness carries them out is its adapter's declaration (contracts/flavor.ts,
 * src/adapters/flavors/); this module has their words and the reading of a Run's selection.
 */
export const PERMISSION_WORDS: Readonly<Record<PermissionLevel, string>> = { plan: "只规划", ask: "每步询问", auto_edit: "自动改文件", auto: "自动执行", full: "完全放行" };
export const PERMISSION_MEANINGS: Readonly<Record<PermissionLevel, string>> = { plan: "只读，只出方案", ask: "改文件和跑命令都先问", auto_edit: "改文件不问，跑命令问", auto: "都不问，仍受沙箱限制", full: "不问，不设限" };
export const EFFORT_WORDS: Readonly<Record<EffortLevel, string>> = { off: "关", low: "低", medium: "中", high: "高", max: "最高" };
export { EFFORT_KEY, PERMISSION_KEY, effortOfValue, levelOf, levelOptions, nativeLevels, selectedLevels, type ChosenLevels, type LevelValues, type NativeLevels } from "./flavor.js";

/**
 * The levels a Run ran with, from its selection: the levels it named by the Hub's keys, and for a selection written before the effort key (the
 * page then sent the model's own value) the effort level of the reasoning value it named. Absent when it named none: the Harness then ran on its
 * own setting, which is not claimed to be any level.
 */
export function selectionLevels(values: NativeOptions | undefined): { readonly permission?: PermissionLevel; readonly effort?: EffortLevel } {
  if (values === undefined) return {};
  const permission = selectedPermission(values);
  const effortKey = Object.keys(values).find(id => id !== EFFORT_KEY && /effort|thought|thinking/u.test(id));
  const effort = selectedEffort(values) ?? (effortKey === undefined ? null : effortOfValue(values[effortKey]!));
  return { ...(permission === undefined ? {} : { permission }), ...(effort === null ? {} : { effort }) };
}
/** The level used in place of `wanted` where a Harness lacks it: the nearest it has, the wider of two as near; null when none fits. */
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
