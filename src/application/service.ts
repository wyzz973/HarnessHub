import type { EngineManagement } from "../domain/engines.js";
import { HubError } from "../domain/errors.js";
import type { Runtime } from "../runtime/runtime.js";
import type {
  ArtifactId,
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
  createSession(input: { engineId?: string; workspaceId?: string }) {
    return this.runtime.createSession(input);
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
