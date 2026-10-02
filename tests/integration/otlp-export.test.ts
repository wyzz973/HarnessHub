// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { startHub } from "@harnesshub/daemon/main";
import { connectLocal } from "@harnesshub/sdk/local";
import { startFakeProvider } from "../support/fake-provider.js";
import { temporaryDirectory } from "../support/temporary.js";

const UPSTREAM_KEY = "sk-synthetic-otlp-upstream-7c21";
const HEADER_SECRET = "otlp-collector-token-canary-2d9e";
const PROMPT = "prompt-canary-otlp-5a0f";
const KEY_NAME = "alice@example.com laptop";

interface Received {
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

/** A loopback OTLP/HTTP collector that accepts everything. */
async function collector(t: TestContext) {
  const received: Received[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received.push({
        path: request.url ?? "",
        headers: request.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      response.writeHead(200, { "content-type": "application/json" });
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

/** Set environment variables for the test and restore them afterwards. */
function environment(t: TestContext, values: Record<string, string>): void {
  const saved = Object.fromEntries(
    Object.keys(values).map((name) => [name, process.env[name]]),
  );
  Object.assign(process.env, values);
  t.after(() => {
    for (const [name, value] of Object.entries(saved))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  });
}

type Value = Record<string, unknown>;
interface Span {
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  status: { code: number; message?: string };
  attributes: { key: string; value: Value }[];
}

function spans(received: Received[]): Span[] {
  return received.flatMap(
    (request) =>
      (
        JSON.parse(request.body) as {
          resourceSpans: { scopeSpans: { spans: Span[] }[] }[];
        }
      ).resourceSpans[0]!.scopeSpans[0]!.spans,
  );
}

const view = (span: Span) =>
  Object.fromEntries(span.attributes.map(({ key, value }) => [key, value]));

/** A daemon with a fake upstream provider and one Gateway Key. */
async function hubWithProvider(
  t: TestContext,
  otlp: Record<string, unknown> | undefined,
) {
  const { directory, defer } = await temporaryDirectory(t, "hh-otlp-");
  const provider = await startFakeProvider({
    models: ["chat-1"],
    keys: { upstream: UPSTREAM_KEY },
    chunkDelayMs: 0,
  });
  defer(() => provider.close());
  const dataDir = path.join(directory, "data");
  const hub = await startHub({
    dataDir,
    configDir: path.join(directory, "config"),
    secretsBackend: "file",
    demo: true,
    cwd: directory,
    port: 0,
    host: "127.0.0.1",
    ...(otlp ? { otlp } : {}),
  });
  let running = true;
  defer(() => (running ? hub.server.close() : undefined));
  const client = await connectLocal({ dataDir, url: hub.url });
  await client.providers.create({
    id: "fake",
    endpoints: { chat: `${provider.url}/v1` },
    models: {
      source: "manual",
      list: [{ id: "chat-1", price: { input: 1, output: 2 } }],
      expose: "all",
    },
    credential: { value: UPSTREAM_KEY },
  });
  const { key } = await client.gatewayKeys.create({
    name: KEY_NAME,
    modelAllow: ["fake/*"],
  });
  const gateway = (await client.system.info()).gateway!;
  const chat = async (body: Record<string, unknown>) => {
    const response = await fetch(`${gateway.openaiBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, text: await response.text() };
  };
  const close = async () => {
    running = false;
    await hub.server.close();
  };
  return { client, chat, close, key, provider };
}

void test(
  "committed model calls are exported as GenAI spans without prompts, outputs, tool arguments or credentials",
  { timeout: 60_000 },
  async (t) => {
    const stub = await collector(t);
    environment(t, { HH_OTLP_TEST_TOKEN: HEADER_SECRET });
    const { client, chat, close, key, provider } = await hubWithProvider(t, {
      endpoint: stub.endpoint,
      headers: {
        "x-otlp-token": { kind: "env", value: "HH_OTLP_TEST_TOKEN" },
      },
      resource: { "deployment.environment": "integration" },
    });

    const plain = await chat({
      model: "fake/chat-1",
      messages: [{ role: "user", content: PROMPT }],
    });
    assert.equal(plain.status, 200, plain.text);
    const tool = await chat({
      model: "fake/chat-1",
      stream: true,
      messages: [{ role: "user", content: `HH_MOCK_TOOL ${PROMPT}` }],
      tools: [
        {
          type: "function",
          function: {
            name: "bash",
            parameters: {
              type: "object",
              properties: { command: { type: "string" } },
              required: ["command"],
            },
          },
        },
      ],
    });
    assert.equal(tool.status, 200, tool.text);
    assert.match(tool.text, /mock-ok\.txt/);
    const refused = await chat({
      model: "elsewhere/model",
      messages: [{ role: "user", content: PROMPT }],
    });
    assert.ok(refused.status >= 400, refused.text);
    const ledger = (await client.modelCalls.list({ limit: 10 })).items;
    assert.equal(ledger.length, 3);
    // Nothing is exported before the periodic flush (5 s); closing the
    // daemon flushes the queue after the last ledger commit.
    await close();
    await provider.idle();
    assert.deepEqual(provider.violations(), []);

    assert.ok(stub.received.length >= 1);
    for (const request of stub.received) {
      assert.equal(request.path, "/v1/traces");
      assert.equal(request.headers["content-type"], "application/json");
      assert.equal(request.headers["x-otlp-token"], HEADER_SECRET);
    }
    const exported = spans(stub.received);
    assert.deepEqual(
      exported
        .map((span) => (view(span)["hh.model_call.id"] as Value).stringValue)
        .sort(),
      ledger.map((entry) => entry.callId).sort(),
    );

    // The plain call's span against its ledger entry, attribute by attribute.
    const entry = ledger.find(
      (call) => call.inbound.stream === false && call.status === 200,
    )!;
    const span = exported.find(
      (candidate) =>
        JSON.stringify(view(candidate)["hh.model_call.id"]) ===
        JSON.stringify({ stringValue: entry.callId }),
    )!;
    const usage = entry.usage!;
    assert.equal(span.name, "chat fake/chat-1");
    assert.equal(span.kind, 2);
    assert.deepEqual(span.status, { code: 0 });
    const start = BigInt(Date.parse(entry.occurredAt)) * 1_000_000n;
    assert.equal(span.startTimeUnixNano, String(start));
    assert.equal(
      span.endTimeUnixNano,
      String(start + BigInt(entry.timing.durationMs) * 1_000_000n),
    );
    const int = (value: number) => ({ intValue: String(value) });
    const text = (value: string) => ({ stringValue: value });
    const expected: Record<string, Value> = {
      "gen_ai.operation.name": text("chat"),
      // A provider created without a preset is named by its id.
      "gen_ai.provider.name": text("fake"),
      "gen_ai.request.model": text("fake/chat-1"),
      "gen_ai.response.model": text(entry.servedModel!),
      "gen_ai.response.finish_reasons": {
        arrayValue: { values: [text(entry.finishReason!)] },
      },
      "gen_ai.usage.input_tokens": int(
        usage.input + usage.cacheRead + usage.cacheWrite,
      ),
      "gen_ai.usage.output_tokens": int(usage.output + usage.reasoning),
      "http.response.status_code": int(200),
      "hh.model_call.id": text(entry.callId),
      "hh.model_ref": text(entry.modelRef!),
      "hh.provider.id": text("fake"),
      "hh.ingress.protocol": text("chat"),
      "hh.stream": { boolValue: false },
      "hh.upstream.protocol": text(entry.upstreamProtocol!),
      "hh.mode": text(entry.mode!),
      "hh.key.id": text(entry.keyId!),
      "hh.key.scope": text("client"),
      "hh.usage.cache_read_tokens": int(usage.cacheRead),
      "hh.usage.cache_write_tokens": int(usage.cacheWrite),
      "hh.usage.reasoning_tokens": int(usage.reasoning),
      "hh.usage.source": text(usage.source),
      "hh.cost.amount": { doubleValue: Number(entry.cost!.amount) },
      "hh.cost.currency": text("USD"),
      "hh.cost.source": text(entry.cost!.priceSource),
      "hh.attempts": int(entry.attempts.length),
      ...(entry.timing.firstByteMs !== undefined
        ? { "hh.time_to_first_byte_ms": int(entry.timing.firstByteMs) }
        : {}),
      ...(entry.timing.firstContentMs !== undefined
        ? { "hh.time_to_first_content_ms": int(entry.timing.firstContentMs) }
        : {}),
      ...(entry.completion !== undefined
        ? { "hh.completion": text(entry.completion) }
        : {}),
    };
    assert.deepEqual(view(span), expected);

    // No prompt, answer, reasoning, tool argument, credential, key text or
    // key name reached the collector.
    const payload = stub.received.map((request) => request.body).join("\n");
    for (const secret of [
      PROMPT,
      "mock-ok.txt",
      "short acknowledgement",
      UPSTREAM_KEY,
      key,
      HEADER_SECRET,
      KEY_NAME,
      "alice@example.com",
    ])
      assert.equal(payload.includes(secret), false, secret);
  },
);

void test(
  "without an otlp block nothing is exported, even with the standard OTEL variables set",
  { timeout: 60_000 },
  async (t) => {
    const stub = await collector(t);
    environment(t, {
      OTEL_EXPORTER_OTLP_ENDPOINT: stub.endpoint,
      OTEL_TRACES_EXPORTER: "otlp",
    });
    const { chat, close } = await hubWithProvider(t, undefined);
    const answered = await chat({
      model: "fake/chat-1",
      messages: [{ role: "user", content: PROMPT }],
    });
    assert.equal(answered.status, 200, answered.text);
    await close();
    assert.deepEqual(stub.received, []);
  },
);

void test(
  "an invalid otlp block fails the start before anything listens",
  { timeout: 30_000 },
  async (t) => {
    const { directory } = await temporaryDirectory(t, "hh-otlp-invalid-");
    await assert.rejects(
      startHub({
        dataDir: path.join(directory, "data"),
        configDir: path.join(directory, "config"),
        secretsBackend: "file",
        demo: true,
        cwd: directory,
        port: 0,
        host: "127.0.0.1",
        otlp: { endpoint: "http://127.0.0.1:4318", protocol: "http/protobuf" },
      }),
      /otlp: protocol http\/protobuf is not supported/,
    );
  },
);
