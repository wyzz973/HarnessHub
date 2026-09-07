import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeEngine } from "../../src/engine/registry.js";
import { prepareConfiguration } from "../../src/drivers/configuration/prepare.js";
import type { RunId, SessionId } from "../../src/domain/types.js";
import { startModelBridge } from "../../src/drivers/chat-completions/bridge.js";
import {
  responsesToChat,
  googleToChat,
  responseOutput,
  googleOutput,
} from "../../src/drivers/chat-completions/protocol.js";

void test("Responses function, custom and namespace tool history is reversible; unsupported semantics reject", () => {
  const request = {
    model: "fixture",
    instructions: "system",
    input: [
      { role: "developer", content: [{ type: "input_text", text: "skill" }] },
      {
        type: "custom_tool_call",
        call_id: "c",
        name: "apply_patch",
        input: "*** Begin Patch\n*** End Patch",
      },
      { type: "custom_tool_call_output", call_id: "c", output: "done" },
    ],
    tools: [
      { type: "custom", name: "apply_patch", format: { type: "text" } },
      {
        type: "namespace",
        name: "mcp",
        tools: [
          { type: "function", name: "read", parameters: { type: "object" } },
        ],
      },
    ],
    stream: true,
    store: false,
  };
  const translated = responsesToChat(request, "fixture");
  const messages = translated.body.messages as Record<string, unknown>[];
  assert.deepEqual(messages.slice(0, 2), [
    { role: "system", content: "system" },
    { role: "system", content: "skill" },
  ]);
  assert.deepEqual(messages.at(-1), {
    role: "tool",
    tool_call_id: "c",
    content: "done",
  });
  const names = [...translated.tools.keys()];
  const output = responseOutput(
    {
      text: "",
      finish: "tool_calls",
      calls: [
        { id: "c1", name: names[0]!, arguments: '{"input":"raw patch"}' },
        { id: "c2", name: names[1]!, arguments: '{"path":"a"}' },
      ],
    },
    translated.tools,
    "fixture",
  );
  assert.equal(output[0]!.input, "raw patch");
  assert.equal(output[0]!.type, "custom_tool_call");
  assert.equal(output[1]!.namespace, "mcp");
  assert.equal(output[1]!.name, "read");
  for (const change of [
    { previous_response_id: "old" },
    { tools: [{ type: "web_search" }] },
    { input: [{ type: "reasoning", encrypted_content: "cipher" }] },
    {
      input: [
        {
          role: "user",
          content: [{ type: "input_image", image_url: "data:test" }],
        },
      ],
    },
    { reasoning: { effort: "high" } },
    { model: "other" },
    { unknown: true },
    { temperature: { value: 1 } },
    { parallel_tool_calls: "yes" },
    { stream: "true" },
  ])
    assert.throws(() => responsesToChat({ ...request, ...change }, "fixture"));
});

void test("Google function identities and result pairing survive Chat conversion; unsupported parts reject", () => {
  const request = {
    contents: [
      { role: "user", parts: [{ text: "read" }] },
      {
        role: "model",
        parts: [
          {
            functionCall: { name: "workspace_read", args: { path: "文档" } },
            thoughtSignature: "skip_thought_signature_validator",
          },
        ],
      },
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              name: "workspace_read",
              response: { output: "value" },
            },
          },
        ],
      },
    ],
    tools: [
      {
        functionDeclarations: [
          {
            name: "workspace_read",
            parameters: {
              type: "OBJECT",
              properties: { path: { type: "STRING" } },
            },
          },
        ],
      },
    ],
  };
  const translated = googleToChat(request, "fixture", true),
    messages = translated.body.messages as Record<string, unknown>[];
  assert.deepEqual(messages.at(-1), {
    role: "tool",
    tool_call_id: "gcall_0",
    content: '{"output":"value"}',
  });
  const output = googleOutput(
    {
      text: "",
      calls: [
        { id: "call_1", name: "workspace_read", arguments: '{"path":"文档"}' },
      ],
      finish: "tool_calls",
    },
    translated.tools,
  );
  assert.match(JSON.stringify(output), /workspace_read/);
  assert.match(JSON.stringify(output), /文档/);
  for (const change of [
    { contents: [{ role: "user", parts: [{ inlineData: {} }] }] },
    { tools: [{ googleSearch: {} }] },
    { generationConfig: { topK: 5 } },
    { cachedContent: "cached" },
    {
      contents: [
        {
          role: "model",
          parts: [
            {
              functionCall: { name: "workspace_read", args: {} },
              thoughtSignature: "real-signature",
            },
          ],
        },
      ],
    },
    {
      contents: [
        {
          role: "model",
          parts: [
            {
              text: "reasoning",
              thoughtSignature: "skip_thought_signature_validator",
            },
          ],
        },
      ],
    },
  ])
    assert.throws(() =>
      googleToChat({ ...request, ...change }, "fixture", true),
    );
});

async function fixture(
  t: test.TestContext,
  handler: (response: ServerResponse, body: Record<string, unknown>) => void,
) {
  const requests: Record<string, unknown>[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      assert.equal(request.url, "/company/v1/chat/completions");
      assert.equal(
        request.headers.authorization,
        "Bearer synthetic-company-key",
      );
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<
        string,
        unknown
      >;
      requests.push(body);
      handler(response, body);
    })().catch(() => {
      response.writeHead(500);
      response.end();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const bridge = await startModelBridge({
    baseUrl: `http://127.0.0.1:${address.port}/company/v1`,
    model: "fixture",
    apiKey: "synthetic-company-key",
  });
  t.after(async () => {
    await bridge.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const request = (body: unknown, token = bridge.token) =>
    fetch(bridge.baseUrl + "/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  return { bridge, request, requests };
}

void test(
  "authenticated Run-owned bridge preserves fragmented streaming, usage, tool args and awaited shutdown",
  { timeout: 10000 },
  async (t) => {
    const { bridge, request, requests } = await fixture(t, (response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      const data = (v: unknown) =>
        response.write(`data: ${JSON.stringify(v)}\r\n\r\n`);
      data({
        choices: [
          { index: 0, delta: { content: "你好" }, finish_reason: null },
        ],
      });
      data({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: { name: "read", arguments: '{"pa' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      });
      data({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: 'th":"文档"}' } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      });
      data({
        choices: [],
        usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
      });
      response.end("data: [DONE]\r\n\r\n");
    });
    const body = {
      model: "fixture",
      input: "hello",
      stream: true,
      tools: [
        { type: "function", name: "read", parameters: { type: "object" } },
      ],
    };
    assert.equal((await request(body, "wrong")).status, 401);
    assert.equal((await request(body)).status, 409);
    assert.equal(requests.length, 0);
    bridge.beginRun(new AbortController().signal);
    const response = await request(body),
      text = await response.text();
    assert.equal(response.status, 200);
    assert.match(text, /response.completed/);
    assert.match(text, /你好/);
    assert.match(text, /文档/);
    assert.match(text, /"input_tokens":3/);
    assert.equal(requests.length, 1);
    await bridge.endRun();
    assert.equal((await request(body)).status, 409);
    await bridge.close();
    await assert.rejects(fetch(bridge.baseUrl));
  },
);

for (const adapter of ["codex", "gemini"] as const)
  void test(`${adapter} Chat preparation keeps upstream credentials off disk and configures native approval/model before ACP`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "hh-chat-config-"));
    const profile = normalizeEngine({
      id: adapter,
      driver: "acp",
      command: [process.execPath, "peer.js"],
      model: "fixture",
      configuration: {
        adapter,
        provider: {
          protocol: "openai-completions",
          baseUrl: "http://127.0.0.1:1/v1",
          apiKey: { kind: "env", value: "FIXTURE_KEY" },
        },
      },
    });
    const prepared = await prepareConfiguration(
      {
        profile,
        cwd: root,
        stateDir: root,
        sessionId: "fixture" as SessionId,
        runId: "fixture" as RunId,
        generation: 1,
        input: { text: "test", timeoutMs: 1000 },
      },
      { FIXTURE_KEY: "synthetic-company-key" },
    );
    t.after(async () => {
      await prepared.modelBridge?.close();
      await rm(root, { recursive: true, force: true });
    });
    assert.ok(prepared.modelBridge);
    assert.notEqual(
      prepared.env.HARNESSHUB_PROVIDER_KEY,
      "synthetic-company-key",
    );
    const config = await readFile(
      adapter === "codex"
        ? join(prepared.env.CODEX_HOME!, "config.toml")
        : prepared.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH!,
      "utf8",
    );
    assert.equal(config.includes("synthetic-company-key"), false);
    if (adapter === "codex") {
      assert.equal(prepared.env.INITIAL_AGENT_MODE, "read-only");
      assert.match(config, /web_search = "disabled"/);
      assert.match(config, /model_reasoning_effort = "none"/);
    } else {
      assert.equal(prepared.nativeModelSelection, true);
      const settings = JSON.parse(config) as { model: { name: string } };
      assert.equal(settings.model.name, "fixture");
      const malformed = await fetch(
        prepared.modelBridge.baseUrl + "/v1beta/models/%ZZ:generateContent",
        {
          method: "POST",
          headers: { authorization: `Bearer ${prepared.modelBridge.token}` },
          body: "{}",
        },
      );
      assert.equal(malformed.status, 400);
    }
    const response = await fetch(
      prepared.modelBridge.baseUrl +
        (adapter === "codex"
          ? "/responses"
          : "/v1beta/models/fixture:generateContent"),
      {
        method: "POST",
        headers: { authorization: `Bearer ${prepared.modelBridge.token}` },
        body: "{}",
      },
    );
    assert.equal(response.status, 409);
  });

void test(
  "upstream cancellation is observed before Run reuse and incomplete streams never complete",
  { timeout: 10000 },
  async (t) => {
    const received = Promise.withResolvers<void>(),
      aborted = Promise.withResolvers<void>();
    let responseCount = 0;
    const { bridge, request } = await fixture(t, (response) => {
      responseCount++;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        'data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n',
      );
      if (responseCount === 1) {
        response.once("close", () => aborted.resolve());
        received.resolve();
      } else response.end();
    });
    const controller = new AbortController();
    bridge.beginRun(controller.signal);
    const first = await request({
      model: "fixture",
      input: "long",
      stream: true,
    });
    const reading = first.text().catch(() => "aborted");
    await received.promise;
    controller.abort();
    await bridge.endRun();
    await aborted.promise;
    await reading;
    bridge.beginRun(new AbortController().signal);
    const second = await request({
      model: "fixture",
      input: "short",
      stream: true,
    });
    const text = await second.text();
    assert.match(text, /response.failed/);
    assert.doesNotMatch(text, /response.completed/);
    await bridge.endRun();
  },
);
