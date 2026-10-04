// SPDX-License-Identifier: MIT
/**
 * Backups of this machine's model plane (docs/backup-sync.md): providers with
 * their credentials (the values only with keys), route groups, model
 * overrides, the agents' wirings as intents (model, tiers, effort, options
 * and the models they list and hide), wiring profiles, settings, and the
 * client keys that would need re-issuing. Gateway Key text is never stored
 * anywhere, so no key is in a backup: restoring re-wires agents with new
 * `agent:` keys and lists the client keys to issue again. Restore is
 * additive and goes record by record: a provider or profile with the same id
 * is replaced, the others are added, nothing is deleted. Sync's mirrors
 * (`bringProviders`, `bringProfiles`) also remove what the server no longer
 * holds. The bundle follows Magpie's backup
 * (yetone/magpie, MIT, internal/backup).
 */
import { HubError } from "@harnesshub/core/errors";
import type { SecretReference } from "@harnesshub/core/engine-configuration";
import {
  isModelOverride,
  isModelProvenance,
  type ModelMetadataStore,
  type ModelOverride,
  type ModelProvenance,
  type OverrideChange,
} from "@harnesshub/core/model-metadata";
import {
  isModelPattern,
  modelAllowed,
  parseModelRef,
  reasoningEfforts,
  wireProtocols,
  wiringTiers,
  type AgentWiringStore,
  type CredentialId,
  type GatewayKeyQuota,
  type ModelPlaneStore,
  type ProviderConfig,
  type ProviderCredential,
  type RouteGroup,
  type WireProtocol,
  type WiringChoice,
  type WiringProfile,
} from "@harnesshub/core/model-plane";
import {
  isProviderConfig,
  isRouteGroup,
  isTimestamp,
  isWiringProfile,
} from "@harnesshub/core/model-plane-records";
import {
  BackupError,
  open,
  seal,
  type BackupEnvelope,
} from "./backup-envelope.js";
import type { WiringRequest } from "./agents-wiring.js";
import type { ManagedSecrets } from "./http/api-v1.js";
import type {
  GatewayShareControl,
  GatewayShareStatus,
} from "./http/gateway-share-routes.js";

/** Header and environment names that look like they hold a key (Magpie's rule). */
const SECRET_NAME = /auth|key|token|secret|cookie|session|password/i;

/** Where a credential's secret is. */
export type BackupSecret =
  /** HarnessHub's secret store: `value` only in a backup with keys. */
  | { source: "store"; value?: string }
  /** An outside reference (environment variable, file, keychain item), kept as is. */
  | { source: "reference"; kind: "env" | "file" | "keychain"; name: string };

export interface BackupCredential {
  id: CredentialId;
  name: string;
  protocols?: WireProtocol[];
  enabled: boolean;
  secret: BackupSecret;
}

export interface BackupProvider {
  /** The stored provider without its credentials. */
  config: Omit<ProviderConfig, "credentials">;
  credentials: BackupCredential[];
  provenance: ModelProvenance[];
  overrides: ModelOverride[];
}

/**
 * One wired agent: what to wire it to again, not its files. `model` is
 * absent for an agent that signs in by itself (Codex with ChatGPT), which
 * then lists no models either.
 */
export interface AgentIntent extends WiringChoice {
  agent: string;
  /** The models it may list: its key's allow list (`*` for every model). */
  models: string[];
  /** The models hidden from it: its key's deny list. */
  deny?: string[];
}

/** A client key to issue again; its text is not restorable. */
export interface ClientKeyIntent {
  name: string;
  modelAllow: string[];
  allowLan: boolean;
  quota?: GatewayKeyQuota;
  expiresAt?: string;
}

/** The settings of `PUT /api/v1/gateway/share`. */
export interface GatewayShareSettings {
  lan: { enabled: boolean; host?: string; port?: number; names: string[] };
  publicBaseUrl?: string;
}

export interface CatalogSettingsBackup {
  autoRefresh: boolean;
  url: string;
}

/** What a backup holds once opened. */
export interface BackupBundle {
  version: 1;
  createdAt: string;
  /** The HarnessHub that made it (`HarnessHub <version>`). */
  app: string;
  /** Whether credential values are included. */
  keys: boolean;
  providers: BackupProvider[];
  groups: RouteGroup[];
  settings: {
    gatewayShare?: GatewayShareSettings;
    catalog?: CatalogSettingsBackup;
  };
  agents: AgentIntent[];
  /** Wiring profiles; absent in a backup from before them, which restores none. */
  profiles?: WiringProfile[];
  clientKeys: ClientKeyIntent[];
}

/** The parts of the agent wiring service a restore uses (AgentWiringService). */
export interface AgentWirings {
  /** Fails with WIRING_ADAPTER_UNKNOWN for an unknown agent, AGENT_WIRING_UNAVAILABLE without a wiring home. */
  get(id: string): Promise<{
    installation: { status: "installed" | "configured-only" | "not-found" };
  }>;
  plan(
    id: string,
    request: WiringRequest,
  ): Promise<{
    files: ReadonlyArray<{ path: string; exists: boolean; hash?: string }>;
  }>;
  wire(
    id: string,
    request: WiringRequest,
    expect: {
      files: ReadonlyArray<{ path: string; exists: boolean; hash?: string }>;
    },
  ): Promise<unknown>;
  /** Replaces the models hidden from a wired agent, keeping its key. */
  setHidden(id: string, hidden: string[]): Promise<unknown>;
}

export interface BackupServiceOptions {
  store: ModelPlaneStore & ModelMetadataStore & AgentWiringStore;
  secrets: Pick<ManagedSecrets, "create" | "delete" | "resolve">;
  /** The daemon's environment snapshot, for `env` credential references. */
  environment: Readonly<NodeJS.ProcessEnv>;
  agents: AgentWirings;
  /** LAN sharing; absent, its settings are neither saved nor restored. */
  share?: GatewayShareControl;
  /** The catalog settings this daemon was started with (from its configuration). */
  catalog: CatalogSettingsBackup;
  /** `HarnessHub <version>`. */
  app: string;
  clock?: () => Date;
}

export type AgentAction =
  | "wire"
  | "unchanged"
  | "skip-disabled"
  | "skip-not-installed"
  | "skip-unknown"
  | "skip-unavailable";

/** What a restore does (dry run) or did. */
export interface RestoreSummary {
  createdAt: string;
  app: string;
  keys: boolean;
  providers: {
    added: string[];
    replaced: string[];
    /** Restored without any credential: neither the backup nor this machine has a key. */
    needKey: string[];
  };
  groups: {
    added: string[];
    replaced: string[];
    /** A member names a provider that is neither in the backup nor here. */
    skipped: string[];
  };
  overrides: number;
  profiles: { added: string[]; replaced: string[] };
  gatewayShare: {
    action: "apply" | "unchanged" | "absent" | "unavailable";
    settings?: GatewayShareSettings;
    /** Why applying failed; the settings stayed as they were. */
    error?: string;
  };
  catalog: {
    backup: CatalogSettingsBackup;
    current: CatalogSettingsBackup;
    /** The settings come from the configuration file; a restore only reports them. */
    differs: boolean;
  } | null;
  agents: Array<
    AgentIntent & {
      action: AgentAction;
      /** After a restore: whether wiring succeeded. */
      outcome?: "wired" | "failed";
      error?: string;
    }
  >;
  /** Client keys to issue again with `hh key create`. */
  clientKeys: ClientKeyIntent[];
}

/** What a mirror of the server's providers part did that it was asked not to see. */
export interface MirrorResult {
  /** Providers and groups the server no longer holds, kept because Gateway Keys still allow them. */
  kept: string[];
}

/**
 * Backups, restores and the record-level writes sync shares with them. Every
 * operation runs after the previous one settled; writes of the model-plane
 * API in between land between records.
 */
export class BackupService {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: BackupServiceOptions) {}

  /**
   * Collects and seals a backup. With `keys`, the values of stored
   * credentials are read from the secret store and included; outside
   * references (env, file, keychain) are kept as references either way, and
   * provider headers whose names look like keys are left out without keys.
   *
   * @throws BackupError `BACKUP_INVALID` for an empty passphrase.
   */
  async create(input: {
    passphrase: string;
    keys: boolean;
  }): Promise<BackupEnvelope> {
    if (!input.passphrase)
      throw new BackupError("BACKUP_INVALID", "A backup needs a passphrase");
    const bundle = await this.serial(() => this.collect({ keys: input.keys }));
    return seal(encodeBundle(bundle), input.passphrase);
  }

  /**
   * Opens a sealed backup and shows what restoring it would do
   * (`dryRun`), or restores it: providers, then groups, the sharing
   * settings, and the agents installed here (unless `agents` is false),
   * each through the agent wiring service's plan and apply.
   *
   * @throws BackupError for a backup that does not open or is invalid.
   */
  async restore(input: {
    backup: unknown;
    passphrase: string;
    agents: boolean;
    dryRun: boolean;
  }): Promise<RestoreSummary> {
    const bundle = decodeBundle(await open(input.backup, input.passphrase));
    return this.serial(async () => {
      const summary = await this.summarize(bundle, input.agents);
      return input.dryRun ? summary : this.apply(bundle, summary);
    });
  }

  /**
   * The bundle as this machine is now. `agents: false` leaves the wirings out
   * (sync configured without agents).
   */
  async collect(
    options: { keys: boolean; agents?: boolean } = { keys: true },
  ): Promise<BackupBundle> {
    const { store } = this.options;
    const providers: BackupProvider[] = [];
    for (const provider of await store.listProviders()) {
      const { credentials, headers, ...rest } = provider;
      const kept =
        headers && !options.keys
          ? Object.fromEntries(
              Object.entries(headers).filter(
                ([name]) => !SECRET_NAME.test(name),
              ),
            )
          : headers;
      providers.push({
        config: { ...rest, ...(kept ? { headers: kept } : {}) },
        credentials: await Promise.all(
          credentials.map((credential) =>
            this.backupCredential(credential, options.keys),
          ),
        ),
        provenance: await store.listModelProvenance(provider.id),
        overrides: await store.listModelOverrides(provider.id),
      });
    }
    const keys = await store.listGatewayKeys();
    const active = keys.filter((key) => key.revokedAt === undefined);
    const agents: AgentIntent[] = [];
    if (options.agents !== false)
      for (const wiring of await store.listWirings()) {
        const key =
          wiring.keyId === undefined
            ? undefined
            : keys.find((item) => item.keyId === wiring.keyId);
        agents.push({
          agent: wiring.adapterId,
          ...choiceOf(wiring),
          models: key
            ? [...key.modelAllow]
            : wiring.model !== undefined
              ? [wiring.model]
              : [],
          ...(key?.modelDeny?.length ? { deny: [...key.modelDeny] } : {}),
        });
      }
    const share = this.options.share?.status();
    return {
      version: 1,
      createdAt: this.now(),
      app: this.options.app,
      keys: options.keys,
      providers,
      groups: await store.listRouteGroups(),
      settings: {
        ...(share ? { gatewayShare: shareSettings(share) } : {}),
        catalog: { ...this.options.catalog },
      },
      agents: agents.sort((a, b) => a.agent.localeCompare(b.agent)),
      profiles: await store.listWiringProfiles(),
      clientKeys: active.flatMap((key): ClientKeyIntent[] =>
        key.scope.kind === "client"
          ? [
              {
                name: key.name,
                modelAllow: [...key.modelAllow],
                allowLan: key.allowLan === true,
                ...(key.quota ? { quota: key.quota } : {}),
                ...(key.expiresAt ? { expiresAt: key.expiresAt } : {}),
              },
            ]
          : [],
      ),
    };
  }

  /**
   * Writes the bundle's providers and groups. Without `mirror` this is a
   * restore: same ids replaced, others added. With `mirror` (sync), providers
   * and groups that the bundle lacks are deleted too, except those Gateway
   * Keys still allow, which are kept and named in the result.
   */
  async bringProviders(
    bundle: BackupBundle,
    mirror: boolean,
  ): Promise<MirrorResult> {
    const { store } = this.options;
    for (const provider of bundle.providers)
      await this.writeProvider(provider, bundle.keys);
    const providers = new Set<string>(
      (await store.listProviders()).map((item) => item.id),
    );
    for (const group of bundle.groups)
      if (memberProviders(group).every((id) => providers.has(id)))
        await store.putRouteGroup(group);
    const kept: string[] = [];
    if (!mirror) return { kept };
    const allowed = (await store.listGatewayKeys())
      .filter((key) => key.revokedAt === undefined)
      .flatMap((key) => key.modelAllow);
    for (const group of await store.listRouteGroups())
      if (!bundle.groups.some((item) => item.id === group.id)) {
        if (allowed.includes(`group/${group.id}`))
          kept.push(`group/${group.id}`);
        else await store.deleteRouteGroup(group.id);
      }
    const groups = await store.listRouteGroups();
    for (const provider of await store.listProviders()) {
      if (bundle.providers.some((item) => item.config.id === provider.id))
        continue;
      const used =
        allowed.some((entry) => namesProvider(entry, provider.id)) ||
        groups.some((group) => memberProviders(group).includes(provider.id));
      if (used) {
        kept.push(provider.id);
        continue;
      }
      // Secrets first: a failure leaves the provider, and the next sync
      // finishes the job.
      for (const credential of provider.credentials)
        if (credential.ref.kind === "store")
          await this.options.secrets.delete(credential.ref);
      await store.deleteProvider(provider.id);
    }
    return { kept };
  }

  /**
   * Wires the agents installed here to the bundle's intents through plan and
   * apply, one at a time; one that fails leaves the others to go in.
   * `outcomes` are given for every intent.
   */
  async bringAgents(
    intents: readonly AgentIntent[],
    enabled = true,
  ): Promise<RestoreSummary["agents"]> {
    const planned = await this.planAgents(intents, enabled);
    return this.applyAgents(planned);
  }

  /**
   * Writes wiring profiles: the same name replaced, the others added. With
   * `mirror` (sync), profiles that `profiles` lacks are deleted. A profile
   * only names choices; applying it stays the user's step.
   */
  async bringProfiles(
    profiles: readonly WiringProfile[],
    mirror: boolean,
  ): Promise<void> {
    const { store } = this.options;
    for (const profile of profiles) await store.putWiringProfile(profile);
    if (mirror)
      for (const profile of await store.listWiringProfiles())
        if (!profiles.some((item) => item.name === profile.name))
          await store.deleteWiringProfile(profile.name);
  }

  /**
   * When a sync part was last changed here, as its records tell: the newest
   * `updatedAt` of providers, groups and overrides, of profiles, or
   * `wiredAt` of the wirings. A deletion leaves no time, so it does not count.
   */
  async lastChange(
    part: "providers" | "agents" | "profiles",
  ): Promise<string | undefined> {
    const { store } = this.options;
    const times: string[] = [];
    if (part === "agents")
      for (const wiring of await store.listWirings())
        times.push(wiring.wiredAt);
    else if (part === "profiles")
      for (const profile of await store.listWiringProfiles())
        times.push(profile.updatedAt);
    else {
      for (const provider of await store.listProviders()) {
        times.push(provider.updatedAt);
        for (const override of await store.listModelOverrides(provider.id))
          times.push(override.updatedAt);
      }
      for (const group of await store.listRouteGroups())
        times.push(group.updatedAt);
    }
    const latest = Math.max(...times.map((time) => Date.parse(time)));
    return Number.isFinite(latest) ? new Date(latest).toISOString() : undefined;
  }

  /** Runs `action` after every operation before it settled. */
  serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action, action);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async summarize(
    bundle: BackupBundle,
    agents: boolean,
  ): Promise<RestoreSummary> {
    const { store } = this.options;
    const here = new Map(
      (await store.listProviders()).map((item) => [item.id as string, item]),
    );
    const providers: RestoreSummary["providers"] = {
      added: [],
      replaced: [],
      needKey: [],
    };
    for (const provider of bundle.providers) {
      const local = here.get(provider.config.id);
      (local ? providers.replaced : providers.added).push(provider.config.id);
      if (
        provider.credentials.length > 0 &&
        credentialPlan(provider, local, bundle.keys).length === 0
      )
        providers.needKey.push(provider.config.id);
    }
    const ids = new Set([
      ...here.keys(),
      ...bundle.providers.map((item) => item.config.id),
    ]);
    const groupsHere = new Set(
      (await store.listRouteGroups()).map((item) => item.id as string),
    );
    const groups: RestoreSummary["groups"] = {
      added: [],
      replaced: [],
      skipped: [],
    };
    for (const group of bundle.groups)
      (!memberProviders(group).every((id) => ids.has(id))
        ? groups.skipped
        : groupsHere.has(group.id)
          ? groups.replaced
          : groups.added
      ).push(group.id);
    const profilesHere = new Set(
      (await store.listWiringProfiles()).map((item) => item.name),
    );
    const profiles: RestoreSummary["profiles"] = { added: [], replaced: [] };
    for (const profile of bundle.profiles ?? [])
      (profilesHere.has(profile.name)
        ? profiles.replaced
        : profiles.added
      ).push(profile.name);
    return {
      createdAt: bundle.createdAt,
      app: bundle.app,
      keys: bundle.keys,
      providers,
      groups,
      overrides: bundle.providers.reduce(
        (total, item) => total + item.overrides.length,
        0,
      ),
      profiles,
      gatewayShare: this.planShare(bundle.settings.gatewayShare),
      catalog: bundle.settings.catalog
        ? {
            backup: bundle.settings.catalog,
            current: this.options.catalog,
            differs:
              bundle.settings.catalog.autoRefresh !==
                this.options.catalog.autoRefresh ||
              bundle.settings.catalog.url !== this.options.catalog.url,
          }
        : null,
      agents: await this.planAgents(bundle.agents, agents),
      clientKeys: bundle.clientKeys,
    };
  }

  private async apply(
    bundle: BackupBundle,
    summary: RestoreSummary,
  ): Promise<RestoreSummary> {
    await this.bringProviders(bundle, false);
    await this.bringProfiles(bundle.profiles ?? [], false);
    const gatewayShare = { ...summary.gatewayShare };
    if (gatewayShare.action === "apply" && this.options.share)
      try {
        await this.options.share.update(gatewayShare.settings);
      } catch (error) {
        if (!(error instanceof HubError)) throw error;
        gatewayShare.error = `${error.code}: ${error.message}`;
      }
    return {
      ...summary,
      gatewayShare,
      agents: await this.applyAgents(summary.agents),
    };
  }

  private planShare(
    settings: GatewayShareSettings | undefined,
  ): RestoreSummary["gatewayShare"] {
    if (!settings) return { action: "absent" };
    if (!this.options.share) return { action: "unavailable", settings };
    const current = shareSettings(this.options.share.status());
    return {
      action:
        JSON.stringify(canonical(current)) ===
        JSON.stringify(canonical(settings))
          ? "unchanged"
          : "apply",
      settings,
    };
  }

  private async planAgents(
    intents: readonly AgentIntent[],
    enabled: boolean,
  ): Promise<RestoreSummary["agents"]> {
    const planned: RestoreSummary["agents"] = [];
    for (const intent of intents) {
      if (!enabled) {
        planned.push({ ...intent, action: "skip-disabled" });
        continue;
      }
      let action: AgentAction;
      try {
        const agent = await this.options.agents.get(intent.agent);
        const current = await this.intentOf(intent.agent);
        action =
          agent.installation.status === "not-found"
            ? "skip-not-installed"
            : current && sameIntent(current, intent)
              ? "unchanged"
              : "wire";
      } catch (error) {
        if (!(error instanceof HubError)) throw error;
        action =
          error.code === "WIRING_ADAPTER_UNKNOWN"
            ? "skip-unknown"
            : "skip-unavailable";
      }
      planned.push({ ...intent, action });
    }
    return planned;
  }

  private async applyAgents(
    planned: RestoreSummary["agents"],
  ): Promise<RestoreSummary["agents"]> {
    const done: RestoreSummary["agents"] = [];
    for (const item of planned) {
      if (item.action !== "wire") {
        done.push(item);
        continue;
      }
      const { agents } = this.options;
      const request = requestOf(item);
      const deny = item.deny ?? [];
      try {
        // Models hidden here that the intent chooses would refuse the
        // wiring: they are shown first, and the intent's hidden models are
        // set once the agent is wired to its own choice.
        const current = await this.intentOf(item.agent);
        const chosen = [
          ...(item.model !== undefined ? [item.model] : []),
          ...Object.values(item.tiers ?? {}),
        ];
        if (
          current?.deny?.length &&
          chosen.some((ref) => !modelAllowed(["*"], ref, current.deny ?? []))
        )
          await agents.setHidden(item.agent, []);
        const plan = await agents.plan(item.agent, request);
        await agents.wire(item.agent, request, plan);
        const wired = await this.intentOf(item.agent);
        if (item.model !== undefined && !sameSet(wired?.deny ?? [], deny))
          await agents.setHidden(item.agent, deny);
        done.push({ ...item, outcome: "wired" });
      } catch (error) {
        if (!(error instanceof HubError)) throw error;
        done.push({
          ...item,
          outcome: "failed",
          error: `${error.code}: ${error.message}`,
        });
      }
    }
    return done;
  }

  /** The agent's wiring here as an intent; undefined when it is not wired. */
  private async intentOf(agent: string): Promise<AgentIntent | undefined> {
    const { store } = this.options;
    const wiring = (await store.listWirings()).find(
      (record) => record.adapterId === agent,
    );
    if (!wiring) return undefined;
    const key =
      wiring.keyId === undefined
        ? undefined
        : await store.getGatewayKey(wiring.keyId);
    return {
      agent,
      ...choiceOf(wiring),
      models: key
        ? [...key.modelAllow]
        : wiring.model !== undefined
          ? [wiring.model]
          : [],
      ...(key?.modelDeny?.length ? { deny: [...key.modelDeny] } : {}),
    };
  }

  /**
   * Writes one provider with its credentials, provenance and overrides. New
   * secrets are stored before the provider is written and removed again if
   * the write fails; secrets of this machine that the provider no longer
   * refers to are removed after it is written.
   */
  private async writeProvider(
    provider: BackupProvider,
    keys: boolean,
  ): Promise<void> {
    const { store, secrets } = this.options;
    const local = await store.getProvider(provider.config.id);
    const created: SecretReference[] = [];
    const credentials: ProviderCredential[] = [];
    for (const entry of credentialPlan(provider, local, keys)) {
      if (entry.own && entry.value === undefined && !entry.reference) {
        credentials.push(entry.own);
        continue;
      }
      let ref: SecretReference;
      if (entry.reference) ref = entry.reference;
      else if (
        entry.own?.ref.kind === "store" &&
        (await this.resolve(entry.own.ref)) === entry.value
      )
        ref = entry.own.ref;
      else {
        ref = await secrets.create(entry.value!);
        created.push(ref);
      }
      credentials.push({
        id: entry.item!.id,
        name: entry.item!.name,
        ref,
        ...(entry.item!.protocols ? { protocols: entry.item!.protocols } : {}),
        enabled: entry.item!.enabled,
      });
    }
    // Headers that look like keys stay as this machine has them when the
    // backup carries none.
    const ownHeaders = keys
      ? []
      : Object.entries(local?.headers ?? {}).filter(([name]) =>
          SECRET_NAME.test(name),
        );
    const headers = {
      ...provider.config.headers,
      ...Object.fromEntries(ownHeaders),
    };
    const { headers: _ignored, ...rest } = provider.config;
    const config = {
      ...rest,
      ...(Object.keys(headers).length ? { headers } : {}),
      credentials,
    };
    try {
      if (!isProviderConfig(config))
        throw new BackupError(
          "BACKUP_INVALID",
          `The provider ${provider.config.id} in the backup is invalid`,
        );
      const overrides = local ? await store.listModelOverrides(local.id) : [];
      const changes: OverrideChange[] = [
        ...overrides
          .filter(
            (own) => !provider.overrides.some((item) => item.ref === own.ref),
          )
          .map((own): OverrideChange => ({ delete: own.ref })),
        ...provider.overrides.map((item): OverrideChange => ({ put: item })),
      ];
      if (!changes.length)
        await store.putProviderMetadata(config, provider.provenance);
      for (const change of changes)
        await store.putProviderMetadata(config, provider.provenance, change);
    } catch (error) {
      const failed: unknown[] = [];
      for (const ref of created)
        try {
          await secrets.delete(ref);
        } catch (cleanup) {
          failed.push(cleanup);
        }
      if (failed.length)
        throw new AggregateError(
          [error, ...failed],
          "Writing a restored provider failed and its new secrets could not all be removed",
        );
      throw error;
    }
    for (const old of local?.credentials ?? [])
      if (
        old.ref.kind === "store" &&
        !credentials.some(
          (item) =>
            item.ref.kind === "store" && item.ref.value === old.ref.value,
        )
      )
        await secrets.delete(old.ref);
  }

  private async backupCredential(
    credential: ProviderCredential,
    keys: boolean,
  ): Promise<BackupCredential> {
    const { ref } = credential;
    return {
      id: credential.id,
      name: credential.name,
      ...(credential.protocols ? { protocols: credential.protocols } : {}),
      enabled: credential.enabled,
      secret:
        ref.kind === "store"
          ? {
              source: "store",
              ...(keys ? { value: await this.resolve(ref) } : {}),
            }
          : { source: "reference", kind: ref.kind, name: ref.value },
    };
  }

  private resolve(ref: SecretReference): Promise<string> {
    return this.options.secrets.resolve(ref, this.options.environment);
  }

  private now(): string {
    return (this.options.clock?.() ?? new Date()).toISOString();
  }
}

/** The choices of a wiring, as an intent keeps them. */
function choiceOf(record: WiringChoice): WiringChoice {
  return {
    ...(record.model !== undefined ? { model: record.model } : {}),
    ...(record.tiers && Object.keys(record.tiers).length
      ? { tiers: { ...record.tiers } }
      : {}),
    ...(record.effort !== undefined ? { effort: record.effort } : {}),
    ...(record.options && Object.keys(record.options).length
      ? { options: { ...record.options } }
      : {}),
  };
}

/**
 * The wiring request for an intent: its choices exactly (unset tiers and
 * effort cleared) and the models it lists; only options for an agent that
 * signs in by itself.
 */
function requestOf(intent: AgentIntent): WiringRequest {
  return {
    ...(intent.model !== undefined
      ? {
          model: intent.model,
          models: intent.models,
          tiers: intent.tiers ?? {},
          effort: intent.effort ?? null,
        }
      : {}),
    ...(intent.options ? { options: intent.options } : {}),
  };
}

/** Whether two intents wire an agent the same way. */
function sameIntent(left: AgentIntent, right: AgentIntent): boolean {
  const normal = (intent: AgentIntent) =>
    JSON.stringify(
      canonical({
        model: intent.model ?? null,
        tiers: intent.tiers ?? {},
        effort: intent.effort ?? null,
        options: intent.options ?? {},
        models: [...intent.models].sort(),
        deny: [...(intent.deny ?? [])].sort(),
      }),
    );
  return normal(left) === normal(right);
}

/**
 * The credentials a restored provider gets, in order: the backup's (an
 * outside reference as it is, a stored value, or this machine's credential
 * of the same id for a stored one without value); then, from a backup
 * without keys, this machine's other credentials, so that its keys stay. A
 * stored credential with neither a value nor one here is left out.
 */
function credentialPlan(
  provider: BackupProvider,
  local: ProviderConfig | undefined,
  keys: boolean,
): Array<{
  item?: BackupCredential;
  own?: ProviderCredential;
  value?: string;
  reference?: SecretReference;
}> {
  const plan: ReturnType<typeof credentialPlan> = [];
  for (const item of provider.credentials) {
    const own = local?.credentials.find((entry) => entry.id === item.id);
    if (item.secret.source === "reference")
      plan.push({
        item,
        reference: { kind: item.secret.kind, value: item.secret.name },
      });
    else if (item.secret.value !== undefined)
      plan.push({ item, value: item.secret.value, ...(own ? { own } : {}) });
    else if (own) plan.push({ own });
  }
  if (!keys)
    for (const own of local?.credentials ?? [])
      if (!provider.credentials.some((item) => item.id === own.id))
        plan.push({ own });
  return plan;
}

/** The bundle as the bytes that are sealed. */
export function encodeBundle(bundle: BackupBundle): Buffer {
  return Buffer.from(JSON.stringify(bundle), "utf8");
}

/**
 * Validates opened bytes as a bundle (they come from a file or a server).
 *
 * @throws BackupError `BACKUP_UNSUPPORTED` for a newer bundle version,
 *   `BACKUP_INVALID` for anything that does not form a valid bundle.
 */
export function decodeBundle(bytes: Buffer): BackupBundle {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw invalidBundle("is not JSON");
  }
  if (!object(value)) throw invalidBundle("is not an object");
  if (typeof value.version === "number" && value.version > 1)
    throw new BackupError(
      "BACKUP_UNSUPPORTED",
      "This backup was made by a newer HarnessHub; update HarnessHub to open it",
    );
  if (value.version !== 1) throw invalidBundle("has no supported version");
  if (!isTimestamp(value.createdAt) || typeof value.app !== "string")
    throw invalidBundle("has no creation time or application");
  if (typeof value.keys !== "boolean") throw invalidBundle("lacks keys");
  if (
    !Array.isArray(value.providers) ||
    !value.providers.every(isBackupProvider)
  )
    throw invalidBundle("has an invalid provider");
  const ids = value.providers.map((item) => item.config.id);
  if (new Set(ids).size !== ids.length)
    throw invalidBundle("names a provider twice");
  if (!Array.isArray(value.groups) || !value.groups.every(isRouteGroup))
    throw invalidBundle("has an invalid route group");
  const settings = value.settings;
  if (
    !object(settings) ||
    (settings.gatewayShare !== undefined &&
      !isShareSettings(settings.gatewayShare)) ||
    (settings.catalog !== undefined && !isCatalogSettings(settings.catalog))
  )
    throw invalidBundle("has invalid settings");
  if (!Array.isArray(value.agents) || !value.agents.every(isAgentIntent))
    throw invalidBundle("has an invalid agent wiring");
  if (
    value.profiles !== undefined &&
    !(
      Array.isArray(value.profiles) &&
      value.profiles.every(isWiringProfile) &&
      new Set(value.profiles.map((item) => item.name)).size ===
        value.profiles.length
    )
  )
    throw invalidBundle("has an invalid wiring profile");
  if (!Array.isArray(value.clientKeys) || !value.clientKeys.every(isClientKey))
    throw invalidBundle("has an invalid client key");
  return value as unknown as BackupBundle;
}

function invalidBundle(detail: string): BackupError {
  return new BackupError("BACKUP_INVALID", `The backup content ${detail}`);
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const strings = (value: unknown, max = 1000): value is string[] =>
  Array.isArray(value) &&
  value.length <= max &&
  value.every((item) => typeof item === "string" && item.length <= 512);

function isBackupProvider(value: unknown): value is BackupProvider {
  if (!object(value) || !object(value.config)) return false;
  if (!isProviderConfig({ ...value.config, credentials: [] })) return false;
  const id = value.config.id as string;
  const owns = (ref: string) => {
    const parsed = parseModelRef(ref);
    return parsed?.kind === "model" && parsed.provider === id;
  };
  return (
    Array.isArray(value.credentials) &&
    value.credentials.every(isBackupCredential) &&
    new Set(value.credentials.map((item) => item.id)).size ===
      value.credentials.length &&
    Array.isArray(value.provenance) &&
    value.provenance.every(
      (item) => isModelProvenance(item) && owns(item.ref),
    ) &&
    Array.isArray(value.overrides) &&
    value.overrides.every((item) => isModelOverride(item) && owns(item.ref))
  );
}

function isBackupCredential(value: unknown): value is BackupCredential {
  if (
    !object(value) ||
    typeof value.id !== "string" ||
    !value.id ||
    value.id.length > 200 ||
    typeof value.name !== "string" ||
    !value.name ||
    value.name.length > 200 ||
    typeof value.enabled !== "boolean" ||
    (value.protocols !== undefined &&
      !(
        Array.isArray(value.protocols) &&
        value.protocols.every((item) =>
          (wireProtocols as readonly unknown[]).includes(item),
        )
      )) ||
    !object(value.secret)
  )
    return false;
  const secret = value.secret;
  return secret.source === "store"
    ? secret.value === undefined ||
        (typeof secret.value === "string" && secret.value.length > 0)
    : secret.source === "reference" &&
        ["env", "file", "keychain"].includes(secret.kind as string) &&
        typeof secret.name === "string" &&
        secret.name.length > 0;
}

function isShareSettings(value: unknown): value is GatewayShareSettings {
  return (
    object(value) &&
    object(value.lan) &&
    typeof value.lan.enabled === "boolean" &&
    (value.lan.host === undefined || typeof value.lan.host === "string") &&
    (value.lan.port === undefined || typeof value.lan.port === "number") &&
    strings(value.lan.names, 20) &&
    (value.publicBaseUrl === undefined ||
      typeof value.publicBaseUrl === "string")
  );
}

function isCatalogSettings(value: unknown): value is CatalogSettingsBackup {
  return (
    object(value) &&
    typeof value.autoRefresh === "boolean" &&
    typeof value.url === "string"
  );
}

function isAgentIntent(value: unknown): value is AgentIntent {
  const patterns = (item: unknown) =>
    strings(item) && item.every((entry) => isModelPattern(entry));
  const ref = (item: unknown) =>
    typeof item === "string" && parseModelRef(item) !== undefined;
  return (
    object(value) &&
    typeof value.agent === "string" &&
    /^[a-z0-9][a-z0-9-]{0,62}$/.test(value.agent) &&
    (value.model === undefined || ref(value.model)) &&
    patterns(value.models) &&
    (value.deny === undefined || patterns(value.deny)) &&
    (value.tiers === undefined ||
      (object(value.tiers) &&
        Object.entries(value.tiers).every(
          ([tier, model]) =>
            (wiringTiers as readonly string[]).includes(tier) && ref(model),
        ))) &&
    (value.effort === undefined ||
      (reasoningEfforts as readonly unknown[]).includes(value.effort)) &&
    (value.options === undefined ||
      (object(value.options) &&
        Object.values(value.options).every(
          (option) => typeof option === "string",
        )))
  );
}

function isClientKey(value: unknown): value is ClientKeyIntent {
  return (
    object(value) &&
    typeof value.name === "string" &&
    value.name.length > 0 &&
    value.name.length <= 200 &&
    strings(value.modelAllow) &&
    typeof value.allowLan === "boolean" &&
    (value.quota === undefined || object(value.quota)) &&
    (value.expiresAt === undefined || isTimestamp(value.expiresAt))
  );
}

/** The settings part of a sharing status. */
function shareSettings(status: GatewayShareStatus): GatewayShareSettings {
  return {
    lan: {
      enabled: status.lan.enabled,
      ...(status.lan.host !== undefined ? { host: status.lan.host } : {}),
      ...(status.lan.port !== undefined ? { port: status.lan.port } : {}),
      names: [...status.lan.names],
    },
    ...(status.publicBaseUrl !== undefined
      ? { publicBaseUrl: status.publicBaseUrl }
      : {}),
  };
}

/** A value with object keys sorted, for comparing and hashing. */
export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (object(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}

/** The providers a group's members name. */
function memberProviders(group: RouteGroup): string[] {
  return group.members.flatMap((member) => {
    const parsed = parseModelRef(member);
    return parsed?.kind === "model" ? [parsed.provider] : [];
  });
}

/** Whether an allowlist entry names a provider's models (`p/*` or `p/model`). */
function namesProvider(entry: string, provider: string): boolean {
  const parsed = parseModelRef(entry);
  return parsed?.kind === "model" && parsed.provider === provider;
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    [...left].sort().join("\n") === [...right].sort().join("\n")
  );
}
