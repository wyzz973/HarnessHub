// SPDX-License-Identifier: MIT
/**
 * Multi-machine sync through a WebDAV folder or an S3-compatible bucket
 * (docs/backup-sync.md), off by default. What goes to the server is a backup
 * sealed with the sync passphrase, so the server only ever holds ciphertext.
 * The setup is taken in five parts: `providers` (providers with their
 * credentials and overrides, and route groups), `agents` (the wirings as
 * intents), `profiles` (wiring profiles), `library` (the Library's items;
 * with agent wirings synced, also written into the agents installed here)
 * and `features` (the gateway's redaction, vision model and search
 * backends; redaction turned off by the server is named in the notice). A part changed only here is pushed, one changed only on the
 * server is brought in, and one changed on both since the last sync keeps
 * the side changed last; the side it replaced is saved under
 * `<dataDir>/sync/conflicts/` and named in a notice. Each machine writes only
 * over the version it read; when another wrote in between, the sync reads
 * that version, merges again and retries once. The design follows Magpie's
 * davsync (yetone/magpie, MIT).
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SecretReference } from "@harnesshub/core/engine-configuration";
import { HubError } from "@harnesshub/core/errors";
import { NO_LOG, type LogSink } from "@harnesshub/core/logging";
import {
  BACKUP_EXTENSION,
  BackupError,
  formatEnvelope,
  open,
  parseEnvelope,
  seal,
} from "./backup-envelope.js";
import {
  canonical,
  decodeBundle,
  encodeBundle,
  type BackupBundle,
  type BackupService,
} from "./backup.js";
import {
  emptyFeatures,
  featuresView,
  withFeaturesValues,
} from "./features-backup.js";
import type { ManagedSecrets } from "./http/api-v1.js";
import {
  emptyLibrary,
  libraryView,
  withLibraryValues,
} from "./library-backup.js";
import {
  RateLimited,
  RemoteChanged,
  S3Remote,
  WebDavRemote,
  type Fetch,
  type RemoteVersion,
  type SyncRemote,
} from "./sync-remote.js";

/** How often the daemon syncs while it runs. */
export const SYNC_INTERVAL_MS = 3 * 60_000;
const FIRST_SYNC_DELAY_MS = 20_000;
/** One sync, both attempts included. */
const SYNC_TIMEOUT_MS = 2 * 60_000;
/** The longest wait after a server that limits requests without saying for how long. */
const MAX_BACKOFF_MS = 30 * 60_000;
/** The longest Retry-After honoured. */
const MAX_RETRY_AFTER_MS = 6 * 60 * 60_000;

export const SYNC_PARTS = [
  "providers",
  "agents",
  "profiles",
  "library",
  "features",
] as const;
export type SyncPart = (typeof SYNC_PARTS)[number];

/** `<dataDir>/sync/config.json`: the target, with its secrets as references. */
interface SyncConfig {
  schemaVersion: 1;
  kind: "webdav" | "s3";
  url: string;
  /** The WebDAV user, or the S3 access key ID. */
  user?: string;
  endpoint?: string;
  region?: string;
  pathStyle?: boolean;
  /** Credential values go to the server (sealed). */
  keys: boolean;
  /** Agent wirings are synced. */
  agents: boolean;
  /** The WebDAV password or the S3 secret access key. */
  secret?: SecretReference;
  passphrase: SecretReference;
}

/** What the last sync replaced when a part had changed on both sides. */
export interface SyncNotice {
  at: string;
  /** This machine's parts, replaced by the server's. */
  here: SyncPart[];
  /** The server's parts, replaced by this machine's. */
  there: SyncPart[];
  /** The directory the replaced copies are kept in. */
  saved?: string;
  /** Providers and groups the server no longer has, kept because Gateway Keys still allow them. */
  kept?: string[];
  /**
   * The server's gateway features turned outbound redaction off here: a
   * security change, shown until the next notice.
   */
  redactionOff?: true;
  /** Search backends the server carries without a key and this machine has none for: not brought in. */
  needKey?: string[];
  /**
   * Left out (second security review M5): provider credentials naming
   * HarnessHub's own secrets, and search keys that are references.
   */
  refused?: string[];
}

/** `<dataDir>/sync/state.json`: what the last sync saw. */
interface SyncState {
  /** The target and passphrase it was for; another starts afresh. */
  key: string;
  last?: string;
  error?: string;
  notice?: SyncNotice;
  /** SHA-256 of the server's file as last seen. */
  sum?: string;
  server?: RemoteVersion;
  local?: Partial<Record<SyncPart, string>>;
  remote?: Partial<Record<SyncPart, string>>;
}

/** `GET /api/v1/sync`. */
export interface SyncStatus {
  enabled: boolean;
  kind?: "webdav" | "s3";
  url?: string;
  user?: string;
  endpoint?: string;
  region?: string;
  pathStyle?: boolean;
  keys?: boolean;
  agents?: boolean;
  intervalMs: number;
  lastSyncAt?: string;
  lastError?: string;
  nextSyncAt?: string;
  notice?: SyncNotice;
  /** Where the target's secret and the passphrase are kept. */
  secretBackend: ManagedSecrets["backend"];
  /** Present after `configure`: what the caller must know. */
  warnings?: string[];
}

/** What sync uses of the backup service. */
export type SyncBackups = Pick<
  BackupService,
  | "collect"
  | "lastChange"
  | "bringProviders"
  | "bringAgents"
  | "bringProfiles"
  | "bringLibrary"
  | "bringFeatures"
  | "serial"
>;

export interface SyncServiceOptions {
  dataDir: string;
  backups: SyncBackups;
  secrets: ManagedSecrets;
  environment: Readonly<NodeJS.ProcessEnv>;
  fetch?: Fetch;
  log?: LogSink;
  clock?: () => Date;
  /** Timers of the background loop; injectable for tests. */
  timers?: {
    setTimeout: (callback: () => void, ms: number) => unknown;
    clearTimeout: (handle: unknown) => void;
  };
  intervalMs?: number;
  firstDelayMs?: number;
}

/** A failure of the sync configuration (`SYNC_CONFIG_INVALID`, 400). */
function invalid(message: string): HubError {
  return new HubError("SYNC_CONFIG_INVALID", message, 400);
}

const PASSPHRASE_WARNING =
  "The sync passphrase is kept in this machine's secret store so that the daemon can sync unattended: anyone who can read this account's secrets can open the copy on the server. Use the same passphrase on every machine.";

/**
 * Owns the sync configuration, its secrets, the background loop and the
 * state files under `<dataDir>/sync/`. Syncs run one at a time, and inside
 * the backup service's queue, so a restore never interleaves with one.
 */
export class SyncService {
  private config: SyncConfig | undefined;
  private state: SyncState | undefined;
  private timer: unknown;
  private nextAt: number | undefined;
  private wait: number;
  private running: Promise<unknown> = Promise.resolve();
  private abort: AbortController | undefined;
  private closed = false;

  constructor(private readonly options: SyncServiceOptions) {
    this.wait = this.interval;
  }

  /**
   * Reads the configuration and state (absent: sync off).
   *
   * @throws HubError `INVALID_CONFIG` when `config.json` is not a valid configuration.
   */
  async load(): Promise<void> {
    const text = await readText(this.file("config.json"));
    if (text !== undefined) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        parsed = undefined;
      }
      if (!isSyncConfig(parsed))
        throw new HubError(
          "INVALID_CONFIG",
          `${this.file("config.json")} is not a valid sync configuration`,
        );
      this.config = parsed;
    }
    const state = await readText(this.file("state.json"));
    let parsed: unknown;
    try {
      parsed = state ? (JSON.parse(state) as unknown) : undefined;
    } catch {
      parsed = undefined;
    }
    // A state that is missing or not one is a fresh start: the next sync
    // merges with the server as on first joining.
    this.state = isSyncState(parsed) ? parsed : undefined;
  }

  /** Starts the background loop when sync is configured. */
  start(): void {
    if (this.config && !this.closed) this.schedule(this.firstDelay);
  }

  status(): SyncStatus {
    const config = this.config;
    const state = this.state;
    return {
      enabled: config !== undefined,
      ...(config
        ? {
            kind: config.kind,
            url: config.url,
            ...(config.user !== undefined ? { user: config.user } : {}),
            ...(config.endpoint !== undefined
              ? { endpoint: config.endpoint }
              : {}),
            ...(config.region !== undefined ? { region: config.region } : {}),
            ...(config.pathStyle !== undefined
              ? { pathStyle: config.pathStyle }
              : {}),
            keys: config.keys,
            agents: config.agents,
          }
        : {}),
      intervalMs: this.interval,
      ...(config && state?.last ? { lastSyncAt: state.last } : {}),
      ...(config && state?.error ? { lastError: state.error } : {}),
      ...(config && this.nextAt !== undefined
        ? { nextSyncAt: new Date(this.nextAt).toISOString() }
        : {}),
      ...(config && state?.notice ? { notice: state.notice } : {}),
      secretBackend: this.options.secrets.backend,
    };
  }

  /**
   * Turns sync on or changes it. The target's secret and the passphrase go to
   * the secret store; one left out keeps the one stored before (the secret
   * only for the same target and user). Does not sync: call {@link now}.
   *
   * @throws HubError `SYNC_CONFIG_INVALID` (400) for invalid input.
   */
  async configure(input: unknown): Promise<SyncStatus> {
    const request = parseConfigure(input);
    return this.serial(async () => {
      const old = this.config;
      const sameTarget =
        old !== undefined &&
        old.kind === request.kind &&
        old.url === request.url &&
        old.user === request.user &&
        old.endpoint === request.endpoint;
      if (request.secret === undefined && !(sameTarget && old.secret)) {
        if (request.kind === "s3")
          throw invalid(
            "S3 sync needs the secret access key of its access key ID",
          );
        if (request.user !== undefined)
          throw invalid(`Give the WebDAV password of ${request.user}`);
      }
      if (request.passphrase === undefined && !old)
        throw invalid("Sync needs a passphrase");
      // The remote is built once here so that an address that cannot be
      // used is refused before anything is stored.
      this.remoteFor(request.kind, request, request.secret ?? "");
      const { secrets } = this.options;
      const created: SecretReference[] = [];
      let written = false;
      try {
        const secret =
          request.secret !== undefined
            ? await secrets.create(request.secret)
            : sameTarget
              ? old.secret
              : undefined;
        if (request.secret !== undefined && secret) created.push(secret);
        const passphrase =
          request.passphrase !== undefined
            ? await secrets.create(request.passphrase)
            : old!.passphrase;
        if (request.passphrase !== undefined) created.push(passphrase);
        const config: SyncConfig = {
          schemaVersion: 1,
          kind: request.kind,
          url: request.url,
          ...(request.user !== undefined ? { user: request.user } : {}),
          ...(request.endpoint !== undefined
            ? { endpoint: request.endpoint }
            : {}),
          ...(request.region !== undefined ? { region: request.region } : {}),
          ...(request.pathStyle !== undefined
            ? { pathStyle: request.pathStyle }
            : {}),
          keys: request.keys,
          agents: request.agents,
          ...(secret ? { secret } : {}),
          passphrase,
        };
        await this.writeJson("config.json", config);
        this.config = config;
        written = true;
        // The secrets replaced go after the configuration naming the new
        // ones is written.
        for (const ref of [old?.secret, old?.passphrase])
          if (ref && ref !== config.secret && ref !== config.passphrase)
            await secrets.delete(ref);
      } catch (error) {
        if (written) throw error;
        const failed: unknown[] = [];
        for (const ref of created)
          await secrets.delete(ref).catch((cleanup: unknown) => {
            failed.push(cleanup);
          });
        if (failed.length)
          throw new AggregateError(
            [error, ...failed],
            "Configuring sync failed and its new secrets could not all be removed",
          );
        throw error;
      }
      if (!this.closed) this.schedule(this.firstDelay);
      return { ...this.status(), warnings: [PASSPHRASE_WARNING] };
    });
  }

  /** Turns sync off: the configuration, its secrets and the state go; conflict copies stay. */
  async disable(): Promise<SyncStatus> {
    this.stopTimer();
    this.abort?.abort();
    return this.serial(async () => {
      const old = this.config;
      this.config = undefined;
      this.state = undefined;
      for (const name of [
        "config.json",
        "state.json",
        `server${BACKUP_EXTENSION}`,
      ])
        await rm(this.file(name), { force: true });
      for (const ref of [old?.secret, old?.passphrase])
        if (ref) await this.options.secrets.delete(ref);
      return this.status();
    });
  }

  /**
   * Syncs once now and reschedules the loop.
   *
   * @throws HubError `SYNC_DISABLED` (409) when sync is off; the sync's own
   *   failure otherwise (also kept as `lastError`).
   */
  async now(): Promise<SyncStatus> {
    if (!this.config)
      throw new HubError(
        "SYNC_DISABLED",
        "Sync is off; turn it on with hh sync <webdav|s3> on",
        409,
      );
    const error = await this.run();
    if (error) throw error;
    return this.status();
  }

  /** Stops the loop, aborts a sync in flight and waits for it. */
  async close(): Promise<void> {
    this.closed = true;
    this.stopTimer();
    this.abort?.abort();
    await this.running.catch(() => undefined);
  }

  private get interval(): number {
    return this.options.intervalMs ?? SYNC_INTERVAL_MS;
  }

  private get firstDelay(): number {
    return this.options.firstDelayMs ?? FIRST_SYNC_DELAY_MS;
  }

  private schedule(ms: number): void {
    this.stopTimer();
    const timers = this.options.timers ?? {
      setTimeout: (callback: () => void, delay: number) => {
        const handle = setTimeout(callback, delay);
        handle.unref();
        return handle;
      },
      clearTimeout: (handle: unknown) =>
        clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
    this.nextAt = this.now_() + ms;
    this.timer = timers.setTimeout(() => {
      this.timer = undefined;
      this.nextAt = undefined;
      void this.run();
    }, ms);
  }

  private stopTimer(): void {
    if (this.timer !== undefined) {
      (
        this.options.timers?.clearTimeout ??
        ((handle: unknown) =>
          clearTimeout(handle as ReturnType<typeof setTimeout>))
      )(this.timer);
      this.timer = undefined;
    }
    this.nextAt = undefined;
  }

  /** One sync with its bookkeeping; resolves to its error, never rejects. */
  private run(): Promise<HubError | undefined> {
    return this.serial(async () => {
      if (!this.config || this.closed) return undefined;
      this.stopTimer();
      const abort = new AbortController();
      this.abort = abort;
      const timeout = setTimeout(() => abort.abort(), SYNC_TIMEOUT_MS);
      let failure: HubError | undefined;
      try {
        await this.options.backups.serial(() =>
          this.syncWithRetry(abort.signal),
        );
        this.wait = this.interval;
      } catch (error) {
        failure =
          error instanceof HubError
            ? error
            : new HubError(
                "SYNC_FAILED",
                abort.signal.aborted
                  ? "The sync was stopped before it finished"
                  : error instanceof Error
                    ? error.message.slice(0, 500)
                    : "The sync failed",
                502,
              );
        this.wait = backoff(failure, this.wait, this.interval);
        this.log.info("sync.failed", {
          code: failure.code,
          message: failure.message,
        });
      } finally {
        clearTimeout(timeout);
        this.abort = undefined;
      }
      if (this.config) {
        const state = (this.state ??= { key: "" });
        if (failure) state.error = failure.message;
        else delete state.error;
        if (!failure) state.last = new Date(this.now_()).toISOString();
        await this.writeJson("state.json", state).catch((error: unknown) => {
          failure ??= new HubError(
            "SYNC_FAILED",
            `The sync state could not be saved: ${error instanceof Error ? error.message : String(error)}`,
            500,
          );
        });
        if (!this.closed) this.schedule(this.wait);
      }
      return failure;
    });
  }

  private async syncWithRetry(signal: AbortSignal): Promise<void> {
    const config = this.config!;
    const secret = config.secret
      ? await this.options.secrets.resolve(
          config.secret,
          this.options.environment,
        )
      : "";
    const passphrase = await this.options.secrets.resolve(
      config.passphrase,
      this.options.environment,
    );
    const key = this.stateKey(config);
    if (this.state?.key !== key) this.state = { key };
    const remote = this.remoteFor(config.kind, config, secret);
    try {
      await this.syncOnce(config, remote, passphrase, signal);
    } catch (error) {
      if (!(error instanceof RemoteChanged)) throw error;
      // Another machine wrote in between: once more, over its version.
      try {
        await this.syncOnce(
          config,
          remote,
          passphrase,
          signal,
          error.intervening,
        );
      } catch (again) {
        if (again instanceof RemoteChanged)
          throw new HubError(
            "SYNC_CONFLICT",
            "Another machine kept writing the file on the server; the next sync tries again",
            409,
          );
        throw again;
      }
    }
  }

  private async syncOnce(
    config: SyncConfig,
    remote: SyncRemote,
    passphrase: string,
    signal: AbortSignal,
    intervening?: { data: Buffer; version: RemoteVersion },
  ): Promise<void> {
    const state = this.state!;
    const { backups } = this.options;
    let read = intervening
      ? ({ status: "found", ...intervening } as const)
      : await remote.get(state.server ?? {}, signal);
    let local = await backups.collect({
      keys: config.keys,
      agents: config.agents,
    });
    const L = this.hashes(local);
    if (read.status === "unchanged") {
      if (same(L, state.local)) return; // nothing changed on either side
      // Changed here: merged with the server's file as last seen.
      const cached = await this.cached(state.sum);
      read = cached
        ? { status: "found", data: cached, version: state.server ?? {} }
        : await remote.get({}, signal);
      if (read.status === "unchanged")
        throw new HubError(
          "SYNC_FAILED",
          "The server answered an unconditional read with 304",
          502,
        );
    }
    const push = async (bundle: BackupBundle, base: string | undefined) => {
      const sealed = Buffer.from(
        formatEnvelope(
          await seal(
            encodeBundle({
              ...bundle,
              createdAt: new Date(this.now_()).toISOString(),
            }),
            passphrase,
          ),
        ),
      );
      const version = await remote.put(sealed, base, signal);
      state.sum = sha256(sealed);
      state.server = version;
      state.remote = this.hashes(bundle);
      await this.remember(sealed);
    };
    if (read.status === "absent") {
      // Nothing there yet: this machine's setup is the first.
      await push(local, undefined);
      state.local = L;
      return;
    }
    const { data, version } = read;
    if (sha256(data) === state.sum && same(L, state.local)) {
      state.server = version;
      await this.remember(data);
      return;
    }
    let remoteBundle: BackupBundle;
    try {
      remoteBundle = decodeBundle(await open(parseEnvelope(data), passphrase));
    } catch (error) {
      if (error instanceof BackupError && error.code === "BACKUP_PASSPHRASE")
        throw new HubError(
          "SYNC_PASSPHRASE",
          "The passphrase does not open the file on the server: it was sealed with another one; use the passphrase set on your other machines",
          409,
        );
      throw error;
    }
    const R = this.hashes(remoteBundle);
    const first = state.local === undefined;
    const merged: BackupBundle = { ...remoteBundle };
    const bring: SyncPart[] = [];
    const here: SyncPart[] = [];
    const there: SyncPart[] = [];
    for (const part of SYNC_PARTS) {
      if (L[part] === R[part] || (part === "agents" && !config.agents))
        continue;
      // From a HarnessHub before profiles, the Library or the gateway
      // features: this machine's go up.
      if (
        (part === "profiles" && remoteBundle.profiles === undefined) ||
        (part === "library" && remoteBundle.library === undefined) ||
        (part === "features" && remoteBundle.gatewayFeatures === undefined)
      ) {
        take(merged, local, part);
        continue;
      }
      const localChanged = !first && L[part] !== state.local?.[part];
      const remoteChanged = first || R[part] !== state.remote?.[part];
      if (localChanged && !remoteChanged) take(merged, local, part);
      else if (remoteChanged && !localChanged) {
        bring.push(part);
        // Joining replaces this machine's part with the server's; a part
        // with nothing in it here loses nothing.
        if (first && !emptyPart(local, part)) here.push(part);
      } else if (localChanged && remoteChanged) {
        const changed = await backups.lastChange(part);
        if (changed !== undefined && changed > remoteBundle.createdAt) {
          take(merged, local, part);
          there.push(part);
        } else {
          bring.push(part);
          here.push(part);
        }
      }
    }
    let saved: string | undefined;
    if (here.length || there.length) {
      saved = this.file("conflicts");
      await mkdir(saved, { recursive: true, mode: 0o700 });
      const stamp = new Date(this.now_()).toISOString().replace(/[:.]/g, "-");
      if (here.length)
        await writePrivate(
          path.join(saved, `${stamp}-this-computer${BACKUP_EXTENSION}`),
          formatEnvelope(await seal(encodeBundle(local), passphrase)),
        );
      if (there.length)
        await writePrivate(
          path.join(saved, `${stamp}-server${BACKUP_EXTENSION}`),
          data,
        );
    }
    const kept: string[] = [];
    let redactionOff = false;
    const needKey: string[] = [];
    const refused: string[] = [];
    for (const part of bring)
      if (part === "features") {
        if (!remoteBundle.gatewayFeatures) continue;
        const brought = await backups.bringFeatures(
          remoteBundle.gatewayFeatures,
        );
        if (brought.redaction.turnsOff) {
          redactionOff = true;
          this.log.info("sync.redaction_off", {});
        }
        needKey.push(...brought.search.needKey);
        refused.push(...brought.search.refused);
      } else if (part === "providers") {
        const mirrored = await backups.bringProviders(remoteBundle, true);
        kept.push(...mirrored.kept);
        refused.push(...mirrored.refused);
      } else if (part === "agents")
        await backups.bringAgents(remoteBundle.agents, config.agents);
      else if (part === "profiles")
        await backups.bringProfiles(remoteBundle.profiles ?? [], true);
      else if (remoteBundle.library) {
        const brought = await backups.bringLibrary(
          remoteBundle.library,
          config.agents,
        );
        if (brought.agentsError)
          this.log.info("sync.library_agents_failed", {
            error: brought.agentsError,
          });
        if (brought.restore.refused.length)
          this.log.info("sync.library_refused", {
            items: brought.restore.refused
              .map((item) => `${item.kind}:${item.name}`)
              .join(","),
          });
      }
    // The server's parts are in; until the push below is done, what it
    // carries counts as changed here.
    let now = L;
    if (bring.length) {
      local = await backups.collect({
        keys: config.keys,
        agents: config.agents,
      });
      now = this.hashes(local);
    }
    const M = this.hashes(merged);
    const pending: Partial<Record<SyncPart, string>> = {};
    for (const part of SYNC_PARTS) {
      const value =
        M[part] !== R[part] && state.local ? state.local[part] : now[part];
      if (value !== undefined) pending[part] = value;
    }
    state.local = pending;
    state.sum = sha256(data);
    state.server = version;
    state.remote = R;
    await this.remember(data);
    if (
      here.length ||
      there.length ||
      kept.length ||
      redactionOff ||
      needKey.length ||
      refused.length
    )
      state.notice = {
        at: new Date(this.now_()).toISOString(),
        here,
        there,
        ...(saved ? { saved } : {}),
        ...(kept.length ? { kept } : {}),
        ...(redactionOff ? { redactionOff: true as const } : {}),
        ...(needKey.length ? { needKey } : {}),
        ...(refused.length ? { refused } : {}),
      };
    if (!same(M, R)) await push(merged, version.etag);
    state.local = now;
  }

  /** Each part's SHA-256, compared to tell a change; the state keeps them. */
  private hashes(bundle: BackupBundle): Record<SyncPart, string> {
    const hash = (value: unknown) => sha256(JSON.stringify(canonical(value)));
    return {
      providers: hash({ providers: bundle.providers, groups: bundle.groups }),
      agents: hash(bundle.agents),
      profiles: hash(bundle.profiles ?? []),
      library: hash(libraryView(bundle.library)),
      features: hash(featuresView(bundle.gatewayFeatures)),
    };
  }

  private remoteFor(
    kind: SyncConfig["kind"],
    target: Pick<
      SyncConfig,
      "url" | "user" | "endpoint" | "region" | "pathStyle"
    >,
    secret: string,
  ): SyncRemote {
    try {
      return kind === "webdav"
        ? new WebDavRemote({
            url: target.url,
            ...(target.user !== undefined ? { user: target.user } : {}),
            ...(secret ? { password: secret } : {}),
            ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
          })
        : new S3Remote({
            url: target.url,
            accessKeyId: target.user ?? "",
            secretAccessKey: secret,
            ...(target.endpoint !== undefined
              ? { endpoint: target.endpoint }
              : {}),
            ...(target.region !== undefined ? { region: target.region } : {}),
            ...(target.pathStyle !== undefined
              ? { pathStyle: target.pathStyle }
              : {}),
            ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
            ...(this.options.clock ? { now: this.options.clock } : {}),
          });
    } catch (error) {
      if (error instanceof HubError) throw invalid(error.message);
      throw error;
    }
  }

  /**
   * The target a state is for, and the passphrase by its secret reference
   * (a new passphrase is a new reference): another starts afresh.
   */
  private stateKey(config: SyncConfig): string {
    return sha256(
      [
        config.kind,
        config.url,
        config.endpoint ?? "",
        config.user ?? "",
        config.passphrase.value,
      ].join("\0"),
    );
  }

  private async cached(sum: string | undefined): Promise<Buffer | undefined> {
    if (!sum) return undefined;
    try {
      const bytes = await readFile(this.file(`server${BACKUP_EXTENSION}`));
      return sha256(bytes) === sum ? bytes : undefined;
    } catch {
      // A copy that is gone or unreadable is read from the server again.
      return undefined;
    }
  }

  private async remember(data: Buffer): Promise<void> {
    await this.ensureDirectory();
    await writePrivate(this.file(`server${BACKUP_EXTENSION}`), data);
  }

  private async writeJson(name: string, value: unknown): Promise<void> {
    await this.ensureDirectory();
    await writePrivate(this.file(name), `${JSON.stringify(value, null, 2)}\n`);
  }

  private async ensureDirectory(): Promise<void> {
    await mkdir(this.file(""), { recursive: true, mode: 0o700 });
  }

  private file(name: string): string {
    return path.join(this.options.dataDir, "sync", name);
  }

  private now_(): number {
    return (this.options.clock?.() ?? new Date()).getTime();
  }

  private get log(): LogSink {
    return this.options.log ?? NO_LOG;
  }

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.running.then(action, action);
    this.running = result.catch(() => undefined);
    return result;
  }
}

/** Puts `from`'s part into `to`; credential values `from` lacks are kept from `to`. */
function take(to: BackupBundle, from: BackupBundle, part: SyncPart): void {
  if (part === "agents") {
    to.agents = from.agents;
    return;
  }
  if (part === "profiles") {
    to.profiles = from.profiles ?? [];
    return;
  }
  if (part === "library") {
    if (from.library) to.library = withLibraryValues(from.library, to.library);
    else delete to.library;
    return;
  }
  if (part === "features") {
    if (from.gatewayFeatures)
      to.gatewayFeatures = withFeaturesValues(
        from.gatewayFeatures,
        to.gatewayFeatures,
      );
    else delete to.gatewayFeatures;
    return;
  }
  const values = new Map<string, string>();
  for (const provider of to.providers)
    for (const credential of provider.credentials)
      if (credential.secret.source === "store" && credential.secret.value)
        values.set(
          `${provider.config.id}\0${credential.id}`,
          credential.secret.value,
        );
  to.providers = from.providers.map((provider) => ({
    ...provider,
    credentials: provider.credentials.map((credential) => {
      const value = values.get(`${provider.config.id}\0${credential.id}`);
      return credential.secret.source === "store" &&
        credential.secret.value === undefined &&
        value !== undefined
        ? { ...credential, secret: { source: "store", value } }
        : credential;
    }),
  }));
  to.groups = from.groups;
  to.keys = to.keys || from.keys;
}

function emptyPart(bundle: BackupBundle, part: SyncPart): boolean {
  switch (part) {
    case "agents":
      return bundle.agents.length === 0;
    case "profiles":
      return (bundle.profiles ?? []).length === 0;
    case "library":
      return emptyLibrary(bundle.library);
    case "features":
      return emptyFeatures(bundle.gatewayFeatures);
    case "providers":
      return bundle.providers.length === 0 && bundle.groups.length === 0;
  }
}

/**
 * How long the loop waits after a sync: the interval, but longer for a
 * server limiting requests: its Retry-After (between the interval and six
 * hours), else twice the last wait up to thirty minutes.
 */
function backoff(error: HubError, previous: number, interval: number): number {
  if (!(error instanceof RateLimited)) return interval;
  if (error.afterMs !== undefined)
    return Math.min(Math.max(error.afterMs, interval), MAX_RETRY_AFTER_MS);
  return Math.min(Math.max(2 * previous, 2 * interval), MAX_BACKOFF_MS);
}

function same(
  left: Partial<Record<SyncPart, string>>,
  right: Partial<Record<SyncPart, string>> | undefined,
): boolean {
  return (
    right !== undefined &&
    SYNC_PARTS.every((part) => left[part] === right[part])
  );
}

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

async function readText(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return undefined;
    throw error;
  }
}

/** Writes a 0600 file through a temporary one and a rename. */
async function writePrivate(
  file: string,
  data: string | Buffer,
): Promise<void> {
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, data, { flag: "wx", mode: 0o600 });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

interface ConfigureRequest {
  kind: "webdav" | "s3";
  url: string;
  user?: string;
  secret?: string;
  passphrase?: string;
  endpoint?: string;
  region?: string;
  pathStyle?: boolean;
  keys: boolean;
  agents: boolean;
}

/** The body of `PUT /api/v1/sync`, validated (the route schema checks types too). */
function parseConfigure(input: unknown): ConfigureRequest {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw invalid("The sync configuration must be an object");
  const body = input as Record<string, unknown>;
  const text = (name: string, max = 2048): string | undefined => {
    const value = body[name];
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !value.trim() || value.length > max)
      throw invalid(`${name} must be a non-empty string`);
    return name === "secret" || name === "passphrase" ? value : value.trim();
  };
  const flag = (name: string, fallback: boolean): boolean => {
    const value = body[name];
    if (value === undefined) return fallback;
    if (typeof value !== "boolean")
      throw invalid(`${name} must be true or false`);
    return value;
  };
  const kind = body.kind;
  if (kind !== "webdav" && kind !== "s3")
    throw invalid("kind must be webdav or s3");
  const url = text("url");
  if (!url) throw invalid("url is required");
  if (kind === "s3" && !text("user"))
    throw invalid("S3 sync needs an access key ID (user)");
  if (kind === "webdav")
    for (const name of ["endpoint", "region", "pathStyle"])
      if (body[name] !== undefined) throw invalid(`${name} is an S3 setting`);
  const request: ConfigureRequest = {
    kind,
    url,
    keys: flag("keys", true),
    agents: flag("agents", true),
  };
  for (const name of [
    "user",
    "secret",
    "passphrase",
    "endpoint",
    "region",
  ] as const) {
    const value = text(name);
    if (value !== undefined) request[name] = value;
  }
  if (body.pathStyle !== undefined)
    request.pathStyle = flag("pathStyle", false);
  return request;
}

function isSyncState(value: unknown): value is SyncState {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const state = value as Record<string, unknown>;
  const text = (item: unknown) =>
    item === undefined || typeof item === "string";
  const hashes = (item: unknown) =>
    item === undefined ||
    (typeof item === "object" &&
      item !== null &&
      Object.values(item).every((hash) => typeof hash === "string"));
  const version = state.server as Record<string, unknown> | undefined;
  return (
    typeof state.key === "string" &&
    text(state.last) &&
    text(state.error) &&
    text(state.sum) &&
    (version === undefined ||
      (typeof version === "object" &&
        version !== null &&
        text(version.etag) &&
        text(version.modified))) &&
    hashes(state.local) &&
    hashes(state.remote) &&
    (state.notice === undefined ||
      (typeof state.notice === "object" && state.notice !== null))
  );
}

function isSyncConfig(value: unknown): value is SyncConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const config = value as Record<string, unknown>;
  const ref = (item: unknown) =>
    typeof item === "object" &&
    item !== null &&
    typeof (item as { kind?: unknown }).kind === "string" &&
    typeof (item as { value?: unknown }).value === "string";
  const optionalText = (item: unknown) =>
    item === undefined || typeof item === "string";
  return (
    config.schemaVersion === 1 &&
    (config.kind === "webdav" || config.kind === "s3") &&
    typeof config.url === "string" &&
    optionalText(config.user) &&
    optionalText(config.endpoint) &&
    optionalText(config.region) &&
    (config.pathStyle === undefined || typeof config.pathStyle === "boolean") &&
    typeof config.keys === "boolean" &&
    typeof config.agents === "boolean" &&
    (config.secret === undefined || ref(config.secret)) &&
    ref(config.passphrase)
  );
}
