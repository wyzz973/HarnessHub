// SPDX-License-Identifier: MIT
/**
 * The shared gateway's optional capabilities (Magpie parity §11), as the
 * user sets them: outbound secret redaction, a vision model that describes
 * images for models without image input, web search backends that let the
 * gateway emulate server-side search tools, and usage alerts on the
 * credentials' allowance windows. The daemon keeps them in
 * `<dataDir>/gateway-features.json`; search credentials are secret store
 * references, never values.
 */
import type { SecretReference } from "./engine-configuration.js";
import { parseModelRef } from "./model-plane.js";
import { regexHazard } from "./regex-safety.js";

/** A user's own redaction pattern: what it finds becomes `{{HH_<NAME>_…}}`. */
export interface RedactionRule {
  /** Letters, digits and `_`, starting with a letter; the placeholder's kind, upper-cased. */
  name: string;
  /** A JavaScript regular expression; group 1 is the value when it has one. */
  pattern: string;
  /** Only `i` (ignore case). */
  flags?: string;
}

export interface RedactionSettings {
  enabled: boolean;
  rules: RedactionRule[];
}

/** The web search APIs the gateway can call (Magpie's `searches[]`). */
export const searchBackendKinds = [
  "tavily",
  "brave",
  "exa",
  "firecrawl",
  "searxng",
] as const;
export type SearchBackendKind = (typeof searchBackendKinds)[number];

export interface SearchBackend {
  /** Stable within the settings: `search-<n>`. */
  id: string;
  kind: SearchBackendKind;
  /** The API key; SearXNG may have none. */
  credential?: SecretReference;
  /** Required for SearXNG (the instance); otherwise the vendor's API, unless overridden. */
  baseUrl?: string;
}

export interface GatewayFeatures {
  schemaVersion: 1;
  /** On by default; `rules` are the user's own patterns. */
  redaction: RedactionSettings;
  /**
   * Describes images for models whose metadata says they take no image
   * input: a Model Ref or `group/<id>` of a vision-capable model. Absent:
   * images become a placeholder text, as without this feature.
   */
  vision?: { model: string };
  /** Web search emulation; absent or without backends: off. */
  search?: { backends: SearchBackend[] };
  /**
   * Usage alerts (Magpie's `usageAlert`): a log line and an entry in
   * `GET /api/v1/usage/alerts` when a credential's allowance window has
   * reached this percent used, once per run of the window. Absent: off.
   */
  alerts?: { usagePercent: number };
  /**
   * When the settings were last changed (ISO 8601); absent until the first
   * change. Sync compares it when both sides changed them.
   */
  updatedAt?: string;
}

export const DEFAULT_GATEWAY_FEATURES: Readonly<GatewayFeatures> =
  Object.freeze({
    schemaVersion: 1,
    redaction: Object.freeze({ enabled: true, rules: [] }),
  });

/** The reason a redaction rule is invalid, or undefined. */
export function redactionRuleProblem(rule: unknown): string | undefined {
  if (typeof rule !== "object" || rule === null || Array.isArray(rule))
    return "must be an object";
  const { name, pattern, flags } = rule as Record<string, unknown>;
  if (typeof name !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(name))
    return "name must be 1 to 32 letters, digits or _, starting with a letter";
  if (
    typeof pattern !== "string" ||
    pattern.length === 0 ||
    pattern.length > 512
  )
    return "pattern must be 1 to 512 characters";
  if (flags !== undefined && flags !== "" && flags !== "i")
    return "flags may only be i";
  try {
    if (new RegExp(pattern, typeof flags === "string" ? flags : "").test(""))
      return "pattern must not match the empty string";
    const hazard = regexHazard(pattern, typeof flags === "string" ? flags : "");
    if (hazard) return `pattern can take too long: ${hazard}`;
  } catch (error) {
    return `pattern is not a valid regular expression: ${error instanceof Error ? error.message : "invalid"}`;
  }
  const keys = Object.keys(rule);
  if (keys.some((key) => !["name", "pattern", "flags"].includes(key)))
    return "has unknown fields";
  return undefined;
}

const reference = (value: unknown): value is SecretReference =>
  typeof value === "object" &&
  value !== null &&
  ["env", "file", "keychain", "store"].includes(
    (value as { kind?: unknown }).kind as string,
  ) &&
  typeof (value as { value?: unknown }).value === "string";

/** Why a search backend's address with `user:password@` is refused. */
export const SEARCH_URL_CREDENTIALS =
  "baseUrl must not hold credentials (user:password@)";

/**
 * The member of a search backend that is invalid and why, or undefined;
 * `field` is absent when the backend is not an object.
 */
export function searchBackendIssue(
  backend: unknown,
):
  | { field?: "id" | "kind" | "credential" | "baseUrl"; detail: string }
  | undefined {
  if (typeof backend !== "object" || backend === null || Array.isArray(backend))
    return { detail: "must be an object" };
  const value = backend as Record<string, unknown>;
  if (typeof value.id !== "string" || !/^search-[0-9]{1,6}$/.test(value.id))
    return { field: "id", detail: "id must be search-<n>" };
  if (!searchBackendKinds.includes(value.kind as SearchBackendKind))
    return {
      field: "kind",
      detail: `kind must be one of ${searchBackendKinds.join(", ")}`,
    };
  if (value.credential !== undefined && !reference(value.credential))
    return {
      field: "credential",
      detail: "credential must be a secret reference",
    };
  if (value.kind !== "searxng" && value.credential === undefined)
    return {
      field: "credential",
      detail: `${String(value.kind)} needs an API key`,
    };
  if (value.baseUrl !== undefined) {
    let url: URL | undefined;
    try {
      url =
        typeof value.baseUrl === "string" ? new URL(value.baseUrl) : undefined;
    } catch {
      url = undefined;
    }
    if (!url || (url.protocol !== "https:" && url.protocol !== "http:"))
      return {
        field: "baseUrl",
        detail: "baseUrl must be an http or https URL",
      };
    // They would show in views and backups; a key goes in the backend's key.
    if (url.username || url.password)
      return { field: "baseUrl", detail: SEARCH_URL_CREDENTIALS };
  } else if (value.kind === "searxng")
    return {
      field: "baseUrl",
      detail: "searxng needs the baseUrl of the instance",
    };
  return undefined;
}

/** The reason a search backend is invalid, or undefined. */
export function searchBackendProblem(backend: unknown): string | undefined {
  return searchBackendIssue(backend)?.detail;
}

/** Whether `value` is a usage alert's threshold: a whole percent from 1 to 100. */
export function usagePercent(value: unknown): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) >= 1 &&
    (value as number) <= 100
  );
}

/** Every problem of a settings document, by JSON pointer; empty when valid. */
export function gatewayFeaturesProblems(
  value: unknown,
): { pointer: string; detail: string }[] {
  const problems: { pointer: string; detail: string }[] = [];
  const add = (pointer: string, detail: string) =>
    problems.push({ pointer, detail });
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    add("", "must be an object");
    return problems;
  }
  const features = value as Record<string, unknown>;
  if (features.schemaVersion !== 1) add("/schemaVersion", "must be 1");
  const redaction = features.redaction as Record<string, unknown> | undefined;
  if (typeof redaction !== "object" || redaction === null)
    add("/redaction", "must be an object");
  else {
    if (typeof redaction.enabled !== "boolean")
      add("/redaction/enabled", "must be a boolean");
    if (!Array.isArray(redaction.rules) || redaction.rules.length > 64)
      add("/redaction/rules", "must be a list of at most 64 rules");
    else {
      const names = new Set<string>();
      redaction.rules.forEach((rule: unknown, index) => {
        const problem = redactionRuleProblem(rule);
        if (problem) add(`/redaction/rules/${index}`, problem);
        const name = (rule as { name?: unknown }).name;
        if (typeof name === "string") {
          if (names.has(name.toUpperCase()))
            add(`/redaction/rules/${index}/name`, "is used twice");
          names.add(name.toUpperCase());
        }
      });
    }
  }
  if (features.vision !== undefined) {
    const model = (features.vision as { model?: unknown } | null)?.model;
    if (typeof model !== "string" || !parseModelRef(model))
      add("/vision/model", "must be a Model Ref or group/<id>");
  }
  if (features.search !== undefined) {
    const backends = (features.search as { backends?: unknown } | null)
      ?.backends;
    if (!Array.isArray(backends) || backends.length > 16)
      add("/search/backends", "must be a list of at most 16 backends");
    else {
      const ids = new Set<string>();
      backends.forEach((backend: unknown, index) => {
        const problem = searchBackendProblem(backend);
        if (problem) add(`/search/backends/${index}`, problem);
        const id = (backend as { id?: unknown }).id;
        if (typeof id === "string") {
          if (ids.has(id)) add(`/search/backends/${index}/id`, "is used twice");
          ids.add(id);
        }
      });
    }
  }
  if (features.alerts !== undefined) {
    const alerts = features.alerts as Record<string, unknown> | null;
    if (typeof alerts !== "object" || alerts === null || Array.isArray(alerts))
      add("/alerts", "must be an object");
    else {
      if (!usagePercent(alerts.usagePercent))
        add("/alerts/usagePercent", "must be a whole percent from 1 to 100");
      for (const key of Object.keys(alerts))
        if (key !== "usagePercent") add(`/alerts/${key}`, "is not a setting");
    }
  }
  if (
    features.updatedAt !== undefined &&
    !(
      typeof features.updatedAt === "string" &&
      !Number.isNaN(Date.parse(features.updatedAt)) &&
      /^\d{4}-\d{2}-\d{2}T/.test(features.updatedAt)
    )
  )
    add("/updatedAt", "must be an ISO 8601 time");
  for (const key of Object.keys(features))
    if (
      ![
        "schemaVersion",
        "redaction",
        "vision",
        "search",
        "alerts",
        "updatedAt",
      ].includes(key)
    )
      add(`/${key}`, "is not a setting");
  return problems;
}

export function isGatewayFeatures(value: unknown): value is GatewayFeatures {
  return gatewayFeaturesProblems(value).length === 0;
}
