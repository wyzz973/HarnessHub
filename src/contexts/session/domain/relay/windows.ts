import type { NativeUsage } from "../../../../contracts/control.js";
import { RELAY_WINDOW_RETENTION_MS, type BindingRelayState, type RelayCapabilities, type RelayWindow, type VendorKey, type WINDOW_SOURCES } from "../../../../contracts/relay.js";
import { RELAY_BUDGET, resolveRelayBudget, type RelayBudget } from "./budget.js";

/**
 * The target's context window and what it leaves a packet (ADR-055 §6.2, §9 "窗口未知"; G072): the four sources of the window
 * in order — what the binding's own session reported (`window: session_report | turn_report` of its Driver, kept in the
 * binding's `cache`), what was observed for the Harness control and model in the last 30 days (`relay_windows`), a documented
 * window (no table is kept yet, so this source is never taken), and an assumption by the vendor key's kind — and the hard cap
 * `hardCap = min(capWindow, capChannel, T_full)` the smallest packet (MIN_PACKET of the target's family) must fit, or the input
 * meets RELAY_INPUT_LIMIT with "只发这条消息" (D2). The history's length never enters it. Pure: nothing here reads a clock, a
 * store or a process; `now` is given.
 */

/** The smallest packet of each estimator family (§6.2 MIN_PACKET, its initial values; the MVP's one estimator counts for all). */
export const MIN_PACKET = Object.freeze({ o200k: 900, claude: 1350, unknown: 1350 });
export type PacketFamily = keyof typeof MIN_PACKET;
/** What a packet's window leaves after the target's fixed prefix and the current words (§6.2 RESERVE), and the largest tier's cap. */
export const WINDOW_RESERVE = 4096, FULL_TIER_CAP = 32_000;
/** The windows assumed by vendor kind when no source tells (§6.2 ASSUMED_WINDOW, VF2-04): a cloud vendor 128k; anything else 32k. */
export const ASSUMED_WINDOW = Object.freeze({ cloud: 128_000, gateway: 32_000, local: 32_000 });
/** The target's own system prompt and tool specifications when no source tells (§6.2 FIXED_PREFIX_DEFAULT). */
export const FIXED_PREFIX_DEFAULT = Object.freeze({ cloud: 8000, gateway: 8000, local: 4000 });
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
/** A vendor key's kind (§6.2): one of the named cloud vendors, `local`, or a gateway, router, Provider or unknown one. */
export function vendorKind(key: VendorKey): "cloud" | "gateway" | "local" {
  return key === "local" ? "local" : key.includes(":") ? "gateway" : "cloud";
}
/** The estimator family a target's packet is measured in (§6.2): o200k for OpenAI, Claude's for Anthropic's models, unknown otherwise. */
export function packetFamily(key: VendorKey, modelKey: string): PacketFamily {
  if (key === "openai") return "o200k";
  if (key === "anthropic" || /(^|[./:-])claude/u.test(modelKey)) return "claude";
  return "unknown";
}
/**
 * The window a packet for this binding is budgeted against: the session's own report (a Driver that reports one, and a size its
 * binding keeps), else the latest observed for its Harness control and model within RELAY_WINDOW_RETENTION_MS, else assumed by
 * the vendor's kind; the fixed prefix as the Driver declares it, else the first Turn's use observed with that window, else
 * assumed by kind.
 */
export function resolveWindow(input: { readonly relay: BindingRelayState | null; readonly report: RelayCapabilities["window"]; readonly stored: RelayWindow | null; readonly vendor: VendorKey;
    readonly fixedPrefix: RelayCapabilities["fixedPrefix"]; readonly now: number }): ResolvedWindow {
  const kind = vendorKind(input.vendor), stored = input.stored !== null && input.now - input.stored.observedAt <= RELAY_WINDOW_RETENTION_MS ? input.stored : null;
  const reported = input.report === "none" ? null : input.relay?.cache.contextSize ?? null;
  const size = reported ?? stored?.size ?? ASSUMED_WINDOW[kind];
  const source: WindowSource = reported !== null ? "session_report" : stored !== null ? "observed_recent" : kind === "cloud" ? "assumed_cloud" : kind === "local" ? "assumed_local" : "assumed_gateway";
  return { size, source, fixedPrefix: input.fixedPrefix?.tokens ?? stored?.firstTurnUsed ?? FIXED_PREFIX_DEFAULT[kind] };
}
/** Whether a window came from what the target reported (its session, or the same Harness control and model recently). */
export function observedWindow(window: ResolvedWindow): boolean { return window.source === "session_report" || window.source === "observed_recent"; }
/**
 * hardCap (§6.2): what the window leaves a packet — at most 5% of it, and no more than remains after the fixed prefix, the
 * current words (`inputTokens`) and the reserve — and what the channel leaves it (`channel`'s bound less what the Turn takes
 * without a packet, `inputSize` in its unit, and the reserve, in tokens at the most units a token may take), never above the
 * largest tier's cap. Never negative.
 */
export function hardCap(window: ResolvedWindow, inputTokens: number, channel: { readonly limit: number } | null, inputSize: number): number {
  const capWindow = Math.max(0, Math.min(Math.floor(0.05 * window.size), window.size - window.fixedPrefix - inputTokens - WINDOW_RESERVE));
  const capChannel = channel === null ? Number.POSITIVE_INFINITY : Math.max(0, Math.floor((channel.limit - inputSize - WINDOW_RESERVE) / UNITS_PER_TOKEN));
  return Math.max(0, Math.min(capWindow, capChannel, FULL_TIER_CAP));
}
/** Whether the smallest packet of the family fits (§6.2: only `hardCap < MIN_PACKET[family]` is RELAY_INPUT_LIMIT). */
export function fitsMinPacket(cap: number, family: PacketFamily): boolean { return cap >= MIN_PACKET[family]; }
/**
 * The budget the renderer folds a packet to (budget.ts's standard tier, the MVP's one tier): for an observed window its own;
 * for an assumed one the renderer's own assumption (so a target that reported nothing is rendered as before); in both cases
 * no larger than `cap` (the hard cap), the shares of model text and of the user's words following it.
 */
export function packetBudget(window: ResolvedWindow, cap: number): RelayBudget {
  const base = resolveRelayBudget(observedWindow(window) ? window.size : null);
  if (cap >= base.cap) return base;
  const capped = Math.max(0, Math.floor(cap));
  return { ...base, cap: capped, untrusted: Math.floor(RELAY_BUDGET.untrustedRatio * capped), user: Math.min(RELAY_BUDGET.userCap, Math.floor(0.5 * capped)) };
}
/**
 * The binding's cache after a Turn (§4 BindingRelayState.cache, §7.3 "热"): the Turn's last request is taken to start no later
 * than its dispatch (no Driver reports a request's own start, so the cache is never judged warmer than it is), with the context
 * its usage reported; a Turn that reported none keeps what was known.
 */
export function cacheAfter(cache: BindingRelayState["cache"], usage: NativeUsage | undefined, dispatchedAt: number | null): BindingRelayState["cache"] {
  const context = usage?.context, count = (value: unknown, least: number) => typeof value === "number" && Number.isSafeInteger(value) && value >= least && value <= 2_147_483_647 ? value : null;
  return { lastRequestStartedAt: dispatchedAt ?? cache.lastRequestStartedAt, contextUsed: count(context?.used, 0) ?? cache.contextUsed, contextSize: count(context?.size, 1) ?? cache.contextSize };
}
/**
 * The `relay_windows` row a Turn's usage gives (the window's second source for later Sessions): its reported context size for
 * this Harness control and model key, and the context the first Turn of its native session used (the fixed prefix with it);
 * null when the usage reports no size.
 */
export function windowRow(harnessId: string, controlId: string, modelKey: string, usage: NativeUsage | undefined, firstTurn: boolean, now: number): RelayWindow | null {
  const size = usage?.context?.size, used = usage?.context?.used;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 1 || size > 2_147_483_647 || new TextEncoder().encode(modelKey).byteLength > 96) return null;
  const first = firstTurn && typeof used === "number" && Number.isSafeInteger(used) && used >= 0 && used <= size ? used : null;
  return { harnessId, controlId, modelKey, size, firstTurnUsed: first, observedAt: now };
}
