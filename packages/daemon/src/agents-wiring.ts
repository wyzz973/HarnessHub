// SPDX-License-Identifier: MIT
/**
 * Global wiring of the agents on this machine (04-agent-plane section 4) as
 * the daemon runs it: one `agent:<adapterId>` Gateway Key per wired agent,
 * whose text exists only in the agent's configuration files, the
 * `WiringRecord` in the model-plane store, the models each agent lists (the
 * key's allow and deny lists) and wiring profiles. The file edits, backups
 * and drift detection are `@harnesshub/agents/wiring`'s.
 */
import { HubError } from "@harnesshub/core/errors";
import { NO_LOG, type LogSink } from "@harnesshub/core/logging";
import {
  isModelPattern,
  issueGatewayKey,
  modelAllowed,
  parseModelRef,
  providerEnabled,
  type AgentWiringStore,
  type GatewayKeyId,
  type GatewayKeyRecord,
  type ModelPlaneStore,
  type ProviderModel,
  type ReasoningEffort,
  type WireProtocol,
  type WiringChoice,
  type WiringProfile,
  type WiringRecord,
  type WiringTier,
} from "@harnesshub/core/model-plane";
import { isWiringProfileName } from "@harnesshub/core/model-plane-records";
import {
  groupModels,
  modelEfforts,
  type GroupCapabilities,
} from "@harnesshub/core/route-groups";
import { ruledCapabilities } from "@harnesshub/core/route-rules";
import {
  applyWiring,
  detectAgent,
  detectDrift,
  isModelOptional,
  managedOverrides,
  planWiring,
  resolveOptions,
  restartNotice,
  unwire,
  wiredEntries,
  wiredKeyText,
  wiringAdapter,
  wiringAdapters,
  WiringError,
  type AgentInstallation,
  type ConfirmedPlan,
  type DriftReport,
  type ManagedOverride,
  type UnwireResult,
  type WiringAdapter,
  type WiringContext,
  type WiringModel,
  type WiringPlan,
  type WiringTarget,
} from "@harnesshub/agents/wiring/index";

/** Where agent configuration lives; absent, every wiring operation is refused. */
export interface WiringHome {
  /** The user's home directory (absolute). Only `hh serve` passes the real one. */
  home: string;
  /** The environment agents see: PATH for detection and directory overrides such as CODEX_HOME. */
  env: Readonly<Record<string, string | undefined>>;
  /**
   * For tests only: where system-wide files (Claude Code's managed settings)
   * are read; the file system root otherwise.
   */
  systemRoot?: string;
}

/**
 * A wiring preview with what the user must know before applying it: what
 * to do afterwards for the agent to use it (`notice`), and the entries an
 * administrator's policy sets over the ones written (`managed`), which then
 * have no effect.
 */
export type AgentWiringPlan = WiringPlan & {
  notice?: string;
  managed?: ManagedOverride[];
};

/** Settings of global wiring, resolved by `resolveWiringSettings`. */
export interface WiringSettings {
  /** Rewrite the model lists in wired agents' files when the gateway's models change. */
  autoSync: boolean;
}

/**
 * The `wiring` settings: `autoSync` (default true). Anything else, or a
 * value of the wrong type, fails with a HubError (startup fails).
 */
export function resolveWiringSettings(raw: unknown): WiringSettings {
  if (raw === undefined) return { autoSync: true };
  const invalid = () =>
    new HubError(
      "WIRING_SETTINGS_INVALID",
      "wiring takes only autoSync, a boolean",
      400,
    );
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw invalid();
  const { autoSync, ...rest } = raw as Record<string, unknown>;
  if (
    Object.keys(rest).length ||
    (autoSync !== undefined && typeof autoSync !== "boolean")
  )
    throw invalid();
  return { autoSync: autoSync ?? true };
}

/** How long catalog changes settle before the agents' model lists are rewritten. */
const SYNC_DELAY_MS = 500;

export interface AgentWiringOptions {
  store: ModelPlaneStore & AgentWiringStore;
  dataDir: string;
  home: WiringHome | undefined;
  /** The gateway origin agents are pointed at; undefined until the listener is bound. */
  origin: () => string | undefined;
  /**
   * Whether the gateway answers hosted web search tools itself (a search
   * backend is configured), read for every plan; false when absent.
   */
  gatewaySearch?: () => boolean;
  settings?: WiringSettings;
  clock?: () => Date;
  log?: LogSink;
}

/** The state of one wired agent. */
export interface AgentWiringView extends WiringChoice {
  /** The models the agent lists and its key may use: the gateway's models minus the hidden ones. Empty without a key. */
  models: string[];
  /** Models hidden from the agent (its key's deny list); models added to the gateway later are shown. */
  hidden: string[];
  /** Absent when the agent signs in by itself and has no key. */
  keyId?: GatewayKeyId;
  /** `suspended`: the key is refused until it is resumed (`hh key resume`); unwiring still revokes it. */
  keyState: "active" | "suspended" | "revoked" | "expired" | "missing" | "none";
  wiredAt: string;
  files: string[];
  drift: Pick<DriftReport, "drifted" | "kinds" | "findings"> | null;
  /** Why drift could not be checked (for example a missing backup). */
  driftError?: string;
  /**
   * Why the last catalog sync left this agent's files as they were (the
   * user changed them, or its key is gone), until a sync or a wiring
   * operation succeeds; or that a model it is wired to or allowed has left
   * the gateway (`AGENT_MODEL_UNAVAILABLE`, its provider switched off or the
   * model removed), which is read from the catalog as the view is made and
   * so shows as soon as the change is committed. `at` is when the mark was
   * first made.
   */
  attention?: { code: string; message: string; at: string };
  /** Entries written that an administrator's policy overrides, so that they have no effect. */
  managed?: ManagedOverride[];
}

/** One agent as `GET /api/v1/agents` shows it. */
export interface AgentView {
  id: string;
  name: string;
  protocol: WireProtocol;
  keyDelivery: "config-file" | "env-file";
  /** What wiring can set for this agent besides its model. */
  capabilities: {
    tiers: WiringTier[];
    efforts: ReasoningEffort[];
    /** Option values, the default first. */
    options: Record<string, string[]>;
    /**
     * The option values (one of every option) with which the agent keeps
     * its own model unless one is named (`model: null`), such as Codex with
     * `{codexAuth: "chatgpt"}`; empty when it always takes a model.
     */
    ownModel: Array<Record<string, string>>;
  };
  /** What to do after wiring changes for the agent to use them (`restartNotice`); absent when it picks them up by itself. */
  notice?: string;
  installation: AgentInstallation;
  wiring: AgentWiringView | null;
}

/**
 * What to wire an agent to. Absent fields keep the current wiring's value:
 * the model, tiers, effort, options and the listed models; `tiers: {}`
 * clears the tiers and `effort: null` the effort. An agent that keeps its own
 * model with its options (Codex with `codexAuth: chatgpt`) is wired without
 * one unless one is named, and then without tiers or effort.
 */
export interface WiringRequest {
  /** null: none, for an agent that keeps its own model (Codex with `codexAuth: chatgpt`). */
  model?: string | null;
  /** The models the agent may list (`provider/model`, `provider/*`, `group/<id>`, `*`); default: the current list, else every model. */
  models?: string[];
  tiers?: Partial<Record<WiringTier, string>>;
  effort?: ReasoningEffort | null;
  options?: Record<string, string>;
}

/** One agent of a profile plan: unchanged agents have no plan. */
export interface ProfileAgentPlan {
  adapterId: string;
  changed: boolean;
  plan: AgentWiringPlan | null;
}

export interface ProfilePlan {
  profile: WiringProfile;
  agents: ProfileAgentPlan[];
}

export interface ProfileApplied {
  profile: WiringProfile;
  agents: Array<{
    adapterId: string;
    outcome: "applied" | "unchanged";
    agent: AgentView;
  }>;
}

/** What one wiring will write, worked out from a request and the current state. */
interface Prepared {
  options: Record<string, string>;
  /** Absent when the agent keeps its own model. */
  model?: string;
  tiers: Partial<Record<WiringTier, string>>;
  effort?: ReasoningEffort;
  allow: string[];
  deny: string[];
  /** The models the agent lists, with the gateway's metadata. */
  models: WiringModel[];
}

/**
 * Runs wiring operations one at a time. The key lifecycle follows 04 section
 * 4: a new key is issued for every wiring, written only into the agent's
 * files and never kept by the daemon; after the files are written and read
 * back and the record is committed, the previous key is revoked; on any
 * failure the new key is revoked instead. Unwire restores the files, then
 * revokes the key and deletes the record. Changing an agent's hidden models
 * keeps its key: the key's deny list changes in place and the files are
 * rewritten with the key they hold.
 */
export class AgentWiringService {
  private queue: Promise<unknown> = Promise.resolve();
  /** Agents the last catalog sync could not bring up to date, by adapter id. */
  private readonly attention = new Map<
    string,
    { code: string; message: string; at: string }
  >();
  private syncTimer: NodeJS.Timeout | undefined;
  private syncing: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly options: AgentWiringOptions) {}

  /**
   * Notes that the gateway's models may have changed (a provider saved or
   * removed, its models refreshed or enriched, a route group changed), or
   * whether it answers web search itself (search backends added or all
   * removed). After
   * changes settle, every wired agent's files are rewritten with the models
   * now visible to its key, through the normal plan and apply path with
   * backups, one agent at a time and in turn with other wiring operations.
   * An agent whose files the user changed since HarnessHub last wrote them
   * (drift), whose key is gone or not in its files, or whose model left the
   * gateway is left alone and marked `attention`. Does nothing when
   * `wiring.autoSync` is false, without a wiring home, or after `close`.
   */
  catalogChanged(): void {
    if (
      this.closed ||
      this.options.settings?.autoSync === false ||
      !this.options.home
    )
      return;
    clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => {
      this.syncTimer = undefined;
      this.syncing = this.serial(() => this.syncCatalog()).catch(
        (error: unknown) => {
          this.log.info("wiring.sync_failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        },
      );
    }, SYNC_DELAY_MS);
  }

  /** Stops scheduling catalog syncs and waits for one that is running. */
  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.syncTimer);
    this.syncTimer = undefined;
    await this.syncing;
  }

  /** One sync round over every wired agent with a key; failures are per agent. */
  private async syncCatalog(): Promise<void> {
    if (this.closed) return;
    const context = this.context();
    const origin = this.options.origin();
    if (!origin) return;
    for (const record of await this.options.store.listWirings()) {
      if (record.keyId === undefined || !wiringAdapters.has(record.adapterId))
        continue;
      try {
        const written = await this.syncOne(record, context, origin);
        this.attention.delete(record.adapterId);
        if (written)
          this.log.info("wiring.synced", { adapterId: record.adapterId });
      } catch (error) {
        const code =
          error instanceof HubError ? error.code : "WIRING_SYNC_FAILED";
        const message = error instanceof Error ? error.message : String(error);
        this.mark(record.adapterId, code, message);
        this.log.info("wiring.sync_skipped", {
          adapterId: record.adapterId,
          code,
        });
      }
    }
  }

  /** Rewrites one agent's files for the current catalog; false when nothing changed. */
  private async syncOne(
    record: WiringRecord,
    context: WiringContext,
    origin: string,
  ): Promise<boolean> {
    const adapterId = record.adapterId;
    const drift = await detectDrift(record, context, { baseUrl: origin });
    if (drift.drifted)
      throw new HubError(
        "AGENT_FILES_CHANGED",
        `${adapterId}'s configuration changed since HarnessHub wrote it (${drift.kinds.join(", ")}); its model list was not rewritten. Wire it again to take the change over or unwire it`,
        409,
      );
    const store = this.options.store;
    const key = await store.getGatewayKey(record.keyId!);
    if (!key || key.revokedAt)
      throw new HubError(
        "AGENT_KEY_INACTIVE",
        `The key of ${adapterId} is revoked or missing; rotate it with hh wire ${adapterId} --rotate`,
        409,
      );
    const keyText = await wiredKeyText(record, context);
    if (keyText === undefined)
      throw new HubError(
        "AGENT_KEY_NOT_IN_FILES",
        `The configuration of ${adapterId} no longer holds its key; rotate it with hh wire ${adapterId} --rotate`,
        409,
      );
    const prepared = await this.prepare(
      adapterId,
      { models: key.modelAllow },
      record,
      key.modelDeny ?? [],
    );
    const target = this.target(prepared, { text: keyText, keyId: key.keyId });
    const plan = await planWiring(adapterId, target, context, {
      previous: record,
    });
    if (!plan.changed) return false;
    const { record: next } = await applyWiring(adapterId, target, context, {
      previous: record,
      expect: plan,
    });
    await store.putWiring(next);
    return true;
  }

  /**
   * Every supported agent with installation, wiring and drift. Waits for a
   * wiring operation or catalog sync in progress: those write the files
   * before the record, and a view between the two would report drift.
   */
  list(): Promise<AgentView[]> {
    return this.serial(() => this.listNow());
  }

  private async listNow(): Promise<AgentView[]> {
    const context = this.context();
    const wirings = await this.options.store.listWirings();
    const catalog = await gatewayModels(this.options.store);
    const views: AgentView[] = [];
    for (const adapter of wiringAdapters.values())
      views.push(
        await this.view(
          adapter.id,
          context,
          wirings.find((record) => record.adapterId === adapter.id),
          catalog,
        ),
      );
    return views;
  }

  /**
   * One agent; an unknown id fails with WIRING_ADAPTER_UNKNOWN (404). Waits
   * for a wiring operation or sync in progress, as `list` does.
   */
  async get(adapterId: string): Promise<AgentView> {
    wiringAdapter(adapterId);
    return this.serial(async () =>
      this.view(adapterId, this.context(), await this.wiringOf(adapterId)),
    );
  }

  /**
   * The edits wiring would make, with a throwaway key that is never stored:
   * the preview masks key text anyway, and applying issues the real key.
   */
  async plan(
    adapterId: string,
    request: WiringRequest,
  ): Promise<AgentWiringPlan> {
    const adapter = wiringAdapter(adapterId);
    const context = this.context();
    const previous = await this.wiringOf(adapterId);
    const prepared = await this.prepare(adapterId, request, previous);
    const issued = issueGatewayKey({ kind: "agent", adapterId });
    const plan = await planWiring(
      adapterId,
      this.target(prepared, { text: issued.text, keyId: issued.keyId }),
      context,
      previous ? { previous } : {},
    );
    // What it writes in the file an administrator's policy can override.
    const first = plan.files.find((file) => file.id === adapter.files[0]?.id);
    const managed = await managedOverrides(
      adapterId,
      [
        ...(first?.changes.map((change) => change.keyPath) ?? []),
        ...(previous ? await wiredEntries(previous, context) : []),
      ],
      context,
    );
    const notice = restartNotice(adapter);
    return {
      ...plan,
      ...(notice ? { notice } : {}),
      ...(managed.length ? { managed } : {}),
    };
  }

  /** Wires the agent as requested with a new key (none when it signs in by itself), after checking the confirmed plan. */
  async wire(
    adapterId: string,
    request: WiringRequest,
    expect: ConfirmedPlan | undefined,
  ): Promise<AgentView> {
    wiringAdapter(adapterId);
    return this.serial(() => this.wireNow(adapterId, request, expect));
  }

  /**
   * Re-wires the agent with the same choices and a new key; the old key is
   * revoked. A record wired without a key (Codex's ChatGPT mode before it
   * took one) gets its first.
   */
  async rotate(adapterId: string): Promise<AgentView> {
    wiringAdapter(adapterId);
    return this.serial(async () => {
      await this.required(adapterId);
      return this.wireNow(adapterId, {}, undefined);
    });
  }

  /** Restores the agent's files, revokes its key and deletes the record. */
  async unwire(
    adapterId: string,
  ): Promise<{ agent: AgentView; files: UnwireResult["files"] }> {
    wiringAdapter(adapterId);
    return this.serial(async () => {
      const context = this.context();
      const record = await this.required(adapterId);
      const result = await unwire(record, context);
      if (record.keyId !== undefined)
        await this.options.store.revokeGatewayKey(record.keyId, this.now());
      await this.options.store.deleteWiring(adapterId);
      this.attention.delete(adapterId);
      return {
        agent: await this.view(adapterId, context, undefined),
        files: result.files,
      };
    });
  }

  /**
   * Hides `hidden` from the agent: its key's deny list becomes `hidden`, so
   * the gateway refuses those models to it and lists the rest, and the
   * model list in its files is rewritten with the same key. Models added to
   * the gateway later are shown. Fails with 409 AGENT_KEYLESS for an agent
   * without a key, AGENT_KEY_INACTIVE for a revoked or missing key,
   * AGENT_MODEL_IN_USE when a hidden model is the agent's model or a tier's,
   * and AGENT_KEY_NOT_IN_FILES when its files no longer hold its key
   * (rotate to re-wire them). When rewriting the files fails, the deny list
   * is put back.
   */
  async setHidden(adapterId: string, hidden: string[]): Promise<AgentView> {
    wiringAdapter(adapterId);
    const invalid = hidden.filter((entry) => !isModelPattern(entry));
    if (invalid.length)
      throw new HubError(
        "AGENT_MODELS_INVALID",
        `Hidden entries must be provider/model, provider/*, group/<id> or *: ${invalid
          .slice(0, 5)
          .map((entry) => JSON.stringify(entry.slice(0, 200)))
          .join(", ")}`,
        400,
      );
    return this.serial(async () => {
      const context = this.context();
      const record = await this.required(adapterId);
      if (record.keyId === undefined) throw keyless(adapterId);
      const store = this.options.store;
      const key = await store.getGatewayKey(record.keyId);
      if (!key || key.revokedAt)
        throw new HubError(
          "AGENT_KEY_INACTIVE",
          `The key of ${adapterId} is revoked or missing; rotate it with hh wire ${adapterId} --rotate`,
          409,
        );
      const deny = [...new Set(hidden)];
      const prepared = await this.prepare(
        adapterId,
        { models: key.modelAllow },
        record,
        deny,
      );
      const keyText = await wiredKeyText(record, context);
      if (keyText === undefined)
        throw new HubError(
          "AGENT_KEY_NOT_IN_FILES",
          `The configuration of ${adapterId} no longer holds its key; rotate it with hh wire ${adapterId} --rotate`,
          409,
        );
      const previousDeny = key.modelDeny ?? [];
      await store.setGatewayKeyModels(key.keyId, key.modelAllow, deny);
      try {
        const { record: next } = await applyWiring(
          adapterId,
          this.target(prepared, { text: keyText, keyId: key.keyId }),
          context,
          { previous: record },
        );
        await store.putWiring(next);
        this.attention.delete(adapterId);
      } catch (error) {
        await store
          .setGatewayKeyModels(key.keyId, key.modelAllow, previousDeny)
          .catch((restore: unknown) => {
            this.log.info("wiring.models_restore_failed", {
              adapterId,
              error:
                restore instanceof Error ? restore.message : String(restore),
            });
          });
        throw summarized(error);
      }
      this.log.info("wiring.models_changed", {
        adapterId,
        keyId: key.keyId,
        hidden: deny.length,
      });
      return this.view(adapterId, context, await this.wiringOf(adapterId));
    });
  }

  /** Every profile, by name. */
  async listProfiles(): Promise<WiringProfile[]> {
    return this.options.store.listWiringProfiles();
  }

  /** One profile; an unknown name fails with 404 PROFILE_NOT_FOUND. */
  async getProfile(name: string): Promise<WiringProfile> {
    const profile = await this.options.store.getWiringProfile(
      profileName(name),
    );
    if (!profile)
      throw new HubError(
        "PROFILE_NOT_FOUND",
        `No profile is named ${JSON.stringify(name)}`,
        404,
      );
    return profile;
  }

  /**
   * Saves the model choices (model, tiers, effort, options) of every wired
   * agent under `name`, replacing a profile of that name. Hidden models and
   * keys are not part of a profile.
   */
  async saveProfile(name: string): Promise<WiringProfile> {
    const valid = profileName(name);
    return this.serial(async () => {
      const store = this.options.store;
      const now = this.now();
      const existing = await store.getWiringProfile(valid);
      const agents: Record<string, WiringChoice> = {};
      for (const record of await store.listWirings())
        agents[record.adapterId] = choiceOf(record);
      const profile: WiringProfile = {
        name: valid,
        agents,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      await store.putWiringProfile(profile);
      return profile;
    });
  }

  /** Deletes a profile; an unknown name fails with 404 PROFILE_NOT_FOUND. */
  async deleteProfile(name: string): Promise<void> {
    if (!(await this.options.store.deleteWiringProfile(profileName(name))))
      throw new HubError(
        "PROFILE_NOT_FOUND",
        `No profile is named ${JSON.stringify(name)}`,
        404,
      );
  }

  /**
   * What applying a profile would change: per agent in the profile, whether
   * its choices differ from its current wiring and, if so, the wiring plan.
   * Agents that are not in the profile are left as they are. Writes nothing.
   */
  async planProfile(name: string): Promise<ProfilePlan> {
    const profile = await this.getProfile(name);
    const agents: ProfileAgentPlan[] = [];
    for (const [adapterId, choice] of Object.entries(profile.agents)) {
      wiringAdapter(adapterId);
      const current = await this.wiringOf(adapterId);
      if (current && sameChoice(current, choice)) {
        agents.push({ adapterId, changed: false, plan: null });
        continue;
      }
      agents.push({
        adapterId,
        changed: true,
        plan: await this.plan(adapterId, requestOf(choice)),
      });
    }
    return { profile, agents };
  }

  /**
   * Wires every agent of the profile whose choices differ, one at a time,
   * through the same path as `wire` (new key, backup, verified write),
   * checking each against its confirmed plan in `expect` (by adapter id).
   * An agent that now differs but has no confirmed plan fails the whole
   * operation with 409 PROFILE_PLAN_STALE before anything is written. The
   * first failure stops: agents before it stay switched and the error names
   * them.
   */
  async applyProfile(
    name: string,
    expect: Record<string, ConfirmedPlan>,
  ): Promise<ProfileApplied> {
    const profile = await this.getProfile(name);
    for (const adapterId of Object.keys(profile.agents))
      wiringAdapter(adapterId);
    return this.serial(async () => {
      const pending = new Set<string>();
      for (const [adapterId, choice] of Object.entries(profile.agents)) {
        const current = await this.wiringOf(adapterId);
        if (current && sameChoice(current, choice)) continue;
        if (!Object.hasOwn(expect, adapterId))
          throw new HubError(
            "PROFILE_PLAN_STALE",
            `${adapterId} changed since the profile was planned; plan again`,
            409,
          );
        pending.add(adapterId);
      }
      const applied: ProfileApplied["agents"] = [];
      for (const [adapterId, choice] of Object.entries(profile.agents)) {
        if (!pending.has(adapterId)) {
          applied.push({
            adapterId,
            outcome: "unchanged",
            agent: await this.view(
              adapterId,
              this.context(),
              await this.wiringOf(adapterId),
            ),
          });
          continue;
        }
        try {
          applied.push({
            adapterId,
            outcome: "applied",
            agent: await this.wireNow(
              adapterId,
              requestOf(choice),
              expect[adapterId],
            ),
          });
        } catch (error) {
          throw stopped(error, adapterId, applied);
        }
      }
      this.log.info("wiring.profile_applied", {
        profile: profile.name,
        applied: pending.size,
      });
      return { profile, agents: applied };
    });
  }

  private async wireNow(
    adapterId: string,
    request: WiringRequest,
    expect: ConfirmedPlan | undefined,
  ): Promise<AgentView> {
    const context = this.context();
    const previous = await this.wiringOf(adapterId);
    const prepared = await this.prepare(adapterId, request, previous);
    await this.apply(adapterId, prepared, context, previous, expect);
    this.attention.delete(adapterId);
    return this.view(adapterId, context, await this.wiringOf(adapterId));
  }

  private async apply(
    adapterId: string,
    prepared: Prepared,
    context: WiringContext,
    previous: WiringRecord | undefined,
    expect: ConfirmedPlan | undefined,
  ): Promise<void> {
    const store = this.options.store;
    const style = wiringAdapter(adapterId).modelIdStyle;
    const issued = issueGatewayKey({ kind: "agent", adapterId });
    const keyId = issued.keyId;
    await store.createGatewayKey({
      keyId,
      name: `agent:${adapterId}`,
      scope: { kind: "agent", adapterId },
      modelAllow: prepared.allow,
      ...(prepared.deny.length ? { modelDeny: prepared.deny } : {}),
      ...(style ? { modelIdStyle: style } : {}),
      secretHash: issued.secretHash,
      createdAt: this.now(),
    });
    let record: WiringRecord;
    try {
      ({ record } = await applyWiring(
        adapterId,
        this.target(prepared, { text: issued.text, keyId }),
        context,
        {
          ...(previous ? { previous } : {}),
          ...(expect ? { expect } : {}),
        },
      ));
    } catch (error) {
      await this.revoke(keyId, "wiring.failed");
      throw summarized(error);
    }
    try {
      await store.putWiring(record);
    } catch (error) {
      // The files hold a key no record names: put them back first.
      await unwire(record, context).catch((cleanup: unknown) => {
        this.log.info("wiring.restore_failed", {
          adapterId,
          error: cleanup instanceof Error ? cleanup.message : String(cleanup),
        });
      });
      await this.revoke(keyId, "wiring.failed");
      throw error;
    }
    if (previous?.keyId !== undefined && previous.keyId !== keyId)
      await this.revoke(previous.keyId, "wiring.replaced");
    this.log.info("wiring.applied", {
      adapterId,
      keyId,
      ...(prepared.model ? { model: prepared.model } : {}),
      files: record.files.length,
    });
  }

  /** Revokes a key; a failure is logged, as it must not hide the operation's own result. */
  private async revoke(keyId: GatewayKeyId, reason: string): Promise<void> {
    try {
      await this.options.store.revokeGatewayKey(keyId, this.now());
    } catch (error) {
      this.log.info("wiring.revoke_failed", {
        keyId,
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * The request completed from the current wiring and checked against the
   * gateway: the model and every tier's must be offered and not hidden, and
   * every listed Model Ref offered. `deny` replaces the current key's.
   */
  private async prepare(
    adapterId: string,
    request: WiringRequest,
    previous: WiringRecord | undefined,
    deny?: string[],
  ): Promise<Prepared> {
    const adapter = wiringAdapter(adapterId);
    const options = resolveOptions(adapter, {
      ...previous?.options,
      ...request.options,
    });
    const optional = isModelOptional(adapter, options);
    // Choices carry over within a mode: switched to keep its own model, the
    // agent does, unless one is named.
    const carried =
      previous && isModelOptional(adapter, previous.options) === optional
        ? previous
        : undefined;
    const model =
      request.model === null ? undefined : (request.model ?? carried?.model);
    if (model === undefined && !optional)
      throw new HubError(
        "AGENT_WIRING_INVALID",
        `Name a model for ${adapter.name}: provider/model or group/<id>`,
        400,
      );
    // Without a model the agent keeps its own: no tiers or effort either.
    if (
      model === undefined &&
      (Object.keys(request.tiers ?? {}).length ||
        (request.effort !== undefined && request.effort !== null))
    )
      throw new HubError(
        "AGENT_WIRING_INVALID",
        `${adapter.name} keeps its own model with these options; name a model to set tiers or an effort`,
        400,
      );
    const tiers =
      model === undefined ? {} : (request.tiers ?? carried?.tiers ?? {});
    const effort =
      model === undefined || request.effort === null
        ? undefined
        : (request.effort ?? carried?.effort);
    const key = previous?.keyId
      ? await this.options.store.getGatewayKey(previous.keyId)
      : undefined;
    const chosen = [
      ...(model === undefined ? [] : [model]),
      ...Object.values(tiers),
    ];
    const listed = request.models ?? key?.modelAllow ?? ["*"];
    const allow = listed.includes("*")
      ? ["*"]
      : [...new Set([...chosen, ...listed])];
    const denied = deny ?? key?.modelDeny ?? [];
    const catalog = await gatewayModels(this.options.store);
    const unknown = unoffered([...chosen, ...listed], catalog);
    if (unknown.length) throw modelUnavailable(adapterId, unknown);
    const hidden = [
      ...new Set(chosen.filter((ref) => !modelAllowed(allow, ref, denied))),
    ];
    if (hidden.length)
      throw new HubError(
        "AGENT_MODEL_IN_USE",
        `${hidden.map((ref) => JSON.stringify(ref.slice(0, 200))).join(", ")} ${hidden.length === 1 ? "is" : "are"} hidden from ${adapterId} but chosen for it; show ${hidden.length === 1 ? "it" : "them"} or choose another model`,
        409,
      );
    return {
      options,
      ...(model !== undefined ? { model } : {}),
      tiers,
      ...(effort !== undefined ? { effort } : {}),
      allow,
      deny: denied,
      models: [...catalog.values()].filter((entry) =>
        modelAllowed(allow, entry.ref, denied),
      ),
    };
  }

  private target(
    prepared: Prepared,
    key: { text: string; keyId: GatewayKeyId } | undefined,
  ): WiringTarget {
    return {
      baseUrl: this.origin(),
      models: prepared.models,
      options: prepared.options,
      ...(key ? { keyText: key.text, keyId: key.keyId } : {}),
      ...(prepared.model !== undefined ? { model: prepared.model } : {}),
      ...(Object.keys(prepared.tiers).length ? { tiers: prepared.tiers } : {}),
      ...(prepared.effort !== undefined ? { effort: prepared.effort } : {}),
      gatewaySearch: this.options.gatewaySearch?.() ?? false,
    };
  }

  private async view(
    adapterId: string,
    context: WiringContext,
    record: WiringRecord | undefined,
    catalog?: Map<string, WiringModel>,
  ): Promise<AgentView> {
    const adapter = wiringAdapter(adapterId);
    const notice = restartNotice(adapter);
    return {
      id: adapter.id,
      name: adapter.name,
      protocol: adapter.protocol,
      keyDelivery: adapter.keyDelivery,
      capabilities: {
        tiers: [...(adapter.tiers ?? [])],
        efforts: [...(adapter.efforts ?? [])],
        options: Object.fromEntries(
          Object.entries(adapter.options ?? {}).map(([name, values]) => [
            name,
            [...values],
          ]),
        ),
        ownModel: ownModelOptions(adapter),
      },
      ...(notice ? { notice } : {}),
      installation: await detectAgent(adapterId, context),
      wiring: record
        ? await this.wiringView(
            record,
            context,
            catalog ?? (await gatewayModels(this.options.store)),
          )
        : null,
    };
  }

  private async wiringView(
    record: WiringRecord,
    context: WiringContext,
    catalog: Map<string, WiringModel>,
  ): Promise<AgentWiringView> {
    const key =
      record.keyId === undefined
        ? undefined
        : await this.options.store.getGatewayKey(record.keyId);
    const now = Date.parse(this.now());
    const keyState =
      record.keyId === undefined
        ? "none"
        : !key
          ? "missing"
          : key.revokedAt
            ? "revoked"
            : key.expiresAt && Date.parse(key.expiresAt) <= now
              ? "expired"
              : key.suspendedAt
                ? "suspended"
                : "active";
    let drift: AgentWiringView["drift"] = null;
    let driftError: string | undefined;
    try {
      const origin = this.options.origin();
      const report = await detectDrift(
        record,
        context,
        origin ? { baseUrl: origin } : {},
      );
      drift = {
        drifted: report.drifted,
        kinds: report.kinds,
        findings: report.findings,
      };
    } catch (error) {
      if (!(error instanceof HubError)) throw error;
      driftError = `${error.code}: ${error.message}`;
    }
    const attention = this.attentionOf(record, key, catalog);
    let managed: ManagedOverride[] = [];
    try {
      managed = await managedOverrides(
        record.adapterId,
        await wiredEntries(record, context),
        context,
      );
    } catch (error) {
      if (!(error instanceof WiringError)) throw error;
    }
    return {
      ...choiceOf(record),
      ...(managed.length ? { managed } : {}),
      models: key
        ? [...catalog.keys()].filter((ref) =>
            modelAllowed(key.modelAllow, ref, key.modelDeny),
          )
        : [],
      hidden: key?.modelDeny ?? [],
      ...(record.keyId !== undefined ? { keyId: record.keyId } : {}),
      keyState,
      wiredAt: record.wiredAt,
      files: record.files.map((file) => file.path),
      drift,
      ...(driftError ? { driftError } : {}),
      ...(attention ? { attention } : {}),
    };
  }

  /** Marks the agent, keeping the time of the same mark made before. */
  private mark(
    adapterId: string,
    code: string,
    message: string,
  ): { code: string; message: string; at: string } {
    const previous = this.attention.get(adapterId);
    const mark =
      previous?.code === code && previous.message === message
        ? previous
        : { code, message, at: this.now() };
    this.attention.set(adapterId, mark);
    return mark;
  }

  /**
   * The agent's mark: the last catalog sync's, except that whether the
   * models it is wired to and allowed are offered is read from `catalog`
   * now, as a sync would find it, so a provider switched off shows at once
   * rather than after the sync's delay (or never, without `autoSync`).
   */
  private attentionOf(
    record: WiringRecord,
    key: GatewayKeyRecord | undefined,
    catalog: ReadonlyMap<string, WiringModel>,
  ): { code: string; message: string; at: string } | undefined {
    const stored = this.attention.get(record.adapterId);
    if (stored && stored.code !== "AGENT_MODEL_UNAVAILABLE") return stored;
    const unknown = unoffered(
      [
        ...(record.model !== undefined ? [record.model] : []),
        ...Object.values(record.tiers ?? {}),
        ...(key?.modelAllow ?? []),
      ],
      catalog,
    );
    if (!unknown.length) {
      this.attention.delete(record.adapterId);
      return undefined;
    }
    return this.mark(
      record.adapterId,
      "AGENT_MODEL_UNAVAILABLE",
      modelUnavailable(record.adapterId, unknown).message,
    );
  }

  private async wiringOf(adapterId: string): Promise<WiringRecord | undefined> {
    return (await this.options.store.listWirings()).find(
      (record) => record.adapterId === adapterId,
    );
  }

  private async required(adapterId: string): Promise<WiringRecord> {
    const record = await this.wiringOf(adapterId);
    if (!record)
      throw new HubError(
        "AGENT_NOT_WIRED",
        `${adapterId} is not wired to the gateway`,
        409,
      );
    return record;
  }

  private context(): WiringContext {
    const home = this.options.home;
    if (!home)
      throw new HubError(
        "AGENT_WIRING_UNAVAILABLE",
        "This daemon was started without a wiring home; hh serve sets it to your home directory",
        503,
      );
    return {
      home: home.home,
      dataDir: this.options.dataDir,
      env: home.env,
      ...(home.systemRoot ? { systemRoot: home.systemRoot } : {}),
      ...(this.options.clock ? { clock: this.options.clock } : {}),
    };
  }

  private origin(): string {
    const origin = this.options.origin();
    if (!origin)
      throw new HubError(
        "GATEWAY_NOT_LISTENING",
        "The model gateway is not listening yet",
        503,
      );
    return origin;
  }

  private now(): string {
    return (this.options.clock?.() ?? new Date()).toISOString();
  }

  private get log(): LogSink {
    return this.options.log ?? NO_LOG;
  }

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action, action);
    this.queue = result.catch(() => undefined);
    return result;
  }
}

/** Every combination of the adapter's option values with which it keeps its own model. */
function ownModelOptions(
  adapter: WiringAdapter,
): Array<Record<string, string>> {
  let combinations: Array<Record<string, string>> = [{}];
  for (const [name, values] of Object.entries(adapter.options ?? {}))
    combinations = combinations.flatMap((combination) =>
      values.map((value) => ({ ...combination, [name]: value })),
    );
  return combinations.filter((combination) =>
    isModelOptional(adapter, combination),
  );
}

/** A record wired without a key: Codex's ChatGPT mode before it took one. */
function keyless(adapterId: string): HubError {
  return new HubError(
    "AGENT_KEYLESS",
    `${adapterId} was wired without a Gateway Key; give it one with hh wire ${adapterId} --rotate`,
    409,
  );
}

function profileName(name: string): string {
  if (!isWiringProfileName(name))
    throw new HubError(
      "PROFILE_NAME_INVALID",
      "A profile name is 1 to 64 letters, digits, '.', '_' or '-', starting with a letter or digit",
      400,
    );
  return name;
}

/** The entries of `refs` that name a model or group `catalog` lacks; wildcards are always offered. */
function unoffered(
  refs: readonly string[],
  catalog: ReadonlyMap<string, unknown>,
): string[] {
  return [
    ...new Set(
      refs.filter(
        (ref) => ref !== "*" && !ref.endsWith("/*") && !catalog.has(ref),
      ),
    ),
  ];
}

/** `AGENT_MODEL_UNAVAILABLE` (400): the gateway does not offer the first five of `unknown`. */
function modelUnavailable(adapterId: string, unknown: string[]): HubError {
  return new HubError(
    "AGENT_MODEL_UNAVAILABLE",
    `The gateway does not offer ${unknown
      .slice(0, 5)
      .map((ref) => JSON.stringify(ref.slice(0, 200)))
      .join(
        ", ",
      )} for ${adapterId}; use a model of a provider or a route group`,
    400,
  );
}

/** The choices of a wiring, as a profile keeps them. */
function choiceOf(record: WiringChoice): WiringChoice {
  return {
    ...(record.model !== undefined ? { model: record.model } : {}),
    ...(record.tiers && Object.keys(record.tiers).length
      ? { tiers: { ...record.tiers } }
      : {}),
    ...(record.effort !== undefined ? { effort: record.effort } : {}),
    ...(record.options ? { options: { ...record.options } } : {}),
  };
}

/**
 * The request that wires an agent to a profile's choice exactly: unset tiers
 * and effort are cleared, and so is the model of an agent that keeps its own.
 */
function requestOf(choice: WiringChoice): WiringRequest {
  return {
    model: choice.model ?? null,
    ...(choice.model !== undefined
      ? { tiers: choice.tiers ?? {}, effort: choice.effort ?? null }
      : {}),
    ...(choice.options ? { options: choice.options } : {}),
  };
}

function sameChoice(record: WiringRecord, choice: WiringChoice): boolean {
  const adapter = wiringAdapter(record.adapterId);
  const normal = (value: WiringChoice) =>
    JSON.stringify({
      model: value.model ?? null,
      tiers: Object.entries(value.tiers ?? {}).sort(),
      effort: value.effort ?? null,
      options: Object.entries(resolveOptions(adapter, value.options)).sort(),
    });
  return normal(record) === normal(choice);
}

/** The error of a profile apply that stopped at `adapterId`, naming the agents already switched. */
function stopped(
  error: unknown,
  adapterId: string,
  applied: ProfileApplied["agents"],
): unknown {
  if (!(error instanceof HubError)) return error;
  const done = applied
    .filter((item) => item.outcome === "applied")
    .map((item) => item.adapterId);
  const result = new HubError(
    error.code,
    `Applying the profile stopped at ${adapterId}: ${error.message}${
      done.length ? `; already switched: ${done.join(", ")}` : ""
    }`,
    error.statusCode,
  );
  result.cause = error;
  return result;
}

/**
 * The models the gateway offers, by Model Ref and in the order `/v1/models`
 * lists them: the exposed models of every provider, with their window,
 * output limit, reasoning levels, image input and the protocols the gateway
 * passes through to the provider, then every route group with what its
 * models share (core `groupCapabilities`: groups inside it included, the
 * smallest window and output when all are known, the levels every model
 * that follows the request offers), and the larger window or image input
 * its rules make reachable (core `ruledCapabilities`).
 */
async function gatewayModels(
  store: ModelPlaneStore,
): Promise<Map<string, WiringModel>> {
  const catalog = new Map<string, WiringModel>();
  const metadata = new Map<string, ProviderModel>();
  const providers = (await store.listProviders()).filter(providerEnabled);
  for (const provider of providers) {
    const exposed =
      provider.models.expose === "all"
        ? provider.models.list
        : provider.models.list.filter((model) =>
            (provider.models.expose as string[]).includes(model.id),
          );
    for (const model of provider.models.list)
      metadata.set(`${provider.id}/${model.id}`, model);
    const native = provider.translateOnly
      ? []
      : (Object.keys(provider.endpoints) as WireProtocol[]);
    for (const model of exposed) {
      const ref = `${provider.id}/${model.id}`;
      catalog.set(ref, {
        ...describe(ref, {
          ...(model.contextWindow !== undefined
            ? { contextWindow: model.contextWindow }
            : {}),
          ...(model.maxOutputTokens !== undefined
            ? { maxOutputTokens: model.maxOutputTokens }
            : {}),
          efforts: modelEfforts(model),
          ...(model.inputModalities
            ? { inputModalities: model.inputModalities }
            : {}),
        }),
        ...(native.length ? { nativeProtocols: native } : {}),
      });
    }
  }
  const groups = await store.listRouteGroups();
  const byId = new Map(groups.map((group) => [group.id, group]));
  for (const group of groups) {
    const ref = `group/${group.id}`;
    catalog.set(
      ref,
      describe(
        ref,
        ruledCapabilities(
          group,
          groupModels(
            group,
            (id) => byId.get(id),
            (provider, model) => metadata.has(`${provider}/${model}`),
          ),
          (member) => metadata.get(member),
        ),
      ),
    );
  }
  for (const ref of catalog.keys())
    if (!parseModelRef(ref)) catalog.delete(ref);
  return catalog;
}

/** A model or group for wiring: its window, output, levels, and image input when it takes images. */
function describe(ref: string, capabilities: GroupCapabilities): WiringModel {
  return {
    ref,
    ...(capabilities.contextWindow !== undefined
      ? { contextWindow: capabilities.contextWindow }
      : {}),
    ...(capabilities.maxOutputTokens !== undefined
      ? { maxOutputTokens: capabilities.maxOutputTokens }
      : {}),
    ...(capabilities.efforts.length ? { efforts: capabilities.efforts } : {}),
    ...(capabilities.inputModalities?.includes("image")
      ? { images: true }
      : {}),
  };
}

/** Adds how many files were put back to a failed write's message. */
function summarized(error: unknown): unknown {
  if (!(error instanceof WiringError) || !error.rollback.length) return error;
  const restored = error.rollback.filter((entry) => entry.restored).length;
  const failed = error.rollback.filter((entry) => !entry.restored);
  return new WiringError(
    error.code,
    `${error.message}; ${restored} of ${error.rollback.length} written files restored${
      failed.length
        ? `, not restored: ${failed.map((entry) => `${entry.path}${entry.backupId ? ` (backup ${entry.backupId})` : ""}`).join(", ")}`
        : ""
    }`,
    {
      ...(error.path !== undefined ? { path: error.path } : {}),
      rollback: error.rollback,
      cause: error,
    },
  );
}
