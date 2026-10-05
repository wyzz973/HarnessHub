// SPDX-License-Identifier: MIT
/**
 * The gateway features page (docs/gateway-features.md): the search APIs it
 * can register and the user's redaction rules as the API takes them.
 */
import type {
  GatewayFeaturesView,
  RedactionRule,
  SearchBackendKind,
} from "@harnesshub/sdk/client";

/** Every search API the daemon accepts, in its order; the Record keeps the list complete. */
export const searchKinds: Readonly<
  Record<
    SearchBackendKind,
    {
      name: string;
      key: "required" | "optional";
      baseUrl: "required" | "optional";
    }
  >
> = {
  tavily: { name: "Tavily", key: "required", baseUrl: "optional" },
  brave: { name: "Brave Search", key: "required", baseUrl: "optional" },
  exa: { name: "Exa", key: "required", baseUrl: "optional" },
  firecrawl: { name: "Firecrawl", key: "required", baseUrl: "optional" },
  searxng: { name: "SearXNG", key: "optional", baseUrl: "required" },
};

export interface RuleForm {
  name: string;
  pattern: string;
  ignoreCase: boolean;
}

/** The rule a form adds; the daemon checks the name and compiles the pattern. */
export function ruleOf(form: RuleForm): RedactionRule {
  return {
    name: form.name.trim(),
    pattern: form.pattern,
    ...(form.ignoreCase ? { flags: "i" } : {}),
  };
}

/**
 * The rules after adding one or removing one by name. As `hh gateway
 * redaction rule add` does, an added rule replaces any of the same name
 * (case aside, since the placeholder's kind is upper-cased) and goes last.
 */
export function rulesWith(
  features: GatewayFeaturesView,
  change: { add: RedactionRule } | { remove: string },
): RedactionRule[] {
  const rules = features.redaction.rules;
  if ("remove" in change)
    return rules.filter((rule) => rule.name !== change.remove);
  const name = change.add.name.toUpperCase();
  return [
    ...rules.filter((rule) => rule.name.toUpperCase() !== name),
    change.add,
  ];
}

/** The usage alert's threshold as typed: a whole percent from 1 to 100, else undefined. */
export function alertPercentOf(text: string): number | undefined {
  const value = text.trim();
  if (!/^\d{1,3}$/.test(value)) return undefined;
  const percent = Number(value);
  return percent >= 1 && percent <= 100 ? percent : undefined;
}

/**
 * Links to one card of the features page (`/settings/features?section=`):
 * the backup page sends people to turn redaction back on or add search
 * keys, the usage page to the alert threshold.
 */
export const featureSections = {
  redaction: "?section=redaction",
  search: "?section=search",
  alerts: "?section=alerts",
} as const;
