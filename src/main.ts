import { EngineConfigurationService } from "./application/engine-configuration.js";
import { prepareEngine } from "./engine/registry.js";
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

/** Composition root: concrete implementations are assembled only here. */
export async function startHub(options: {
  dataDir: string;
  configFile?: string;
  demo: boolean;
  cwd: string;
  port: number;
  defaultEngine?: string;
  workspaces?: Workspace[];
}) {
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
  const config = await resolveConfig();
  const requestedDataDir = path.resolve(options.dataDir);
  await mkdir(requestedDataDir, { recursive: true, mode: 0o700 });
  const dataDir = await realpath(requestedDataDir);
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
  });
  let runtime: Runtime | undefined;
  let manager: EngineManager | undefined;
  let workflowStore: SqliteWorkflowStore | undefined;
  let workflows: WorkflowService | undefined;
  try {
    manager = new EngineManager({
      config,
      persistence: store,
      load: resolveConfig,
      ...(options.defaultEngine
        ? { initialDefault: options.defaultEngine }
        : {}),
      ...(options.configFile
        ? { configFile: path.resolve(options.configFile) }
        : {}),
      discover: () =>
        discoverEngines({
          cwd: options.cwd,
          home: homedir(),
          pathEnv: process.env.PATH ?? "",
          nodeExecutable: process.execPath,
        }),
    });
    const recoveredWorkers = await host.recover();
    runtime = new Runtime(store, host, {
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
      templates: () =>
        discoverEngines({
          cwd: options.cwd,
          home: homedir(),
          pathEnv: process.env.PATH ?? "",
          nodeExecutable: process.execPath,
          includeManifests: false,
        }),
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
          try {
            directory = await mkdtemp(
              path.join(dataDir, "configuration-test-"),
            );
            const prepared = await prepareConfiguration(
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
    const server = await createGateway(app, {
      workflows,
      observations,
      configuration,
    });
    server.addHook("onClose", async () => {
      for (const abort of activeProbes) abort.abort();
      await Promise.allSettled([...probeTasks]);
    });
    server.addHook("onClose", async () => {
      workflowStore?.close();
      store.close();
    });
    const url = await server.listen({ host: "127.0.0.1", port: options.port });
    return { server, app, url };
  } catch (error) {
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
      config: { type: "string" },
      port: { type: "string", default: "3180" },
      "data-dir": { type: "string", default: "./data" },
      help: { type: "boolean" },
    },
  });
  if (values.help)
    console.log(
      "HarnessHub: node dist/src/main.js [--demo] [--config engines/local.yaml] [--port 3180] [--data-dir ./data]",
    );
  else {
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535)
      throw new Error("Invalid port");
    const hub = await startHub({
      dataDir: values["data-dir"],
      demo: values.demo,
      port,
      cwd: process.cwd(),
      ...(values.config ? { configFile: values.config } : {}),
      ...(process.env.AGENT_ENGINE
        ? { defaultEngine: process.env.AGENT_ENGINE }
        : {}),
    });
    console.log(
      JSON.stringify({
        event: "ready",
        url: hub.url,
        demo: values.demo,
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
