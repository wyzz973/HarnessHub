import { createHash } from "node:crypto";
import { SessionError, type SelectionRequest, type SessionConfiguration } from "../contracts/session.js";
import type { NativeExtensions, NativeModelCatalog, NativeSessionPage } from "../contracts/control.js";
import type { DirectorySessionBindingFactory } from "../infrastructure/session/binding-factory.js";
import type { NativeCatalogCache, NativeReadiness } from "./native-catalog-cache.js";

/** A missing sign-in or setup, as each native interface reports it during a catalog read. */
const SIGNED_OUT = new Set(["GATEWAY_AUTH_REQUIRED", "HARNESS_AUTH_REQUIRED", "NATIVE_AUTH_REQUIRED"]);
/** Failures of the Hub itself or of this request rather than of the Harness; they say nothing about its readiness. */
const NOT_READINESS = /CLEANUP|OWNER_LOST|OWNERSHIP_LOST|STORAGE|^CANCELLED$|^MODEL_LIMIT$|^RUNTIME_CLOSED$|^HARNESS_BUSY$|^INVALID_INPUT$/u;
/** Longest wait for one native catalog read. */
const CATALOG_READ_MS = 20000;

/**
 * Owns native catalog reads and their observations; shutdown awaits every read and the cache's last write. A catalog read
 * under an unchanged installation and configuration fingerprint is reused for up to a day across restarts, so choosing a
 * Harness does not start it (or open a native session) every time; refresh always reads again.
 */
export class HarnessModels {
  private stopping = false;
  private cleanupFailure: unknown = null;
  private readonly active = new Map<string, { readonly abort: AbortController; readonly promise: Promise<NativeModelCatalog> }>();
  private readonly listing = new Map<string, { readonly abort: AbortController; readonly promise: Promise<NativeExtensions | null | NativeSessionPage> }>();
  constructor(private readonly factory: DirectorySessionBindingFactory, private readonly cache: NativeCatalogCache) {}
  read(selection: SelectionRequest, configuration: SessionConfiguration, refresh = false): Promise<NativeModelCatalog> {
    if (this.stopping) return Promise.reject(new SessionError("RUNTIME_CLOSED", "native model reader is stopping"));
    const request = JSON.stringify({ selection, configuration }), existing = this.active.get(request);
    if (existing) return existing.promise;
    if (this.active.size >= 8) return Promise.reject(new SessionError("MODEL_LIMIT", "too many native model discoveries"));
    const abort = new AbortController(), timeout = setTimeout(() => abort.abort(), CATALOG_READ_MS);
    const key = createHash("sha256").update(request).digest("hex");
    let controlId: string | null = null;
    const promise = (async () => {
      const identity = await this.factory.catalogFingerprint(selection, configuration);
      controlId = identity.controlId;
      if (this.stopping || abort.signal.aborted) throw new SessionError("CANCELLED", "native catalog read cancelled");
      const cached = refresh ? null : this.cache.catalog(key, identity.fingerprint);
      if (cached) return cached;
      const value = await this.factory.discoverModels(selection, configuration, abort.signal, id => this.cache.recordProbeSession(selection.harnessId, identity.controlId, id));
      if (this.stopping || abort.signal.aborted) return value;
      if (value.authentication === "missing") { this.cache.dropCatalog(key); this.cache.observe({ harnessId: selection.harnessId, controlId: identity.controlId, state: "signed_out" }); return value; }
      this.cache.observe({ harnessId: selection.harnessId, controlId: identity.controlId, state: "ready", signedIn: value.authentication === "ready" ? true : null });
      if (value.models.length) this.cache.putCatalog({ key, fingerprint: identity.fingerprint, harnessId: selection.harnessId, controlId: identity.controlId, catalog: value });
      return value;
    })().catch((error: unknown) => {
      const code = error !== null && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (/CLEANUP|OWNER_LOST|OWNERSHIP_LOST|STORAGE/u.test(code)) { this.cleanupFailure ??= error; this.stopping = true; }
      // A read cut off by its own deadline is the Harness not answering; one cut off by shutdown is not about the Harness.
      const timedOut = abort.signal.aborted && !this.stopping;
      if (controlId !== null && (timedOut || code && !NOT_READINESS.test(code))) {
        this.cache.dropCatalog(key);
        this.cache.observe(SIGNED_OUT.has(code) ? { harnessId: selection.harnessId, controlId, state: "signed_out" }
          : { harnessId: selection.harnessId, controlId, state: "failed", failureCode: timedOut ? "NATIVE_CATALOG_TIMEOUT" : /^[A-Z][A-Z0-9_]{0,63}$/u.test(code) ? code : "MODEL_DISCOVERY_FAILED" });
      }
      throw error;
    }).finally(() => { clearTimeout(timeout); this.active.delete(request); });
    this.active.set(request, { abort, promise }); return promise;
  }
  /** Native skills/MCP/plugins, read on demand (listing can contact MCP servers); not cached, bounded by the same probe limits. */
  extensions(selection: SelectionRequest, configuration: SessionConfiguration): Promise<NativeExtensions | null> {
    return this.list("extensions", selection, configuration, signal => this.factory.discoverExtensions(selection, configuration, signal));
  }
  /** The installed Harness's own sessions of the workspace, read on demand like extensions; null when it cannot list them. */
  sessions(selection: SelectionRequest, configuration: SessionConfiguration, cursor?: string): Promise<NativeSessionPage | null> {
    return this.list("sessions:" + (cursor ?? ""), selection, configuration, signal => this.factory.listNativeSessions(selection, configuration, signal, cursor));
  }
  /** Native sessions that catalog reads of this entry opened; the session list leaves them out unless asked. */
  probeSessions(harnessId: string, controlId: string): ReadonlySet<string> { return this.cache.probeSessions(harnessId, controlId); }
  /** Each entry's latest catalog read, most recent first. */
  readiness(): readonly NativeReadiness[] { return this.cache.readinessList(); }
  /** The display name the catalogs read so far give a native model of a Harness (the name the message box's picker shows); null when none has been read. Never reads a catalog. */
  modelName(harnessId: string, nativeModel: string): string | null { return this.cache.modelNames().get(harnessId + "\n" + nativeModel) ?? null; }
  private list<T extends NativeExtensions | null | NativeSessionPage>(kind: string, selection: SelectionRequest, configuration: SessionConfiguration, read: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.stopping) return Promise.reject(new SessionError("RUNTIME_CLOSED", "native model reader is stopping"));
    const key = JSON.stringify({ kind, selection, configuration }), existing = this.listing.get(key);
    if (existing) return existing.promise as Promise<T>;
    if (this.active.size + this.listing.size >= 8) return Promise.reject(new SessionError("MODEL_LIMIT", "too many native model discoveries"));
    const abort = new AbortController(), timeout = setTimeout(() => abort.abort(), 30000);
    const promise = read(abort.signal).catch((error: unknown) => {
      const code = error !== null && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (/CLEANUP|OWNER_LOST|OWNERSHIP_LOST|STORAGE/u.test(code)) { this.cleanupFailure ??= error; this.stopping = true; }
      throw error;
    }).finally(() => { clearTimeout(timeout); this.listing.delete(key); });
    this.listing.set(key, { abort, promise }); return promise;
  }
  async close(): Promise<void> {
    this.stopping = true;
    const active = [...this.active.values(), ...this.listing.values()]; active.forEach(item => item.abort.abort());
    await Promise.allSettled(active.map(item => item.promise));
    await this.cache.close();
    if (this.cleanupFailure !== null) throw this.cleanupFailure;
  }
}
