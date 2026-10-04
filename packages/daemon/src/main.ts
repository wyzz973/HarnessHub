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
import { codexWiringCatalog } from "@harnesshub/agents/configuration/codex-models";
import { configurationAdapters } from "@harnesshub/core/engine-configuration";
import { createSecret } from "@harnesshub/secrets/secrets";
import {
  gatewayRoutable,
  prepareConfiguration,
} from "@harnesshub/agents/configuration/prepare";
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
import {
  ensureAdminToken,
  readAdminToken,
  ADMIN_TOKEN_FILE,
} from "./admin-token.js";
import {
  defaultConfigDir,
  formatSource,
  readConfigFile,
  resolveConfig,
  startOptions,
  type ResolvedConfig,
} from "./config-file.js";
import { GatewayFeaturesFile } from "./gateway-features.js";
import { registerApiV1 } from "./http/api-v1.js";
import { ConsoleSessions } from "./http/console-session.js";
import { loadConsole, registerConsole } from "./http/console-static.js";
import { consoleAssets } from "@harnesshub/console/assets";
import { AgentWiringService, resolveWiringSettings } from "./agents-wiring.js";
import { BackupService } from "./backup.js";
import { SyncService } from "./sync.js";
import { LibraryService } from "./library-service.js";
import { SIWC, SiwcClient, SiwcTokens } from "@harnesshub/gateway/siwc";
import { CopilotHosts } from "./copilot.js";
import { allowanceFile, SubscriptionService } from "./subscriptions.js";
import { ProviderDoctor } from "./provider-doctor.js";
import { GatewayShare } from "./lan-share.js";
import {
  getPreset,
  listPresets,
  resolveMagpiePreset,
} from "@harnesshub/gateway/presets";
import { modelCatalog } from "@harnesshub/gateway/catalog";
import {
  CatalogRefresher,
  resolveCatalogSettings,
} from "@harnesshub/gateway/catalog-refresh";
import type { ModelCallEntry } from "@harnesshub/core/model-plane";
import {
  createGatewayHandler,
  type GatewayHandler,
} from "@harnesshub/gateway/server";
import { resolveHandlerLimits } from "@harnesshub/gateway/limits";
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
import { ModelSessions, type ModelRouting } from "./model-sessions.js";
import {
  exportCommittedCalls,
  resolveOtlpConfig,
  startModelCallExport,
  type ModelCallExporter,
} from "./otlp-export.js";
import type { Store } from "@harnesshub/core/ports";
import type { EngineProfile } from "@harnesshub/core/types";

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

/**
 * The model-plane store whose ledger reports each committed call, so the
 * catalog can refresh early when a served model had no price.
 */
class CallObservingModelPlaneStore extends SqliteModelPlaneStore {
  /** Called after a committed write that can change the models the gateway offers. */
  catalogChanged: () => void = () => undefined;

  constructor(
    file: string,
    private readonly observe: (entry: ModelCallEntry) => void,
  ) {
    super(file);
  }

  override async appendModelCall(entry: ModelCallEntry): Promise<void> {
    await super.appendModelCall(entry);
    this.observe(entry);
  }

  override async putProvider(
    ...args: Parameters<SqliteModelPlaneStore["putProvider"]>
  ): Promise<void> {
    await super.putProvider(...args);
    this.catalogChanged();
  }

  override async deleteProvider(
    ...args: Parameters<SqliteModelPlaneStore["deleteProvider"]>
  ): Promise<boolean> {
    const deleted = await super.deleteProvider(...args);
    if (deleted) this.catalogChanged();
    return deleted;
  }

  override async putProviderMetadata(
    ...args: Parameters<SqliteModelPlaneStore["putProviderMetadata"]>
  ): ReturnType<SqliteModelPlaneStore["putProviderMetadata"]> {
    const result = await super.putProviderMetadata(...args);
    this.catalogChanged();
    return result;
  }

  override async putRouteGroup(
    ...args: Parameters<SqliteModelPlaneStore["putRouteGroup"]>
  ): Promise<void> {
    await super.putRouteGroup(...args);
    this.catalogChanged();
  }

  override async deleteRouteGroup(
    ...args: Parameters<SqliteModelPlaneStore["deleteRouteGroup"]>
  ): Promise<boolean> {
    const deleted = await super.deleteRouteGroup(...args);
    if (deleted) this.catalogChanged();
    return deleted;
  }
}

export { defaultConfigDir } from "./config-file.js";

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
  /**
   * The built console served at `/` (ADR-P10); defaults to the build of
   * `@harnesshub/console`. Without its `index.html` the page answers 503.
   */
  consoleDir?: string;
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
  /**
   * Overrides of the shared model gateway's limits (`gateway.limits`), resolved
   * by `resolveHandlerLimits`; unknown or out-of-range values fail the start.
   */
  gatewayLimits?: unknown;
  /**
   * The model catalog settings (`catalog.autoRefresh`, default true;
   * `catalog.url`, default models.dev), resolved by
   * `resolveCatalogSettings`; `HH_OFFLINE=1` turns the background refresh
   * off. Invalid values fail the start.
   */
  catalog?: { autoRefresh?: boolean; url?: string };
  /**
   * The `otlp` block: OTLP export of committed model calls, off when absent.
   * Resolved by `resolveOtlpConfig`; an invalid block fails the start.
   */
  otlp?: unknown;
  /**
   * The home directory whose agent configuration global wiring edits, and
   * the environment agents see there (PATH, CODEX_HOME, ...). Only the
   * `hh serve` entry passes the real home; without it every `/api/v1/agents`
   * operation fails with AGENT_WIRING_UNAVAILABLE instead of falling back to
   * the account's home.
   */
  wiringHome?: {
    home: string;
    env: Readonly<Record<string, string | undefined>>;
  };
  /**
   * The `wiring` settings: `autoSync` (default true) rewrites the model
   * lists in wired agents' files when the gateway's models change. Resolved
   * by `resolveWiringSettings`; invalid values fail the start.
   */
  wiring?: unknown;
  /**
   * For tests only: the Sign in with ChatGPT issuer and the Responses base a
   * first ChatGPT sign-in gives its provider, pointed at loopback fakes.
   * Unset, they are OpenAI's (`https://auth.openai.com`,
   * `https://api.openai.com/v1`); there is no user setting.
   */
  siwc?: { issuer: string; responsesBase: string };
  /**
   * For tests only: the Copilot CLI, the Copilot SDK add-on directory and
   * npm, pointed at fakes. Unset, the CLI and npm are found on PATH and the
   * add-on is `<dataDir>/addons/copilot-sdk`; there is no user setting.
   */
  copilot?: { cli: string; addon: string; npm: string };
}) {
  // HARNESSHUB_LOG_LEVEL is validated before anything starts; Workers inherit the value.
  const logLevel = parseLogLevel(process.env[LOG_LEVEL_ENVIRONMENT]);
  const gatewayLimits = resolveHandlerLimits(options.gatewayLimits);
  const catalogSettings = resolveCatalogSettings(options.catalog, process.env);
  const wiringSettings = resolveWiringSettings(options.wiring);
  const otlpConfig = resolveOtlpConfig(options.otlp);
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
  let modelPlane: CallObservingModelPlaneStore | undefined;
  let modelGateway: GatewayHandler | undefined;
  let subscriptions: SubscriptionService | undefined;
  let copilotHosts: CopilotHosts | undefined;
  // Every model-plane write of the API and of subscription sign-ins, in order.
  let writes: Promise<unknown> = Promise.resolve();
  const serializeWrites = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = writes.then(operation, operation);
    writes = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  /** OTLP export of committed model calls; only with an `otlp` block. */
  let otlp: ModelCallExporter | undefined;
  let shareToClose: GatewayShare | undefined;
  let syncToClose: SyncService | undefined;
  let server: Awaited<ReturnType<typeof createGateway>> | undefined;
  /** The Runtime's store, where `model.call` Run events are committed. */
  let runStore: Store = store;
  let catalog: CatalogRefresher | undefined;
  /** Where local clients reach the model gateway; known once the listener is bound. */
  let gatewayOrigin: string | undefined;
  // env credential references read the environment the daemon started with.
  const environment = Object.freeze({ ...process.env });
  const startedAt = new Date().toISOString();
  try {
    // The model-plane API: the admin token, managed secrets and the store
    // on this owned database (opened after SqliteStore applied migrations).
    const adminTokenDigest = await ensureAdminToken(dataDir);
    const consoleSessions = new ConsoleSessions();
    const consoleBundle = await loadConsole(
      path.resolve(options.consoleDir ?? fileURLToPath(consoleAssets)),
    );
    const configDir = path.resolve(options.configDir ?? defaultConfigDir());
    const secrets = await SecretStore.open({
      dataDir,
      configDir,
      backend: options.secretsBackend ?? "auto",
      launcher,
    });
    modelPlane = new CallObservingModelPlaneStore(
      path.join(dataDir, "harnesshub.sqlite"),
      (entry) => catalog?.noteCall(entry),
    );
    // Session Runs use the shared gateway (03 section 10). A Session's engine
    // is routed when the unified model was applied to its profile, or when it
    // is routable and declares no provider of its own (then only once a
    // model target exists); explicit providers keep the Worker gateway.
    const routeSession = (profile: EngineProfile): ModelRouting | undefined => {
      if (profile.driver === "fake" || !profile.command) return undefined;
      const configuration = profile.configuration;
      if (configuration?.provider) {
        const active = harnessModel.active();
        return active &&
          harnessModel.migrated() &&
          gatewayRoutable(configuration.adapter) &&
          JSON.stringify(configuration.provider) ===
            JSON.stringify(active.provider)
          ? { adapter: configuration.adapter, required: true }
          : undefined;
      }
      const adapter =
        configuration?.adapter ?? builtinConfigurationAdapter(profile.id);
      return adapter && gatewayRoutable(adapter)
        ? { adapter, required: false }
        : undefined;
    };
    const sessions = new ModelSessions({
      store: modelPlane,
      events: () => runStore,
      gateway: () => modelGateway,
      origin: () => gatewayOrigin,
      route: routeSession,
      clock: Date.now,
      log: gatewayLog,
    });
    // Keys of a previous process cannot be presented any more.
    await sessions.revokeAll();
    // The legacy unified model is mirrored into the model plane once.
    await harnessModel.syncModelPlane({ store: modelPlane, log: gatewayLog });
    // The models.dev catalog: the bundled snapshot or a newer refreshed copy
    // under <dataDir>/catalog; refreshing starts once the daemon listens.
    catalog = await CatalogRefresher.open({
      directory: path.join(dataDir, "catalog"),
      settings: catalogSettings,
      bundled: modelCatalog,
      log: gatewayLog,
    });
    const plane = modelPlane;
    otlp = otlpConfig
      ? await startModelCallExport(otlpConfig, {
          resolveSecret: (ref) => secrets.resolve(ref, environment),
          serviceVersion: build.version,
          providerPreset: async (id) => (await plane.getProvider(id))?.preset,
          log: gatewayLog,
        })
      : undefined;
    const exporter = otlp;
    // Subscription accounts (ADR-P09): one token keeper shared by the gateway
    // and the API, so each account renews at most once at a time.
    const siwcClient = new SiwcClient({
      ...(options.siwc ? { issuer: options.siwc.issuer } : {}),
    });
    const siwcTokens = new SiwcTokens({
      client: siwcClient,
      read: (ref) => secrets.resolve(ref, environment),
      write: (ref, value) => secrets.rotate(ref, value),
      clock: Date.now,
      log: gatewayLog,
    });
    // Copilot accounts: a host per account drives the user's Copilot CLI
    // with the Copilot SDK add-on; the gateway's bridge owns the sessions.
    copilotHosts = new CopilotHosts({
      launcher,
      secrets,
      environment,
      paths: {
        addon:
          options.copilot?.addon ?? path.join(dataDir, "addons", "copilot-sdk"),
        directory: path.join(dataDir, "subscriptions", "copilot"),
        ...(options.copilot
          ? { cli: options.copilot.cli, npm: options.copilot.npm }
          : {}),
      },
      clock: Date.now,
      log: gatewayLog,
    });
    subscriptions = new SubscriptionService({
      store: modelPlane,
      secrets,
      environment,
      client: siwcClient,
      tokens: siwcTokens,
      directory: path.join(dataDir, "subscriptions"),
      responsesBase: options.siwc?.responsesBase ?? SIWC.resource,
      copilot: copilotHosts,
      serialize: serializeWrites,
      clock: Date.now,
      log: gatewayLog,
    });
    // LAN sharing (03 section 1): settings now, the LAN listener once the
    // daemon's own listener is bound.
    const share = new GatewayShare({
      dataDir,
      handle: (request, response) => modelGateway?.lan(request, response),
      headersTimeoutMs: gatewayLimits.requestHeadersTimeoutMs,
      daemonPort: () => {
        const address = server?.server.address();
        return address && typeof address === "object"
          ? address.port
          : undefined;
      },
      log: gatewayLog,
    });
    shareToClose = share;
    await share.load();
    // Redaction, vision and search settings (Magpie parity §11).
    const gatewayFeatures = new GatewayFeaturesFile({ dataDir, secrets });
    await gatewayFeatures.load();
    const gatewaySearch = () =>
      (gatewayFeatures.current().search?.backends.length ?? 0) > 0;
    const adminToken = await readAdminToken(dataDir);
    // The shared model gateway on this listener (03-model-plane); it reads
    // providers, keys and the ledger from the store and resolves credentials
    // per upstream attempt. With OTLP export, each committed ledger entry
    // is also queued as a span.
    modelGateway = createGatewayHandler({
      store: exporter
        ? exportCommittedCalls(modelPlane, (entry) => exporter.record(entry))
        : modelPlane,
      resolveSecret: (ref) => secrets.resolve(ref, environment),
      clock: Date.now,
      limits: gatewayLimits,
      log: gatewayLog,
      sessions,
      access: () => share.access(),
      subscriptions: siwcTokens,
      copilot: copilotHosts,
      allowances: allowanceFile(dataDir),
      features: () => gatewayFeatures.current(),
      ...(adminToken ? { secrets: [adminToken] } : {}),
      // ChatGPT-mode Codex lists the gateway's models as wiring writes them.
      codexCatalog: (models, first) => codexWiringCatalog(models, first).models,
    });
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
    runStore = observedStore;
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
      models: sessions,
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
    server = await createGateway(app, {
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
      modelGateway: {
        handle: modelGateway,
        headersTimeoutMs: gatewayLimits.requestHeadersTimeoutMs,
      },
    });
    // Before the stores close (onClose): stop new model calls, abort the
    // upstream requests in flight and wait for their ledger entries.
    // Then the spans of the last ledger entries are exported within the
    // exporter's shutdown deadline.
    const gatewayToClose = modelGateway;
    const copilotToClose = copilotHosts;
    server.addHook("preClose", async () => {
      await gatewayToClose.close();
      // The bridge closed its sessions; the hosts and their CLIs stop.
      await copilotToClose.close();
      await exporter?.shutdown();
      await share.close();
    });
    // Before the store closes: a running refresh may still update providers.
    const catalogToClose = catalog;
    server.addHook("preClose", async () => catalogToClose.close());
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
    // Global wiring: catalog changes committed to the store reach the
    // agents' model lists; a sync in progress finishes before the store closes.
    const agents = new AgentWiringService({
      store: modelPlane,
      dataDir,
      home: options.wiringHome,
      origin: () => gatewayOrigin,
      gatewaySearch,
      settings: wiringSettings,
      log: gatewayLog,
    });
    modelPlane.catalogChanged = () => agents.catalogChanged();
    // Codex keeps its hosted web search only while the gateway can answer
    // it, so wired agents follow search backends coming and going.
    let searching = gatewaySearch();
    gatewayFeatures.changed = () => {
      if (gatewaySearch() === searching) return;
      searching = !searching;
      agents.catalogChanged();
    };
    server.addHook("preClose", async () => agents.close());
    const library = new LibraryService({
      dataDir,
      configDir,
      providers: modelPlane,
      secrets,
      environment,
      adminTokenDigest,
      home: options.wiringHome,
      log: gatewayLog,
    });
    // Backups and sync (off until configured); a sync in flight is aborted
    // and awaited before the stores close.
    const backups = new BackupService({
      store: modelPlane,
      secrets,
      environment,
      agents,
      share,
      library,
      // As configured: HH_OFFLINE is this process's environment, not a setting.
      catalog: {
        autoRefresh: options.catalog?.autoRefresh !== false,
        url: catalogSettings.url,
      },
      app: `HarnessHub ${build.version}`,
    });
    const sync = new SyncService({
      dataDir,
      backups,
      secrets,
      environment,
      log: gatewayLog,
    });
    syncToClose = sync;
    await sync.load();
    server.addHook("preClose", async () => sync.close());
    const doctor = new ProviderDoctor({
      store: modelPlane,
      resolveSecret: (ref) => secrets.resolve(ref, environment),
      log: gatewayLog,
    });
    // Before the stores close: stop doctor runs and wait for their ledger entries.
    server.addHook("preClose", async () => doctor.close());
    registerApiV1(server, {
      doctor,
      adminTokenDigest,
      consoleSessions,
      modelPlane,
      secrets,
      presets: {
        list: listPresets,
        get: getPreset,
        magpie: resolveMagpiePreset,
      },
      catalog,
      environment,
      system: () => ({
        apiVersion: "v1",
        version: build.version,
        commit: build.commit,
        pid: process.pid,
        startedAt,
        dataDir,
        secretBackend: secrets.backend,
        gateway: gatewayOrigin
          ? {
              openaiBaseUrl: `${gatewayOrigin}/v1`,
              anthropicBaseUrl: gatewayOrigin,
              geminiBaseUrl: gatewayOrigin,
            }
          : null,
      }),
      log: gatewayLog,
      ...(options.wiringHome ? { importHome: options.wiringHome } : {}),
      agents,
      library,
      gatewayShare: share,
      gatewayFeatures,
      routing: { state: () => modelGateway?.routingState() ?? [] },
      keyLimits: {
        limit: async (keyId) => {
          if (!modelGateway)
            throw new HubError(
              "GATEWAY_UNAVAILABLE",
              "The model gateway is not running",
              503,
            );
          return modelGateway.keyLimit(keyId);
        },
      },
      backup: { backups, sync },
      ...(subscriptions ? { subscriptions } : {}),
      serialize: serializeWrites,
    });
    // Registered after createGateway's hook, so the application has already cancelled
    // Runs; this only stops a pending model test and waits for its Session cleanup.
    server.addHook("preClose", async () => harnessModel.close());
    registerConsole(server, consoleBundle);
    server.addHook("onClose", async () => {
      for (const abort of activeProbes) abort.abort();
      await Promise.allSettled([...probeTasks]);
    });
    server.addHook("onClose", async () => {
      await subscriptions?.close();
      workflowStore?.close();
      modelPlane?.close();
      store.close();
    });
    // onClose hooks run last-registered first: before the stores close,
    // the keys of Sessions still open are revoked.
    server.addHook("onClose", async () => sessions.revokeAll());
    // Fastify runs onClose hooks last-registered first, so this marks the start of
    // shutdown; Worker exits recorded by the host afterwards still reach the file.
    server.addHook("onClose", async () => {
      gatewayLog.info("gateway.stop", { pid: process.pid });
    });
    const url = await server.listen({
      host: bindHost,
      port: options.port,
    });
    // The gateway accepts loopback clients only, whatever address is bound.
    const bound = server.server.address();
    if (bound && typeof bound === "object")
      gatewayOrigin = `http://127.0.0.1:${bound.port}`;
    await share.listen();
    sync.start();
    gatewayLog.info("gateway.listen", {
      url,
      host: bindHost,
      remoteHosts: !["localhost", "127.0.0.1", "::1", "[::1]"].includes(
        bindHost,
      ),
      fullAccess: runtimeInfo.fullAccess,
      console: consoleBundle?.directory ?? null,
      adminToken: path.join(dataDir, ADMIN_TOKEN_FILE),
      modelGateway: gatewayOrigin ?? null,
      maxConcurrency: config.maxConcurrency,
      defaultTimeoutMs: config.defaultTimeoutMs,
    });
    catalog.start();
    const origin = gatewayOrigin;
    return {
      server,
      app,
      url,
      logFile: gatewayLog.file,
      /** Whether the built console was found and is served at `/`. */
      consoleBuilt: consoleBundle !== undefined,
      /**
       * A new one-time console sign-in URL on this daemon's loopback origin,
       * valid once for 60 s (`/#login=<code>`, 07-data-security 5.2).
       */
      consoleLink: () =>
        `${origin ?? url}/#login=${consoleSessions.createLink().code}`,
    };
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
    await modelGateway?.close();
    await copilotHosts?.close();
    await catalog?.close();
    await otlp?.shutdown();
    await shareToClose?.close();
    await syncToClose?.close();
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
      host: { type: "string" },
      port: { type: "string" },
      "data-dir": { type: "string" },
      "config-dir": { type: "string" },
      "secrets-backend": { type: "string" },
      "tool-package-root": { type: "string" },
      "harness-model-file": { type: "string" },
      "otlp-config": { type: "string" },
      "wiring-home": { type: "string" },
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
  } else if (values.help)
    console.log(
      "HarnessHub: node dist/src/main.js [--engine opencode] [--host 127.0.0.1] [--port 3180] [--config engines/local.yaml] [--data-dir ./data] [--config-dir DIR] [--secrets-backend auto|keychain|dpapi|file] [--tool-package-root DIR] [--harness-model-file FILE] [--otlp-config FILE] [--wiring-home DIR] | --version [--json]\nFlags override <config-dir>/config.jsonc (hh config show).",
    );
  else {
    // Flags, then documented variables, then <configDir>/config.jsonc, then
    // defaults (config-file.ts); --otlp-config passes its file's text.
    const configDir = path.resolve(values["config-dir"] ?? defaultConfigDir());
    let config: ResolvedConfig;
    try {
      config = resolveConfig({
        config: await readConfigFile(configDir),
        env: process.env,
        flags: {
          "--host": values.host,
          "--port": values.port,
          "--data-dir": values["data-dir"],
          "--config": values.config,
          "--engine": values.engine,
          "--secrets-backend": values["secrets-backend"],
          "--tool-package-root": values["tool-package-root"],
          "--harness-model-file": values["harness-model-file"],
          "--wiring-home": values["wiring-home"],
          "--otlp-config":
            values["otlp-config"] === undefined
              ? undefined
              : await readFile(values["otlp-config"], "utf8"),
        },
        cwd: process.cwd(),
      });
    } catch (error) {
      if (!(error instanceof HubError) || !error.code.startsWith("CONFIG_"))
        throw error;
      console.error(`${error.code}: ${error.message}`);
      process.exitCode = 2;
      return;
    }
    const settings = startOptions(config);
    const { wiringHome, ...rest } = settings;
    const hub = await startHub({
      ...rest,
      configDir,
      demo: values.demo,
      cwd: process.cwd(),
      // Global wiring edits the agents of this account. wiring.home points
      // it at another directory and then ignores the shell's agent directory
      // variables (CODEX_HOME, ...), which name directories of the real home.
      wiringHome: wiringHome
        ? {
            home: wiringHome,
            env: {
              PATH: process.env.PATH,
              PATHEXT: process.env.PATHEXT,
            },
          }
        : { home: homedir(), env: Object.freeze({ ...process.env }) },
      logEcho: true,
    });
    const selectedEngine = settings.defaultEngine;
    const configured = config.entries.filter(
      (entry) => entry.source.kind !== "default",
    );
    process.stderr.write(
      `Config: ${config.file}${
        configured.length
          ? ` (${configured
              .map(
                (entry) => `${entry.path} from ${formatSource(entry.source)}`,
              )
              .join(", ")})`
          : " (defaults)"
      }\n`,
    );
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
    // For the person at the terminal (stderr, like the log echo); the code
    // never enters the log file.
    process.stderr.write(
      hub.consoleBuilt
        ? `Console: ${hub.consoleLink()}\n  (sign-in link, valid once for 60 s; run hh console for a new one)\n`
        : "Console: not built; run pnpm build:console and restart\n",
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
