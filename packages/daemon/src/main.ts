// SPDX-License-Identifier: MIT
import { COMMAND_MCP_ENTRY } from "./command-mcp-entry.js";
import { EngineConfigurationService } from "@harnesshub/agents/application/engine-configuration";
import {
  HarnessModelService,
  type RuntimeInfo,
} from "@harnesshub/agents/application/harness-model";
import { builtinConfigurationAdapter } from "@harnesshub/agents/engine/builtins";
import {
  normalizeEngine,
  prepareEngine,
  type HubConfig,
} from "@harnesshub/agents/engine/registry";
import { fullAccessEnabled } from "@harnesshub/agents/engine/full-access";
import { registerHarnessModelRoutes } from "./http/harness-model-routes.js";
import { providerProtocols } from "@harnesshub/agents/engine/configuration";
import { configurationAdapters } from "@harnesshub/core/engine-configuration";
import { createSecret } from "@harnesshub/secrets/secrets";
import { prepareConfiguration } from "@harnesshub/agents/configuration/prepare";
import { startModelGateway } from "@harnesshub/gateway/gateway";
import { probeConfiguration } from "@harnesshub/runtime/process/probe";
import { HubError } from "@harnesshub/core/errors";
import { parseBuildInfo, type BuildInfo } from "@harnesshub/core/build-info";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { RunId, SessionId } from "@harnesshub/core/types";
import { SqliteWorkflowStore } from "@harnesshub/store/storage/workflow-store";
import { WorkflowService } from "@harnesshub/runtime/application/workflows";
import { ObservationService } from "@harnesshub/runtime/application/observability";
import { parseArgs } from "node:util";
import { homedir } from "node:os";
import { EngineManager } from "@harnesshub/agents/engine/manager";
import { discoverEngines } from "@harnesshub/agents/engine/discovery";
import { inspectEngineInstallation } from "@harnesshub/agents/engine/installation";
import type { Workspace } from "@harnesshub/core/types";
import { mkdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "@harnesshub/agents/engine/registry";
import { SqliteStore } from "@harnesshub/store/storage/sqlite-store";
import { SqliteModelPlaneStore } from "@harnesshub/store/storage/model-plane-store";
import {
  SecretStore,
  type SecretBackendSetting,
} from "@harnesshub/secrets/secret-store";
import { ensureAdminToken, ADMIN_TOKEN_FILE } from "./admin-token.js";
import { registerApiV1 } from "./http/api-v1.js";
import { getPreset, listPresets } from "@harnesshub/gateway/presets";
import { ProcessWorkerHost } from "@harnesshub/runtime/process/worker-host";
import { sharedProcessLauncher } from "@harnesshub/runtime/process/launcher";
import { usePlatformLauncher } from "@harnesshub/store/platform/process-launcher";
import {
  createArtifactPublisher,
  readArtifact,
  discardArtifacts,
} from "@harnesshub/runtime/artifacts/publisher";
import { createFileArtifactCollector } from "@harnesshub/runtime/artifacts/collector";
import { Runtime } from "@harnesshub/runtime/runtime/runtime";
import { HubApplication } from "@harnesshub/runtime/application/service";
import { createGateway } from "./http/server.js";
import { registerToolPackageRoutes } from "./http/tool-package-routes.js";
import { createToolPackageManagement } from "@harnesshub/agents/tool-packages/management";
import {
  LOG_LEVEL_ENVIRONMENT,
  parseLogLevel,
  type LogLevel,
} from "@harnesshub/core/logging";
import { harnessModelEnvironment } from "@harnesshub/core/harness-model";
import { JsonLogFile } from "./logging/json-log-file.js";
import { observeStore } from "./logging/observed-store.js";
import { createSessionLogReader } from "./logging/session-log-reader.js";
import { createRedactor } from "./worker/diagnostics.js";

/** Gateway log records not mirrored by `logEcho`; per-request and per-call lines stay in the file. */
const QUIET_ECHO = new Set([
  "http",
  "model.call",
  "run.status",
  "session.backend",
  "permission.applied",
]);

/** Known secret values the Gateway redacts in its log: the environment's unified model key. */
function gatewayLogSecrets(): Set<string> {
  const secrets = new Set<string>();
  const modelKey = process.env[harnessModelEnvironment.apiKey];
  if (modelKey) secrets.add(modelKey);
  return secrets;
}

/**
 * Open `<dataDir>/logs/gateway.log`. The unified model key (when it comes from the
 * environment) is redacted as a known value on top of the credential patterns.
 */
function openGatewayLog(
  dataDir: string,
  level: LogLevel,
  echo: boolean,
): JsonLogFile {
  const file = path.join(dataDir, "logs", "gateway.log");
  return new JsonLogFile({
    file,
    level,
    redact: createRedactor(gatewayLogSecrets()),
    ...(echo
      ? {
          // stderr: stdout stays reserved for the machine-readable ready line.
          echo: (line: string, recordLevel: LogLevel, event: string) => {
            if (recordLevel === "info" && !QUIET_ECHO.has(event))
              process.stderr.write(`${line}\n`);
          },
        }
      : {}),
    onError: (error) =>
      process.stderr.write(
        `${JSON.stringify({
          event: "log.error",
          file,
          message: error instanceof Error ? error.message : String(error),
        })}\n`,
      ),
  });
}

/**
 * Read the identity written next to the compiled code by `tools/build-info.mjs`
 * (`dist/build-info.json`).
 *
 * @throws HubError `BUILD_INFO_UNAVAILABLE` when the file is missing or unreadable
 *   (the code was compiled without `pnpm build`), or `BUILD_INFO_INVALID`.
 */
export async function loadBuildInfo(
  file: URL = new URL("../build-info.json", import.meta.url),
): Promise<BuildInfo> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    throw new HubError(
      "BUILD_INFO_UNAVAILABLE",
      `Build identity ${fileURLToPath(file)} is unavailable (${error instanceof Error ? error.message : String(error)}); build with pnpm build`,
      500,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new HubError(
      "BUILD_INFO_INVALID",
      `build-info.json is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
      500,
    );
  }
  return parseBuildInfo(raw);
}

const secretBackends: readonly string[] = ["auto", "keychain", "dpapi", "file"];

/**
 * The platform's HarnessHub config root (07-data-security section 1): macOS
 * `~/Library/Application Support/HarnessHub/config`, Windows
 * `%LOCALAPPDATA%\HarnessHub\config`, elsewhere `$XDG_CONFIG_HOME/harnesshub`
 * (an absolute XDG value only) or `~/.config/harnesshub`.
 */
export function defaultConfigDir(
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  if (platform === "darwin")
    return path.join(
      home,
      "Library",
      "Application Support",
      "HarnessHub",
      "config",
    );
  if (platform === "win32")
    return path.win32.join(
      environment.LOCALAPPDATA ?? path.win32.join(home, "AppData", "Local"),
      "HarnessHub",
      "config",
    );
  const xdg = environment.XDG_CONFIG_HOME;
  return path.join(
    xdg && path.isAbsolute(xdg) ? xdg : path.join(home, ".config"),
    "harnesshub",
  );
}

/** Composition root: concrete implementations are assembled only here. */
export async function startHub(options: {
  dataDir: string;
  configFile?: string;
  demo: boolean;
  cwd: string;
  port: number;
  host?: string;
  defaultEngine?: string;
  workspaces?: Workspace[];
  /** Console page opened from the Gateway root `/`. */
  consoleUrl?: string;
  /** Installed Tool Package root; defaults to `<dataDir>/tool-packages`. */
  toolPackageRoot?: string;
  /**
   * Persistent unified-model file (ADR 0013); defaults to
   * `<dataDir>/harness-model.json`. Sources: HARNESSHUB_MODEL* > this file > config `model`.
   */
  harnessModelFile?: string;
  /**
   * Mirror info-level lifecycle records of `<dataDir>/logs/gateway.log` to stderr
   * (entry points only; access and model-call lines stay in the file; stdout keeps
   * only the entry point's own ready events).
   */
  logEcho?: boolean;
  /**
   * Config root holding `secrets.key` of the encrypted-file secret backend
   * (07-data-security section 1); defaults to the platform's HarnessHub
   * config directory (`defaultConfigDir`).
   */
  configDir?: string;
  /** Backend for new managed secrets (`secrets.backend`); `auto` by default. */
  secretsBackend?: SecretBackendSetting;
}) {
  // HARNESSHUB_LOG_LEVEL is validated before anything starts; Workers inherit the value.
  const logLevel = parseLogLevel(process.env[LOG_LEVEL_ENVIRONMENT]);
  // Helper programs (secrets, Windows ACLs) start through this process's
  // launcher; every Gateway of the process shares it, and `main` closes it.
  const launcher = sharedProcessLauncher();
  usePlatformLauncher(launcher);
  const build = await loadBuildInfo();
  const resolveConfig = async () => {
    const config = await loadConfig({
      demo: options.demo,
      cwd: options.cwd,
      ...(options.configFile ? { file: options.configFile } : {}),
    });
    if (!options.workspaces) return config;
    if (
      !options.workspaces.length ||
      new Set(options.workspaces.map((w) => w.id)).size !==
        options.workspaces.length
    )
      throw new Error("Workspace override must contain unique workspaces");
    const workspaces = await Promise.all(
      options.workspaces.map(async (w) => {
        const location = await realpath(w.path);
        if (!(await stat(location)).isDirectory())
          throw new Error("Workspace override must be a directory");
        return { id: w.id, path: location };
      }),
    );
    return { ...config, workspaces, defaultWorkspace: workspaces[0]!.id };
  };
  const baseConfig = await resolveConfig();
  const requestedDataDir = path.resolve(options.dataDir);
  await mkdir(requestedDataDir, { recursive: true, mode: 0o700 });
  const dataDir = await realpath(requestedDataDir);
  // Ownership comes first: a second start on this directory fails before it
  // writes anything, including the running Gateway's log and model file (F05).
  const store = new SqliteStore(path.join(dataDir, "harnesshub.sqlite"), {
    appVersion: build.version,
  });
  try {
    store.acquireOwner();
  } catch (error) {
    store.close();
    throw error;
  }
  /** A Session's engine log, written by its Worker under the Session state directory. */
  const engineLogPath = (sessionId: string) =>
    path.join(dataDir, "backends", sessionId, "diagnostics", "engine.log");
  let gatewayLog: ReturnType<typeof openGatewayLog>;
  try {
    gatewayLog = openGatewayLog(dataDir, logLevel, options.logEcho ?? false);
  } catch (error) {
    store.close();
    throw error;
  }
  gatewayLog.info("gateway.start", {
    pid: process.pid,
    dataDir,
    engine: options.defaultEngine ?? null,
    logLevel,
    build: {
      version: build.version,
      commit: build.commit,
      dirty: build.dirty,
      builtAt: build.builtAt,
    },
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    engineLogs: path.join(dataDir, "backends", "<sessionId>", "diagnostics"),
  });
  let harnessModel: HarnessModelService;
  try {
    harnessModel = await HarnessModelService.load({
      environment: process.env,
      file: path.resolve(
        options.harnessModelFile ?? path.join(dataDir, "harness-model.json"),
      ),
      ...(baseConfig.model ? { settings: baseConfig.model } : {}),
      ports: {
        normalize: normalizeEngine,
        inferAdapter: builtinConfigurationAdapter,
      },
    });
  } catch (error) {
    gatewayLog.info("gateway.start_failed", {
      stage: "unified-model",
      message: error instanceof Error ? error.message : String(error),
    });
    store.close();
    throw error;
  }
  {
    // `active()` needs no engine catalog; key values are never part of it.
    const active = harnessModel.active();
    gatewayLog.info("model.configured", {
      configured: active !== undefined,
      source: active?.source ?? null,
      model: active?.model ?? null,
      alias: active?.alias ?? null,
      protocol: active?.provider.protocol ?? null,
      baseUrl: active?.provider.baseUrl ?? null,
      contextWindow: active?.provider.contextWindow ?? null,
      maxOutputTokens: active?.provider.maxOutputTokens ?? null,
      compatibility: active?.provider.compatibility
        ? JSON.parse(JSON.stringify(active.provider.compatibility))
        : null,
    });
  }
  const discover = (includeManifests = true) =>
    discoverEngines({
      cwd: options.cwd,
      home: homedir(),
      pathEnv: process.env.PATH ?? "",
      nodeExecutable: process.execPath,
      ...(process.env.PATHEXT ? { pathExt: process.env.PATHEXT } : {}),
      ...(process.env.APPDATA ? { appData: process.env.APPDATA } : {}),
      ...(process.env.LOCALAPPDATA
        ? { localAppData: process.env.LOCALAPPDATA }
        : {}),
      ...(includeManifests ? {} : { includeManifests: false }),
    });
  const config = baseConfig;
  const runtimeInfo: RuntimeInfo = {
    build,
    fullAccess: fullAccessEnabled(process.env),
    ...(options.consoleUrl ? { consoleUrl: options.consoleUrl } : {}),
  };
  const artifactRoot = path.join(dataDir, "artifacts");
  const host = new ProcessWorkerHost({
    workerEntry: new URL("./worker/main.js", import.meta.url),
    shutdownGraceMs: config.cancelGraceMs,
    maxWorkers: config.maxWorkers,
    leaseDir: path.join(dataDir, "workers"),
    log: gatewayLog,
    // Workers write their Session engine log at the Gateway's validated level.
    env: { [LOG_LEVEL_ENVIRONMENT]: logLevel },
  });
  let runtime: Runtime | undefined;
  let manager: EngineManager | undefined;
  let workflowStore: SqliteWorkflowStore | undefined;
  let workflows: WorkflowService | undefined;
  let modelPlane: SqliteModelPlaneStore | undefined;
  try {
    // The model-plane API: the admin token, managed secrets and the store
    // on this owned database (opened after SqliteStore applied migrations).
    const adminTokenDigest = await ensureAdminToken(dataDir);
    const secrets = await SecretStore.open({
      dataDir,
      configDir: path.resolve(options.configDir ?? defaultConfigDir()),
      backend: options.secretsBackend ?? "auto",
      launcher,
    });
    modelPlane = new SqliteModelPlaneStore(
      path.join(dataDir, "harnesshub.sqlite"),
    );
    manager = new EngineManager({
      config,
      persistence: store,
      load: resolveConfig,
      policy: harnessModel.policy(),
      ...(options.defaultEngine
        ? { initialDefault: options.defaultEngine }
        : {}),
      ...(options.configFile
        ? { configFile: path.resolve(options.configFile) }
        : {}),
      discover: () => discover(),
    });
    const recoveredWorkers = await host.recover();
    const observedStore = observeStore(store, gatewayLog, {
      engineLog: engineLogPath,
    });
    runtime = new Runtime(observedStore, host, {
      ...config,
      catalog: manager,
      stateDir: path.join(dataDir, "backends"),
      recoveredWorkers,
      publishArtifact: createArtifactPublisher(artifactRoot),
      collectArtifacts: createFileArtifactCollector(artifactRoot),
      discardArtifacts: (records) => discardArtifacts(artifactRoot, records),
      inspectInstallation: (profile, signal) =>
        inspectEngineInstallation(profile, {
          pathEnv: process.env.PATH ?? "",
          signal,
        }),
    });
    const app = new HubApplication(
      runtime,
      async (artifact) => readArtifact(artifactRoot, artifact),
      manager,
    );
    harnessModel.bind({
      catalog: manager,
      sessions: app,
      scratchDirectory: dataDir,
    });
    workflowStore = new SqliteWorkflowStore(
      path.join(dataDir, "harnesshub.sqlite"),
    );
    workflows = new WorkflowService(app, workflowStore);
    const observations = new ObservationService({
      store,
      engines: () => runtime!.listEngines(),
    });
    const activeProbes = new Set<AbortController>();
    const probeTasks = new Set<Promise<unknown>>();
    const configuration = new EngineConfigurationService({
      templates: () => discover(false),
      inspect: prepareEngine,
      createSecret: (value) => createSecret(value, launcher),
      adapters: () =>
        configurationAdapters.map((id) => ({
          id,
          providerProtocols: [...providerProtocols[id]],
          description: providerProtocols[id].length
            ? "支持独立 Provider 配置；Skills 使用便携上下文；MCP 需要 ACP"
            : "使用原生账号配置或显式环境引用；Skills 使用便携上下文；MCP 需要 ACP",
        })),
      test: async (id) => {
        const profile = manager!.list().find((p) => p.id === id);
        if (!profile || profile.driver === "fake")
          throw new HubError(
            "ENGINE_UNAVAILABLE",
            "Configured engine not found",
            404,
          );
        if (activeProbes.size >= 2)
          throw new HubError(
            "PROBE_BUSY",
            "Two configuration tests are already running",
            429,
          );
        const abort = new AbortController();
        activeProbes.add(abort);
        const task = (async () => {
          let directory: string | undefined;
          let prepared:
            Awaited<ReturnType<typeof prepareConfiguration>> | undefined;
          try {
            directory = await mkdtemp(
              path.join(dataDir, "configuration-test-"),
            );
            prepared = await prepareConfiguration(
              {
                profile,
                cwd: options.cwd,
                stateDir: directory,
                sessionId: randomUUID() as SessionId,
                runId: randomUUID() as RunId,
                generation: 1,
                input: { text: "", timeoutMs: 10000 },
              },
              process.env,
              {
                startModelGateway,
                processLauncher: launcher,
                commandMcpEntry: COMMAND_MCP_ENTRY,
              },
            );
            const probe = await probeConfiguration(
              prepared,
              profile.driver,
              options.cwd,
              abort.signal,
              profile.acp?.initializeTimeoutMs,
            );
            return {
              engineId: id,
              revision: profile.revision,
              checkedAt: Date.now(),
              modelCalled: false as const,
              checks: [
                {
                  name: "configuration",
                  status: "passed" as const,
                  message:
                    "模型配置、密钥引用与 Skill 指纹已解析；未向模型发送任务",
                },
                probe,
              ],
            };
          } catch (error) {
            return {
              engineId: id,
              revision: profile.revision,
              checkedAt: Date.now(),
              modelCalled: false as const,
              checks: [
                {
                  name: "configuration",
                  status: "failed" as const,
                  message:
                    error instanceof HubError
                      ? error.message
                      : "配置文件、可执行文件或凭证引用不可用",
                },
              ],
            };
          } finally {
            try {
              await prepared?.modelBridge?.close();
              if (directory)
                await rm(directory, { recursive: true, force: true });
            } finally {
              activeProbes.delete(abort);
            }
          }
        })();
        probeTasks.add(task);
        try {
          return await task;
        } finally {
          probeTasks.delete(task);
        }
      },
    });
    const bindHost = options.host ?? "127.0.0.1";
    const server = await createGateway(app, {
      workflows,
      observations,
      configuration,
      remoteHosts: !["localhost", "127.0.0.1", "::1", "[::1]"].includes(
        bindHost,
      ),
      log: gatewayLog,
      sessionLogs: createSessionLogReader({
        gatewayLog: gatewayLog.file,
        engineLog: engineLogPath,
        redact: createRedactor(gatewayLogSecrets()),
        ownRoute: "/v1/sessions/:id/logs",
      }),
    });
    const toolPackages = createToolPackageManagement({
      root: options.toolPackageRoot ?? path.join(dataDir, "tool-packages"),
      nodeExecutable: process.execPath,
      commandMcpEntry: COMMAND_MCP_ENTRY,
      engineProfile: (id) => app.engineProfile(id),
      registerEngine: (input) => app.registerEngine(input),
      listEngines: () => app.engines(),
    });
    registerToolPackageRoutes(server, toolPackages);
    registerHarnessModelRoutes(server, harnessModel, () => runtimeInfo);
    registerApiV1(server, {
      adminTokenDigest,
      modelPlane,
      secrets,
      presets: { list: listPresets, get: getPreset },
      // env credential references read the environment the daemon started with.
      environment: Object.freeze({ ...process.env }),
      system: {
        apiVersion: "v1",
        version: build.version,
        commit: build.commit,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        dataDir,
        secretBackend: secrets.backend,
      },
      log: gatewayLog,
    });
    // Registered after createGateway's hook, so the application has already cancelled
    // Runs; this only stops a pending model test and waits for its Session cleanup.
    server.addHook("preClose", async () => harnessModel.close());
    if (options.consoleUrl) {
      const consoleUrl = options.consoleUrl;
      server.get("/", async (_request, reply) => reply.redirect(consoleUrl));
    }
    server.addHook("onClose", async () => {
      for (const abort of activeProbes) abort.abort();
      await Promise.allSettled([...probeTasks]);
    });
    server.addHook("onClose", async () => {
      workflowStore?.close();
      modelPlane?.close();
      store.close();
    });
    // Fastify runs onClose hooks last-registered first, so this marks the start of
    // shutdown; Worker exits recorded by the host afterwards still reach the file.
    server.addHook("onClose", async () => {
      gatewayLog.info("gateway.stop", { pid: process.pid });
    });
    const url = await server.listen({
      host: bindHost,
      port: options.port,
    });
    gatewayLog.info("gateway.listen", {
      url,
      host: bindHost,
      remoteHosts: !["localhost", "127.0.0.1", "::1", "[::1]"].includes(
        bindHost,
      ),
      fullAccess: runtimeInfo.fullAccess,
      consoleUrl: options.consoleUrl ?? null,
      adminToken: path.join(dataDir, ADMIN_TOKEN_FILE),
      maxConcurrency: config.maxConcurrency,
      defaultTimeoutMs: config.defaultTimeoutMs,
    });
    return { server, app, url, logFile: gatewayLog.file };
  } catch (error) {
    gatewayLog.info("gateway.start_failed", {
      stage: "startup",
      message: error instanceof Error ? error.message : String(error),
    });
    await workflows?.close();
    await manager?.close();
    try {
      await runtime?.close();
    } catch {
      /* Preserve the startup error; host cleanup follows independently. */
    }
    try {
      await host.close();
    } catch {
      /* Unconfirmed process leases remain available to the next startup. */
    }
    workflowStore?.close();
    modelPlane?.close();
    store.close();
    throw error;
  }
}

/**
 * Command-line entry of `serve` (`node dist/src/main.js` and `hh serve`):
 * `--version [--json]`, `--help`, or start the Gateway and print the `ready`
 * line on stdout. Usage and version errors set `process.exitCode`; a startup
 * failure rejects, which ends the process with exit code 1 exactly like the
 * former top-level await did. A started Gateway keeps running after this
 * resolves and stops on SIGINT or SIGTERM.
 *
 * @param argv The command-line arguments after the command itself.
 */
export async function main(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      demo: { type: "boolean", default: false },
      config: { type: "string" },
      engine: { type: "string" },
      host: { type: "string", default: "localhost" },
      port: { type: "string" },
      "data-dir": { type: "string", default: "./data" },
      "config-dir": { type: "string" },
      "secrets-backend": { type: "string" },
      "tool-package-root": { type: "string" },
      "harness-model-file": { type: "string" },
      "console-url": { type: "string" },
      help: { type: "boolean" },
      version: { type: "boolean" },
      json: { type: "boolean" },
    },
  });
  if (values.json && !values.version) {
    console.error("--json is only valid with --version");
    process.exitCode = 2;
  } else if (values.version) {
    try {
      const build = await loadBuildInfo();
      const dirty =
        build.dirty === true
          ? " (dirty)"
          : build.dirty === "unknown"
            ? " (dirty: unknown)"
            : "";
      console.log(
        values.json
          ? JSON.stringify(build)
          : `HarnessHub ${build.version} ${build.commit}${dirty}`,
      );
    } catch (error) {
      console.error(
        error instanceof HubError
          ? `${error.code}: ${error.message}`
          : String(error),
      );
      process.exitCode = 1;
    }
  } else if (
    values["secrets-backend"] !== undefined &&
    !secretBackends.includes(values["secrets-backend"])
  ) {
    console.error(
      `--secrets-backend must be one of ${secretBackends.join(", ")}`,
    );
    process.exitCode = 2;
  } else if (values.help)
    console.log(
      "HarnessHub: node dist/src/main.js [--engine opencode] [--host localhost] [--port 3180] [--config engines/local.yaml] [--data-dir ./data] [--config-dir DIR] [--secrets-backend auto|keychain|dpapi|file] [--tool-package-root DIR] [--harness-model-file FILE] [--console-url URL] | --version [--json]",
    );
  else {
    const selectedEngine = values.engine ?? process.env.AGENT_ENGINE;
    const port = Number(values.port ?? "3180");
    if (!Number.isInteger(port) || port < 0 || port > 65535)
      throw new Error("Invalid port");
    const hub = await startHub({
      dataDir: values["data-dir"],
      ...(values["config-dir"] ? { configDir: values["config-dir"] } : {}),
      ...(values["secrets-backend"]
        ? {
            secretsBackend: values["secrets-backend"] as SecretBackendSetting,
          }
        : {}),
      demo: values.demo,
      port,
      host: values.host,
      cwd: process.cwd(),
      ...(values.config ? { configFile: values.config } : {}),
      ...(selectedEngine ? { defaultEngine: selectedEngine } : {}),
      ...(values["tool-package-root"]
        ? { toolPackageRoot: values["tool-package-root"] }
        : {}),
      ...(values["harness-model-file"]
        ? { harnessModelFile: values["harness-model-file"] }
        : {}),
      ...(values["console-url"] ? { consoleUrl: values["console-url"] } : {}),
      logEcho: true,
    });
    console.log(
      JSON.stringify({
        event: "ready",
        log: hub.logFile,
        url: hub.url,
        demo: values.demo,
        engine: selectedEngine ?? hub.app.defaultEngine(),
        pid: process.pid,
      }),
    );
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      void hub.server
        .close()
        .then(() => sharedProcessLauncher().close())
        .catch((error: unknown) => {
          console.error(error);
          process.exitCode = 1;
        });
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  // Not a top-level await: the single-executable spike (tools/sea) bundles this
  // module as CommonJS, which cannot contain one. The rejection stays unhandled on
  // purpose so the process still exits with code 1 and prints the error.
  void main(process.argv.slice(2));
}
