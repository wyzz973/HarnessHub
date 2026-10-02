// SPDX-License-Identifier: MIT
// Sets the process launcher for the Windows filesystem primitives used directly here.
import "../support/process-launcher.js";
import assert from "node:assert/strict";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { RunRecord, SessionRecord } from "@harnesshub/core/types";
import { startHub } from "@harnesshub/daemon/main";
import { startModelGateway } from "@harnesshub/gateway/gateway";
import type { HubApplication } from "@harnesshub/runtime/application/service";
import { ensurePrivateDirectory } from "@harnesshub/store/platform/windows-acl";
import {
  credentialFingerprint,
  decodeAnswer,
  requestBuilders,
  startFakeProvider,
  type FakeProvider,
  type WireProtocol,
} from "../support/fake-provider.js";
import { temporaryDirectory } from "../support/temporary.js";

const UPSTREAM_KEY = "synthetic-fake-provider-upstream-canary-5e8d";
const UPSTREAM_MODEL = "upstream-real-model";
const ALIAS = "harnesshub-model";
const PROTOCOLS: WireProtocol[] = ["chat", "responses", "messages", "gemini"];

async function strictProvider(
  t: test.TestContext,
  options: Record<string, unknown> = {},
): Promise<FakeProvider> {
  // Blacklist mode (the default); the gateway always streams upstream.
  const provider = await startFakeProvider({
    models: [UPSTREAM_MODEL],
    keys: { upstream: UPSTREAM_KEY },
    streamOnly: true,
    chunkDelayMs: 0,
    ...options,
  });
  t.after(() => provider.close());
  return provider;
}

/** What engines send to the gateway: their native requests, with the extras they really add. */
function inbound(
  protocol: WireProtocol,
  stream: boolean,
  text: string,
  tools: unknown[],
): Record<string, unknown> {
  switch (protocol) {
    case "chat":
      return {
        model: ALIAS,
        stream,
        ...(stream ? { stream_options: { include_usage: true } } : {}),
        store: false,
        metadata: { trace: "engine" },
        user: "engine-user",
        parallel_tool_calls: true,
        reasoning_effort: "low",
        max_completion_tokens: 512,
        messages: [
          { role: "developer", content: "Be brief." },
          { role: "user", content: text },
        ],
        tools,
        tool_choice: "auto",
      };
    case "responses":
      return {
        model: ALIAS,
        stream,
        instructions: "Be brief.",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text }],
          },
        ],
        tools,
        tool_choice: "auto",
        parallel_tool_calls: false,
        reasoning: { effort: "low", summary: "auto" },
        store: false,
        include: ["reasoning.encrypted_content"],
        prompt_cache_key: "conversation-1",
        max_output_tokens: 512,
      };
    case "messages":
      return {
        model: ALIAS,
        stream,
        max_tokens: 512,
        system: [
          {
            type: "text",
            text: "Be brief.",
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text, cache_control: { type: "ephemeral" } },
            ],
          },
        ],
        tools,
        thinking: { type: "enabled", budget_tokens: 1024 },
        metadata: { user_id: "engine-user" },
      };
    case "gemini":
      return {
        systemInstruction: { parts: [{ text: "Be brief." }] },
        contents: [{ role: "user", parts: [{ text }] }],
        tools,
        generationConfig: {
          maxOutputTokens: 512,
          temperature: 0.2,
          thinkingConfig: { includeThoughts: true },
        },
      };
  }
}

function gatewayRoute(protocol: WireProtocol, stream: boolean): string {
  switch (protocol) {
    case "chat":
      return "/v1/chat/completions";
    case "responses":
      return "/v1/responses";
    case "messages":
      return "/v1/messages";
    case "gemini":
      return `/v1beta/models/${ALIAS}:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`;
  }
}

function gatewayHeaders(
  protocol: WireProtocol,
  token: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (protocol === "messages") {
    headers["x-api-key"] = token;
    headers["anthropic-version"] = "2023-06-01";
  } else if (protocol === "gemini") headers["x-goog-api-key"] = token;
  else headers.authorization = `Bearer ${token}`;
  return headers;
}

void test(
  "the model gateway's upstream requests from all four inbound protocols pass the strict fake provider",
  { timeout: 60_000 },
  async (t) => {
    const provider = await strictProvider(t);
    const gateway = await startModelGateway({
      upstream: {
        protocol: "openai-completions",
        baseUrl: `${provider.url}/v1`,
        apiKey: UPSTREAM_KEY,
      },
      model: UPSTREAM_MODEL,
      alias: ALIAS,
    });
    t.after(() => gateway.close());
    gateway.beginRun(new AbortController().signal);
    const builders = await requestBuilders();
    const call = async (
      protocol: WireProtocol,
      stream: boolean,
      body: Record<string, unknown>,
    ) => {
      const response = await fetch(
        gateway.baseUrl + gatewayRoute(protocol, stream),
        {
          method: "POST",
          headers: gatewayHeaders(protocol, gateway.token),
          body: JSON.stringify(body),
        },
      );
      const text = await response.text();
      assert.equal(response.status, 200, `${protocol} ${stream}: ${text}`);
      return decodeAnswer(protocol, text, { stream, sse: true });
    };

    for (const protocol of PROTOCOLS)
      for (const stream of [false, true]) {
        const where = `${protocol} stream=${stream}`;
        const plain = await call(
          protocol,
          stream,
          inbound(protocol, stream, "hello", builders.shellTools(protocol)),
        );
        assert.equal(plain.text, "OK", where);
        // A tool round trip: the provider requires the reasoning of its call
        // back, which the gateway restores from what the engine returned.
        const first = inbound(
          protocol,
          stream,
          `HH_MOCK_TOOL ${where}`,
          builders.shellTools(protocol),
        );
        const called = await call(protocol, stream, first);
        assert.deepEqual(
          called.toolCalls.map((tool) => [
            tool.name,
            JSON.parse(tool.arguments) as unknown,
          ]),
          [["bash", { command: "echo mock-ok > mock-ok.txt" }]],
          where,
        );
        const done = await call(
          protocol,
          stream,
          builders.followUp(protocol, first, called),
        );
        assert.equal(done.text, "DONE", where);
      }

    await provider.idle();
    const records = provider.records();
    assert.equal(records.length, PROTOCOLS.length * 2 * 3);
    assert.deepEqual(provider.violations(), []);
    const upstreamKey = await credentialFingerprint(UPSTREAM_KEY);
    for (const record of records) {
      assert.equal(record.path, "/v1/chat/completions");
      assert.equal(record.status, 200);
      assert.equal(record.stream, true);
      assert.equal(record.model, UPSTREAM_MODEL);
      assert.equal(record.auth, "ok");
      assert.equal(record.keyId, "upstream");
      // Only the configured upstream key left the gateway, never its Session token.
      assert.equal(record.keyFingerprint, upstreamKey);
    }
    assert.deepEqual(
      records.map((record) => record.turn),
      Array.from({ length: PROTOCOLS.length * 2 }, () => [
        "plain",
        "tool-call",
        "tool-result",
      ]).flat(),
    );
    for (const record of records.filter(
      (entry) => entry.turn === "tool-result",
    ))
      assert.equal(record.reasoningEcho, true);
  },
);

void test(
  "the strict fake provider reports what the gateway leaks upstream when compatibility settings add vendor fields",
  { timeout: 30_000 },
  async (t) => {
    const provider = await strictProvider(t);
    const gateway = await startModelGateway({
      upstream: {
        protocol: "openai-completions",
        baseUrl: `${provider.url}/v1`,
        apiKey: UPSTREAM_KEY,
      },
      model: UPSTREAM_MODEL,
      alias: ALIAS,
      compatibility: {
        includeUsage: true,
        maxTokensField: "max_completion_tokens",
      },
    });
    t.after(() => gateway.close());
    gateway.beginRun(new AbortController().signal);
    const response = await fetch(`${gateway.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: gatewayHeaders("chat", gateway.token),
      body: JSON.stringify({
        model: ALIAS,
        stream: true,
        max_tokens: 64,
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    const text = await response.text();
    assert.equal(response.status, 400, text);
    assert.match(text, /Unsupported parameter: 'max_completion_tokens'/);
    await provider.idle();
    assert.deepEqual(
      provider
        .violations()
        .map((violation) => [violation.path, violation.rule])
        .sort(),
      [
        ["max_completion_tokens", "forbidden"],
        ["stream_options", "forbidden"],
      ],
    );
  },
);

type Hub = Awaited<ReturnType<typeof startHub>>;
type RunView = ReturnType<HubApplication["getRun"]>;

void test(
  "a Run through the daemon, a Worker and the Session model gateway reaches the strict fake provider without violations",
  { timeout: 60_000 },
  async (t) => {
    const { directory: root, defer } = await temporaryDirectory(
      t,
      "hh-fake-provider-",
    );
    const provider = await startFakeProvider({
      models: [UPSTREAM_MODEL],
      keys: { upstream: UPSTREAM_KEY },
      streamOnly: true,
      chunkDelayMs: 0,
    });
    defer(() => provider.close());
    const saved = process.env.HH_FAKE_PROVIDER_FIXTURE_KEY;
    // The Gateway snapshots its environment for Workers when it starts.
    process.env.HH_FAKE_PROVIDER_FIXTURE_KEY = UPSTREAM_KEY;
    defer(() => {
      if (saved === undefined) delete process.env.HH_FAKE_PROVIDER_FIXTURE_KEY;
      else process.env.HH_FAKE_PROVIDER_FIXTURE_KEY = saved;
    });
    if (process.platform === "win32") await ensurePrivateDirectory(root);
    const hub: Hub = await startHub({
      cwd: root,
      dataDir: join(root, "data"),
      demo: false,
      port: 0,
    });
    defer(() => hub.server.close());
    async function json<T>(route: string, body?: unknown): Promise<T> {
      const response = await fetch(
        hub.url + route,
        body === undefined
          ? {}
          : {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            },
      );
      assert.ok(response.ok, `${route}: ${response.status}`);
      return (await response.json()) as T;
    }
    await json("/v1/engines", {
      id: "opencode",
      driver: "acp",
      command: [
        process.execPath,
        fileURLToPath(
          new URL("../fixtures/model-gateway-peer.js", import.meta.url),
        ),
        "opencode",
      ],
      model: UPSTREAM_MODEL,
      configuration: {
        adapter: "opencode",
        provider: {
          protocol: "openai-completions",
          baseUrl: `${provider.url}/v1`,
          apiKey: { kind: "env", value: "HH_FAKE_PROVIDER_FIXTURE_KEY" },
        },
      },
    });
    const session = await json<SessionRecord>("/v1/sessions", {
      engineId: "opencode",
    });
    const accepted = await json<RunRecord>(`/v1/sessions/${session.id}/runs`, {
      text: "hello through the model gateway",
      timeoutMs: 20_000,
    });
    let run = await json<RunView>(`/v1/runs/${accepted.id}`);
    const deadline = Date.now() + 30_000;
    while (!run.finishedAt) {
      assert.ok(Date.now() < deadline, "Run did not settle");
      await delay(20);
      run = await json<RunView>(`/v1/runs/${accepted.id}`);
    }
    assert.equal(run.status, "completed", JSON.stringify(run.error));
    assert.equal(run.output, "OK");
    await json(`/v1/sessions/${session.id}/close`, {});

    await provider.idle();
    const records = provider.records();
    assert.equal(records.length, 1);
    assert.deepEqual(provider.violations(), []);
    const [record] = records;
    assert.deepEqual(
      [
        record!.path,
        record!.status,
        record!.auth,
        record!.keyId,
        record!.model,
        record!.stream,
      ],
      ["/v1/chat/completions", 200, "ok", "upstream", UPSTREAM_MODEL, true],
    );
  },
);
