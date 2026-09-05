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
  ) {}
  isReady() {
    return this.runtime.isReady();
  }
  engines() {
    return this.runtime.listEngines().map((profile) => ({
      ...profile,
      capabilities: {
        configured: profile.capabilities,
        observed: this.runtime.engineEvidence(profile.id),
        validated: null,
      },
    }));
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
  close() {
    return this.runtime.close();
  }
}
