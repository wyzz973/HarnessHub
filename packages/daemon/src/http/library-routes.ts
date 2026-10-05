// SPDX-License-Identifier: MIT
import type { FastifyInstance } from "fastify";
import { libraryAgents } from "@harnesshub/agents/library/index";
import type { LibraryService, LibrarySyncRequest } from "../library-service.js";
import { listOf, noContent, responses } from "./api-v1-schemas.js";

const text = (maxLength: number) =>
  ({ type: "string", minLength: 1, maxLength }) as const;
const sha256 = { type: "string", pattern: "^[0-9a-f]{64}$" } as const;
const timestamp = { type: "string", format: "date-time" } as const;
const agentsSchema = {
  type: "array",
  maxItems: libraryAgents.length,
  uniqueItems: true,
  items: { enum: [...libraryAgents] },
  description: "The agents the item goes to; default none",
} as const;
const stringMap = (description: string) =>
  ({
    type: "object",
    maxProperties: 32,
    additionalProperties: text(8192),
    description,
  }) as const;
const instructionId = {
  type: "string",
  pattern: "^[a-z0-9][a-z0-9-]{0,62}$",
} as const;
const serverName = {
  type: "string",
  pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$",
} as const;
const skillName = {
  type: "string",
  maxLength: 64,
  pattern: "^[a-z0-9]+(-[a-z0-9]+)*$",
} as const;

const secretRef = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "value"],
  properties: {
    kind: { enum: ["env", "file", "store"] },
    value: text(4096),
  },
} as const;
const secretInput = {
  anyOf: [
    {
      ...secretRef,
      description:
        "An environment variable or an absolute file; store only for a secret the server already holds",
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["secret"],
      properties: { secret: text(8192) },
      description:
        "A value, which goes to the secret store; it is never returned",
    },
  ],
} as const;
const secretMap = (input: object, description: string) =>
  ({
    type: "object",
    maxProperties: 32,
    additionalProperties: input,
    description,
  }) as const;

const instructionSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "name",
    "sha256",
    "size",
    "agents",
    "createdAt",
    "updatedAt",
  ],
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    sha256,
    size: { type: "integer" },
    agents: { type: "array", items: { type: "string" } },
    text: {
      type: "string",
      description: "The Markdown text; on single-item responses",
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  },
} as const;
const instructionFields = {
  name: text(200),
  text: { ...text(256 * 1024), description: "Markdown; CRLF becomes LF" },
  agents: agentsSchema,
} as const;
const instructionBody = {
  type: "object",
  additionalProperties: false,
  required: ["text"],
  properties: instructionFields,
} as const;
const instructionCreateBody = {
  type: "object",
  additionalProperties: false,
  required: ["id", "text"],
  properties: { id: instructionId, ...instructionFields },
} as const;

const mcpSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "transport", "agents", "createdAt", "updatedAt"],
  properties: {
    name: { type: "string" },
    transport: { enum: ["stdio", "http", "sse"] },
    command: { type: "string" },
    args: { type: "array", items: { type: "string" } },
    url: { type: "string" },
    env: { type: "object", additionalProperties: { type: "string" } },
    secretEnv: { type: "object", additionalProperties: secretRef },
    headers: { type: "object", additionalProperties: { type: "string" } },
    secretHeaders: { type: "object", additionalProperties: secretRef },
    agents: { type: "array", items: { type: "string" } },
    createdAt: timestamp,
    updatedAt: timestamp,
  },
} as const;
const mcpFields = {
  transport: { enum: ["stdio", "http", "sse"] },
  command: {
    ...text(8192),
    description: "stdio: the program the agent starts",
  },
  args: {
    type: "array",
    maxItems: 128,
    items: { type: "string", maxLength: 8192 },
  },
  url: {
    ...text(8192),
    description: "http or sse: the endpoint, without credentials",
  },
  env: stringMap(
    "Plain environment of a stdio server; names that carry credentials (…_TOKEN, …_API_KEY) belong in secretEnv",
  ),
  secretEnv: secretMap(secretInput, "Environment whose values are secrets"),
  headers: stringMap(
    "Plain headers of an http or sse server; Authorization and the like belong in secretHeaders",
  ),
  secretHeaders: secretMap(secretInput, "Headers whose values are secrets"),
  agents: agentsSchema,
} as const;
const mcpBody = {
  type: "object",
  additionalProperties: false,
  required: ["transport"],
  properties: mcpFields,
} as const;
const mcpCreateBody = {
  type: "object",
  additionalProperties: false,
  required: ["name", "transport"],
  properties: { name: serverName, ...mcpFields },
} as const;

const skillSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "name",
    "description",
    "sha256",
    "files",
    "size",
    "agents",
    "createdAt",
    "updatedAt",
  ],
  properties: {
    name: { type: "string" },
    description: { type: "string" },
    sha256: { ...sha256, description: "The stored version" },
    files: { type: "integer" },
    size: { type: "integer" },
    agents: { type: "array", items: { type: "string" } },
    createdAt: timestamp,
    updatedAt: timestamp,
  },
} as const;
/** Base64 of 20 MiB of files, with room for the JSON around it. */
const SKILL_UPLOAD_BODY_LIMIT = 30 * 1024 * 1024;
const skillImportBody = {
  type: "object",
  additionalProperties: false,
  properties: {
    source: {
      ...text(4096),
      description:
        "Absolute path of the skill directory on the daemon's machine; its name is the skill's",
    },
    name: {
      ...text(64),
      description: "An upload: the skill's name, which its directory has",
    },
    files: {
      type: "object",
      maxProperties: 500,
      additionalProperties: { type: "string" },
      description:
        "An upload: each file's base64 content by its path with / below the skill directory",
    },
    exec: {
      type: "array",
      maxItems: 500,
      items: text(1024),
      description: "An upload: the paths of its executable files",
    },
    agents: agentsSchema,
    replace: {
      type: "boolean",
      description:
        "Replace the Library's skill of the same name; without it, 409 LIBRARY_EXISTS",
    },
  },
} as const;
const skillPatchBody = {
  type: "object",
  additionalProperties: false,
  required: ["agents"],
  properties: { agents: agentsSchema },
} as const;

const syncProperties = {
  agents: {
    ...agentsSchema,
    minItems: 1,
    description: "The agents to sync; default every Library agent",
  },
  allowPlaintextSecret: {
    type: "boolean",
    description:
      "Write the values of secrets an agent cannot reference into its file (shown masked in the plan)",
  },
  placement: {
    enum: ["auto", "copy"],
    description: "copy copies skills instead of linking them",
  },
} as const;
const syncBody = {
  type: "object",
  additionalProperties: false,
  properties: syncProperties,
} as const;
const applyBody = {
  type: "object",
  additionalProperties: false,
  required: ["expect"],
  properties: {
    ...syncProperties,
    expect: {
      type: "object",
      required: ["agents"],
      description:
        "The plan the user confirmed (the plan response will do): a file that changed since fails with 409 LIBRARY_CONCURRENT_MODIFICATION",
      properties: {
        agents: {
          type: "array",
          maxItems: libraryAgents.length,
          items: {
            type: "object",
            required: ["agent", "files"],
            properties: {
              agent: { type: "string" },
              files: {
                type: "array",
                maxItems: 10,
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
      },
    },
  },
} as const;
const planSchema = {
  type: "object",
  additionalProperties: false,
  required: ["changed", "agents"],
  properties: {
    changed: { type: "boolean" },
    agents: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "agent",
          "name",
          "changed",
          "files",
          "skills",
          "refused",
          "warnings",
        ],
        properties: {
          agent: { type: "string" },
          name: { type: "string" },
          changed: { type: "boolean" },
          files: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["kind", "path", "exists", "action", "diff"],
              properties: {
                kind: { enum: ["instructions", "mcp"] },
                path: { type: "string" },
                exists: { type: "boolean" },
                hash: sha256,
                action: { enum: ["write", "restore", "delete", "unchanged"] },
                diff: {
                  type: "string",
                  description:
                    "Unified diff; secret values written as plain text show as <secret>",
                },
              },
            },
          },
          skills: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["name", "path", "action"],
              properties: {
                name: { type: "string" },
                path: { type: "string" },
                action: { enum: ["place", "replace", "remove", "unchanged"] },
              },
            },
          },
          refused: {
            type: "array",
            description:
              "Items assigned to the agent that are not written, and why",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["kind", "name", "reason"],
              properties: {
                kind: { enum: ["instructions", "mcp", "skills"] },
                name: { type: "string" },
                reason: { type: "string" },
              },
            },
          },
          warnings: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
} as const;

const params = (key: string, schema: object) =>
  ({
    type: "object",
    additionalProperties: false,
    required: [key],
    properties: { [key]: schema },
  }) as const;

type Id = { Params: { id: string } };
type Name = { Params: { name: string } };
type Apply = LibrarySyncRequest & {
  expect: {
    agents: Array<{
      agent: string;
      files: Array<{ path: string; exists: boolean; hash?: string }>;
    }>;
  };
};

/**
 * `/api/v1/library`: instruction sets, MCP servers and skills of the
 * Library (`LibraryService`), and syncing them into the agents' own files:
 * a plan with diffs first, then an apply of the confirmed plan. Item
 * failures keep their `LIBRARY_*` codes; a secret reference to one of
 * HarnessHub's own credentials is 400 SECRET_REF_FORBIDDEN.
 */
export function registerLibraryRoutes(
  api: FastifyInstance,
  library: LibraryService,
): void {
  api.get(
    "/library/instructions",
    { schema: { response: responses(listOf(instructionSchema)) } },
    async () => ({
      items: (await library.index()).instructions,
      nextCursor: null,
    }),
  );
  api.post<{ Body: { id: string } }>(
    "/library/instructions",
    {
      schema: {
        body: instructionCreateBody,
        response: responses(instructionSchema, 201),
      },
    },
    async (request, reply) => {
      const { id, ...fields } = request.body;
      return reply
        .code(201)
        .send(await library.putInstructions(id, fields, true));
    },
  );
  api.get<Id>(
    "/library/instructions/:id",
    {
      schema: {
        params: params("id", instructionId),
        response: responses(instructionSchema),
      },
    },
    async (request) => library.instructions(request.params.id),
  );
  api.put<Id & { Body: unknown }>(
    "/library/instructions/:id",
    {
      schema: {
        params: params("id", instructionId),
        body: instructionBody,
        response: responses(instructionSchema),
      },
    },
    async (request) =>
      library.putInstructions(request.params.id, request.body, false),
  );
  api.delete<Id>(
    "/library/instructions/:id",
    { schema: { params: params("id", instructionId), response: noContent } },
    async (request, reply) => {
      await library.remove("instructions", request.params.id);
      return reply.code(204).send();
    },
  );

  api.get(
    "/library/mcp",
    { schema: { response: responses(listOf(mcpSchema)) } },
    async () => ({ items: (await library.index()).mcp, nextCursor: null }),
  );
  api.post<{ Body: { name: string } }>(
    "/library/mcp",
    {
      schema: { body: mcpCreateBody, response: responses(mcpSchema, 201) },
    },
    async (request, reply) => {
      const { name, ...fields } = request.body;
      return reply.code(201).send(await library.putMcp(name, fields, true));
    },
  );
  api.get<Name>(
    "/library/mcp/:name",
    {
      schema: {
        params: params("name", serverName),
        response: responses(mcpSchema),
      },
    },
    async (request) => library.mcp(request.params.name),
  );
  api.put<Name & { Body: unknown }>(
    "/library/mcp/:name",
    {
      schema: {
        params: params("name", serverName),
        body: mcpBody,
        response: responses(mcpSchema),
      },
    },
    async (request) => library.putMcp(request.params.name, request.body, false),
  );
  api.delete<Name>(
    "/library/mcp/:name",
    { schema: { params: params("name", serverName), response: noContent } },
    async (request, reply) => {
      await library.remove("mcp", request.params.name);
      return reply.code(204).send();
    },
  );

  api.get(
    "/library/skills",
    { schema: { response: responses(listOf(skillSchema)) } },
    async () => ({ items: (await library.index()).skills, nextCursor: null }),
  );
  api.post<{ Body: unknown }>(
    "/library/skills",
    {
      bodyLimit: SKILL_UPLOAD_BODY_LIMIT,
      schema: {
        body: skillImportBody,
        response: responses(skillSchema, 201),
      },
    },
    async (request, reply) =>
      reply.code(201).send(await library.importSkill(request.body)),
  );
  api.get<Name>(
    "/library/skills/:name",
    {
      schema: {
        params: params("name", skillName),
        response: responses(skillSchema),
      },
    },
    async (request) => library.skill(request.params.name),
  );
  api.patch<Name & { Body: unknown }>(
    "/library/skills/:name",
    {
      schema: {
        params: params("name", skillName),
        body: skillPatchBody,
        response: responses(skillSchema),
      },
    },
    async (request) =>
      library.setSkillAgents(request.params.name, request.body),
  );
  api.delete<Name>(
    "/library/skills/:name",
    { schema: { params: params("name", skillName), response: noContent } },
    async (request, reply) => {
      await library.remove("skills", request.params.name);
      return reply.code(204).send();
    },
  );

  api.post<{ Body: LibrarySyncRequest }>(
    "/library/sync/plan",
    { schema: { body: syncBody, response: responses(planSchema) } },
    async (request) => library.plan(request.body),
  );
  api.post<{ Body: Apply }>(
    "/library/sync/apply",
    { schema: { body: applyBody, response: responses(planSchema) } },
    async (request) => library.apply(request.body),
  );
}
