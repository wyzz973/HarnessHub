import { z } from "zod";
import {
  candidateSchema,
  engineSchema,
  errorSchema,
  eventSchema,
  observationSchema,
  overviewSchema,
  type registrationSchema,
  runSchema,
  selectionSchema,
  sessionSchema,
  workflowSchema,
  workspaceSchema,
} from "./contracts";

const base = "/api/gateway";
/** Every response enters as unknown and is checked before becoming UI state. */
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
  const data: unknown = await response.json();
  if (!response.ok) {
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
    request("/v1/sessions", z.object({ sessions: z.array(sessionSchema) }), {
      signal,
    }),
  runs: (signal?: AbortSignal) =>
    request("/v1/runs?limit=100", z.object({ runs: z.array(runSchema) }), {
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
  discovery: () =>
    request(
      "/v1/engines/discover",
      z.object({ candidates: z.array(candidateSchema) }),
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
};
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
