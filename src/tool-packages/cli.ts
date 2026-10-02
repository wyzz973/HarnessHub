import path from "node:path";
import { parseArgs } from "node:util";
import type { SecretReference } from "../domain/engine-configuration.js";
import type { EngineRegistration } from "../domain/engines.js";
import type { EngineProfile } from "../domain/types.js";
import { bindInstalled } from "./bind.js";
import { PackageReader } from "./files.js";
import { capabilities, footprint, planBinding } from "./footprint.js";
import {
  importKinds,
  importLocal,
  type ToolPackImportKind,
} from "./importer.js";
import { packageError } from "./manifest.js";
import {
  inspectLocal,
  installLocal,
  listInstalled,
  listManifests,
  removeInstalled,
  verifyInstalled,
} from "./store.js";
import type { ToolPackageCapabilities } from "./types.js";

export interface ToolPackageCliContext {
  root: string;
  nodeExecutable: string;
  commandMcpEntry?: string;
  /** @deprecated Ignored: bindings use the Session workspace placeholder (ADR 0013). */
  workspace?: string;
  /** Composition root injects the existing engine validator. No model invocation is required. */
  prepareEngine: (input: unknown) => Promise<EngineProfile>;
}
export interface ToolPackageBindResult {
  registration: EngineRegistration;
  revision: string;
  package: { id: string; version: string };
  capabilities?: ToolPackageCapabilities;
  /** Other versions of the package removed with --replace. */
  replaced?: string[];
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
        kind: { type: "string" },
        id: { type: "string" },
        version: { type: "string" },
        "display-name": { type: "string" },
        engine: { type: "string" },
        workspace: { type: "string" },
        bindings: { type: "string" },
        replace: { type: "boolean" },
        "include-removed": { type: "boolean" },
      },
    });
  } catch {
    throw packageError(
      "INVALID_TOOL_PACKAGE_ARGUMENT",
      "Expected inspect/install --source, import --source [--kind] [--id] [--version] [--display-name], list [--include-removed], verify/remove --id --version, or bind --id --version --engine [--bindings] [--replace]",
    );
  }
  const [command] = parsed.positionals;
  const allowed: Record<string, string[]> = {
    inspect: ["source"],
    install: ["source"],
    import: ["source", "kind", "id", "version", "display-name"],
    list: ["include-removed"],
    verify: ["id", "version"],
    remove: ["id", "version"],
    bind: ["id", "version", "engine", "workspace", "bindings", "replace"],
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
  const optional = (name: string): string | undefined => {
    const value = parsed.values[name];
    return typeof value === "string" ? value : undefined;
  };
  if (command === "inspect") return inspectLocal(required("source"));
  if (command === "install")
    return installLocal(required("source"), context.root);
  if (command === "import") {
    const kind = optional("kind");
    if (kind !== undefined && !importKinds.includes(kind as ToolPackImportKind))
      throw packageError(
        "INVALID_TOOL_PACKAGE_ARGUMENT",
        "--kind must be auto, skills, mcp or cli",
      );
    const id = optional("id");
    const version = optional("version");
    const displayName = optional("display-name");
    const imported = await importLocal(required("source"), context.root, {
      ...(kind ? { kind: kind as ToolPackImportKind } : {}),
      ...(id ? { id } : {}),
      ...(version ? { version } : {}),
      ...(displayName ? { displayName } : {}),
    });
    return {
      package: {
        id: imported.installed.manifest.id,
        version: imported.installed.manifest.version,
      },
      displayName: imported.installed.manifest.displayName,
      digest: imported.installed.digest,
      format: imported.format,
      counts: imported.counts,
      warnings: imported.warnings,
    };
  }
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
  const secretBindings =
    typeof parsed.values.bindings === "string"
      ? ((await readJson(parsed.values.bindings, 65536)) as Record<
          string,
          SecretReference
        >)
      : undefined;
  const installed = await verifyInstalled(context.root, id, version);
  const fragment = await bindInstalled(context.root, id, version, {
    nodeExecutable: context.nodeExecutable,
    ...(context.commandMcpEntry
      ? { commandMcpEntry: context.commandMcpEntry }
      : {}),
    ...(secretBindings !== undefined ? { secretBindings } : {}),
  });
  const plan = planBinding(
    base.configuration,
    "generic",
    footprint(installed.record, installed.manifest),
    (await listManifests(context.root, { includeRemoved: true, id })).map(
      (entry) => footprint(entry.record, entry.manifest),
    ),
    fragment,
    parsed.values.replace === true,
  );
  const registration = {
    ...(input as EngineRegistration),
    configuration: plan.configuration,
  };
  const prepared = await context.prepareEngine(registration);
  const result: ToolPackageBindResult = {
    registration: { ...registration, configuration: prepared.configuration! },
    revision: prepared.revision,
    package: { id, version },
    capabilities: capabilities(fragment, installed.manifest),
    ...(plan.replaced.length ? { replaced: plan.replaced } : {}),
  };
  return result;
}
