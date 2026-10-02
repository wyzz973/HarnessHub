// SPDX-License-Identifier: MIT
/**
 * Global wiring of the agents on this machine (04-agent-plane section 4) as
 * the daemon runs it: one `agent:<adapterId>` Gateway Key per wired agent,
 * whose text exists only in the agent's configuration file, and the
 * `WiringRecord` in the model-plane store. The file edits, backups and drift
 * detection are `@harnesshub/agents/wiring`'s.
 */
import { HubError } from "@harnesshub/core/errors";
import { NO_LOG, type LogSink } from "@harnesshub/core/logging";
import {
  issueGatewayKey,
  parseModelRef,
  type GatewayKeyId,
  type GatewayKeyRecord,
  type ModelPlaneStore,
  type ProviderModel,
  type WireProtocol,
  type WiringRecord,
} from "@harnesshub/core/model-plane";
import {
  applyWiring,
  detectAgent,
  detectDrift,
  planWiring,
  unwire,
  wiringAdapter,
  wiringAdapters,
  WiringError,
  type AgentInstallation,
  type ConfirmedPlan,
  type DriftReport,
  type UnwireResult,
  type WiringContext,
  type WiringModel,
  type WiringPlan,
} from "@harnesshub/agents/wiring/index";

/** Where agent configuration lives; absent, every wiring operation is refused. */
export interface WiringHome {
  /** The user's home directory (absolute). Only `hh serve` passes the real one. */
  home: string;
  /** The environment agents see: PATH for detection and directory overrides such as CODEX_HOME. */
  env: Readonly<Record<string, string | undefined>>;
}

export interface AgentWiringOptions {
  store: ModelPlaneStore;
  dataDir: string;
  home: WiringHome | undefined;
  /** The gateway origin agents are pointed at; undefined until the listener is bound. */
  origin: () => string | undefined;
  clock?: () => Date;
  log?: LogSink;
}

/** The state of one wired agent. */
export interface AgentWiringView {
  model: string;
  /** The models the agent's picker lists; also the key's allowlist. */
  models: string[];
  keyId: GatewayKeyId;
  keyState: "active" | "revoked" | "expired" | "missing";
  wiredAt: string;
  files: string[];
  drift: Pick<DriftReport, "drifted" | "kinds" | "findings"> | null;
  /** Why drift could not be checked (for example a missing backup). */
  driftError?: string;
}

/** One agent as `GET /api/v1/agents` shows it. */
export interface AgentView {
  id: string;
  name: string;
  protocol: WireProtocol;
  keyDelivery: "config-file" | "env-file";
  installation: AgentInstallation;
  wiring: AgentWiringView | null;
}

export interface WiringRequest {
  model: string;
  /** The models the agent lists; default: the current list, or just `model`. */
  models?: string[];
}

/**
 * Runs wiring operations one at a time. The key lifecycle follows 04 section
 * 4: a new key is issued for every wiring, written only into the agent's
 * files and never kept by the daemon; after the files are written and read
 * back and the record is committed, the previous key is revoked; on any
 * failure the new key is revoked instead. Unwire restores the files, then
 * revokes the key and deletes the record.
 */
export class AgentWiringService {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: AgentWiringOptions) {}

  /** Every supported agent with installation, wiring and drift. */
  async list(): Promise<AgentView[]> {
    const context = this.context();
    const wirings = await this.options.store.listWirings();
    const views: AgentView[] = [];
    for (const adapter of wiringAdapters.values())
      views.push(
        await this.view(
          adapter.id,
          context,
          wirings.find((record) => record.adapterId === adapter.id),
        ),
      );
    return views;
  }

  /** One agent; an unknown id fails with WIRING_ADAPTER_UNKNOWN (404). */
  async get(adapterId: string): Promise<AgentView> {
    wiringAdapter(adapterId);
    return this.view(adapterId, this.context(), await this.wiringOf(adapterId));
  }

  /**
   * The edits wiring would make, with a throwaway key that is never stored:
   * the preview masks key text anyway, and applying issues the real key.
   */
  async plan(adapterId: string, request: WiringRequest): Promise<WiringPlan> {
    wiringAdapter(adapterId);
    const context = this.context();
    const previous = await this.wiringOf(adapterId);
    const models = await this.models(adapterId, request, previous);
    const issued = issueGatewayKey({ kind: "agent", adapterId });
    return planWiring(
      adapterId,
      {
        baseUrl: this.origin(),
        keyText: issued.text,
        keyId: issued.keyId,
        model: request.model,
        models,
      },
      context,
      previous ? { previous } : {},
    );
  }

  /** Wires the agent to `request.model` with a new key, after checking the confirmed plan. */
  async wire(
    adapterId: string,
    request: WiringRequest,
    expect: ConfirmedPlan | undefined,
  ): Promise<AgentView> {
    wiringAdapter(adapterId);
    return this.serial(async () => {
      const context = this.context();
      const previous = await this.wiringOf(adapterId);
      await this.apply(
        adapterId,
        request.model,
        await this.models(adapterId, request, previous),
        context,
        previous,
        expect,
      );
      return this.view(adapterId, context, await this.wiringOf(adapterId));
    });
  }

  /** Re-wires the agent with the same models and a new key; the old key is revoked. */
  async rotate(adapterId: string): Promise<AgentView> {
    wiringAdapter(adapterId);
    return this.serial(async () => {
      const context = this.context();
      const previous = await this.required(adapterId);
      const key = await this.options.store.getGatewayKey(previous.keyId);
      const models = await this.models(
        adapterId,
        {
          model: previous.model,
          ...(key ? { models: key.modelAllow } : {}),
        },
        previous,
      );
      await this.apply(
        adapterId,
        previous.model,
        models,
        context,
        previous,
        undefined,
      );
      return this.view(adapterId, context, await this.wiringOf(adapterId));
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
      await this.options.store.revokeGatewayKey(record.keyId, this.now());
      await this.options.store.deleteWiring(adapterId);
      return {
        agent: await this.view(adapterId, context, undefined),
        files: result.files,
      };
    });
  }

  private async apply(
    adapterId: string,
    model: string,
    models: WiringModel[],
    context: WiringContext,
    previous: WiringRecord | undefined,
    expect: ConfirmedPlan | undefined,
  ): Promise<void> {
    const baseUrl = this.origin();
    const store = this.options.store;
    const issued = issueGatewayKey({ kind: "agent", adapterId });
    const key: GatewayKeyRecord = {
      keyId: issued.keyId,
      name: `agent:${adapterId}`,
      scope: { kind: "agent", adapterId },
      modelAllow: models.map((item) => item.ref),
      secretHash: issued.secretHash,
      createdAt: this.now(),
    };
    await store.createGatewayKey(key);
    let record: WiringRecord;
    try {
      ({ record } = await applyWiring(
        adapterId,
        { baseUrl, keyText: issued.text, keyId: issued.keyId, model, models },
        context,
        {
          ...(previous ? { previous } : {}),
          ...(expect ? { expect } : {}),
        },
      ));
    } catch (error) {
      await this.revoke(key.keyId, "wiring.failed");
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
      await this.revoke(key.keyId, "wiring.failed");
      throw error;
    }
    if (previous && previous.keyId !== key.keyId)
      await this.revoke(previous.keyId, "wiring.replaced");
    this.log.info("wiring.applied", {
      adapterId,
      keyId: key.keyId,
      model,
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

  /** The requested models with the gateway's metadata; every one must be exposed by the gateway. */
  private async models(
    adapterId: string,
    request: WiringRequest,
    previous: WiringRecord | undefined,
  ): Promise<WiringModel[]> {
    let listed = request.models;
    if (listed === undefined && previous) {
      const key = await this.options.store.getGatewayKey(previous.keyId);
      listed = key?.modelAllow;
    }
    const refs = [...new Set([request.model, ...(listed ?? [])])];
    const catalog = await gatewayModels(this.options.store);
    const unknown = refs.filter((ref) => !catalog.has(ref));
    if (unknown.length)
      throw new HubError(
        "AGENT_MODEL_UNAVAILABLE",
        `The gateway does not offer ${unknown
          .slice(0, 5)
          .map((ref) => JSON.stringify(ref.slice(0, 200)))
          .join(
            ", ",
          )} for ${adapterId}; use a model of a provider or a route group`,
        400,
      );
    return refs.map((ref) => catalog.get(ref)!);
  }

  private async view(
    adapterId: string,
    context: WiringContext,
    record: WiringRecord | undefined,
  ): Promise<AgentView> {
    const adapter = wiringAdapter(adapterId);
    return {
      id: adapter.id,
      name: adapter.name,
      protocol: adapter.protocol,
      keyDelivery: adapter.keyDelivery,
      installation: await detectAgent(adapterId, context),
      wiring: record ? await this.wiringView(record, context) : null,
    };
  }

  private async wiringView(
    record: WiringRecord,
    context: WiringContext,
  ): Promise<AgentWiringView> {
    const key = await this.options.store.getGatewayKey(record.keyId);
    const now = Date.parse(this.now());
    const keyState = !key
      ? "missing"
      : key.revokedAt
        ? "revoked"
        : key.expiresAt && Date.parse(key.expiresAt) <= now
          ? "expired"
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
    return {
      model: record.model,
      models: key?.modelAllow ?? [record.model],
      keyId: record.keyId,
      keyState,
      wiredAt: record.wiredAt,
      files: record.files.map((file) => file.path),
      drift,
      ...(driftError ? { driftError } : {}),
    };
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

/**
 * The models the gateway offers, by Model Ref: the exposed models of every
 * provider and every route group, with the window and output limit a group
 * can promise (the smallest of its members, when all are known).
 */
async function gatewayModels(
  store: ModelPlaneStore,
): Promise<Map<string, WiringModel>> {
  const catalog = new Map<string, WiringModel>();
  const metadata = new Map<string, ProviderModel>();
  for (const provider of await store.listProviders()) {
    const exposed =
      provider.models.expose === "all"
        ? provider.models.list
        : provider.models.list.filter((model) =>
            (provider.models.expose as string[]).includes(model.id),
          );
    for (const model of provider.models.list)
      metadata.set(`${provider.id}/${model.id}`, model);
    for (const model of exposed)
      catalog.set(
        `${provider.id}/${model.id}`,
        limits(`${provider.id}/${model.id}`, [model]),
      );
  }
  for (const group of await store.listRouteGroups()) {
    const ref = `group/${group.id}`;
    catalog.set(
      ref,
      limits(
        ref,
        group.members.map((member) => metadata.get(member)),
      ),
    );
  }
  for (const ref of catalog.keys())
    if (!parseModelRef(ref)) catalog.delete(ref);
  return catalog;
}

function limits(
  ref: string,
  models: Array<ProviderModel | undefined>,
): WiringModel {
  const least = (values: Array<number | undefined>) =>
    values.length && values.every((value) => value !== undefined)
      ? Math.min(...(values as number[]))
      : undefined;
  const contextWindow = least(models.map((model) => model?.contextWindow));
  const maxOutputTokens = least(models.map((model) => model?.maxOutputTokens));
  return {
    ref,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
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
