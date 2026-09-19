import {
  adapterIds,
  configurationTestSchema,
  secretReferenceSchema,
} from "./engine-configuration";
import { z } from "zod";
import {
  candidateSchema,
  engineSchema,
  errorSchema,
  eventSchema,
  harnessModelTestSchema,
  harnessModelViewSchema,
  observationSchema,
  overviewSchema,
  type registrationSchema,
  runSchema,
  runtimeInfoSchema,
  selectionSchema,
  sessionSchema,
  toolPackApplySchema,
  toolPackImportSchema,
  toolPackRecordSchema,
  workflowSchema,
  workspaceSchema,
} from "./contracts";
import type { SecretReference } from "./engine-configuration";

const base = "/api/gateway";
/** The connected Gateway has no route for this path, e.g. an older build without ADR 0013 APIs. */
export class UnsupportedFeatureError extends Error {
  constructor(readonly path: string) {
    super("当前 Gateway 不支持此功能，请升级到包含该接口的版本。");
    this.name = "UnsupportedFeatureError";
  }
}
/** Fastify's own not-found reply; business 404s carry `{ error: { code, message } }` instead. */
function missingRoute(status: number, data: unknown) {
  return (
    status === 404 &&
    typeof data === "object" &&
    data !== null &&
    "error" in data &&
    data.error === "Not Found" &&
    "message" in data &&
    typeof data.message === "string" &&
    data.message.startsWith("Route ")
  );
}
/**
 * Every response enters as unknown and is checked before becoming UI state.
 * Throws {@link UnsupportedFeatureError} for routes the Gateway does not register,
 * and an `Error` carrying the Gateway message for every other failure.
 */
export async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    ...init,
    cache: "no-store",
    headers: {
      ...(init?.body !== undefined
        ? { "Content-Type": "application/json" }
        : {}),
      ...init?.headers,
    },
  });
  const body = await response.text();
  let data: unknown = undefined;
  if (body) {
    try {
      data = JSON.parse(body) as unknown;
    } catch {
      throw new Error(
        response.ok
          ? `服务返回了无法解析的数据：${path}`
          : `请求失败（${response.status}）`,
      );
    }
  }
  if (!response.ok) {
    if (missingRoute(response.status, data))
      throw new UnsupportedFeatureError(path);
    const parsed = errorSchema.safeParse(data);
    const nested = z.object({ error: errorSchema }).safeParse(data);
    throw new Error(
      parsed.success
        ? parsed.data.message
        : nested.success
          ? nested.data.error.message
          : `请求失败（${response.status}）`,
    );
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new Error(`服务返回的数据格式不符合约定：${path}`);
  return parsed.data;
}
/** Loadable Gateway data with an explicit "this Gateway lacks the API" state. */
export type Remote<T> =
  | { state: "loading" }
  | { state: "ready"; value: T }
  | { state: "unsupported" }
  | { state: "error"; message: string };
export function remoteOf<T>(result: PromiseSettledResult<T>): Remote<T> {
  if (result.status === "fulfilled")
    return { state: "ready", value: result.value };
  if (result.reason instanceof UnsupportedFeatureError)
    return { state: "unsupported" };
  return {
    state: "error",
    message:
      result.reason instanceof Error ? result.reason.message : "读取失败",
  };
}
export type GatewayHealth = "checking" | "ready" | "not-ready" | "offline";
/**
 * Probe `/health/ready` through the same-origin proxy with a 4 s budget.
 * `offline` covers an unreachable Gateway and a proxy that cannot connect;
 * rejects only when the caller's signal aborts.
 */
export async function probeHealth(
  signal: AbortSignal,
): Promise<Exclude<GatewayHealth, "checking">> {
  // Combined manually: offline judge machines may run browsers without AbortSignal.any.
  const probe = new AbortController();
  const abort = () => probe.abort();
  const timer = setTimeout(abort, 4000);
  signal.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetch(`${base}/health/ready`, {
      cache: "no-store",
      signal: probe.signal,
    });
    const data: unknown = await response.json().catch(() => undefined);
    const ready =
      typeof data === "object" && data !== null && "ready" in data
        ? data.ready
        : undefined;
    if (response.ok && ready === true) return "ready";
    if (response.status === 503 && ready === false) return "not-ready";
    return "offline";
  } catch (error) {
    if (signal.aborted) throw error;
    return "offline";
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}
const post = (value?: unknown): RequestInit => ({
  method: "POST",
  ...(value === undefined ? {} : { body: JSON.stringify(value) }),
});
const accepted = z.unknown();
export const api = {
  engines: (signal?: AbortSignal) =>
    request("/v1/engines", z.object({ engines: z.array(engineSchema) }), {
      signal,
    }),
  workspaces: (signal?: AbortSignal) =>
    request(
      "/v1/workspaces",
      z.object({
        workspaces: z.array(workspaceSchema),
        defaultEngine: z.string(),
        defaultWorkspace: z.string(),
      }),
      { signal },
    ),
  sessions: (signal?: AbortSignal) =>
    request(
      "/v1/sessions?limit=200",
      z.object({ sessions: z.array(sessionSchema) }),
      { signal },
    ),
  session: (id: string, signal?: AbortSignal) =>
    request(`/v1/sessions/${encodeURIComponent(id)}`, sessionSchema, {
      signal,
    }),
  runs: (signal?: AbortSignal) =>
    request("/v1/runs?limit=200", z.object({ runs: z.array(runSchema) }), {
      signal,
    }),
  sessionRuns: (id: string, signal?: AbortSignal) =>
    request(
      `/v1/sessions/${encodeURIComponent(id)}/runs`,
      z.object({ runs: z.array(runSchema) }),
      { signal },
    ),
  run: (id: string, signal?: AbortSignal) =>
    request(`/v1/runs/${encodeURIComponent(id)}`, runSchema, { signal }),
  events: (id: string, afterSeq = 0, signal?: AbortSignal) =>
    request(
      `/v1/runs/${encodeURIComponent(id)}/event-log?afterSeq=${afterSeq}&limit=1000`,
      z.object({ events: z.array(eventSchema) }),
      { signal },
    ),
  createSession: (engineId: string, workspaceId?: string) =>
    request("/v1/sessions", sessionSchema, post({ engineId, workspaceId })),
  autoSession: (workspaceId?: string) =>
    request(
      "/v1/sessions/auto",
      z.object({ session: sessionSchema, selection: selectionSchema }),
      post({ workspaceId }),
    ),
  submit: (
    id: string,
    text: string,
    key: string,
    outputs: { path: string; name: string }[] = [],
  ) =>
    request(`/v1/sessions/${encodeURIComponent(id)}/runs`, runSchema, {
      ...post({ text, ...(outputs.length ? { outputs } : {}) }),
      headers: { "Idempotency-Key": key },
    }),
  cancel: (id: string) =>
    request(`/v1/runs/${encodeURIComponent(id)}/cancel`, accepted, post()),
  decide: (id: string, optionId: string) =>
    request(
      `/v1/permissions/${encodeURIComponent(id)}/decision`,
      accepted,
      post({ optionId }),
    ),
  workflows: (signal?: AbortSignal) =>
    request("/v1/workflows", z.object({ workflows: z.array(workflowSchema) }), {
      signal,
    }),
  workflow: (id: string, signal?: AbortSignal) =>
    request(`/v1/workflows/${encodeURIComponent(id)}`, workflowSchema, {
      signal,
    }),
  createWorkflow: (
    goal: string,
    engineId: string,
    workspaceId: string | undefined,
    key: string,
  ) =>
    request("/v1/workflows", workflowSchema, {
      ...post({ goal, engineId, workspaceId }),
      headers: { "Idempotency-Key": key },
    }),
  approve: (id: string) =>
    request(
      `/v1/workflows/${encodeURIComponent(id)}/approve`,
      workflowSchema,
      post(),
    ),
  cancelWorkflow: (id: string) =>
    request(
      `/v1/workflows/${encodeURIComponent(id)}/cancel`,
      workflowSchema,
      post(),
    ),
  discovery: (signal?: AbortSignal) =>
    request(
      "/v1/engines/discover",
      z.object({ candidates: z.array(candidateSchema) }),
      { signal },
    ),
  configurationAdapters: (signal?: AbortSignal) =>
    request(
      "/v1/engine-configuration/adapters",
      z.object({
        adapters: z.array(
          z.object({
            id: z.enum(adapterIds),
            providerProtocols: z.array(z.string()),
            description: z.string(),
          }),
        ),
      }),
      { signal },
    ),
  configurationTemplates: (signal?: AbortSignal) =>
    request(
      "/v1/engine-configuration/templates",
      z.object({ candidates: z.array(candidateSchema) }),
      { signal },
    ),
  inspectConfiguration: (registration: z.infer<typeof registrationSchema>) =>
    request(
      "/v1/engine-configuration/inspect",
      z.object({ configuration: z.unknown().optional() }),
      post(registration),
    ),
  testEngineConfiguration: (id: string) =>
    request(
      `/v1/engines/${encodeURIComponent(id)}/test`,
      configurationTestSchema,
      post({}),
    ),
  createSecret: (value: string) =>
    request(
      "/v1/secrets",
      z.object({ reference: secretReferenceSchema }),
      post({ value }),
    ),
  register: (registration: z.infer<typeof registrationSchema>) =>
    request("/v1/engines", accepted, post(registration)),
  replace: (registration: z.infer<typeof registrationSchema>) =>
    request(`/v1/engines/${encodeURIComponent(registration.id)}`, accepted, {
      method: "PUT",
      body: JSON.stringify(registration),
    }),
  setDefault: (engineId: string) =>
    request("/v1/engines/default", accepted, {
      method: "PUT",
      body: JSON.stringify({ engineId }),
    }),
  reload: () => request("/v1/engines/reload", accepted, post()),
  overview: (signal?: AbortSignal) =>
    request("/v1/observability?limit=100", overviewSchema, { signal }),
  observation: (id: string, signal?: AbortSignal) =>
    request(
      `/v1/runs/${encodeURIComponent(id)}/observations`,
      observationSchema,
      { signal },
    ),
  artifactUrl: (id: string) => `${base}/v1/artifacts/${encodeURIComponent(id)}`,
  rolloutUrl: (id: string) =>
    `${base}/v1/runs/${encodeURIComponent(id)}/rollout`,
  runtimeInfo: (signal?: AbortSignal) =>
    request("/v1/runtime/info", runtimeInfoSchema, { signal }),
  harnessModel: (signal?: AbortSignal) =>
    request("/v1/harness/model", harnessModelViewSchema, { signal }),
  saveHarnessModel: (model: HarnessModelInput) =>
    request("/v1/harness/model", harnessModelViewSchema, {
      method: "PUT",
      body: JSON.stringify(model),
    }),
  /** Sends one short streaming request with the saved configuration; this calls the real model. */
  testHarnessModel: () =>
    request("/v1/harness/model/test", harnessModelTestSchema, post()),
  toolPacks: (signal?: AbortSignal) =>
    request(
      "/v1/tool-packs",
      z.object({ packages: z.array(toolPackRecordSchema) }),
      { signal },
    ),
  applyToolPack: (input: {
    package: { id: string; version: string };
    engineIds: "all" | string[];
  }) => request("/v1/tool-packs/apply", toolPackApplySchema, post(input)),
  importToolPack: (input: {
    source: string;
    kind: "auto" | "skills" | "mcp" | "cli";
    id?: string;
    version?: string;
    applyTo?: "all";
  }) => request("/v1/tool-packs/import", toolPackImportSchema, post(input)),
  unbindToolPack: (id: string, version: string, engineIds: "all" | string[]) =>
    request(
      `/v1/tool-packs/${encodeURIComponent(id)}/${encodeURIComponent(version)}/bindings`,
      toolPackApplySchema.optional(),
      { method: "DELETE", body: JSON.stringify({ engineIds }) },
    ),
};
/** `PUT /v1/harness/model` body; the API key is accepted only as a secret reference. */
export interface HarnessModelInput {
  model: string;
  alias?: string;
  provider: {
    protocol: "openai-completions";
    baseUrl: string;
    apiKey?: SecretReference;
    headers?: Record<string, string>;
    secretHeaders?: Record<string, SecretReference>;
    contextWindow?: number;
    maxOutputTokens?: number;
    compatibility: {
      includeUsage: boolean;
      reasoning: "passthrough" | "strip";
      maxTokensField: "max_tokens" | "max_completion_tokens";
      dropParameters?: string[];
    };
  };
}
/** Read named SSE events from the committed stream. Reconnect uses the caller's persisted sequence. */
export async function readEvents(
  id: string,
  afterSeq: number,
  receive: (event: z.infer<typeof eventSchema>) => void,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch(
    `${base}/v1/runs/${encodeURIComponent(id)}/events?afterSeq=${afterSeq}`,
    { signal, headers: { Accept: "text/event-stream" }, cache: "no-store" },
  );
  if (!response.ok || !response.body)
    throw new Error(`事件流暂不可用（${response.status}）`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) return;
      buffered += decoder
        .decode(result.value, { stream: true })
        .replace(/\r\n/g, "\n");
      let boundary: number;
      while ((boundary = buffered.indexOf("\n\n")) >= 0) {
        const frame = buffered.slice(0, boundary);
        buffered = buffered.slice(boundary + 2);
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data) {
          const decoded: unknown = JSON.parse(data);
          receive(eventSchema.parse(decoded));
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
