import { SessionError, type SelectionRequest, type SessionConfiguration } from "../contracts/session.js";
import type { NativeModelCatalog } from "../contracts/control.js";
import type { DirectorySessionBindingFactory } from "../infrastructure/session/binding-factory.js";

/** Owns cache identity reads and native probes; shutdown awaits all of them before Store release. */
export class HarnessModels {
  private stopping = false;
  private cleanupFailure: unknown = null;
  private readonly cache = new Map<string, { value: NativeModelCatalog; fingerprint: string; expires: number }>();
  private readonly active = new Map<string, { readonly abort: AbortController; readonly promise: Promise<NativeModelCatalog> }>();
  constructor(private readonly factory: DirectorySessionBindingFactory) {}
  read(selection: SelectionRequest, configuration: SessionConfiguration, refresh = false): Promise<NativeModelCatalog> {
    if (this.stopping) return Promise.reject(new SessionError("RUNTIME_CLOSED", "native model reader is stopping"));
    const key = JSON.stringify({ selection, configuration }), existing = this.active.get(key);
    if (existing) return existing.promise;
    if (this.active.size >= 8) return Promise.reject(new SessionError("MODEL_LIMIT", "too many native model discoveries"));
    const abort = new AbortController(), timeout = setTimeout(() => abort.abort(), 20000);
    const promise = (async () => {
      const fingerprint = await this.factory.catalogFingerprint(selection, configuration);
      if (this.stopping || abort.signal.aborted) throw new SessionError("CANCELLED", "native catalog read cancelled");
      const cached = this.cache.get(key);
      if (!refresh && cached && cached.expires > Date.now() && cached.fingerprint === fingerprint) return cached.value;
      const value = await this.factory.discoverModels(selection, configuration, abort.signal);
      if (value.models.length && !this.stopping && !abort.signal.aborted) {
        if (this.cache.size >= 8) this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(key, { value, fingerprint, expires: Date.now() + 60000 });
      }
      return value;
    })().catch((error: unknown) => {
      const code = error !== null && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (/CLEANUP|OWNER_LOST|OWNERSHIP_LOST|STORAGE/u.test(code)) { this.cleanupFailure ??= error; this.stopping = true; }
      throw error;
    }).finally(() => { clearTimeout(timeout); this.active.delete(key); });
    this.active.set(key, { abort, promise }); return promise;
  }
  async close(): Promise<void> {
    this.stopping = true; this.cache.clear();
    const active = [...this.active.values()]; active.forEach(item => item.abort.abort());
    await Promise.allSettled(active.map(item => item.promise));
    if (this.cleanupFailure !== null) throw this.cleanupFailure;
  }
}
