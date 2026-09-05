import { fork, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  WorkerLeaseStore,
  recoverWorkerLease,
  type WorkerLease,
} from "./leases.js";
import { settleWorkerCleanup } from "./cleanup-settlement.js";
import type {
  ExecutionHandle,
  ExecutionSpec,
  WorkerHost,
  WorkerMessage,
} from "../domain/ports.js";
import type {
  CleanupStatus,
  DriverResult,
  SessionId,
} from "../domain/types.js";
import { HubError } from "../domain/errors.js";
import {
  assertMessageSize,
  matchesIdentity,
  parseWorkerMessage,
  type HostCommand,
} from "../domain/ipc.js";

function deferred<T>() {
  const result = Promise.withResolvers<T>();
  // Ownership begins before the caller receives the handle, including handshake failures.
  void result.promise.catch(() => undefined);
  return result;
}
interface ActiveRun {
  spec: ExecutionSpec;
  sink: (message: WorkerMessage) => Promise<void>;
  result: ReturnType<typeof deferred<DriverResult>>;
  seq: number;
  processing: boolean;
}
interface SessionWorker {
  child: ChildProcess;
  ready: ReturnType<typeof deferred<void>>;
  exited: ReturnType<typeof deferred<void>>;
  hasExited: boolean;
  readySeen: boolean;
  failed: boolean;
  active?: ActiveRun;
  closing?: Promise<CleanupStatus>;
  anchor: string;
  ownerToken: string;
  workerPath: string;
  lease?: WorkerLease;
}

/** Owns detached Workers. POSIX escalation targets only groups created by this instance. */
export class ProcessWorkerHost implements WorkerHost {
  private readonly sessions = new Map<SessionId, SessionWorker>();
  private readonly quarantinedLeases = new Set<SessionId>();
  private readonly handshakeTimeoutMs: number;
  private readonly shutdownGraceMs: number;
  private readonly maxWorkers: number;
  private readonly parentEnv: Readonly<NodeJS.ProcessEnv>;
  private readonly explicitEnv: Readonly<Record<string, string>>;
  private readonly leases: WorkerLeaseStore | undefined;
  private closing = false;

  constructor(
    options: {
      handshakeTimeoutMs?: number;
      shutdownGraceMs?: number;
      maxWorkers?: number;
      env?: Record<string, string>;
      leaseDir?: string;
    } = {},
  ) {
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 10_000;
    this.shutdownGraceMs = options.shutdownGraceMs ?? 1_500;
    this.maxWorkers = options.maxWorkers ?? 16;
    if (!Number.isSafeInteger(this.maxWorkers) || this.maxWorkers < 1)
      throw new Error("maxWorkers must be a positive integer");
    for (const value of [this.handshakeTimeoutMs, this.shutdownGraceMs]) {
      if (!Number.isSafeInteger(value) || value < 1)
        throw new Error(
          "Worker timeouts must be positive integer milliseconds",
        );
    }
    this.parentEnv = Object.freeze({ ...process.env });
    this.explicitEnv = Object.freeze({ ...options.env });
    this.leases = options.leaseDir
      ? new WorkerLeaseStore(options.leaseDir)
      : undefined;
  }

  async start(
    spec: ExecutionSpec,
    sink: (message: WorkerMessage) => Promise<void>,
  ): Promise<ExecutionHandle> {
    if (this.closing)
      throw new HubError("HOST_CLOSED", "Worker host is closing", 503);
    if (this.quarantinedLeases.has(spec.sessionId))
      throw new HubError(
        "WORKER_QUARANTINED",
        "A prior Worker remains unconfirmed for this session",
        503,
      );
    assertMessageSize({ version: 1, type: "run", spec });
    const anchor = JSON.stringify([
      spec.sessionId,
      spec.profile,
      spec.cwd,
      spec.stateDir,
    ]);
    let worker = this.sessions.get(spec.sessionId);
    if (!worker) {
      if (
        new Set([...this.sessions.keys(), ...this.quarantinedLeases]).size >=
        this.maxWorkers
      )
        throw new HubError(
          "WORKER_CAPACITY",
          "Resident Worker limit reached; close an idle session before creating another Worker",
          429,
        );
      worker = this.createWorker(spec, anchor);
      this.sessions.set(spec.sessionId, worker);
      try {
        if (this.leases) {
          if (worker.child.pid === undefined)
            throw new HubError(
              "WORKER_SPAWN_FAILED",
              "Worker could not be started",
              503,
            );
          worker.lease = this.leases.save({
            sessionId: spec.sessionId,
            pid: worker.child.pid,
            ownerToken: worker.ownerToken,
            workerPath: worker.workerPath,
          });
        }
      } catch (error) {
        this.fail(worker, error);
        await this.closeSession(spec.sessionId);
        throw error;
      }
    }
    if (worker.closing || worker.failed || worker.active)
      throw new HubError("WORKER_BUSY", "Session Worker is unavailable", 409);
    if (worker.anchor !== anchor)
      throw new HubError(
        "SESSION_BINDING_CHANGED",
        "Session engine binding cannot change",
        409,
      );
    const owned = worker;
    const active: ActiveRun = {
      spec,
      sink,
      result: deferred<DriverResult>(),
      seq: 0,
      processing: false,
    };
    owned.active = active;
    try {
      await owned.ready.promise;
      if (owned.closing || owned.failed || this.closing)
        throw new HubError(
          "WORKER_CLOSED",
          "Session Worker closed during startup",
          503,
        );
      await this.send(owned, { version: 1, type: "run", spec });
    } catch (error) {
      this.fail(owned, error);
      await this.closeSession(spec.sessionId);
      throw error;
    }
    return {
      result: active.result.promise,
      cancel: async () => {
        if (owned.active !== active || owned.closing || owned.hasExited) return;
        await this.send(owned, {
          version: 1,
          type: "cancel",
          sessionId: spec.sessionId,
          runId: spec.runId,
          generation: spec.generation,
        });
      },
      respondPermission: async (permissionId, optionId) => {
        if (owned.active !== active || owned.closing || owned.hasExited)
          throw new HubError(
            "EXECUTION_ENDED",
            "Permission execution is no longer active",
            409,
          );
        await this.send(owned, {
          version: 1,
          type: "permission",
          sessionId: spec.sessionId,
          runId: spec.runId,
          generation: spec.generation,
          permissionId,
          optionId,
        });
      },
    };
  }

  private createWorker(spec: ExecutionSpec, anchor: string): SessionWorker {
    const workerPath = fileURLToPath(
      new URL("../worker/main.js", import.meta.url),
    );
    const ownerToken = randomUUID();
    const child = fork(workerPath, [`--harnesshub-owner=${ownerToken}`], {
      cwd: spec.cwd,
      env: this.workerEnvironment(spec),
      detached: process.platform !== "win32",
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      serialization: "json",
      execArgv: [],
    });
    const worker: SessionWorker = {
      child,
      ready: deferred<void>(),
      exited: deferred<void>(),
      hasExited: false,
      readySeen: false,
      failed: false,
      anchor,
      ownerToken,
      workerPath,
    };
    const handshake = setTimeout(
      () =>
        this.fail(
          worker,
          new HubError(
            "WORKER_HANDSHAKE_TIMEOUT",
            "Worker did not become ready",
            503,
          ),
        ),
      this.handshakeTimeoutMs,
    );
    void worker.ready.promise
      .finally(() => clearTimeout(handshake))
      .catch(() => undefined);
    child.on("message", (raw: unknown) => {
      try {
        const message = parseWorkerMessage(raw);
        if (message.type === "ready") {
          if (
            message.pid !== child.pid ||
            worker.readySeen ||
            worker.active?.seq !== 0
          )
            throw new Error("Invalid Worker ready identity");
          worker.readySeen = true;
          worker.ready.resolve();
          return;
        }
        const active = worker.active;
        if (
          !active ||
          worker.failed ||
          !matchesIdentity(message, active.spec) ||
          message.seq !== active.seq + 1 ||
          active.processing
        ) {
          throw new Error("Stale, unordered, or unacknowledged Worker IPC");
        }
        active.processing = true;
        active.seq = message.seq;
        void (async () => {
          await active.sink(message);
          await this.send(worker, {
            version: 1,
            type: "ack",
            sessionId: message.sessionId,
            runId: message.runId,
            generation: message.generation,
            seq: message.seq,
          });
          active.processing = false;
          if (message.type === "result") {
            delete worker.active;
            active.result.resolve(message.result);
          }
        })().catch((error: unknown) => this.fail(worker, error));
      } catch (error) {
        this.fail(worker, error);
      }
    });
    child.once("error", (error) => {
      this.fail(worker, error);
      // Spawn failures have no PID and therefore no exit event.
      if (child.pid === undefined) {
        worker.hasExited = true;
        worker.exited.resolve();
      }
    });
    child.once("exit", () => {
      worker.hasExited = true;
      worker.exited.resolve();
      worker.ready.reject(
        new HubError("WORKER_EXIT", "Worker exited before becoming ready", 503),
      );
      worker.active?.result.reject(
        new HubError(
          "WORKER_EXIT",
          "Worker exited before execution settled",
          503,
        ),
      );
      delete worker.active;
    });
    child.once("disconnect", () => {
      if (!worker.closing && !worker.hasExited)
        this.fail(
          worker,
          new HubError("WORKER_DISCONNECTED", "Worker IPC disconnected", 503),
        );
    });
    return worker;
  }

  private workerEnvironment(spec: ExecutionSpec): NodeJS.ProcessEnv {
    const normalize = (name: string) =>
      process.platform === "win32" ? name.toUpperCase() : name;
    const inherited = new Map(
      Object.entries(this.parentEnv).map(([name, value]) => [
        normalize(name),
        value,
      ]),
    );
    const env: NodeJS.ProcessEnv = {};
    const systemNames = [
      "PATH",
      "PATHEXT",
      "SYSTEMROOT",
      "WINDIR",
      "COMSPEC",
      "SYSTEMDRIVE",
      "PROCESSOR_ARCHITECTURE",
      "NUMBER_OF_PROCESSORS",
      "OS",
      "LANG",
      "LC_ALL",
      "LC_CTYPE",
      "TZ",
      "TERM",
      "COLORTERM",
      "NO_COLOR",
      "FORCE_COLOR",
      "USER",
      "USERNAME",
      "LOGNAME",
    ];
    for (const name of [
      ...systemNames,
      ...(spec.profile.credentialEnv ?? []),
    ]) {
      const value = inherited.get(normalize(name));
      if (value !== undefined) env[normalize(name)] = value;
    }
    for (const [name, value] of Object.entries(this.explicitEnv))
      env[normalize(name)] = value;

    const stateDir = resolve(spec.stateDir);
    const home = join(stateDir, "home");
    const temporary = join(stateDir, "tmp");
    const privatePaths = {
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, "AppData", "Roaming"),
      LOCALAPPDATA: join(home, "AppData", "Local"),
      TMPDIR: temporary,
      TEMP: temporary,
      TMP: temporary,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_CACHE_HOME: join(home, ".cache"),
      XDG_DATA_HOME: join(home, ".local", "share"),
    };
    for (const directory of new Set([
      stateDir,
      ...Object.values(privatePaths),
    ])) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new HubError(
          "WORKER_PRIVATE_PATH_INVALID",
          "Worker private directory is not an owned ordinary directory",
          503,
        );
      if (process.platform !== "win32") chmodSync(directory, 0o700);
    }
    // Per-session paths win over explicit values so backend logs and temporary files stay local.
    return { ...env, ...privatePaths };
  }

  private fail(worker: SessionWorker, error: unknown): void {
    if (worker.failed) return;
    worker.failed = true;
    worker.ready.reject(error);
    worker.active?.result.reject(error);
    const entry = [...this.sessions.entries()].find(
      ([, value]) => value === worker,
    );
    if (entry) void this.closeSession(entry[0]).catch(() => undefined);
  }

  private send(worker: SessionWorker, command: HostCommand): Promise<void> {
    assertMessageSize(command);
    return new Promise((resolve, reject) => {
      if (!worker.child.connected) {
        reject(
          new HubError("WORKER_DISCONNECTED", "Worker IPC is unavailable", 503),
        );
        return;
      }
      worker.child.send(command, (error) =>
        error ? reject(error) : resolve(),
      );
    });
  }

  closeSession(id: SessionId): Promise<CleanupStatus> {
    const worker = this.sessions.get(id);
    if (!worker)
      return Promise.resolve(
        this.quarantinedLeases.has(id) ? "unconfirmed" : "confirmed",
      );
    if (worker.closing) return worker.closing;
    const settle = (cleanup: CleanupStatus, error?: unknown): CleanupStatus => {
      const outcome = settleWorkerCleanup(
        worker,
        cleanup,
        () => {
          if (worker.lease) this.leases?.remove(worker.lease);
        },
        error,
      );
      if (outcome === "confirmed" && this.sessions.get(id) === worker)
        this.sessions.delete(id);
      return outcome;
    };
    worker.closing = this.terminate(worker).then(
      (cleanup) => settle(cleanup),
      (error: unknown) => settle("failed", error),
    );
    return worker.closing;
  }

  /** Reconcile old ownership only after the composition root owns the Gateway lock. No runs restart. */
  async recover(): Promise<Map<SessionId, CleanupStatus>> {
    const statuses = new Map<SessionId, CleanupStatus>();
    if (!this.leases) return statuses;
    for (const entry of this.leases.readAll()) {
      if (!entry.lease) {
        statuses.set(entry.sessionId, "unconfirmed");
        this.quarantinedLeases.add(entry.sessionId);
        continue;
      }
      if (this.sessions.get(entry.sessionId)?.lease?.id === entry.lease.id)
        continue;
      let cleanup = await recoverWorkerLease(entry.lease, this.shutdownGraceMs);
      if (cleanup === "confirmed") {
        try {
          this.leases.remove(entry.lease);
        } catch {
          cleanup = "failed";
        }
      }
      statuses.set(entry.sessionId, cleanup);
      if (cleanup === "confirmed")
        this.quarantinedLeases.delete(entry.sessionId);
      else this.quarantinedLeases.add(entry.sessionId);
    }
    return statuses;
  }

  private async terminate(worker: SessionWorker): Promise<CleanupStatus> {
    if (worker.child.connected) {
      try {
        await this.send(worker, { version: 1, type: "shutdown" });
      } catch {
        /* Disconnect races with shutdown; process exit remains the cleanup authority. */
      }
    }
    const exitedGracefully = await this.waitExit(worker, this.shutdownGraceMs);
    if (process.platform === "win32") {
      // Direct child exit is not evidence that its descendants are gone.
      if (exitedGracefully) return "unconfirmed";
      const pid = worker.child.pid;
      if (pid === undefined) return "unconfirmed";
      await new Promise<void>((resolve) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        };
        const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
        killer.once("error", finish);
        killer.once("exit", finish);
        timer = setTimeout(() => {
          try {
            killer.kill("SIGKILL");
          } catch {
            /* Helper termination failure remains an unconfirmed cleanup result. */
          }
          killer.unref();
          finish();
        }, this.shutdownGraceMs);
      });
      // Native Windows descendant behavior still requires its own platform acceptance test.
      await this.waitExit(worker, this.shutdownGraceMs);
      return "unconfirmed";
    }
    if (exitedGracefully && !this.groupExists(worker)) return "confirmed";
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      const pid = worker.child.pid;
      if (pid === undefined) return "unconfirmed";
      try {
        process.kill(-pid, signal);
      } catch (error) {
        if (!(
          error instanceof Error &&
          "code" in error &&
          error.code === "ESRCH"
        ))
          return "failed";
      }
      if (await this.waitGroupExit(worker, this.shutdownGraceMs))
        return "confirmed";
    }
    return "unconfirmed";
  }

  private groupExists(worker: SessionWorker): boolean {
    if (worker.child.pid === undefined) return false;
    try {
      process.kill(-worker.child.pid, 0);
      return true;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH")
        return false;
      throw error;
    }
  }

  private async waitGroupExit(
    worker: SessionWorker,
    milliseconds: number,
  ): Promise<boolean> {
    const deadline = Date.now() + milliseconds;
    while (Date.now() < deadline) {
      if (worker.hasExited && !this.groupExists(worker)) return true;
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.min(20, Math.max(1, deadline - Date.now()))),
      );
    }
    return worker.hasExited && !this.groupExists(worker);
  }

  private async waitExit(
    worker: SessionWorker,
    milliseconds: number,
  ): Promise<boolean> {
    if (worker.hasExited) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), milliseconds);
    });
    try {
      return await Promise.race([
        worker.exited.promise.then(() => true),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    const cleanup = await Promise.all(
      [...this.sessions.keys()].map((id) => this.closeSession(id)),
    );
    if (cleanup.some((value) => value !== "confirmed"))
      throw new HubError(
        "WORKER_CLEANUP_FAILED",
        "One or more Workers did not confirm exit",
        503,
      );
  }
}
