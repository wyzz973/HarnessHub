import { lstat } from "node:fs/promises";
import path from "node:path";
import type {
  EngineMcpServer,
  SecretReference,
} from "../domain/engine-configuration.js";
import { canonicalDirectory, directories } from "./files.js";
import { isStdioMcp, packageError } from "./manifest.js";
import { verifyInstalled } from "./store.js";
import {
  SESSION_WORKSPACE_PLACEHOLDER,
  type ToolPackageArgument,
  type ToolPackageBinding,
  type ToolPackageConfiguration,
} from "./types.js";

/** Longest managed command MCP configuration, matching the engine configuration text limit. */
const CLI_CONFIGURATION_LIMIT = 8192;

function secretReference(value: unknown): SecretReference {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw packageError(
      "INVALID_TOOL_PACKAGE_BINDING",
      "Expected a secret location reference, never a credential value",
    );
  const reference = value as Record<string, unknown>;
  if (
    Object.keys(reference).sort().join(",") !== "kind,value" ||
    typeof reference.value !== "string" ||
    reference.value.length > 8192 ||
    reference.value.includes("\0")
  )
    throw packageError(
      "INVALID_TOOL_PACKAGE_BINDING",
      "Invalid secret reference",
    );
  const location = reference.value;
  if (reference.kind === "env" && /^[A-Z][A-Z0-9_]*$/.test(location))
    return { kind: "env", value: location };
  if (reference.kind === "file" && path.isAbsolute(location))
    return { kind: "file", value: location };
  if (
    reference.kind === "keychain" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      location,
    )
  )
    return { kind: "keychain", value: location };
  throw packageError(
    "INVALID_TOOL_PACKAGE_BINDING",
    "Secret locations must be an environment name, absolute file, or credential-store UUID",
  );
}

/** Command MCP argument naming the Session directory; see drivers/tool-command/config.ts. */
export const COMMAND_MCP_WORKSPACE_FLAG = "--workspace";

/**
 * Verifies the entire package, then resolves explicit anchors without executing
 * anything or reading secrets. Package anchors become absolute paths inside the
 * installed content object; workspace anchors and the managed CLI working
 * directory become {@link SESSION_WORKSPACE_PLACEHOLDER}, which the owning
 * Worker replaces with the Session directory. Secret slots use the supplied
 * binding, else the manifest's env default; a slot without either fails with
 * INVALID_TOOL_PACKAGE_BINDING. The result is engine-independent; callers
 * merge it into an EngineConfiguration and validate it with prepareEngine.
 */
export async function bindInstalled(
  root: string,
  id: string,
  version: string,
  options: ToolPackageBinding,
): Promise<ToolPackageConfiguration> {
  const installed = await verifyInstalled(root, id, version);
  const object = path.join(
    await canonicalDirectory(root),
    "objects",
    installed.record.digest,
  );
  const servers = installed.manifest.mcpServers ?? [];
  const stdioServers = servers.filter(isStdioMcp);
  const cliTools = installed.manifest.cliTools ?? [];
  const needsNode =
    cliTools.length > 0 ||
    stdioServers.some((server) => server.launch === "node");
  if (needsNode) {
    if (!path.isAbsolute(options.nodeExecutable))
      throw packageError(
        "INVALID_TOOL_PACKAGE_BINDING",
        "The caller must supply an absolute bundled Node executable",
      );
    await directories(path.dirname(options.nodeExecutable));
    const node = await lstat(options.nodeExecutable);
    if (
      !node.isFile() ||
      node.isSymbolicLink() ||
      (process.platform !== "win32" && !(node.mode & 0o100))
    )
      throw packageError(
        "INVALID_TOOL_PACKAGE_BINDING",
        "The bundled Node executable must be a regular executable file",
      );
  }
  if (cliTools.length) {
    if (!options.commandMcpEntry || !path.isAbsolute(options.commandMcpEntry))
      throw packageError(
        "INVALID_TOOL_PACKAGE_BINDING",
        "CLI tools require the bundled HarnessHub command MCP entry",
      );
    const entry = await lstat(options.commandMcpEntry);
    if (!entry.isFile() || entry.isSymbolicLink())
      throw packageError(
        "INVALID_TOOL_PACKAGE_BINDING",
        "The HarnessHub command MCP entry must be a regular file",
      );
    if (servers.some((server) => server.name.toLowerCase() === "cli"))
      throw packageError(
        "TOOL_PACKAGE_BIND_CONFLICT",
        "MCP server name cli is reserved when cliTools are present",
      );
    if (servers.length >= 16)
      throw packageError(
        "INVALID_TOOL_PACKAGE_BINDING",
        "A Tool Pack with CLI tools can contain at most 15 additional MCP servers",
      );
  }
  const slots = new Set(
    servers.flatMap((server) =>
      Object.values(
        (isStdioMcp(server) ? server.secretEnv : server.secretHeaders) ?? {},
      ),
    ),
  );
  const supplied = options.secretBindings ?? {};
  if (
    !supplied ||
    typeof supplied !== "object" ||
    Array.isArray(supplied) ||
    Object.keys(supplied).some((name) => !slots.has(name))
  )
    throw packageError(
      "INVALID_TOOL_PACKAGE_BINDING",
      "Secret bindings must match this package's explicit slots",
    );
  const defaults = installed.manifest.defaultSecretBindings ?? {};
  const references = new Map<string, SecretReference>();
  for (const slot of slots)
    references.set(
      slot,
      secretReference(
        Object.hasOwn(supplied, slot)
          ? supplied[slot]
          : Object.hasOwn(defaults, slot)
            ? defaults[slot]
            : undefined,
      ),
    );
  const referenced = (mapping: Record<string, string> | undefined) =>
    Object.fromEntries(
      Object.entries(mapping ?? {}).map(([name, slot]) => [
        name,
        references.get(slot)!,
      ]),
    );
  const resolve = (relative: string) =>
    path.join(object, ...relative.split("/"));
  const resolveArgs = (args: ToolPackageArgument[] | undefined) =>
    (args ?? []).map((argument) =>
      typeof argument === "string"
        ? argument
        : argument.anchor === "workspace"
          ? SESSION_WORKSPACE_PLACEHOLDER
          : resolve(argument.path),
    );
  const skills = (installed.manifest.skills ?? []).map((skill) => ({
    path: resolve(skill.path),
    enabled: true,
    sha256: installed.manifest.files.find((file) => file.path === skill.path)!
      .sha256,
  }));
  const mcpServers: EngineMcpServer[] = servers.map((server) => {
    if (!isStdioMcp(server))
      return {
        name: `${id}-${server.name}`,
        type: server.type,
        enabled: true,
        url: server.url,
        ...(server.headers ? { headers: { ...server.headers } } : {}),
        ...(server.secretHeaders
          ? { secretHeaders: referenced(server.secretHeaders) }
          : {}),
      };
    const args = resolveArgs(server.args);
    return {
      name: `${id}-${server.name}`,
      type: "stdio",
      enabled: true,
      command:
        server.launch === "node"
          ? path.resolve(options.nodeExecutable)
          : resolve(server.entry),
      args: server.launch === "node" ? [resolve(server.entry), ...args] : args,
      ...(server.env ? { env: { ...server.env } } : {}),
      ...(server.secretEnv ? { secretEnv: referenced(server.secretEnv) } : {}),
    };
  });
  if (cliTools.length) {
    // Workspace anchors stay structured inside the JSON value; the command MCP
    // resolves them from its own --workspace argument. A raw placeholder in
    // this env value would be rewritten by the Worker without JSON escaping.
    const commandConfig = cliTools.map((tool) => ({
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      command:
        tool.launch === "node"
          ? path.resolve(options.nodeExecutable)
          : resolve(tool.entry),
      prefixArgs: [
        ...(tool.launch === "node" ? [resolve(tool.entry)] : []),
        ...(tool.args ?? []).map((argument) =>
          typeof argument === "string"
            ? argument
            : argument.anchor === "workspace"
              ? { anchor: "workspace" as const }
              : resolve(argument.path),
        ),
      ],
    }));
    const encoded = JSON.stringify(commandConfig);
    if (encoded.includes(SESSION_WORKSPACE_PLACEHOLDER))
      throw packageError(
        "INVALID_TOOL_PACKAGE_BINDING",
        `CLI tool declarations must use {"anchor":"workspace"} instead of ${SESSION_WORKSPACE_PLACEHOLDER}`,
      );
    if (encoded.length > CLI_CONFIGURATION_LIMIT)
      throw packageError(
        "INVALID_TOOL_PACKAGE_BINDING",
        // Every tool repeats the resolved Node and entry paths, so the same pack can fit
        // under a short installation root and not under a long one.
        `CLI tool declarations exceed the managed command MCP configuration limit (${encoded.length} of ${CLI_CONFIGURATION_LIMIT} characters for ${cliTools.length} tools; shorten the descriptions, install fewer tools in one package, or use a shorter installation path)`,
      );
    mcpServers.push({
      name: `${id}-cli`,
      type: "stdio",
      enabled: true,
      command: path.resolve(options.nodeExecutable),
      args: [
        path.resolve(options.commandMcpEntry!),
        COMMAND_MCP_WORKSPACE_FLAG,
        SESSION_WORKSPACE_PLACEHOLDER,
      ],
      env: { HHCAP_CLI_TOOLS_JSON: encoded },
    });
  }
  return { skills, mcpServers };
}
