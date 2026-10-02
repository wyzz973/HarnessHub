import type { FastifyInstance } from "fastify";
import { secretReferenceSchema } from "../domain/engine-configuration.js";
import { HubError } from "../domain/errors.js";
import { errorResponseSchema } from "../domain/schemas.js";
import type { ToolPackageManagement } from "../domain/tool-packages.js";

/**
 * Tool Pack port used by these routes. It extends the shared domain port with
 * import and unbind; results are produced and validated by the injected
 * implementation, the schemas below only describe and bound HTTP input/output.
 */
export interface ToolPackageRoutesPort extends ToolPackageManagement {
  import(input: unknown): Promise<unknown>;
  unbind(id: string, version: string, input: unknown): Promise<unknown>;
}

const packageId = { type: "string", pattern: "^[a-z][a-z0-9-]{0,31}$" };
const packageVersion = {
  type: "string",
  pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$",
};
const strings = { type: "array", items: { type: "string" } };
const localPath = { type: "string", minLength: 1, maxLength: 4096 };
const targets = {
  anyOf: [
    { type: "string", enum: ["all"] },
    {
      type: "array",
      minItems: 1,
      maxItems: 64,
      uniqueItems: true,
      items: { type: "string", minLength: 1, maxLength: 100 },
    },
  ],
};
const secretBindings = {
  type: "object",
  maxProperties: 64,
  additionalProperties: secretReferenceSchema,
};
const packageReference = {
  type: "object",
  required: ["id", "version"],
  properties: { id: { type: "string" }, version: { type: "string" } },
};
const capabilities = {
  type: "object",
  required: ["skills", "mcp", "cli"],
  properties: { skills: strings, mcp: strings, cli: strings },
};
const counts = {
  type: "object",
  required: ["skills", "mcp", "cli"],
  properties: {
    skills: { type: "integer" },
    mcp: { type: "integer" },
    cli: { type: "integer" },
  },
};
const applyResponse = {
  type: "object",
  required: ["ok", "package", "results", "warnings", "note"],
  properties: {
    ok: { type: "boolean" },
    package: packageReference,
    results: {
      type: "array",
      items: {
        type: "object",
        required: ["engineId", "status"],
        properties: {
          engineId: { type: "string" },
          status: { type: "string", enum: ["applied", "skipped", "failed"] },
          revision: { type: "string" },
          code: { type: "string" },
          reason: { type: "string" },
          capabilities,
          replaced: strings,
        },
      },
    },
    warnings: strings,
    note: { type: "string" },
    engineId: { type: "string" },
    revision: { type: "string" },
    capabilities,
  },
};
const listResponse = {
  type: "object",
  required: ["packages"],
  properties: {
    packages: {
      type: "array",
      items: {
        type: "object",
        required: [
          "schemaVersion",
          "id",
          "version",
          "digest",
          "installedAt",
          "status",
        ],
        properties: {
          schemaVersion: { type: "integer", enum: [1] },
          id: { type: "string" },
          version: { type: "string" },
          digest: { type: "string" },
          installedAt: { type: "integer" },
          status: { type: "string", enum: ["installed", "removed"] },
          displayName: { type: "string" },
          counts,
          engines: strings,
          problem: {
            type: "object",
            required: ["code", "message"],
            properties: {
              code: { type: "string" },
              message: { type: "string" },
            },
          },
        },
      },
    },
  },
};
const importResponse = {
  type: "object",
  required: [
    "ok",
    "package",
    "displayName",
    "digest",
    "format",
    "counts",
    "warnings",
  ],
  properties: {
    ok: { type: "boolean" },
    package: packageReference,
    displayName: { type: "string" },
    digest: { type: "string" },
    format: { type: "string", enum: ["tool-package", "generated"] },
    counts,
    warnings: strings,
    apply: applyResponse,
  },
};
const unbindResponse = {
  type: "object",
  required: ["ok", "package", "results", "note"],
  properties: {
    ok: { type: "boolean" },
    package: packageReference,
    results: {
      type: "array",
      items: {
        type: "object",
        required: ["engineId", "status"],
        properties: {
          engineId: { type: "string" },
          status: { type: "string", enum: ["unbound", "skipped", "failed"] },
          revision: { type: "string" },
          code: { type: "string" },
          reason: { type: "string" },
          removed: {
            type: "object",
            required: ["skills", "mcp"],
            properties: { skills: strings, mcp: strings },
          },
        },
      },
    },
    note: { type: "string" },
  },
};
const responses = (schema: object) => ({
  200: schema,
  default: errorResponseSchema,
});

/** Local-only Tool Pack routes; installation, binding and engine revisions stay behind the injected port. */
export function registerToolPackageRoutes(
  server: FastifyInstance,
  management: ToolPackageRoutesPort,
): void {
  server.get(
    "/v1/tool-packs",
    { schema: { response: responses(listResponse) } },
    async () => management.list(),
  );

  server.post<{ Body: unknown }>(
    "/v1/tool-packs/apply",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            engineIds: targets,
            engineId: { type: "string", minLength: 1, maxLength: 100 },
            package: {
              type: "object",
              additionalProperties: false,
              required: ["id", "version"],
              properties: { id: packageId, version: packageVersion },
            },
            source: localPath,
            workspace: localPath,
            secretBindings,
            replace: { type: "boolean" },
          },
        },
        response: responses(applyResponse),
      },
    },
    async (request) => management.apply(request.body),
  );

  server.post<{ Body: unknown }>(
    "/v1/tool-packs/import",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          // Exactly one of them; the service reports which rule was broken.
          anyOf: [{ required: ["source"] }, { required: ["mcp"] }],
          properties: {
            source: localPath,
            mcp: {
              type: "object",
              required: ["mcpServers"],
              properties: { mcpServers: { type: "object" } },
            },
            kind: { type: "string", enum: ["auto", "skills", "mcp", "cli"] },
            id: packageId,
            version: packageVersion,
            displayName: { type: "string", minLength: 1, maxLength: 128 },
            applyTo: targets,
            replace: { type: "boolean" },
            secretBindings,
          },
        },
        response: responses(importResponse),
      },
    },
    async (request) => management.import(request.body),
  );

  server.delete<{
    Params: { id: string; version: string };
    Querystring: { engineIds?: string };
    Body: unknown;
  }>(
    "/v1/tool-packs/:id/:version/bindings",
    {
      schema: {
        params: {
          type: "object",
          required: ["id", "version"],
          properties: { id: packageId, version: packageVersion },
        },
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            engineIds: { type: "string", minLength: 1, maxLength: 6500 },
          },
        },
        // A DELETE may carry no body; engineIds then comes from the query.
        body: {
          type: ["object", "null"],
          additionalProperties: false,
          required: ["engineIds"],
          properties: { engineIds: targets },
        },
        response: responses(unbindResponse),
      },
    },
    async (request) => {
      const query = request.query.engineIds;
      const body =
        request.body === null || request.body === undefined
          ? undefined
          : request.body;
      if (body !== undefined && query !== undefined)
        throw new HubError(
          "INVALID_REQUEST",
          "Provide engineIds in either the body or the query string",
          400,
        );
      const input =
        body ??
        (query === undefined
          ? {}
          : {
              engineIds:
                query === "all"
                  ? "all"
                  : query
                      .split(",")
                      .map((id) => id.trim())
                      .filter(Boolean),
            });
      return management.unbind(
        request.params.id,
        request.params.version,
        input,
      );
    },
  );
}
