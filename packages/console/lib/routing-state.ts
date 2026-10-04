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
import { isMessageKey, t, translate } from "./i18n";

const breakerTones: Readonly<
  Record<CredentialRoutingState["state"], "good" | "warn" | "info">
> = { closed: "good", open: "warn", "half-open": "info" };

/** A breaker state's tag, tone and what it means. */
export function breakerState(state: CredentialRoutingState["state"]): {
  label: string;
  tone: "good" | "warn" | "info";
  hint: string;
} {
  return {
    label: t(`providers.breaker.${state}`),
    tone: breakerTones[state],
    hint: t(`providers.breaker.${state}Hint`),
  };
}

/**
 * The class of the last failure (the ledger's error classes of upstream
 * failures, gateway `failureClass`) with its status, as
 * `被限流（HTTP 429）`; an unknown class shows as the daemon names it.
 */
export function failureText(
  failure: NonNullable<CredentialRoutingState["lastFailure"]>,
): string {
  const key = `providers.failure.${failure.kind}`;
  return t("providers.failure.text", {
    kind: isMessageKey(key) ? translate(key) : failure.kind,
    status: String(failure.status),
  });
}

/** The name of an allowance window that sources report (others show as named). */
function windowName(window: string): string {
  const key = `providers.window.${window}`;
  return isMessageKey(key) ? translate(key) : window;
}

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
    name: windowName(reading.window),
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
