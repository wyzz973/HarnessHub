// SPDX-License-Identifier: MIT
import type { FastifyInstance } from "fastify";
import type { ModelPlaneStore } from "@harnesshub/core/model-plane";
import { listOf, responses } from "./api-v1-schemas.js";

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
  },
} as const;

/**
 * `GET /api/v1/routing/state`: every credential of every provider with the
 * gateway's in-memory routing state (breaker, rest, last failure class,
 * allowance readings). A credential the gateway knows nothing about is
 * closed with no readings. The state lives in the daemon's memory and
 * starts empty after a restart, except readings, which persist.
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
          });
        }
      return { items, nextCursor: null };
    },
  );
}
