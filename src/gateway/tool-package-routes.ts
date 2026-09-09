import type { FastifyInstance } from "fastify";
import type { ToolPackageManagement } from "../domain/tool-packages.js";

/** Thin HTTP compatibility surface; package installation and engine revision logic stay behind the injected domain port. */
export function registerToolPackageRoutes(
  server: FastifyInstance,
  management: ToolPackageManagement,
) {
  server.get("/v1/tool-packs", { schema: { hide: true } }, async () =>
    management.list(),
  );

  server.post(
    "/v1/tool-packs/apply",
    { schema: { hide: true } },
    async (request) => management.apply(request.body),
  );
}
