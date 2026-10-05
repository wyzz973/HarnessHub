// SPDX-License-Identifier: MIT
import type { FastifyInstance } from "fastify";
import type { ModelPlaneStore } from "@harnesshub/core/model-plane";
import type { UsageAlert } from "../usage-alerts.js";
import { responses } from "./api-v1-schemas.js";

/** The usage alerts as the API needs them (`UsageAlerts` of ../usage-alerts.ts). */
export interface UsageAlertsSource {
  /** The alerts said in the last 40 days, newest first. */
  list(): UsageAlert[];
  /** The threshold in force; undefined when no alert is set. */
  percent(): number | undefined;
}

const alertSchema = {
  type: "object",
  additionalProperties: false,
  required: ["at", "provider", "credential", "window", "usedPercent"],
  properties: {
    at: { type: "string" },
    provider: { type: "string" },
    credential: { type: "string" },
    credentialName: { type: "string" },
    window: { type: "string" },
    usedPercent: { type: "number" },
    resetsAt: { type: "string" },
  },
} as const;

/**
 * `GET /api/v1/usage/alerts`: the threshold (`alerts.usagePercent` of the
 * gateway features, null when off) and the alerts said in the last 40 days,
 * newest first, each with its credential's current name when it still
 * exists. Read-only.
 */
export function registerUsageAlertsRoutes(
  api: FastifyInstance,
  store: ModelPlaneStore,
  source: UsageAlertsSource,
): void {
  api.get(
    "/usage/alerts",
    {
      schema: {
        response: responses({
          type: "object",
          additionalProperties: false,
          required: ["usagePercent", "items"],
          properties: {
            usagePercent: { type: ["integer", "null"] },
            items: { type: "array", items: alertSchema },
          },
        }),
      },
    },
    async () => {
      const names = new Map<string, string>();
      for (const provider of await store.listProviders())
        for (const credential of provider.credentials)
          names.set(`${provider.id}\u0000${credential.id}`, credential.name);
      return {
        usagePercent: source.percent() ?? null,
        items: source.list().map((alert) => {
          const name = names.get(`${alert.provider}\u0000${alert.credential}`);
          return name === undefined
            ? alert
            : { ...alert, credentialName: name };
        }),
      };
    },
  );
}
