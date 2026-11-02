// 原型，仅用于测量，不是实现。v1 §6.2 的单一策略解析器与预算选择。
// 默认值只在 resolveRelayPolicy 里出现；无效配置抛 PolicyError（明确失败，不回退）。
import { TIERS } from "./types.ts";
import type { Family, Tier } from "./types.ts";

export class PolicyError extends Error { constructor(message: string) { super(message); this.name = "PolicyError"; } }
export interface Price { readonly w: number; readonly r: number }
export interface RelayPolicy {
  readonly version: "relay/1";
  readonly tierCap: Readonly<Record<Tier, number>>;
  readonly untrustedCap: Readonly<Record<Tier, number>>;
  readonly mustHaveCap: number; readonly deltaCap: number; readonly deltaUserCap: number; readonly reanchorCap: number; readonly goalFloor: number;
  readonly latencyS: number; readonly costUsd: number; readonly assumedWindow: number; readonly windowShare: number; readonly prefillTokS: number;
  readonly fixedPrefix: number; readonly cliffMargin: number; readonly inputMargin: number; readonly omissionsReserve: number;
  /** 价格悬崖（文档常量，v1 §6.2）：键是模型前缀或 "family:openai"。 */
  readonly cliffs: Readonly<Record<string, number>>;
  /** 带日期的价格表，美元/百万 token（w：首次写入价，r：缓存读价）。取自第一轮 R6 的 cost-model.mjs（2026-11-02 读厂商页面），本原型未重新核实。 */
  readonly prices: { readonly date: string; readonly perMTok: Readonly<Record<string, Price>> };
  /** 生命期单价的默认 R̂（之后重读交接单的请求数）与 k̂（缓存失效次数），J2 M9；R6 的假设值。 */
  readonly lifetime: { readonly requests: number; readonly misses: number };
}
const DEFAULTS: RelayPolicy = {
  version: "relay/1",
  tierCap: { goal: 2000, brief: 4000, standard: 8000, fidelity: 16000, full: 32000 },
  untrustedCap: { goal: 300, brief: 1500, standard: 3000, fidelity: 8000, full: 24000 },
  mustHaveCap: 3000, deltaCap: 1500, deltaUserCap: 4000, reanchorCap: 600, goalFloor: 1200,
  latencyS: 1.5, costUsd: 0.20, assumedWindow: 128000, windowShare: 0.05, prefillTokS: 8000,
  fixedPrefix: 15000, cliffMargin: 16000, inputMargin: 4096, omissionsReserve: 300,
  cliffs: { "claude-haiku-5": 100000, "family:openai": 272000 },
  prices: { date: "2026-11-02", perMTok: {
    "claude-opus-5": { w: 5, r: 0.20 }, "claude-sonnet-5": { w: 2.5, r: 0.10 }, "gpt-6.1-sol": { w: 2.5, r: 0.10 },
    "gpt-5.5": { w: 5, r: 0.50 }, "deepseek-v4-flash": { w: 0.30, r: 0.006 }, "deepseek-v4-pro": { w: 1.32, r: 0.044 } } },
  lifetime: { requests: 80, misses: 0 },
};
const NUMERIC_KEYS = ["mustHaveCap", "deltaCap", "deltaUserCap", "reanchorCap", "goalFloor", "latencyS", "costUsd", "assumedWindow", "windowShare", "prefillTokS", "fixedPrefix", "cliffMargin", "inputMargin", "omissionsReserve"] as const;

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new PolicyError(label + " must be an object");
  return value as Record<string, unknown>;
}
function positive(value: unknown, label: string, integer: boolean): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || (integer && !Number.isSafeInteger(value))) throw new PolicyError(label + " must be a positive " + (integer ? "integer" : "number"));
  return value;
}
function tiers(value: unknown, base: Readonly<Record<Tier, number>>, label: string): Record<Tier, number> {
  const input = record(value, label), out = { ...base };
  for (const key of Object.keys(input)) { if (!(TIERS as readonly string[]).includes(key)) throw new PolicyError(label + ": unknown tier " + key); out[key as Tier] = positive(input[key], label + "." + key, true); }
  return out;
}
/** 唯一的策略解析器：外部输入先收敛为 unknown；未知键、非正数、档位不单调、不可信上限大于档位上限都明确失败。 */
export function resolveRelayPolicy(overrides: unknown = {}): RelayPolicy {
  const input = record(overrides, "relay policy");
  const allowed = new Set<string>(["tierCap", "untrustedCap", "cliffs", "lifetime", ...NUMERIC_KEYS]);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new PolicyError("relay policy: unknown key " + key);
  const tierCap = input.tierCap === undefined ? DEFAULTS.tierCap : tiers(input.tierCap, DEFAULTS.tierCap, "tierCap");
  const untrustedCap = input.untrustedCap === undefined ? DEFAULTS.untrustedCap : tiers(input.untrustedCap, DEFAULTS.untrustedCap, "untrustedCap");
  const numbers: Record<string, number> = {};
  for (const key of NUMERIC_KEYS) numbers[key] = input[key] === undefined ? DEFAULTS[key] : positive(input[key], key, !["latencyS", "costUsd", "windowShare"].includes(key));
  for (let i = 1; i < TIERS.length; i++) if (tierCap[TIERS[i]!] < tierCap[TIERS[i - 1]!]) throw new PolicyError("tierCap must not decrease from " + TIERS[i - 1] + " to " + TIERS[i]);
  for (const t of TIERS) if (untrustedCap[t] > tierCap[t]) throw new PolicyError("untrustedCap." + t + " exceeds tierCap." + t);
  if (numbers.goalFloor! > tierCap.goal) throw new PolicyError("goalFloor exceeds tierCap.goal");
  if (numbers.windowShare! > 1) throw new PolicyError("windowShare must be at most 1");
  if (numbers.deltaCap! > numbers.deltaUserCap!) throw new PolicyError("deltaCap exceeds deltaUserCap");
  const cliffs = input.cliffs === undefined ? DEFAULTS.cliffs : Object.fromEntries(Object.entries(record(input.cliffs, "cliffs")).map(([k, v]) => [k, positive(v, "cliffs." + k, true)]));
  const lifetimeInput = input.lifetime === undefined ? DEFAULTS.lifetime : record(input.lifetime, "lifetime");
  const requests = positive(lifetimeInput.requests, "lifetime.requests", true);
  const misses = lifetimeInput.misses === 0 ? 0 : positive(lifetimeInput.misses, "lifetime.misses", true);
  if (misses > requests - 1) throw new PolicyError("lifetime.misses must be below lifetime.requests");
  return Object.freeze({ ...DEFAULTS, ...numbers, tierCap, untrustedCap, cliffs, lifetime: { requests, misses } }) as RelayPolicy;
}

export interface TargetSpec {
  readonly harnessId: string; readonly controlId: string; readonly model: string | null; readonly family: Family;
  readonly documentedWindow: number | null;
  readonly placement: { readonly parts: "multiple" | "single"; readonly maxInput: { readonly unit: "chars" | "bytes"; readonly limit: number } | null };
}
export interface BindingWindow { readonly contextSize: number | null; readonly contextUsed: number | null; readonly observedWindow: number | null }
export type ClampReason = "window" | "cliff" | "latency" | "cost" | "input_limit";
export interface Budget {
  readonly tier: Tier; readonly T: number; readonly untrustedCap: number;
  readonly inputCap: { readonly unit: "chars" | "bytes"; readonly limit: number } | null;
  readonly window: number; readonly windowSource: "session_report" | "observed_recent" | "documented" | "assumed";
  readonly caps: { readonly tier: number; readonly window: number; readonly cliff: number | null; readonly latency: number; readonly cost: number | null; readonly hard: number };
  readonly clampedBy: readonly ClampReason[]; readonly cliffGuard: boolean; readonly lifetimeUsdPerToken: number | null;
}
export type BudgetResult = { readonly kind: "ok"; readonly budget: Budget } | { readonly kind: "blocked"; readonly code: "RELAY_INPUT_LIMIT"; readonly reason: string; readonly hardCap: number };

function lookup<T>(table: Readonly<Record<string, T>>, model: string | null): T | null {
  if (model === null) return null;
  let best: string | null = null;
  for (const key of Object.keys(table)) if (!key.startsWith("family:") && model.startsWith(key) && (best === null || key.length > best.length)) best = key;
  return best === null ? null : table[best]!;
}

/** v1 §6.2 chooseBudget：窗口份额、价格悬崖、时延与费用（只压低默认档）、通道输入上限。 */
export function chooseBudget(policy: RelayPolicy, target: TargetSpec, binding: BindingWindow, options: { readonly userTier?: Tier; readonly currentInput: string }): BudgetResult {
  let W: number, src: Budget["windowSource"];
  if (binding.contextSize !== null) { W = binding.contextSize; src = "session_report"; }
  else if (binding.observedWindow !== null) { W = binding.observedWindow; src = "observed_recent"; }
  else if (target.documentedWindow !== null) { W = target.documentedWindow; src = "documented"; }
  else { W = policy.assumedWindow; src = "assumed"; }
  const capWindow = Math.floor(W * policy.windowShare);
  const cliff = lookup(policy.cliffs, target.model) ?? (policy.cliffs["family:" + target.family] ?? null);
  const capCliff = cliff === null ? null : cliff - (binding.contextUsed ?? 0) - policy.fixedPrefix - policy.cliffMargin;
  const capLatency = Math.floor(policy.latencyS * policy.prefillTokS);
  const price = lookup(policy.prices.perMTok, target.model);
  const R = policy.lifetime.requests, k = policy.lifetime.misses;
  const pi = price === null ? null : (price.w * (1 + k) + price.r * (R - 1 - k)) / 1e6;
  const capCost = pi === null ? null : Math.floor(policy.costUsd / pi);
  const hard = Math.min(capWindow, capCliff ?? Infinity, policy.tierCap.full);
  if (hard < policy.goalFloor) return { kind: "blocked", code: "RELAY_INPUT_LIMIT", reason: capCliff !== null && capCliff === hard ? "price_cliff" : "window", hardCap: hard };
  const tier = options.userTier ?? "standard";
  const soft = options.userTier !== undefined ? Infinity : Math.min(capLatency, capCost ?? Infinity);
  const T = Math.min(policy.tierCap[tier], hard, soft);
  const clampedBy: ClampReason[] = [];
  if (capWindow < policy.tierCap[tier] && capWindow === T) clampedBy.push("window");
  if (capCliff !== null && capCliff < policy.tierCap[tier] && capCliff === T) clampedBy.push("cliff");
  if (options.userTier === undefined && capLatency < policy.tierCap[tier] && capLatency === T) clampedBy.push("latency");
  if (options.userTier === undefined && capCost !== null && capCost < policy.tierCap[tier] && capCost === T) clampedBy.push("cost");
  let inputCap: Budget["inputCap"] = null;
  if (target.placement.maxInput !== null) {
    const used = target.placement.maxInput.unit === "bytes" ? Buffer.byteLength(options.currentInput, "utf8") : options.currentInput.length;
    const limit = target.placement.maxInput.limit - used - policy.inputMargin;
    if (limit <= 0) return { kind: "blocked", code: "RELAY_INPUT_LIMIT", reason: "input_limit", hardCap: hard };
    inputCap = { unit: target.placement.maxInput.unit, limit };
  }
  return { kind: "ok", budget: { tier, T, untrustedCap: Math.min(policy.untrustedCap[tier], T), inputCap, window: W, windowSource: src,
    caps: { tier: policy.tierCap[tier], window: capWindow, cliff: capCliff, latency: capLatency, cost: capCost, hard },
    clampedBy, cliffGuard: capCliff !== null, lifetimeUsdPerToken: pi } };
}
