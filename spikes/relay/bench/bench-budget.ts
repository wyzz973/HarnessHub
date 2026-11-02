// 原型，仅用于测量，不是实现。(b) 预算解析器：v1 §6.2 的典型输入与无效配置。数字是解析器的输出（文档常量 + 原型假设的窗口与价格），不是实测。
import { chooseBudget, PolicyError, resolveRelayPolicy } from "../proto/budget.ts";
import type { BindingWindow, TargetSpec } from "../proto/budget.ts";
import type { Tier } from "../proto/types.ts";
import { now, summary } from "./common.ts";

const spec = (model: string | null, family: TargetSpec["family"], documentedWindow: number | null, maxInput: TargetSpec["placement"]["maxInput"] = null): TargetSpec =>
  ({ harnessId: "h", controlId: "c", model, family, documentedWindow, placement: { parts: "multiple", maxInput } });
const win = (contextSize: number | null, contextUsed: number | null = null): BindingWindow => ({ contextSize, contextUsed, observedWindow: null });

export function run(): Record<string, unknown> {
  const policy = resolveRelayPolicy();
  const cases: { name: string; target: TargetSpec; window: BindingWindow; tier?: Tier; input?: string }[] = [
    { name: "窗口未知（按 128k）· Claude Opus 5.5 · 默认档", target: spec("claude-opus-5-5", "anthropic", null), window: win(null) },
    { name: "窗口未知 · 用户选完整档", target: spec("claude-opus-5-5", "anthropic", null), window: win(null), tier: "full" },
    { name: "Codex gpt-6.1-sol · 会话报告 400k · 默认档", target: spec("gpt-6.1-sol", "openai", null, { unit: "chars", limit: 1048576 }), window: win(400000) },
    { name: "GPT-5.5 · 400k · 默认档（费用压低）", target: spec("gpt-5.5", "openai", null), window: win(400000) },
    { name: "GPT-5.5 · 400k · 用户选标准档（费用不压低用户选择）", target: spec("gpt-5.5", "openai", null), window: win(400000), tier: "standard" },
    { name: "dsh deepseek-v4-flash · 文档 1M · 完整档", target: spec("deepseek-v4-flash", "deepseek", 1000000), window: win(null), tier: "full" },
    { name: "dsh · 1M · 保真档", target: spec("deepseek-v4-flash", "deepseek", 1000000), window: win(null), tier: "fidelity" },
    { name: "Claude Haiku 5.5 · 新会话（已用 0）", target: spec("claude-haiku-5-5", "anthropic", 200000), window: win(null, 0) },
    { name: "Claude Haiku 5.5 · 返回时已用 75k（价格悬崖）", target: spec("claude-haiku-5-5", "anthropic", 200000), window: win(200000, 75000) },
    { name: "本地小模型 · 窗口 16k", target: spec("local-q4", "unknown", 16000), window: win(null) },
    { name: "Codex · 原话 1,040,000 字符（逼近 1,048,576 上限）", target: spec("gpt-6.1-sol", "openai", null, { unit: "chars", limit: 1048576 }), window: win(400000), input: "x".repeat(1040000) },
    { name: "Codex · 原话 1,046,000 字符（超过上限 − 4,096 余量）", target: spec("gpt-6.1-sol", "openai", null, { unit: "chars", limit: 1048576 }), window: win(400000), input: "x".repeat(1046000) },
  ];
  const rows = cases.map(c => {
    const r = chooseBudget(policy, c.target, c.window, { currentInput: c.input ?? "继续", ...(c.tier === undefined ? {} : { userTier: c.tier }) });
    return r.kind === "blocked" ? { name: c.name, outcome: "blocked", code: r.code, reason: r.reason, hardCap: r.hardCap }
      : { name: c.name, outcome: "ok", tier: r.budget.tier, T: r.budget.T, untrustedCap: r.budget.untrustedCap, window: r.budget.window, windowSource: r.budget.windowSource, clampedBy: r.budget.clampedBy, caps: r.budget.caps, inputCap: r.budget.inputCap, lifetimeUsdPerToken: r.budget.lifetimeUsdPerToken };
  });
  // 无效配置必须明确失败（每条规则一个无效样例）
  const invalid: [string, unknown][] = [
    ["未知键", { tierCapp: {} }], ["未知档位", { tierCap: { huge: 1 } }], ["非正数", { deltaCap: 0 }], ["非整数", { goalFloor: 1.5 }], ["档位递减", { tierCap: { brief: 1000 } }],
    ["不可信上限大于档位", { untrustedCap: { goal: 2500 } }], ["下限大于只交目标档", { goalFloor: 2500 }], ["窗口份额 > 1", { windowShare: 1.5 }], ["增量上限大于扩展上限", { deltaCap: 5000 }],
    ["k̂ > R̂ − 1", { lifetime: { requests: 2, misses: 2 } }], ["不是对象", 42],
  ];
  const rejected = invalid.map(([name, cfg]) => { try { resolveRelayPolicy(cfg); return { name, rejected: false }; } catch (e) { return { name, rejected: e instanceof PolicyError, message: (e as Error).message }; } });
  const t = spec("gpt-6.1-sol", "openai", null), w = win(400000);
  const xs: number[] = [];
  for (let i = 0; i < 2000; i++) { const a = now(); chooseBudget(policy, t, w, { currentInput: "继续" }); xs.push(now() - a); }
  // 由 5%·W 推出的“某档要多大的窗口才不被压低”
  const windowNeeded = Object.fromEntries((["goal", "brief", "standard", "fidelity", "full"] as const).map(tt => [tt, Math.ceil(policy.tierCap[tt] / policy.windowShare)]));
  return { rows, rejected, allRejected: rejected.every(r => r.rejected), chooseBudgetMs: summary(xs, 5), windowNeededForTier: windowNeeded };
}

if (import.meta.main) console.log(JSON.stringify(run(), null, 2));
