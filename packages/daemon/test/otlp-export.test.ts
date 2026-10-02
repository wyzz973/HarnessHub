// SPDX-License-Identifier: MIT
import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import type {
  GatewayKeyId,
  ModelCallEntry,
  ModelCallId,
  ModelPlaneStore,
  ModelRef,
  ProviderId,
  RouteGroupId,
} from "@harnesshub/core/model-plane";
import type { RunId, SessionId } from "@harnesshub/core/types";
import {
  exportCommittedCalls,
  resolveOtlpConfig,
  startModelCallExport,
  type ModelCallExportDeps,
  type OtlpConfig,
} from "../src/otlp-export.js";

const PROMPT = "prompt-canary-3f1c";
const ERROR_TEXT = "upstream said: prompt-canary-3f1c";
const HEADER_SECRET = "otlp-header-canary-91ab";

interface Received {
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

/**
 * A loopback OTLP/HTTP collector. `answer` decides each response; `"hang"`
 * never answers (the exporter's abort ends the request).
 */
async function collector(
  t: TestContext,
  answer: (
    index: number,
  ) => { status: number; headers?: Record<string, string> } | "hang" = () => ({
    status: 200,
  }),
) {
  const received: Received[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const index = received.length;
      received.push({
        path: request.url ?? "",
        headers: request.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      const decision = answer(index);
      if (decision === "hang") return;
      response.writeHead(decision.status, {
        "content-type": "application/json",
        ...decision.headers,
      });
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    received,
  };
}

function config(endpoint: string, extra: object = {}): OtlpConfig {
  const resolved = resolveOtlpConfig({ endpoint, ...extra });
  assert.ok(resolved);
  return resolved;
}

const deps = (
  extra: Partial<ModelCallExportDeps> = {},
): ModelCallExportDeps => ({
  resolveSecret: () => Promise.reject(new Error("no secret expected")),
  serviceVersion: "0.1.0-test",
  ...extra,
});

/** A successful translated streaming call with every field set. */
function fullEntry(): ModelCallEntry {
  return {
    callId: "mc_full" as ModelCallId,
    occurredAt: "2026-10-03T10:00:00.000Z",
    keyId: "hk_key1" as GatewayKeyId,
    scope: { kind: "session", sessionId: "ses_1" as SessionId },
    sessionId: "ses_1" as SessionId,
    runId: "run_1" as RunId,
    generation: 2,
    inbound: { protocol: "chat", path: "/v1/chat/completions", stream: true },
    requestedModel: "deepseek/deepseek-chat",
    modelRef: "deepseek/deepseek-chat" as ModelRef,
    group: "fast" as RouteGroupId,
    provider: "deepseek" as ProviderId,
    wireModel: "deepseek-chat",
    upstreamProtocol: "chat",
    mode: "translated",
    servedModel: "deepseek-chat-v3",
    patches: ["drop:store"],
    unmapped: ["metadata"],
    status: 200,
    finishReason: "stop",
    usage: {
      input: 100,
      cacheRead: 20,
      cacheWrite: 5,
      output: 40,
      reasoning: 10,
      source: "reported",
    },
    timing: { firstByteMs: 120, firstContentMs: 150, durationMs: 1500 },
    attempts: [],
    cost: { amountUsd: 0.0125, priceSource: "preset" },
    completion: "explicit",
  };
}

/** A gateway rejection of an agent key's call, with a redacted error text. */
function rejectedEntry(): ModelCallEntry {
  return {
    callId: "mc_rejected" as ModelCallId,
    occurredAt: "2026-10-03T10:00:01.000Z",
    keyId: "hk_key2" as GatewayKeyId,
    scope: { kind: "agent", adapterId: "codex" },
    inbound: { protocol: "gemini", path: "/v1beta/models/x", stream: false },
    patches: [],
    unmapped: [],
    status: 403,
    errorClass: "model_not_allowed",
    errorSource: "gateway",
    error: ERROR_TEXT,
    timing: { durationMs: 3 },
    attempts: [],
    cost: null,
    rejected: true,
    rejectReason: "model_not_allowed",
  };
}

type Value = Record<string, unknown>;
interface Span {
  traceId: string;
  spanId: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  status: { code: number; message?: string };
  attributes: { key: string; value: Value }[];
}
interface Payload {
  resourceSpans: {
    resource: { attributes: { key: string; value: Value }[] };
    scopeSpans: { scope: { name: string; version: string }; spans: Span[] }[];
  }[];
}

function spans(received: Received[]): Span[] {
  return received.flatMap((request) =>
    (JSON.parse(request.body) as Payload).resourceSpans.flatMap((resource) =>
      resource.scopeSpans.flatMap((scope) => scope.spans),
    ),
  );
}

function attributes(span: { attributes: { key: string; value: Value }[] }) {
  return Object.fromEntries(
    span.attributes.map(({ key, value }) => [key, value]),
  );
}

void test("the otlp block is off when absent and validated when present", () => {
  assert.equal(resolveOtlpConfig(undefined), undefined);
  assert.deepEqual(
    resolveOtlpConfig({
      endpoint: "https://api.honeycomb.io/",
      headers: {
        "x-honeycomb-team": { kind: "env", value: "HONEYCOMB_API_KEY" },
        "x-honeycomb-dataset": "harnesshub",
      },
      resource: { "deployment.environment": "dev", "host.cpus": 8 },
    }),
    {
      endpoint: "https://api.honeycomb.io",
      protocol: "http/json",
      headers: {
        "x-honeycomb-team": { kind: "env", value: "HONEYCOMB_API_KEY" },
        "x-honeycomb-dataset": "harnesshub",
      },
      resource: { "deployment.environment": "dev", "host.cpus": 8 },
    },
  );
  const rejected: [unknown, RegExp][] = [
    ["http://localhost:4318", /the block must be an object/],
    [{}, /endpoint must be a URL/],
    [{ endpoint: "localhost:4318" }, /endpoint must use http or https/],
    [{ endpoint: "ftp://collector" }, /endpoint must use http or https/],
    [{ endpoint: "https://user:pw@collector" }, /must not contain credentials/],
    [{ endpoint: "https://collector?token=x" }, /query or fragment/],
    [
      { endpoint: "http://c", protocol: "http/protobuf" },
      /http\/protobuf is not supported/,
    ],
    [{ endpoint: "http://c", protocol: "grpc" }, /protocol must be http\/json/],
    [{ endpoint: "http://c", enabled: true }, /unknown setting enabled/],
    [
      { endpoint: "http://c", headers: { "content-type": "x" } },
      /header content-type is not allowed/,
    ],
    [
      { endpoint: "http://c", headers: { "bad header": "x" } },
      /header bad header is not allowed/,
    ],
    [
      { endpoint: "http://c", headers: { a: "x\r\nb: y" } },
      /contains a line break/,
    ],
    [
      { endpoint: "http://c", headers: { a: { kind: "vault", value: "x" } } },
      /must be a string or a secret reference/,
    ],
    [
      { endpoint: "http://c", resource: { a: { nested: true } } },
      /resource a must be a string, number or boolean/,
    ],
  ];
  for (const [input, message] of rejected)
    assert.throws(
      () => resolveOtlpConfig(input),
      (error: Error & { code?: string }) =>
        error.code === "INVALID_CONFIG" && message.test(error.message),
      JSON.stringify(input),
    );
});

void test("each committed call is one SERVER span with exactly the GenAI and hh attributes", async (t) => {
  const stub = await collector(t);
  const exporter = await startModelCallExport(
    config(stub.endpoint, {
      headers: {
        "x-otlp-token": { kind: "env", value: "OTLP_TOKEN" },
        "x-tenant": "team-a",
      },
      resource: { "deployment.environment": "test", "service.name": "hh-dev" },
    }),
    deps({
      resolveSecret: async (ref) => {
        assert.deepEqual(ref, { kind: "env", value: "OTLP_TOKEN" });
        return HEADER_SECRET;
      },
      providerPreset: async (id) =>
        id === "deepseek" ? "deepseek" : undefined,
    }),
  );
  exporter.record(fullEntry());
  exporter.record(rejectedEntry());
  await exporter.flush();
  assert.equal(stub.received.length, 1);
  const [request] = stub.received;
  assert.equal(request!.path, "/v1/traces");
  assert.equal(request!.headers["content-type"], "application/json");
  assert.equal(request!.headers["x-otlp-token"], HEADER_SECRET);
  assert.equal(request!.headers["x-tenant"], "team-a");
  const payload = JSON.parse(request!.body) as Payload;
  assert.deepEqual(attributes(payload.resourceSpans[0]!.resource), {
    "service.name": { stringValue: "hh-dev" },
    "service.version": { stringValue: "0.1.0-test" },
    "deployment.environment": { stringValue: "test" },
  });
  assert.deepEqual(payload.resourceSpans[0]!.scopeSpans[0]!.scope, {
    name: "harnesshub.model-gateway",
    version: "0.1.0-test",
  });
  const [full, rejected] = spans(stub.received);
  assert.equal(full!.name, "chat deepseek/deepseek-chat");
  assert.equal(full!.kind, 2);
  assert.match(full!.traceId, /^[0-9a-f]{32}$/);
  assert.match(full!.spanId, /^[0-9a-f]{16}$/);
  const start = BigInt(Date.parse("2026-10-03T10:00:00.000Z")) * 1_000_000n;
  assert.equal(full!.startTimeUnixNano, String(start));
  assert.equal(full!.endTimeUnixNano, String(start + 1_500_000_000n));
  assert.deepEqual(full!.status, { code: 0 });
  assert.deepEqual(full!.attributes.map(({ key }) => key).slice(0, 2), [
    "gen_ai.operation.name",
    "gen_ai.provider.name",
  ]);
  assert.deepEqual(attributes(full!), {
    "gen_ai.operation.name": { stringValue: "chat" },
    "gen_ai.provider.name": { stringValue: "deepseek" },
    "gen_ai.request.model": { stringValue: "deepseek/deepseek-chat" },
    "gen_ai.response.model": { stringValue: "deepseek-chat-v3" },
    "gen_ai.conversation.id": { stringValue: "ses_1" },
    "gen_ai.response.finish_reasons": {
      arrayValue: { values: [{ stringValue: "stop" }] },
    },
    "gen_ai.usage.input_tokens": { intValue: "125" },
    "gen_ai.usage.output_tokens": { intValue: "50" },
    "http.response.status_code": { intValue: "200" },
    "hh.model_call.id": { stringValue: "mc_full" },
    "hh.model_ref": { stringValue: "deepseek/deepseek-chat" },
    "hh.provider.id": { stringValue: "deepseek" },
    "hh.route.group": { stringValue: "fast" },
    "hh.ingress.protocol": { stringValue: "chat" },
    "hh.stream": { boolValue: true },
    "hh.upstream.protocol": { stringValue: "chat" },
    "hh.mode": { stringValue: "translated" },
    "hh.key.id": { stringValue: "hk_key1" },
    "hh.key.scope": { stringValue: "session" },
    "hh.session.id": { stringValue: "ses_1" },
    "hh.run.id": { stringValue: "run_1" },
    "hh.run.generation": { intValue: "2" },
    "hh.usage.cache_read_tokens": { intValue: "20" },
    "hh.usage.cache_write_tokens": { intValue: "5" },
    "hh.usage.reasoning_tokens": { intValue: "10" },
    "hh.usage.source": { stringValue: "reported" },
    "hh.cost.amount": { doubleValue: 0.0125 },
    "hh.cost.currency": { stringValue: "USD" },
    "hh.cost.source": { stringValue: "preset" },
    "hh.time_to_first_byte_ms": { intValue: "120" },
    "hh.time_to_first_content_ms": { intValue: "150" },
    "hh.attempts": { intValue: "0" },
    "hh.completion": { stringValue: "explicit" },
  });
  assert.equal(rejected!.name, "generate_content");
  assert.deepEqual(rejected!.status, { code: 2, message: "model_not_allowed" });
  assert.deepEqual(attributes(rejected!), {
    "gen_ai.operation.name": { stringValue: "generate_content" },
    "http.response.status_code": { intValue: "403" },
    "error.type": { stringValue: "model_not_allowed" },
    "hh.model_call.id": { stringValue: "mc_rejected" },
    "hh.ingress.protocol": { stringValue: "gemini" },
    "hh.stream": { boolValue: false },
    "hh.key.id": { stringValue: "hk_key2" },
    "hh.key.scope": { stringValue: "agent" },
    "hh.key.agent": { stringValue: "codex" },
    "hh.cost.source": { stringValue: "unknown" },
    "hh.attempts": { intValue: "0" },
    "hh.error.source": { stringValue: "gateway" },
    "hh.rejected": { boolValue: true },
    "hh.reject_reason": { stringValue: "model_not_allowed" },
  });
  // Error texts, patches and header secrets never enter the payload.
  for (const secret of [
    ERROR_TEXT,
    PROMPT,
    HEADER_SECRET,
    "drop:store",
    "metadata",
  ])
    assert.equal(request!.body.includes(secret), false, secret);
  await exporter.shutdown();
});

void test("usage that was not reported is not exported as zero, and a custom provider keeps its id", async (t) => {
  const stub = await collector(t);
  const exporter = await startModelCallExport(
    config(stub.endpoint),
    deps({ providerPreset: () => Promise.reject(new Error("store closed")) }),
  );
  const entry = fullEntry();
  entry.usage = { ...entry.usage!, source: "missing" };
  entry.provider = "my-relay" as ProviderId;
  entry.cost = null;
  exporter.record(entry);
  await exporter.shutdown();
  const view = attributes(spans(stub.received)[0]!);
  assert.deepEqual(view["gen_ai.provider.name"], { stringValue: "my-relay" });
  for (const key of [
    "gen_ai.usage.input_tokens",
    "gen_ai.usage.output_tokens",
    "hh.usage.cache_read_tokens",
    "hh.cost.amount",
  ])
    assert.equal(view[key], undefined, key);
  assert.deepEqual(view["hh.usage.source"], { stringValue: "missing" });
  assert.deepEqual(view["hh.cost.source"], { stringValue: "unknown" });
});

void test("a full queue drops and counts spans; recording never waits for the collector", async (t) => {
  const stub = await collector(t, () => "hang");
  const exporter = await startModelCallExport(
    config(stub.endpoint),
    deps({
      limits: {
        maxQueue: 4,
        maxBatch: 2,
        shutdownMs: 200,
        exportTimeoutMs: 60_000,
      },
    }),
  );
  const started = performance.now();
  for (let index = 0; index < 10; index++) exporter.record(fullEntry());
  // A malformed entry is dropped as well, without throwing at the caller.
  exporter.record({} as unknown as ModelCallEntry);
  assert.ok(performance.now() - started < 50, "record() does not wait");
  assert.deepEqual(exporter.stats(), {
    queued: 4,
    exported: 0,
    dropped: 7,
    failed: 0,
    retries: 0,
  });
  // The first full batch is in flight and the collector never answers.
  while (stub.received.length === 0)
    await new Promise((resolve) => setTimeout(resolve, 5));
  const stopping = performance.now();
  const final = await exporter.shutdown();
  assert.ok(performance.now() - stopping < 2000, "shutdown keeps its deadline");
  assert.deepEqual(final, {
    queued: 0,
    exported: 0,
    dropped: 11,
    failed: 0,
    retries: 0,
  });
  exporter.record(fullEntry());
  assert.equal(exporter.stats().dropped, 12);
});

void test("429 and 5xx answers are retried after Retry-After; other statuses fail without a retry", async (t) => {
  const flaky = await collector(t, (index) =>
    index === 0
      ? { status: 503, headers: { "retry-after": "0" } }
      : { status: 200 },
  );
  const retried = await startModelCallExport(config(flaky.endpoint), deps());
  retried.record(fullEntry());
  await retried.flush();
  assert.equal(flaky.received.length, 2);
  assert.deepEqual(await retried.shutdown(), {
    queued: 0,
    exported: 1,
    dropped: 0,
    failed: 0,
    retries: 1,
  });
  const refusing = await collector(t, () => ({ status: 400 }));
  const refused = await startModelCallExport(config(refusing.endpoint), deps());
  refused.record(fullEntry());
  await refused.flush();
  assert.equal(refusing.received.length, 1);
  assert.deepEqual(await refused.shutdown(), {
    queued: 0,
    exported: 0,
    dropped: 0,
    failed: 1,
    retries: 0,
  });
});

void test("shutdown exports the queued spans before the periodic flush would", async (t) => {
  const stub = await collector(t);
  const exporter = await startModelCallExport(config(stub.endpoint), deps());
  for (let index = 0; index < 3; index++) exporter.record(fullEntry());
  assert.equal(stub.received.length, 0);
  assert.deepEqual(await exporter.shutdown(), {
    queued: 0,
    exported: 3,
    dropped: 0,
    failed: 0,
    retries: 0,
  });
  assert.equal(spans(stub.received).length, 3);
  // Idempotent.
  assert.equal((await exporter.shutdown()).exported, 3);
});

void test("only entries whose ledger commit succeeded are handed to the exporter", async () => {
  const committed: string[] = [];
  const store = {
    calls: 0,
    async appendModelCall(entry: ModelCallEntry) {
      this.calls++;
      if (entry.callId === ("mc_rejected" as ModelCallId))
        throw new Error("SQLITE_FULL");
    },
    async getProvider(this: { calls: number }) {
      return this.calls;
    },
  };
  const wrapped = exportCommittedCalls(
    store as unknown as ModelPlaneStore,
    (entry) => committed.push(entry.callId),
  );
  await wrapped.appendModelCall(fullEntry());
  await assert.rejects(wrapped.appendModelCall(rejectedEntry()), /SQLITE_FULL/);
  assert.deepEqual(committed, ["mc_full"]);
  // Other members run on the store itself.
  assert.equal(await wrapped.getProvider("p" as ProviderId), 2);
});
