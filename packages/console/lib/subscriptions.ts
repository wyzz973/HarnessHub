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
import { t } from "./i18n";

export function backendName(backend: SubscriptionBackend): string {
  return t(`subscriptions.backend.${backend}`);
}

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
      label: t("subscriptions.state.signedOut"),
      tone: "warn",
      hint: t("subscriptions.state.signedOutHint"),
    };
  if (!account.noticeAccepted)
    return {
      label: t("subscriptions.state.notice"),
      tone: "warn",
      hint: t("subscriptions.state.noticeHint"),
    };
  if (!account.enabled)
    return {
      label: t("subscriptions.state.disabled"),
      tone: "neutral",
      hint: t("subscriptions.state.disabledHint"),
    };
  if (account.usable)
    return { label: t("subscriptions.state.usable"), tone: "good" };
  return { label: t("subscriptions.state.unusable"), tone: "error" };
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
