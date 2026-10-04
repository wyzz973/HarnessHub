// SPDX-License-Identifier: MIT
/**
 * Test support for the shared gateway: an in-memory ModelPlaneStore, scripted
 * loopback upstreams and a raw HTTP client. Nothing here reaches the network.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type test from "node:test";
import type { SecretReference } from "@harnesshub/core/engine-configuration";
import {
  issueGatewayKey,
  type CredentialId,
  type GatewayKeyId,
  type GatewayKeyRecord,
  type GatewayKeyScope,
  type ModelCallEntry,
  type ModelPlaneStore,
  type ProviderConfig,
  type ProviderId,
  type RouteGroup,
  type RouteGroupId,
  type CallUsage,
  type UsageBucket,
  type UsageFilter,
  type WireProtocol,
  type WiringRecord,
} from "@harnesshub/core/model-plane";
import { resolveHandlerLimits } from "../src/limits.js";
import {
  createGatewayHandler,
  type GatewayHandler,
  type GatewayHandlerDeps,
} from "../src/server.js";

/** ModelPlaneStore in memory; `appendGate` delays and `failAppend` rejects ledger writes. */
export class MemoryStore implements ModelPlaneStore {
  providers = new Map<string, ProviderConfig>();
  groups = new Map<string, RouteGroup>();
  keys = new Map<string, GatewayKeyRecord>();
  entries: ModelCallEntry[] = [];
  touches: string[] = [];
  failAppend = false;
  aggregations = 0;
  appendGate: Promise<void> | undefined;
  appendStarted = 0;
  async listProviders() {
    return [...this.providers.values()];
  }
  async getProvider(id: ProviderId) {
    return this.providers.get(id);
  }
  async putProvider(provider: ProviderConfig) {
    this.providers.set(provider.id, provider);
  }
  async deleteProvider(id: ProviderId) {
    return this.providers.delete(id);
  }
  async listRouteGroups() {
    return [...this.groups.values()];
  }
  async getRouteGroup(id: RouteGroupId) {
    return this.groups.get(id);
  }
  async putRouteGroup(group: RouteGroup) {
    this.groups.set(group.id, group);
  }
  async deleteRouteGroup(id: RouteGroupId) {
    return this.groups.delete(id);
  }
  async createGatewayKey(record: GatewayKeyRecord) {
    this.keys.set(record.keyId, record);
  }
  async getGatewayKey(keyId: GatewayKeyId) {
    return this.keys.get(keyId);
  }
  async listGatewayKeys() {
    return [...this.keys.values()];
  }
  async revokeGatewayKey(keyId: GatewayKeyId, at: string) {
    const key = this.keys.get(keyId);
    if (!key) return false;
    key.revokedAt = at;
    return true;
  }
  async touchGatewayKey(keyId: GatewayKeyId) {
    this.touches.push(keyId);
  }
  async appendModelCall(entry: ModelCallEntry) {
    this.appendStarted++;
    if (this.appendGate) await this.appendGate;
    if (this.failAppend) throw new Error("disk full");
    this.entries.push(structuredClone(entry));
  }
  async listModelCalls() {
    return { items: this.entries };
  }
  /** Ledger totals of the matching entries in one bucket; `groupBy` is ignored. */
  async aggregateUsage(filter: UsageFilter): Promise<UsageBucket[]> {
    this.aggregations++;
    const rows = this.entries.filter(
      (entry) =>
        (filter.keyId === undefined || entry.keyId === filter.keyId) &&
        (filter.from === undefined ||
          Date.parse(entry.occurredAt) >= Date.parse(filter.from)) &&
        (filter.to === undefined ||
          Date.parse(entry.occurredAt) < Date.parse(filter.to)),
    );
    if (!rows.length) return [];
    const sum = (pick: (usage: CallUsage) => number) =>
      rows.reduce(
        (total, entry) => total + (entry.usage ? pick(entry.usage) : 0),
        0,
      );
    return [
      {
        key: filter.keyId ?? "",
        calls: rows.length,
        failedCalls: rows.filter((entry) => entry.status >= 400).length,
        usage: {
          input: sum((usage) => usage.input),
          cacheRead: sum((usage) => usage.cacheRead),
          cacheWrite: sum((usage) => usage.cacheWrite),
          output: sum((usage) => usage.output),
          reasoning: sum((usage) => usage.reasoning),
        },
        costUsd: rows.reduce(
          (total, entry) => total + (entry.cost?.amountUsd ?? 0),
          0,
        ),
        unpricedCalls: rows.filter((entry) => entry.cost === null).length,
      },
    ];
  }
  /** Not used by the gateway; conversations are summed by the SQLite store. */
  async listConversations() {
    return { items: [] };
  }
  hidden = new Set<string>();
  async listHiddenAutoGroups() {
    return [...this.hidden].sort() as RouteGroupId[];
  }
  async setAutoGroupHidden(id: RouteGroupId, hidden: boolean) {
    if (this.hidden.has(id) === hidden) return false;
    if (hidden) this.hidden.add(id);
    else this.hidden.delete(id);
    return true;
  }
  async listWirings(): Promise<WiringRecord[]> {
    return [];
  }
  async putWiring() {}
  async deleteWiring() {
    return false;
  }
}

/** Secrets by reference value; anything else fails to resolve. */
export const SECRETS: Record<string, string> = {
  "key-a": "sk-upstream-a-0001",
  "key-b": "sk-upstream-b-0002",
  "key-c": "sk-upstream-c-0003",
};
export async function resolveSecret(ref: SecretReference): Promise<string> {
  const value = SECRETS[ref.value];
  if (value === undefined) throw new Error(`no secret ${ref.value}`);
  return value;
}

const STAMP = "2026-10-02T00:00:00.000Z";

export function provider(
  id: string,
  endpoints: Partial<Record<WireProtocol, string>>,
  options: Partial<ProviderConfig> & { secrets?: string[] } = {},
): ProviderConfig {
  const { secrets = ["key-a"], ...rest } = options;
  return {
    schemaVersion: 1,
    id: id as ProviderId,
    name: id,
    kind: "custom",
    endpoints,
    auth: { apiKeyHeader: "authorization-bearer" },
    credentials: secrets.map((value, index) => ({
      id: `cred-${index}` as CredentialId,
      name: `credential ${index}`,
      ref: { kind: "env", value },
      enabled: true,
    })),
    models: {
      source: "manual",
      list: [
        {
          id: "model-a",
          contextWindow: 128_000,
          maxOutputTokens: 8_192,
          reasoning: true,
          inputModalities: ["text"],
          price: { input: 1, output: 2, cacheRead: 0.5 },
        },
        { id: "model-b" },
      ],
      expose: "all",
    },
    createdAt: STAMP,
    updatedAt: STAMP,
    ...rest,
  };
}

export function group(
  id: string,
  members: string[],
  options: Partial<RouteGroup> = {},
): RouteGroup {
  return {
    id: id as RouteGroupId,
    strategy: "order",
    stickiness: "off",
    members: members as RouteGroup["members"],
    createdAt: STAMP,
    updatedAt: STAMP,
    ...options,
  };
}

export async function addKey(
  store: MemoryStore,
  modelAllow: string[],
  options: Partial<GatewayKeyRecord> & { scope?: GatewayKeyScope } = {},
): Promise<{ text: string; keyId: GatewayKeyId }> {
  const scope = options.scope ?? { kind: "client", name: "test" };
  const issued = issueGatewayKey(scope);
  await store.createGatewayKey({
    keyId: issued.keyId,
    name: "test",
    scope,
    modelAllow,
    secretHash: issued.secretHash,
    createdAt: STAMP,
    ...options,
  });
  return { text: issued.text, keyId: issued.keyId };
}

/** One request the fake upstream received. */
export interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
  json(): Record<string, unknown>;
}
export type Reply = (
  response: ServerResponse,
  seen: Seen,
  request: IncomingMessage,
) => void | Promise<void>;

/**
 * A scripted upstream on 127.0.0.1. Each request takes the next reply; the
 * last one repeats. `base` has no path.
 */
export async function upstream(
  t: test.TestContext,
  ...replies: Reply[]
): Promise<{ base: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const entry: Seen = {
        method: request.method ?? "",
        url: request.url ?? "",
        headers: request.headers,
        body,
        json: () =>
          JSON.parse(body.toString("utf8")) as Record<string, unknown>,
      };
      seen.push(entry);
      const reply = replies[Math.min(seen.length - 1, replies.length - 1)]!;
      await reply(response, entry, request);
    })().catch(() => response.destroy());
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { base: `http://127.0.0.1:${address.port}`, seen };
}

export function json(status: number, body: unknown, headers = {}): Reply {
  return (response) => {
    response.writeHead(status, {
      "content-type": "application/json",
      ...headers,
    });
    response.end(typeof body === "string" ? body : JSON.stringify(body));
  };
}
export function events(text: string): Reply {
  return (response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(text);
  };
}
export function chatChunks(chunks: unknown[], done = true): string {
  return (
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
    (done ? "data: [DONE]\n\n" : "")
  );
}
export function delta(value: unknown, finish: string | null = null) {
  return {
    id: "chatcmpl-up",
    object: "chat.completion.chunk",
    model: "served-model",
    choices: [{ index: 0, delta: value, finish_reason: finish }],
  };
}
export const CHAT_TEXT = chatChunks([
  delta({ role: "assistant", content: "" }),
  delta({ content: "Hello" }),
  delta({ content: " world" }, "stop"),
  {
    id: "chatcmpl-up",
    object: "chat.completion.chunk",
    model: "served-model",
    choices: [],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      prompt_tokens_details: { cached_tokens: 40 },
      completion_tokens_details: { reasoning_tokens: 5 },
    },
  },
]);

/** A Chat endpoint: CHAT_TEXT for `stream: true`, otherwise the same answer as one completion. */
export const CHAT_REPLY: Reply = (response, seen) => {
  if (seen.json().stream === true) {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(CHAT_TEXT);
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      id: "chatcmpl-up",
      object: "chat.completion",
      model: "served-model",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Hello world" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    }),
  );
};

/** A gateway handler mounted on its own loopback listener. */
export interface Mounted {
  base: string;
  port: number;
  handler: GatewayHandler;
  store: MemoryStore;
  clock: { now: number };
}
export async function mount(
  t: test.TestContext,
  store: MemoryStore,
  limits: Record<string, number> = {},
  deps: Pick<
    GatewayHandlerDeps,
    | "log"
    | "codexBackend"
    | "subscriptions"
    | "allowances"
    | "copilot"
    | "features"
    | "secrets"
  > = {},
): Promise<Mounted> {
  const clock = { now: Date.parse("2026-10-02T12:00:00.000Z") };
  const handler = createGatewayHandler({
    store,
    resolveSecret,
    clock: () => clock.now,
    limits: resolveHandlerLimits(limits),
    ...deps,
  });
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  t.after(async () => {
    await handler.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    base: `http://127.0.0.1:${address.port}`,
    port: address.port,
    handler,
    store,
    clock,
  };
}

export interface Answer {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  text: string;
  json(): Record<string, unknown>;
}
/** A raw HTTP/1.1 request; headers are sent exactly as given (Host included). */
export function send(
  port: number,
  path: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string | Buffer | object;
  } = {},
): Promise<Answer> {
  const body =
    options.body === undefined
      ? undefined
      : typeof options.body === "string" || Buffer.isBuffer(options.body)
        ? options.body
        : JSON.stringify(options.body);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: options.method ?? (body === undefined ? "GET" : "POST"),
        headers: {
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...options.headers,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const buffer = Buffer.concat(chunks);
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: buffer,
            text: buffer.toString("utf8"),
            json: () =>
              JSON.parse(buffer.toString("utf8")) as Record<string, unknown>,
          });
        });
        response.on("error", reject);
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}

/** Poll `condition` every 5 ms until it holds or `ms` passed. */
export async function until(condition: () => boolean, ms = 5_000) {
  const deadline = performance.now() + ms;
  while (!condition()) {
    if (performance.now() > deadline)
      throw new Error("condition not reached in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export function at(value: unknown, ...path: (string | number)[]): unknown {
  let current = value;
  for (const key of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}
