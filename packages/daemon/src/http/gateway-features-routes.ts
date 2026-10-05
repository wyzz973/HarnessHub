// SPDX-License-Identifier: MIT
import type { FastifyInstance } from "fastify";
import {
  searchBackendKinds,
  type GatewayFeatures,
  type RedactionRule,
  type SearchBackend,
  type SearchBackendKind,
} from "@harnesshub/core/gateway-features";
import { idParams, responses } from "./api-v1-schemas.js";

/** The gateway features without secret references: a search backend says whether it has a key. */
export interface GatewayFeaturesView extends Omit<
  GatewayFeatures,
  "search" | "updatedAt"
> {
  search?: {
    backends: (Omit<SearchBackend, "credential"> & { hasKey: boolean })[];
  };
}

/** The gateway features as the API needs them (`GatewayFeaturesFile` of ../gateway-features.ts). */
export interface GatewayFeaturesControl {
  view(): GatewayFeaturesView;
  /**
   * Turn redaction on or off and replace the user's rules.
   *
   * @throws ApiProblem `GATEWAY_FEATURES_INVALID` (400, the rule in `errors[]`).
   */
  setRedaction(input: {
    enabled?: boolean;
    rules?: RedactionRule[];
  }): Promise<GatewayFeaturesView>;
  /**
   * Set the model that describes images, or `null` for none.
   *
   * @throws ApiProblem `GATEWAY_FEATURES_INVALID` (400).
   */
  setVision(model: string | null): Promise<GatewayFeaturesView>;
  /**
   * Set the usage alert's threshold, or `null` for none.
   *
   * @throws ApiProblem `GATEWAY_FEATURES_INVALID` (400).
   */
  setAlerts(usagePercent: number | null): Promise<GatewayFeaturesView>;
  /**
   * Add a web search backend; its key goes to the secret store.
   *
   * @throws ApiProblem `GATEWAY_FEATURES_INVALID` (400): a missing key, or
   *   SearXNG without `baseUrl`.
   */
  addSearch(input: {
    kind: SearchBackendKind;
    key?: string;
    baseUrl?: string;
  }): Promise<GatewayFeaturesView>;
  /**
   * Remove a search backend and delete its key.
   *
   * @throws HubError `SEARCH_BACKEND_NOT_FOUND` (404).
   */
  removeSearch(id: string): Promise<GatewayFeaturesView>;
}

const rule = {
  type: "object",
  additionalProperties: false,
  required: ["name", "pattern"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: 32 },
    pattern: { type: "string", minLength: 1, maxLength: 512 },
    flags: { type: "string", enum: ["", "i"] },
  },
} as const;
const kind = { type: "string", enum: [...searchBackendKinds] } as const;
const featuresSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "redaction"],
  properties: {
    schemaVersion: { type: "integer", enum: [1] },
    redaction: {
      type: "object",
      additionalProperties: false,
      required: ["enabled", "rules"],
      properties: {
        enabled: { type: "boolean" },
        rules: { type: "array", items: rule },
      },
    },
    vision: {
      type: "object",
      additionalProperties: false,
      required: ["model"],
      properties: { model: { type: "string" } },
    },
    alerts: {
      type: "object",
      additionalProperties: false,
      required: ["usagePercent"],
      properties: { usagePercent: { type: "integer" } },
    },
    search: {
      type: "object",
      additionalProperties: false,
      required: ["backends"],
      properties: {
        backends: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "kind", "hasKey"],
            properties: {
              id: { type: "string" },
              kind,
              baseUrl: { type: "string" },
              hasKey: { type: "boolean" },
            },
          },
        },
      },
    },
  },
} as const;
/**
 * `/api/v1/gateway/features/*` (Magpie parity §11): outbound redaction, the
 * vision model, web search backends and the usage alert of the shared
 * gateway. Registered inside the `/api/v1` plugin, so the admin token and
 * loopback rules apply.
 */
export function registerGatewayFeaturesRoutes(
  api: FastifyInstance,
  features: GatewayFeaturesControl,
): void {
  const ok = { response: responses(featuresSchema) };
  api.get("/gateway/features", { schema: ok }, async () => features.view());
  api.put<{ Body: { enabled?: boolean; rules?: RedactionRule[] } }>(
    "/gateway/features/redaction",
    {
      schema: {
        ...ok,
        body: {
          type: "object",
          additionalProperties: false,
          minProperties: 1,
          properties: {
            enabled: { type: "boolean" },
            rules: { type: "array", maxItems: 64, items: rule },
          },
        },
      },
    },
    async (request) => features.setRedaction(request.body),
  );
  api.put<{ Body: { model: string } }>(
    "/gateway/features/vision",
    {
      schema: {
        ...ok,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["model"],
          properties: {
            model: { type: "string", minLength: 1, maxLength: 300 },
          },
        },
      },
    },
    async (request) => features.setVision(request.body.model),
  );
  api.delete("/gateway/features/vision", { schema: ok }, async () =>
    features.setVision(null),
  );
  api.put<{ Body: { usagePercent: number } }>(
    "/gateway/features/alerts",
    {
      schema: {
        ...ok,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["usagePercent"],
          properties: {
            usagePercent: { type: "integer", minimum: 1, maximum: 100 },
          },
        },
      },
    },
    async (request) => features.setAlerts(request.body.usagePercent),
  );
  api.delete("/gateway/features/alerts", { schema: ok }, async () =>
    features.setAlerts(null),
  );
  api.post<{
    Body: { kind: SearchBackendKind; key?: string; baseUrl?: string };
  }>(
    "/gateway/features/search",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["kind"],
          properties: {
            kind,
            key: { type: "string", minLength: 1, maxLength: 4096 },
            baseUrl: { type: "string", minLength: 1, maxLength: 2048 },
          },
        },
        response: responses(featuresSchema, 201),
      },
    },
    async (request, reply) =>
      reply.code(201).send(await features.addSearch(request.body)),
  );
  api.delete<{ Params: { id: string } }>(
    "/gateway/features/search/:id",
    { schema: { ...ok, params: idParams } },
    async (request) => features.removeSearch(request.params.id),
  );
}
