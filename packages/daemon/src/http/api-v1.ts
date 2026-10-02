// SPDX-License-Identifier: MIT
import { createHash, timingSafeEqual } from "node:crypto";
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
import type { ModelPlaneStore } from "@harnesshub/core/model-plane";
import { responses, systemInfoSchema } from "./api-v1-schemas.js";
import { registerModelPlaneRoutes } from "./model-plane-routes.js";

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
}

export interface ApiV1Options {
  /** SHA-256 of the local admin token (`<dataDir>/admin.token`). */
  adminTokenDigest: Buffer;
  modelPlane: ModelPlaneStore;
  secrets: ManagedSecrets;
  system: SystemInfo;
  /** Internal failures (500) are recorded here, without request bodies. */
  log?: LogSink;
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
 * Register `/api/v1` (06-interfaces): every route requires the local admin
 * token as `Authorization: Bearer` and a loopback peer, on top of the
 * server-wide Host and Origin checks; state-changing requests with a body must
 * be JSON (415 otherwise); every error is `application/problem+json`. The
 * plugin is encapsulated, so the legacy `/v1` routes keep their own error
 * format.
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
        const match = /^Bearer ([A-Za-z0-9._~+/=-]{1,512})$/.exec(
          request.headers.authorization ?? "",
        );
        if (!match) {
          reply.header("www-authenticate", 'Bearer realm="harnesshub"');
          throw new HubError(
            "ADMIN_TOKEN_REQUIRED",
            "Send the local admin token as a Bearer token",
            401,
          );
        }
        const presented = createHash("sha256").update(match[1]!).digest();
        if (!timingSafeEqual(presented, options.adminTokenDigest)) {
          reply.header("www-authenticate", 'Bearer error="invalid_token"');
          throw new HubError(
            "ADMIN_TOKEN_INVALID",
            "The admin token is not valid for this daemon",
            401,
          );
        }
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
        async () => options.system,
      );
      registerModelPlaneRoutes(api, options);
    },
    { prefix: "/api/v1" },
  );
}
