// SPDX-License-Identifier: MIT
/**
 * Subscription account helpers (docs/subscriptions.md): what an account's
 * state means for the gateway, and whether Copilot's add-on is ready.
 */
import type {
  CopilotSetupView,
  SubscriptionAccountView,
  SubscriptionBackend,
} from "@harnesshub/sdk/client";

export const backendNames: Record<SubscriptionBackend, string> = {
  siwc: "ChatGPT",
  copilot: "GitHub Copilot",
};

/**
 * Why the gateway uses an account or not, first reason first: signed out,
 * a newer notice to accept, turned off, or usable.
 */
export function accountState(account: SubscriptionAccountView): {
  label: string;
  tone: "good" | "warn" | "neutral" | "error";
  hint?: string;
} {
  if (!account.signedIn)
    return {
      label: "已退出登录",
      tone: "warn",
      hint: "令牌已清除；重新登录后恢复",
    };
  if (!account.noticeAccepted)
    return {
      label: "需要接受新的告知",
      tone: "warn",
      hint: "风险告知已更新；重新登录并接受后恢复",
    };
  if (!account.enabled)
    return { label: "已停用", tone: "neutral", hint: "凭据已停用" };
  if (account.usable) return { label: "可用", tone: "good" };
  return { label: "不可用", tone: "error" };
}

/** The Copilot SDK add-on and CLI, as the setup step shows them. */
export function copilotReadiness(setup: CopilotSetupView): {
  sdk: "missing" | "other-version" | "ready";
  cli: boolean;
  ready: boolean;
} {
  const sdk =
    setup.sdkVersion === undefined
      ? "missing"
      : setup.sdkVersion === setup.supportedSdkVersion
        ? "ready"
        : "other-version";
  const cli = setup.cliPath !== undefined;
  return { sdk, cli, ready: sdk === "ready" && cli };
}

/** Seconds left of a pending ChatGPT sign-in, or undefined without a deadline. */
export function secondsLeft(
  expiresAt: string | undefined,
  now: number,
): number | undefined {
  if (expiresAt === undefined) return undefined;
  return Math.max(0, Math.round((Date.parse(expiresAt) - now) / 1000));
}
