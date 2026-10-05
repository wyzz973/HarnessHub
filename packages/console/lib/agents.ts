// SPDX-License-Identifier: MIT
/** Presentation rules of the agent pages; pure functions over `/api/v1/agents` records. */
import type {
  Agent,
  AgentManagedOverride,
  AgentWiringInput,
  ReasoningEffort,
  WiringTier,
} from "@harnesshub/sdk/client";
import type { GatewayModels } from "./gateway-models";
import { isMessageKey, t, translate } from "./i18n";

export function installationText(status: Agent["installation"]["status"]): {
  label: string;
  tone: string;
} {
  return {
    label: t(`agents.installation.${status}`),
    tone: status === "installed" ? "good" : "",
  };
}

/** A known value's label, or the value as the daemon sends it. */
function labelOf(prefix: string, value: string): string {
  const key = `${prefix}.${value}`;
  return isMessageKey(key) ? translate(key) : value;
}

/** A drift kind (`unwired`, `replaced`, `foreign-gateway`); unknown kinds show as written. */
export function driftText(kind: string): string {
  return labelOf("agents.drift", kind);
}

/** Why a drift finding was found (`missing`, `changed`, …); unknown reasons show as written. */
export function driftReasonText(reason: string): string {
  return labelOf("agents.driftReason", reason);
}

export function tierText(tier: WiringTier): string {
  return t(`agents.tier.${tier}`);
}

/** The label of a tier name read from a record keyed by string. */
export function tierLabel(tier: string): string {
  return labelOf("agents.tier", tier);
}

export function effortText(effort: ReasoningEffort): string {
  return t(`agents.effort.${effort}`);
}

/** The label of an adapter option; unknown ones show as written. */
export function optionLabel(name: string): string {
  return labelOf("agents.option", name);
}

/** The label of an adapter option's value; unknown ones show as written. */
export function optionValueText(name: string, value: string): string {
  return labelOf(`agents.option.${name}`, value);
}

/**
 * Whether these options let the agent keep its own model, as its
 * `capabilities.ownModel` lists them (Codex with `codexAuth: chatgpt`,
 * ADR 0030): a HarnessHub model is then optional. It still gets a key;
 * without a model it takes no tiers or effort.
 */
export function modelOptional(
  agent: Pick<Agent, "capabilities">,
  options: Readonly<Record<string, string>> | undefined,
): boolean {
  return agent.capabilities.ownModel.some((combination) =>
    Object.entries(combination).every(
      ([name, value]) => options?.[name] === value,
    ),
  );
}

/**
 * A ChatGPT-mode wiring from before ADR 0030: it has no key, so the
 * gateway answers its HarnessHub model calls with 401 until a rotation
 * issues the first key.
 */
export function legacyKeyless(agent: Agent): boolean {
  const wiring = agent.wiring;
  return (
    wiring !== null &&
    modelOptional(agent, wiring.options) &&
    wiring.keyId === undefined
  );
}

/** Why an agent needs attention; empty when it does not. */
export function attention(agent: Agent, models?: GatewayModels): string[] {
  const wiring = agent.wiring;
  if (!wiring) return [];
  const reasons: string[] = [];
  const list = (items: readonly string[]) =>
    items.join(t("agents.listSeparator"));
  if (agent.installation.status === "not-found")
    reasons.push(t("agents.attention.notFound"));
  if (wiring.driftError) reasons.push(t("agents.attention.uncheckable"));
  else if (wiring.drift?.drifted)
    reasons.push(
      t("agents.attention.drifted", {
        kinds: list(wiring.drift.kinds.map(driftText)),
      }),
    );
  if (wiring.managed?.length) reasons.push(t("agents.attention.managed"));
  if (["revoked", "expired", "missing"].includes(wiring.keyState))
    reasons.push(
      wiring.keyState === "missing"
        ? t("agents.attention.keyMissing")
        : t("agents.attention.keyInvalid"),
    );
  if (models) {
    const gone = [wiring.model, ...Object.values(wiring.tiers ?? {})].filter(
      (ref): ref is string => ref !== undefined && !models.byRef.has(ref),
    );
    if (gone.length)
      reasons.push(
        t("agents.attention.modelGone", { models: list([...new Set(gone)]) }),
      );
  }
  return reasons;
}

/**
 * The files of an administrator's policy (Claude Code's managed settings)
 * that set entries the wiring writes, one line each: the file and its
 * entries as dotted paths, or that it does not parse.
 */
export function managedLines(
  managed: readonly AgentManagedOverride[] | undefined,
): string[] {
  return (managed ?? []).map((file) =>
    file.keyPaths.length
      ? t("agents.managed.keys", {
          path: file.path,
          keys: file.keyPaths
            .map((keyPath) => keyPath.join("."))
            .join(t("agents.listSeparator")),
        })
      : t("agents.managed.unreadable", { path: file.path }),
  );
}

/** A success message with the agent's notice after it, such as restarting it; the message alone without one. */
export function withNotice(
  message: string,
  notice: string | undefined,
): string {
  return notice ? t("agents.withNotice", { message, notice }) : message;
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
 * The request for a draft. Tiers are always sent so cleared ones are
 * removed, effort `null` clears it. An agent that may keep its own model
 * sends `model: null` for none, and then no tiers or effort.
 */
export function wiringInput(
  agent: Agent,
  draft: WiringDraft,
): AgentWiringInput {
  const options = Object.keys(draft.options).length
    ? { options: draft.options }
    : {};
  if (modelOptional(agent, draft.options) && !draft.model)
    return { model: null, ...options };
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
