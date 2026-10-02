// SPDX-License-Identifier: MIT
import type { FastifyInstance } from "fastify";
import {
  gatewayShareSchema,
  gatewaySharePutSchema,
  responses,
} from "./api-v1-schemas.js";

/** `GET /api/v1/gateway/share`: the persisted settings and the LAN listener's state. */
export interface GatewayShareStatus {
  lan: { enabled: boolean; host?: string; port?: number; names: string[] };
  publicBaseUrl?: string;
  /** The LAN listener is bound and serving. */
  listening: boolean;
  /** The port it bound (the configured one, or the one the system chose for 0). */
  boundPort?: number;
  /**
   * Base URLs a peer configures (`hh provider add --preset harnesshub-remote
   * --base URL`): one per declared LAN host or name, then `publicBaseUrl`.
   */
  urls: string[];
  /** Why the listener is not serving although sharing is enabled. */
  error?: string;
}

/** Gateway sharing as the API needs it (`GatewayShare` of ../lan-share.ts). */
export interface GatewayShareControl {
  status(): GatewayShareStatus;
  /**
   * Replace the settings and apply them.
   *
   * @throws ApiProblem `GATEWAY_SHARE_INVALID` (400, the field in
   *   `errors[]`) for invalid settings; HubError `GATEWAY_SHARE_LISTEN_FAILED`
   *   (409) when the LAN address cannot be bound.
   */
  update(input: unknown): Promise<GatewayShareStatus>;
}

/**
 * `GET` and `PUT /api/v1/gateway/share` (03-model-plane section 1,
 * 07-data-security section 5.4): read and replace the LAN sharing settings.
 * Registered inside the `/api/v1` plugin, so the admin token and loopback
 * rules apply.
 */
export function registerGatewayShareRoutes(
  api: FastifyInstance,
  share: GatewayShareControl,
): void {
  api.get(
    "/gateway/share",
    { schema: { response: responses(gatewayShareSchema) } },
    async () => share.status(),
  );
  api.put<{ Body: unknown }>(
    "/gateway/share",
    {
      schema: {
        body: gatewaySharePutSchema,
        response: responses(gatewayShareSchema),
      },
    },
    async (request) => share.update(request.body),
  );
}
