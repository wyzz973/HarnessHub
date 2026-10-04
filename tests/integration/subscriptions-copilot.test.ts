// SPDX-License-Identifier: MIT
/**
 * GitHub Copilot accounts through the daemon: the real Copilot host process
 * and its JSON-line protocol, with a fake Copilot SDK add-on in a temporary
 * directory in place of GitHub's (which would start a real Copilot CLI).
 * Tokens are synthetic; nothing reads a real Copilot sign-in.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startHub } from "@harnesshub/daemon/main";
import { HarnessHubError } from "@harnesshub/sdk/client";
import { connectLocal } from "@harnesshub/sdk/local";
import { HH_ENTRY } from "../support/entries.js";
import { temporaryDirectory } from "../support/temporary.js";

const TOKEN = `github_pat_${"synthetic0".repeat(5)}`;

/**
 * A stand-in for `@github/copilot-sdk`: the surface the host uses, a
 * logged-in user `octocat` (or `token-user` for {@link TOKEN}), one enabled
 * and one disabled model, a quota report, and sessions that echo prompts or
 * call `get_weather`. Every call is appended to `<package>/calls.jsonl`.
 */
const FAKE_SDK = String.raw`
import { appendFileSync } from "node:fs";
const LOG = new URL("../calls.jsonl", import.meta.url);
const log = (entry) => appendFileSync(LOG, JSON.stringify(entry) + "\n");
const TOKEN = ${JSON.stringify(TOKEN)};
export const RuntimeConnection = {
  forStdio: (options) => ({ kind: "stdio", ...options }),
};
class FakeSession {
  constructor(config) {
    this.sessionId = "session-" + Math.random().toString(36).slice(2);
    this.config = config;
    this.handlers = [];
  }
  on(handler) {
    this.handlers.push(handler);
    return () => undefined;
  }
  emit(type, data) {
    for (const handler of this.handlers)
      handler({ id: "e", parentId: null, timestamp: new Date().toISOString(), type, data });
  }
  finish(text) {
    this.emit("assistant.message_delta", { messageId: "m", deltaContent: text });
    this.emit("assistant.message", { messageId: "m", content: text });
    this.emit("assistant.usage", { model: "gpt-5", inputTokens: 20, outputTokens: 4 });
    this.emit("session.idle", {});
  }
  async send(options) {
    log({ method: "send", prompt: options.prompt });
    setImmediate(() => {
      if (/weather/.test(options.prompt) && this.config.tools.length) {
        this.emit("assistant.message", {
          messageId: "m",
          content: "",
          toolRequests: [{ toolCallId: "call_1", name: "get_weather", arguments: { city: "Paris" } }],
        });
        this.emit("external_tool.requested", {
          requestId: "request-1",
          sessionId: this.sessionId,
          toolCallId: "call_1",
          toolName: "get_weather",
          arguments: { city: "Paris" },
        });
        return;
      }
      this.finish("Echo: " + options.prompt);
    });
    return "message-1";
  }
  get rpc() {
    return {
      tools: {
        handlePendingToolCall: async (params) => {
          log({ method: "handlePendingToolCall", ...params });
          setImmediate(() => this.finish("Weather: " + params.result));
          return { success: true };
        },
      },
    };
  }
  async abort() {
    log({ method: "abort" });
    this.emit("session.idle", { aborted: true });
  }
  async disconnect() {
    log({ method: "disconnect" });
  }
}
export class CopilotClient {
  constructor(options) {
    this.options = options;
    log({
      method: "constructor",
      mode: options.mode,
      cli: options.connection.path,
      token: options.gitHubToken === undefined ? "none" : options.gitHubToken === TOKEN ? "given" : "other",
      home: options.baseDirectory !== undefined,
    });
  }
  async start() {
    log({ method: "start" });
  }
  async stop() {
    log({ method: "stop" });
    return [];
  }
  async getAuthStatus() {
    if (this.options.gitHubToken !== undefined)
      return this.options.gitHubToken === TOKEN
        ? { isAuthenticated: true, authType: "token", login: "token-user", host: "https://github.com" }
        : { isAuthenticated: false, statusMessage: "Bad credentials" };
    return { isAuthenticated: true, authType: "user", login: "octocat", host: "https://github.com" };
  }
  async listModels() {
    return [
      {
        id: "gpt-5",
        name: "GPT-5",
        capabilities: {
          supports: { vision: true, reasoningEffort: true },
          limits: { max_context_window_tokens: 200000, max_output_tokens: 64000 },
        },
        policy: { state: "enabled", terms: "" },
      },
      {
        id: "disabled-model",
        name: "Disabled",
        capabilities: { supports: { vision: false, reasoningEffort: false }, limits: { max_context_window_tokens: 1000 } },
        policy: { state: "disabled", terms: "" },
      },
    ];
  }
  get rpc() {
    return {
      account: {
        getQuota: async () => (log({ method: "getQuota", token: this.options.gitHubToken !== undefined }), {
          quotaSnapshots: {
            premium_interactions: {
              isUnlimitedEntitlement: false,
              entitlementRequests: 300,
              usedRequests: 75,
              usageAllowedWithExhaustedQuota: false,
              remainingPercentage: 75,
              overage: 0,
              overageAllowedWithExhaustedQuota: false,
              resetDate: "2026-11-01T00:00:00.000Z",
            },
            chat: { isUnlimitedEntitlement: true, remainingPercentage: 100 },
          },
        }),
      },
    };
  }
  async createSession(config) {
    log({
      method: "createSession",
      clientName: config.clientName,
      model: config.model,
      systemMessage: config.systemMessage,
      availableTools: config.availableTools,
      tools: config.tools.map((tool) => ({ name: tool.name, skipPermission: tool.skipPermission })),
      permission: (await config.onPermissionRequest({}, { sessionId: "x" })).kind,
    });
    return new FakeSession(config);
  }
}
`;

/** The fake add-on and a placeholder CLI below `directory`. */
async function fakeCopilot(directory: string) {
  const addon = path.join(directory, "addon");
  const root = path.join(addon, "node_modules", "@github", "copilot-sdk");
  await mkdir(path.join(root, "dist"), { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "@github/copilot-sdk",
      version: "1.0.16",
      type: "module",
      exports: { ".": { import: { default: "./dist/index.js" } } },
    }),
  );
  await writeFile(path.join(root, "dist", "index.js"), FAKE_SDK);
  const cli = path.join(directory, "bin", "copilot");
  await mkdir(path.dirname(cli), { recursive: true });
  await writeFile(cli, "#!/bin/sh\nexit 1\n");
  await chmod(cli, 0o755);
  const calls = async () =>
    (await readFile(path.join(root, "calls.jsonl"), "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { addon, cli, calls };
}

void test(
  "a Copilot account signs in with the CLI's login or a token, lists models, answers with tools, and signs out",
  { timeout: 120_000 },
  async (t) => {
    const { directory, defer } = await temporaryDirectory(t, "hh-copilot-");
    const fake = await fakeCopilot(directory);
    const dataDir = path.join(directory, "data");
    const hub = await startHub({
      dataDir,
      configDir: path.join(directory, "config"),
      secretsBackend: "file",
      demo: true,
      cwd: directory,
      port: 0,
      host: "127.0.0.1",
      copilot: { cli: fake.cli, addon: fake.addon },
    });
    let closed = false;
    defer(() => (closed ? undefined : hub.server.close()));
    const client = await connectLocal({ dataDir, url: hub.url });

    const setup = await client.subscriptions.copilotSetup();
    assert.equal(setup.sdkVersion, "1.0.16");
    assert.equal(setup.cliPath, fake.cli);
    assert.match(
      setup.installCommand,
      /^npm install --prefix \S+ --omit=optional --no-audit --no-fund @github\/copilot-sdk@1\.0\.16$/,
    );
    const notice = (await client.subscriptions.notices()).items.find(
      (item) => item.backend === "copilot",
    )!;
    assert.match(notice.text, /this computer/);
    await assert.rejects(
      client.subscriptions.startSignIn({
        backend: "copilot",
        acceptNotice: "siwc-2026-10-04",
      }),
      (error: unknown) =>
        error instanceof HarnessHubError &&
        error.code === "SUBSCRIPTION_NOTICE_NOT_ACCEPTED",
    );

    // The CLI's own login: Copilot reports who it is.
    const login = await client.subscriptions.startSignIn({
      backend: "copilot",
      acceptNotice: notice.version,
    });
    assert.deepEqual(
      [
        login.status,
        login.provider,
        login.credential,
        login.login,
        login.firstSignIn,
      ],
      ["succeeded", "copilot", "account-1", "octocat", true],
    );
    const provider = await client.providers.get("copilot");
    assert.deepEqual(provider.subscription, { backend: "copilot" });
    assert.deepEqual(provider.endpoints, {});
    assert.deepEqual(provider.credentials[0]?.account, {
      backend: "copilot",
      subject: "octocat",
      host: "https://github.com",
      auth: "login",
      consent: {
        notice: notice.version,
        acceptedAt: provider.credentials[0]!.account!.consent.acceptedAt,
      },
    });

    // A token must be fine-grained and accepted by GitHub.
    await assert.rejects(
      client.subscriptions.startSignIn({
        backend: "copilot",
        acceptNotice: notice.version,
        auth: "token",
        token: "ghp_classic0000000000000000000000000000",
      }),
      (error: unknown) =>
        error instanceof HarnessHubError &&
        error.code === "COPILOT_TOKEN_INVALID",
    );
    const rejected = await client.subscriptions.startSignIn({
      backend: "copilot",
      acceptNotice: notice.version,
      token: `github_pat_${"unknown000".repeat(5)}`,
    });
    assert.deepEqual(
      [rejected.status, rejected.error],
      ["failed", "GitHub did not accept the token for Copilot"],
    );
    const viaToken = await client.subscriptions.startSignIn({
      backend: "copilot",
      acceptNotice: notice.version,
      auth: "token",
      token: TOKEN,
    });
    assert.deepEqual(
      [viaToken.status, viaToken.credential, viaToken.login],
      ["succeeded", "account-2", "token-user"],
    );
    assert.deepEqual(
      (await client.subscriptions.signIn(viaToken.id)).status,
      "succeeded",
    );
    assert.ok(
      !JSON.stringify(await client.providers.get("copilot")).includes(TOKEN),
      "the token stays in the secret store",
    );
    const started = (await fake.calls()).filter(
      (call) => call.method === "constructor",
    );
    assert.deepEqual(
      started.map((call) => [call.mode, call.token, call.home]),
      [
        ["copilot-cli", "none", false],
        ["empty", "other", true],
        ["empty", "given", true],
      ],
    );
    assert.ok(started.every((call) => call.cli === fake.cli));

    // Models come from the account's Copilot client; disabled ones are left out.
    const listed = await client.providers.refreshModels("copilot");
    assert.deepEqual(
      listed.models.list.map((model) => model.id),
      ["gpt-5"],
    );

    const { key } = await client.gatewayKeys.create({
      name: "copilot",
      modelAllow: ["copilot/*"],
    });
    const call = (body: Record<string, unknown>) =>
      fetch(`${hub.url}/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "copilot/gpt-5", ...body }),
      }).then(async (response) => ({
        status: response.status,
        body: (await response.json()) as {
          choices: {
            finish_reason: string;
            message: {
              content: string | null;
              tool_calls?: {
                id: string;
                function: { name: string; arguments: string };
              }[];
            };
          }[];
        },
      }));
    const echo = await call({ messages: [{ role: "user", content: "hi" }] });
    assert.equal(echo.status, 200);
    assert.equal(echo.body.choices[0]!.message.content, "Echo: hi");

    const tools = [
      {
        type: "function",
        function: {
          name: "get_weather",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
          },
        },
      },
    ];
    const asked = [
      { role: "system", content: "Be brief." },
      { role: "user", content: "What is the weather?" },
    ];
    const first = await call({ tools, messages: asked });
    assert.equal(first.status, 200);
    assert.equal(first.body.choices[0]!.finish_reason, "tool_calls");
    const toolCall = first.body.choices[0]!.message.tool_calls![0]!;
    assert.deepEqual(
      [
        toolCall.id,
        toolCall.function.name,
        JSON.parse(toolCall.function.arguments),
      ],
      ["call_1", "get_weather", { city: "Paris" }],
    );
    const second = await call({
      tools,
      messages: [
        ...asked,
        {
          role: "assistant",
          content: null,
          tool_calls: [{ ...toolCall, type: "function" }],
        },
        { role: "tool", tool_call_id: "call_1", content: "22C" },
      ],
    });
    assert.equal(second.status, 200);
    assert.equal(second.body.choices[0]!.message.content, "Weather: 22C");
    const calls = await fake.calls();
    const sessions = calls.filter((item) => item.method === "createSession");
    assert.equal(sessions.length, 2, "the tool result continued its session");
    assert.deepEqual(sessions[1], {
      method: "createSession",
      clientName: "HarnessHub",
      model: "gpt-5",
      systemMessage: { mode: "replace", content: "Be brief." },
      availableTools: ["get_weather"],
      tools: [{ name: "get_weather", skipPermission: true }],
      permission: "denied-no-approval-rule-and-could-not-request-from-user",
    });
    assert.deepEqual(
      calls.find((item) => item.method === "handlePendingToolCall"),
      {
        method: "handlePendingToolCall",
        requestId: "request-1",
        result: "22C",
      },
    );

    // Signed out, the login account stops serving; the token account answers.
    assert.deepEqual(
      await client.subscriptions.signOut("copilot", "account-1"),
      { revoked: false },
    );
    const accounts = await client.subscriptions.accounts();
    assert.deepEqual(
      accounts.items.map((item) => [
        item.credential,
        item.login,
        item.auth,
        item.usable,
      ]),
      [
        ["account-1", "octocat", "login", false],
        ["account-2", "token-user", "token", true],
      ],
    );
    const after = await call({
      messages: [{ role: "user", content: "still?" }],
    });
    assert.equal(after.status, 200);
    assert.equal(after.body.choices[0]!.message.content, "Echo: still?");

    // Each account's quota after its first answer becomes its reading.
    for (let tries = 0; ; tries++) {
      const read = (await fake.calls()).filter(
        (item) => item.method === "getQuota",
      );
      if (read.length === 2) break;
      assert.ok(tries < 500, "both accounts read their quota");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // Deleting the token account stops its host and removes its token.
    await client.credentials.remove("copilot", "account-2");
    await hub.server.close();
    closed = true;
    const stops = (await fake.calls()).filter((item) => item.method === "stop");
    assert.ok(stops.length >= 4, "every host stopped its client");
    const readings = JSON.parse(
      await readFile(path.join(dataDir, "allowance-readings.json"), "utf8"),
    ) as {
      readings: {
        provider: string;
        credential: string;
        reading: { window: string; usedPercent: number; resetsAt: string };
      }[];
    };
    assert.deepEqual(
      readings.readings.map((item) => [
        item.provider,
        item.credential,
        item.reading.window,
        item.reading.usedPercent,
        item.reading.resetsAt,
      ]),
      ["account-1", "account-2"].map((credential) => [
        "copilot",
        credential,
        "premium_interactions",
        25,
        "2026-11-01T00:00:00.000Z",
      ]),
    );
  },
);

/** The real `hh` launcher with piped stdin (never interactive). */
function hh(
  cwd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(HH_ENTRY), ...args], {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    child.stdin.end();
  });
}

void test(
  "hh subscription setup and login copilot report the add-on and sign in with the CLI's login or a token file",
  { timeout: 120_000 },
  async (t) => {
    const { directory, defer } = await temporaryDirectory(t, "hh-copilot-cli-");
    const fake = await fakeCopilot(directory);
    const dataDir = path.join(directory, "data");
    const hub = await startHub({
      dataDir,
      configDir: path.join(directory, "config"),
      secretsBackend: "file",
      demo: true,
      cwd: directory,
      port: 0,
      host: "127.0.0.1",
      copilot: { cli: fake.cli, addon: fake.addon },
    });
    defer(() => hub.server.close());
    const daemon = ["--url", hub.url, "--data-dir", dataDir];
    const setup = await hh(directory, [
      "subscription",
      "setup",
      "copilot",
      ...daemon,
    ]);
    assert.equal(setup.code, 0, setup.stderr);
    assert.match(setup.stdout, /Copilot SDK 1\.0\.16 is installed/);
    assert.match(setup.stdout, /Next: hh subscription login copilot/);
    // Without a terminal or --accept-notice nothing starts.
    const refused = await hh(directory, [
      "subscription",
      "login",
      "copilot",
      ...daemon,
    ]);
    assert.equal(refused.code, 4, refused.stderr);
    assert.match(refused.stderr, /Use your GitHub Copilot plan/);
    const login = await hh(directory, [
      "subscription",
      "login",
      "copilot",
      "--accept-notice",
      ...daemon,
    ]);
    assert.equal(login.code, 0, login.stderr);
    assert.match(
      login.stdout,
      /You're using your GitHub Copilot plan as octocat\./,
    );
    assert.match(login.stdout, /1 models listed for copilot/);
    const tokenFile = path.join(directory, "token.txt");
    await writeFile(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
    const viaToken = await hh(directory, [
      "subscription",
      "login",
      "copilot",
      "--accept-notice",
      "--token-from-file",
      tokenFile,
      ...daemon,
    ]);
    assert.equal(viaToken.code, 0, viaToken.stderr);
    assert.match(viaToken.stdout, /as token-user/);
    assert.ok(
      !viaToken.stdout.includes(TOKEN) && !viaToken.stderr.includes(TOKEN),
    );
    const listed = await hh(directory, ["subscription", "list", ...daemon]);
    assert.equal(listed.code, 0, listed.stderr);
    assert.match(
      listed.stdout,
      /copilot\s+account-1\s+octocat \(Copilot CLI login\)\s+usable/,
    );
    assert.match(
      listed.stdout,
      /copilot\s+account-2\s+token-user \(token\)\s+usable/,
    );
    const out = await hh(directory, [
      "subscription",
      "logout",
      "copilot",
      "account-2",
      "--yes",
      ...daemon,
    ]);
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, /stays valid at GitHub until you revoke it there/);
  },
);
