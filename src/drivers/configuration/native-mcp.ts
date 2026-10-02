import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExecutionSpec } from "../../domain/ports.js";
import { HubError } from "../../domain/errors.js";
import type { PreparedConfiguration } from "./prepare.js";

const piExtension = fileURLToPath(
  new URL("../../../../scripts/native-mcp/pi-extension.mjs", import.meta.url),
);
type JsonObject = Record<string, unknown>;
type ReferencedServer =
  | {
      name: string;
      command: string;
      args: string[];
      env: Record<string, string>;
    }
  | {
      name: string;
      type: "http" | "sse";
      url: string;
      headers: Record<string, string>;
    };

function unsupported(message: string): never {
  throw new HubError("ENGINE_CONFIGURATION_UNSUPPORTED", message, 400);
}

async function privateObject(file: string, root: string): Promise<JsonObject> {
  const relative = path.relative(root, file);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    unsupported(
      "Native MCP requires this Session's managed private configuration",
    );
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink())
      unsupported("Native MCP configuration must be a regular private file");
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      unsupported("Native MCP configuration must contain an object");
    return value as JsonObject;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

function record(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

async function save(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function sdkUrls(command: string[]): Record<string, string> {
  for (const arg of command) {
    if (!path.isAbsolute(arg) || !/\.[cm]?js$/i.test(arg)) continue;
    const require = createRequire(arg);
    try {
      // This SDK is already part of the pinned engine closure. Resolve relative
      // to that installation, never from a user's global packages or the CWD.
      return Object.fromEntries(
        ["index", "stdio", "streamableHttp", "sse"].map((name) => [
          name,
          pathToFileURL(
            require.resolve(`@modelcontextprotocol/sdk/client/${name}.js`),
          ).href,
        ]),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND")
        throw error;
    }
  }
  return unsupported(
    "Pi native MCP requires the bundled MCP SDK beside its fixed adapter entry",
  );
}

/**
 * Consume Session MCP definitions using the fixed engine's native configuration.
 * Call once after provider preparation, before command normalization. Resolved
 * secrets stay in the owning engine's environment; files contain references only.
 * Native children remain owned by the formal Worker process tree. This function
 * starts no process and acquires no lifetime resource.
 */
export async function prepareNativeMcp(
  spec: ExecutionSpec,
  prepared: PreparedConfiguration,
): Promise<void> {
  const config = spec.profile.configuration;
  if (!config || !prepared.mcpServers.length) return;
  const adapter = config.adapter;
  if (!["pi", "openclaw", "kimi"].includes(adapter)) return;
  if (spec.profile.driver !== (adapter === "kimi" ? "cli" : "acp"))
    unsupported(
      "Native MCP requires Pi/OpenClaw ACP or Kimi's noninteractive CLI",
    );
  const root = path.resolve(spec.stateDir, "configuration");
  await mkdir(root, { recursive: true, mode: 0o700 });

  if (adapter === "kimi") {
    if (
      config.mcpServers?.some(
        (server) =>
          server.enabled &&
          (Object.keys(server.secretEnv ?? {}).length > 0 ||
            Object.keys(server.secretHeaders ?? {}).length > 0),
      )
    )
      unsupported(
        "Kimi 1.50.0 cannot resolve MCP secretEnv/secretHeaders without persisting their values; use an engine with native secret references",
      );
    if (
      prepared.command.some((arg) => /^--mcp-config(?:-file)?(?:=|$)/.test(arg))
    )
      unsupported(
        "Remove fixed Kimi MCP arguments before using Session MCP configuration",
      );
    if (!prepared.command.some((arg) => arg === "--quiet" || arg === "--print"))
      unsupported(
        "Kimi native MCP requires the fixed --quiet or --print CLI entry",
      );
    const file = path.join(root, "kimi-mcp.json");
    const servers = Object.fromEntries(
      prepared.mcpServers.map((server) => [
        server.name,
        "command" in server
          ? {
              command: server.command,
              args: server.args,
              env: Object.fromEntries(
                server.env.map(({ name, value }) => [name, value]),
              ),
            }
          : {
              url: server.url,
              transport: server.type,
              headers: Object.fromEntries(
                server.headers.map(({ name, value }) => [name, value]),
              ),
            },
      ]),
    );
    await save(file, { mcpServers: servers });
    prepared.command.push("--mcp-config-file", file);
  } else {
    const servers: ReferencedServer[] = prepared.mcpServers.map(
      (server, index) => {
        const fields = "command" in server ? server.env : server.headers;
        const references = Object.fromEntries(
          fields.map(({ name, value }, field) => {
            const alias = `HARNESSHUB_NATIVE_MCP_${index}_${field}`;
            prepared.env[alias] = value;
            return [name, alias];
          }),
        );
        return "command" in server
          ? {
              name: server.name,
              command: server.command,
              args: server.args,
              env: references,
            }
          : {
              name: server.name,
              type: server.type,
              url: server.url,
              headers: references,
            };
      },
    );
    if (adapter === "pi") {
      const directory = prepared.env.PI_CODING_AGENT_DIR ?? root;
      const file = path.join(directory, "settings.json");
      const settings = await privateObject(file, root);
      const extensions = settings.extensions ?? [];
      if (
        !Array.isArray(extensions) ||
        extensions.some((item) => typeof item !== "string")
      )
        unsupported("Pi extensions must be an array of local paths");
      const mcpFile = path.join(root, "pi-mcp.json");
      await save(mcpFile, {
        servers,
        sdk: sdkUrls(prepared.command),
        cwd: spec.cwd,
      });
      await save(file, {
        ...settings,
        extensions: [...new Set([...extensions, piExtension])],
      });
      prepared.env.PI_CODING_AGENT_DIR = directory;
      prepared.env.HARNESSHUB_NATIVE_MCP_CONFIG = mcpFile;
    } else {
      const file =
        prepared.env.OPENCLAW_CONFIG_PATH ?? path.join(root, "openclaw.json");
      const native = await privateObject(file, root);
      const entries = Object.fromEntries(
        servers.map((server) => {
          const fields = "command" in server ? server.env : server.headers;
          const references = Object.fromEntries(
            Object.entries(fields).map(([name, alias]) => [
              name,
              `\${${alias}}`,
            ]),
          );
          return [
            server.name,
            "command" in server
              ? {
                  command: server.command,
                  args: server.args,
                  env: references,
                  cwd: spec.cwd,
                }
              : {
                  url: server.url,
                  transport: server.type === "http" ? "streamable-http" : "sse",
                  headers: references,
                },
          ];
        }),
      );
      const oldMcp = record(native.mcp);
      const oldServers = record(oldMcp.servers);
      if (Object.keys(oldServers).some((name) => name in entries))
        unsupported(
          "Session MCP server conflicts with an existing private OpenClaw server",
        );
      await save(file, {
        ...native,
        mcp: { ...oldMcp, servers: { ...oldServers, ...entries } },
      });
      prepared.env.OPENCLAW_CONFIG_PATH = file;
      prepared.env.OPENCLAW_STATE_DIR = root;
    }
  }
  // Each definition has exactly one native owner; never also forward it over ACP.
  prepared.mcpServers = [];
}
