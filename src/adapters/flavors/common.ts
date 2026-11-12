import { HUB_POLICIES, type AsksFor, type NativeWant, type PermissionWay } from "../../contracts/flavor.js";
import { PERMISSION_LEVELS, type PermissionLevel } from "../../contracts/protocol.js";

/**
 * The five levels of a Harness the Hub carries out by its policy alone (no native setting known yet): each level answers the requests the
 * Harness sends by HUB_POLICIES, and says where that falls short: what the Harness does not ask about, the Hub cannot hold back.
 */
export function policyLevels(asks: AsksFor, native: Partial<Record<PermissionLevel, readonly NativeWant[]>> = {}): Readonly<Record<PermissionLevel, PermissionWay>> {
  const unasked = [...(asks.edit ? [] : ["改文件"]), ...(asks.execute ? [] : ["跑命令"])];
  const gap = unasked.length === 0 ? undefined : "它" + unasked.join("、") + "时不来问，Hub 拦不住这些操作";
  const notes: Readonly<Record<PermissionLevel, string | undefined>> = {
    plan: native.plan !== undefined ? undefined : unasked.length ? "Hub 拒绝它来问的改动与命令；" + gap : undefined,
    ask: gap === undefined ? undefined : "Hub 把它来问的都交给你；" + gap,
    auto_edit: gap === undefined ? undefined : "Hub 自动允许改文件、命令交给你；" + gap,
    auto: undefined,
    full: undefined,
  };
  return Object.fromEntries(PERMISSION_LEVELS.map(level => {
    const note = notes[level];
    return [level, { ...(native[level] === undefined ? {} : { native: native[level] }), policy: HUB_POLICIES[level], ...(note === undefined ? {} : { note }) }];
  })) as Record<PermissionLevel, PermissionWay>;
}
export const MODE = (value: string, ids: readonly string[] = ["__mode", "mode"]): NativeWant => ({ ids, category: "mode", value });
