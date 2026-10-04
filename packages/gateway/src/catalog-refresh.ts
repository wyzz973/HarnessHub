// SPDX-License-Identifier: MIT
/**
 * Refresh of the models.dev catalog (03-model-plane section 7, owner decision
 * of 2026-10-03): on by default, every 24 hours, and early (at most every 6
 * hours) after a served call whose model had no price. `catalog.autoRefresh:
 * false` or `HH_OFFLINE=1` turns the background refresh off; a manual refresh
 * still runs. Refreshed copies are kept beside the bundled snapshot, never
 * over it, and a failed refresh keeps the catalog in use.
 */
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { HubError } from "@harnesshub/core/errors";
import { NO_LOG, type LogSink } from "@harnesshub/core/logging";
import type {
  CatalogService,
  CatalogStatus,
  ModelCatalog,
} from "@harnesshub/core/model-metadata";
import type { ModelCallEntry } from "@harnesshub/core/model-plane";
import { parseCatalog, snapshotText } from "./catalog.js";
import { deadline } from "./http.js";

export const DEFAULT_CATALOG_URL = "https://models.dev/api.json";
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const EARLY_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;
/** The full document is about 5 MB; anything far larger is not a catalog. */
const MAX_DOCUMENT_BYTES = 64 * 1024 * 1024;
const DATA_FILE = "models-dev.json";
const STATE_FILE = "refresh.json";

export interface CatalogSettings {
  /** Background refresh (every 24 h, early after unpriced calls). */
  autoRefresh: boolean;
  /** Why background refresh is off. */
  disabledBy?: "setting" | "offline";
  /** Where the catalog is fetched from. */
  url: string;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const LOOPBACK = /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\])$/;

/**
 * Resolve `catalog.autoRefresh` (default true) and `catalog.url` (default
 * models.dev) with `HH_OFFLINE`: `1` turns background refresh off whatever the
 * setting, `0` or empty leaves it to the setting.
 *
 * @throws Error naming the setting: an unknown key, a non-boolean
 *   `autoRefresh`, a `url` that is not HTTPS (plain HTTP only on loopback) or
 *   carries credentials, or another `HH_OFFLINE` value.
 */
export function resolveCatalogSettings(
  input: unknown,
  environment: Readonly<Record<string, string | undefined>>,
): CatalogSettings {
  const settings = input ?? {};
  if (!object(settings)) throw new Error("catalog settings must be an object");
  for (const key of Object.keys(settings))
    if (key !== "autoRefresh" && key !== "url")
      throw new Error(`catalog.${key} is not a setting`);
  if (
    settings.autoRefresh !== undefined &&
    typeof settings.autoRefresh !== "boolean"
  )
    throw new Error("catalog.autoRefresh must be true or false");
  const url = settings.url ?? DEFAULT_CATALOG_URL;
  let parsed: URL | undefined;
  try {
    parsed = typeof url === "string" ? new URL(url) : undefined;
  } catch {
    parsed = undefined;
  }
  if (
    !parsed ||
    parsed.username ||
    parsed.password ||
    !(
      parsed.protocol === "https:" ||
      (parsed.protocol === "http:" && LOOPBACK.test(parsed.hostname))
    )
  )
    throw new Error(
      "catalog.url must be an HTTPS URL (HTTP only on loopback) without credentials",
    );
  const offline = environment.HH_OFFLINE ?? "";
  if (!["", "0", "1"].includes(offline))
    throw new Error("HH_OFFLINE must be 1 (offline), 0 or empty");
  const disabledBy =
    offline === "1"
      ? "offline"
      : settings.autoRefresh === false
        ? "setting"
        : undefined;
  return {
    autoRefresh: disabledBy === undefined,
    ...(disabledBy ? { disabledBy } : {}),
    url: parsed.href,
  };
}

/** Timers of the background refresh; injectable for tests. */
export interface RefreshTimers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const nodeTimers: RefreshTimers = {
  // Unreferenced: a pending refresh never keeps the process alive.
  set: (callback, ms) => setTimeout(callback, ms).unref(),
  clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export interface CatalogRefresherOptions {
  /** Where refreshed copies and the refresh state are kept (`<dataDir>/catalog`). */
  directory: string;
  settings: CatalogSettings;
  /** The bundled snapshot (`modelCatalog`). */
  bundled: () => ModelCatalog;
  fetch?: typeof fetch;
  /** Wall-clock milliseconds since the epoch. */
  now?: () => number;
  timers?: RefreshTimers;
  log?: LogSink;
}

type LastRefresh = NonNullable<CatalogStatus["lastRefresh"]>;

function isLastRefresh(value: unknown): value is LastRefresh {
  return (
    object(value) &&
    typeof value.at === "string" &&
    Number.isFinite(Date.parse(value.at)) &&
    ["updated", "unchanged", "failed"].includes(value.outcome as string) &&
    (value.error === undefined ||
      (typeof value.error === "string" && value.error.length <= 500))
  );
}

async function readOptional(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** The body, refusing more than `limit` bytes as declared or as read. */
async function readLimited(response: Response, limit: number) {
  if (Number(response.headers.get("content-length")) > limit)
    throw new Error(`the response is larger than ${limit} bytes`);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > limit)
      throw new Error(`the response is larger than ${limit} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * The catalog in use and its refresh. Open with {@link CatalogRefresher.open};
 * the owner calls {@link CatalogRefresher.start} once the daemon serves and
 * awaits {@link CatalogRefresher.close} before closing what its listeners use.
 * One fetch runs at a time; background, early and manual refreshes join it.
 * State: `<directory>/models-dev.json` (the last successful refresh, in the
 * snapshot format) and `<directory>/refresh.json` (the last attempt), each
 * replaced atomically. A refreshed copy is used only while it is newer than
 * the bundled snapshot.
 */
export class CatalogRefresher implements CatalogService {
  private readonly listeners: Array<() => Promise<void>> = [];
  private readonly abort = new AbortController();
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly timers: RefreshTimers;
  private readonly log: LogSink;
  private running: Promise<CatalogStatus> | undefined;
  private timer: unknown;
  private dueAt: number | undefined;
  private started = false;
  private closed = false;

  private constructor(
    private readonly options: CatalogRefresherOptions,
    private active: ModelCatalog,
    private source: CatalogStatus["source"],
    private last: LastRefresh | null,
  ) {
    this.fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? Date.now;
    this.timers = options.timers ?? nodeTimers;
    this.log = options.log ?? NO_LOG;
  }

  /**
   * Load the bundled snapshot and any stored refresh. An unreadable or
   * invalid stored copy is logged and ignored (the next refresh replaces it).
   *
   * @throws Error when the bundled snapshot is invalid, or a stored file
   *   exists but cannot be read.
   */
  static async open(options: CatalogRefresherOptions) {
    const log = options.log ?? NO_LOG;
    const bundled = options.bundled();
    let active = bundled;
    let source: CatalogStatus["source"] = "bundled";
    const file = path.join(options.directory, DATA_FILE);
    const stored = await readOptional(file);
    if (stored !== undefined)
      try {
        const catalog = parseCatalog(stored);
        if (
          Date.parse(catalog.meta.retrievedAt) >
          Date.parse(bundled.meta.retrievedAt)
        ) {
          active = catalog;
          source = "refreshed";
        }
      } catch (error) {
        log.info("catalog.load_failed", {
          file,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    let last: LastRefresh | null = null;
    const state = await readOptional(path.join(options.directory, STATE_FILE));
    if (state !== undefined) {
      let value: unknown;
      try {
        value = JSON.parse(state);
      } catch {
        value = undefined;
      }
      if (isLastRefresh(value)) last = value;
      else log.info("catalog.state_invalid", { file: STATE_FILE });
    }
    return new CatalogRefresher(options, active, source, last);
  }

  current(): ModelCatalog {
    return this.active;
  }

  status(): CatalogStatus {
    const { autoRefresh, disabledBy, url } = this.options.settings;
    return {
      source: this.source,
      snapshot: this.active.meta,
      url,
      autoRefresh: {
        enabled: autoRefresh,
        ...(disabledBy ? { disabledBy } : {}),
      },
      lastRefresh: this.last,
      nextRefreshAt:
        this.dueAt === undefined ? null : new Date(this.dueAt).toISOString(),
    };
  }

  subscribe(listener: () => Promise<void>): void {
    this.listeners.push(listener);
  }

  refresh(): Promise<CatalogStatus> {
    if (this.closed)
      return Promise.reject(
        new HubError("CATALOG_CLOSED", "The model catalog is closed", 503),
      );
    this.running ??= this.run().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  /**
   * Start the background refresh when it is on: due 24 hours after the last
   * attempt, or at once when there was none or it is older. Idempotent.
   */
  start(): void {
    this.started = true;
    this.schedule();
  }

  /**
   * Refresh early after a served call with usage but no price, unless a
   * refresh ran in the last 6 hours or the background refresh is off.
   */
  noteCall(entry: ModelCallEntry): void {
    if (
      entry.cost !== null ||
      entry.rejected === true ||
      entry.status >= 400 ||
      entry.usage === undefined ||
      entry.usage.source === "missing"
    )
      return;
    if (
      !this.started ||
      this.closed ||
      !this.options.settings.autoRefresh ||
      this.running
    )
      return;
    if (
      this.last &&
      this.now() - Date.parse(this.last.at) < EARLY_REFRESH_INTERVAL_MS
    )
      return;
    this.background();
  }

  /**
   * Stop the timer, abort a running fetch and wait for it and its listeners.
   * Idempotent.
   */
  async close(): Promise<void> {
    this.closed = true;
    this.cancelTimer();
    this.abort.abort();
    await this.running?.catch(() => undefined);
  }

  private background(): void {
    void this.refresh().catch(() => undefined);
  }

  private cancelTimer(): void {
    if (this.timer !== undefined) this.timers.clear(this.timer);
    this.timer = undefined;
    this.dueAt = undefined;
  }

  private schedule(): void {
    this.cancelTimer();
    if (!this.started || this.closed || !this.options.settings.autoRefresh)
      return;
    const now = this.now();
    const due = this.last
      ? Math.max(now, Date.parse(this.last.at) + REFRESH_INTERVAL_MS)
      : now;
    this.dueAt = due;
    this.timer = this.timers.set(() => {
      this.timer = undefined;
      this.dueAt = undefined;
      this.background();
    }, due - now);
  }

  private async run(): Promise<CatalogStatus> {
    const at = new Date(this.now()).toISOString();
    let outcome: LastRefresh;
    let changed = false;
    try {
      const fetched = await this.download(at);
      if (
        fetched === undefined ||
        fetched.catalog.meta.sha256 === this.active.meta.sha256
      )
        outcome = { at, outcome: "unchanged" };
      else {
        await this.write(DATA_FILE, fetched.text);
        this.active = fetched.catalog;
        this.source = "refreshed";
        changed = true;
        outcome = { at, outcome: "updated" };
      }
    } catch (error) {
      outcome = {
        at,
        outcome: "failed",
        error: (error instanceof Error ? error.message : String(error)).slice(
          0,
          500,
        ),
      };
    }
    if (!this.closed) {
      // Stored before the status shows it, so that what the status shows is
      // what the next start reads.
      try {
        await this.write(STATE_FILE, `${JSON.stringify(outcome)}\n`);
      } catch (error) {
        this.log.info("catalog.state_write_failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      }
      this.last = outcome;
    }
    this.log.info("catalog.refresh", {
      outcome: outcome.outcome,
      error: outcome.error ?? null,
      source: this.source,
      retrievedAt: this.active.meta.retrievedAt,
    });
    if (changed)
      for (const listener of this.listeners)
        try {
          await listener();
        } catch (error) {
          this.log.info("catalog.listener_failed", {
            message: error instanceof Error ? error.message : String(error),
          });
        }
    this.schedule();
    if (outcome.outcome === "failed")
      throw new HubError(
        "CATALOG_REFRESH_FAILED",
        `The model catalog could not be refreshed: ${outcome.error}`,
        502,
      );
    return this.status();
  }

  /** The new catalog, or undefined when the server says it is unchanged. */
  private async download(at: string) {
    const timeout = deadline(this.abort.signal, FETCH_TIMEOUT_MS);
    try {
      return await this.fetchCatalog(at, timeout.signal);
    } finally {
      timeout.dispose();
    }
  }

  private async fetchCatalog(at: string, signal: AbortSignal) {
    const url = this.options.settings.url;
    const host = new URL(url).host;
    const etag = this.active.meta.etag;
    const failed = (error: unknown): never => {
      if (this.abort.signal.aborted)
        throw new Error("the daemon is shutting down");
      if (signal.aborted)
        throw new Error(
          `${host} did not answer within ${FETCH_TIMEOUT_MS / 1000} s`,
        );
      throw error;
    };
    let response: Response;
    try {
      response = await this.fetch(url, {
        headers: {
          accept: "application/json",
          ...(etag ? { "if-none-match": etag } : {}),
        },
        signal,
      });
    } catch (error) {
      return failed(
        new Error(`could not connect to ${host}`, { cause: error }),
      );
    }
    if (response.status === 304) {
      await response.body?.cancel();
      return undefined;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`${host} answered HTTP ${response.status}`);
    }
    let bytes: Buffer;
    try {
      bytes = await readLimited(response, MAX_DOCUMENT_BYTES);
    } catch (error) {
      return failed(error);
    }
    try {
      const text = snapshotText(bytes, {
        source: url,
        retrievedAt: at,
        etag: response.headers.get("etag"),
        commit: null,
      });
      return { text, catalog: parseCatalog(text) };
    } catch {
      throw new Error(`${host} did not return a valid models.dev catalog`);
    }
  }

  /** Replace `name` in the directory atomically. */
  private async write(name: string, content: string): Promise<void> {
    const directory = this.options.directory;
    await mkdir(directory, { recursive: true });
    const temporary = path.join(directory, `.${name}.${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, "wx");
      try {
        await handle.writeFile(content);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, path.join(directory, name));
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
}
