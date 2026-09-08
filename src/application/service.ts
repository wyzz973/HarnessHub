import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import type { EngineManagement } from "../domain/engines.js";
import { HubError } from "../domain/errors.js";
import type { Runtime } from "../runtime/runtime.js";
import type {
  ArtifactId,
  JsonObject,
  ArtifactRecord,
  PermissionId,
  RunId,
  RunInput,
  SessionId,
} from "../domain/types.js";

/** Shared application entry for HTTP, CLI and benchmark consumers. */
export class HubApplication {
  constructor(
    private readonly runtime: Runtime,
    private readonly artifactReader: (
      artifact: ArtifactRecord,
    ) => Promise<Buffer>,
    private readonly engineManagement?: EngineManagement,
  ) {}
  isReady() {
    return this.runtime.isReady();
  }
  defaultEngine() {
    return this.runtime.defaultEngine();
  }
  defaultWorkspace() {
    return this.runtime.defaultWorkspace();
  }
  workspaces() {
    return this.runtime.workspaces();
  }
  sessions() {
    return this.runtime.store.listSessions();
  }
  runs(sessionId?: SessionId) {
    return this.runtime.store.listRuns(sessionId);
  }
  engines() {
    return this.runtime.listEngines().map((profile) => ({
      ...profile,
      capabilities: {
        configured: profile.capabilities,
        observed: this.runtime.engineEvidence(profile.id, profile.revision),
        validated: null,
      },
    }));
  }
  private management(): EngineManagement {
    if (!this.engineManagement)
      throw new HubError(
        "ENGINE_MANAGEMENT_UNAVAILABLE",
        "Engine management is not configured",
        503,
      );
    return this.engineManagement;
  }
  registerEngine(input: unknown) {
    return this.management().register(input);
  }
  removeEngine(id: string) {
    return this.management().remove(id);
  }
  setDefaultEngine(id: string) {
    return this.management().setDefault(id);
  }
  discoverEngines() {
    return this.management().discover();
  }
  reloadEngines() {
    return this.management().reload();
  }
  engineRegistryStatus() {
    const m = this.management();
    return { ...m.status(), defaultEngine: m.defaultId() };
  }
  createSession(input: {
    engineId?: string;
    workspaceId?: string;
    routing?: JsonObject;
  }) {
    return this.runtime.createSession(input);
  }
  async createSessionAtDirectory(input: {
    directory: string;
    engineId?: string;
    routing?: JsonObject;
  }) {
    let directory: string;
    try {
      directory = await realpath(input.directory);
      if (!(await stat(directory)).isDirectory())
        throw new Error("not a directory");
    } catch {
      throw new HubError(
        "INVALID_DIRECTORY",
        "directory must reference an existing directory",
        400,
      );
    }
    const engineId = input.engineId ?? this.runtime.defaultEngine();
    const profile = this.runtime
      .listEngines()
      .find((engine) => engine.id === engineId && engine.enabled);
    if (!profile)
      throw new HubError(
        "ENGINE_UNAVAILABLE",
        `Engine ${engineId} is not enabled`,
        404,
      );
    const workspaceId = `directory-${createHash("sha256")
      .update(directory)
      .digest("hex")
      .slice(0, 20)}`;
    return this.runtime.store.createSession(
      profile,
      { id: workspaceId, path: directory },
      input.routing,
    );
  }
  getSession(id: SessionId) {
    return this.runtime.store.getSession(id);
  }
  submit(
    id: SessionId,
    input: Omit<RunInput, "timeoutMs"> & { timeoutMs?: number },
    key?: string,
  ) {
    return this.runtime.submit(id, input, key);
  }
  getRun(id: RunId) {
    return {
      ...this.runtime.store.getRun(id),
      permissions: this.runtime.store.listPermissions(id),
      artifacts: this.runtime.store
        .listArtifacts(id)
        .map(({ path: _path, ...artifact }) => artifact),
    };
  }
  events(id: RunId, afterSeq = 0, limit = 100) {
    return this.runtime.store.events(id, afterSeq, limit);
  }
  cancel(id: RunId) {
    return this.runtime.cancel(id);
  }
  decide(id: PermissionId, optionId: string) {
    return this.runtime.decide(id, optionId);
  }
  suspendSession(id: SessionId) {
    return this.runtime.suspendSession(id);
  }
  closeSession(id: SessionId) {
    return this.runtime.closeSession(id);
  }
  async artifact(id: ArtifactId) {
    const record = this.runtime.store.getArtifact(id);
    return { record, bytes: await this.artifactReader(record) };
  }
  /** Serializes committed events only; repeated exports contain the same event records. */
  *rollout(id: RunId): Generator<string> {
    this.runtime.store.getRun(id);
    let cursor = 0;
    for (;;) {
      const batch = this.events(id, cursor, 100);
      if (!batch.length) return;
      for (const event of batch) {
        yield `${JSON.stringify(event)}\n`;
        cursor = event.seq;
      }
    }
  }
  async close() {
    await this.engineManagement?.close();
    await this.runtime.close();
  }
}
