// SPDX-License-Identifier: MIT
/**
 * The gateway's routing state of each credential (`/api/v1/routing/state`):
 * its breaker, the rest after a failure and the allowance readings that the
 * `smart` and `pace` strategies use. The daemon holds it in memory; this
 * module only presents it.
 */
import type {
  AllowanceReading,
  CredentialRoutingState,
} from "@harnesshub/sdk/client";

export const breakerStates: Record<
  CredentialRoutingState["state"],
  { label: string; tone: "good" | "warn" | "info"; hint: string }
> = {
  closed: { label: "正常", tone: "good", hint: "网关照常使用这个凭据" },
  open: {
    label: "休息中",
    tone: "warn",
    hint: "失败后暂停使用，到期后放行一次探测",
  },
  "half-open": {
    label: "待探测",
    tone: "info",
    hint: "休息已结束，下一次请求用来探测它是否恢复",
  },
};

/** The ledger's error classes of upstream failures (gateway `failureClass`). */
const errorClasses: Readonly<Record<string, string>> = {
  proxy_failed: "代理连接失败",
  verification_required: "账号需要验证",
  auth_failed: "认证失败",
  insufficient_balance: "余额不足",
  quota_exhausted: "额度用尽",
  rate_limited: "被限流",
  model_not_found: "不提供这个模型",
  upstream_timeout: "上游超时",
  upstream_unavailable: "上游不可用",
  context_length_exceeded: "上下文超长",
  upstream_rejected: "上游拒绝了请求",
};

/** `被限流（HTTP 429）`; an unknown class shows as the daemon names it. */
export function failureText(
  failure: NonNullable<CredentialRoutingState["lastFailure"]>,
): string {
  return `${errorClasses[failure.kind] ?? failure.kind}（HTTP ${failure.status}）`;
}

/** Names of allowance windows that sources report (others show as named). */
const windowNames: Readonly<Record<string, string>> = {
  requests: "请求数",
  tokens: "token",
  input_tokens: "输入 token",
  output_tokens: "输出 token",
  premium_interactions: "高级请求",
  chat: "对话",
  completions: "补全",
};

/**
 * One reading as the page shows it. A window past its reset counts as
 * unused, as the router counts it; the bands are the router's: fine below
 * 90%, low below 98%, spent from 98%.
 */
export function readingView(
  reading: AllowanceReading,
  now: number,
): {
  name: string;
  percent: number;
  tone: "good" | "warn" | "error";
  renewed: boolean;
} {
  const renewed =
    reading.resetsAt !== undefined && Date.parse(reading.resetsAt) <= now;
  const percent = renewed
    ? 0
    : Math.min(100, Math.max(0, Math.round(reading.usedPercent)));
  return {
    name: windowNames[reading.window] ?? reading.window,
    percent,
    tone: percent >= 98 ? "error" : percent >= 90 ? "warn" : "good",
    renewed,
  };
}

/** `provider/credential`, the key of a credential's state. */
export function stateKey(provider: string, credential: string): string {
  return `${provider}/${credential}`;
}

export function statesByCredential(
  items: readonly CredentialRoutingState[],
): ReadonlyMap<string, CredentialRoutingState> {
  return new Map(
    items.map((item) => [stateKey(item.provider, item.credential), item]),
  );
}

/** Time left of a rest, `9:52` or `1:02:03`; undefined once it has passed. */
export function restLeft(until: string, now: number): string | undefined {
  const seconds = Math.ceil((Date.parse(until) - now) / 1000);
  if (!(seconds > 0)) return undefined;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = String(seconds % 60).padStart(2, "0");
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}`
    : `${minutes}:${rest}`;
}
