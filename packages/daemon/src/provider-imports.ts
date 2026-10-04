// SPDX-License-Identifier: MIT
/**
 * Upstreams that other apps on this machine are configured with, read so
 * that they can be imported as providers (Magpie's "import from other
 * apps", yetone/magpie@2e340f7 `importapps.go`, `import_codex.go`): the
 * relay Claude Code's `settings.json` points at, and every
 * `[model_providers.*]` table of Codex's `config.toml`. Files are located
 * like global wiring locates them, under the wiring home only, and are only
 * read; values are returned to the caller, which treats keys as secrets.
 */
import { stat } from "node:fs/promises";
import type { ImportApp } from "@harnesshub/core/import-links";
import type { ApiKeyHeader, WireProtocol } from "@harnesshub/core/model-plane";
import { wiringAdapter, WiringError } from "@harnesshub/agents/wiring/index";
import { editors } from "@harnesshub/agents/wiring/formats/index";
import {
  decodeText,
  isCode,
  readState,
  resolveFile,
} from "@harnesshub/agents/wiring/files";
import { adapterEnvironment } from "@harnesshub/agents/wiring/operations";
import type { WiringHome } from "./agents-wiring.js";

/** Configuration files larger than this are refused rather than read. */
const MAX_CONFIG_BYTES = 1024 * 1024;

/** One upstream an app is configured with. */
export interface AppUpstream {
  /** Stable within the file: `settings` for Claude Code, the table name for Codex. */
  ref: string;
  name: string;
  endpoints: Partial<Record<WireProtocol, string>>;
  apiKeyHeader: ApiKeyHeader;
  /** The key itself (a secret), or the environment variable the app reads it from. */
  key?: { value: string } | { env: string };
  models: string[];
  /** Non-secret headers the app sends; values may still be sensitive and are not shown. */
  headers?: Record<string, string>;
}

/** What one app's configuration holds. */
export interface AppConfiguration {
  /** The file read, or undefined when it does not exist. */
  file: string | undefined;
  upstreams: AppUpstream[];
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const string = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

/** A pasted base URL: trimmed, without a trailing slash, `https://` when it names no scheme. */
function base(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
}

/**
 * Read the file of `adapterId` that global wiring would edit, if it exists:
 * through symlinks only within the home (or the app's directory override),
 * a regular file of at most 1 MiB, parsed by its format.
 *
 * @throws WiringError for a symlink escape, a non-regular or oversized
 *   file, or content that does not parse (messages never contain values).
 */
async function readConfig(
  adapterId: string,
  home: WiringHome,
): Promise<{ file: string; document: Record<string, unknown> } | undefined> {
  const adapter = wiringAdapter(adapterId);
  const spec = adapter.files[0]!;
  const location = spec.locate(
    adapterEnvironment({ home: home.home, dataDir: home.home, env: home.env }),
  );
  for (const candidate of location.candidates) {
    const resolved = await resolveFile(candidate, [location.root]);
    const info = await stat(resolved.realPath).catch((error: unknown) => {
      if (isCode(error, "ENOENT")) return undefined;
      throw error;
    });
    if (!info) continue;
    if (info.size > MAX_CONFIG_BYTES)
      throw new WiringError(
        "WIRING_UNSUPPORTED_STRUCTURE",
        "The configuration file is larger than 1 MiB; it is not read",
        { path: candidate },
      );
    const state = await readState(resolved.realPath);
    if (!state.exists) continue;
    const { text } = decodeText(state.bytes, candidate);
    return {
      file: candidate,
      document: editors[spec.format].parse(text),
    };
  }
  return undefined;
}

/** Claude Code: `env.ANTHROPIC_BASE_URL` and its token, or nothing when it signs in to Anthropic itself. */
function claudeUpstreams(document: Record<string, unknown>): AppUpstream[] {
  const env = record(document.env) ?? {};
  const url = string(env.ANTHROPIC_BASE_URL);
  if (url === undefined) return [];
  const anthropic = base(url);
  const token = string(env.ANTHROPIC_AUTH_TOKEN);
  const apiKey = string(env.ANTHROPIC_API_KEY);
  const models = [
    "ANTHROPIC_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_SMALL_FAST_MODEL",
  ]
    .map((name) => string(env[name]))
    .filter((model): model is string => model !== undefined);
  return [
    {
      ref: "settings",
      name: URL.canParse(anthropic) ? new URL(anthropic).host : "claude-code",
      endpoints: { anthropic },
      // Claude Code sends ANTHROPIC_AUTH_TOKEN as a bearer token and
      // ANTHROPIC_API_KEY as x-api-key.
      apiKeyHeader:
        token === undefined && apiKey !== undefined
          ? "x-api-key"
          : "authorization-bearer",
      ...(token !== undefined
        ? { key: { value: token } }
        : apiKey !== undefined
          ? { key: { value: apiKey } }
          : {}),
      models: [...new Set(models)],
    },
  ];
}

/**
 * Codex: one upstream per `[model_providers.<id>]` with a `base_url`. The key
 * is `experimental_bearer_token`, else the variable `env_key` names; the
 * endpoint is chat for `wire_api = "chat"`, responses otherwise; models are
 * the top-level `model` and those of `[profiles.*]` that select the table.
 */
function codexUpstreams(document: Record<string, unknown>): AppUpstream[] {
  const tables = record(document.model_providers) ?? {};
  const profiles = Object.values(record(document.profiles) ?? {})
    .map(record)
    .filter((item): item is Record<string, unknown> => item !== undefined);
  const selected = string(document.model_provider);
  const upstreams: AppUpstream[] = [];
  for (const [id, value] of Object.entries(tables).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const table = record(value);
    const url = table && string(table.base_url);
    if (!table || url === undefined) continue;
    const protocol: WireProtocol =
      string(table.wire_api) === "chat" ? "chat" : "responses";
    const token = string(table.experimental_bearer_token);
    const env = string(table.env_key);
    const models = [
      ...(selected === id ? [string(document.model)] : []),
      ...profiles
        .filter(
          (profile) => (string(profile.model_provider) ?? selected) === id,
        )
        .map((profile) => string(profile.model)),
    ].filter((model): model is string => model !== undefined);
    const headers = Object.fromEntries(
      Object.entries(record(table.http_headers) ?? {}).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    upstreams.push({
      ref: id,
      name: string(table.name) ?? id,
      endpoints: { [protocol]: base(url) },
      apiKeyHeader: "authorization-bearer",
      ...(token !== undefined
        ? { key: { value: token } }
        : env !== undefined
          ? { key: { env } }
          : {}),
      models: [...new Set(models)],
      ...(Object.keys(headers).length ? { headers } : {}),
    });
  }
  return upstreams;
}

/**
 * The upstreams `app` is configured with in `home`. A missing file is no
 * upstream, not an error. Nothing is written and nothing is fetched.
 *
 * @throws WiringError when the file cannot be read safely or parsed.
 */
export async function readAppConfiguration(
  app: ImportApp,
  home: WiringHome,
): Promise<AppConfiguration> {
  const read = await readConfig(
    app === "claude-code" ? "claude" : "codex",
    home,
  );
  if (!read) return { file: undefined, upstreams: [] };
  return {
    file: read.file,
    upstreams:
      app === "claude-code"
        ? claudeUpstreams(read.document)
        : codexUpstreams(read.document),
  };
}
