// SPDX-License-Identifier: MIT
/**
 * Model Refs and the reasoning-level lists of the model plane, apart from
 * `model-plane.ts` because they need no Node module: the console bundles the
 * route-group code (`route-groups.ts`, `route-rules.ts`) that uses them, and
 * `model-plane.ts` imports `node:crypto`. `model-plane.ts` re-exports all of
 * them.
 */
import type { ModelRef, ProviderId, RouteGroupId } from "./model-plane.js";

const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function isProviderId(value: string): value is ProviderId {
  return PROVIDER_ID.test(value) && value !== "group";
}

/**
 * Parses `provider/model` or `group/<id>`. The model part is everything after
 * the first `/`, so `openrouter/deepseek/deepseek-chat` names model
 * `deepseek/deepseek-chat` of provider `openrouter`.
 */
export function parseModelRef(
  text: string,
):
  | { kind: "model"; ref: ModelRef; provider: ProviderId; model: string }
  | { kind: "group"; group: RouteGroupId }
  | undefined {
  const slash = text.indexOf("/");
  if (slash <= 0 || slash === text.length - 1) return undefined;
  const head = text.slice(0, slash);
  const rest = text.slice(slash + 1);
  if (head === "group")
    return PROVIDER_ID.test(rest)
      ? { kind: "group", group: rest as RouteGroupId }
      : undefined;
  if (!isProviderId(head) || /\s/.test(rest)) return undefined;
  return { kind: "model", ref: text as ModelRef, provider: head, model: rest };
}

/** Reasoning levels an agent can start with, lowest first. */
export const reasoningEfforts = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ReasoningEffort = (typeof reasoningEfforts)[number];

/** The reasoning levels a group rule compares with, lowest first (Magpie `provider.Efforts`). */
export const ruleEfforts = ["low", "medium", "high", "xhigh", "max"] as const;
export type RuleEffort = (typeof ruleEfforts)[number];

/** Days of the week as a rule's hours name them, Sunday first (Magpie `Weekdays`). */
export const weekdays = [
  "sun",
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
] as const;
export type Weekday = (typeof weekdays)[number];
