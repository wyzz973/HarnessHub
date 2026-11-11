import type { WINDOW_SOURCES } from "../../../../contracts/relay.js";
import type { PublicRun, SessionSnapshot } from "../../../../contracts/session.js";
import { RELAY_BUDGET, resolveRelayBudget, type RelayBudget } from "./budget.js";

/**
 * The target's context window and what it leaves a packet (ADR-055 §6.2, slim.md): the window is what the target's own Turns
 * reported (`usage.context.size` of its latest Run on the same Harness control), else an assumed one; the hard cap is the least of
 * what the window leaves, what the Driver's channel leaves and the largest packet, and a packet is folded to it. When even the
 * least packet the renderer makes does not fit (its `tokens` above its `budget.cap`), the input goes as typed. The history's
 * length never enters it. Pure.
 */

/** What a packet's window leaves after the target's fixed prefix and the current words (§6.2 RESERVE). */
export const WINDOW_RESERVE = 4096;
/** The window assumed when the target never reported one, and the target's own system prompt and tool specifications. */
export const ASSUMED_WINDOW = 128_000, FIXED_PREFIX = 8000;
/** How many units of a channel's bound one estimated token may take at most (`estimateTokens` counts 3.2 ASCII bytes a token). */
const UNITS_PER_TOKEN = 3.2;

export type WindowSource = typeof WINDOW_SOURCES[number];
export interface ResolvedWindow {
  /** W, in tokens. */
  readonly size: number;
  readonly source: WindowSource;
  /** S_B: the target's fixed prefix, in tokens. */
  readonly fixedPrefix: number;
}
/** The latest context window the target reported: `usage.context.size` of the latest earlier Run on the same Harness control. */
export function reportedWindow(state: SessionSnapshot, current: PublicRun): number | null {
  for (let index = state.runs.length - 1; index >= 0; index--) {
    const run = state.runs[index]!;
    if (run.id === current.id || run.selection.harnessId !== current.selection.harnessId || run.selection.controlId !== current.selection.controlId) continue;
    const size = run.usage?.context?.size;
    if (typeof size === "number" && Number.isSafeInteger(size) && size > 0) return size;
  }
  return null;
}
export function resolveWindow(state: SessionSnapshot, current: PublicRun): ResolvedWindow {
  const reported = reportedWindow(state, current);
  return { size: reported ?? ASSUMED_WINDOW, source: reported === null ? "assumed" : "observed", fixedPrefix: FIXED_PREFIX };
}
/**
 * hardCap (§6.2): what the window leaves a packet — at most 5% of it, and no more than remains after the fixed prefix, the
 * current words (`inputTokens`) and the reserve — and what the channel leaves it (`channel`'s bound less what the Turn takes
 * without a packet, `inputSize` in its unit, and the reserve, in tokens at the most units a token may take), never above the
 * largest packet's cap (RELAY_BUDGET.standardCap). Never negative.
 */
export function hardCap(window: ResolvedWindow, inputTokens: number, channel: { readonly limit: number } | null, inputSize: number): number {
  const capWindow = Math.max(0, Math.min(Math.floor(0.05 * window.size), window.size - window.fixedPrefix - inputTokens - WINDOW_RESERVE));
  const capChannel = channel === null ? Number.POSITIVE_INFINITY : Math.max(0, Math.floor((channel.limit - inputSize - WINDOW_RESERVE) / UNITS_PER_TOKEN));
  return Math.max(0, Math.min(capWindow, capChannel, RELAY_BUDGET.standardCap));
}
/**
 * The budget the renderer folds a packet to (budget.ts): for a reported window its own; for an assumed one the renderer's own
 * assumption; in both cases no larger than `cap` (the hard cap), the share of the user's words following it.
 */
export function packetBudget(window: ResolvedWindow, cap: number): RelayBudget {
  const base = resolveRelayBudget(window.source === "observed" ? window.size : null);
  if (cap >= base.cap) return base;
  const capped = Math.max(0, Math.floor(cap));
  return { ...base, cap: capped, user: Math.min(RELAY_BUDGET.userCap, Math.floor(0.5 * capped)) };
}
