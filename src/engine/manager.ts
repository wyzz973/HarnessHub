import { watchFile, unwatchFile } from "node:fs";
import type {
  EngineCandidate,
  EngineCatalogPersistence,
  EngineManagement,
} from "../domain/engines.js";
import { HubError } from "../domain/errors.js";
import type { EngineProfile } from "../domain/types.js";
import { normalizeEngine, prepareEngine, type HubConfig } from "./registry.js";

interface CatalogState {
  revisions: Map<string, EngineProfile>;
  overrides: Map<string, EngineProfile | null>;
  defaultOverride: string | null;
}
const key = (id: string, revision: string) => `${id}:${revision}`;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HubError(
      "INVALID_ENGINE_CATALOG",
      "Stored engine catalog is invalid",
      500,
    );
  return value as Record<string, unknown>;
}
function storedProfile(value: unknown): EngineProfile {
  const raw = record(value);
  const { revision, capabilities: _capabilities, ...registration } = raw;
  const profile = normalizeEngine(registration);
  if (profile.revision !== revision)
    throw new HubError(
      "INVALID_ENGINE_CATALOG",
      "Stored engine revision does not match its contents",
      500,
    );
  return profile;
}
function loadState(raw: unknown): CatalogState {
  const empty: CatalogState = {
    revisions: new Map(),
    overrides: new Map(),
    defaultOverride: null,
  };
  if (raw === undefined) return empty;
  const value = record(raw);
  if (
    (value.version !== 1 && value.version !== 2) ||
    !Array.isArray(value.revisions) ||
    !Array.isArray(value.overrides) ||
    !(
      value.defaultOverride === null ||
      typeof value.defaultOverride === "string"
    )
  )
    throw new HubError(
      "INVALID_ENGINE_CATALOG",
      "Stored engine catalog version or shape is unsupported",
      500,
    );
  for (const rawProfile of value.revisions) {
    const p = storedProfile(rawProfile);
    empty.revisions.set(key(p.id, p.revision), p);
  }
  for (const rawEntry of value.overrides) {
    const entry = record(rawEntry);
    if (typeof entry.id !== "string")
      throw new HubError(
        "INVALID_ENGINE_CATALOG",
        "Stored engine override has no id",
        500,
      );
    const p = entry.profile === null ? null : storedProfile(entry.profile);
    if (p && (p.id !== entry.id || !empty.revisions.has(key(p.id, p.revision))))
      throw new HubError(
        "INVALID_ENGINE_CATALOG",
        "Stored engine override has no matching revision",
        500,
      );
    empty.overrides.set(entry.id, p);
  }
  empty.defaultOverride = value.defaultOverride;
  return empty;
}
function deployment(config: HubConfig): string {
  const { engines: _engines, defaultEngine: _defaultEngine, ...fixed } = config;
  return JSON.stringify(fixed);
}

/** Serialized management owns current revisions; every mutation commits before publication.
 * A failed file reload keeps the last valid catalog and exposes its error through status().
 */
export class EngineManager implements EngineManagement {
  private state: CatalogState;
  private config: HubConfig;
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private lastReloadAt: number | null = null;
  private lastError: string | null = null;
  private readonly watchListener = () => {
    void this.reload().catch(() => {
      // reload records its failure; the last committed catalog remains usable.
    });
  };
  constructor(
    private readonly options: {
      config: HubConfig;
      persistence: EngineCatalogPersistence;
      load: () => Promise<HubConfig>;
      discover: () => Promise<EngineCandidate[]>;
      configFile?: string;
      initialDefault?: string;
    },
  ) {
    this.config = options.config;
    this.state = loadState(options.persistence.readEngineCatalog());
    if (options.initialDefault) {
      this.resolve(options.initialDefault);
      this.state.defaultOverride = options.initialDefault;
    }
    this.publish(this.config, this.state);
    if (options.configFile)
      watchFile(
        options.configFile,
        { interval: 500, persistent: false },
        this.watchListener,
      );
  }
  private current(
    config = this.config,
    state = this.state,
  ): Map<string, EngineProfile> {
    const profiles = new Map(config.engines.map((p) => [p.id, p]));
    for (const [id, p] of state.overrides) {
      if (p) profiles.set(id, p);
      else profiles.delete(id);
    }
    return profiles;
  }
  list(): EngineProfile[] {
    return [...this.current().values()];
  }
  defaultId(): string {
    const id = this.state.defaultOverride ?? this.config.defaultEngine;
    if (id) return this.current().get(id)?.enabled ? id : "";
    return this.list().find((p) => p.enabled)?.id ?? "";
  }
  resolve(id: string, revision?: string): EngineProfile {
    const current = this.current().get(id);
    const p = revision
      ? current?.revision === revision
        ? current
        : this.state.revisions.get(key(id, revision))
      : current;
    if (!p || (!revision && !p.enabled))
      throw new HubError(
        "ENGINE_UNAVAILABLE",
        revision
          ? "Pinned engine revision is unavailable"
          : "Engine is not registered or enabled; discover/register an engine first",
        404,
      );
    return p;
  }
  private serialize<T>(action: () => Promise<T> | T): Promise<T> {
    if (this.closed)
      return Promise.reject(
        new HubError(
          "ENGINE_MANAGER_CLOSED",
          "Engine management is closed",
          503,
        ),
      );
    const pending = this.tail.then(action);
    this.tail = pending.catch(() => undefined);
    return pending;
  }
  private copy(): CatalogState {
    return {
      revisions: new Map(this.state.revisions),
      overrides: new Map(this.state.overrides),
      defaultOverride: this.state.defaultOverride,
    };
  }
  private publish(config: HubConfig, state: CatalogState): void {
    for (const p of this.current(config, state).values())
      if (p.driver !== "fake") state.revisions.set(key(p.id, p.revision), p);
    if (
      state.revisions.size > 10_000 ||
      this.current(config, state).size > 1000
    )
      throw new HubError(
        "ENGINE_CATALOG_FULL",
        "Engine catalog capacity reached",
        409,
      );
    this.options.persistence.writeEngineCatalog({
      version: 2,
      revisions: [...state.revisions.values()],
      overrides: [...state.overrides].map(([id, profile]) => ({ id, profile })),
      defaultOverride: state.defaultOverride,
    });
    this.state = state;
    this.config = config;
  }
  register(input: unknown): Promise<EngineProfile> {
    return this.serialize(async () => {
      const p = await prepareEngine(input);
      if (this.config.engines.some((e) => e.id === p.id && e.driver === "fake"))
        throw new HubError(
          "ENGINE_RESERVED",
          "The demo engine id is reserved",
          409,
        );
      const state = this.copy();
      state.overrides.set(p.id, p);
      this.publish(this.config, state);
      return p;
    });
  }
  remove(id: string): Promise<void> {
    return this.serialize(() => {
      const state = this.copy();
      if (this.current().get(id)?.driver === "fake")
        throw new HubError(
          "ENGINE_RESERVED",
          "The demo engine is controlled by --demo",
          409,
        );
      if (!this.current().has(id))
        throw new HubError(
          "ENGINE_UNAVAILABLE",
          "Engine is not registered",
          404,
        );
      state.overrides.set(id, null);
      this.publish(this.config, state);
    });
  }
  setDefault(id: string): Promise<void> {
    return this.serialize(() => {
      const p = this.resolve(id);
      if (p.driver === "fake")
        throw new HubError(
          "ENGINE_RESERVED",
          "Demo defaults are controlled by --demo",
          409,
        );
      const state = this.copy();
      state.defaultOverride = id;
      this.publish(this.config, state);
    });
  }
  discover(): Promise<EngineCandidate[]> {
    return this.options.discover();
  }
  reload(): Promise<{ engines: number; defaultEngine: string }> {
    return this.serialize(async () => {
      try {
        const config = await this.options.load();
        if (deployment(config) !== deployment(this.config))
          throw new HubError(
            "CONFIG_RESTART_REQUIRED",
            "Workspace and process limits require a restart; engine changes were not applied",
            409,
          );
        this.publish(config, this.copy());
        this.lastReloadAt = Date.now();
        this.lastError = null;
        return { engines: this.list().length, defaultEngine: this.defaultId() };
      } catch (error) {
        this.lastError =
          error instanceof HubError ? error.code : "CONFIG_READ_FAILED";
        throw error;
      }
    });
  }
  status() {
    return {
      watching: Boolean(this.options.configFile) && !this.closed,
      lastReloadAt: this.lastReloadAt,
      lastError: this.lastError,
    };
  }
  async close(): Promise<void> {
    this.closed = true;
    if (this.options.configFile)
      unwatchFile(this.options.configFile, this.watchListener);
    await this.tail;
  }
}
