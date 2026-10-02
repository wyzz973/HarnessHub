// SPDX-License-Identifier: MIT
/**
 * Typed client of the daemon's `/api/v1` model-plane API (06-interfaces
 * section 4). It runs anywhere `fetch` exists; local token discovery is in
 * `@harnesshub/sdk/local`, which needs Node.
 */
import type { SecretReference } from "@harnesshub/core/engine-configuration";
import type {
  CatalogMeta,
  MetadataField,
  ModelOverride,
  OverrideValues,
  ResolvedField,
} from "@harnesshub/core/model-metadata";
import type { ProviderPreset } from "@harnesshub/core/provider-presets";
import type {
  GatewayKeyQuota,
  GatewayKeyView,
  ModelCallEntry,
  ProviderConfig,
  ProviderCredential,
  RetryPolicy,
  RouteGroup,
  UsageGroupBy,
  WireProtocol,
} from "@harnesshub/core/model-plane";

/** Record types of the API, re-exported so clients need no other package. */
export type {
  GatewayKeyQuota,
  GatewayKeyScope,
  GatewayKeyView,
  ProviderConfig,
  ProviderCredential,
  ProviderKind,
  ProviderModel,
  RouteGroup,
  RouteStrategy,
  Stickiness,
  UsageGroupBy,
  WireProtocol,
} from "@harnesshub/core/model-plane";
export type { SecretReference } from "@harnesshub/core/engine-configuration";
export type { ProviderPreset } from "@harnesshub/core/provider-presets";
export type {
  CatalogMeta,
  MetadataField,
  MetadataSource,
  Modality,
  ModelOverride,
  OverrideValues,
  ResolvedField,
} from "@harnesshub/core/model-metadata";

/** One `errors[]` entry of a problem: a body member or a query parameter. */
export interface ProblemItem {
  pointer?: string;
  parameter?: string;
  detail: string;
}

/** RFC 9457 problem details as `/api/v1` sends them. */
export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  code: string;
  requestId: string;
  errors?: ProblemItem[];
  references?: Array<{ type: string; id: string }>;
}

/** The daemon answered with an error; `code` is stable within v1, unknown codes included. */
export class HarnessHubError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | undefined;
  readonly problem: Problem;

  constructor(problem: Problem) {
    super(problem.detail ?? problem.title);
    this.name = "HarnessHubError";
    this.status = problem.status;
    this.code = problem.code;
    this.requestId = problem.requestId;
    this.problem = problem;
  }
}

/** The daemon could not be reached (connection refused, reset or timed out). */
export class HarnessHubUnavailableError extends Error {
  constructor(url: string, cause: unknown) {
    super(`The HarnessHub daemon at ${url} is not reachable`, { cause });
    this.name = "HarnessHubUnavailableError";
  }
}

export interface ClientOptions {
  /**
   * Daemon origin, e.g. `http://127.0.0.1:3180`, or a proxy base whose path
   * ends with `/`, e.g. `http://127.0.0.1:3330/api/gateway/`: requests go to
   * `<base>api/v1/...`.
   */
  url: string | URL;
  /**
   * The local admin token (`<dataDir>/admin.token`). Omit it only behind a
   * proxy that adds the token itself, as the console's does.
   */
  token?: string;
  /** Replaces the global `fetch`, e.g. in tests. */
  fetch?: typeof fetch;
}

/** `POST /providers`; credentials are added with `credentials.add`. */
/** Provider fields a client may set; the daemon fills the rest. */
export interface ProviderFields {
  name?: string;
  kind?: ProviderConfig["kind"];
  endpoints?: ProviderConfig["endpoints"];
  auth?: ProviderConfig["auth"];
  headers?: Record<string, string>;
  models?: ProviderConfig["models"];
  wire?: Record<string, string>;
  patches?: ProviderConfig["patches"];
  capabilities?: ProviderConfig["capabilities"];
  translateOnly?: boolean;
}

/** A value to store, or an `env` or `file` reference. */
export type CredentialSource =
  | { value: string; ref?: never }
  | { ref: SecretReference & { kind: "env" | "file" }; value?: never };

/** `POST /providers/{id}/credentials`. */
export type CredentialInput = {
  id?: string;
  name: string;
  protocols?: WireProtocol[];
  enabled?: boolean;
} & CredentialSource;

/**
 * `POST /providers`: from a preset (`id` defaults to the preset's; other
 * fields override it, endpoints by protocol) or from scratch (`id` and
 * `endpoints`). `credential` adds the first credential (name `default`).
 */
export type ProviderInput = ProviderFields & {
  credential?: Omit<CredentialInput, "name"> & { name?: string };
} & (
    | { preset: string; id?: string }
    | {
        preset?: never;
        id: string;
        endpoints: ProviderConfig["endpoints"];
      }
  );

/** JSON Merge Patch of a provider: `null` removes an optional member. */
export type ProviderPatch = {
  [K in keyof ProviderFields]?: ProviderFields[K] | null;
} & {
  /** null detaches the provider from its preset. */
  preset?: null;
};

export interface RouteGroupInput {
  id: string;
  members: string[];
  strategy?: RouteGroup["strategy"];
  stickiness?: RouteGroup["stickiness"];
  retry?: Partial<RetryPolicy>;
}

export interface RouteGroupPatch {
  members?: string[];
  strategy?: RouteGroup["strategy"];
  stickiness?: RouteGroup["stickiness"];
  retry?: Partial<RetryPolicy> | null;
}

export interface GatewayKeyInput {
  name: string;
  /** Model Refs, `provider/*` and `group/<id>`; at least one. */
  modelAllow: string[];
  quota?: GatewayKeyQuota;
  /** Absent: 90 days from now; null: never expires. */
  expiresAt?: string | null;
}

/** `POST /gateway-keys`: `key` is the key text, returned only by this call. */
export interface CreatedGatewayKey {
  key: string;
  gatewayKey: GatewayKeyView;
}

/** A USD amount as a decimal string. */
export interface Money {
  amount: string;
  currency: "USD";
}

/** A ledger entry as the API returns it: the cost as a decimal string. */
export type ApiModelCall = Omit<ModelCallEntry, "cost"> & {
  cost: (Money & { priceSource: string }) | null;
};

export interface CallFilter {
  /** Inclusive RFC 3339 time. */
  from?: string;
  /** Exclusive RFC 3339 time. */
  to?: string;
  keyId?: string;
  provider?: string;
  /** A Model Ref. */
  model?: string;
  sessionId?: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface UsageBucketView {
  /** Empty for calls without the grouped attribute. */
  key: string;
  calls: number;
  failedCalls: number;
  usage: {
    input: number;
    cacheRead: number;
    cacheWrite: number;
    output: number;
    reasoning: number;
  };
  /** Sum of known costs; `unpricedCalls` had none. */
  cost: Money;
  unpricedCalls: number;
}

export interface UsageReport {
  groupBy: UsageGroupBy;
  items: UsageBucketView[];
}

export interface SystemInfo {
  apiVersion: "v1";
  version: string;
  commit: string;
  pid: number;
  startedAt: string;
  dataDir: string;
  secretBackend: "keychain" | "dpapi" | "file";
  /** The model gateway's base URLs for local clients; null before the daemon listens. */
  gateway: {
    openaiBaseUrl: string;
    anthropicBaseUrl: string;
    geminiBaseUrl: string;
  } | null;
}

/**
 * One model's metadata (03-model-plane section 7): each known field with its
 * value, source and time; fields no source knows are listed in `unknown` and
 * never defaulted.
 */
export interface ModelMetadataView {
  /** `provider/model`. */
  ref: string;
  /** Whether the provider's model list has this model. */
  listed: boolean;
  fields: Partial<Record<MetadataField, ResolvedField>>;
  unknown: MetadataField[];
  /** The stored `provider/*` override and this model's, if any. */
  overrides: ModelOverride[];
}

/** The bundled models.dev snapshot; it is never refreshed in the background. */
export interface CatalogStatus {
  snapshot: CatalogMeta;
  autoRefresh: boolean;
}

type Query = Record<string, string | number | undefined>;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProblem(value: unknown): value is Problem {
  return (
    object(value) &&
    typeof value.status === "number" &&
    typeof value.code === "string" &&
    typeof value.title === "string"
  );
}

const segment = (value: string) => encodeURIComponent(value);

/**
 * Client of one daemon. Every method sends one request and resolves to the
 * decoded response; it rejects with `HarnessHubError` for an error response
 * and `HarnessHubUnavailableError` when the daemon cannot be reached. It never
 * retries: none of these operations carries an idempotency key yet.
 */
export class HarnessHubClient {
  private readonly base: URL;
  private readonly token: string | undefined;
  private readonly send: typeof fetch;

  constructor(options: ClientOptions) {
    const base = new URL(options.url);
    if (
      !["http:", "https:"].includes(base.protocol) ||
      base.username ||
      base.password
    )
      throw new TypeError(
        "The daemon URL must be HTTP(S) without embedded credentials",
      );
    if (!base.pathname.endsWith("/")) base.pathname += "/";
    base.search = "";
    base.hash = "";
    this.base = new URL("api/v1/", base);
    this.token = options.token;
    // Called unbound: browsers reject a `fetch` invoked with another `this`.
    this.send =
      options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  /**
   * One request. The response body is decoded as JSON and trusted to match
   * the documented shape of the operation, which the daemon serializes from
   * the same schemas that its OpenAPI document publishes.
   */
  private async request<T>(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    options: { body?: unknown; query?: Query; contentType?: string } = {},
  ): Promise<T> {
    const url = new URL(path, this.base);
    for (const [name, value] of Object.entries(options.query ?? {}))
      if (value !== undefined) url.searchParams.set(name, String(value));
    let response: Response;
    try {
      response = await this.send(url, {
        method,
        headers: {
          accept: "application/json",
          ...(this.token !== undefined
            ? { authorization: `Bearer ${this.token}` }
            : {}),
          ...(options.body !== undefined
            ? { "content-type": options.contentType ?? "application/json" }
            : {}),
        },
        ...(options.body !== undefined
          ? { body: JSON.stringify(options.body) }
          : {}),
      });
    } catch (error) {
      throw new HarnessHubUnavailableError(this.base.origin, error);
    }
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    let body: unknown;
    try {
      body = text ? (JSON.parse(text) as unknown) : undefined;
    } catch {
      body = undefined;
    }
    if (!response.ok)
      throw new HarnessHubError(
        isProblem(body)
          ? body
          : {
              type: "about:blank",
              title: response.statusText || "Error",
              status: response.status,
              code: "UNEXPECTED_RESPONSE",
              requestId: "",
            },
      );
    if (body === undefined)
      throw new HarnessHubError({
        type: "about:blank",
        title: "Invalid response",
        status: response.status,
        code: "UNEXPECTED_RESPONSE",
        requestId: "",
        detail: "The daemon answered without a JSON body",
      });
    return body as T;
  }

  readonly system = {
    info: () => this.request<SystemInfo>("GET", "system/info"),
  };

  readonly providers = {
    list: () => this.request<Page<ProviderConfig>>("GET", "providers"),
    get: (id: string) =>
      this.request<ProviderConfig>("GET", `providers/${segment(id)}`),
    create: (input: ProviderInput) =>
      this.request<ProviderConfig>("POST", "providers", { body: input }),
    update: (id: string, patch: ProviderPatch) =>
      this.request<ProviderConfig>("PATCH", `providers/${segment(id)}`, {
        body: patch,
        contentType: "application/merge-patch+json",
      }),
    remove: (id: string) =>
      this.request<void>("DELETE", `providers/${segment(id)}`),
    /**
     * List the provider's models from its upstream with its first enabled
     * credential and store them. On failure the daemon keeps the previous
     * list, marks it stale and rejects (`MODELS_REFRESH_FAILED`, 502, or
     * `CREDENTIAL_UNAVAILABLE`, 409).
     */
    refreshModels: (id: string) =>
      this.request<ProviderConfig>(
        "POST",
        `providers/${segment(id)}/models/refresh`,
        { body: {} },
      ),
    /** The metadata of every listed model, with sources. */
    models: (id: string) =>
      this.request<Page<ModelMetadataView>>(
        "GET",
        `providers/${segment(id)}/models`,
      ),
  };

  /** Model metadata and user overrides, by Model Ref (`provider/model`, or `provider/*` for overrides). */
  readonly models = {
    get: (ref: string) =>
      this.request<ModelMetadataView>("GET", `models/${segment(ref)}`),
    /** The stored override of `ref`; `MODEL_OVERRIDE_NOT_FOUND` (404) when there is none. */
    getOverride: (ref: string) =>
      this.request<ModelOverride>("GET", `models/${segment(ref)}/overrides`),
    /**
     * Replace the override of `ref` as a whole; the daemon resolves the
     * provider's models again, so the gateway uses the new values (prices
     * for costs) from the next call.
     */
    setOverride: (ref: string, values: OverrideValues) =>
      this.request<ModelOverride>("PUT", `models/${segment(ref)}/overrides`, {
        body: values,
      }),
    /** Remove the override; its values fall back to the next source. */
    removeOverride: (ref: string) =>
      this.request<void>("DELETE", `models/${segment(ref)}/overrides`),
  };

  readonly catalog = {
    status: () => this.request<CatalogStatus>("GET", "catalog"),
  };

  readonly presets = {
    list: () => this.request<Page<ProviderPreset>>("GET", "presets"),
  };

  readonly credentials = {
    list: (providerId: string) =>
      this.request<Page<ProviderCredential>>(
        "GET",
        `providers/${segment(providerId)}/credentials`,
      ),
    /** Stores `input.value` in the daemon's secret store; the result holds only the reference. */
    add: (providerId: string, input: CredentialInput) =>
      this.request<ProviderCredential>(
        "POST",
        `providers/${segment(providerId)}/credentials`,
        { body: input },
      ),
    /** Replaces the stored value; the reference stays the same. */
    rotate: (providerId: string, credentialId: string, value: string) =>
      this.request<ProviderCredential>(
        "PUT",
        `providers/${segment(providerId)}/credentials/${segment(credentialId)}/secret`,
        { body: { value } },
      ),
    remove: (providerId: string, credentialId: string) =>
      this.request<void>(
        "DELETE",
        `providers/${segment(providerId)}/credentials/${segment(credentialId)}`,
      ),
  };

  readonly routeGroups = {
    list: () => this.request<Page<RouteGroup>>("GET", "route-groups"),
    get: (id: string) =>
      this.request<RouteGroup>("GET", `route-groups/${segment(id)}`),
    create: (input: RouteGroupInput) =>
      this.request<RouteGroup>("POST", "route-groups", { body: input }),
    update: (id: string, patch: RouteGroupPatch) =>
      this.request<RouteGroup>("PATCH", `route-groups/${segment(id)}`, {
        body: patch,
        contentType: "application/merge-patch+json",
      }),
    remove: (id: string) =>
      this.request<void>("DELETE", `route-groups/${segment(id)}`),
  };

  readonly gatewayKeys = {
    list: () => this.request<Page<GatewayKeyView>>("GET", "gateway-keys"),
    get: (keyId: string) =>
      this.request<GatewayKeyView>("GET", `gateway-keys/${segment(keyId)}`),
    /** Creates a `client:` key; the key text is in this response only. */
    create: (input: GatewayKeyInput) =>
      this.request<CreatedGatewayKey>("POST", "gateway-keys", { body: input }),
    revoke: (keyId: string) =>
      this.request<GatewayKeyView>(
        "POST",
        `gateway-keys/${segment(keyId)}/revoke`,
        { body: {} },
      ),
  };

  readonly modelCalls = {
    /** Newest first; pass `nextCursor` back to continue. `limit` is 1 to 200 (default 50). */
    list: (query: CallFilter & { limit?: number; cursor?: string } = {}) =>
      this.request<Page<ApiModelCall>>("GET", "model-calls", {
        query: { ...query },
      }),
  };

  readonly usage = {
    aggregate: (query: CallFilter & { groupBy?: UsageGroupBy } = {}) =>
      this.request<UsageReport>("GET", "usage", { query: { ...query } }),
  };
}
