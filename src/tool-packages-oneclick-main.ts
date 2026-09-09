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
import type {
  EngineConfiguration,
  SecretReference,
} from "./domain/engine-configuration.js";
import { bindInstalled, installLocal, verifyInstalled } from "./tool-packages/index.js";
import { canonicalJson } from "./tool-packages/manifest.js";

const help = `HarnessHub one-click Capability Pack installer
  Install-Tool-Pack.cmd --source DIRECTORY [--engines all|codex,opencode] [--workspace DIRECTORY] [--bindings JSON]

The source directory must contain tool-package.json. One invocation installs the
package, verifies all payload hashes, binds Skill/MCP/CLI capabilities, preflights
each selected bundled engine, and atomically saves only compatible engine bindings.
Secret bindings are references (env/file/keychain), never secret values.`;

function merge<T>(existing: T[], incoming: T[], key: (item: T) => string): T[] {
  const result = [...existing];
  for (const item of incoming) {
    const previous = result.find((candidate) => key(candidate) === key(item));
    if (!previous) result.push(item);
    else if (canonicalJson(previous) !== canonicalJson(item))
      throw new Error(
        `Capability conflicts with an existing engine configuration: ${key(item)}`,
      );
  }
  return result;
}

function errorResult(error: unknown): { code: string; message: string } {
  if (error instanceof Error) {
    const candidate = error as Error & { code?: unknown };
    return {
      code: typeof candidate.code === "string" ? candidate.code : "INSTALL_FAILED",
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
    throw new Error("--bindings must contain a JSON object of secret references");
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
      ? manifest.engines
          .filter((engine) => settings.engines?.[engine.id]?.enabled !== false)
          .map((engine) => engine.id)
      : input
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean);
  if (!requested.length) throw new Error("No target engines were selected");
  if (new Set(requested).size !== requested.length)
    throw new Error("--engines contains duplicate engine ids");
  for (const id of requested)
    if (!available.has(id)) throw new Error(`Engine ${id} is not in this bundle`);
  return requested;
}

function withFragment(
  manifest: BundleManifest,
  settings: BundleSettings,
  engineId: string,
  fragment: Awaited<ReturnType<typeof bindInstalled>>,
): BundleSettings {
  const template = manifest.engines.find((engine) => engine.id === engineId)!;
  const previous: BundleEngineSettings = settings.engines?.[engineId] ?? {};
  const base = previous.configuration;
  const adapter = base?.adapter ?? template.configuration?.adapter ?? "generic";
  const configuration: EngineConfiguration = {
    ...base,
    adapter,
    skills: merge(base?.skills ?? [], fragment.skills, (skill) =>
      process.platform === "win32" ? skill.path.toLowerCase() : skill.path,
    ),
    mcpServers: merge(
      base?.mcpServers ?? [],
      fragment.mcpServers,
      (server) => server.name.toLowerCase(),
    ),
  };
  return {
    ...settings,
    engines: {
      ...settings.engines,
      [engineId]: { ...previous, configuration },
    },
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
    throw new Error("Usage: Install-Tool-Pack.cmd --source DIRECTORY [options]");

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
  await prepareDirectories(context, manifest);
  let settings = await readSettings(context.state);
  const targets = selectedEngines(manifest, settings, values.engines);
  const source = path.resolve(values.source);
  const workspace = path.resolve(values.workspace ?? process.cwd());
  const bindings = await secretBindings(values.bindings);
  const installed = await installLocal(
    source,
    path.join(context.state, "tool-packages"),
  );
  await verifyInstalled(
    path.join(context.state, "tool-packages"),
    installed.manifest.id,
    installed.manifest.version,
  );
  const fragment = await bindInstalled(
    path.join(context.state, "tool-packages"),
    installed.manifest.id,
    installed.manifest.version,
    {
      nodeExecutable: context.node,
      commandMcpEntry: bundlePath(
        root,
        "dist/src/drivers/tool-command/command-mcp.js",
      ),
      workspace,
      ...(bindings ? { secretBindings: bindings } : {}),
    },
  );

  const results: Array<{
    engineId: string;
    status: "installed" | "skipped";
    revision?: string;
    code?: string;
    message?: string;
  }> = [];
  for (const engineId of targets) {
    if (settings.engines?.[engineId]?.enabled === false) {
      results.push({
        engineId,
        status: "skipped",
        code: "ENGINE_DISABLED",
        message: "Engine is disabled in state/settings.json",
      });
      continue;
    }
    try {
      const candidate = withFragment(manifest, settings, engineId, fragment);
      const engine = materializeEngines(manifest, candidate, context).find(
        (item) => item.id === engineId,
      );
      if (!engine) throw new Error(`Engine ${engineId} could not be materialized`);
      const prepared = await prepareEngine(engine);
      settings = candidate;
      results.push({
        engineId,
        status: "installed",
        revision: prepared.revision,
      });
    } catch (error) {
      const failure = errorResult(error);
      results.push({ engineId, status: "skipped", ...failure });
    }
  }

  const successes = results.filter((item) => item.status === "installed");
  if (!successes.length)
    throw new Error(
      `Tool Pack installed in the local store but no selected engine accepted it: ${results
        .map((item) => `${item.engineId}:${item.code ?? "failed"}`)
        .join(", ")}`,
    );
  await writeSettings(context.state, settings);
  console.log(
    JSON.stringify(
      {
        ok: true,
        modelCalled: false,
        package: {
          id: installed.manifest.id,
          version: installed.manifest.version,
          displayName: installed.manifest.displayName,
        },
        workspace,
        capabilities: {
          skills: fragment.skills.map((skill) => skill.path),
          mcp: fragment.mcpServers.map((server) => server.name),
          cli: (installed.manifest.cliTools ?? []).map(
            (tool) => `cli_${tool.name}`,
          ),
        },
        engines: results,
        settings: path.join(context.state, "settings.json"),
        note: "Compatible engine bindings were saved atomically. Restart the Competition Gateway and create a new Session to use them.",
      },
      null,
      2,
    ),
  );
  return 0;
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
