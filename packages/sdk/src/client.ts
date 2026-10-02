// SPDX-License-Identifier: MIT
/**
 * Typed client of the daemon's `/api/v1` model-plane API (06-interfaces
 * section 4). It runs anywhere `fetch` exists; local token discovery is in
 * `@harnesshub/sdk/local`, which needs Node.
 */
import type { SecretReference } from "@harnesshub/core/engine-configuration";
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
  /** Daemon origin, e.g. `http://127.0.0.1:3180`. */
  url: string | URL;
  /** The local admin token (`<dataDir>/admin.token`). */
  token: string;
  /** Replaces the global `fetch`, e.g. in tests. */
  fetch?: typeof fetch;
}

/** `POST /providers`; credentials are added with `credentials.add`. */
export interface ProviderInput {
  id: string;
  name?: string;
  kind?: ProviderConfig["kind"];
  preset?: string;
  endpoints: ProviderConfig["endpoints"];
  auth?: ProviderConfig["auth"];
  headers?: Record<string, string>;
  models?: ProviderConfig["models"];
  wire?: Record<string, string>;
  patches?: ProviderConfig["patches"];
  capabilities?: ProviderConfig["capabilities"];
  translateOnly?: boolean;
}

/** JSON Merge Patch of a provider: `null` removes an optional member. */
export type ProviderPatch = {
  [K in Exclude<keyof ProviderInput, "id">]?: ProviderInput[K] | null;
};

/** `POST /providers/{id}/credentials`: either a value to store or a reference. */
export type CredentialInput = {
  id?: string;
  name: string;
  protocols?: WireProtocol[];
  enabled?: boolean;
} & (
  | { value: string; ref?: never }
  | { ref: SecretReference & { kind: "env" | "file" }; value?: never }
);

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
  private readonly token: string;
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
    this.base = new URL("/api/v1/", base);
    this.token = options.token;
    this.send = options.fetch ?? fetch;
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
          authorization: `Bearer ${this.token}`,
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
