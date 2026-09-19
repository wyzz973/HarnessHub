import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { startHub } from "../../src/main.js";
import type { RunRecord, SessionRecord } from "../../src/domain/types.js";
import type { HubApplication } from "../../src/application/service.js";
import { ensurePrivateDirectory } from "../../src/platform/windows-acl.js";

type Hub = Awaited<ReturnType<typeof startHub>>;
type RunView = ReturnType<HubApplication["getRun"]>;
type LogLine = { time: string; level: string; event: string } & Record<
  string,
  unknown
>;

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function lines(file: string): Promise<LogLine[]> {
  const text = await readFile(file, "utf8");
  assert.ok(text.endsWith("\n"), `${file} ends with a newline`);
  return text
    .trimEnd()
    .split("\n")
    .map((line) => {
      const parsed = JSON.parse(line) as LogLine;
      assert.equal(typeof parsed.time, "string");
      assert.ok(["info", "debug"].includes(parsed.level), line);
      assert.equal(typeof parsed.event, "string");
      return parsed;
    });
}

function events(records: LogLine[], event: string): LogLine[] {
  return records.filter((record) => record.event === event);
}

async function until<T>(
  probe: () => Promise<T | undefined>,
  message: string,
): Promise<T> {
  const end = Date.now() + 15000;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    assert.ok(Date.now() < end, message);
    await delay(25);
  }
}

void test(
  "Gateway and engine logs record lifecycle, ACP traffic, model calls and stderr without secrets; debug adds payload excerpts",
  { timeout: 120000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "hh-diagnostic-logs-"));
    const companyKey = "synthetic-company-log-key-0123456789abcdef";
    const saved = {
      key: process.env.HH_LOG_FIXTURE_COMPANY_KEY,
      level: process.env.HARNESSHUB_LOG_LEVEL,
    };
    process.env.HH_LOG_FIXTURE_COMPANY_KEY = companyKey;
    const upstream = createServer((request, response) => {
      void (async () => {
        const text = await body(request);
        const toolResult = text.includes('"role":"tool"');
        const delta = toolResult
          ? { content: "LOGGED_DONE" }
          : {
              tool_calls: [
                {
                  index: 0,
                  id: "call_log",
                  type: "function",
                  function: {
                    name: "fixture_write",
                    arguments: '{"text":"日志"}',
                  },
                },
              ],
            };
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: "思考" } }] })}\n\n`,
        );
        response.write(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: toolResult ? "stop" : "tool_calls" }], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } })}\n\n`,
        );
        response.end("data: [DONE]\n\n");
      })().catch(() => response.destroy());
    });
    let hub: Hub | undefined;
    t.after(async () => {
      await hub?.server.close();
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      for (const [name, value] of [
        ["HH_LOG_FIXTURE_COMPANY_KEY", saved.key],
        ["HARNESSHUB_LOG_LEVEL", saved.level],
      ] as const)
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      await rm(root, { recursive: true, force: true });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const address = upstream.address();
    assert.ok(address && typeof address !== "string");
    if (process.platform === "win32") await ensurePrivateDirectory(root);
    const peer = fileURLToPath(
      new URL("../fixtures/model-gateway-peer.js", import.meta.url),
    );

    for (const level of ["info", "debug"] as const) {
      process.env.HARNESSHUB_LOG_LEVEL = level;
      const dataDir = join(root, `data-${level}`);
      hub = await startHub({ cwd: root, dataDir, demo: false, port: 0 });
      const current = hub;
      assert.equal(
        current.logFile,
        join(await realpath(dataDir), "logs", "gateway.log"),
      );
      const json = async <T>(route: string, payload?: unknown): Promise<T> => {
        const response = await fetch(
          current.url + route,
          payload === undefined
            ? {}
            : {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(payload),
              },
        );
        assert.ok(response.ok, `${route}: ${response.status}`);
        return (await response.json()) as T;
      };
      await json("/v1/engines", {
        id: "opencode",
        driver: "acp",
        command: [process.execPath, peer, "opencode", "log-canary"],
        model: "company-log-model",
        configuration: {
          adapter: "opencode",
          provider: {
            protocol: "openai-completions",
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            apiKey: { kind: "env", value: "HH_LOG_FIXTURE_COMPANY_KEY" },
          },
        },
      });
      const session = await json<SessionRecord>("/v1/sessions", {
        engineId: "opencode",
      });
      const accepted = await json<RunRecord>(
        `/v1/sessions/${session.id}/runs`,
        { text: "USE_TOOL please 日志", timeoutMs: 20000 },
      );
      const run = await until(async () => {
        const view = await json<RunView>(`/v1/runs/${accepted.id}`);
        for (const permission of view.permissions.filter(
          (p) => p.status === "pending",
        ))
          await json(`/v1/permissions/${permission.id}/decision`, {
            optionId: "write-once",
          });
        return view.finishedAt ? view : undefined;
      }, "Run did not settle");
      assert.equal(run.status, "completed", JSON.stringify(run.error));
      await json(`/v1/sessions/${session.id}/close`, {});
      const gatewayLog = current.logFile;
      await until(
        async () =>
          (await lines(gatewayLog)).some(
            (record) =>
              record.event === "worker.exit" && record.sessionId === session.id,
          )
            ? true
            : undefined,
        "worker.exit was not logged",
      );
      await current.server.close();
      hub = undefined;

      // The Session tokens the engines used, as the fixture recorded them.
      const tokens: string[] = [];
      for (const name of await readdir(session.cwd))
        if (name.startsWith("gateway-peer-opencode-") && name.endsWith(".json"))
          tokens.push(
            (
              JSON.parse(await readFile(join(session.cwd, name), "utf8")) as {
                token: string;
              }
            ).token,
          );
      assert.ok(tokens.length > 0, "fixture wrote its endpoint record");
      assert.ok(tokens.every((token) => token.length >= 16));

      const gateway = await lines(gatewayLog);
      const engineLogFile = join(
        await realpath(dataDir),
        "backends",
        session.id,
        "diagnostics",
        "engine.log",
      );
      const engine = await lines(engineLogFile);
      const rawGateway = await readFile(gatewayLog, "utf8");
      const rawEngine = await readFile(engineLogFile, "utf8");
      for (const [name, raw] of [
        ["gateway", rawGateway],
        ["engine", rawEngine],
      ] as const) {
        assert.equal(
          raw.includes(companyKey),
          false,
          `${name} log has the company key`,
        );
        for (const token of tokens)
          assert.equal(
            raw.includes(token),
            false,
            `${name} log has a Session token`,
          );
      }

      // Gateway log: startup, access, Session/Run lifecycle, Worker and permission records.
      for (const event of [
        "gateway.start",
        "gateway.listen",
        "session.create",
        "run.accept",
        "run.status",
        "run.finish",
        "worker.spawn",
        "worker.ready",
        "worker.exit",
        "permission.request",
        "permission.decide",
        "model.call",
        "gateway.stop",
      ])
        assert.ok(
          events(gateway, event).length > 0,
          `gateway log has ${event}`,
        );
      const created = events(gateway, "session.create")[0]!;
      assert.equal(created.sessionId, session.id);
      assert.equal(created.engineLog, engineLogFile);
      const finished = events(gateway, "run.finish").find(
        (record) => record.runId === run.id,
      )!;
      assert.equal(finished.status, "completed");
      assert.equal(typeof finished.ms, "number");
      const access = events(gateway, "http");
      assert.ok(
        access.some(
          (record) =>
            record.method === "POST" &&
            record.route === "/v1/sessions/:id/runs" &&
            record.id === session.id &&
            record.status === 202,
        ),
        `the Run submission has an access record with its Session id: ${JSON.stringify(access.filter((record) => record.method === "POST"))}`,
      );
      assert.ok(access.every((record) => typeof record.ms === "number"));
      assert.equal(
        events(gateway, "model.call").filter(
          (record) => record.runId === run.id,
        ).length,
        2,
      );
      // Successful GET/HEAD access lines (polling) are debug records; everything else
      // the Gateway writes is info.
      const successfulReads = access.filter(
        (record) =>
          (record.method === "GET" || record.method === "HEAD") &&
          Number(record.status) < 400 &&
          record.route !== "/event",
      );
      assert.deepEqual(
        gateway.filter(
          (record) => record.level === "debug" && record.event !== "http",
        ),
        [],
        "only polling access lines are Gateway debug records",
      );
      assert.ok(
        successfulReads.every((record) => record.level === "debug"),
        "successful reads are logged at debug level",
      );
      if (level === "info")
        assert.deepEqual(successfulReads, [], "info omits successful reads");
      else
        assert.ok(
          successfulReads.some(
            (record) => record.route === "/v1/runs/:id" && record.id === run.id,
          ),
          "debug keeps the polling reads",
        );

      // Engine log: Worker, process, ACP traffic, tool and permission, model calls.
      for (const event of [
        "worker.start",
        "run.start",
        "run.prepared",
        "engine.spawn",
        "acp.request",
        "acp.response",
        "acp.turn",
        "acp.tool",
        "acp.permission",
        "model.call",
        "engine.stderr",
        "run.finish",
        "worker.stop",
        "engine.exit",
      ])
        assert.ok(events(engine, event).length > 0, `engine log has ${event}`);
      const methods = events(engine, "acp.request").map(
        (record) => record.method,
      );
      for (const method of [
        "initialize",
        "session/new",
        "session/prompt",
        "session/request_permission",
      ])
        assert.ok(methods.includes(method), `ACP ${method} is logged`);
      const prompt = events(engine, "acp.response").find(
        (record) => record.method === "session/prompt",
      )!;
      assert.equal(prompt.ok, true);
      assert.equal(prompt.stopReason, "end_turn");
      assert.equal(typeof prompt.ms, "number");
      const turn = events(engine, "acp.turn")[0]!;
      assert.deepEqual(turn.updates, {
        tool_call: 1,
        tool_call_update: 1,
        agent_message_chunk: 1,
      });
      assert.equal(turn.textBytes, Buffer.byteLength("LOGGED_DONE"));
      assert.deepEqual(
        events(engine, "acp.tool").map((record) => record.status),
        ["pending", "completed"],
      );
      assert.equal(events(engine, "acp.permission")[0]!.decision, "allow_once");
      const calls = events(engine, "model.call");
      assert.equal(calls.length, 2);
      for (const call of calls) {
        assert.equal(call.runId, run.id);
        assert.equal(call.path, "/v1/chat/completions");
        assert.equal(call.upstreamModel, "company-log-model");
        assert.equal(call.status, 200);
        assert.equal(typeof call.firstByteMs, "number");
      }
      assert.deepEqual(calls[1]!.reasoning, { restored: 1, missing: 0 });
      const stderr = events(engine, "engine.stderr").map(
        (record) => record.line,
      );
      assert.ok(
        stderr.includes(
          "fixture diagnostics: gateway credential in use [REDACTED]",
        ),
        JSON.stringify(stderr),
      );
      assert.ok(stderr.includes("诊断 stderr 多字节行"));
      assert.equal(
        events(engine, "run.finish").find((record) => record.runId === run.id)!
          .status,
        "completed",
      );

      const debugEvents = [
        "run.input",
        "acp.request.params",
        "acp.response.result",
        "acp.update",
        "model.payload",
      ];
      if (level === "info")
        assert.equal(
          engine.some((record) => record.level === "debug"),
          false,
          "info writes no debug records",
        );
      else {
        for (const event of debugEvents)
          assert.ok(events(engine, event).length > 0, `debug adds ${event}`);
        const payload = events(engine, "model.payload")[0]!;
        assert.match(String(payload.request), /company-log-model/);
        assert.match(String(payload.response), /fixture_write/);
        assert.ok(
          events(engine, "acp.request.params").every(
            (record) => String(record.params).length <= 2048 + 16,
          ),
        );
        assert.match(
          String(
            events(engine, "acp.request.params").find(
              (record) => record.method === "session/prompt",
            )!.params,
          ),
          /USE_TOOL please 日志/,
        );
      }
    }
  },
);
