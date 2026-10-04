// SPDX-License-Identifier: MIT
import type { FastifyInstance } from "fastify";
import { reasoningEfforts, wiringTiers } from "@harnesshub/core/model-plane";
import type { AgentWiringService, WiringRequest } from "../agents-wiring.js";
import {
  emptyBodySchema,
  listOf,
  noContent,
  responses,
} from "./api-v1-schemas.js";

const text = (maxLength: number) =>
  ({ type: "string", minLength: 1, maxLength }) as const;
const modelRef = {
  type: "string",
  minLength: 3,
  maxLength: 512,
  pattern: "^[a-z0-9][a-z0-9-]{0,62}/\\S+$",
} as const;
const sha256 = { type: "string", pattern: "^[0-9a-f]{64}$" } as const;
/** An allow or deny entry: a Model Ref, `provider/*`, `group/<id>` or `*`. */
const modelPattern = { anyOf: [modelRef, { const: "*" }] } as const;
const tiersSchema = {
  type: "object",
  additionalProperties: false,
  properties: Object.fromEntries(wiringTiers.map((tier) => [tier, modelRef])),
  description:
    "A model per tier the agent has (capabilities.tiers); an absent tier follows model",
} as const;
const effortSchema = { enum: [...reasoningEfforts] } as const;
const optionsSchema = {
  type: "object",
  maxProperties: 20,
  additionalProperties: text(200),
  description:
    "Adapter options (capabilities.options), such as codexAuth: chatgpt",
} as const;

const agentParams = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: { id: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,62}$" } },
} as const;

const profileParams = {
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: {
    name: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$" },
  },
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
  required: [
    "id",
    "name",
    "protocol",
    "keyDelivery",
    "capabilities",
    "installation",
    "wiring",
  ],
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    protocol: { enum: ["chat", "responses", "anthropic", "gemini"] },
    keyDelivery: { enum: ["config-file", "env-file"] },
    capabilities: {
      type: "object",
      additionalProperties: false,
      required: ["tiers", "efforts", "options"],
      properties: {
        tiers: { type: "array", items: { enum: [...wiringTiers] } },
        efforts: { type: "array", items: effortSchema },
        options: {
          type: "object",
          additionalProperties: { type: "array", items: { type: "string" } },
          description: "Allowed values per option, the default first",
        },
      },
    },
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
      required: ["models", "hidden", "keyState", "wiredAt", "files", "drift"],
      properties: {
        model: {
          type: "string",
          description: "Absent for an agent that keeps its own models",
        },
        tiers: tiersSchema,
        effort: effortSchema,
        options: { type: "object", additionalProperties: { type: "string" } },
        models: {
          type: "array",
          items: { type: "string" },
          description:
            "The models the agent lists and its key may use; models added to the gateway later are included",
        },
        hidden: {
          type: "array",
          items: { type: "string" },
          description: "Models hidden from the agent (its key's deny list)",
        },
        keyId: {
          type: "string",
          description: "Absent for an agent that signs in by itself",
        },
        keyState: {
          enum: ["active", "revoked", "expired", "missing", "none"],
        },
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
  required: ["adapterId", "protocol", "keyDelivery", "changed", "files"],
  properties: {
    adapterId: { type: "string" },
    protocol: { enum: ["chat", "responses", "anthropic", "gemini"] },
    keyDelivery: { enum: ["config-file", "env-file"] },
    model: { type: "string" },
    keyId: { type: "string" },
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
              "Unified diff; Gateway Keys appear as hhk_a_xxxx… and replaced key values as <redacted>; a file HarnessHub generates is summarised by its size",
          },
        },
      },
    },
  },
} as const;

const requestProperties = {
  model: {
    ...modelRef,
    description:
      "Default: the current model; an agent that signs in by itself takes none",
  },
  models: {
    type: "array",
    maxItems: 500,
    items: modelPattern,
    description:
      "Models the agent may list (and its key allows): provider/model, provider/*, group/<id> or *; default: the current list, else *",
  },
  tiers: tiersSchema,
  effort: {
    type: ["string", "null"],
    enum: [...reasoningEfforts, null],
    description:
      "One of capabilities.efforts; default: the current effort; null clears it",
  },
  options: optionsSchema,
} as const;

const planBodySchema = {
  type: "object",
  additionalProperties: false,
  properties: requestProperties,
} as const;

const confirmedPlanSchema = {
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
} as const;

const wireBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["expect"],
  properties: { ...requestProperties, expect: confirmedPlanSchema },
} as const;

const modelsBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["hidden"],
  properties: {
    hidden: {
      type: "array",
      maxItems: 1000,
      uniqueItems: true,
      items: modelPattern,
      description:
        "The models to hide from the agent; every other model of the gateway, including ones added later, is shown",
    },
  },
} as const;

const choiceSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    model: { type: "string" },
    tiers: tiersSchema,
    effort: effortSchema,
    options: { type: "object", additionalProperties: { type: "string" } },
  },
} as const;

const profileSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "agents", "createdAt", "updatedAt"],
  properties: {
    name: { type: "string" },
    agents: {
      type: "object",
      additionalProperties: choiceSchema,
      description: "The model choices of each wired agent, by agent id",
    },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
} as const;

const profilePlanSchema = {
  type: "object",
  additionalProperties: false,
  required: ["profile", "agents"],
  properties: {
    profile: profileSchema,
    agents: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["adapterId", "changed", "plan"],
        properties: {
          adapterId: { type: "string" },
          changed: { type: "boolean" },
          plan: { ...planSchema, type: ["object", "null"] },
        },
      },
    },
  },
} as const;

const profileApplyBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["expect"],
  properties: {
    expect: {
      type: "object",
      maxProperties: 200,
      additionalProperties: confirmedPlanSchema,
      description:
        "The confirmed plan of every changed agent, by agent id (the plan response's agents will do)",
    },
  },
} as const;

const profileAppliedSchema = {
  type: "object",
  additionalProperties: false,
  required: ["profile", "agents"],
  properties: {
    profile: profileSchema,
    agents: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["adapterId", "outcome", "agent"],
        properties: {
          adapterId: { type: "string" },
          outcome: { enum: ["applied", "unchanged"] },
          agent: agentSchema,
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
type ProfileParams = { Params: { name: string } };
type ConfirmedFile = { path: string; exists: boolean; hash?: string };
type Confirmed = { files: ConfirmedFile[] };

/**
 * `/api/v1/agents`: the supported agents with installation, wiring and
 * drift, and the wiring operations (plan, apply, rotate, unwire, hidden
 * models) of `AgentWiringService`; `/api/v1/profiles`: named snapshots of
 * every wired agent's model choices and their application. Wiring errors
 * keep their `WIRING_*` codes.
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
  api.post<Params & { Body: WiringRequest & { expect: Confirmed } }>(
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
  api.put<Params & { Body: { hidden: string[] } }>(
    "/agents/:id/models",
    {
      schema: {
        params: agentParams,
        body: modelsBodySchema,
        response: responses(agentSchema),
      },
    },
    async (request) => agents.setHidden(request.params.id, request.body.hidden),
  );
  api.get(
    "/profiles",
    { schema: { response: responses(listOf(profileSchema)) } },
    async () => ({ items: await agents.listProfiles(), nextCursor: null }),
  );
  api.get<ProfileParams>(
    "/profiles/:name",
    { schema: { params: profileParams, response: responses(profileSchema) } },
    async (request) => agents.getProfile(request.params.name),
  );
  api.put<ProfileParams>(
    "/profiles/:name",
    {
      schema: {
        params: profileParams,
        body: emptyBodySchema,
        response: responses(profileSchema),
      },
    },
    async (request) => agents.saveProfile(request.params.name),
  );
  api.delete<ProfileParams>(
    "/profiles/:name",
    {
      schema: { params: profileParams, response: noContent },
    },
    async (request, reply) => {
      await agents.deleteProfile(request.params.name);
      return reply.code(204).send();
    },
  );
  api.post<ProfileParams>(
    "/profiles/:name/plan",
    {
      schema: {
        params: profileParams,
        body: emptyBodySchema,
        response: responses(profilePlanSchema),
      },
    },
    async (request) => agents.planProfile(request.params.name),
  );
  api.post<ProfileParams & { Body: { expect: Record<string, Confirmed> } }>(
    "/profiles/:name/apply",
    {
      schema: {
        params: profileParams,
        body: profileApplyBodySchema,
        response: responses(profileAppliedSchema),
      },
    },
    async (request) =>
      agents.applyProfile(request.params.name, request.body.expect),
  );
}
