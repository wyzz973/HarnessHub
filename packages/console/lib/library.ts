// SPDX-License-Identifier: MIT
/**
 * Library helpers of the console (docs/library.md): the agents it writes
 * into, and the MCP server form. Secrets in the form are references (an
 * environment variable or a file on the daemon's machine), a value sent
 * once for the daemon's secret store, or a stored secret kept as it is; the
 * daemon never returns a value, and the page never stores one.
 */
import type {
  Agent,
  LibraryAgent,
  LibraryMcpInput,
  LibraryMcpServer,
  LibrarySecretInput,
  LibrarySecretRef,
} from "@harnesshub/sdk/client";
import { t } from "./i18n";

/** The agents the Library writes into, in the daemon's order. */
export const libraryAgents: readonly LibraryAgent[] = [
  "claude",
  "codex",
  "gemini",
  "qwen",
  "opencode",
  "pi",
  "crush",
  "kimi",
  "hermes",
];

/** Agents without a user-level instruction file (the daemon refuses them). */
export const noInstructionFile: ReadonlySet<LibraryAgent> = new Set([
  "kimi",
  "hermes",
]);

/** Agents without SSE MCP servers (the daemon refuses them). */
export const noSse: ReadonlySet<LibraryAgent> = new Set(["codex", "pi"]);

export function isLibraryAgent(id: string): id is LibraryAgent {
  return (libraryAgents as readonly string[]).includes(id);
}

/** The Library agents found on this machine, in the Library's order. */
export function installedLibraryAgents(
  agents: readonly Agent[],
): LibraryAgent[] {
  const installed = new Set(
    agents
      .filter((agent) => agent.installation.status !== "not-found")
      .map((agent) => agent.id),
  );
  return libraryAgents.filter((id) => installed.has(id));
}

/** One secret of the form, by name. `keep` is a stored secret sent back unchanged. */
export interface SecretRow {
  name: string;
  kind: "env" | "file" | "value" | "keep";
  /** The variable name, the absolute path or the new value; unused for `keep`. */
  value: string;
  /** The stored reference a `keep` row stands for. */
  stored?: LibrarySecretRef;
}

export interface McpForm {
  name: string;
  transport: "stdio" | "http" | "sse";
  command: string;
  /** One argument per line. */
  args: string;
  url: string;
  /** `NAME=value`, one per line. */
  env: string;
  /** `Name: value`, one per line. */
  headers: string;
  secretEnv: SecretRow[];
  secretHeaders: SecretRow[];
  agents: LibraryAgent[];
}

export function emptyMcpForm(): McpForm {
  return {
    name: "",
    transport: "stdio",
    command: "",
    args: "",
    url: "",
    env: "",
    headers: "",
    secretEnv: [],
    secretHeaders: [],
    agents: [],
  };
}

function rowsOf(refs: Record<string, LibrarySecretRef> | undefined) {
  return Object.entries(refs ?? {}).map(([name, ref]): SecretRow =>
    ref.kind === "store"
      ? { name, kind: "keep", value: "", stored: ref }
      : { name, kind: ref.kind, value: ref.value },
  );
}

export function mcpFormOf(server: LibraryMcpServer): McpForm {
  return {
    name: server.name,
    transport: server.transport,
    command: server.command ?? "",
    args: (server.args ?? []).join("\n"),
    url: server.url ?? "",
    env: Object.entries(server.env ?? {})
      .map(([name, value]) => `${name}=${value}`)
      .join("\n"),
    headers: Object.entries(server.headers ?? {})
      .map(([name, value]) => `${name}: ${value}`)
      .join("\n"),
    secretEnv: rowsOf(server.secretEnv),
    secretHeaders: rowsOf(server.secretHeaders),
    agents: [...server.agents],
  };
}

/** `NAME=value` (or `Name: value`) lines; a line without the separator is an error. */
export function pairsOf(
  text: string,
  separator: "=" | ":",
  field: string,
): Record<string, string> {
  const pairs: Record<string, string> = {};
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line) continue;
    const at = line.indexOf(separator);
    if (at <= 0)
      throw new Error(
        t("library.lineFormat", {
          field,
          line: index + 1,
          format: separator === "=" ? "NAME=value" : "Name: value",
        }),
      );
    pairs[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return pairs;
}

function secretsOf(
  rows: readonly SecretRow[],
  field: string,
): Record<string, LibrarySecretInput> | undefined {
  const named = rows.filter((row) => row.name.trim());
  if (!named.length) return undefined;
  const secrets: Record<string, LibrarySecretInput> = {};
  for (const row of named) {
    const name = row.name.trim();
    if (row.kind === "keep") {
      if (!row.stored)
        throw new Error(t("library.secret.noStored", { field, name }));
      secrets[name] = row.stored;
    } else if (row.kind === "value") {
      if (!row.value)
        throw new Error(t("library.secret.needValue", { field, name }));
      secrets[name] = { secret: row.value };
    } else {
      if (!row.value.trim())
        throw new Error(
          row.kind === "env"
            ? t("library.secret.needEnv", { field, name })
            : t("library.secret.needFile", { field, name }),
        );
      secrets[name] = { kind: row.kind, value: row.value.trim() };
    }
  }
  return secrets;
}

/**
 * The `POST`/`PUT /library/mcp` body of the form. Throws an Error with a
 * readable message for a malformed line or an incomplete secret; the
 * daemon checks the rest (names, URLs, credential-like plain values and
 * references to HarnessHub's own credentials).
 */
export function mcpInput(form: McpForm): LibraryMcpInput {
  const stdio = form.transport === "stdio";
  const args = form.args
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const env = stdio ? pairsOf(form.env, "=", t("library.mcp.env")) : {};
  const headers = stdio
    ? {}
    : pairsOf(form.headers, ":", t("library.mcp.headers"));
  const secretEnv = stdio
    ? secretsOf(form.secretEnv, t("library.mcp.secretEnv"))
    : undefined;
  const secretHeaders = stdio
    ? undefined
    : secretsOf(form.secretHeaders, t("library.mcp.secretHeaders"));
  return {
    transport: form.transport,
    ...(stdio
      ? {
          command: form.command.trim(),
          ...(args.length ? { args } : {}),
          ...(Object.keys(env).length ? { env } : {}),
          ...(secretEnv ? { secretEnv } : {}),
        }
      : {
          url: form.url.trim(),
          ...(Object.keys(headers).length ? { headers } : {}),
          ...(secretHeaders ? { secretHeaders } : {}),
        }),
    agents: [...form.agents],
  };
}

/**
 * The secret rows a daemon message points at: `secretEnv.NAME` in a
 * validation message, or a reference whose variable name or path a
 * `SECRET_REF_FORBIDDEN` reason names. Keys are `secretEnv:NAME`.
 */
export function rowsNamedBy(message: string, form: McpForm): Set<string> {
  const named = new Set<string>();
  for (const field of ["secretEnv", "secretHeaders"] as const)
    for (const row of form[field]) {
      const name = row.name.trim();
      if (!name) continue;
      const value = row.value.trim();
      if (
        message.includes(`${field}.${name}`) ||
        ((row.kind === "env" || row.kind === "file") &&
          value &&
          message.includes(value))
      )
        named.add(`${field}:${name}`);
    }
  return named;
}

export function bytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  return `${(size / 1024 / 1024).toFixed(1)} MiB`;
}
