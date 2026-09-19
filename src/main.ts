import { EngineConfigurationService } from "./application/engine-configuration.js";
import {
  HarnessModelService,
  type RuntimeInfo,
} from "./application/harness-model.js";
import { builtinConfigurationAdapter } from "./engine/builtins.js";
import {
  normalizeEngine,
  prepareEngine,
  type HubConfig,
} from "./engine/registry.js";
import { fullAccessEnabled } from "./distribution/full-access.js";
import { registerHarnessModelRoutes } from "./gateway/harness-model-routes.js";
import { providerProtocols } from "./engine/configuration.js";
import { configurationAdapters } from "./domain/engine-configuration.js";
import { createSecret } from "./drivers/configuration/secrets.js";
import { prepareConfiguration } from "./drivers/configuration/prepare.js";
import { probeConfiguration } from "./drivers/configuration/probe.js";
import { HubError } from "./domain/errors.js";
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { RunId, SessionId } from "./domain/types.js";
import { SqliteWorkflowStore } from "./storage/workflow-store.js";
import { WorkflowService } from "./application/workflows.js";
import { ObservationService } from "./application/observability.js";
import { parseArgs } from "node:util";
import { homedir } from "node:os";
import { EngineManager } from "./engine/manager.js";
import { discoverEngines } from "./engine/discovery.js";
import { inspectEngineInstallation } from "./engine/installation.js";
import type { Workspace } from "./domain/types.js";
import { mkdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./engine/registry.js";
import { SqliteStore } from "./storage/sqlite-store.js";
import { ProcessWorkerHost } from "./process/worker-host.js";
import {
  createArtifactPublisher,
  readArtifact,
  discardArtifacts,
} from "./artifacts/publisher.js";
import { createFileArtifactCollector } from "./artifacts/collector.js";
import { Runtime } from "./runtime/runtime.js";
import { HubApplication } from "./application/service.js";
import { createGateway } from "./gateway/server.js";
import { registerCompetitionRoutes } from "./gateway/competition/routes.js";
import { registerToolPackageRoutes } from "./gateway/tool-package-routes.js";
import { createToolPackageManagement } from "./tool-packages/management.js";
import {
  LOG_LEVEL_ENVIRONMENT,
  parseLogLevel,
  type LogLevel,
} from "./domain/logging.js";
import { harnessModelEnvironment } from "./domain/harness-model.js";
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
  competition?: boolean;
  /** Engine used by every Competition `/session`, independent of later default changes. */
  competitionEngine?: string;
  /** Console page opened from the Gateway root `/`. */
  consoleUrl?: string;
  /** Installed Tool Package root; defaults to `<dataDir>/tool-packages`. */
  toolPackageRoot?: string;
  /**
   * Persistent unified-model file shared by bundle entry points (ADR 0013); defaults to
   * `<dataDir>/harness-model.json`. Sources: HARNESSHUB_MODEL* > this file > config `model`.
   */
  harnessModelFile?: string;
  /**
   * Mirror info-level lifecycle records of `<dataDir>/logs/gateway.log` to stderr
   * (entry points only; access and model-call lines stay in the file; stdout keeps
   * only the entry point's own ready events).
   */
  logEcho?: boolean;
}) {
  // HARNESSHUB_LOG_LEVEL is validated before anything starts; Workers inherit the value.
  const logLevel = parseLogLevel(process.env[LOG_LEVEL_ENVIRONMENT]);
  const resolveConfig = async () => {
    const config = await loadConfig({
      demo: options.demo,
      cwd: options.cwd,
      ...(options.competition ? { competition: true } : {}),
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
  /** A Session's engine log, written by its Worker under the Session state directory. */
  const engineLogPath = (sessionId: string) =>
    path.join(dataDir, "backends", sessionId, "diagnostics", "engine.log");
  const gatewayLog = openGatewayLog(
    dataDir,
    logLevel,
    options.logEcho ?? false,
  );
  gatewayLog.info("gateway.start", {
    pid: process.pid,
    dataDir,
    competition: options.competition ?? false,
    engine: options.competitionEngine ?? options.defaultEngine ?? null,
    logLevel,
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
  /**
   * Source-mode Competition with a unified model may start from AGENT_ENGINE alone: an
   * unconfigured competition engine is added from its reviewed discovery recipe as a
   * base (file-level) entry, so the unified model policy applies to it like any other.
   */
  const withCompetitionEngine = async (
    loaded: HubConfig,
  ): Promise<HubConfig> => {
    const id = options.competitionEngine;
    if (
      !id ||
      !harnessModel.active() ||
      loaded.engines.some((engine) => engine.id === id)
    )
      return loaded;
    const candidate = (await discover()).find((item) => item.id === id);
    if (candidate?.status !== "ready" || !candidate.registration) return loaded;
    return {
      ...loaded,
      engines: [...loaded.engines, await prepareEngine(candidate.registration)],
    };
  };
  const config = await withCompetitionEngine(baseConfig);
  const runtimeInfo: RuntimeInfo = {
    competition: options.competition ?? false,
    ...(options.competitionEngine
      ? { competitionEngine: options.competitionEngine }
      : {}),
    fullAccess: fullAccessEnabled(process.env),
    ...(options.consoleUrl ? { consoleUrl: options.consoleUrl } : {}),
  };
  const artifactRoot = path.join(dataDir, "artifacts");
  const store = new SqliteStore(path.join(dataDir, "harnesshub.sqlite"));
  try {
    store.acquireOwner();
  } catch (error) {
    store.close();
    throw error;
  }
  const host = new ProcessWorkerHost({
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
  try {
    manager = new EngineManager({
      config,
      persistence: store,
      load: async () => withCompetitionEngine(await resolveConfig()),
      policy: harnessModel.policy(),
      ...(options.defaultEngine
        ? { initialDefault: options.defaultEngine }
        : {}),
      ...(options.configFile
        ? { configFile: path.resolve(options.configFile) }
        : {}),
      discover: () => discover(),
    });
    // Fail startup when the fixed Competition engine cannot run, with the policy reason.
    if (options.competitionEngine) manager.resolve(options.competitionEngine);
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
      createSecret,
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
      commandMcpEntry: fileURLToPath(
        new URL("./drivers/tool-command/command-mcp.js", import.meta.url),
      ),
      engineProfile: (id) => app.engineProfile(id),
      registerEngine: (input) => app.registerEngine(input),
      listEngines: () => app.engines(),
    });
    registerToolPackageRoutes(server, toolPackages);
    registerHarnessModelRoutes(server, harnessModel, () => runtimeInfo);
    // Registered after createGateway's hook, so the application has already cancelled
    // Runs; this only stops a pending model test and waits for its Session cleanup.
    server.addHook("preClose", async () => harnessModel.close());
    if (options.competition)
      registerCompetitionRoutes(server, app, {
        ...(options.competitionEngine
          ? { engineId: options.competitionEngine }
          : {}),
      });
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
    store.close();
    throw error;
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { values } = parseArgs({
    options: {
      demo: { type: "boolean", default: false },
      competition: { type: "boolean", default: false },
      config: { type: "string" },
      engine: { type: "string" },
      host: { type: "string", default: "localhost" },
      port: { type: "string" },
      "data-dir": { type: "string", default: "./data" },
      "tool-package-root": { type: "string" },
      "harness-model-file": { type: "string" },
      "console-url": { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help)
    console.log(
      "HarnessHub: node dist/src/main.js [--competition] [--engine opencode] [--host localhost] [--port 6217] [--config engines/local.yaml] [--data-dir ./data] [--tool-package-root DIR] [--harness-model-file FILE] [--console-url URL]",
    );
  else {
    const selectedEngine = values.engine ?? process.env.AGENT_ENGINE;
    if (values.competition && !selectedEngine)
      throw new Error("Competition mode requires --engine or AGENT_ENGINE");
    const port = Number(values.port ?? (values.competition ? "6217" : "3180"));
    if (!Number.isInteger(port) || port < 0 || port > 65535)
      throw new Error("Invalid port");
    const hub = await startHub({
      dataDir: values["data-dir"],
      demo: values.demo,
      competition: values.competition,
      port,
      host: values.host,
      cwd: process.cwd(),
      ...(values.config ? { configFile: values.config } : {}),
      ...(selectedEngine ? { defaultEngine: selectedEngine } : {}),
      ...(values.competition && selectedEngine
        ? { competitionEngine: selectedEngine }
        : {}),
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
        competition: values.competition,
        engine: selectedEngine ?? hub.app.defaultEngine(),
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
}
