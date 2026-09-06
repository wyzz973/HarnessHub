import path from "node:path";
import { parseArgs } from "node:util";
import type {
  EngineConfiguration,
  SecretReference,
} from "../domain/engine-configuration.js";
import type { EngineRegistration } from "../domain/engines.js";
import type { EngineProfile } from "../domain/types.js";
import { bindInstalled } from "./bind.js";
import { PackageReader } from "./files.js";
import { canonicalJson, packageError } from "./manifest.js";
import {
  inspectLocal,
  installLocal,
  listInstalled,
  removeInstalled,
  verifyInstalled,
} from "./store.js";

export interface ToolPackageCliContext {
  root: string;
  nodeExecutable: string;
  workspace?: string;
  /** Composition root injects the existing engine validator. No model invocation is required. */
  prepareEngine: (input: unknown) => Promise<EngineProfile>;
}
export interface ToolPackageBindResult {
  registration: EngineRegistration;
  revision: string;
  package: { id: string; version: string };
}

async function readJson(file: string, maximum: number): Promise<unknown> {
  if (!path.isAbsolute(file))
    throw packageError(
      "INVALID_TOOL_PACKAGE_ARGUMENT",
      "JSON input files must use an absolute local path",
    );
  const reader = await PackageReader.create();
  try {
    const bytes = await reader.read(file, maximum);
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      ) as unknown;
    } catch {
      throw packageError(
        "INVALID_TOOL_PACKAGE_ARGUMENT",
        "Input file must contain valid UTF-8 JSON",
      );
    }
  } finally {
    await reader.close();
  }
}
function merge<T>(existing: T[], incoming: T[], key: (item: T) => string): T[] {
  const result = [...existing];
  for (const item of incoming) {
    const found = result.find((previous) => key(previous) === key(item));
    if (!found) result.push(item);
    else if (canonicalJson(found) !== canonicalJson(item))
      throw packageError(
        "TOOL_PACKAGE_BIND_CONFLICT",
        "An existing Skill or MCP name has different configuration; choose an explicit engine configuration before binding",
      );
  }
  return result;
}

/** Parses only local package commands. Returns JSON data for the caller to print or persist. */
export async function runToolPackageCli(
  argv: string[],
  context: ToolPackageCliContext,
): Promise<unknown> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        source: { type: "string" },
        id: { type: "string" },
        version: { type: "string" },
        engine: { type: "string" },
        workspace: { type: "string" },
        bindings: { type: "string" },
        "include-removed": { type: "boolean" },
      },
    });
  } catch {
    throw packageError(
      "INVALID_TOOL_PACKAGE_ARGUMENT",
      "Expected inspect/install --source, list [--include-removed], verify/remove --id --version, or bind --id --version --engine [--workspace] [--bindings]",
    );
  }
  const [command] = parsed.positionals;
  const allowed: Record<string, string[]> = {
    inspect: ["source"],
    install: ["source"],
    list: ["include-removed"],
    verify: ["id", "version"],
    remove: ["id", "version"],
    bind: ["id", "version", "engine", "workspace", "bindings"],
  };
  if (
    !command ||
    parsed.positionals.length !== 1 ||
    !Object.hasOwn(allowed, command) ||
    Object.keys(parsed.values).some((key) => !allowed[command]!.includes(key))
  )
    throw packageError(
      "INVALID_TOOL_PACKAGE_ARGUMENT",
      "Unknown package command or unexpected option",
    );
  const required = (name: string): string => {
    const value = parsed.values[name];
    if (typeof value !== "string" || !value.length)
      throw packageError("INVALID_TOOL_PACKAGE_ARGUMENT", `Missing --${name}`);
    return value;
  };
  if (command === "inspect") return inspectLocal(required("source"));
  if (command === "install")
    return installLocal(required("source"), context.root);
  if (command === "list")
    return listInstalled(context.root, {
      includeRemoved: parsed.values["include-removed"] === true,
    });
  const id = required("id");
  const version = required("version");
  if (command === "verify") return verifyInstalled(context.root, id, version);
  if (command === "remove") return removeInstalled(context.root, id, version);
  const input = await readJson(required("engine"), 1024 * 1024);
  const base = await context.prepareEngine(input);
  const workspace =
    typeof parsed.values.workspace === "string"
      ? parsed.values.workspace
      : context.workspace;
  if (!workspace)
    throw packageError(
      "INVALID_TOOL_PACKAGE_ARGUMENT",
      "Binding requires an explicit --workspace or caller workspace",
    );
  const secretBindings =
    typeof parsed.values.bindings === "string"
      ? ((await readJson(parsed.values.bindings, 65536)) as Record<
          string,
          SecretReference
        >)
      : undefined;
  const fragment = await bindInstalled(context.root, id, version, {
    nodeExecutable: context.nodeExecutable,
    workspace,
    ...(secretBindings !== undefined ? { secretBindings } : {}),
  });
  const configuration: EngineConfiguration = {
    ...base.configuration,
    adapter: base.configuration?.adapter ?? "generic",
    skills: merge(base.configuration?.skills ?? [], fragment.skills, (skill) =>
      process.platform === "win32" ? skill.path.toLowerCase() : skill.path,
    ),
    mcpServers: merge(
      base.configuration?.mcpServers ?? [],
      fragment.mcpServers,
      (server) => server.name.toLowerCase(),
    ),
  };
  const registration = { ...(input as EngineRegistration), configuration };
  const prepared = await context.prepareEngine(registration);
  const result: ToolPackageBindResult = {
    registration: { ...registration, configuration: prepared.configuration! },
    revision: prepared.revision,
    package: { id, version },
  };
  return result;
}
