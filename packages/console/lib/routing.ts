// SPDX-License-Identifier: MIT
/**
 * Route groups, their rules and the decisions they make, and Gateway Key
 * budgets, as the Routing and Key pages present and edit them. Members and
 * typed rules are read by the same code as the daemon and `hh group rule`
 * (`@harnesshub/sdk/route-rules`), so the editor marks the word the daemon
 * would refuse before anything is sent.
 */
import type {
  BudgetPeriod,
  GatewayKeyBudget,
  GatewayKeyQuota,
  GroupRule,
  KeyBudgetStatus,
  ProviderConfig,
  ReasoningEffort,
  RouteDecision,
  RouteDecisionPage,
  RouteDecisionRule,
} from "@harnesshub/sdk/client";
import {
  cleanRule,
  faultySpans,
  memberText,
  parseGroupMember,
  parseRule,
  reasoningEfforts,
  ruleKey,
  ruleLine,
  RuleSyntaxError,
  ruleWords,
  ruleWordSpans,
  type RuleWord,
} from "@harnesshub/sdk/route-rules";

/** One member of a group as the editor shows it. */
export interface MemberRow {
  kind: "model" | "group";
  /** `provider/model`, or `group/<id>`. */
  ref: string;
  /** The effort the member is fixed at; none follows the request. */
  effort?: ReasoningEffort;
  fast: boolean;
}

/** A member as written, read as `route-groups` reads it; a colon of a model the provider lists stays in the model. */
export function memberRow(
  text: string,
  providers: readonly ProviderConfig[],
): MemberRow {
  const member = parseGroupMember(text, (provider, model) =>
    providers.some(
      (item) =>
        item.id === provider &&
        item.models.list.some((entry) => entry.id === model),
    ),
  );
  if (member?.kind === "group")
    return { kind: "group", ref: `group/${member.group}`, fast: false };
  if (member?.kind === "model")
    return {
      kind: "model",
      ref: member.ref,
      ...(member.effort ? { effort: member.effort } : {}),
      fast: member.fast,
    };
  return { kind: "model", ref: text, fast: false };
}

/** A member row as the group stores it: `provider/model:high:fast`. */
export function memberRowText(row: MemberRow): string {
  if (row.kind === "group") return row.ref;
  const named = parseGroupMember(row.ref);
  if (named?.kind !== "model") return row.ref;
  return memberText({
    ...named,
    ...(row.effort ? { effort: row.effort } : {}),
    fast: row.fast,
  });
}

/** The efforts a member can be fixed at, after "follows the request". */
export const memberEfforts: readonly ReasoningEffort[] = reasoningEfforts;

/** The keys a typed rule spells each field with (what a problem of that field marks). */
const fieldKeys: Readonly<Record<string, readonly string[]>> = {
  use: ["use", "model", "to"],
  tokens: ["tokens", "context", "longer"],
  images: ["images", "image"],
  effort: ["effort", "reasoning", "thinking"],
  agents: ["agents", "agent"],
  intent: ["intent", "asks", "about"],
  compact: ["compact", "compacting", "compaction"],
  time: ["time", "hours", "between", "days", "day"],
};

/** What a typed rule reads as: the rule, or why not and the words at fault. */
export type TypedRuleResult =
  | {
      ok: true;
      rule: GroupRule;
      /** The place asked for with `at=`, from 1. */
      at?: number;
      /** The classifier given with `classifier=`. */
      classifier?: string;
      /** The rule as it reads back. */
      line: string;
    }
  | { ok: false; message: string; spans: RuleWord[] };

/**
 * Read a typed rule (`use=a/m tokens=200k images …`) among `members` as the
 * daemon would: a word it cannot read, a field it refuses, or an intent
 * without a classifier is the error, with the words to mark.
 */
export function readTypedRule(
  text: string,
  members: readonly string[],
  groupId: string,
  hasClassifier: boolean,
): TypedRuleResult {
  let typed;
  try {
    typed = parseRule(members, groupId, ruleWords(text));
  } catch (error) {
    if (error instanceof RuleSyntaxError)
      return {
        ok: false,
        message: error.message,
        spans: faultySpans(text, error.word),
      };
    throw error;
  }
  const { rule, problems } = cleanRule(typed.rule, members, "");
  const problem = problems[0];
  if (problem) {
    const field = problem.pointer.split("/")[1] ?? "";
    const keys = fieldKeys[field] ?? [];
    return {
      ok: false,
      message: field ? `${field} ${problem.detail}` : problem.detail,
      spans: ruleWordSpans(text).filter((span) =>
        keys.includes(ruleKey(span.word)),
      ),
    };
  }
  if (rule.intent && !typed.classifier && !hasClassifier)
    return {
      ok: false,
      message:
        "带 intent 的规则需要组的分类器（判断消息属于哪种意图的模型）：在这一行加上 classifier=<provider/model>，或先在下方选择分类器",
      spans: ruleWordSpans(text).filter((span) =>
        fieldKeys.intent!.includes(ruleKey(span.word)),
      ),
    };
  return {
    ok: true,
    rule,
    ...(typed.at !== undefined ? { at: typed.at } : {}),
    ...(typed.classifier !== undefined ? { classifier: typed.classifier } : {}),
    line: ruleLine(rule),
  };
}

/** `text` cut into parts, those inside `spans` marked, for showing the words at fault. */
export function markedParts(
  text: string,
  spans: readonly RuleWord[],
): { text: string; marked: boolean }[] {
  const out: { text: string; marked: boolean }[] = [];
  let at = 0;
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    if (span.start < at) continue;
    if (span.start > at)
      out.push({ text: text.slice(at, span.start), marked: false });
    out.push({ text: text.slice(span.start, span.end), marked: true });
    at = span.end;
  }
  if (at < text.length) out.push({ text: text.slice(at), marked: false });
  return out;
}

/** The rules' errors the daemon returned, by rule: `/rules/2/tokens` is rule 3's. */
export function ruleFailures(
  fields: Readonly<Record<string, string>>,
): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const [pointer, detail] of Object.entries(fields)) {
    const match = /^\/rules\/(\d+)(\/.*)?$/.exec(pointer);
    if (!match) continue;
    const index = Number(match[1]);
    const field = match[2]?.split("/")[1];
    out.set(index, [
      ...(out.get(index) ?? []),
      field ? `${field} ${detail}` : detail,
    ]);
  }
  return out;
}

/** Move the item at `from` to `to` (both indexes); other items keep their order. */
export function moved<T>(items: readonly T[], from: number, to: number): T[] {
  const out = [...items];
  if (from < 0 || from >= out.length || to < 0 || to >= out.length) return out;
  const [item] = out.splice(from, 1);
  out.splice(to, 0, item!);
  return out;
}

// Gateway Key budgets.

export const budgetPeriodNames: Readonly<Record<BudgetPeriod, string>> = {
  day: "每天",
  week: "每周",
  month: "每月",
};
const periods: readonly BudgetPeriod[] = ["day", "week", "month"];

/** The quota form: requests per minute, and one budget per period. */
export interface QuotaForm {
  rpm: string;
  budgets: Record<
    BudgetPeriod,
    { on: boolean; tokens: string; cost: string; cacheReads: boolean }
  >;
}

export function quotaFormOf(quota: GatewayKeyQuota | undefined): QuotaForm {
  const budget = (period: BudgetPeriod) => {
    const found = quota?.budgets?.find((item) => item.period === period);
    return {
      on: found !== undefined,
      tokens: found?.tokens === undefined ? "" : String(found.tokens),
      cost: found?.costUsd === undefined ? "" : String(found.costUsd),
      cacheReads: found?.cacheReads === true,
    };
  };
  return {
    rpm:
      quota?.requestsPerMinute === undefined
        ? ""
        : String(quota.requestsPerMinute),
    budgets: {
      day: budget("day"),
      week: budget("week"),
      month: budget("month"),
    },
  };
}

/**
 * The quota a form gives, or its problems by field (`rpm`, `day.tokens`,
 * `week`…); none when nothing is set. Caps are whole tokens or dollars of
 * 0 or more (0 refuses every call of the window); a budget turned on needs
 * one of them.
 */
export function quotaOf(
  form: QuotaForm,
):
  | { ok: true; quota: GatewayKeyQuota | undefined }
  | { ok: false; problems: Record<string, string> } {
  const problems: Record<string, string> = {};
  const quota: GatewayKeyQuota = {};
  const rpm = form.rpm.trim();
  if (rpm) {
    if (!/^\d+$/.test(rpm) || Number(rpm) < 1)
      problems.rpm = "每分钟请求数是大于 0 的整数";
    else quota.requestsPerMinute = Number(rpm);
  }
  const budgets: GatewayKeyBudget[] = [];
  for (const period of periods) {
    const fields = form.budgets[period];
    if (!fields.on) continue;
    const budget: GatewayKeyBudget = { period };
    const tokens = fields.tokens.trim();
    const cost = fields.cost.trim();
    if (tokens) {
      if (!/^\d+$/.test(tokens))
        problems[`${period}.tokens`] = "token 上限是 0 或更大的整数";
      else budget.tokens = Number(tokens);
    }
    if (cost) {
      if (!/^\d+(\.\d+)?$/.test(cost))
        problems[`${period}.cost`] = "成本上限是 0 或更大的美元数";
      else budget.costUsd = Number(cost);
    }
    if (!tokens && !cost)
      problems[period] = "至少填写 token 或成本中的一个上限";
    if (fields.cacheReads) budget.cacheReads = true;
    budgets.push(budget);
  }
  if (Object.keys(problems).length) return { ok: false, problems };
  if (budgets.length) quota.budgets = budgets;
  return {
    ok: true,
    quota: Object.keys(quota).length ? quota : undefined,
  };
}

function tokenCount(value: number): string {
  if (value >= 1_000_000 && value % 10_000 === 0)
    return `${value / 1_000_000} 百万`;
  return value.toLocaleString();
}

/** A quota in words: `60 次/分钟`、`每天 2 百万 token（含缓存读取）`、`每月 $20`. */
export function quotaSummary(quota: GatewayKeyQuota | undefined): string[] {
  if (!quota) return [];
  return [
    ...(quota.requestsPerMinute !== undefined
      ? [`${quota.requestsPerMinute} 次/分钟`]
      : []),
    ...(quota.budgets ?? []).map((budget) => {
      const caps = [
        ...(budget.tokens !== undefined
          ? [
              budget.tokens === 0
                ? "0 token（拒绝所有调用）"
                : `${tokenCount(budget.tokens)} token${budget.cacheReads ? "（含缓存读取）" : ""}`,
            ]
          : []),
        ...(budget.costUsd !== undefined
          ? [budget.costUsd === 0 ? "$0（拒绝所有调用）" : `$${budget.costUsd}`]
          : []),
      ];
      return `${budgetPeriodNames[budget.period]} ${caps.join("、")}`;
    }),
  ];
}

/** How much of one budget is used and held, as shares of its caps (0 to 1). */
export function budgetUse(status: KeyBudgetStatus): {
  tokens?: { used: number; held: number; limit: number; share: number };
  cost?: { used: number; held: number; limit: number; share: number };
} {
  const share = (used: number, held: number, limit: number) =>
    limit === 0 ? 1 : Math.min(1, (used + held) / limit);
  return {
    ...(status.tokenLimit !== undefined
      ? {
          tokens: {
            used: status.tokens,
            held: status.reservedTokens,
            limit: status.tokenLimit,
            share: share(
              status.tokens,
              status.reservedTokens,
              status.tokenLimit,
            ),
          },
        }
      : {}),
    ...(status.costLimitUsd !== undefined
      ? {
          cost: {
            used: status.costUsd,
            held: status.reservedCostUsd,
            limit: status.costLimitUsd,
            share: share(
              status.costUsd,
              status.reservedCostUsd,
              status.costLimitUsd,
            ),
          },
        }
      : {}),
  };
}

// Route decisions.

/** Decisions the trace view keeps. */
export const DECISIONS_SHOWN = 200;

/**
 * The decisions shown after a page: a decision read again (its call ended)
 * replaces the earlier copy; newest first, at most {@link DECISIONS_SHOWN}.
 */
export function mergeDecisions(
  current: readonly RouteDecision[],
  page: RouteDecisionPage,
): RouteDecision[] {
  const byCall = new Map(current.map((item) => [item.callId, item]));
  for (const item of page.items) byCall.set(item.callId, item);
  return [...byCall.values()]
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.seq - a.seq)
    .slice(0, DECISIONS_SHOWN);
}

export const decisionKinds: Readonly<
  Record<RouteDecisionRule["kind"], string>
> = {
  turn: "新一轮",
  grown: "超出窗口后改换",
  compact: "压缩请求",
  held: "沿用本轮的决定",
  waits: "没见到这一轮的开头",
};

/** What one group's rules did: `规则 2 → a/m（tokens ≥ 200000）`. */
export function ruleDecisionText(rule: RouteDecisionRule): string {
  if (!rule.n)
    return rule.kind === "held" || rule.kind === "waits"
      ? decisionKinds[rule.kind]
      : "没有规则命中，按组的策略排列";
  const when = rule.when?.length ? `（${rule.when.join("，")}）` : "";
  const instead = rule.unready
    ? rule.instead
      ? `；它没有就绪的凭据，改由 ${rule.instead} 先试`
      : "；它没有就绪的凭据，按组的策略排列"
    : "";
  return `规则 ${rule.n} → ${rule.use ?? "?"}${when}${instead}`;
}

/** A conversation the decisions came from, for choosing one to follow. */
export interface DecisionSession {
  key: string;
  agent?: string;
  requested: string;
  lastAt: string;
}

/** The conversations of `decisions` and those known before, the latest first, each once. */
export function decisionSessions(
  known: readonly DecisionSession[],
  decisions: readonly RouteDecision[],
): DecisionSession[] {
  const byKey = new Map(known.map((item) => [item.key, item]));
  for (const decision of decisions) {
    const before = byKey.get(decision.conversation);
    if (before && Date.parse(before.lastAt) >= Date.parse(decision.at))
      continue;
    byKey.set(decision.conversation, {
      key: decision.conversation,
      ...(decision.agent ? { agent: decision.agent } : {}),
      requested: decision.requested,
      lastAt: decision.at,
    });
  }
  return [...byKey.values()].sort(
    (a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt),
  );
}

/** What the classifier said: `judge 判断：意图是 a quick question`. */
export function classifierText(
  classifier: NonNullable<RouteDecisionRule["classifier"]>,
): string {
  if (classifier.resting)
    return `${classifier.by} 刚失败过，30 秒内不再询问：${classifier.error ?? ""}`;
  if (classifier.error) return `${classifier.by} 没能判断：${classifier.error}`;
  const parts = [
    ...(classifier.intents.length
      ? [
          classifier.intent
            ? `意图是 ${classifier.intent}`
            : "不属于任何一种意图",
        ]
      : []),
    ...(classifier.effort ? [`需要 ${classifier.effort} 推理`] : []),
  ];
  return `${classifier.by} 判断：${parts.join("，")}${classifier.cached ? "（10 分钟内问过同一消息，用的是那次的回答）" : ""}`;
}

/** Stickiness in words: `hit` → 留在上次应答的凭据. */
export function stickyText(sticky: string | undefined): string | undefined {
  if (sticky === undefined) return undefined;
  const [state, why] = sticky.split(":", 2);
  if (state === "hit") return "留在上次应答的凭据";
  const reasons: Record<string, string> = {
    new: "新会话",
    model_changed: "换了模型",
    cache_cold: "提示缓存已冷",
    new_turn: "新的一轮",
    breaker: "上次的凭据在休息",
    unavailable: "上次的凭据已不可用",
    rule: "规则把它换到了别的成员",
  };
  const reason = why === undefined ? "" : (reasons[why] ?? why);
  return state === "broken" ? `粘性被打破：${reason}` : `没有沿用：${reason}`;
}
