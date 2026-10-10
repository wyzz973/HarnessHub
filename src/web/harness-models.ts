import { SessionError, type SelectionRequest, type SessionConfiguration } from "../contracts/session.js";
import type { NativeModelCatalog } from "../contracts/control.js";
import type { DirectorySessionBindingFactory } from "../infrastructure/session/binding-factory.js";

/** Owns all read-only probes; cancellation closes their processes before the Store may be released. */
export class HarnessModels {
  private stopping = false;
  private cleanupFailure: unknown = null;
  private readonly active = new Map<string, { readonly abort: AbortController; readonly promise: Promise<NativeModelCatalog> }>();
  constructor(private readonly factory: DirectorySessionBindingFactory) {}
  read(selection: SelectionRequest, configuration: SessionConfiguration): Promise<NativeModelCatalog> {
    if (this.stopping) return Promise.reject(new SessionError("RUNTIME_CLOSED", "native model reader is stopping"));
    const key = JSON.stringify({ selection, configuration });
    const existing = this.active.get(key); if (existing) return existing.promise;
    if (this.active.size >= 8) return Promise.reject(new SessionError("MODEL_LIMIT", "too many native model discoveries"));
    const abort = new AbortController(), timeout = setTimeout(() => abort.abort(), 20000);
    const promise = this.factory.discoverModels(selection, configuration, abort.signal).catch((error: unknown) => {
      const code = error !== null && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (/CLEANUP|OWNER_LOST|OWNERSHIP_LOST|STORAGE/gu.test(code)) { this.cleanupFailure ??= error; this.stopping = true; }
      throw error;
    }).finally(() => { clearTimeout(timeout); this.active.delete(key); });
    this.active.set(key, { abort, promise }); return promise;
  }
  async close(): Promise<void> {
    this.stopping = true;
    const active = [...this.active.values()]; active.forEach(item => item.abort.abort());
    await Promise.allSettled(active.map(item => item.promise));
    if (this.cleanupFailure !== null) throw this.cleanupFailure;
  }
}
