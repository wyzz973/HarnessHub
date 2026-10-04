// SPDX-License-Identifier: MIT
import { STATUS_CODES } from "node:http";
import type {
  FastifyError,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import type { SecretReference } from "@harnesshub/core/engine-configuration";
import { HubError } from "@harnesshub/core/errors";
import type { LogSink } from "@harnesshub/core/logging";
import type {
  CatalogService,
  ModelMetadataStore,
} from "@harnesshub/core/model-metadata";
import type { ModelPlaneStore } from "@harnesshub/core/model-plane";
import type { ProviderPreset } from "@harnesshub/core/provider-presets";
import { responses, systemInfoSchema } from "./api-v1-schemas.js";
import { registerModelPlaneRoutes } from "./model-plane-routes.js";
import type { AgentWiringService, WiringHome } from "../agents-wiring.js";
import { registerAgentRoutes } from "./agents-routes.js";
import {
  registerGatewayShareRoutes,
  type GatewayShareControl,
} from "./gateway-share-routes.js";
import {
  authenticateApiRequest,
  registerConsoleSessionRoutes,
  type ConsoleSessions,
} from "./console-session.js";
import type { BackupService } from "../backup.js";
import type { SyncService } from "../sync.js";
import { registerBackupRoutes } from "./backup-routes.js";

/** Where a problem's `errors[]` entry points: a body member or a query parameter. */
export type ProblemItem =
  { pointer: string; detail: string } | { parameter: string; detail: string };

/**
 * An `/api/v1` failure with RFC 9457 extension members: `errors` locates
 * invalid input, `references` lists the records that block a deletion.
 */
export class ApiProblem extends HubError {
  constructor(
    code: string,
    message: string,
    statusCode: number,
    readonly extensions: {
      errors?: ProblemItem[];
      references?: Array<{ type: string; id: string }>;
    } = {},
  ) {
    super(code, message, statusCode);
    this.name = "ApiProblem";
  }
}

/**
 * Managed secrets as the API needs them (implemented by `SecretStore` of
 * `@harnesshub/secrets/secret-store`, injected by the composition root).
 * Values pass through to the store and are never logged or returned.
 */
export interface ManagedSecrets {
  readonly backend: "keychain" | "dpapi" | "file";
  /** Stores a value; resolves to a `{kind: "store"}` reference. */
  create(value: string): Promise<SecretReference>;
  /** Replaces the value under the same reference. */
  rotate(ref: SecretReference, value: string): Promise<void>;
  /** Deletes the value; false when it did not exist. */
  delete(ref: SecretReference): Promise<boolean>;
  /** Reads any reference kind; env references against `environment`. */
  resolve(
    ref: SecretReference,
    environment: Readonly<NodeJS.ProcessEnv>,
  ): Promise<string>;
}

/** The shipped provider presets (`@harnesshub/gateway/presets`, injected). */
export interface PresetCatalog {
  list(): ProviderPreset[];
  get(id: string): ProviderPreset | undefined;
  /**
   * The preset, region and plan that a Magpie import link's `preset` and
   * `region` name (`resolveMagpiePreset`); undefined when none answers.
   */
  magpie(
    id: string,
    region?: string,
  ): { preset: ProviderPreset; region?: string; plan?: string } | undefined;
}

/** `GET /api/v1/system/info`. */
export interface SystemInfo {
  apiVersion: "v1";
  version: string;
  commit: string;
  pid: number;
  startedAt: string;
  dataDir: string;
  secretBackend: ManagedSecrets["backend"];
  /**
   * Base URLs of the model gateway on this daemon for local clients, by the
   * official SDKs' conventions; null before the listener is bound.
   */
  gateway: {
    openaiBaseUrl: string;
    anthropicBaseUrl: string;
    geminiBaseUrl: string;
  } | null;
}

export interface ApiV1Options {
  /** SHA-256 of the local admin token (`<dataDir>/admin.token`). */
  adminTokenDigest: Buffer;
  /** Console login codes and sessions, the other credential of `/api/v1`. */
  consoleSessions: ConsoleSessions;
  /** The model-plane store with model overrides and metadata provenance. */
  modelPlane: ModelPlaneStore & ModelMetadataStore;
  secrets: ManagedSecrets;
  presets: PresetCatalog;
  /**
   * The models.dev catalog in use and its refresh (the gateway's
   * `CatalogRefresher`, injected and owned by the composition root).
   */
  catalog: CatalogService;
  /** The daemon's environment snapshot, for `env` credential references. */
  environment: Readonly<NodeJS.ProcessEnv>;
  /** Read on every `GET /system/info`. */
  system: () => SystemInfo;
  /** Internal failures (500) are recorded here, without request bodies. */
  log?: LogSink;
  /** Global wiring of local agents (`/agents`). */
  agents: AgentWiringService;
  /**
   * The home whose apps' configuration `/import/preview` may read (the
   * wiring home); absent, imports from other apps are refused.
   */
  importHome?: WiringHome;
  /** LAN sharing of the model gateway; without it `/gateway/share` is absent. */
  gatewayShare?: GatewayShareControl;
  /** Backups and sync; without them `/backup`, `/restore` and `/sync` are absent. */
  backup?: { backups: BackupService; sync: SyncService };
}

const LOOPBACK =
  /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/;
const JSON_BODY = /^application\/(json|merge-patch\+json)\s*(;|$)/i;

function problemBody(
  request: FastifyRequest,
  status: number,
  code: string,
  detail: string,
  extensions: ApiProblem["extensions"] = {},
) {
  return {
    type: `https://harnesshub.dev/problems/${code.toLowerCase().replaceAll("_", "-")}`,
    title: STATUS_CODES[status] ?? "Error",
    status,
    detail,
    instance: request.url.split("?")[0]!.slice(0, 500),
    code,
    requestId: String(request.id),
    ...extensions,
  };
}

function sendProblem(
  request: FastifyRequest,
  reply: FastifyReply,
  status: number,
  code: string,
  detail: string,
  extensions?: ApiProblem["extensions"],
) {
  // Serialized here: the problem media type must not depend on route schemas.
  return reply
    .code(status)
    .header("content-type", "application/problem+json; charset=utf-8")
    .send(
      JSON.stringify(problemBody(request, status, code, detail, extensions)),
    );
}

/** Ajv errors as problem items; input values are never copied into them. */
function validationItems(error: FastifyError): ProblemItem[] {
  const query = error.validationContext === "querystring";
  return (error.validation ?? []).map((item) => {
    const params = item.params as Record<string, unknown>;
    const member =
      typeof params.missingProperty === "string"
        ? params.missingProperty
        : typeof params.additionalProperty === "string"
          ? params.additionalProperty
          : undefined;
    const pointer = `${item.instancePath}${member === undefined ? "" : `/${member}`}`;
    const detail = item.message ?? "is invalid";
    return query
      ? { parameter: pointer.replace(/^\//, ""), detail }
      : { pointer, detail };
  });
}

/**
 * Register `/api/v1` (06-interfaces): every route requires a loopback peer
 * and a credential, the local admin token as `Authorization: Bearer` or a
 * console session (`authenticateApiRequest`), on top of the server-wide Host
 * and Origin checks; state-changing requests with a body must be JSON (415
 * otherwise); every error is `application/problem+json`. The plugin is
 * encapsulated, so the legacy `/v1` routes keep their own error format.
 */
export function registerApiV1(
  server: FastifyInstance,
  options: ApiV1Options,
): void {
  void server.register(
    async (api) => {
      const parse = api.getDefaultJsonParser(
        api.initialConfig.onProtoPoisoning ?? "error",
        api.initialConfig.onConstructorPoisoning ?? "error",
      );
      api.addContentTypeParser(
        "application/merge-patch+json",
        { parseAs: "string" },
        parse,
      );
      api.addHook("onRequest", async (request, reply) => {
        if (!LOOPBACK.test(request.socket.remoteAddress ?? ""))
          throw new HubError(
            "LOCAL_ACCESS_REQUIRED",
            "The management API accepts loopback connections only",
            403,
          );
        authenticateApiRequest(request, reply, {
          adminTokenDigest: options.adminTokenDigest,
          sessions: options.consoleSessions,
        });
        if (
          ["POST", "PUT", "PATCH"].includes(request.method) &&
          !JSON_BODY.test(request.headers["content-type"] ?? "")
        )
          throw new HubError(
            "UNSUPPORTED_MEDIA_TYPE",
            "Requests that change state must be application/json",
            415,
          );
      });
      api.setErrorHandler<FastifyError>((error, request, reply) => {
        if (error instanceof ApiProblem)
          return sendProblem(
            request,
            reply,
            error.statusCode,
            error.code,
            error.message,
            error.extensions,
          );
        if (error instanceof HubError)
          return sendProblem(
            request,
            reply,
            error.statusCode,
            error.code,
            error.message,
          );
        if (error.validation)
          return sendProblem(
            request,
            reply,
            400,
            "INVALID_REQUEST",
            "The request does not match the API schema",
            { errors: validationItems(error) },
          );
        const status = error.statusCode ?? 500;
        if (status >= 400 && status < 500)
          return sendProblem(
            request,
            reply,
            status,
            status === 415
              ? "UNSUPPORTED_MEDIA_TYPE"
              : status === 413
                ? "PAYLOAD_TOO_LARGE"
                : "INVALID_REQUEST",
            "The request could not be accepted",
          );
        options.log?.info("api.error", {
          route: request.routeOptions.url ?? null,
          name: error.name,
          message: error.message,
        });
        return sendProblem(
          request,
          reply,
          500,
          "INTERNAL_ERROR",
          "The request failed",
        );
      });
      api.setNotFoundHandler((request, reply) =>
        sendProblem(
          request,
          reply,
          404,
          "ROUTE_NOT_FOUND",
          "No /api/v1 operation has this method and path",
        ),
      );
      api.get(
        "/system/info",
        { schema: { response: responses(systemInfoSchema) } },
        async () => options.system(),
      );
      registerConsoleSessionRoutes(api, options.consoleSessions);
      registerModelPlaneRoutes(api, options);
      registerAgentRoutes(api, options.agents);
      if (options.gatewayShare)
        registerGatewayShareRoutes(api, options.gatewayShare);
      if (options.backup)
        registerBackupRoutes(api, options.backup.backups, options.backup.sync);
    },
    { prefix: "/api/v1" },
  );
}
