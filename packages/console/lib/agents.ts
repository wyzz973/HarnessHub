// SPDX-License-Identifier: MIT
/** Presentation rules of the agent pages; pure functions over `/api/v1/agents` records. */
import type {
  Agent,
  AgentWiringInput,
  ReasoningEffort,
  WiringTier,
} from "@harnesshub/sdk/client";
import type { GatewayModels } from "./gateway-models";

export const installationText: Record<
  Agent["installation"]["status"],
  { label: string; tone: string }
> = {
  installed: { label: "已安装", tone: "good" },
  "configured-only": { label: "只有配置", tone: "" },
  "not-found": { label: "未发现", tone: "" },
};

export const driftText: Record<string, string> = {
  unwired: "未接到网关",
  replaced: "接线字段被改",
  "foreign-gateway": "指向其他网关",
};

export const driftReasonText: Record<string, string> = {
  missing: "缺失",
  changed: "被修改",
  "other-key": "换成了别的 Key",
  "file-missing": "文件不存在",
  unreadable: "无法读取",
};

export const tierText: Record<WiringTier, string> = {
  opus: "Opus 档",
  sonnet: "Sonnet 档",
  haiku: "Haiku 档",
  fable: "Fable 档",
  subagent: "子 Agent",
};

const tierLabels = new Map<string, string>(Object.entries(tierText));
/** The label of a tier name read from a record keyed by string. */
export function tierLabel(tier: string): string {
  return tierLabels.get(tier) ?? tier;
}

export const effortText: Record<ReasoningEffort, string> = {
  none: "不推理",
  minimal: "最少",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "很高",
  max: "最高",
};

/** Labels of adapter options and their values; unknown ones show as written. */
export const optionText: Record<
  string,
  { label: string; values: Record<string, string> }
> = {
  codexAuth: {
    label: "Codex 登录方式",
    values: {
      "gateway-key": "Gateway Key：经网关调用所选模型",
      chatgpt: "ChatGPT 登录：保留 Codex 自己的登录，请求经网关转发",
    },
  },
};

/**
 * Whether these options make the agent sign in by itself, without a key,
 * model, tiers or effort (Codex with `codexAuth: chatgpt`; 04 section 4).
 */
export function keylessOptions(options: Record<string, string> | undefined) {
  return options?.codexAuth === "chatgpt";
}

/** Why an agent needs attention; empty when it does not. */
export function attention(agent: Agent, models?: GatewayModels): string[] {
  const wiring = agent.wiring;
  if (!wiring) return [];
  const reasons: string[] = [];
  if (agent.installation.status === "not-found")
    reasons.push("已接线，但本机找不到这个 Agent");
  if (wiring.driftError) reasons.push("无法检查配置文件");
  else if (wiring.drift?.drifted)
    reasons.push(
      `配置文件被改动：${wiring.drift.kinds.map((kind) => driftText[kind] ?? kind).join("、")}`,
    );
  if (["revoked", "expired", "missing"].includes(wiring.keyState))
    reasons.push(
      wiring.keyState === "missing" ? "它的 Key 不存在" : "它的 Key 已失效",
    );
  if (models) {
    const gone = [wiring.model, ...Object.values(wiring.tiers ?? {})].filter(
      (ref): ref is string => ref !== undefined && !models.byRef.has(ref),
    );
    if (gone.length)
      reasons.push(`网关不再提供 ${[...new Set(gone)].join("、")}`);
  }
  return reasons;
}

/** Whether `ref` matches one entry of a wiring's model list (`*`, `provider/*` or a Ref). */
function listed(patterns: readonly string[], ref: string) {
  return patterns.some(
    (pattern) =>
      pattern === "*" ||
      pattern === ref ||
      (pattern.endsWith("/*") && ref.startsWith(pattern.slice(0, -1))),
  );
}

/**
 * The gateway models an agent may list: those of its model list (which no
 * longer holds the hidden ones) and the hidden ones, in the gateway's order;
 * of those the ones not hidden are shown. M counts the first, N the second.
 */
export function modelVisibility(agent: Agent, models: GatewayModels) {
  const wiring = agent.wiring;
  const all = [...models.byRef.keys()];
  if (!wiring) return { allowed: all, shown: all };
  const patterns = [...wiring.models, ...wiring.hidden];
  const allowed = all.filter((ref) => listed(patterns, ref));
  const hidden = new Set(wiring.hidden);
  return { allowed, shown: allowed.filter((ref) => !hidden.has(ref)) };
}

/** The editable wiring of one agent: what the detail form holds. */
export interface WiringDraft {
  model: string | undefined;
  tiers: Partial<Record<WiringTier, string>>;
  effort: ReasoningEffort | undefined;
  options: Record<string, string>;
}

/** The current wiring as a draft; options default to the adapter's first value. */
export function draftOf(agent: Agent): WiringDraft {
  const wiring = agent.wiring;
  return {
    model: wiring?.model,
    tiers: { ...wiring?.tiers },
    effort: wiring?.effort,
    options: Object.fromEntries(
      Object.entries(agent.capabilities.options).map(([name, values]) => [
        name,
        wiring?.options?.[name] ?? values[0] ?? "",
      ]),
    ),
  };
}

/**
 * The request for a draft. A keyless choice sends only the options; tiers
 * are always sent so cleared ones are removed, effort `null` clears it.
 */
export function wiringInput(
  agent: Agent,
  draft: WiringDraft,
): AgentWiringInput {
  const options = Object.keys(draft.options).length
    ? { options: draft.options }
    : {};
  if (keylessOptions(draft.options)) return options;
  const tiers = Object.fromEntries(
    Object.entries(draft.tiers).filter(([, ref]) => ref),
  );
  return {
    ...(draft.model ? { model: draft.model } : {}),
    ...(agent.capabilities.tiers.length ? { tiers } : {}),
    ...(agent.capabilities.efforts.length
      ? { effort: draft.effort ?? null }
      : {}),
    ...options,
  };
}
