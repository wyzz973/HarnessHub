import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type IncomingMessage } from "node:http";
import { once } from "node:events";
import {
  mkdtemp,
  readFile,
  realpath,
  writeFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { startHub } from "../../src/main.js";
import type {
  AgentEvent,
  RunRecord,
  SessionRecord,
} from "../../src/domain/types.js";
import type { HubApplication } from "../../src/application/service.js";
import { ensurePrivateDirectory } from "../../src/platform/windows-acl.js";
import { startModelGateway } from "../../src/drivers/chat-completions/gateway.js";
import { writePrivateSecretFile } from "../fixtures/private-secret-file.js";

type Hub = Awaited<ReturnType<typeof startHub>>;
type RunView = ReturnType<HubApplication["getRun"]>;

function client(hub: Hub) {
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
  async function terminal(id: string, optionId = "write-once") {
    let run = await json<RunView>(`/v1/runs/${id}`);
    const end = Date.now() + 15000;
    while (!run.finishedAt) {
      assert.ok(Date.now() < end, "Run did not settle");
      for (const permission of run.permissions.filter(
        (p) => p.status === "pending",
      ))
        await json(`/v1/permissions/${permission.id}/decision`, { optionId });
      await delay(10);
      run = await json<RunView>(`/v1/runs/${id}`);
    }
    return run;
  }
  async function run(sessionId: string, text: string, extra = {}) {
    const accepted = await json<RunRecord>(`/v1/sessions/${sessionId}/runs`, {
      text,
      timeoutMs: 12000,
      ...extra,
    });
    return terminal(accepted.id);
  }
  return { json, terminal, run };
}

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

void test(
  "model gateway routes Chat engines to one upstream model, commits model.call events and fails explicitly on upstream errors",
  { timeout: 60000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "hh-model-gateway-"));
    const companyKey = "synthetic-company-gateway-key-0123456789";
    const vendorKey = "sk-vendor-key-that-must-not-reach-engines";
    const saved = {
      company: process.env.HH_GATEWAY_FIXTURE_COMPANY_KEY,
      vendor: process.env.OPENAI_API_KEY,
    };
    // The Gateway snapshots its environment for Workers when it starts.
    process.env.HH_GATEWAY_FIXTURE_COMPANY_KEY = companyKey;
    process.env.OPENAI_API_KEY = vendorKey;
    let hub: Hub | undefined;
    const started = Promise.withResolvers<void>(),
      disconnected = Promise.withResolvers<void>();
    const requests: {
      path: string | undefined;
      authorization: string | undefined;
      tenant: string | undefined;
      model: string;
      skill: boolean;
      mcp: boolean;
      toolResult: boolean;
    }[] = [];
    const upstream = createServer((request, response) => {
      void (async () => {
        const text = await body(request);
        const parsed = JSON.parse(text) as {
          model: string;
          messages: { role: string; content?: string }[];
        };
        const toolResult = parsed.messages.some((m) => m.role === "tool");
        requests.push({
          path: request.url,
          authorization: request.headers.authorization,
          tenant: request.headers["x-tenant"] as string | undefined,
          model: parsed.model,
          skill: text.includes("gateway skill instruction"),
          mcp: text.includes("MCP_COUNT=1"),
          toolResult,
        });
        if (text.includes("REJECT_PARAMETERS")) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              error: {
                message: `Unsupported parameter: stream_options (key ${companyKey})`,
                type: "invalid_request_error",
              },
            }),
          );
          return;
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        if (text.includes("CANCEL_BARRIER")) {
          response.once("close", () => disconnected.resolve());
          response.write(
            'data: {"choices":[{"index":0,"delta":{"content":"waiting"},"finish_reason":null}]}\n\n',
          );
          started.resolve();
          return;
        }
        const delta = toolResult
          ? { content: "GATEWAY_TOOL_DONE" }
          : text.includes("USE_TOOL")
            ? {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_write",
                    type: "function",
                    function: {
                      name: "fixture_write",
                      arguments: '{"text":"精确产物"}',
                    },
                  },
                ],
              }
            : { content: "GATEWAY_OK" };
        response.write(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: "tool_calls" in delta ? "tool_calls" : "stop" }] })}\n\n`,
        );
        response.end("data: [DONE]\n\n");
      })().catch(() => response.destroy());
    });
    t.after(async () => {
      await hub?.server.close();
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      if (saved.company === undefined)
        delete process.env.HH_GATEWAY_FIXTURE_COMPANY_KEY;
      else process.env.HH_GATEWAY_FIXTURE_COMPANY_KEY = saved.company;
      if (saved.vendor === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = saved.vendor;
      await rm(root, { recursive: true, force: true });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const address = upstream.address();
    assert.ok(address && typeof address !== "string");
    const skill = join(root, "SKILL.md");
    if (process.platform === "win32") await ensurePrivateDirectory(root);
    await writeFile(skill, "gateway skill instruction");
    const dataDir = join(root, "data");
    hub = await startHub({ cwd: root, dataDir, demo: false, port: 0 });
    const { json, run } = client(hub);
    const peer = fileURLToPath(
      new URL("../fixtures/model-gateway-peer.js", import.meta.url),
    );
    const outputs = (adapter: string) => ({
      outputs: [
        {
          path: `${adapter}-proof.txt`,
          name: "proof",
          mediaType: "text/plain",
        },
      ],
    });
    const runIds: string[] = [];
    for (const adapter of ["opencode", "qwen", "pi"] as const) {
      await json("/v1/engines", {
        id: adapter,
        driver: "acp",
        command: [process.execPath, peer, adapter],
        model: "company-real-model",
        credentialEnv: ["OPENAI_API_KEY"],
        configuration: {
          adapter,
          provider: {
            protocol: "openai-completions",
            baseUrl: `http://127.0.0.1:${address.port}/company/v1`,
            apiKey: { kind: "env", value: "HH_GATEWAY_FIXTURE_COMPANY_KEY" },
            headers: { "X-Tenant": "contest" },
            contextWindow: 65536,
            maxOutputTokens: 8192,
          },
          skills: [{ path: skill, enabled: true }],
          ...(adapter === "pi"
            ? {}
            : {
                mcpServers: [
                  {
                    // Forwarded over ACP only; the fixture never starts it.
                    name: "files",
                    type: "stdio",
                    command: process.execPath,
                    args: [
                      "mcp.js",
                      "--root",
                      "${HARNESSHUB_SESSION_WORKSPACE}",
                    ],
                    enabled: true,
                  },
                ],
              }),
        },
      });
      const session = await json<SessionRecord>("/v1/sessions", {
        engineId: adapter,
      });
      const completed = await run(
        session.id,
        "USE_TOOL please",
        outputs(adapter),
      );
      assert.equal(
        completed.status,
        "completed",
        JSON.stringify(completed.error),
      );
      assert.equal(completed.output, "GATEWAY_TOOL_DONE");
      assert.equal(completed.permissions[0]?.status, "applied");
      assert.equal(completed.artifacts.length, 1);
      const artifact: { bytes: Buffer } = await hub.app.artifact(
        completed.artifacts[0]!.id,
      );
      assert.equal(artifact.bytes.toString(), "精确产物");
      runIds.push(completed.id);
      const calls: AgentEvent[] = hub.app
        .events(completed.id, 0, 1000)
        .filter((event) => event.type === "model.call");
      assert.equal(calls.length, 2);
      for (const call of calls) {
        assert.equal(call.data.inbound, "openai-completions");
        assert.equal(call.data.ok, true);
        assert.equal(call.data.status, 200);
        assert.equal(call.data.upstreamModel, "company-real-model");
        assert.equal(call.data.requestedModel, "harnesshub-model");
      }

      if (adapter === "opencode") {
        const cancelled = await json<RunRecord>(
          `/v1/sessions/${session.id}/runs`,
          { text: "CANCEL_BARRIER", timeoutMs: 12000 },
        );
        await started.promise;
        await json(`/v1/runs/${cancelled.id}/cancel`, {});
        const result = await client(hub).terminal(cancelled.id);
        assert.equal(result.status, "cancelled");
        assert.equal(result.cleanupStatus, "confirmed");
        await disconnected.promise;
      }
      await json(`/v1/sessions/${session.id}/close`, {});

      // A rejected upstream request ends the engine turn without text; the
      // Worker reports the real upstream cause instead of an empty success.
      const rejectedSession = await json<SessionRecord>("/v1/sessions", {
        engineId: adapter,
      });
      const rejected = await run(rejectedSession.id, "REJECT_PARAMETERS");
      assert.equal(rejected.status, "failed");
      assert.equal(rejected.error?.code, "MODEL_UPSTREAM_ERROR");
      assert.match(rejected.error?.message ?? "", /HTTP 400/);
      assert.match(
        rejected.error?.message ?? "",
        /Unsupported parameter: stream_options/,
      );
      assert.equal(rejected.error?.message.includes(companyKey), false);
      const failedCall: AgentEvent | undefined = hub.app
        .events(rejected.id, 0, 1000)
        .find((event) => event.type === "model.call");
      assert.equal(failedCall?.data.ok, false);
      assert.equal(failedCall?.data.status, 400);
      runIds.push(rejected.id);
      await json(`/v1/sessions/${rejectedSession.id}/close`, {});

      const silentSession = await json<SessionRecord>("/v1/sessions", {
        engineId: adapter,
      });
      const silent = await run(silentSession.id, "NO_MODEL");
      assert.equal(silent.status, "failed");
      assert.equal(silent.error?.code, "ENGINE_NO_OUTPUT");
      assert.equal(silent.error?.message, "引擎未调用模型也未产生输出");
      await json(`/v1/sessions/${silentSession.id}/close`, {});
    }

    // Unified routing: every engine reached only the configured upstream
    // model, with the company key, the configured header, and its Skill/MCP.
    assert.ok(requests.length >= 10);
    for (const request of requests) {
      assert.equal(request.path, "/company/v1/chat/completions");
      assert.equal(request.authorization, `Bearer ${companyKey}`);
      assert.equal(request.tenant, "contest");
      assert.equal(request.model, "company-real-model");
    }
    assert.ok(requests.filter((r) => r.skill).length >= 6);
    assert.equal(requests.filter((r) => r.toolResult).length, 3);

    // Engines saw only the loopback gateway, its local token and the alias;
    // no vendor or upstream credential reached their environment.
    const reports = (await readdir(root)).filter((file) =>
      /^gateway-peer-.*\.json$/.test(file),
    );
    assert.ok(reports.length >= 9);
    const tokens = new Set<string>();
    const backends = join(await realpath(dataDir), "backends");
    for (const file of reports) {
      const report = JSON.parse(await readFile(join(root, file), "utf8")) as {
        adapter: string;
        pid: number;
        url: string;
        token: string;
        model: string;
        home: string;
        env: string[];
        mcp: string[][];
      };
      assert.match(report.url, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
      assert.equal(report.model, "harnesshub-model");
      assert.notEqual(report.token, companyKey);
      assert.notEqual(report.token, vendorKey);
      assert.equal(report.home.startsWith(backends), true, report.home);
      assert.equal(
        report.env.includes("HH_GATEWAY_FIXTURE_COMPANY_KEY"),
        false,
      );
      // Qwen's native key variable carries the local token; others get none.
      if (report.adapter !== "qwen")
        assert.equal(report.env.includes("OPENAI_API_KEY"), false);
      // The Session workspace replaces the placeholder at run time only.
      assert.deepEqual(
        report.mcp,
        report.adapter === "pi"
          ? []
          : [[process.execPath, "mcp.js", "--root", await realpath(root)]],
      );
      tokens.add(report.token);
      await assert.rejects(fetch(report.url.replace(/\/v1$/, "")));
      assert.throws(() => process.kill(report.pid, 0), { code: "ESRCH" });
    }
    assert.equal(tokens.size, reports.length);

    await hub.server.close();
    hub = undefined;
    const database = await readFile(join(dataDir, "harnesshub.sqlite"));
    for (const secret of [companyKey, vendorKey, ...tokens])
      assert.equal(database.includes(Buffer.from(secret)), false, secret);
  },
);

void test(
  "unexpected engine errors publish their redacted real cause and keep the full stack in the Session diagnostic log",
  { timeout: 30000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "hh-worker-errors-"));
    let hub: Hub | undefined;
    t.after(async () => {
      await hub?.server.close();
      await rm(root, { recursive: true, force: true });
    });
    if (process.platform === "win32") await ensurePrivateDirectory(root);
    const dataDir = join(root, "data");
    hub = await startHub({ cwd: root, dataDir, demo: false, port: 0 });
    const { json, run } = client(hub);
    await json("/v1/engines", {
      id: "auth-failure",
      driver: "acp",
      command: [
        process.execPath,
        fileURLToPath(
          new URL("../fixtures/model-gateway-peer.js", import.meta.url),
        ),
        "auth-failure",
      ],
      model: "company-real-model",
      configuration: {
        adapter: "opencode",
        provider: {
          protocol: "openai-completions",
          baseUrl: "http://127.0.0.1:1/v1",
        },
      },
    });
    const session = await json<SessionRecord>("/v1/sessions", {
      engineId: "auth-failure",
    });
    const result = await run(session.id, "hello");
    assert.equal(result.status, "failed");
    assert.equal(result.error?.code, "DRIVER_ERROR");
    const message = result.error?.message ?? "";
    assert.match(message, /Authentication required/);
    assert.match(message, /fixture engine has no native login/);
    assert.ok(Array.from(message).length <= 500);
    assert.doesNotMatch(message, /inspect the local engine configuration/);
    const log = join(
      dataDir,
      "backends",
      session.id,
      "diagnostics",
      "worker-errors.log",
    );
    const text = await readFile(log, "utf8");
    assert.match(text, new RegExp(`run=${result.id}`));
    assert.match(text, /Authentication required/);
    assert.match(text, /\n\s+at /);
    if (process.platform !== "win32")
      assert.equal((await stat(log)).mode & 0o777, 0o600);
  },
);

void test(
  "Codex and Gemini native protocols reach the Chat upstream through the gateway with MCP, Skills, permissions and cancellation",
  { timeout: 30000 },
  async (t) => {
    // The formal gateway implements Responses and Google inbound routes. The
    // temporary Chat-only stub answers 501; skip explicitly in that case.
    const probe = await startModelGateway({
      upstream: {
        protocol: "openai-completions",
        baseUrl: "http://127.0.0.1:1",
      },
      model: "probe",
      alias: "probe",
    });
    const supported = await fetch(`${probe.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${probe.token}` },
      body: "{}",
    });
    await supported.body?.cancel();
    await probe.close();
    if (supported.status === 501) {
      t.skip(
        "model gateway without Responses/Google inbound support (temporary stub)",
      );
      return;
    }
    const root = await mkdtemp(join(tmpdir(), "hh-chat-bridge-"));
    let hub: Hub | undefined;
    const started = Promise.withResolvers<void>(),
      disconnected = Promise.withResolvers<void>();
    const requests: {
      path: string | undefined;
      key: boolean;
      skill: boolean;
      mcp: boolean;
      toolResult: boolean;
    }[] = [];
    const server = createServer((request, response) => {
      void (async () => {
        const serialized = await body(request);
        const parsed = JSON.parse(serialized) as {
          model: string;
          messages: { role: string; content?: string }[];
        };
        requests.push({
          path: request.url,
          key:
            request.headers.authorization ===
            "Bearer synthetic-bridge-integration-key",
          skill: serialized.includes("bridge skill instruction"),
          mcp: serialized.includes("MCP_COUNT=1"),
          toolResult: parsed.messages.some(
            (message) => message.role === "tool",
          ),
        });
        assert.equal(parsed.model, "fixture");
        response.writeHead(200, { "content-type": "text/event-stream" });
        if (serialized.includes("CANCEL_BARRIER")) {
          response.once("close", () => disconnected.resolve());
          response.write(
            'data: {"choices":[{"index":0,"delta":{"content":"waiting"},"finish_reason":null}]}\n\n',
          );
          started.resolve();
          return;
        }
        const tool = parsed.messages.some((message) => message.role === "tool");
        response.write(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: tool ? { content: "BRIDGE_TOOL_DONE" } : { tool_calls: [{ index: 0, id: "call_write", type: "function", function: { name: "fixture_write", arguments: '{"text":"精确产物"}' } }] }, finish_reason: tool ? "stop" : "tool_calls" }] })}\n\n`,
        );
        response.end("data: [DONE]\n\n");
      })().catch(() => {
        response.destroy();
      });
    });
    t.after(async () => {
      await hub?.server.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const key = join(root, "fixture.key"),
      skill = join(root, "SKILL.md");
    if (process.platform === "win32") await ensurePrivateDirectory(root);
    await writePrivateSecretFile(key, "synthetic-bridge-integration-key");
    await writeFile(skill, "bridge skill instruction");
    hub = await startHub({
      cwd: root,
      dataDir: join(root, "data"),
      demo: false,
      port: 0,
    });
    const { json, terminal } = client(hub);
    for (const adapter of ["codex", "gemini"] as const) {
      await json("/v1/engines", {
        id: adapter,
        driver: "acp",
        command: [
          process.execPath,
          fileURLToPath(
            new URL("../fixtures/chat-bridge-peer.js", import.meta.url),
          ),
          adapter,
        ],
        model: "fixture",
        configuration: {
          adapter,
          provider: {
            protocol: "openai-completions",
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            apiKey: { kind: "file", value: key },
            // The fixture peer addresses the model by this engine-visible id.
            modelAlias: "fixture",
          },
          skills: [{ path: skill, enabled: true }],
          mcpServers: [
            {
              name: "files",
              type: "http",
              url: "http://127.0.0.1:1/mcp",
              enabled: true,
            },
          ],
        },
      });
      const check = await json<{ checks: { status: string }[] }>(
        `/v1/engines/${adapter}/test`,
        {},
      );
      assert.ok(
        check.checks.every((c) => c.status === "passed"),
        JSON.stringify(check),
      );
      const session = await json<SessionRecord>("/v1/sessions", {
        engineId: adapter,
      });
      for (let i = 0; i < 2; i++) {
        const accepted = await json<RunRecord>(
          `/v1/sessions/${session.id}/runs`,
          {
            text: "Use tools",
            timeoutMs: 10000,
            outputs: [
              {
                path: `${adapter}-proof.txt`,
                name: "proof",
                mediaType: "text/plain",
              },
            ],
          },
        );
        const run = await terminal(accepted.id);
        assert.equal(run.status, "completed", JSON.stringify(run.error));
        assert.equal(run.output, "BRIDGE_TOOL_DONE");
        assert.equal(run.cleanupStatus, "confirmed");
        assert.equal(run.permissions[0]?.status, "applied");
        assert.equal(run.artifacts.length, 1);
        const artifact: { bytes: Buffer } = await hub.app.artifact(
          run.artifacts[0]!.id,
        );
        assert.equal(artifact.bytes.toString(), "精确产物");
      }
      if (adapter === "codex") {
        const accepted = await json<RunRecord>(
          `/v1/sessions/${session.id}/runs`,
          { text: "CANCEL_BARRIER", timeoutMs: 10000 },
        );
        await started.promise;
        await json(`/v1/runs/${accepted.id}/cancel`, {});
        const result = await terminal(accepted.id);
        assert.equal(result.status, "cancelled");
        assert.equal(result.cleanupStatus, "confirmed");
        await disconnected.promise;
      }
      await json(`/v1/sessions/${session.id}/close`, {});
    }
    assert.equal(requests.length, 9);
    assert.ok(
      requests.every(
        (request) =>
          request.path === "/v1/chat/completions" &&
          request.key &&
          request.skill &&
          request.mcp,
      ),
    );
    assert.equal(requests.filter((request) => request.toolResult).length, 4);
    for (const file of (await readdir(root)).filter((file) =>
      /^peer-\d+\.json$/.test(file),
    )) {
      const record = JSON.parse(await readFile(join(root, file), "utf8")) as {
        url: string;
        pid: number;
      };
      await assert.rejects(fetch(record.url));
      assert.throws(() => process.kill(record.pid, 0), { code: "ESRCH" });
    }
    const db = await readFile(join(root, "data", "harnesshub.sqlite"));
    assert.equal(
      db.includes(Buffer.from("synthetic-bridge-integration-key")),
      false,
    );
  },
);
