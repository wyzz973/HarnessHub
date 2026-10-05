// SPDX-License-Identifier: MIT
import type { FastifyInstance } from "fastify";
import type {
  ModelPlaneStore,
  RouteDecisionPage,
  RouteDecisionQuery,
} from "@harnesshub/core/model-plane";
import {
  listOf,
  responses,
  routeDecisionPageSchema,
  routeDecisionsQuerySchema,
} from "./api-v1-schemas.js";

/** One credential's routing state as the gateway holds it in memory. */
export interface CredentialRoutingView {
  provider: string;
  credential: string;
  state: "closed" | "open" | "half-open";
  /** ISO time an open breaker admits a probe again. */
  restingUntil?: string;
  /** The last counted failure: its class, HTTP status and time; never its message. */
  lastFailure?: { kind: string; status: number; at: string };
  /** The latest reading of each allowance window. */
  readings: {
    window: string;
    usedPercent: number;
    resetsAt?: string;
    spanSeconds?: number;
    observedAt: string;
  }[];
}

/** Where the routing state comes from: the shared gateway (`GatewayHandler.routingState`). */
export interface RoutingStateSource {
  state(): CredentialRoutingView[];
  /**
   * The latest routing decisions (`GatewayHandler.routeDecisions`), waiting
   * for one with `query.wait` until `signal` aborts; without it
   * `/routing/decisions` is absent.
   */
  decisions?(
    query: RouteDecisionQuery,
    signal: AbortSignal,
  ): Promise<RouteDecisionPage>;
}

const reading = {
  type: "object",
  additionalProperties: false,
  required: ["window", "usedPercent", "observedAt"],
  properties: {
    window: { type: "string" },
    usedPercent: { type: "number" },
    resetsAt: { type: "string" },
    spanSeconds: { type: "number" },
    observedAt: { type: "string" },
  },
} as const;
const item = {
  type: "object",
  additionalProperties: false,
  required: [
    "provider",
    "credential",
    "credentialName",
    "enabled",
    "state",
    "readings",
  ],
  properties: {
    provider: { type: "string" },
    credential: { type: "string" },
    credentialName: { type: "string" },
    enabled: { type: "boolean" },
    state: { type: "string", enum: ["closed", "open", "half-open"] },
    restingUntil: { type: "string" },
    lastFailure: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "status", "at"],
      properties: {
        kind: { type: "string" },
        status: { type: "integer" },
        at: { type: "string" },
      },
    },
    readings: { type: "array", items: reading },
    unlistedModels: { type: "array", items: { type: "string" } },
  },
} as const;

/**
 * `GET /api/v1/routing/state`: every credential of every provider with the
 * gateway's in-memory routing state (breaker, rest, last failure class,
 * allowance readings). A credential the gateway knows nothing about is
 * closed with no readings. The state lives in the daemon's memory and
 * starts empty after a restart, except readings, which persist. A
 * credential whose own model list the last refresh read has
 * `unlistedModels`: the provider's models its list lacks, which the
 * gateway does not send it.
 */
export function registerRoutingStateRoutes(
  api: FastifyInstance,
  store: ModelPlaneStore,
  source: RoutingStateSource,
): void {
  api.get(
    "/routing/state",
    { schema: { response: responses(listOf(item)) } },
    async () => {
      const known = new Map(
        source
          .state()
          .map((state) => [
            `${state.provider}\u0000${state.credential}`,
            state,
          ]),
      );
      const items = [];
      for (const provider of await store.listProviders())
        for (const credential of provider.credentials) {
          const state = known.get(`${provider.id}\u0000${credential.id}`);
          items.push({
            provider: provider.id,
            credential: credential.id,
            credentialName: credential.name,
            enabled: credential.enabled,
            state: state?.state ?? "closed",
            ...(state?.restingUntil
              ? { restingUntil: state.restingUntil }
              : {}),
            ...(state?.lastFailure ? { lastFailure: state.lastFailure } : {}),
            readings: state?.readings ?? [],
            ...(provider.models.listedFor?.includes(credential.id)
              ? {
                  unlistedModels: provider.models.list
                    .filter(
                      (model) =>
                        model.credentials !== undefined &&
                        !model.credentials.includes(credential.id),
                    )
                    .map((model) => model.id),
                }
              : {}),
          });
        }
      return { items, nextCursor: null };
    },
  );
  const decisions = source.decisions?.bind(source);
  if (decisions)
    api.get<{ Querystring: RouteDecisionQuery }>(
      "/routing/decisions",
      {
        schema: {
          querystring: routeDecisionsQuerySchema,
          response: responses(routeDecisionPageSchema),
        },
      },
      async (request, reply) => {
        // A long poll ends early when its client goes away.
        const abort = new AbortController();
        const gone = () => {
          if (!reply.raw.writableFinished) abort.abort();
        };
        reply.raw.once("close", gone);
        try {
          return await decisions(request.query, abort.signal);
        } finally {
          reply.raw.removeListener("close", gone);
        }
      },
    );
}
