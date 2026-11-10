import type { BindingRelayState, RelayCapabilities, RelayPrefKey } from "../../../../contracts/relay.js";

/**
 * The return decision (ADR-055 §7.3 A→B→A, D9; G072): when a conversation comes back to a Harness that holds an earlier part of
 * it, whether to continue its native session and add what it was not told (the default, "继续原会话"), or to show beside it
 * "新开原生会话并附交接单". The estimates of cost and time are for showing and for suggesting a lower tier only; they never
 * change what is sent by themselves: the Runtime acts on the user's `relay.native` alone (never a silent change of level).
 * Pure: the clock, prices and counts are given.
 */

/** When "新开并附交接单" is shown beside continuing (§7.3, D9; warm or cold): a whole-life cost difference, a latency difference, a full window. */
export const RETURN_THRESHOLDS = Object.freeze({ costUsd: 0.10, latencyS: 10, windowShare: 0.85 });
/** The prior of a target's requests per handoff and cache misses among them until 20 realized windows are known (§7.3: R=80, k=0). */
export const RETURN_PRIOR = Object.freeze({ requests: 80, misses: 0, sample: 20 });
/** The prefill speed assumed without a measured one (§6.2 prefill: 8,000 tokens/s, "假设"). */
export const ASSUMED_PREFILL = 8000;

/**
 * How long a target's prompt cache lives (§7.3 ttl(cacheTtl, auth)), in milliseconds; null when it cannot be told (`unknown`),
 * which is never warm. `auth_dependent` takes the shorter life of an API key (5 minutes) unless the authentication kind says
 * an account (1 hour): a cache is never judged warmer than it may be.
 */
export function cacheLifeMs(ttl: RelayCapabilities["cacheTtl"], authKind: string | null): number | null {
  switch (ttl) {
    case "5m": return 5 * 60_000;
    case "30m": return 30 * 60_000;
    case "1h": return 60 * 60_000;
    case "hours": return 2 * 60 * 60_000;
    case "auth_dependent": return authKind === "account" ? 60 * 60_000 : 5 * 60_000;
    case "unknown": return null;
  }
}
/** Warm (§7.3): the last request started less than 0.8 of the cache's life ago; never without a known start or life. */
export function warm(cache: BindingRelayState["cache"], ttl: RelayCapabilities["cacheTtl"], authKind: string | null, now: number): boolean {
  const life = cacheLifeMs(ttl, authKind), last = cache.lastRequestStartedAt;
  return life !== null && last !== null && now >= last && now - last < 0.8 * life;
}

/** A realized cache window of an earlier handoff (relay_deliveries.realized): its requests, and whether it closed (else it is still open: censored). */
export interface RealizedCount { readonly requests: number; readonly misses: number; readonly closed: boolean }
/**
 * R̂ and k̂ (§7.3 "生存估计"): the median requests per handoff by Kaplan–Meier over the latest 50 windows (an open window is
 * right-censored), and the median misses among closed ones; the prior (R=80, k=0) while fewer than 20 are known. A median the
 * curve never reaches is the largest observation (the estimate errs long, which favours showing the fresh option).
 */
export function survivalEstimate(windows: readonly RealizedCount[]): { readonly requests: number; readonly misses: number; readonly prior: boolean } {
  const recent = windows.slice(-50).filter(row => Number.isSafeInteger(row.requests) && row.requests >= 1);
  if (recent.length < RETURN_PRIOR.sample) return { requests: RETURN_PRIOR.requests, misses: RETURN_PRIOR.misses, prior: true };
  const times = [...new Set(recent.filter(row => row.closed).map(row => row.requests))].sort((a, b) => a - b);
  let survival = 1, median: number | null = null;
  for (const time of times) {
    const atRisk = recent.filter(row => row.requests >= time).length, ended = recent.filter(row => row.closed && row.requests === time).length;
    if (atRisk === 0) continue;
    survival *= 1 - ended / atRisk;
    if (survival <= 0.5) { median = time; break; }
  }
  const closed = recent.filter(row => row.closed).map(row => Math.max(0, Math.min(row.misses, row.requests - 1))).sort((a, b) => a - b);
  const misses = closed.length === 0 ? RETURN_PRIOR.misses : closed[Math.floor((closed.length - 1) / 2)]!;
  return { requests: median ?? Math.max(...recent.map(row => row.requests)), misses, prior: false };
}

/** Per-token prices in US dollars (§7.3 p_w for a write or a miss, p_r for a cache read); null for a subscription or an unknown authentication. */
export interface TokenPrice { readonly write: number; readonly read: number }
/** What one packet of T tokens costs over a window of R requests with k misses (§11.1): T·[p_w(1+k) + p_r(R−1−k)]. */
export function packetCost(tokens: number, requests: number, misses: number, price: TokenPrice): number {
  const k = Math.max(0, Math.min(misses, requests - 1));
  return tokens * (price.write * (1 + k) + price.read * Math.max(0, requests - 1 - k));
}

export interface ReturnInput {
  /** The returning binding's cache: when its last request started, the context it used and its window. */
  readonly cache: BindingRelayState["cache"];
  readonly cacheTtl: RelayCapabilities["cacheTtl"];
  readonly authKind: string | null;
  readonly now: number;
  /** |Δ|: the estimated tokens of what it was not told (the delta's facts). */
  readonly delta: number;
  /** T: the estimated tokens of a whole packet for a new native session. */
  readonly packet: number;
  /** S_new: the current words. */
  readonly input: number;
  /** S_A: the target's fixed prefix (system prompt and tools). */
  readonly fixedPrefix: number;
  /** W, the window the ratio N/W is read against; N is `cache.contextUsed`, or `fixedPrefix` when unknown. */
  readonly window: number;
  readonly price: TokenPrice | null;
  /** P̂, tokens per second. */
  readonly prefill: number;
  readonly requests: { readonly requests: number; readonly misses: number };
}
interface PathEstimate { readonly firstRequest: number | null; readonly perRequest: number | null; readonly latencyS: number }
export interface ReturnEstimate {
  readonly warm: boolean;
  readonly native: PathEstimate;
  readonly fresh: PathEstimate;
  /** What each later request costs more by continuing than by starting anew (the card's "每个后续请求 +$x"); null without a price. */
  readonly perRequestDiff: number | null;
  /** The whole-life difference: the first request's, plus each later one's over R̂ requests with k̂ misses; null without a price. */
  readonly wholeDiff: number | null;
  readonly latencyDiffS: number;
  /** N/W. */
  readonly windowShare: number;
  /** Whether "新开并附交接单" is shown beside "继续原会话" (D9). */
  readonly sideBySide: boolean;
}
/**
 * The two paths of a return (§7.3): continuing pays for the native context again (read when warm, written when cold) plus
 * what is new, and keeps it for every later request; a new session pays for its fixed prefix, the packet and the words. Only
 * an estimate (the window and prices may be assumed); never a reason to change what is sent.
 */
export function estimateReturn(input: ReturnInput): ReturnEstimate {
  const isWarm = warm(input.cache, input.cacheTtl, input.authKind, input.now), price = input.price, prefill = input.prefill > 0 ? input.prefill : ASSUMED_PREFILL;
  const native = Math.max(0, input.cache.contextUsed ?? input.fixedPrefix), delta = Math.max(0, input.delta), words = Math.max(0, input.input);
  const fresh = Math.max(0, input.fixedPrefix) + Math.max(0, input.packet) + words;
  const nativeLatency = (isWarm ? delta + words : native + delta + words) / prefill, freshLatency = fresh / prefill;
  const requests = Math.max(1, Math.floor(input.requests.requests)), misses = Math.max(0, Math.min(Math.floor(input.requests.misses), requests - 1));
  const nativeFirst = price === null ? null : native * (isWarm ? price.read : price.write) + (delta + words) * price.write;
  const freshFirst = price === null ? null : fresh * price.write;
  const perRequestDiff = price === null ? null : (native + delta - input.fixedPrefix - input.packet) * price.read;
  const missDiff = price === null ? null : (native + delta - input.fixedPrefix - input.packet) * price.write;
  const wholeDiff = nativeFirst === null || freshFirst === null || perRequestDiff === null || missDiff === null ? null
    : (nativeFirst - freshFirst) + (requests - 1 - misses) * perRequestDiff + misses * missDiff;
  const latencyDiffS = nativeLatency - freshLatency, windowShare = input.window > 0 ? native / input.window : 0;
  const sideBySide = (wholeDiff !== null && wholeDiff >= RETURN_THRESHOLDS.costUsd) || latencyDiffS >= RETURN_THRESHOLDS.latencyS || windowShare >= RETURN_THRESHOLDS.windowShare;
  return { warm: isWarm, native: { firstRequest: nativeFirst, perRequest: price === null ? null : (native + delta + words) * price.read, latencyS: nativeLatency },
    fresh: { firstRequest: freshFirst, perRequest: price === null ? null : fresh * price.read, latencyS: freshLatency }, perRequestDiff, wholeDiff, latencyDiffS, windowShare, sideBySide };
}

export type ReturnPreference = "continue" | "new_when_cold" | "ask";
/** The `relay.returnPreference` value (§7.3): "continue" when unset or unreadable. */
export function returnPreference(prefs: Readonly<Partial<Record<RelayPrefKey, string>>>): ReturnPreference {
  const value = prefs["relay.returnPreference"];
  return value === "new_when_cold" || value === "ask" ? value : "continue";
}
/**
 * What a return defaults to and whether the page asks (§7.3): the user's own `relay.native` decides when given; otherwise
 * "continue" — `new_when_cold` defaults to a new native session only when the cache is cold and the fresh path is shown
 * beside it, `ask` asks whenever it is shown beside. The Runtime sends what the request chose and nothing else.
 */
export function returnChoice(estimate: Pick<ReturnEstimate, "warm" | "sideBySide">, preference: ReturnPreference, requested: "continue" | "new" | undefined): { readonly choice: "continue" | "new"; readonly ask: boolean; readonly by: "request" | "preference" | "default" } {
  if (requested !== undefined) return { choice: requested, ask: false, by: "request" };
  if (preference === "new_when_cold" && !estimate.warm && estimate.sideBySide) return { choice: "new", ask: false, by: "preference" };
  if (preference === "ask") return { choice: "continue", ask: estimate.sideBySide, by: "preference" };
  return { choice: "continue", ask: false, by: "default" };
}
