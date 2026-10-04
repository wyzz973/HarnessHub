// SPDX-License-Identifier: MIT
/**
 * Import links (06-interfaces section 8): text a vendor, relay or colleague
 * hands out so that one paste describes a provider. This module only reads
 * a link; the daemon resolves its preset, previews the provider and creates
 * it after the user confirms. Nothing here touches the network.
 */
import {
  isProviderId,
  wireProtocols,
  type ProviderConfig,
  type WireProtocol,
} from "./model-plane.js";
import { endpointProblem } from "./model-plane-records.js";

/** The longest link accepted, in UTF-8 bytes. */
export const IMPORT_LINK_MAX_BYTES = 8192;

/**
 * Whose preset IDs the link uses. Magpie links (`magpie://import?…`,
 * `https://usemagpie.ai/import#…`, yetone/magpie@2e340f7) name Magpie's
 * presets, which the daemon maps to HarnessHub's.
 */
export type ImportLinkFlavor = "harnesshub" | "magpie";

/** A link read and checked; `key` is a secret, to be stored and never logged. */
export interface ImportLink {
  flavor: ImportLinkFlavor;
  preset?: string;
  region?: string;
  plan?: string;
  /** Slug; from `id`, else derived from `name` when there is no preset. */
  id?: string;
  name?: string;
  key?: string;
  /** Endpoints given by the link; with a preset they replace its own by protocol. */
  endpoints: Partial<Record<WireProtocol, string>>;
  models: string[];
  catalog?: string;
  website?: string;
  keysUrl?: string;
  /** Things the user should know before confirming; never contain the key. */
  warnings: string[];
}

/**
 * Why a link is refused. The message names the parameter but never repeats
 * a value, so it may be shown and logged.
 */
export class ImportLinkError extends Error {
  constructor(
    message: string,
    readonly parameter?: string,
  ) {
    super(message);
    this.name = "ImportLinkError";
  }
}

const MAGPIE_PARAMETERS = [
  "preset",
  "region",
  "name",
  "id",
  "key",
  "chat",
  "responses",
  "anthropic",
  "models",
  "catalog",
  "website",
  "keys",
  "icon",
] as const;
/** HarnessHub links add the format version, the kind, a plan and Gemini. */
const HARNESSHUB_PARAMETERS = [
  ...MAGPIE_PARAMETERS,
  "v",
  "kind",
  "plan",
  "gemini",
] as const;
/** IDs that mean something else in a Model Ref or to the gateway. */
const RESERVED_IDS = new Set(["hh", "harnesshub", "group"]);
/** Pages that carry a link in their fragment, which browsers never send. */
const WEB_PAGES: Readonly<Record<string, ImportLinkFlavor>> = {
  "harnesshub.dev": "harnesshub",
  "usemagpie.ai": "magpie",
};
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** A provider ID made from a name: lowercase letters, digits and dashes. */
export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize("NFKD")
      // Accents decompose into combining marks, which are dropped.
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 63)
      .replace(/-+$/, "")
  );
}

/** The flavor and the parameter text of a link, or an error naming the form. */
function locate(text: string): { flavor: ImportLinkFlavor; query: string } {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(text)?.[1]?.toLowerCase();
  if (scheme === "harnesshub" || scheme === "magpie") {
    // harnesshub://import?…, harnesshub:import?… and harnesshub:///import?…
    const rest = text.slice(scheme.length + 1);
    const mark = rest.indexOf("?");
    const action = (mark < 0 ? rest : rest.slice(0, mark)).replace(
      /^\/*|\/*$/g,
      "",
    );
    if (action.toLowerCase() !== "import")
      throw new ImportLinkError(
        `${scheme}:// links start with ${scheme}://import?`,
      );
    if (rest.includes("#"))
      throw new ImportLinkError("The link must not have a fragment");
    return { flavor: scheme, query: mark < 0 ? "" : rest.slice(mark + 1) };
  }
  if (scheme === "https" && URL.canParse(text)) {
    const url = new URL(text);
    const flavor = WEB_PAGES[url.hostname.replace(/^www\./, "")];
    if (
      flavor &&
      !url.username &&
      !url.password &&
      !url.search &&
      url.pathname.replace(/\/+$/, "") === "/import"
    )
      return { flavor, query: url.hash.replace(/^#/, "") };
  }
  throw new ImportLinkError(
    "Not an import link: expected harnesshub://import?…, https://harnesshub.dev/import#…, magpie://import?… or https://usemagpie.ai/import#…",
  );
}

/**
 * Read an import link. HarnessHub links use HarnessHub's preset IDs and may
 * give `v` (only 1), `kind` (only `provider`), `plan` and `gemini`; Magpie
 * links accept exactly Magpie's parameters. Every parameter may appear once,
 * unknown ones are refused, endpoints follow the provider base-URL rules
 * (HTTPS, or plain HTTP to loopback and private addresses, which adds a
 * warning; no credentials, query or fragment), `website` and `keys` that
 * are not HTTPS are dropped with a warning, and `icon` is checked but never
 * fetched (a warning says so). Values are trimmed; a key with whitespace is
 * refused (an unencoded `+` reads as a space). Pure: nothing is fetched.
 *
 * @throws ImportLinkError naming the first problem; it never contains the key.
 */
export function parseImportLink(text: string): ImportLink {
  const trimmed = text.trim();
  if (new TextEncoder().encode(trimmed).length > IMPORT_LINK_MAX_BYTES)
    throw new ImportLinkError(
      `The link is longer than ${IMPORT_LINK_MAX_BYTES} bytes`,
    );
  const { flavor, query } = locate(trimmed);
  const allowed: readonly string[] =
    flavor === "magpie" ? MAGPIE_PARAMETERS : HARNESSHUB_PARAMETERS;
  const values = new Map<string, string>();
  for (const [name, value] of new URLSearchParams(query)) {
    if (!allowed.includes(name))
      throw new ImportLinkError(
        `The link has an unknown parameter ${JSON.stringify(name.slice(0, 40))}`,
        name.slice(0, 40),
      );
    if (values.has(name))
      throw new ImportLinkError(`The link gives ${name}= twice`, name);
    values.set(name, value.trim());
  }
  const get = (name: string) => values.get(name) || undefined;
  const warnings: string[] = [];

  const version = get("v");
  if (version !== undefined && version !== "1")
    throw new ImportLinkError(
      /^\d+$/.test(version)
        ? `The link is format version ${version}; this HarnessHub reads version 1, so update HarnessHub`
        : "The link's v= is not a version number",
      "v",
    );
  const kind = get("kind");
  if (kind !== undefined && kind !== "provider")
    throw new ImportLinkError(
      kind === "mcp"
        ? "MCP server links are not supported yet"
        : "The link's kind= must be provider",
      "kind",
    );
  const slugOf = (name: string): string | undefined => {
    const value = get(name)?.toLowerCase();
    if (value !== undefined && !SLUG.test(value))
      throw new ImportLinkError(`The link's ${name}= is not an ID`, name);
    return value;
  };
  const preset = slugOf("preset");
  const region = slugOf("region");
  const plan = slugOf("plan");
  if ((region !== undefined || plan !== undefined) && preset === undefined)
    throw new ImportLinkError(
      `The link's ${region !== undefined ? "region" : "plan"}= needs preset=`,
      region !== undefined ? "region" : "plan",
    );

  const name = get("name");
  if (name !== undefined && name.length > 80)
    throw new ImportLinkError(
      "The link's name= is longer than 80 characters",
      "name",
    );
  if (name !== undefined && /[\u0000-\u001f\u007f]/.test(name))
    throw new ImportLinkError(
      "The link's name= has control characters",
      "name",
    );
  if (preset === undefined && name === undefined)
    throw new ImportLinkError(
      "The link names no provider: it needs preset= or name=",
      "name",
    );
  const given = get("id");
  const id =
    given !== undefined
      ? slugify(given)
      : preset === undefined
        ? slugify(name!)
        : undefined;
  if (id !== undefined) {
    if (!id)
      throw new ImportLinkError(
        `The link's ${given !== undefined ? "id" : "name"} has no letters or digits to make an ID from`,
        given !== undefined ? "id" : "name",
      );
    if (RESERVED_IDS.has(id) || !isProviderId(id))
      throw new ImportLinkError(
        `The ID ${id} is reserved; the link needs another id=`,
        "id",
      );
  }

  const key = get("key");
  if (
    key !== undefined &&
    (key.length > 4096 || /[\s\u0000-\u001f\u007f]/.test(key))
  )
    throw new ImportLinkError(
      "The link's key= is not a key (a + in it must be written %2B)",
      "key",
    );

  const endpoints: Partial<Record<WireProtocol, string>> = {};
  for (const protocol of wireProtocols) {
    const value = get(protocol);
    if (value === undefined) continue;
    const base = value.replace(/\/+$/, "");
    const problem = endpointProblem(protocol, base);
    if (problem)
      throw new ImportLinkError(`The link's ${protocol}= ${problem}`, protocol);
    if (new URL(base).protocol === "http:")
      warnings.push(
        `${protocol}= uses plain HTTP to a local or private address: requests and the key travel unencrypted`,
      );
    endpoints[protocol] = base;
  }
  if (preset === undefined && !Object.keys(endpoints).length)
    throw new ImportLinkError(
      "The link gives no base URL: it needs chat=, responses=, anthropic= or gemini=",
      "chat",
    );

  const models: string[] = [];
  for (const item of (get("models") ?? "").split(",")) {
    const model = item.trim();
    if (!model) continue;
    if (model.length > 512 || /\s/.test(model))
      throw new ImportLinkError(
        "The link's models= has an invalid model ID",
        "models",
      );
    if (!models.includes(model)) models.push(model);
  }
  if (models.length > 200)
    throw new ImportLinkError(
      "The link's models= lists more than 200 models",
      "models",
    );

  const catalog = slugOf("catalog");
  // Shown as text only, so a page that is not https is dropped, not refused.
  const page = (parameter: string): string | undefined => {
    const value = get(parameter);
    if (value === undefined) return undefined;
    const url = URL.canParse(value) ? new URL(value) : undefined;
    if (url?.protocol === "https:" && !url.username && !url.password)
      return value;
    warnings.push(`${parameter}= is left out: it is not an https page`);
    return undefined;
  };
  const website = page("website");
  const keysUrl = page("keys");
  const icon = get("icon");
  if (icon !== undefined) {
    const url = URL.canParse(icon) ? new URL(icon) : undefined;
    if (!url || url.protocol !== "https:" || url.username || url.password)
      throw new ImportLinkError(
        "The link's icon= must be an https picture",
        "icon",
      );
    warnings.push(
      "icon= is not fetched: HarnessHub shows only the icons of its own presets",
    );
  }

  return {
    flavor,
    ...(preset !== undefined ? { preset } : {}),
    ...(region !== undefined ? { region } : {}),
    ...(plan !== undefined ? { plan } : {}),
    ...(id !== undefined ? { id } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(key !== undefined ? { key } : {}),
    endpoints,
    models,
    ...(catalog !== undefined ? { catalog } : {}),
    ...(website !== undefined ? { website } : {}),
    ...(keysUrl !== undefined ? { keysUrl } : {}),
    warnings,
  };
}

/** Apps whose configuration `POST /api/v1/import/preview` can read. */
export const importApps = ["claude-code", "codex"] as const;
export type ImportApp = (typeof importApps)[number];

/** One provider an import would create, as the preview shows it. */
export interface ImportItem {
  /** `link`; `settings` for Claude Code; the table name for Codex. */
  ref: string;
  /** `new` is created on apply; `exists` and `skipped` are not. */
  status: "new" | "exists" | "skipped";
  reason?: string;
  provider?: {
    id: string;
    name: string;
    kind: ProviderConfig["kind"];
    preset?: string;
    region?: string;
    plan?: string;
    catalog?: string;
    endpoints: ProviderConfig["endpoints"];
    apiKeyHeader: string;
    models: string[];
    /** Names only: header values may be sensitive. */
    headers: string[];
  };
  /** Where prompts and the key would be sent. */
  hosts: string[];
  /** The key itself is never shown: its last four characters at most. */
  key:
    | { kind: "none" }
    | { kind: "value"; last4?: string }
    | { kind: "env"; variable: string };
  website?: string;
  keysUrl?: string;
}

/** `POST /api/v1/import/preview`: what apply would create, held under `previewId`. */
export interface ImportPreview {
  previewId: string;
  expiresAt: string;
  source: "link" | ImportApp;
  /** The configuration file read, for an app. */
  file?: string;
  items: ImportItem[];
  warnings: string[];
}

/** `POST /api/v1/import/apply`: the outcome per item of the preview. */
export interface ImportResult {
  items: Array<{
    ref: string;
    status: "created" | "skipped" | "failed";
    /** Why it was skipped or failed. */
    reason?: string;
    /** The problem code of a failure, e.g. `PROVIDER_EXISTS`. */
    code?: string;
    provider?: ProviderConfig;
  }>;
}
