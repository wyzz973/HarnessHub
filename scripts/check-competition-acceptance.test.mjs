import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseChatStream, strictChatViolations } from "./lib/strict-chat.mjs";
import {
  decodeText,
  freePort,
  launcherCommand,
  redactor,
  startLoggedProcess,
  vendorCredentialNames,
  withoutVendorCredentials,
} from "./lib/competition-process.mjs";
import { httpRequest, waitUntil } from "./lib/competition-client.mjs";
import {
  conversationTurnKey,
  markerArguments,
  selectShellTool,
  startMockCompanyModel,
} from "./mock-company-model.mjs";
import { acceptancePrompts, runAcceptance } from "./competition-acceptance.mjs";
import { runSelfTest } from "./competition-selftest.mjs";
import { runMatrix } from "./competition-matrix.mjs";
import { startStrictChatProxy } from "./strict-chat-proxy.mjs";

const repo = fileURLToPath(new URL("../", import.meta.url));
const fixture = path.join(
  repo,
  "scripts",
  "fixtures",
  "fake-competition-gateway.mjs",
);
const valid = {
  model: "company-sim",
  stream: true,
  max_tokens: 1024,
  messages: [
    { role: "system", content: "s" },
    { role: "user", content: "hi" },
  ],
  tools: [{ type: "function", function: { name: "bash", parameters: {} } }],
  tool_choice: "auto",
};
const tool = (name, properties, required = []) => ({
  type: "function",
  function: { name, parameters: { type: "object", properties, required } },
});

async function temporary(t, prefix) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() =>
    rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    }),
  );
  return directory;
}

async function post(url, body, key) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}

async function startFakeGateway(t, mock, apiKey, extraEnv = {}) {
  const port = await freePort();
  const handle = startLoggedProcess({
    entry: fixture,
    args: ["--port", String(port), "--no-console"],
    env: {
      ...process.env,
      AGENT_ENGINE: "fake-engine",
      HARNESSHUB_MODEL: mock.model,
      HARNESSHUB_MODEL_BASE_URL: mock.url,
      HARNESSHUB_MODEL_API_KEY: apiKey,
      ...extraEnv,
    },
  });
  t.after(() => handle.stop());
  const ready = await waitUntil(
    async () =>
      (
        await httpRequest(`http://127.0.0.1:${port}/health/ready`).catch(
          () => undefined,
        )
      )?.status === 200,
    { timeoutMs: 15_000, intervalMs: 100 },
  );
  assert.ok(ready, handle.tail());
  return `http://127.0.0.1:${port}`;
}

async function fakeBundle(t) {
  const bundle = await temporary(t, "hh-fake-bundle-");
  await mkdir(path.join(bundle, "dist", "src"), { recursive: true });
  await writeFile(path.join(bundle, "package.json"), '{"type":"module"}\n');
  const entry = path.join(bundle, "dist", "src", "competition-bundle-main.js");
  await writeFile(
    entry,
    `import ${JSON.stringify(pathToFileURL(fixture).href)};\n`,
  );
  await writeFile(
    path.join(bundle, "bundle.json"),
    JSON.stringify({
      engines: [
        { id: "opencode", name: "OpenCode", version: "1.18.29" },
        { id: "hermes", name: "Hermes Agent" },
      ],
    }),
  );
  return { bundle, entry };
}

test("strict company rules accept a clean streaming request and reject every vendor-only shape", () => {
  assert.deepEqual(
    strictChatViolations(valid, { expectModel: "company-sim" }),
    [],
  );
  const invalid = [
    [{ ...valid, stream: false }, /stream must be true/],
    [{ ...valid, stream: undefined }, /stream must be true/],
    [{ ...valid, stream_options: { include_usage: true } }, /stream_options/],
    [{ ...valid, store: false }, /store/],
    [{ ...valid, metadata: {} }, /metadata/],
    [{ ...valid, max_completion_tokens: 10 }, /max_completion_tokens/],
    [{ ...valid, parallel_tool_calls: false }, /parallel_tool_calls/],
    [{ ...valid, reasoning_effort: "high" }, /reasoning_effort/],
    [
      {
        ...valid,
        messages: [
          { role: "developer", content: "d" },
          { role: "user", content: "u" },
        ],
      },
      /developer/,
    ],
    [
      {
        ...valid,
        messages: [
          { role: "user", content: "u" },
          { role: "system", content: "s" },
        ],
      },
      /system message must be first/,
    ],
    [
      {
        ...valid,
        messages: [
          { role: "system", content: "a" },
          { role: "system", content: "b" },
        ],
      },
      /only one system/,
    ],
    [{ ...valid, tools: [] }, /tool_choice is only accepted/],
    [{ ...valid, tools: [{ type: "web_search" }] }, /must be a function tool/],
    [{ ...valid, model: "other" }, /unified model company-sim/],
    [{ ...valid, messages: [] }, /messages must be a non-empty array/],
    ["not an object", /JSON object/],
  ];
  for (const [body, pattern] of invalid) {
    const violations = strictChatViolations(body, {
      expectModel: "company-sim",
    });
    assert.ok(
      violations.some((message) => pattern.test(message)),
      `${pattern} not in ${JSON.stringify(violations)}`,
    );
  }
});

test("shell tool selection follows engine tool shapes and never picks code or file tools", () => {
  const codex = selectShellTool([
    tool(
      "shell",
      {
        command: { type: "array", items: { type: "string" } },
        timeout_ms: { type: "number" },
      },
      ["command"],
    ),
  ]);
  assert.equal(codex.kind, "array");
  assert.deepEqual(markerArguments(codex, "win32").command, [
    "cmd.exe",
    "/d",
    "/c",
    "echo mock-ok> mock-ok.txt",
  ]);
  assert.deepEqual(markerArguments(codex, "linux").command, [
    "sh",
    "-c",
    "echo mock-ok > mock-ok.txt",
  ]);
  assert.equal(
    selectShellTool([
      tool("exec_command", { cmd: { type: "string" } }, ["cmd"]),
    ]).key,
    "cmd",
  );
  const qwen = selectShellTool([
    tool("read_file", { path: { type: "string" } }),
    tool(
      "run_shell_command",
      {
        command: { type: "string" },
        is_background: { type: "boolean" },
        directory: { type: "string" },
      },
      ["command", "is_background"],
    ),
  ]);
  assert.deepEqual(markerArguments(qwen, "win32"), {
    command: "echo mock-ok > mock-ok.txt",
    is_background: false,
  });
  assert.equal(
    selectShellTool([
      tool("execute_code", { code: { type: "string" } }),
      tool("terminal", { command: { type: "string" } }),
    ]).name,
    "terminal",
  );
  assert.equal(
    selectShellTool([
      tool("BashOutput", { bash_id: { type: "string" } }),
      tool("KillShell", { shell_id: { type: "string" } }),
      tool(
        "Bash",
        { command: { type: "string" }, description: { type: "string" } },
        ["command"],
      ),
    ]).name,
    "Bash",
  );
  assert.equal(
    selectShellTool([
      tool("read_file", { path: { type: "string" } }),
      tool("write_file", { command: { type: "string" } }),
    ]),
    undefined,
  );
  assert.equal(selectShellTool(undefined), undefined);
});

test("mock upstream streams reasoning, drives one tool round and enforces credentials, streaming and reasoning pass-back", async (t) => {
  const key = "mock-test-key-123456";
  const mock = await startMockCompanyModel({
    apiKey: key,
    quirks: true,
    slowMs: 60_000,
    platform: "linux",
  });
  t.after(() => mock.close());
  const url = `${mock.url}/chat/completions`;
  assert.equal((await post(url, { ...valid, stream: false }, key)).status, 400);
  assert.equal((await post(url, valid, "wrong-key")).status, 401);
  assert.equal((await post(url, valid)).status, 401);
  const ok = parseChatStream(
    (
      await post(
        url,
        {
          model: "company-sim",
          stream: true,
          messages: [{ role: "user", content: "只回复 OK" }],
        },
        key,
      )
    ).text,
  );
  assert.equal(ok.content, "OK");
  assert.ok(ok.reasoning.length > 0);
  assert.equal(ok.done, true);
  assert.ok(ok.usage);
  const tools = [
    tool(
      "bash",
      { command: { type: "string" }, description: { type: "string" } },
      ["command", "description"],
    ),
  ];
  const user = { role: "user", content: "HH_MOCK_TOOL please" };
  const first = parseChatStream(
    (
      await post(
        url,
        { model: "company-sim", stream: true, tools, messages: [user] },
        key,
      )
    ).text,
  );
  assert.deepEqual(first.finishReasons.at(-1), "tool_calls");
  const call = first.toolCalls[0];
  assert.match(call.id, /^call_hhmock_/);
  assert.deepEqual(JSON.parse(call.arguments), {
    command: "echo mock-ok > mock-ok.txt",
    description: "Create the HarnessHub mock marker file",
  });
  const assistant = {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      },
    ],
  };
  const result = { role: "tool", tool_call_id: call.id, content: "" };
  const missing = await post(
    url,
    {
      model: "company-sim",
      stream: true,
      tools,
      messages: [user, assistant, result],
    },
    key,
  );
  assert.equal(missing.status, 400);
  assert.match(missing.text, /reasoning_content/);
  const echoed = parseChatStream(
    (
      await post(
        url,
        {
          model: "company-sim",
          stream: true,
          tools,
          messages: [
            user,
            { ...assistant, reasoning_content: first.reasoning },
            result,
          ],
        },
        key,
      )
    ).text,
  );
  assert.equal(echoed.content, "DONE");
  const noShell = parseChatStream(
    (
      await post(
        url,
        {
          model: "company-sim",
          stream: true,
          tools: [tool("read_file", { path: { type: "string" } })],
          messages: [user],
        },
        key,
      )
    ).text,
  );
  assert.equal(noShell.content, "NO_SHELL_TOOL");
  const controller = new AbortController();
  const slow = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: "company-sim",
      stream: true,
      messages: [{ role: "user", content: "HH_MOCK_SLOW" }],
    }),
    signal: controller.signal,
  });
  const reader = slow.body.getReader();
  await reader.read();
  controller.abort();
  const aborted = await waitUntil(
    () =>
      mock
        .records()
        .some((entry) => entry.turn === "slow" && entry.aborted === true),
    {
      timeoutMs: 5000,
      intervalMs: 50,
    },
  );
  assert.ok(aborted);
  const turns = mock.records().map((entry) => entry.turn ?? entry.status);
  assert.ok(turns.includes("tool-call") && turns.includes("tool-result"));
  assert.ok(mock.records().some((entry) => entry.reasoningEcho === false));
  assert.ok(mock.records().some((entry) => entry.reasoningEcho === true));
});

test("mock tool-loop protection is per conversation, so engines sharing a prompt each get a tool call", async (t) => {
  const key = "mock-loop-key-123456";
  const mock = await startMockCompanyModel({ apiKey: key, platform: "linux" });
  t.after(() => mock.close());
  const url = `${mock.url}/chat/completions`;
  const tools = [tool("bash", { command: { type: "string" } }, ["command"])];
  const user = { role: "user", content: "HH_MOCK_TOOL please" };
  const ask = async (system) =>
    parseChatStream(
      (
        await post(
          url,
          {
            model: "company-sim",
            stream: true,
            tools,
            messages: [{ role: "system", content: system }, user],
          },
          key,
        )
      ).text,
    );
  // One conversation that never answers its tool call is stopped after three calls.
  for (let attempt = 1; attempt <= 3; attempt++)
    assert.equal((await ask("engine A")).toolCalls.length, 1, `${attempt}`);
  const stopped = await ask("engine A");
  assert.equal(stopped.toolCalls.length, 0);
  assert.equal(stopped.content, "DONE");
  // Other conversations with the same user prompt keep their own count.
  for (const system of ["engine B", "engine C", "engine D"])
    assert.equal((await ask(system)).toolCalls.length, 1, system);
  assert.deepEqual(
    mock.records().map((entry) => entry.turn),
    [
      "tool-call",
      "tool-call",
      "tool-call",
      "tool-loop-stopped",
      "tool-call",
      "tool-call",
      "tool-call",
    ],
  );
  // The key ignores tool-call rounds inside the turn but not earlier conversation.
  const call = {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: "call_1",
        type: "function",
        function: { name: "bash", arguments: "{}" },
      },
    ],
  };
  const base = [{ role: "system", content: "engine A" }, user];
  assert.equal(
    conversationTurnKey(base),
    conversationTurnKey([
      ...base,
      call,
      { role: "tool", tool_call_id: "call_1", content: "" },
    ]),
  );
  assert.notEqual(
    conversationTurnKey(base),
    conversationTurnKey([{ role: "system", content: "engine B" }, user]),
  );
  // Acceptance runs use a per-run nonce, so identical engines never share a count.
  const first = acceptancePrompts("aaaa1111", "linux").tool;
  const second = acceptancePrompts("bbbb2222", "linux").tool;
  assert.match(first, /^HH_MOCK_TOOL aaaa1111 /);
  assert.notEqual(first, second);
});

test("strict proxy rejects locally and forwards accepted requests with the caller's authorization", async (t) => {
  const key = "proxy-upstream-key-42";
  const upstream = await startMockCompanyModel({ apiKey: key });
  t.after(() => upstream.close());
  const proxy = await startStrictChatProxy({
    upstream: upstream.url,
    expectModel: "company-sim",
    logFile: path.join(await temporary(t, "hh-proxy-"), "log.jsonl"),
  });
  t.after(() => proxy.close());
  const rejected = await post(
    `${proxy.url}/chat/completions`,
    { ...valid, store: true },
    key,
  );
  assert.equal(rejected.status, 400);
  assert.equal(
    upstream.records().length,
    0,
    "rejected requests must not reach the upstream",
  );
  const forwarded = await post(
    `${proxy.url}/chat/completions`,
    {
      model: "company-sim",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    },
    key,
  );
  assert.equal(forwarded.status, 200);
  assert.equal(parseChatStream(forwarded.text).content, "OK");
  assert.equal(upstream.records().at(-1).auth, "ok");
  assert.equal(
    (
      await post(
        `${proxy.url}/chat/completions`,
        {
          model: "company-sim",
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        },
        "bad",
      )
    ).status,
    401,
  );
});

test("mock acceptance passes against a contract-conforming gateway and records unified model calls", async (t) => {
  const key = "acceptance-key-987654";
  const mock = await startMockCompanyModel({ apiKey: key });
  t.after(() => mock.close());
  const base = await startFakeGateway(t, mock, key);
  const out = await temporary(t, "hh-acceptance-");
  const result = await runAcceptance({
    base,
    engine: "fake-engine",
    out,
    scenario: "mock",
    expectModel: "company-sim",
    workRoot: path.join(out, "work"),
    abortSettleMs: 300,
    timeoutMs: 60_000,
  });
  assert.equal(result.status, "PASS", JSON.stringify(result.steps, null, 2));
  assert.deepEqual(
    result.steps.map((step) => [step.id, step.status]),
    [
      ["health", "PASS"],
      ["runtime-info", "PASS"],
      ["unified-model", "PASS"],
      ["event-stream", "PASS"],
      ["session-create", "PASS"],
      ["prompt-ok", "PASS"],
      ["tool-marker", "PASS"],
      ["abort", "PASS"],
      ["model-calls", "PASS"],
      ["session-delete", "PASS"],
    ],
  );
  assert.deepEqual(Object.keys(result.modelCalls.upstreamModels), [
    "company-sim",
  ]);
  assert.ok(result.modelCalls.total >= 3);
  assert.ok(result.session.files.includes("mock-ok.txt"));
  const written = JSON.parse(
    await readFile(path.join(out, "acceptance-fake-engine.json"), "utf8"),
  );
  assert.equal(written.status, "PASS");
  assert.ok(
    mock
      .records()
      .some(
        (entry) => entry.turn === "tool-result" && entry.reasoningEcho === true,
      ),
  );
});

test("mock acceptance fails for missing reasoning pass-back, foreign upstream models and unfinished messages", async (t) => {
  const key = "negative-key-24680";
  const mock = await startMockCompanyModel({ apiKey: key });
  t.after(() => mock.close());
  const cases = [
    [{ FAKE_DROP_REASONING: "1" }, "tool-marker", /prompt_async returned 502/],
    [
      { FAKE_UPSTREAM_MODEL: "vendor-default" },
      "model-calls",
      /non-unified upstream models: vendor-default/,
    ],
    [{ FAKE_FINISH: "length" }, "prompt-ok", /info.finish is "length"/],
  ];
  for (const [env, stepId, pattern] of cases) {
    const base = await startFakeGateway(t, mock, key, env);
    const out = await temporary(t, "hh-acceptance-negative-");
    const result = await runAcceptance({
      base,
      engine: "fake-engine",
      out,
      scenario: "mock",
      expectModel: "company-sim",
      workRoot: path.join(out, "work"),
      abortSettleMs: 300,
      timeoutMs: 60_000,
    });
    assert.equal(result.status, "FAIL");
    const step = result.steps.find((candidate) => candidate.id === stepId);
    assert.equal(step.status, "FAIL", JSON.stringify(result.steps));
    assert.match(step.error, pattern);
  }
});

test("self-test proves startup, console, session directory creation and clean shutdown, and fails when the launcher exits", async (t) => {
  const { bundle, entry } = await fakeBundle(t);
  const passed = await runSelfTest({
    bundle,
    entry,
    engine: "opencode",
    timeoutMs: 30_000,
    // A half-configured model environment must not fail a test that calls no model.
    env: {
      ...process.env,
      HARNESSHUB_MODEL: "only-the-id",
      harnesshub_model_api_key: "x",
    },
  });
  assert.equal(passed.status, "PASS", JSON.stringify(passed.checks, null, 2));
  assert.deepEqual(
    passed.checks.map((check) => check.name),
    [
      "ready",
      "runtime-info",
      "console",
      "root-redirect",
      "session-create",
      "session-status",
      "session-delete",
      "shutdown",
    ],
  );
  const failed = await runSelfTest({
    bundle,
    entry,
    engine: "broken",
    timeoutMs: 15_000,
  });
  assert.equal(failed.status, "FAIL");
  assert.match(failed.checks[0].error, /exited early/);
  assert.equal(failed.checks.at(-1).name, "shutdown");
  assert.equal(failed.checks.at(-1).status, "PASS");
});

test("matrix selects engines only through AGENT_ENGINE, scrubs vendor keys, redacts logs and continues after a failure", async (t) => {
  const { bundle, entry } = await fakeBundle(t);
  const out = await temporary(t, "hh-matrix-");
  const summaryFile = path.join(out, "step-summary.md");
  const result = await runMatrix({
    bundle,
    entry,
    engines: ["alpha", "broken"],
    out,
    mock: true,
    engineTimeoutMs: 90_000,
    summaryFile,
    env: {
      ...process.env,
      OPENAI_API_KEY: "sk-vendor-should-never-leak-000",
      GEMINI_API_KEY: "gemini-vendor-key",
      FAKE_PRINT_ENV: "1",
    },
  });
  assert.equal(result.status, "FAIL");
  assert.deepEqual(
    result.engines.map((engine) => [engine.engine, engine.status]),
    [
      ["alpha", "PASS"],
      ["broken", "FAIL"],
    ],
  );
  assert.ok(result.removedVendorVariables.includes("OPENAI_API_KEY"));
  assert.match(result.engines[1].notes.join(" "), /exited before ready/);
  assert.equal(result.engines[0].upstream.models["company-sim"] > 0, true);
  assert.deepEqual(result.engines[0].upstream.reasoningEcho, ["true"]);
  const summary = await readFile(summaryFile, "utf8");
  assert.match(summary, /NOT a real-model pass/);
  assert.match(summary, /\| alpha \| \*\*PASS\*\*/);
  const gatewayLog = await readFile(
    path.join(out, "gateway-alpha.log"),
    "utf8",
  );
  assert.match(gatewayLog, /"vendorKeys":\[\]/);
  assert.match(gatewayLog, /\[REDACTED\]/);
  for (const name of await readdir(out)) {
    if (!/\.(log|json|jsonl|md)$/.test(name)) continue;
    const text = await readFile(path.join(out, name), "utf8");
    assert.doesNotMatch(text, /hh-mock-[0-9a-f]{20}/, name);
    assert.doesNotMatch(text, /sk-vendor-should-never-leak/, name);
  }
});

test("engines with identical conversations sharing one mock each complete the tool round", async (t) => {
  const { bundle, entry } = await fakeBundle(t);
  const out = await temporary(t, "hh-matrix-shared-");
  const engines = ["alpha", "beta", "gamma", "delta"];
  const result = await runMatrix({
    bundle,
    entry,
    engines,
    out,
    mock: true,
    engineTimeoutMs: 90_000,
    env: { ...process.env },
  });
  assert.deepEqual(
    result.engines.map((engine) => [engine.engine, engine.status]),
    engines.map((engine) => [engine, "PASS"]),
  );
  const turns = (await readFile(path.join(out, "mock-requests.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line).turn);
  assert.equal(turns.filter((turn) => turn === "tool-call").length, 4);
  assert.equal(turns.includes("tool-loop-stopped"), false);
});

test("process helpers scrub vendor credentials, redact secrets, decode Windows text and quote batch launchers", () => {
  const env = {
    PATH: "x",
    OPENAI_API_KEY: "a",
    ANTHROPIC_AUTH_TOKEN: "b",
    GOOGLE_API_KEY: "c",
    HARNESSHUB_MODEL_API_KEY: "keep",
    DEEPSEEK_API_KEY: "d",
    HOME: "h",
  };
  assert.deepEqual(vendorCredentialNames(env), [
    "ANTHROPIC_AUTH_TOKEN",
    "DEEPSEEK_API_KEY",
    "GOOGLE_API_KEY",
    "OPENAI_API_KEY",
  ]);
  assert.deepEqual(Object.keys(withoutVendorCredentials(env)).sort(), [
    "HARNESSHUB_MODEL_API_KEY",
    "HOME",
    "PATH",
  ]);
  const redact = redactor(["super-secret-value"]);
  assert.equal(
    redact("a super-secret-value b Bearer abcdefghijkl sk-abcdefghijklmnop"),
    "a [REDACTED] b Bearer [REDACTED] sk-[REDACTED]",
  );
  assert.equal(
    decodeText(Buffer.from("\ufeffmock-ok\r\n", "utf16le")).trim(),
    "mock-ok",
  );
  assert.equal(decodeText(Buffer.from([0xef, 0xbb, 0xbf, 0x6f, 0x6b])), "ok");
  const launch = launcherCommand(
    "C:\\HH kit\\competition\\gateway.cmd",
    ["--port", "6217"],
    "win32",
  );
  assert.equal(launch.windowsVerbatimArguments, true);
  assert.deepEqual(launch.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.equal(
    launch.args[3],
    '""C:\\HH kit\\competition\\gateway.cmd" --port 6217"',
  );
  assert.throws(
    () => launcherCommand("C:\\a\\gateway.cmd", ["x&y"], "win32"),
    /cannot pass safely/,
  );
  assert.throws(
    () => launcherCommand("/tmp/gateway.cmd", [], "linux"),
    /requires Windows/,
  );
});
