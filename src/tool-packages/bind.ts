import { lstat } from "node:fs/promises";
import path from "node:path";
import type {
  EngineMcpServer,
  SecretReference,
} from "../domain/engine-configuration.js";
import { canonicalDirectory, directories } from "./files.js";
import { packageError } from "./manifest.js";
import { verifyInstalled } from "./store.js";
import type {
  ToolPackageArgument,
  ToolPackageBinding,
  ToolPackageConfiguration,
} from "./types.js";

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

/** Verifies the entire package, then resolves explicit anchors without executing or reading secrets. */
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
  const workspace = await canonicalDirectory(options.workspace);
  const cliTools = installed.manifest.cliTools ?? [];
  const needsNode =
    cliTools.length > 0 ||
    installed.manifest.mcpServers?.some((server) => server.launch === "node");
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
    if (
      installed.manifest.mcpServers?.some(
        (server) => server.name.toLowerCase() === "cli",
      )
    )
      throw packageError(
        "TOOL_PACKAGE_BIND_CONFLICT",
        "MCP server name cli is reserved when cliTools are present",
      );
    if ((installed.manifest.mcpServers?.length ?? 0) >= 16)
      throw packageError(
        "INVALID_TOOL_PACKAGE_BINDING",
        "A Tool Pack with CLI tools can contain at most 15 additional MCP servers",
      );
  }
  const slots = new Set(
    (installed.manifest.mcpServers ?? []).flatMap((server) =>
      Object.values(server.secretEnv ?? {}),
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
  const references = new Map<string, SecretReference>();
  for (const slot of slots)
    references.set(
      slot,
      secretReference(
        Object.hasOwn(supplied, slot) ? supplied[slot] : undefined,
      ),
    );
  const resolve = (relative: string) =>
    path.join(object, ...relative.split("/"));
  const resolveArgs = (args: ToolPackageArgument[] | undefined) =>
    (args ?? []).map((argument) =>
      typeof argument === "string"
        ? argument
        : argument.anchor === "workspace"
          ? workspace
          : resolve(argument.path),
    );
  const skills = (installed.manifest.skills ?? []).map((skill) => ({
    path: resolve(skill.path),
    enabled: true,
    sha256: installed.manifest.files.find((file) => file.path === skill.path)!
      .sha256,
  }));
  const mcpServers: EngineMcpServer[] = (
    installed.manifest.mcpServers ?? []
  ).map((server) => {
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
      ...(server.secretEnv
        ? {
            secretEnv: Object.fromEntries(
              Object.entries(server.secretEnv).map(([name, slot]) => [
                name,
                references.get(slot)!,
              ]),
            ),
          }
        : {}),
    };
  });
  if (cliTools.length) {
    const commandConfig = cliTools.map((tool) => {
      const args = resolveArgs(tool.args);
      return {
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        command:
          tool.launch === "node"
            ? path.resolve(options.nodeExecutable)
            : resolve(tool.entry),
        prefixArgs:
          tool.launch === "node" ? [resolve(tool.entry), ...args] : args,
      };
    });
    const encoded = JSON.stringify(commandConfig);
    if (encoded.length > 8192)
      throw packageError(
        "INVALID_TOOL_PACKAGE_BINDING",
        "CLI tool declarations exceed the managed command MCP configuration limit",
      );
    mcpServers.push({
      name: `${id}-cli`,
      type: "stdio",
      enabled: true,
      command: path.resolve(options.nodeExecutable),
      args: [path.resolve(options.commandMcpEntry!)],
      env: {
        HHCAP_CLI_WORKSPACE: workspace,
        HHCAP_CLI_TOOLS_JSON: encoded,
      },
    });
  }
  return { skills, mcpServers };
}
