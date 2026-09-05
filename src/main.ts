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
    const server = await createGateway(app, { workflows, observations });
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
