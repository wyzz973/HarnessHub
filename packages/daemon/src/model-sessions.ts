// SPDX-License-Identifier: MIT
/**
 * Session Runs on the daemon's shared model gateway (03 section 10). One
 * object is both sides of the bridge: the gateway's `sessions` port (which
 * Run a `session:` key belongs to, and its committed calls) and the
 * Runtime's `RunModelPort` (begin and end of a Run, Session close). Every
 * routed Session gets one `session:` Gateway Key; its text lives only in
 * memory and in the Worker's ExecutionSpec.
 */
import type { ConfigurationAdapter } from "@harnesshub/core/engine-configuration";
import { HubError } from "@harnesshub/core/errors";
import type { LogSink } from "@harnesshub/core/logging";
import {
  issueGatewayKey,
  parseModelRef,
  type GatewayKeyId,
  type ModelCallEntry,
  type ModelPlaneStore,
  type ProviderModel,
} from "@harnesshub/core/model-plane";
import { upstreamFailureMessage } from "@harnesshub/core/model-outcome";
import type {
  ModelCallSummary,
  RunModelPort,
  SessionModelGateway,
} from "@harnesshub/core/ports";
import type {
  EngineProfile,
  EventDraft,
  JsonObject,
  RunId,
  RunRecord,
  SessionId,
  SessionRecord,
} from "@harnesshub/core/types";
import type {
  ActiveSessionRun,
  GatewaySessions,
} from "@harnesshub/gateway/server";

/** The target a Run uses when it names none. */
export const DEFAULT_MODEL_TARGET = "group/default";

/** How a Session's engine reaches models, decided once per Session by the composition root. */
export interface ModelRouting {
  /** Adapter whose configuration the Worker writes for the shared gateway. */
  adapter: ConfigurationAdapter;
  /**
   * The engine has no other way to a model: a Run without a configured
   * target fails. Otherwise such a Session keeps the engine's own login.
   */
  required: boolean;
}

export interface ModelSessionsOptions {
  store: ModelPlaneStore;
  /** Where `model.call` Run events are committed (the Runtime's store). */
  events: () => { appendEvent(runId: RunId, draft: EventDraft): unknown };
  /** The shared gateway handler, for the settlement barrier. */
  gateway: () =>
    | {
        awaitSessionIdle(
          id: SessionId,
          options?: { abort?: boolean },
        ): Promise<void>;
      }
    | undefined;
  /** The daemon's gateway origin (`http://127.0.0.1:<port>`), once the listener is bound. */
  origin: () => string | undefined;
  /** Whether and how a Session's engine uses the shared gateway. */
  route: (profile: EngineProfile) => ModelRouting | undefined;
  clock: () => number;
  log: LogSink;
}

interface SessionState {
  routing: ModelRouting | undefined;
  keyId?: GatewayKeyId;
  key?: string;
}
interface RunState {
  sessionId: SessionId;
  calls: number;
  successfulCalls: number;
  lastError?: string;
}

/** `model.call` Run event data of one committed ledger entry; no prompt, output or secret. */
export function modelCallEventData(entry: ModelCallEntry): JsonObject {
  const usage = entry.usage;
  return {
    id: entry.callId,
    inbound: entry.inbound.protocol,
    stream: entry.inbound.stream,
    ...(entry.requestedModel !== undefined
      ? { requestedModel: entry.requestedModel }
      : {}),
    ...(entry.modelRef !== undefined ? { modelRef: entry.modelRef } : {}),
    ...(entry.servedModel !== undefined || entry.wireModel !== undefined
      ? { upstreamModel: entry.servedModel ?? entry.wireModel! }
      : {}),
    ...(entry.mode !== undefined ? { mode: entry.mode } : {}),
    status: entry.status,
    ok: entry.status < 400 && entry.rejected !== true,
    durationMs: entry.timing.durationMs,
    ...(entry.finishReason !== undefined
      ? { finishReason: entry.finishReason }
      : {}),
    ...(usage
      ? {
          usage: {
            input: usage.input,
            cacheRead: usage.cacheRead,
            cacheWrite: usage.cacheWrite,
            output: usage.output,
            reasoning: usage.reasoning,
            source: usage.source,
          },
        }
      : {}),
    cost: entry.cost
      ? { amountUsd: entry.cost.amountUsd, priceSource: entry.cost.priceSource }
      : null,
    ...(entry.errorClass !== undefined || entry.error !== undefined
      ? {
          error: {
            code: entry.errorClass ?? "error",
            message: entry.error ?? "",
          },
        }
      : {}),
  };
}

/** See the module comment; owned by the composition root, which awaits {@link revokeAll} on shutdown. */
export class ModelSessions implements GatewaySessions, RunModelPort {
  #sessions = new Map<SessionId, SessionState>();
  #active = new Map<SessionId, ActiveSessionRun>();
  #runs = new Map<RunId, RunState>();
  constructor(private readonly options: ModelSessionsOptions) {}

  activeRun(sessionId: SessionId): ActiveSessionRun | undefined {
    return this.#active.get(sessionId);
  }

  committed(entry: ModelCallEntry): void {
    const run = entry.runId ? this.#runs.get(entry.runId) : undefined;
    if (!run || run.sessionId !== entry.sessionId || !entry.runId) return;
    run.calls++;
    const ok = entry.status < 400 && entry.rejected !== true;
    if (ok) run.successfulCalls++;
    else if (entry.status !== 499)
      run.lastError = upstreamFailureMessage(
        entry.status,
        entry.error ?? entry.errorClass ?? "",
      ).slice(0, 500);
    this.options.events().appendEvent(entry.runId, {
      type: "model.call",
      data: modelCallEventData(entry),
    });
  }

  async begin(
    session: SessionRecord,
    run: RunRecord,
    profile: EngineProfile,
  ): Promise<SessionModelGateway | undefined> {
    let state = this.#sessions.get(session.id);
    if (!state) {
      state = { routing: this.options.route(profile) };
      this.#sessions.set(session.id, state);
    }
    const routing = state.routing;
    if (!routing) {
      if (run.input.model !== undefined)
        throw new HubError(
          "MODEL_SELECTION_UNSUPPORTED",
          "This Session's engine does not use the HarnessHub model gateway, so the Run cannot select a model",
          409,
        );
      return undefined;
    }
    const target = run.input.model ?? DEFAULT_MODEL_TARGET;
    const metadata = await this.#target(target);
    if (!metadata) {
      if (run.input.model !== undefined || routing.required || state.key)
        throw new HubError(
          "MODEL_NOT_CONFIGURED",
          run.input.model !== undefined
            ? `Model ${target} is not configured`
            : `The Run names no model and ${DEFAULT_MODEL_TARGET} does not exist; create it or name a Model Ref`,
          409,
        );
      // A Session that never used the gateway keeps the engine's own login.
      state.routing = undefined;
      return undefined;
    }
    const origin = this.options.origin();
    if (!origin)
      throw new HubError(
        "MODEL_GATEWAY_UNAVAILABLE",
        "The model gateway is not listening yet",
        503,
      );
    if (!state.key) {
      const issued = issueGatewayKey({
        kind: "session",
        sessionId: session.id,
      });
      await this.options.store.createGatewayKey({
        keyId: issued.keyId,
        name: `session ${session.id}`,
        scope: { kind: "session", sessionId: session.id },
        modelAllow: [],
        secretHash: issued.secretHash,
        createdAt: new Date(this.options.clock()).toISOString(),
      });
      state.keyId = issued.keyId;
      state.key = issued.text;
    }
    this.#runs.set(run.id, {
      sessionId: session.id,
      calls: 0,
      successfulCalls: 0,
    });
    this.#active.set(session.id, {
      runId: run.id,
      generation: run.generation,
      target,
    });
    return {
      baseUrl: origin,
      key: state.key,
      adapter: routing.adapter,
      ...(metadata.contextWindow !== undefined
        ? { contextWindow: metadata.contextWindow }
        : {}),
      ...(metadata.maxOutputTokens !== undefined &&
      (metadata.contextWindow === undefined ||
        metadata.maxOutputTokens < metadata.contextWindow)
        ? { maxOutputTokens: metadata.maxOutputTokens }
        : {}),
    };
  }

  async end(session: SessionRecord, run: RunRecord): Promise<ModelCallSummary> {
    if (this.#active.get(session.id)?.runId === run.id)
      this.#active.delete(session.id);
    try {
      await this.options
        .gateway()
        ?.awaitSessionIdle(session.id, { abort: true });
    } catch (error) {
      this.options.log.info("model.session.idle_failed", {
        sessionId: session.id,
        error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
      });
    }
    const state = this.#runs.get(run.id);
    this.#runs.delete(run.id);
    return {
      calls: state?.calls ?? 0,
      successfulCalls: state?.successfulCalls ?? 0,
      ...(state?.lastError !== undefined ? { lastError: state.lastError } : {}),
    };
  }

  async close(sessionId: SessionId): Promise<void> {
    const state = this.#sessions.get(sessionId);
    this.#sessions.delete(sessionId);
    this.#active.delete(sessionId);
    if (!state?.keyId) return;
    await this.options
      .gateway()
      ?.awaitSessionIdle(sessionId, { abort: true })
      .catch(() => undefined);
    await this.#revoke(state.keyId);
  }

  /**
   * Revoke every `session:` key that is not revoked yet: at startup their
   * texts are gone with the previous process, at shutdown their Sessions end.
   */
  async revokeAll(): Promise<void> {
    this.#sessions.clear();
    this.#active.clear();
    for (const key of await this.options.store.listGatewayKeys())
      if (key.scope.kind === "session" && key.revokedAt === undefined)
        await this.#revoke(key.keyId);
  }

  async #revoke(keyId: GatewayKeyId): Promise<void> {
    try {
      await this.options.store.revokeGatewayKey(
        keyId,
        new Date(this.options.clock()).toISOString(),
      );
    } catch (error) {
      this.options.log.info("model.session.revoke_failed", {
        keyId,
        error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
      });
    }
  }

  /** Window and output limit of a configured target, or undefined when it names nothing. */
  async #target(
    target: string,
  ): Promise<
    Pick<ProviderModel, "contextWindow" | "maxOutputTokens"> | undefined
  > {
    const parsed = parseModelRef(target);
    if (!parsed) return undefined;
    const model = async (ref: string) => {
      const value = parseModelRef(ref);
      if (value?.kind !== "model") return undefined;
      const provider = await this.options.store.getProvider(value.provider);
      if (!provider) return undefined;
      return (
        provider.models.list.find((entry) => entry.id === value.model) ?? {
          id: value.model,
        }
      );
    };
    if (parsed.kind === "model") return model(target);
    const group = await this.options.store.getRouteGroup(parsed.group);
    if (!group) return undefined;
    const members = await Promise.all(group.members.map(model));
    const known = <K extends "contextWindow" | "maxOutputTokens">(field: K) => {
      const values = members.map((member) => member?.[field]);
      return values.length && values.every((value) => value !== undefined)
        ? Math.min(...(values as number[]))
        : undefined;
    };
    const contextWindow = known("contextWindow");
    const maxOutputTokens = known("maxOutputTokens");
    return {
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    };
  }
}
