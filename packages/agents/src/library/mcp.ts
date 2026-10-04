// SPDX-License-Identifier: MIT
/**
 * An MCP server as each agent writes it (Magpie internal/library/mcp.go
 * `encode`, @2e340f7) and its secrets: a reference to an environment
 * variable where the agent's configuration can name one, or, only with
 * explicit consent, the value (04 section 8).
 */
import type { ConfigValue } from "../wiring/formats/index.js";
import type { McpPlacement, McpStyle } from "./targets.js";
import type { LibrarySecretRef, McpServerItem } from "./types.js";

/** A secret as written: the variable the agent reads it from, or its value. */
export type RenderedSecret = { variable: string } | { value: string };

export interface SecretRendering {
  /** Write values of secrets the agent cannot reference (`--allow-plaintext-secret`). */
  allowPlaintext: boolean;
  /** The value of a reference; called only with `allowPlaintext`. */
  resolve(ref: LibrarySecretRef): Promise<string>;
  /** Whether a value is one of HarnessHub's own credentials (07 section 4.6). */
  forbiddenValue(value: string): Promise<boolean>;
}

/**
 * The secrets of `server` as `placement`'s agent receives them, or why the
 * server cannot go there: an unsupported transport, or a secret the agent
 * cannot reference while values may not be written.
 */
export async function renderSecrets(
  server: McpServerItem,
  placement: McpPlacement,
  rendering: SecretRendering,
): Promise<
  | {
      env: Record<string, RenderedSecret>;
      headers: Record<string, RenderedSecret>;
      plaintext: boolean;
    }
  | { refused: string }
> {
  if (!placement.transports.includes(server.transport))
    return {
      refused: `this agent does not reach MCP servers over ${server.transport}`,
    };
  let plaintext = false;
  const render = async (
    name: string,
    ref: LibrarySecretRef,
    header: boolean,
  ): Promise<RenderedSecret | string> => {
    const indirection = placement.indirection;
    // Codex passes environment variables through by their own name only.
    const referable =
      indirection !== undefined &&
      ref.kind === "env" &&
      (indirection !== "codex" || header || name === ref.value);
    if (referable) return { variable: ref.value };
    if (!rendering.allowPlaintext)
      return indirection === undefined
        ? `this agent cannot reference a secret in its MCP configuration (${name}); allow writing secret values to write it as plain text`
        : ref.kind !== "env"
          ? `${name} is a ${ref.kind} secret, which the agent cannot reference; use an env secret, or allow writing secret values`
          : `Codex passes environment variables through by their own name: name ${name}'s variable ${name}, or allow writing secret values`;
    const value = await rendering.resolve(ref);
    if (await rendering.forbiddenValue(value))
      return `${name} resolves to a HarnessHub credential, which a tool may not receive`;
    plaintext = true;
    return { value };
  };
  const env: Record<string, RenderedSecret> = {};
  const headers: Record<string, RenderedSecret> = {};
  for (const [name, ref] of Object.entries(server.secretEnv ?? {})) {
    const rendered = await render(name, ref, false);
    if (typeof rendered === "string") return { refused: rendered };
    env[name] = rendered;
  }
  for (const [name, ref] of Object.entries(server.secretHeaders ?? {})) {
    const rendered = await render(name, ref, true);
    if (typeof rendered === "string") return { refused: rendered };
    headers[name] = rendered;
  }
  return { env, headers, plaintext };
}

/** A secret reference in the agent's own spelling. */
function reference(style: McpStyle, variable: string): string {
  return style === "opencode" ? `{env:${variable}}` : `\${${variable}}`;
}

/** Plain values and rendered secrets as one map in the agent's spelling (Codex's references excluded). */
function merged(
  style: McpStyle,
  plain: Readonly<Record<string, string>> | undefined,
  secrets: Readonly<Record<string, RenderedSecret>>,
): Record<string, string> {
  const result: Record<string, string> = { ...plain };
  for (const [name, secret] of Object.entries(secrets))
    if ("value" in secret) result[name] = secret.value;
    else if (style !== "codex")
      result[name] = reference(style, secret.variable);
  return result;
}

/** The server's entry in `style`'s configuration, with rendered secrets. */
export function encodeServer(
  style: McpStyle,
  server: McpServerItem,
  secrets: {
    env: Readonly<Record<string, RenderedSecret>>;
    headers: Readonly<Record<string, RenderedSecret>>;
  },
): ConfigValue {
  const env = merged(style, server.env, secrets.env);
  const headers = merged(style, server.headers, secrets.headers);
  const some = (map: Record<string, string>) => Object.keys(map).length > 0;
  const remote = server.transport !== "stdio";
  const command = server.command ?? "";
  const args = server.args ?? [];
  const url = server.url ?? "";
  switch (style) {
    case "claude":
      return remote
        ? {
            type: server.transport,
            url,
            ...(some(headers) ? { headers } : {}),
          }
        : { type: "stdio", command, args, env };
    case "gemini":
      return remote
        ? {
            [server.transport === "http" ? "httpUrl" : "url"]: url,
            ...(some(headers) ? { headers } : {}),
          }
        : { command, args, ...(some(env) ? { env } : {}) };
    case "opencode":
      return remote
        ? {
            type: "remote",
            url,
            ...(some(headers) ? { headers } : {}),
            enabled: true,
          }
        : {
            type: "local",
            command: [command, ...args],
            ...(some(env) ? { environment: env } : {}),
            enabled: true,
          };
    case "pi":
      return remote
        ? { url, ...(some(headers) ? { headers } : {}) }
        : { command, args, ...(some(env) ? { env } : {}) };
    case "kimi":
      return remote
        ? {
            url,
            transport: server.transport,
            ...(some(headers) ? { headers } : {}),
          }
        : { command, args, ...(some(env) ? { env } : {}) };
    case "hermes":
      return remote
        ? {
            url,
            ...(some(headers) ? { headers } : {}),
            ...(server.transport === "sse" ? { transport: "sse" } : {}),
          }
        : { command, args, ...(some(env) ? { env } : {}) };
    case "codex": {
      const passed = Object.values(secrets.env).flatMap((secret) =>
        "variable" in secret ? [secret.variable] : [],
      );
      const fromEnv = Object.fromEntries(
        Object.entries(secrets.headers).flatMap(([name, secret]) =>
          "variable" in secret ? [[name, secret.variable]] : [],
        ),
      );
      return remote
        ? {
            url,
            ...(some(headers) ? { http_headers: headers } : {}),
            ...(some(fromEnv) ? { env_http_headers: fromEnv } : {}),
          }
        : {
            command,
            args,
            ...(some(env) ? { env } : {}),
            ...(passed.length ? { env_vars: passed } : {}),
          };
    }
  }
}
