import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { prepareEngine } from "./engine/registry.js";
import {
  materializeEngines,
  prepareDirectories,
  readSettings,
  writeSettings,
} from "./distribution/configuration.js";
import { bundlePath, readBundle } from "./distribution/manifest.js";
import type {
  BundleContext,
  BundleEngineSettings,
  BundleManifest,
  BundleSettings,
} from "./distribution/types.js";
import type { SecretReference } from "./domain/engine-configuration.js";
import { HubError } from "./domain/errors.js";
import {
  bindInstalled,
  capabilities,
  footprint,
  importKinds,
  importLocal,
  listManifests,
  planBinding,
  verifyInstalled,
  type ToolPackImportKind,
} from "./tool-packages/index.js";

const help = `HarnessHub one-click Capability Pack installer
  Install-Tool-Pack.cmd --source PATH [--engines all|codex,opencode] [--kind auto|skills|mcp|cli]
                        [--id ID] [--version VERSION] [--replace] [--bindings JSON]

PATH is a directory or JSON file on this machine:
  - a directory with tool-package.json (installed unchanged), or
  - a directory with Skill folders (SKILL.md), mcp.json / .mcp.json and/or cli.json, or
  - one mcp.json ({"mcpServers":{...}} or {"servers":{...}}) or cli.json ({"cliTools":[...]}).
The pack is copied and hash-verified, then every selected bundled engine is
preflighted independently; incompatible engines are skipped, others are saved
atomically to state/settings.json. MCP servers and CLI tools run in each
Session's own directory. --replace switches engines from another version of
the same pack. Secret bindings are references (env/file/keychain), never
values. Restart the Gateway afterwards; nothing contacts a model or network.`;

export interface OneClickOptions {
  source: string;
  kind?: ToolPackImportKind;
  id?: string;
  version?: string;
  /** "all" or comma-separated bundled engine ids. */
  engines: string;
  replace: boolean;
  bindings?: Record<string, SecretReference>;
  /** @deprecated Accepted for old command lines; bindings use each Session's directory. */
  workspace?: string;
}
export interface OneClickResult {
  engineId: string;
  status: "applied" | "skipped" | "failed";
  revision?: string;
  code?: string;
  reason?: string;
  replaced?: string[];
}
export interface OneClickReport {
  /** At least one engine applied and none failed. */
  ok: boolean;
  modelCalled: false;
  package: { id: string; version: string; displayName: string };
  format: "tool-package" | "generated";
  counts: { skills: number; mcp: number; cli: number };
  capabilities: { skills: string[]; mcp: string[]; cli: string[] };
  warnings: string[];
  results: OneClickResult[];
  settings: string;
  note: string;
}

/** Validation codes meaning the engine cannot accept this pack at all. */
const INCOMPATIBLE = new Set([
  "INVALID_ENGINE_CONFIGURATION",
  "ENGINE_CONFIGURATION_UNSUPPORTED",
  "INVALID_CONFIG",
]);

function errorResult(error: unknown): { code: string; message: string } {
  if (error instanceof Error) {
    const candidate = error as Error & { code?: unknown };
    return {
      code:
        typeof candidate.code === "string" ? candidate.code : "INSTALL_FAILED",
      message: error.message,
    };
  }
  return { code: "INSTALL_FAILED", message: String(error) };
}

async function secretBindings(file: string | undefined) {
  if (!file) return undefined;
  const target = path.resolve(file);
  const value: unknown = JSON.parse(await readFile(target, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(
      "--bindings must contain a JSON object of secret references",
    );
  return value as Record<string, SecretReference>;
}

function selectedEngines(
  manifest: BundleManifest,
  settings: BundleSettings,
  input: string,
): string[] {
  const available = new Set(manifest.engines.map((engine) => engine.id));
  const requested =
    input === "all"
      ? manifest.engines.map((engine) => engine.id)
      : input
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean);
  if (!requested.length) throw new Error("No target engines were selected");
  if (new Set(requested).size !== requested.length)
    throw new Error("--engines contains duplicate engine ids");
  for (const id of requested)
    if (!available.has(id))
      throw new Error(`Engine ${id} is not in this bundle`);
  return requested;
}

/**
 * Imports one pack into `state/tool-packages` and binds it to the selected
 * bundled engines inside `state/settings.json`. Each engine is planned and
 * validated with prepareEngine on its own; skipped or failed engines never
 * block others, and settings are written once, atomically, only when at least
 * one engine accepted the pack. Settings of engines that did not accept it
 * are left untouched.
 */
export async function installToolPackIntoBundle(
  context: BundleContext,
  manifest: BundleManifest,
  options: OneClickOptions,
  commandMcpEntry: string,
): Promise<OneClickReport> {
  await prepareDirectories(context, manifest);
  let settings = await readSettings(context.state);
  const targets = selectedEngines(manifest, settings, options.engines);
  const store = path.join(context.state, "tool-packages");
  const imported = await importLocal(path.resolve(options.source), store, {
    ...(options.kind ? { kind: options.kind } : {}),
    ...(options.id ? { id: options.id } : {}),
    ...(options.version ? { version: options.version } : {}),
  });
  const { id, version } = imported.installed.manifest;
  const installed = await verifyInstalled(store, id, version);
  const fragment = await bindInstalled(store, id, version, {
    nodeExecutable: context.node,
    commandMcpEntry,
    ...(options.bindings ? { secretBindings: options.bindings } : {}),
  });
  const target = footprint(installed.record, installed.manifest);
  const versions = (
    await listManifests(store, { includeRemoved: true, id })
  ).map((entry) => footprint(entry.record, entry.manifest));
  const warnings = [...imported.warnings];
  if (options.workspace)
    warnings.push(
      "--workspace is ignored: MCP servers and CLI tools use each Session's own directory",
    );

  const results: OneClickResult[] = [];
  for (const engineId of targets) {
    const previous: BundleEngineSettings = settings.engines?.[engineId] ?? {};
    if (previous.enabled === false) {
      results.push({
        engineId,
        status: "skipped",
        code: "ENGINE_DISABLED",
        reason: "Engine is disabled in state/settings.json",
      });
      continue;
    }
    try {
      const selected = previous.toolPackages?.filter((item) => item.id === id);
      if (selected?.length && !options.replace)
        throw new HubError(
          "TOOL_PACKAGE_BIND_CONFLICT",
          `This engine selects ${id} ${selected.map((item) => item.version).join(", ")} through hub.cmd tools use; pass --replace to bind ${version} directly`,
          409,
        );
      const template = manifest.engines.find(
        (engine) => engine.id === engineId,
      )!;
      const plan = planBinding(
        previous.configuration,
        previous.configuration?.adapter ??
          template.configuration?.adapter ??
          "generic",
        target,
        versions,
        fragment,
        options.replace,
      );
      const remaining = previous.toolPackages?.filter((item) => item.id !== id);
      const { toolPackages: _toolPackages, ...rest } = previous;
      const candidate: BundleSettings = {
        ...settings,
        engines: {
          ...settings.engines,
          [engineId]: {
            ...rest,
            ...(remaining?.length ? { toolPackages: remaining } : {}),
            configuration: plan.configuration,
          },
        },
      };
      const engine = materializeEngines(manifest, candidate, context).find(
        (item) => item.id === engineId,
      );
      if (!engine)
        throw new Error(`Engine ${engineId} could not be materialized`);
      const prepared = await prepareEngine(engine);
      settings = candidate;
      results.push({
        engineId,
        status: "applied",
        revision: prepared.revision,
        ...(plan.replaced.length || selected?.length
          ? {
              replaced: [
                ...plan.replaced,
                ...(selected ?? []).map((item) => item.version),
              ],
            }
          : {}),
      });
    } catch (error) {
      const failure = errorResult(error);
      results.push({
        engineId,
        status: INCOMPATIBLE.has(failure.code) ? "skipped" : "failed",
        code: failure.code,
        reason: failure.message,
      });
    }
  }
  const applied = results.some((item) => item.status === "applied");
  if (applied) await writeSettings(context.state, settings);
  return {
    ok: applied && !results.some((item) => item.status === "failed"),
    modelCalled: false,
    package: { id, version, displayName: installed.manifest.displayName },
    format: imported.format,
    counts: imported.counts,
    capabilities: capabilities(fragment, installed.manifest),
    warnings,
    results,
    settings: path.join(context.state, "settings.json"),
    note: applied
      ? "Accepted engine bindings were saved atomically. Restart the Competition Gateway and create a new Session to use them."
      : "No engine accepted the pack; settings were not changed. The pack stays installed in state/tool-packages.",
  };
}

export async function toolPackOneClickMain(
  args: string[],
  bundleRoot = fileURLToPath(new URL("../../", import.meta.url)),
): Promise<number> {
  const { values } = parseArgs({
    args,
    allowPositionals: false,
    strict: true,
    options: {
      source: { type: "string" },
      engines: { type: "string", default: "all" },
      kind: { type: "string", default: "auto" },
      id: { type: "string" },
      version: { type: "string" },
      replace: { type: "boolean", default: false },
      workspace: { type: "string" },
      bindings: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(help);
    return 0;
  }
  if (!values.source)
    throw new Error("Usage: Install-Tool-Pack.cmd --source PATH [options]");
  if (!importKinds.includes(values.kind as ToolPackImportKind))
    throw new Error("--kind must be auto, skills, mcp or cli");

  const root = path.resolve(bundleRoot);
  const manifest = await readBundle(root);
  if (
    process.platform !== manifest.platform ||
    process.arch !== manifest.arch ||
    process.versions.node !== manifest.nodeVersion
  )
    throw new Error(
      `This bundle requires ${manifest.platform}/${manifest.arch} Node ${manifest.nodeVersion}`,
    );
  const context: BundleContext = {
    root,
    state: path.join(root, "state"),
    workspace: path.join(root, "state", "workspace"),
    node: bundlePath(root, "runtime/node.exe"),
  };
  const bindings = await secretBindings(values.bindings);
  const report = await installToolPackIntoBundle(
    context,
    manifest,
    {
      source: values.source,
      kind: values.kind as ToolPackImportKind,
      engines: values.engines,
      replace: values.replace,
      ...(values.id ? { id: values.id } : {}),
      ...(values.version ? { version: values.version } : {}),
      ...(bindings ? { bindings } : {}),
      ...(values.workspace ? { workspace: values.workspace } : {}),
    },
    bundlePath(root, "dist/src/drivers/tool-command/command-mcp.js"),
  );
  console.log(JSON.stringify(report, null, 2));
  return report.ok ? 0 : 1;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.exitCode = await toolPackOneClickMain(process.argv.slice(2));
  } catch (error) {
    const failure = errorResult(error);
    console.error(JSON.stringify(failure));
    process.exitCode = 1;
  }
}
