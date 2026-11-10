import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { MAX_AUTH_KIND_BYTES, MAX_HOST_BYTES, MAX_RELAY_MODEL_BYTES, type EndpointLayer, type RelayCapabilities, type VendorKey, type VendorObservation } from "../../contracts/relay.js";
import { at, parseConfig, type ConfigFormat } from "../../infrastructure/capabilities/formats.js";
import { harnessDirectories, type ReadEnvironment } from "../capability-reads.js";

/**
 * The destination vendor of a Driver's model requests (ADR-055 §8.1 vendor column, §10.4, INV-33), in three parts:
 *
 * - Endpoint layers: each Harness's configuration layers that can name the endpoint its model requests go to, read the
 *   way that Harness resolves them, highest precedence first, and only for the endpoint keys §8.1 names. A layer's file
 *   is parsed, but nothing in it except those keys is read; the endpoint's value is reduced to its host at once and never
 *   enters a message, an error, a log or a status (a failure says which layer and why, not what it held).
 * - Vendor keys: each Driver's resolveVendor, a pure function of the observation (model, authentication kind, endpoint
 *   host and layer). A non-loopback endpoint is `gateway:<host>`; what a Driver cannot tell is `unknown:<harness>`.
 * - Model keys: each Driver's normalizeModel, the model without its provider prefix and version decorations.
 *
 * Nothing here runs a Harness, reads the process environment of its own accord, or writes anything.
 */

// ---------------------------------------------------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------------------------------------------------

/** A configuration file an endpoint is read from is held to the bound the native environment reads such files with. */
const CONFIG_BYTES = 2 * 1024 * 1024;
/** An endpoint value longer than this is no endpoint this reader takes. */
const ENDPOINT_BYTES = 4096;
/** A host name or address literal as a gateway vendor key holds it (the contract's own pattern). */
const HOST = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*|\[[0-9a-f:.]{2,45}\])$/u;
/** A provider name as a model prefix names it, and as `provider:<name>` holds it. */
const PROVIDER = /^[a-z0-9][a-z0-9._-]{0,127}$/u;

/** Whether a host names this machine: `localhost` and its subdomains, 127.0.0.0/8, ::1 and IPv4-mapped 127.x addresses. */
export function loopbackHost(host: string): boolean {
  return host === "localhost" || host.endsWith(".localhost") || /^127(?:\.\d{1,3}){3}$/u.test(host) || host === "[::1]" || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/u.test(host);
}
/**
 * The host of an endpoint value, lower case, and whether it is a loopback one; null when the value is no http(s) URL with
 * a host this reader takes. Never throws and never repeats the value.
 */
export function endpointHost(value: string): { readonly host: string; readonly loopback: boolean } | null {
  if (Buffer.byteLength(value) > ENDPOINT_BYTES) return null;
  let url: URL;
  try { url = new URL(value.trim()); } catch { return null; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  if (Buffer.byteLength(host) > MAX_HOST_BYTES || !HOST.test(host)) return null;
  return { host, loopback: loopbackHost(host) };
}

/**
 * The endpoint a layer named: its host, whether it is loopback, the layer, and where: `<layer>:<label>`, a fixed label of
 * that layer (a file relative to the directory the layer is named after, or the variable), never a path or the value.
 */
export interface Endpoint { readonly host: string; readonly loopback: boolean; readonly layer: EndpointLayer; readonly source: string }
/** Why a layer gave no answer: the file is no regular file, exceeds 2 MiB, cannot be read or parsed, or names no usable endpoint. */
export type EndpointProblem = "not_a_file" | "too_large" | "unreadable" | "unparseable" | "invalid_endpoint";
/**
 * What the endpoint layers say. `read`: the endpoint of the highest layer that names one (null: none does, the Harness's
 * own default), and for Claude Code the cloud backend its settings switch on. `unreadable`: a layer that could name one
 * cannot be read, so the endpoint is not known (the vendor is then unknown). `unsupported`: the Driver knows no endpoint
 * key it may read. Values never appear in any of them.
 */
export type EndpointReading =
  | { readonly kind: "read"; readonly endpoint: Endpoint | null; readonly backend: "bedrock" | "vertex" | null }
  | { readonly kind: "unreadable"; readonly layer: EndpointLayer; readonly source: string; readonly problem: EndpointProblem; readonly code: string | null }
  | { readonly kind: "unsupported" };
/** Where a Harness resolves its configuration from: its environment and home (as capability reads take them) and its workspace. */
export interface EndpointSources extends ReadEnvironment { readonly workspace: string }
/**
 * One layer an endpoint key can come from, highest precedence first: the environment the Harness receives, or a file in a
 * format; `keys` maps what is read (`endpoint`, and Claude Code's `bedrock` and `vertex` switches) to its key path there.
 * A file layer's `label` is how statuses name it (`claude/settings.json`, `<workspace>/.env`…), independent of where the
 * file happens to be.
 */
export type EndpointLayerSpec =
  | { readonly layer: EndpointLayer; readonly kind: "environment"; readonly keys: Readonly<Record<string, readonly string[]>> }
  | { readonly layer: EndpointLayer; readonly kind: "file"; readonly file: string; readonly label: string; readonly format: ConfigFormat | "dotenv"; readonly keys: Readonly<Record<string, readonly string[]>> };

const claudeKeys = (prefix: readonly string[]) => ({ endpoint: [...prefix, "ANTHROPIC_BASE_URL"], bedrock: [...prefix, "CLAUDE_CODE_USE_BEDROCK"], vertex: [...prefix, "CLAUDE_CODE_USE_VERTEX"] });
/**
 * The endpoint layers of each Harness, highest precedence first, with the paths the native environment and capability
 * reads already resolve (CLAUDE_CONFIG_DIR, CODEX_HOME, OPENCODE_CONFIG_DIR, OPENCLAW_CONFIG_PATH, DSH_HOME). The orders
 * are inferred from each product's documentation where it says one (ADR-055 Q24 is open on all of them):
 * - Claude Code: the `env` of the workspace's `.claude/settings.local.json` and `.claude/settings.json`, then of the user's
 *   `settings.json`, then the process environment (settings `env` is applied over it);
 * - Codex: `openai_base_url` of the workspace's `.codex/config.toml`, then of the user's `config.toml`, then
 *   `OPENAI_BASE_URL`;
 * - DeepSeek Harness (0.2.1-rc.5 read only; dsh-llm-deepseek `config.baseURL ?? environment.get("DEEPSEEK_BASE_URL")`,
 *   dsh-launch-environment's order process > project-env > user-env): `DEEPSEEK_BASE_URL` in the inherited environment,
 *   then in the workspace's `.env`, then in `$DSH_HOME/.env`. Its `$DSH_HOME/.credentials.yaml` is not a layer: the base
 *   URL is read from the launch environment, never through the credentials store (whose `refs` resolve credential
 *   references such as the API key). Its CLI refuses to start when either `.env` sets DEEPSEEK_BASE_URL (dsh-app-boot
 *   BOOTSTRAP_NAMES); the two files are still read, so that a launcher or version that takes them is never keyed DeepSeek.
 *   The plugin configuration's `baseURL`, which comes first, is not read (see dshRelayCapabilities);
 * - OpenCode: `provider.<provider>.options.baseURL` of the workspace's `opencode.jsonc` and `opencode.json`, then of the
 *   user's;
 * - OpenClaw: `models.providers.<provider>.baseUrl` of its configuration file;
 * - Hermes: none yet (its provider's base-URL key is not named by §8.1): unsupported.
 * `provider` is the model's provider prefix, which OpenCode and OpenClaw key their endpoints by; without one they read none.
 */
export function endpointLayers(harnessId: "claude" | "codex" | "dsh" | "opencode" | "openclaw" | "hermes", sources: EndpointSources, provider: string | null = null): readonly EndpointLayerSpec[] | null {
  const dirs = harnessDirectories(sources), workspace = (...parts: string[]) => join(sources.workspace, ...parts);
  switch (harnessId) {
    case "claude": return [
      { layer: "workspace_file", kind: "file", file: workspace(".claude", "settings.local.json"), label: "<workspace>/.claude/settings.local.json", format: "json", keys: claudeKeys(["env"]) },
      { layer: "workspace_file", kind: "file", file: workspace(".claude", "settings.json"), label: "<workspace>/.claude/settings.json", format: "json", keys: claudeKeys(["env"]) },
      { layer: "user_config", kind: "file", file: join(dirs.claude, "settings.json"), label: "claude/settings.json", format: "json", keys: claudeKeys(["env"]) },
      { layer: "environment", kind: "environment", keys: claudeKeys([]) },
    ];
    case "codex": return [
      { layer: "workspace_file", kind: "file", file: workspace(".codex", "config.toml"), label: "<workspace>/.codex/config.toml", format: "toml", keys: { endpoint: ["openai_base_url"] } },
      { layer: "user_config", kind: "file", file: join(dirs.codex, "config.toml"), label: "codex/config.toml", format: "toml", keys: { endpoint: ["openai_base_url"] } },
      { layer: "environment", kind: "environment", keys: { endpoint: ["OPENAI_BASE_URL"] } },
    ];
    case "dsh": return [
      { layer: "environment", kind: "environment", keys: { endpoint: ["DEEPSEEK_BASE_URL"] } },
      { layer: "workspace_file", kind: "file", file: workspace(".env"), label: "<workspace>/.env", format: "dotenv", keys: { endpoint: ["DEEPSEEK_BASE_URL"] } },
      { layer: "user_config", kind: "file", file: join(dirs.dsh, ".env"), label: "dsh/.env", format: "dotenv", keys: { endpoint: ["DEEPSEEK_BASE_URL"] } },
    ];
    case "opencode": {
      if (provider === null || !PROVIDER.test(provider)) return [];
      const keys = { endpoint: ["provider", provider, "options", "baseURL"] };
      return [[workspace("opencode.jsonc"), "<workspace>/opencode.jsonc"], [workspace("opencode.json"), "<workspace>/opencode.json"], [join(dirs.opencode, "opencode.jsonc"), "opencode/opencode.jsonc"], [join(dirs.opencode, "opencode.json"), "opencode/opencode.json"]]
        .map(([file, label], index): EndpointLayerSpec => ({ layer: index < 2 ? "workspace_file" : "user_config", kind: "file", file: file!, label: label!, format: "jsonc", keys }));
    }
    case "openclaw":
      return provider === null || !PROVIDER.test(provider) ? [] : [{ layer: "user_config", kind: "file", file: dirs.openclawConfig, label: "openclaw/openclaw.json", format: "json5", keys: { endpoint: ["models", "providers", provider, "baseUrl"] } }];
    case "hermes": return null;
  }
}

/** How a status names a layer: `<layer>:<the layer's fixed label>`, or `environment:<variable>`; never a path or a value. */
function label(spec: EndpointLayerSpec, path: readonly string[]): string { return spec.layer + ":" + (spec.kind === "environment" ? path.join(".") : spec.label); }
type Loaded = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly problem: EndpointProblem; readonly code: string | null } | null;
/**
 * The named variables of a dotenv file, and only those (the other lines, credentials among them, are skipped unread):
 * `KEY=value` or `export KEY=value`, a quoted value up to its closing quote, an unquoted one up to ` #`; a later line wins.
 */
function dotenv(text: string, names: ReadonlySet<string>): Readonly<Record<string, string>> {
  const found: Record<string, string> = {};
  for (const line of text.split(/\r?\n/u)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/u.exec(line);
    if (match === null || !names.has(match[1]!)) continue;
    const raw = match[2]!, quote = raw[0];
    if (quote === "\"" || quote === "'" || quote === "`") { const end = raw.indexOf(quote, 1); found[match[1]!] = end < 0 ? raw.slice(1) : raw.slice(1, end); }
    else found[match[1]!] = raw.replace(/\s+#.*$/u, "").trim();
  }
  return found;
}
/**
 * A configuration file's text, judged on the descriptor that is read (no window between a check and the read): opened
 * without blocking (a FIFO or device answers at once), `fstat` says whether it is a regular file, and at most
 * CONFIG_BYTES + 1 bytes are read. Null when it does not exist.
 */
async function readBounded(file: string): Promise<{ readonly ok: true; readonly text: string } | { readonly ok: false; readonly problem: EndpointProblem; readonly code: string | null } | null> {
  let handle: FileHandle;
  try { handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK); }
  catch (error) {
    const code = codeOf(error);
    return code === "ENOENT" || code === "ENOTDIR" ? null : { ok: false, problem: "unreadable", code };
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { ok: false, problem: "not_a_file", code: null };
    if (info.size > CONFIG_BYTES) return { ok: false, problem: "too_large", code: null };
    const buffer = Buffer.alloc(CONFIG_BYTES + 1);
    let length = 0;
    while (length < buffer.length) { const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length); if (bytesRead === 0) break; length += bytesRead; }
    return length > CONFIG_BYTES ? { ok: false, problem: "too_large", code: null } : { ok: true, text: buffer.subarray(0, length).toString("utf8") };
  } catch (error) {
    return { ok: false, problem: "unreadable", code: codeOf(error) };
  } finally { await handle.close(); }
}
function codeOf(error: unknown): string | null { return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : null; }
/** One layer's content, read once: null when its file does not exist; a problem, never the content, when it cannot be read. */
async function load(spec: EndpointLayerSpec, sources: EndpointSources): Promise<Loaded> {
  if (spec.kind === "environment") return { ok: true, value: sources.values };
  const read = await readBounded(spec.file);
  if (read === null || !read.ok) return read;
  const text = read.text;
  if (spec.format === "dotenv") return { ok: true, value: dotenv(text, new Set(Object.values(spec.keys).map(path => path[0]!))) };
  // The parser's own error text can quote the file; only that it failed is kept.
  const parsed = parseConfig(text, spec.format);
  return parsed.ok ? { ok: true, value: parsed.value } : { ok: false, problem: "unparseable", code: null };
}
type Found = { readonly kind: "found"; readonly spec: EndpointLayerSpec; readonly path: readonly string[]; readonly value: unknown } | { readonly kind: "absent" }
  | { readonly kind: "failed"; readonly spec: EndpointLayerSpec; readonly problem: EndpointProblem; readonly code: string | null };
/** The highest layer that sets `key` (a value that is not null, undefined or blank), or the first layer that cannot be read before it. */
async function first(specs: readonly EndpointLayerSpec[], key: string, loaded: (spec: EndpointLayerSpec) => Promise<Loaded>): Promise<Found> {
  for (const spec of specs) {
    const path = spec.keys[key];
    if (path === undefined) continue;
    const content = await loaded(spec);
    if (content === null) continue;
    if (!content.ok) return { kind: "failed", spec, problem: content.problem, code: content.code };
    const value = at(content.value, path);
    if (value === undefined || value === null || typeof value === "string" && value.trim() === "") continue;
    return { kind: "found", spec, path, value };
  }
  return { kind: "absent" };
}
/**
 * Claude Code's reading of a switch variable (`isEnvTruthy`): 1, true, yes or on, in any case; a settings value written as a
 * JSON number or boolean is read as the text it becomes in the environment.
 */
function truthy(value: unknown): boolean {
  return (typeof value === "string" || typeof value === "number" || typeof value === "boolean") && ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

/**
 * What a Harness's endpoint layers say (endpointLayers), read once each: the endpoint of the highest layer that names one,
 * reduced to its host; a layer that could decide it and cannot be read, or names something that is no endpoint, makes the
 * reading unreadable. Reads only the layers' endpoint keys, writes nothing, never throws for a layer's content, and keeps
 * no value but the host.
 */
export async function readEndpoint(harnessId: Parameters<typeof endpointLayers>[0], sources: EndpointSources, provider: string | null = null): Promise<EndpointReading> {
  const specs = endpointLayers(harnessId, sources, provider);
  if (specs === null) return { kind: "unsupported" };
  const cache = new Map<EndpointLayerSpec, Promise<Loaded>>();
  const loaded = (spec: EndpointLayerSpec): Promise<Loaded> => { let pending = cache.get(spec); if (pending === undefined) cache.set(spec, pending = load(spec, sources)); return pending; };
  const failed = (found: Extract<Found, { kind: "failed" }>, problem = found.problem): EndpointReading =>
    ({ kind: "unreadable", layer: found.spec.layer, source: label(found.spec, found.spec.keys.endpoint ?? []), problem, code: found.code });
  const endpoint = await first(specs, "endpoint", loaded);
  if (endpoint.kind === "failed") return failed(endpoint);
  let named: Endpoint | null = null;
  if (endpoint.kind === "found") {
    const host = typeof endpoint.value === "string" ? endpointHost(endpoint.value) : null;
    if (host === null) return { kind: "unreadable", layer: endpoint.spec.layer, source: label(endpoint.spec, endpoint.path), problem: "invalid_endpoint", code: null };
    named = { ...host, layer: endpoint.spec.layer, source: label(endpoint.spec, endpoint.path) };
  }
  let backend: "bedrock" | "vertex" | null = null;
  for (const switched of ["bedrock", "vertex"] as const) {
    if (backend !== null || !specs.some(spec => spec.keys[switched] !== undefined)) continue;
    const found = await first(specs, switched, loaded);
    if (found.kind === "failed") return failed(found);
    if (found.kind === "found" && truthy(found.value)) backend = switched;
  }
  return { kind: "read", endpoint: named, backend };
}

// ---------------------------------------------------------------------------------------------------------------------
// Observations and vendor keys
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The observation a Driver reports from an endpoint reading and what its native side told of the model and sign-in: null
 * when the reading is not `read` (an endpoint that cannot be known is never reported as none). A model over 96 bytes is
 * not kept (null, with an empty key) and an authentication kind over 16 bytes neither; Claude Code's cloud backend, when
 * its settings switch one on, is the authentication kind (`bedrock`, `vertex`), which the vendor key and the wording read.
 */
export function vendorObservation(reading: EndpointReading, model: string | null, authKind: string | null, normalizeModel: (model: string | null) => string): VendorObservation | null {
  if (reading.kind !== "read") return null;
  const kept = model !== null && model !== "" && Buffer.byteLength(model) <= MAX_RELAY_MODEL_BYTES ? model : null, kind = reading.backend ?? authKind;
  return { model: kept, modelKey: normalizeModel(kept), authKind: kind !== null && kind !== "" && Buffer.byteLength(kind) <= MAX_AUTH_KIND_BYTES ? kind : null,
    endpoint: reading.endpoint === null ? null : { host: reading.endpoint.host, layer: reading.endpoint.layer }, loopback: reading.endpoint?.loopback ?? false };
}
/** The vendor key of an observation by a Driver's declaration; without an observation (its endpoint not known), `unknown:<harness>`. */
export function observedVendor(declaration: Pick<RelayCapabilities, "resolveVendor">, harnessId: string, observation: VendorObservation | null): VendorKey {
  return observation === null ? `unknown:${harnessId}` : declaration.resolveVendor(observation);
}

const gateway = (host: string): VendorKey => `gateway:${host}`;
/** The provider a model names by its prefix before `separator`, lower case; null without one. */
function providerOf(model: string | null, separator: "/" | ":"): string | null {
  const index = model?.indexOf(separator) ?? -1;
  if (model === null || index < 1) return null;
  const name = model.slice(0, index).trim().toLowerCase();
  return PROVIDER.test(name) ? name : null;
}
/** A model a local server forwards to a cloud service (Ollama's `*-cloud` and `:cloud` models): never local (VF3-01). */
export function cloudForwarded(model: string | null): boolean { return model !== null && /(?:^|[-:])cloud$/iu.test(model.trim()); }

/**
 * Claude Code (§8.1): an endpoint host that is not loopback is `gateway:<host>`; a loopback one is a local proxy whose
 * destination is not known (unknown); the cloud backends its settings switch on are `aws-bedrock` and `google-vertex`;
 * otherwise a claude.ai account or an API key is `anthropic`, and any other sign-in (external, gateway, none) unknown.
 * A backend switch together with an endpoint is ambiguous (in Bedrock or Vertex mode ANTHROPIC_BASE_URL is likely not
 * used, inferred), so it is unknown: a stricter reading than §8.1's order, which would take the endpoint.
 */
export function claudeVendor(observed: VendorObservation): VendorKey {
  const backend = observed.authKind === "bedrock" || observed.authKind === "vertex";
  if (observed.endpoint !== null) return observed.loopback || backend ? "unknown:claude" : gateway(observed.endpoint.host);
  if (observed.authKind === "bedrock") return "aws-bedrock";
  if (observed.authKind === "vertex") return "google-vertex";
  return observed.authKind === "account" || observed.authKind === "api_key" ? "anthropic" : "unknown:claude";
}
/**
 * Codex (§8.1), whose observation names the thread's model provider as the model's `provider/` prefix. The endpoint it
 * carries is the one OPENAI_BASE_URL / `openai_base_url` name, which only the built-in openai provider uses: it is read
 * for `openai` or no provider and never for another one. Then a non-loopback endpoint is `gateway:<host>`, a loopback one
 * a local proxy (unknown); `openai` without an endpoint is `openai`; no provider is unknown; `azure` is `gateway:azure`;
 * any other provider is `provider:<name>`. `ollama` is `provider:ollama` too: §8.1's "ollama with a loopback endpoint is
 * local" needs its own endpoint, which is not read (only the two OpenAI keys are).
 */
export function codexVendor(observed: VendorObservation): VendorKey {
  const provider = providerOf(observed.model, "/");
  if (provider === null || provider === "openai") {
    if (observed.endpoint !== null) return observed.loopback ? "unknown:codex" : gateway(observed.endpoint.host);
    return provider === "openai" ? "openai" : "unknown:codex";
  }
  return provider === "azure" ? "gateway:azure" : `provider:${provider}`;
}
/**
 * OpenCode and OpenClaw (§8.1), by the model's `provider/` prefix and that provider's endpoint: a non-loopback endpoint
 * is `gateway:<host>`; a loopback one is `local` for ollama and lmstudio unless the model is forwarded to a cloud service
 * (then `gateway:<host>`), and for any other provider a local proxy of unknown destination; anthropic, openai, deepseek
 * and google are themselves; `opencode/*` is `provider:opencode-zen`, `openrouter/*` `router:openrouter`; any other
 * provider `provider:<name>`, and no provider unknown.
 */
function prefixVendor(observed: VendorObservation, harnessId: "opencode" | "openclaw"): VendorKey {
  const provider = providerOf(observed.model, "/");
  if (observed.endpoint !== null) {
    if (!observed.loopback) return gateway(observed.endpoint.host);
    if (provider === "ollama" || provider === "lmstudio") return cloudForwarded(observed.model) ? gateway(observed.endpoint.host) : "local";
    return `unknown:${harnessId}`;
  }
  if (provider === "anthropic" || provider === "openai" || provider === "deepseek" || provider === "google") return provider;
  if (provider === "opencode") return "provider:opencode-zen";
  if (provider === "openrouter") return "router:openrouter";
  return provider === null ? `unknown:${harnessId}` : `provider:${provider}`;
}
export function openCodeVendor(observed: VendorObservation): VendorKey { return prefixVendor(observed, "opencode"); }
export function openClawVendor(observed: VendorObservation): VendorKey { return prefixVendor(observed, "openclaw"); }
/** DeepSeek Harness (§8.1): a non-loopback endpoint from any layer is `gateway:<host>`, a loopback one unknown, otherwise `deepseek`. */
export function dshVendor(observed: VendorObservation): VendorKey {
  return observed.endpoint === null ? "deepseek" : observed.loopback ? "unknown:dsh" : gateway(observed.endpoint.host);
}
/** Hermes (§8.1): only a non-loopback endpoint of its provider tells the vendor (`gateway:<host>`); anything else is unknown. */
export function hermesVendor(observed: VendorObservation): VendorKey {
  return observed.endpoint !== null && !observed.loopback ? gateway(observed.endpoint.host) : "unknown:hermes";
}

// ---------------------------------------------------------------------------------------------------------------------
// Model keys
// ---------------------------------------------------------------------------------------------------------------------

/**
 * A model's version decorations removed, lower case: a Bedrock id's region and `anthropic.` prefix with its `-vN:M`
 * suffix, a Vertex `@date` or `@latest`, a dated snapshot (`-20250929`, `-2024-08-06`) and `-latest`. An alias a CLI
 * resolves at run time (Claude Code's `opus`, `sonnet`…) stays its own key: which model it names depends on the version.
 */
function undecorated(model: string): string {
  let key = model.trim().toLowerCase();
  const bedrock = /^(?:(?:us|eu|apac|global|jp|au|ca)\.)?anthropic\.(.+?)(?:-v\d+(?::\d+)?)?$/u.exec(key);
  if (bedrock !== null) key = bedrock[1]!;
  return key.replace(/@(?:\d{8}|latest)$/u, "").replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2})$/u, "").replace(/-latest$/u, "");
}
function bounded(key: string): string { return key !== "" && Buffer.byteLength(key) <= MAX_RELAY_MODEL_BYTES ? key : ""; }
/**
 * The model key of a Driver whose models carry a `provider/` prefix, or none (Claude Code, Codex, OpenCode, OpenClaw,
 * DeepSeek Harness): the last `/` segment without its decorations; "" for null, an empty result or one over 96 bytes.
 */
export function slashModelKey(model: string | null): string {
  if (model === null) return "";
  const last = model.trim().split("/").at(-1) ?? "";
  return bounded(undecorated(last));
}
/** A JSON array text longer than this is not parsed: a model the observation keeps is far shorter (MAX_RELAY_MODEL_BYTES). */
const MODEL_ARRAY_BYTES = 1024;
/**
 * DeepSeek Harness's model key. dsh reports its model as a JSON array text of the provider and the model, such as
 * `["deepseek-official","deepseek-v4-flash"]`, and the model that runs is the array's last item (probe record 2026-11-10, F8:
 * the key was that whole text). The last item goes through slashModelKey; an array whose last item is no string (an empty array,
 * a number, null, an object or a nested array) names no model: "". Any other text, invalid JSON and a non-array included, is
 * read as slashModelKey reads it.
 */
export function dshModelKey(model: string | null): string {
  if (model === null) return "";
  const text = model.trim();
  if (text.startsWith("[") && text.endsWith("]") && Buffer.byteLength(text) <= MODEL_ARRAY_BYTES) {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return slashModelKey(model); }
    if (Array.isArray(parsed)) { const last = parsed.at(-1); return typeof last === "string" ? slashModelKey(last) : ""; }
  }
  return slashModelKey(model);
}
/**
 * Hermes's model key: its models are `<provider>:<model>` (server.py `_encode_model_choice`), so the provider before the
 * first colon goes, then any `/` path, then the decorations; "" for null, an empty result or one over 96 bytes.
 */
export function hermesModelKey(model: string | null): string {
  if (model === null) return "";
  const text = model.trim(), provider = providerOf(text, ":");
  return slashModelKey(provider === null ? text : text.slice(text.indexOf(":") + 1));
}
