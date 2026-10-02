// SPDX-License-Identifier: MIT
import type { FastifyInstance } from "fastify";
import type { AgentWiringService, WiringRequest } from "../agents-wiring.js";
import { emptyBodySchema, listOf, responses } from "./api-v1-schemas.js";

const text = (maxLength: number) =>
  ({ type: "string", minLength: 1, maxLength }) as const;
const modelRef = {
  type: "string",
  minLength: 3,
  maxLength: 512,
  pattern: "^[a-z0-9][a-z0-9-]{0,62}/\\S+$",
} as const;
const sha256 = { type: "string", pattern: "^[0-9a-f]{64}$" } as const;

const agentParams = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: { id: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,62}$" } },
} as const;

const findingSchema = {
  type: "object",
  additionalProperties: false,
  required: ["path", "keyPath", "kind", "reason"],
  properties: {
    path: { type: "string" },
    keyPath: { type: "array", items: { type: "string" } },
    kind: { enum: ["unwired", "replaced", "foreign-gateway"] },
    reason: {
      enum: ["missing", "changed", "other-key", "file-missing", "unreadable"],
    },
  },
} as const;

const agentSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "name", "protocol", "keyDelivery", "installation", "wiring"],
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    protocol: { enum: ["chat", "responses", "anthropic", "gemini"] },
    keyDelivery: { enum: ["config-file", "env-file"] },
    installation: {
      type: "object",
      additionalProperties: false,
      required: ["status", "configDirectories"],
      properties: {
        status: { enum: ["installed", "configured-only", "not-found"] },
        executable: { type: "string" },
        configDirectories: { type: "array", items: { type: "string" } },
      },
    },
    wiring: {
      type: ["object", "null"],
      additionalProperties: false,
      required: [
        "model",
        "models",
        "keyId",
        "keyState",
        "wiredAt",
        "files",
        "drift",
      ],
      properties: {
        model: { type: "string" },
        models: { type: "array", items: { type: "string" } },
        keyId: { type: "string" },
        keyState: { enum: ["active", "revoked", "expired", "missing"] },
        wiredAt: { type: "string", format: "date-time" },
        files: { type: "array", items: { type: "string" } },
        drift: {
          type: ["object", "null"],
          additionalProperties: false,
          required: ["drifted", "kinds", "findings"],
          properties: {
            drifted: { type: "boolean" },
            kinds: {
              type: "array",
              items: { enum: ["unwired", "replaced", "foreign-gateway"] },
            },
            findings: { type: "array", items: findingSchema },
          },
        },
        driftError: { type: "string" },
      },
    },
  },
} as const;

const planSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "adapterId",
    "protocol",
    "keyDelivery",
    "model",
    "changed",
    "files",
  ],
  properties: {
    adapterId: { type: "string" },
    protocol: { enum: ["chat", "responses", "anthropic", "gemini"] },
    keyDelivery: { enum: ["config-file", "env-file"] },
    model: { type: "string" },
    changed: { type: "boolean" },
    files: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "path", "format", "exists", "changes", "diff"],
        properties: {
          id: { type: "string" },
          path: { type: "string" },
          format: { enum: ["json", "toml", "yaml", "dotenv"] },
          exists: { type: "boolean" },
          hash: sha256,
          changes: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["keyPath", "op"],
              properties: {
                keyPath: { type: "array", items: { type: "string" } },
                op: { enum: ["set", "remove"] },
                before: { type: "string" },
                after: { type: "string" },
              },
            },
          },
          diff: {
            type: "string",
            description:
              "Unified diff; Gateway Keys appear as hhk_a_xxxx… and replaced key values as <redacted>",
          },
        },
      },
    },
  },
} as const;

const requestProperties = {
  model: modelRef,
  models: {
    type: "array",
    maxItems: 500,
    items: modelRef,
    description:
      "Models the agent's picker lists (and its key allows); default: the current list, or just model",
  },
} as const;

const planBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["model"],
  properties: requestProperties,
} as const;

const wireBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["model", "expect"],
  properties: {
    ...requestProperties,
    expect: {
      type: "object",
      description:
        "The plan the user confirmed (the plan response will do): a file that changed since fails with 409 WIRING_CONCURRENT_MODIFICATION",
      required: ["files"],
      properties: {
        files: {
          type: "array",
          maxItems: 20,
          items: {
            type: "object",
            required: ["path", "exists"],
            properties: {
              path: text(4096),
              exists: { type: "boolean" },
              hash: sha256,
            },
          },
        },
      },
    },
  },
} as const;

const unwireSchema = {
  type: "object",
  additionalProperties: false,
  required: ["agent", "files"],
  properties: {
    agent: agentSchema,
    files: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "action"],
        properties: {
          path: { type: "string" },
          action: {
            enum: [
              "restored",
              "deleted",
              "reverse-patched",
              "unchanged",
              "absent",
            ],
          },
        },
      },
    },
  },
} as const;

type Params = { Params: { id: string } };
type ConfirmedFile = { path: string; exists: boolean; hash?: string };

/**
 * `/api/v1/agents`: the supported agents with installation, wiring and
 * drift, and the wiring operations (plan, apply, rotate, unwire) of
 * `AgentWiringService`. Wiring errors keep their `WIRING_*` codes.
 */
export function registerAgentRoutes(
  api: FastifyInstance,
  agents: AgentWiringService,
): void {
  api.get(
    "/agents",
    { schema: { response: responses(listOf(agentSchema)) } },
    async () => ({ items: await agents.list(), nextCursor: null }),
  );
  api.get<Params>(
    "/agents/:id",
    { schema: { params: agentParams, response: responses(agentSchema) } },
    async (request) => agents.get(request.params.id),
  );
  api.post<Params & { Body: WiringRequest }>(
    "/agents/:id/wiring/plan",
    {
      schema: {
        params: agentParams,
        body: planBodySchema,
        response: responses(planSchema),
      },
    },
    async (request) => agents.plan(request.params.id, request.body),
  );
  api.post<
    Params & {
      Body: WiringRequest & { expect: { files: ConfirmedFile[] } };
    }
  >(
    "/agents/:id/wiring",
    {
      schema: {
        params: agentParams,
        body: wireBodySchema,
        response: responses(agentSchema),
      },
    },
    async (request) => {
      const { expect, ...wiring } = request.body;
      return agents.wire(request.params.id, wiring, expect);
    },
  );
  api.post<Params>(
    "/agents/:id/wiring/rotate",
    {
      schema: {
        params: agentParams,
        body: emptyBodySchema,
        response: responses(agentSchema),
      },
    },
    async (request) => agents.rotate(request.params.id),
  );
  api.delete<Params>(
    "/agents/:id/wiring",
    { schema: { params: agentParams, response: responses(unwireSchema) } },
    async (request) => agents.unwire(request.params.id),
  );
}
