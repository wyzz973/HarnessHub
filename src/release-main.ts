import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, writeFile, lstat } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { readReleaseOverrides } from "./storage/release-catalog.js";
import { startHub } from "./main.js";
import { benchmarkMain } from "./benchmark-main.js";
import { normalizeEngine, prepareEngine } from "./engine/registry.js";
import { providerProtocols } from "./engine/configuration.js";
import { builtinConfigurationAdapter } from "./engine/builtins.js";
import {
  activeHarnessModel,
  evaluateHarnessModel,
  harnessModelFromEnvironment,
  parseHarnessModel,
  readHarnessModelFile,
  writeHarnessModelFile,
} from "./application/harness-model.js";
import {
  HARNESS_MODEL_ALIAS,
  harnessModelEnvironment,
  type HarnessModel,
  type HarnessModelView,
} from "./domain/harness-model.js";
import {
  bundlePath,
  readBundle,
  verifyBundle,
} from "./distribution/manifest.js";
import {
  materializeEngines,
  parseSettings,
  prepareDirectories,
  readSettings,
  writeSettings,
} from "./distribution/configuration.js";
import type {
  BundleContext,
  BundleManifest,
  BundleSettings,
} from "./distribution/types.js";
import type { EngineRegistration } from "./domain/engines.js";
import type { EngineProfile } from "./domain/types.js";
import { bindInstalled, runToolPackageCli } from "./tool-packages/index.js";
import { assertCompleteExtraction } from "./distribution/extraction.js";
import { preinstallEnabled } from "./distribution/preinstalled.js";
import {
  preinstallToolPacks,
  type PreinstallReport,
} from "./preinstalled-tool-packs.js";

const help = `HarnessHub portable competition bundle
  hub.cmd start [--gateway-only] [--port 3180] [--console-port 3330]
  hub.cmd doctor [--full] [--protocol] [--engines codex,opencode]
  hub.cmd engines
  hub.cmd configure --file SETTINGS.json
  hub.cmd model set --model ID --base-url URL --api-key-env NAME [--context-window N] [--max-output-tokens N] [--header NAME=VALUE]... [--alias NAME]
  hub.cmd model show
  hub.cmd tools inspect|install|list|verify|remove|bind ...
  hub.cmd tools use PACKAGE_ID VERSION --engine ENGINE_ID
  hub.cmd tools unuse --id PACKAGE_ID --version VERSION --engine ENGINE_ID
  hub.cmd smoke
  hub.cmd benchmark --dataset TASKS.json --engines codex,opencode [--permissions deny|allow-once]
Runtime dependencies are bundled. Every engine uses one unified model: HARNESSHUB_MODEL* environment
variables, else state/harness-model.json (hub.cmd model set), else the settings.json top-level "model".
start applies the Tool Packs listed in tool-packs\\preinstalled.json to every compatible engine once per
pack content (HARNESSHUB_PREINSTALL_TOOL_PACKS=0 disables this; packs you unbind later stay unbound).
No model is called by doctor, configure, model, tools, or smoke. Benchmark and user Runs call the model.`;

/** Engine-layer validation used to predict each engine's unified-model outcome offline. */
const harnessModelPorts = {
  normalize: normalizeEngine,
  inferAdapter: builtinConfigurationAdapter,
};

/**
 * Unified model status as the Gateway would compute it for these bundle registrations:
 * environment > model file > settings. Invalid sources throw, like Gateway startup.
 */
export async function harnessModelReport(options: {
  file: string;
  settings: BundleSettings;
  environment: Readonly<NodeJS.ProcessEnv>;
  registrations: EngineRegistration[];
}): Promise<
  HarnessModelView & {
    file: string;
    modelCalled: false;
    sources: { environment: boolean; file: boolean; settings: boolean };
  }
> {
  const environment = harnessModelFromEnvironment(options.environment);
  const file = await readHarnessModelFile(options.file);
  const settings = options.settings.model
    ? parseHarnessModel(options.settings.model)
    : undefined;
  const sources = {
    environment: Boolean(environment),
    file: Boolean(file),
    settings: Boolean(settings),
  };
  const active = activeHarnessModel({ environment, file, settings });
  if (!active)
    return {
      configured: false,
      alias: HARNESS_MODEL_ALIAS,
      engines: [],
      file: options.file,
      modelCalled: false,
      sources,
    };
  return {
    configured: true,
    source: active.source,
    model: active.model,
    alias: active.alias,
    provider: active.provider,
    engines: options.registrations.map((registration) => {
      const evaluation = evaluateHarnessModel(
        normalizeEngine(registration),
        active,
        harnessModelPorts,
      );
      return {
        engineId: registration.id,
        status: evaluation.status,
        ...(evaluation.reason !== undefined
          ? { reason: evaluation.reason }
          : {}),
      };
    }),
    file: options.file,
    modelCalled: false,
    sources,
  };
}

/**
 * `hub.cmd model set|show`. `set` validates and atomically writes the unified model file
 * (mode 0600) that hub.cmd start and Start-Competition.cmd pass to the Gateway; it takes
 * effect on the next start. `show` prints {@link harnessModelReport}. Neither command
 * resolves the key or calls the model.
 */
export async function harnessModelCommand(
  args: string[],
  options: {
    file: string;
    settings: BundleSettings;
    environment: Readonly<NodeJS.ProcessEnv>;
    registrations: () => Promise<EngineRegistration[]>;
  },
): Promise<unknown> {
  if (args[0] === "show") {
    parseArgs({ args: args.slice(1), options: {} });
    return harnessModelReport({
      ...options,
      registrations: await options.registrations(),
    });
  }
  if (args[0] !== "set")
    throw new Error("Usage: hub.cmd model set ... | hub.cmd model show");
  const { values } = parseArgs({
    args: args.slice(1),
    options: {
      model: { type: "string" },
      "base-url": { type: "string" },
      "api-key-env": { type: "string" },
      "context-window": { type: "string" },
      "max-output-tokens": { type: "string" },
      header: { type: "string", multiple: true },
      alias: { type: "string" },
    },
  });
  if (!values.model || !values["base-url"] || !values["api-key-env"])
    throw new Error(
      "Usage: hub.cmd model set --model ID --base-url URL --api-key-env NAME [--context-window N] [--max-output-tokens N] [--header NAME=VALUE]... [--alias NAME]",
    );
  const positive = (name: string, value: string | undefined) => {
    if (value === undefined) return undefined;
    if (!/^[1-9][0-9]{0,15}$/.test(value))
      throw new Error(`--${name} must be a positive integer`);
    return Number(value);
  };
  const contextWindow = positive("context-window", values["context-window"]);
  const maxOutputTokens = positive(
    "max-output-tokens",
    values["max-output-tokens"],
  );
  const headers: Record<string, string> = {};
  for (const header of values.header ?? []) {
    const at = header.indexOf("=");
    const name = header.slice(0, at);
    if (at <= 0) throw new Error("--header must be NAME=VALUE");
    if (
      Object.keys(headers).some((n) => n.toLowerCase() === name.toLowerCase())
    )
      throw new Error(`Duplicate --header ${name}`);
    headers[name] = header.slice(at + 1);
  }
  const model: HarnessModel = parseHarnessModel({
    model: values.model,
    ...(values.alias !== undefined ? { alias: values.alias } : {}),
    provider: {
      protocol: "openai-completions",
      baseUrl: values["base-url"],
      apiKey: { kind: "env", value: values["api-key-env"] },
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      ...(Object.keys(headers).length ? { headers } : {}),
    },
  });
  await writeHarnessModelFile(options.file, model);
  const warnings: string[] = [];
  if (options.environment[harnessModelEnvironment.model]?.trim())
    warnings.push(
      `${harnessModelEnvironment.model} is set in this environment and takes priority over the saved file.`,
    );
  if (!options.environment[values["api-key-env"]])
    warnings.push(
      `${values["api-key-env"]} is not set here; set it before hub.cmd start or Start-Competition.cmd.`,
    );
  const saved = activeHarnessModel({ file: model })!;
  return {
    saved: true,
    modelCalled: false,
    file: options.file,
    model: saved.model,
    alias: saved.alias,
    provider: saved.provider,
    appliesTo:
      "New Sessions after the next hub.cmd start or Start-Competition.cmd; a running Gateway can apply it with PUT /v1/harness/model.",
    warnings,
  };
}

/** Never report a file configuration change that an existing console override would hide. */
async function rejectConsoleConflict(
  context: BundleContext,
  engineId?: string,
): Promise<void> {
  const database = path.join(context.state, "data", "harnesshub.sqlite");
  try {
    await lstat(database);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return;
    throw error;
  }
  const catalog = readReleaseOverrides(database);
  const conflicts = engineId
    ? catalog.engineIds.includes(engineId)
    : catalog.engineIds.length > 0 || catalog.hasDefault;
  if (conflicts)
    throw new Error(
      "Console configuration overrides this release setting; edit the engine in the console or use a fresh extraction. Existing settings and history were preserved.",
    );
}

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
) {
  const result: EngineRegistration[] = [];
  for (const engine of materializeEngines(manifest, settings, context)) {
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
/**
 * Write the Gateway configuration for these settings. Its top-level `model` is the
 * settings-level unified model (the lowest-priority source); the Gateway still prefers
 * HARNESSHUB_MODEL* and the model file passed with --harness-model-file.
 */
async function configFile(
  manifest: BundleManifest,
  settings: BundleSettings,
  context: BundleContext,
  options: { name?: string; model?: HarnessModel } = {},
) {
  const engines = await profiles(manifest, settings, context);
  const target = path.join(
    context.state,
    options.name ?? "engines.generated.json",
  );
  const model = options.model ?? settings.model;
  const enabled = engines.filter((engine) => engine.enabled !== false);
  const defaultEngine =
    settings.defaultEngine ??
    enabled.find((engine) => engine.id === "codex")?.id ??
    enabled[0]?.id;
  if (!defaultEngine || !enabled.some((engine) => engine.id === defaultEngine))
    throw new Error("Bundle has no enabled default engine");
  await writeFile(
    target,
    JSON.stringify(
      {
        engines,
        workspaces: [{ id: "default", path: context.workspace }],
        defaultWorkspace: "default",
        defaultEngine,
        ...(model ? { model } : {}),
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  return target;
}
/**
 * What `hub.cmd start` does under `state/` before launching the Gateway: preinstalled
 * Tool Packs are written to `state/settings.json` first, then the Gateway configuration
 * is generated from the settings as they are afterwards. Preinstall problems are
 * reported, never thrown; invalid settings throw as for every other command.
 */
export async function prepareStartConfiguration(
  context: BundleContext,
  manifest: BundleManifest,
  options: {
    /** Result of {@link preinstallEnabled}; false leaves Tool Packs untouched. */
    preinstall: boolean;
    /** Defaults to the bundle's compiled command MCP entry. */
    commandMcpEntry?: string;
    report?: (line: string) => void;
  },
): Promise<{ config: string; preinstall: PreinstallReport }> {
  const preinstall = await preinstallToolPacks(context, manifest, {
    enabled: options.preinstall,
    commandMcpEntry:
      options.commandMcpEntry ??
      bundlePath(context.root, "dist/src/drivers/tool-command/command-mcp.js"),
    ...(options.report ? { report: options.report } : {}),
  });
  const settings = await readSettings(context.state);
  return { config: await configFile(manifest, settings, context), preinstall };
}
function privateEnvironment(context: BundleContext): NodeJS.ProcessEnv {
  const windows = process.env.SystemRoot ?? "C:\\Windows";
  const env = { ...process.env };
  for (const name of Object.keys(env))
    if (
      /^(PATH|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|NODE_PATH|NODE_OPTIONS|PYTHONPATH|PYTHONHOME|XDG_.*)$/i.test(
        name,
      )
    )
      delete env[name];
  const home = path.join(context.state, "gateway-home");
  return {
    ...env,
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
  };
}
async function freePort(port: number) {
  const server = createServer();
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
async function startServices(
  manifest: BundleManifest,
  context: BundleContext,
  config: string,
  options: {
    port: number;
    consolePort: number;
    gatewayOnly: boolean;
    demo: boolean;
    /** Marker of preinstalled Tool Packs for the Gateway; absent when disabled. */
    preinstalledToolPacks?: string;
  },
): Promise<number> {
  await freePort(options.port);
  if (!options.gatewayOnly) await freePort(options.consolePort);
  const helper = bundlePath(context.root, "dist/native/harnesshub-job.exe");
  const owned = new Set<{
    child: ReturnType<typeof spawn>;
    closed: Promise<void>;
    token: string;
  }>();
  let stopping: Promise<void> | undefined;
  let result = 0;
  const stop = (code = 0): Promise<void> => {
    if (stopping) return stopping;
    result = code;
    stopping = Promise.all(
      [...owned].map(async ({ child, closed, token }) => {
        try {
          await promisify(execFile)(helper, ["close", token, "5000"], {
            timeout: 6000,
            windowsHide: true,
          });
        } catch {
          result = 1;
        }
        if (child.pid && child.exitCode === null && child.signalCode === null)
          child.kill("SIGTERM");
        const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
        try {
          await closed;
        } finally {
          clearTimeout(timer);
        }
      }),
    ).then(() => undefined);
    return stopping;
  };
  const launch = (
    args: string[],
    cwd: string,
    extraEnv: NodeJS.ProcessEnv = {},
  ) => {
    const token = randomUUID();
    const child = spawn(
      helper,
      ["run", String(process.pid), token, context.node, ...args],
      {
        cwd,
        env: { ...privateEnvironment(context), ...extraEnv },
        stdio: "inherit",
        windowsHide: true,
      },
    );
    const closed = new Promise<void>((resolve) =>
      child.once("close", () => resolve()),
    );
    const entry = { child, closed, token };
    owned.add(entry);
    child.once("error", (error) => {
      console.error(error.message);
      void stop(1);
    });
    child.once("close", (code) => {
      owned.delete(entry);
      void stop(code ?? 1);
    });
  };
  const interrupt = () => {
    void stop();
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    launch(
      [
        bundlePath(context.root, "dist/src/main.js"),
        "--config",
        config,
        "--port",
        String(options.port),
        "--data-dir",
        path.join(context.state, "data"),
        "--tool-package-root",
        path.join(context.state, "tool-packages"),
        "--harness-model-file",
        path.join(context.state, "harness-model.json"),
        ...(options.preinstalledToolPacks
          ? ["--preinstalled-tool-packs", options.preinstalledToolPacks]
          : []),
        // A demo Gateway serves the fake engine, which calls no model.
        ...(options.demo ? ["--demo"] : ["--require-harness-model"]),
      ],
      context.workspace,
    );
    if (!options.gatewayOnly) {
      const entry = bundlePath(context.root, manifest.consoleEntry);
      launch([entry], path.dirname(entry), {
        PORT: String(options.consolePort),
        HOSTNAME: "127.0.0.1",
        HARNESSHUB_GATEWAY_URL: `http://127.0.0.1:${options.port}`,
      });
    }
    console.log(
      `HarnessHub: http://127.0.0.1:${options.consolePort} | API http://127.0.0.1:${options.port}`,
    );
    await Promise.all([...owned].map((entry) => entry.closed));
    await stopping;
    return result;
  } finally {
    await stop(result);
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}
async function smoke(context: BundleContext) {
  const state = path.join(context.state, "checks", randomUUID());
  const hub = await startHub({
    dataDir: state,
    demo: true,
    cwd: context.workspace,
    port: 0,
  });
  try {
    const session = hub.app.createSession({ engineId: "fake" });
    const accepted = hub.app.submit(
      session.id,
      {
        text: "HarnessHub portable smoke",
        timeoutMs: 10000,
        fixture: { scenario: "artifact", chunks: 2 },
      },
      "portable-smoke",
    );
    const until = Date.now() + 15000;
    let run = hub.app.getRun(accepted.run.id);
    while (!run.finishedAt) {
      if (Date.now() > until) throw new Error("Portable smoke did not settle");
      await delay(20);
      run = hub.app.getRun(run.id);
    }
    if (
      run.status !== "completed" ||
      run.cleanupStatus !== "confirmed" ||
      !run.artifacts.length
    )
      throw new Error("Portable smoke failed");
    const captured = await hub.app.artifact(run.artifacts[0]!.id);
    if (captured.bytes.toString("utf8") !== "HarnessHub portable smoke")
      throw new Error(
        "Portable artifact bytes do not match the submitted fixture",
      );
    await hub.app.closeSession(session.id);
    return {
      modelCalled: false,
      runId: run.id,
      status: run.status,
      cleanupStatus: run.cleanupStatus,
      artifactCount: run.artifacts.length,
      evidence: state,
    };
  } finally {
    await hub.server.close();
  }
}

/** Portable composition entry: every execution uses the same Gateway/Worker/Benchmark implementations. */
export async function releaseMain(
  args: string[],
  bundleRoot = fileURLToPath(new URL("../../", import.meta.url)),
): Promise<number> {
  const command = args[0] ?? "help";
  if (command === "help" || command === "--help") {
    console.log(help);
    return 0;
  }
  const root = path.resolve(bundleRoot);
  const manifest = await readBundle(root);
  if (
    process.platform !== manifest.platform ||
    process.arch !== manifest.arch ||
    process.versions.node !== manifest.nodeVersion
  )
    throw new Error(
      `This bundle requires ${manifest.platform}/${manifest.arch} Node ${manifest.nodeVersion}; run hub.cmd with its bundled runtime`,
    );
  // A ZIP extracted by Explorer into a deep folder silently loses its longest paths.
  await assertCompleteExtraction(root, manifest, {
    warn: (message) => process.stderr.write(`${message}\n`),
  });
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
  let settings: BundleSettings =
    command === "configure"
      ? { schemaVersion: 1 }
      : await readSettings(context.state);
  const harnessModelFile = path.join(context.state, "harness-model.json");
  if (command === "model") {
    console.log(
      JSON.stringify(
        await harnessModelCommand(args.slice(1), {
          file: harnessModelFile,
          settings,
          environment: process.env,
          registrations: () => profiles(manifest, settings, context),
        }),
        null,
        2,
      ),
    );
    return 0;
  }
  if (command === "engines") {
    console.log(
      JSON.stringify(
        manifest.engines.map((engine) => ({
          id: engine.id,
          name: engine.name,
          version: engine.version,
          enabled: settings.engines?.[engine.id]?.enabled ?? true,
          protocols:
            providerProtocols[engine.configuration?.adapter ?? "generic"],
          notes: engine.notes ?? [],
        })),
        null,
        2,
      ),
    );
    return 0;
  }
  if (command === "tools") {
    if (args[1] === "remove" || args[1] === "unuse") {
      const { values } = parseArgs({
        args: args.slice(2),
        options: {
          id: { type: "string" },
          version: { type: "string" },
          engine: { type: "string" },
        },
      });
      if (!values.id || !values.version)
        throw new Error("Tool package id and version are required");
      const selected = Object.entries(settings.engines ?? {})
        .filter(([, engine]) =>
          engine.toolPackages?.some(
            (item) => item.id === values.id && item.version === values.version,
          ),
        )
        .map(([id]) => id);
      if (args[1] === "remove" && selected.length)
        throw new Error(
          `Tool package is selected by ${selected.join(", ")}; run tools unuse first`,
        );
      if (args[1] === "unuse") {
        if (
          !values.engine ||
          !manifest.engines.some((engine) => engine.id === values.engine)
        )
          throw new Error("An engine in this bundle is required");
        await rejectConsoleConflict(context, values.engine);
        const previous = settings.engines?.[values.engine] ?? {};
        settings = {
          ...settings,
          engines: {
            ...settings.engines,
            [values.engine]: {
              ...previous,
              toolPackages: (previous.toolPackages ?? []).filter(
                (item) =>
                  item.id !== values.id || item.version !== values.version,
              ),
            },
          },
        };
        await profiles(manifest, settings, context);
        await writeSettings(context.state, settings);
        await configFile(manifest, settings, context);
        console.log(
          JSON.stringify({
            engineId: values.engine,
            removedSelection: { id: values.id, version: values.version },
          }),
        );
        return 0;
      }
    }
    if (args[1] === "use") {
      const { values, positionals } = parseArgs({
        args: args.slice(2),
        allowPositionals: true,
        options: { engine: { type: "string" } },
      });
      if (
        positionals.length !== 2 ||
        !values.engine ||
        !manifest.engines.some((engine) => engine.id === values.engine)
      )
        throw new Error(
          "Usage: hub.cmd tools use PACKAGE_ID VERSION --engine ENGINE_ID",
        );
      const id = positionals[0]!;
      const version = positionals[1]!;
      await rejectConsoleConflict(context, values.engine);
      const previous = settings.engines?.[values.engine] ?? {};
      settings = {
        ...settings,
        engines: {
          ...settings.engines,
          [values.engine]: {
            ...previous,
            toolPackages: [
              ...(previous.toolPackages ?? []).filter(
                (entry) => entry.id !== id,
              ),
              { id, version },
            ],
          },
        },
      };
      await profiles(manifest, settings, context);
      await writeSettings(context.state, settings);
      await configFile(manifest, settings, context);
      console.log(
        JSON.stringify({
          engineId: values.engine,
          toolPackage: { id, version },
          settings: path.join(context.state, "settings.json"),
          appliesTo: "new sessions using the generated configuration",
        }),
      );
      return 0;
    }
    console.log(
      JSON.stringify(
        await runToolPackageCli(args.slice(1), {
          root: path.join(context.state, "tool-packages"),
          nodeExecutable: context.node,
          workspace: context.workspace,
          prepareEngine,
        }),
        null,
        2,
      ),
    );
    return 0;
  }
  if (command === "configure") {
    await rejectConsoleConflict(context);
    const { values } = parseArgs({
      args: args.slice(1),
      options: { file: { type: "string" } },
    });
    if (!values.file)
      throw new Error("Usage: hub.cmd configure --file SETTINGS.json");
    settings = parseSettings(
      JSON.parse(await readFile(path.resolve(values.file), "utf8")) as unknown,
    );
    // Validate every unified-model source the Gateway will read before replacing state.
    const report = await harnessModelReport({
      file: harnessModelFile,
      settings,
      environment: process.env,
      registrations: await profiles(manifest, settings, context),
    });
    await writeSettings(context.state, settings);
    await configFile(manifest, settings, context);
    console.log(
      JSON.stringify({
        configured: true,
        modelCalled: false,
        file: path.join(context.state, "settings.json"),
        harnessModel: {
          configured: report.configured,
          ...(report.source ? { source: report.source } : {}),
          sources: report.sources,
        },
      }),
    );
    return 0;
  }
  if (command === "smoke") {
    console.log(JSON.stringify(await smoke(context), null, 2));
    return 0;
  }
  if (command === "start") {
    const { values } = parseArgs({
      args: args.slice(1),
      options: {
        "gateway-only": { type: "boolean", default: false },
        demo: { type: "boolean", default: false },
        port: { type: "string", default: "3180" },
        "console-port": { type: "string", default: "3330" },
      },
    });
    const port = Number(values.port);
    const consolePort = Number(values["console-port"]);
    if (
      ![port, consolePort].every(
        (value) => Number.isInteger(value) && value > 0 && value < 65536,
      ) ||
      port === consolePort
    )
      throw new Error("Distinct valid loopback ports required");
    // A mistyped switch fails before anything under state/ changes.
    const prepared = await prepareStartConfiguration(context, manifest, {
      preinstall: preinstallEnabled(process.env),
      report: (line) => console.error(line),
    });
    return startServices(manifest, context, prepared.config, {
      port,
      consolePort,
      gatewayOnly: values["gateway-only"],
      demo: values.demo,
      ...(prepared.preinstall.enabled
        ? { preinstalledToolPacks: prepared.preinstall.markerFile }
        : {}),
    });
  }
  const generated = await configFile(manifest, settings, context);
  if (command === "doctor") {
    const { values } = parseArgs({
      args: args.slice(1),
      options: {
        full: { type: "boolean", default: false },
        protocol: { type: "boolean", default: false },
        engines: { type: "string" },
      },
    });
    const integrity = await verifyBundle(root, manifest, values.full);
    const selected =
      values.engines?.split(",") ?? manifest.engines.map((engine) => engine.id);
    if (
      selected.some(
        (id) => !manifest.engines.some((engine) => engine.id === id),
      )
    )
      throw new Error("Unknown doctor engine selection");
    for (const engine of manifest.engines.filter((engine) =>
      selected.includes(engine.id),
    ))
      for (const file of engine.requiredFiles ?? [])
        if (!(await lstat(bundlePath(root, file))).isFile())
          throw new Error(`Required engine file missing: ${engine.id}`);
    const protocolChecks: {
      engineId: string;
      passed: boolean;
      httpStatus?: number;
      result?: unknown;
      error?: string;
    }[] = [];
    let harnessModel: unknown;
    let harnessModelFailed = false;
    try {
      harnessModel = await harnessModelReport({
        file: harnessModelFile,
        settings,
        environment: process.env,
        registrations: await profiles(manifest, settings, context),
      });
    } catch (error) {
      harnessModelFailed = true;
      harnessModel = {
        configured: false,
        error:
          error instanceof Error ? error.message : "Unified model is invalid",
      };
    }
    if (values.protocol && !harnessModelFailed) {
      const hub = await startHub({
        dataDir: path.join(context.state, "checks", randomUUID()),
        configFile: generated,
        harnessModelFile,
        demo: false,
        cwd: context.workspace,
        port: 0,
      });
      try {
        for (const id of selected) {
          try {
            const initializationBudget =
              manifest.engines.find((engine) => engine.id === id)?.acp
                ?.initializeTimeoutMs ?? 10000;
            console.error(`Checking protocol: ${id}`);
            const response = await fetch(
              `${hub.url}/v1/engines/${encodeURIComponent(id)}/test`,
              {
                method: "POST",
                signal: AbortSignal.timeout(initializationBudget + 15000),
              },
            );
            const check: unknown = await response.json();
            const passed =
              response.ok &&
              typeof check === "object" &&
              check !== null &&
              "modelCalled" in check &&
              check.modelCalled === false &&
              "checks" in check &&
              Array.isArray(check.checks) &&
              check.checks.length > 0 &&
              check.checks.every(
                (item: unknown) =>
                  typeof item === "object" &&
                  item !== null &&
                  "status" in item &&
                  item.status === "passed",
              );
            protocolChecks.push({
              engineId: id,
              httpStatus: response.status,
              passed,
              result: check,
            });
          } catch (error) {
            protocolChecks.push({
              engineId: id,
              passed: false,
              error:
                error instanceof Error
                  ? error.message
                  : "Protocol check failed",
            });
          }
        }
      } finally {
        await hub.server.close();
      }
    }
    console.log(
      JSON.stringify(
        {
          modelCalled: false,
          platform: manifest.platform,
          arch: manifest.arch,
          nodeVersion: manifest.nodeVersion,
          integrity,
          harnessModel,
          protocolChecks,
          authentication:
            "Not verified; configure the competition API before model acceptance.",
        },
        null,
        2,
      ),
    );
    return harnessModelFailed || protocolChecks.some((check) => !check.passed)
      ? 1
      : 0;
  }
  if (command === "benchmark") {
    // The in-process Gateway reads HARNESSHUB_MODEL* itself; the saved model file
    // outranks settings, so it is carried as this configuration's model.
    const savedModel = await readHarnessModelFile(harnessModelFile);
    const benchmarkConfig = await configFile(manifest, settings, context, {
      name: "engines.benchmark.json",
      ...(savedModel ? { model: savedModel } : {}),
    });
    return benchmarkMain([
      ...args.slice(1),
      "--config",
      benchmarkConfig,
      "--data-dir",
      path.join(context.state, "benchmark"),
    ]);
  }
  throw new Error(`Unknown command ${command}; run hub.cmd help`);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.exitCode = await releaseMain(process.argv.slice(2));
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Portable command failed",
    );
    process.exitCode = 1;
  }
}
