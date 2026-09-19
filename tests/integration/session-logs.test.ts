import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { startHub } from "../../src/main.js";
import type { RunRecord, SessionRecord } from "../../src/domain/types.js";
import type { HubApplication } from "../../src/application/service.js";
import { ensurePrivateDirectory } from "../../src/platform/windows-acl.js";

type RunView = ReturnType<HubApplication["getRun"]>;
type LogRecord = { time: string; level: string; event: string } & Record<
  string,
  unknown
>;
type Page = {
  source: "engine" | "gateway";
  file: string;
  exists: boolean;
  records: LogRecord[];
  cursor: string | null;
  truncated: boolean;
  skipped: number;
};

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

void test(
  "GET /v1/sessions/{id}/logs pages a Session's engine log and only its own Gateway lines without secrets",
  { timeout: 120000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "hh-session-logs-"));
    const companyKey = "synthetic-company-session-log-key-0123456789";
    const saved = process.env.HH_SESSION_LOG_COMPANY_KEY;
    process.env.HH_SESSION_LOG_COMPANY_KEY = companyKey;
    // One tool call per Run, then a final answer once the tool result is sent back.
    const upstream = createServer((request, response) => {
      void (async () => {
        const text = await body(request);
        const toolResult = text.includes('"role":"tool"');
        const delta = toolResult
          ? { content: "SESSION_LOG_DONE" }
          : {
              tool_calls: [
                {
                  index: 0,
                  id: "call_session_log",
                  type: "function",
                  function: {
                    name: "fixture_write",
                    arguments: '{"text":"x"}',
                  },
                },
              ],
            };
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: toolResult ? "stop" : "tool_calls" }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })}\n\n`,
        );
        response.end("data: [DONE]\n\n");
      })().catch(() => response.destroy());
    });
    let hub: Awaited<ReturnType<typeof startHub>> | undefined;
    t.after(async () => {
      await hub?.server.close();
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      if (saved === undefined) delete process.env.HH_SESSION_LOG_COMPANY_KEY;
      else process.env.HH_SESSION_LOG_COMPANY_KEY = saved;
      await rm(root, { recursive: true, force: true });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const address = upstream.address();
    assert.ok(address && typeof address !== "string");
    if (process.platform === "win32") await ensurePrivateDirectory(root);
    hub = await startHub({
      cwd: root,
      dataDir: join(root, "data"),
      demo: false,
      port: 0,
    });
    const url = hub.url;
    const raw = async (route: string) => {
      const response = await fetch(url + route);
      return { status: response.status, text: await response.text() };
    };
    const json = async <T>(route: string, payload?: unknown): Promise<T> => {
      const response = await fetch(
        url + route,
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
    const logs = (id: string, query: string) =>
      json<Page>(`/v1/sessions/${id}/logs?${query}`);
    await json("/v1/engines", {
      id: "opencode",
      driver: "acp",
      command: [
        process.execPath,
        fileURLToPath(
          new URL("../fixtures/model-gateway-peer.js", import.meta.url),
        ),
        "opencode",
        "log-canary",
      ],
      model: "company-session-log-model",
      configuration: {
        adapter: "opencode",
        provider: {
          protocol: "openai-completions",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          apiKey: { kind: "env", value: "HH_SESSION_LOG_COMPANY_KEY" },
        },
      },
    });
    const runTo = async (session: SessionRecord, text: string) => {
      const accepted = await json<RunRecord>(
        `/v1/sessions/${session.id}/runs`,
        {
          text,
          timeoutMs: 20000,
        },
      );
      const end = Date.now() + 20000;
      for (;;) {
        const view = await json<RunView>(`/v1/runs/${accepted.id}`);
        for (const permission of view.permissions.filter(
          (item) => item.status === "pending",
        ))
          await json(`/v1/permissions/${permission.id}/decision`, {
            optionId: "write-once",
          });
        if (view.finishedAt) {
          assert.equal(view.status, "completed", JSON.stringify(view.error));
          return view;
        }
        assert.ok(Date.now() < end, "Run did not settle");
        await delay(25);
      }
    };
    const a = await json<SessionRecord>("/v1/sessions", {
      engineId: "opencode",
    });
    const b = await json<SessionRecord>("/v1/sessions", {
      engineId: "opencode",
    });

    // Before any Run the engine log does not exist yet.
    const empty = await logs(a.id, "source=engine");
    assert.equal(empty.exists, false);
    assert.deepEqual(empty.records, []);
    assert.equal(empty.cursor, null);

    const first = await runTo(a, "USE_TOOL for session A");
    const other = await runTo(b, "USE_TOOL for session B");

    const engine = await logs(a.id, "source=engine&limit=2000");
    assert.equal(engine.exists, true);
    assert.equal(engine.truncated, false);
    assert.ok(
      engine.file.endsWith(join("backends", a.id, "diagnostics", "engine.log")),
    );
    const engineEvents = new Set(engine.records.map((record) => record.event));
    for (const event of [
      "run.start",
      "acp.request",
      "acp.tool",
      "acp.permission",
      "model.call",
      "run.finish",
    ])
      assert.ok(engineEvents.has(event), `engine page has ${event}`);
    assert.ok(
      engine.records.every(
        (record) => record.runId === undefined || record.runId === first.id,
      ),
      "the engine page holds only Session A's Runs",
    );
    assert.ok(
      engine.records.some(
        (record) => record.event === "model.call" && record.runId === first.id,
      ),
    );

    // Polling the log itself must not appear in the Gateway page.
    await logs(a.id, "source=gateway");
    await logs(a.id, "source=gateway");
    const gateway = await logs(a.id, "source=gateway&limit=2000");
    assert.ok(gateway.records.length > 0);
    const aRuns = new Set<string>([first.id]);
    for (const record of gateway.records) {
      assert.ok(
        record.sessionId === a.id ||
          record.id === a.id ||
          aRuns.has(String(record.runId)) ||
          aRuns.has(String(record.id)),
        `foreign Gateway record ${JSON.stringify(record)}`,
      );
      assert.notEqual(record.route, "/v1/sessions/:id/logs");
    }
    const gatewayEvents = new Set(
      gateway.records.map((record) => record.event),
    );
    for (const event of [
      "session.create",
      "run.accept",
      "run.finish",
      "permission.request",
      "model.call",
      "http",
    ])
      assert.ok(gatewayEvents.has(event), `gateway page has ${event}`);
    assert.equal(
      gateway.records.some(
        (record) => record.runId === other.id || record.sessionId === b.id,
      ),
      false,
    );

    // Tail plus cursor: a small page, then only what the next Run adds.
    const tail = await logs(a.id, "source=engine&limit=2");
    assert.equal(tail.records.length, 2);
    assert.equal(tail.truncated, true);
    assert.ok(tail.cursor);
    const idle = await logs(
      a.id,
      `source=engine&after=${encodeURIComponent(tail.cursor!)}`,
    );
    assert.deepEqual(idle.records, []);
    const second = await runTo(a, "USE_TOOL again for session A");
    const next = await logs(
      a.id,
      `source=engine&after=${encodeURIComponent(tail.cursor!)}`,
    );
    assert.ok(next.records.length > 0);
    assert.ok(
      next.records.every(
        (record) => record.runId === undefined || record.runId === second.id,
      ),
      "only records of the new Run follow the cursor",
    );
    assert.ok(
      next.records.some(
        (record) => record.event === "run.finish" && record.runId === second.id,
      ),
    );
    assert.equal(next.truncated, false);

    // Validation and unknown Sessions.
    for (const query of [
      "limit=0",
      "limit=2001",
      "source=worker",
      "after=../x",
      "unknown=1",
    ]) {
      const response = await raw(`/v1/sessions/${a.id}/logs?${query}`);
      assert.equal(response.status, 400, query);
      assert.equal(
        (JSON.parse(response.text) as { error: { code: string } }).error.code,
        "INVALID_REQUEST",
      );
    }
    const missing = await raw(
      "/v1/sessions/00000000-0000-4000-8000-000000000000/logs",
    );
    assert.equal(missing.status, 404);
    assert.equal(
      (JSON.parse(missing.text) as { error: { code: string } }).error.code,
      "SESSION_NOT_FOUND",
    );

    // Neither the company key nor a Session token reaches a response.
    const tokens: string[] = [];
    for (const session of [a, b])
      for (const name of await readdir(session.cwd))
        if (name.startsWith("gateway-peer-opencode-") && name.endsWith(".json"))
          tokens.push(
            (
              JSON.parse(await readFile(join(session.cwd, name), "utf8")) as {
                token: string;
              }
            ).token,
          );
    assert.ok(tokens.length >= 2);
    const everything = JSON.stringify([engine, gateway, next]);
    assert.equal(everything.includes(companyKey), false);
    for (const token of tokens) assert.equal(everything.includes(token), false);
    assert.ok(
      engine.records.some(
        (record) =>
          record.event === "engine.stderr" &&
          String(record.line).includes("[REDACTED]"),
      ),
      "the fixture's token-bearing stderr line is present and redacted",
    );

    // The route is documented.
    const openapi = await json<{ paths: Record<string, unknown> }>(
      "/openapi.json",
    );
    assert.ok(openapi.paths["/v1/sessions/{id}/logs"]);
  },
);
