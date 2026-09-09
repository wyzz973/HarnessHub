import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { startHub } from "./main.js";
import { prepareEngine } from "./engine/registry.js";
import { bundlePath, readBundle } from "./distribution/manifest.js";
import {
  materializeEngines,
  prepareDirectories,
  readSettings,
} from "./distribution/configuration.js";
import {
  applyFullAccessToRegistration,
  fullAccessEnabled,
} from "./distribution/full-access.js";
import type {
  BundleContext,
  BundleManifest,
  BundleSettings,
} from "./distribution/types.js";
import type { EngineRegistration } from "./domain/engines.js";
import type { EngineProfile } from "./domain/types.js";
import { bindInstalled } from "./tool-packages/index.js";

function registration(profile: EngineProfile): EngineRegistration {
  const {
    revision: _revision,
    capabilities: _capabilities,
    ...value
  } = profile;
  if (value.driver === "fake" || !value.command)
    throw new Error("A real bundled engine is required");
  return { ...value, driver: value.driver, command: value.command };
}

async function profiles(
  manifest: BundleManifest,
  settings: BundleSettings,
  context: BundleContext,
): Promise<EngineRegistration[]> {
  const result: EngineRegistration[] = [];
  for (const materialized of materializeEngines(manifest, settings, context)) {
    const engine = applyFullAccessToRegistration(materialized);
    for (const selected of settings.engines?.[engine.id]?.toolPackages ?? []) {
      const binding = await bindInstalled(
        path.join(context.state, "tool-packages"),
        selected.id,
        selected.version,
        {
          nodeExecutable: context.node,
          workspace: context.workspace,
        },
      );
      engine.configuration = {
        adapter: "generic",
        ...engine.configuration,
        skills: [...(engine.configuration?.skills ?? []), ...binding.skills],
        mcpServers: [
          ...(engine.configuration?.mcpServers ?? []),
          ...binding.mcpServers,
        ],
      };
    }
    result.push(registration(await prepareEngine(engine)));
  }
  return result;
}

async function generatedConfig(
  manifest: BundleManifest,
  settings: BundleSettings,
  context: BundleContext,
): Promise<{ file: string; engines: EngineRegistration[] }> {
  const engines = await profiles(manifest, settings, context);
  const target = path.join(context.state, "engines.competition.json");
  const enabled = engines.filter((engine) => engine.enabled !== false);
  const defaultEngine =
    settings.defaultEngine ??
    enabled.find((engine) => engine.id === "opencode")?.id ??
    enabled.find((engine) => engine.id === "codex")?.id ??
    enabled[0]?.id;
  if (!defaultEngine || !enabled.some((engine) => engine.id === defaultEngine))
    throw new Error("Bundle has no enabled engine");
  await writeFile(
    target,
    `${JSON.stringify(
      {
        engines,
        workspaces: [{ id: "default", path: context.workspace }],
        defaultWorkspace: "default",
        defaultEngine,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  return { file: target, engines };
}

function applyPrivateEnvironment(context: BundleContext): void {
  const windows = process.env.SystemRoot ?? "C:\\Windows";
  for (const name of Object.keys(process.env))
    if (
      /^(PATH|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|NODE_PATH|NODE_OPTIONS|PYTHONPATH|PYTHONHOME|XDG_.*)$/i.test(
        name,
      )
    )
      delete process.env[name];
  const home = path.join(context.state, "gateway-home");
  Object.assign(process.env, {
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    PATH: [
      path.dirname(context.node),
      path.join(context.root, "bin"),
      path.join(
        context.root,
        "bin",
        "git",
        process.arch === "arm64" ? "clangarm64" : "mingw64",
        "bin",
      ),
      path.join(context.root, "bin", "git", "cmd"),
      path.join(context.root, "bin", "git", "usr", "bin"),
      path.join(windows, "System32"),
      windows,
      path.join(windows, "System32", "WindowsPowerShell", "v1.0"),
    ].join(path.delimiter),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
  });
}

export async function competitionBundleMain(
  args: string[],
  bundleRoot = fileURLToPath(new URL("../../", import.meta.url)),
): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      engine: { type: "string" },
      port: { type: "string", default: "6217" },
      host: { type: "string", default: "localhost" },
      "full-access": { type: "boolean", default: false },
      "safe-permissions": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(
      "Start-Competition.cmd --engine opencode [--port 6217] [--host localhost] [--full-access|--safe-permissions]",
    );
    return;
  }
  if (values["full-access"] && values["safe-permissions"])
    throw new Error("Choose either --full-access or --safe-permissions");
  if (values["full-access"]) process.env.HARNESSHUB_FULL_ACCESS = "1";
  if (values["safe-permissions"])
    delete process.env.HARNESSHUB_FULL_ACCESS;

  const engineId = values.engine ?? process.env.AGENT_ENGINE;
  if (!engineId)
    throw new Error("Competition bundle requires --engine or AGENT_ENGINE");
  const port = Number(values.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535)
    throw new Error("Competition port must be between 1 and 65535");

  const root = path.resolve(bundleRoot);
  const manifest = await readBundle(root);
  if (
    process.platform !== manifest.platform ||
    process.arch !== manifest.arch ||
    process.versions.node !== manifest.nodeVersion
  )
    throw new Error(
      `This bundle requires ${manifest.platform}/${manifest.arch} Node ${manifest.nodeVersion}; use Start-Competition.cmd from the bundle`,
    );
  const context: BundleContext = {
    root,
    state: path.join(root, "state"),
    workspace: path.join(root, "state", "workspace"),
    node: bundlePath(root, "runtime/node.exe"),
  };
  await prepareDirectories(context, manifest);
  await mkdir(path.join(context.state, "gateway-home"), {
    recursive: true,
    mode: 0o700,
  });
  const settings = await readSettings(context.state);
  const generated = await generatedConfig(manifest, settings, context);
  const selected = generated.engines.find((engine) => engine.id === engineId);
  if (!selected)
    throw new Error(`Engine ${engineId} is not included in this bundle`);
  if (selected.enabled === false)
    throw new Error(
      `Engine ${engineId} is disabled in state/settings.json; configure it before starting the competition gateway`,
    );

  applyPrivateEnvironment(context);
  const hub = await startHub({
    dataDir: path.join(context.state, "competition-data"),
    configFile: generated.file,
    demo: false,
    competition: true,
    defaultEngine: engineId,
    cwd: context.workspace,
    port,
    host: values.host,
  });
  console.log(
    JSON.stringify({
      event: "competition.ready",
      url: hub.url,
      engine: engineId,
      port,
      host: values.host,
      fullAccess: fullAccessEnabled(),
      bundle: root,
      pid: process.pid,
    }),
  );
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void hub.server.close().catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await competitionBundleMain(process.argv.slice(2));
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Competition bundle failed",
    );
    process.exitCode = 1;
  }
}
