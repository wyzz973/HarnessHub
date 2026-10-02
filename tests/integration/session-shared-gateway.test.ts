// SPDX-License-Identifier: MIT
// Sets the process launcher for the Windows filesystem primitives used directly here.
import "../support/process-launcher.js";
import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { once } from "node:events";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { startHub } from "@harnesshub/daemon/main";
import type { RunRecord, SessionRecord } from "@harnesshub/core/types";
import type {
  GatewayKeyView,
  ModelCallEntry,
  ProviderConfig,
  RouteGroup,
} from "@harnesshub/core/model-plane";
import { ensurePrivateDirectory } from "@harnesshub/store/platform/windows-acl";
import { temporaryDirectory } from "../support/temporary.js";

type Hub = Awaited<ReturnType<typeof startHub>>;
const peer = fileURLToPath(
  new URL("../fixtures/shared-gateway-peer.js", import.meta.url),
);
const UPSTREAM_KEY = "synthetic-shared-upstream-key-0123456789";

/** A Chat upstream: SSE for streamed requests, one completion otherwise. */
async function upstream(t: test.TestContext) {
  const seen: { authorization?: string; model: string; stream: boolean }[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        model: string;
        stream?: boolean;
      };
      seen.push({
        ...(request.headers.authorization
          ? { authorization: request.headers.authorization }
          : {}),
        model: body.model,
        stream: body.stream === true,
      });
      if (
        JSON.stringify(body).includes("FAIL_UPSTREAM") ||
        (JSON.stringify(body).includes("FAIL_CHAT") && !body.stream)
      ) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: { message: `rejected with ${UPSTREAM_KEY}` },
          }),
        );
        return;
      }
      const usage = {
        prompt_tokens: 30,
        completion_tokens: 4,
        prompt_tokens_details: { cached_tokens: 10 },
      };
      if (body.stream) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          `data: ${JSON.stringify({ model: "served-model", choices: [{ index: 0, delta: { content: "SHARED_OK" }, finish_reason: "stop" }] })}\n\n` +
            `data: ${JSON.stringify({ model: "served-model", choices: [], usage })}\n\ndata: [DONE]\n\n`,
        );
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          model: "served-model",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "SHARED_OK" },
              finish_reason: "stop",
            },
          ],
          usage,
        }),
      );
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

function withEnvironment(t: test.TestContext, values: Record<string, string>) {
  const previous = Object.fromEntries(
    Object.keys(values).map((name) => [name, process.env[name]]),
  );
  Object.assign(process.env, values);
  t.after(() => {
    for (const [name, value] of Object.entries(previous))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  });
}

function client(hub: Hub, dataDir: string) {
  const call = async <T>(
    method: string,
    route: string,
    body?: unknown,
    admin = false,
  ) => {
    const token = admin
      ? (await readFile(join(dataDir, "admin.token"), "utf8")).trim()
      : undefined;
    const response = await fetch(hub.url + route, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return {
      status: response.status,
      value: (text ? JSON.parse(text) : undefined) as T,
    };
  };
  const run = async (sessionId: string, text: string, extra = {}) => {
    const accepted = await call<RunRecord>(
      "POST",
      `/v1/sessions/${sessionId}/runs`,
      { text, timeoutMs: 15000, ...extra },
    );
    assert.equal(accepted.status, 202, JSON.stringify(accepted.value));
    let current = accepted.value;
    const deadline = Date.now() + 20000;
    while (!current.finishedAt) {
      assert.ok(Date.now() < deadline, "Run did not settle");
      await delay(20);
      current = (await call<RunRecord>("GET", `/v1/runs/${accepted.value.id}`))
        .value;
    }
    return current;
  };
  return { call, run };
}

/** Reports of fixture engines that found a gateway in their configuration. */
async function reports(directory: string, adapter: string) {
  const files = (await readdir(directory)).filter((file) =>
    file.startsWith(`shared-peer-${adapter}-`),
  );
  const all = await Promise.all(
    files.map(
      async (file) =>
        JSON.parse(await readFile(join(directory, file), "utf8")) as {
          url: string;
          token: string;
          model: string;
          env: string[];
        },
    ),
  );
  return all.filter((report) => report.url);
}

void test(
  "Session Runs reach the shared gateway with a session key: Chat and Anthropic calls, runId in the ledger, 409 after the Run, revoked after close",
  { timeout: 90000 },
  async (t) => {
    const { directory, defer } = await temporaryDirectory(
      t,
      "hh-shared-session-",
    );
    if (process.platform === "win32") await ensurePrivateDirectory(directory);
    withEnvironment(t, { HH_SHARED_FIXTURE_KEY: UPSTREAM_KEY });
    const up = await upstream(t);
    const dataDir = join(directory, "data");
    let hub: Hub | undefined = await startHub({
      cwd: directory,
      dataDir,
      demo: false,
      port: 0,
    });
    defer(() => hub?.server.close());
    const { call, run } = client(hub, dataDir);
    const origin = new URL(hub.url).origin.replace("localhost", "127.0.0.1");

    // A routable engine without a provider of its own uses group/default once it exists.
    for (const adapter of ["claude", "opencode"])
      assert.equal(
        (
          await call("POST", "/v1/engines", {
            id: adapter,
            driver: "acp",
            command: [process.execPath, peer, adapter],
            configuration: { adapter },
          })
        ).status,
        201,
      );
    const before = (
      await call<SessionRecord>("POST", "/v1/sessions", { engineId: "claude" })
    ).value;
    const native = await run(before.id, "NO_MODEL");
    assert.deepEqual(
      (
        await call<{ items: GatewayKeyView[] }>(
          "GET",
          "/api/v1/gateway-keys",
          undefined,
          true,
        )
      ).value.items,
      [],
      "a Session without a target gets no key",
    );
    assert.equal(
      (await reports(directory, "claude")).length,
      0,
      "no group/default yet: the engine keeps its own login",
    );
    assert.equal(native.status, "completed");
    await call("POST", `/v1/sessions/${before.id}/close`, {});

    const provider = await call<ProviderConfig>(
      "POST",
      "/api/v1/providers",
      {
        id: "fixture",
        endpoints: { chat: `${up.base}/v1` },
        models: {
          source: "manual",
          list: [
            {
              id: "m1",
              contextWindow: 32768,
              maxOutputTokens: 4096,
              price: { input: 1, output: 2, cacheRead: 0.5 },
            },
          ],
          expose: "all",
        },
        credential: { ref: { kind: "env", value: "HH_SHARED_FIXTURE_KEY" } },
      },
      true,
    );
    assert.equal(provider.status, 201, JSON.stringify(provider.value));
    assert.equal(
      (
        await call<RouteGroup>(
          "POST",
          "/api/v1/route-groups",
          { id: "default", members: ["fixture/m1"] },
          true,
        )
      ).status,
      201,
    );

    const session = (
      await call<SessionRecord>("POST", "/v1/sessions", { engineId: "claude" })
    ).value;
    const first = await run(session.id, "BOTH please");
    assert.equal(first.status, "completed", JSON.stringify(first.error));
    assert.equal(first.output, "SHARED_OKSHARED_OK");
    const [report] = await reports(directory, "claude");
    assert.ok(report);
    assert.equal(report.url, origin, "the engine talks to the daemon port");
    assert.match(report.token, /^hhk_s_/);
    assert.equal(report.model, "harnesshub-model");
    assert.equal(report.env.includes("HH_SHARED_FIXTURE_KEY"), false);

    const calls = (
      await call<{ items: ModelCallEntry[] }>(
        "GET",
        `/api/v1/model-calls?sessionId=${session.id}`,
        undefined,
        true,
      )
    ).value.items;
    assert.deepEqual(calls.map((entry) => entry.inbound.protocol).sort(), [
      "anthropic",
      "chat",
    ]);
    for (const entry of calls) {
      assert.equal(entry.runId, first.id);
      assert.equal(entry.group, "default");
      assert.equal(entry.modelRef, "fixture/m1");
      assert.equal(entry.requestedModel, "harnesshub-model");
      assert.equal(entry.status, 200);
    }
    const modelEvents = hub.app
      .events(first.id, 0, 1000)
      .filter((event) => event.type === "model.call");
    assert.equal(modelEvents.length, 2);
    assert.ok(modelEvents.every((event) => event.data.ok === true));
    const observed = (
      await call<{
        tokens: Record<string, number>;
        usage: { source: string };
        cost: { amount: number };
      }>("GET", `/v1/runs/${first.id}/observations`)
    ).value;
    assert.equal(observed.usage.source, "gateway-ledger");
    assert.deepEqual(observed.tokens, {
      input: 60,
      output: 8,
      cacheRead: 20,
      cacheWrite: 0,
      reasoning: 0,
      total: 68,
    });
    assert.equal(up.seen.length, 2);
    for (const seen of up.seen) {
      assert.equal(seen.authorization, `Bearer ${UPSTREAM_KEY}`);
      assert.equal(seen.model, "m1");
    }

    // Between Runs the Session's key is refused; it is not a credential of its own.
    const between = await fetch(`${report.url}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": report.token,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "harnesshub-model",
        max_tokens: 5,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    assert.equal(between.status, 409);
    assert.equal(
      ((await between.json()) as { error: { message: string } }).error.message,
      "No active Run owns this Session's model request",
    );

    const explicit = await run(session.id, "explicit target", {
      model: "fixture/m1",
    });
    assert.equal(explicit.status, "completed", JSON.stringify(explicit.error));
    const missing = await run(session.id, "missing target", {
      model: "nope/x",
    });
    assert.equal(missing.status, "failed");
    assert.equal(missing.error?.code, "MODEL_NOT_CONFIGURED");
    assert.equal(
      (await call<SessionRecord>("GET", `/v1/sessions/${session.id}`)).value
        .status,
      "open",
    );

    // An upstream failure fails the Run with its cause, judged from the
    // ledger; the Session stays usable.
    const failing = await run(session.id, "FAIL_UPSTREAM");
    assert.equal(failing.status, "failed");
    assert.equal(failing.error?.code, "MODEL_UPSTREAM_ERROR");
    assert.match(failing.error?.message ?? "", /HTTP 400/);
    assert.equal(failing.error?.message.includes(UPSTREAM_KEY), false);
    const silent = await run(session.id, "NO_MODEL");
    assert.equal(silent.error?.code, "ENGINE_NO_OUTPUT");
    // The outcome rules are those of the Worker gateway: output without any
    // model call stays completed, and a turn whose last call failed after an
    // earlier success, without output, fails with that cause.
    const echo = await run(session.id, "ECHO_ONLY");
    assert.equal(echo.status, "completed", JSON.stringify(echo.error));
    assert.equal(echo.output, "echo without a model");
    const lastFailed = await run(session.id, "BOTH FAIL_CHAT");
    assert.equal(lastFailed.status, "failed");
    assert.equal(lastFailed.error?.code, "MODEL_UPSTREAM_ERROR");
    const lastCalls = hub.app
      .events(lastFailed.id, 0, 1000)
      .filter((event) => event.type === "model.call");
    assert.deepEqual(
      lastCalls.map((event) => event.data.ok),
      [true, false],
    );

    await call("POST", `/v1/sessions/${session.id}/close`, {});
    const keys = (
      await call<{ items: GatewayKeyView[] }>(
        "GET",
        "/api/v1/gateway-keys",
        undefined,
        true,
      )
    ).value.items;
    const sessionKeys = keys.filter((key) => key.scope.kind === "session");
    assert.equal(sessionKeys.length, 1);
    assert.ok(
      sessionKeys[0]!.revokedAt,
      "the key is revoked after the Session closed",
    );
    const revoked = await fetch(`${report.url}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${report.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "harnesshub-model", messages: [] }),
    });
    assert.equal(revoked.status, 401);

    const chatSession = (
      await call<SessionRecord>("POST", "/v1/sessions", {
        engineId: "opencode",
      })
    ).value;
    const chatRun = await run(chatSession.id, "chat please");
    assert.equal(chatRun.status, "completed", JSON.stringify(chatRun.error));
    const chatCalls = (
      await call<{ items: ModelCallEntry[] }>(
        "GET",
        `/api/v1/model-calls?sessionId=${chatSession.id}`,
        undefined,
        true,
      )
    ).value.items;
    assert.equal(chatCalls.length, 1);
    assert.equal(chatCalls[0]!.runId, chatRun.id);
    assert.equal(chatCalls[0]!.mode, "passthrough");

    await hub.server.close();
    hub = undefined;
    // The key never reaches Worker diagnostics or logs, though the engine printed it.
    const backend = join(dataDir, "backends", session.id);
    const logFiles = [
      join(dataDir, "logs", "gateway.log"),
      ...(await readdir(backend, { recursive: true }))
        .filter((file) => /\.log$/.test(file))
        .map((file) => join(backend, file)),
    ];
    assert.ok(logFiles.some((file) => file.endsWith("engine.log")));
    let canary = false;
    for (const file of logFiles) {
      const text = await readFile(file, "utf8");
      assert.equal(text.includes(report.token), false, file);
      canary ||= text.includes("fixture key in use");
    }
    assert.ok(canary, "the engine's stderr reached the engine log, redacted");
    const database = await readFile(join(dataDir, "harnesshub.sqlite"));
    assert.equal(
      database.includes(Buffer.from(report.token)),
      false,
      "only the key's hash is stored",
    );
    const logs = await readFile(join(dataDir, "logs", "gateway.log"), "utf8");
    assert.equal(logs.includes(report.token), false);
  },
);

void test(
  "a harness-model.json unified model migrates once into provider migrated and group/default, which its engines' Runs use",
  { timeout: 90000 },
  async (t) => {
    const { directory, defer } = await temporaryDirectory(
      t,
      "hh-shared-migrate-",
    );
    if (process.platform === "win32") await ensurePrivateDirectory(directory);
    withEnvironment(t, { HH_SHARED_FIXTURE_KEY: UPSTREAM_KEY });
    const up = await upstream(t);
    const dataDir = join(directory, "data");
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    await writeFile(
      join(dataDir, "harness-model.json"),
      JSON.stringify({
        model: "legacy-upstream-model",
        provider: {
          protocol: "openai-completions",
          baseUrl: `${up.base}/v1`,
          apiKey: { kind: "env", value: "HH_SHARED_FIXTURE_KEY" },
          contextWindow: 65536,
          compatibility: { maxTokensField: "max_completion_tokens" },
        },
      }),
    );
    const start = () =>
      startHub({ cwd: directory, dataDir, demo: false, port: 0 });
    let hub: Hub | undefined = await start();
    defer(() => hub?.server.close());
    let api = client(hub, dataDir);
    const migrated = (
      await api.call<ProviderConfig>(
        "GET",
        "/api/v1/providers/migrated",
        undefined,
        true,
      )
    ).value;
    assert.equal(migrated.kind, "custom");
    assert.deepEqual(migrated.endpoints, { chat: `${up.base}/v1` });
    assert.equal(migrated.credentials.length, 1);
    assert.deepEqual(migrated.credentials[0]!.ref, {
      kind: "env",
      value: "HH_SHARED_FIXTURE_KEY",
    });
    assert.deepEqual(migrated.models.list, [
      { id: "default", wire: "legacy-upstream-model", contextWindow: 65536 },
    ]);
    assert.equal(migrated.translateOnly, true);
    assert.ok(migrated.patches?.chat?.patches.includes("max-tokens-field"));
    const group = (
      await api.call<RouteGroup>(
        "GET",
        "/api/v1/route-groups/default",
        undefined,
        true,
      )
    ).value;
    assert.deepEqual(group.members, ["migrated/default"]);

    // An engine the unified model applies to now runs through the shared gateway.
    assert.equal(
      (
        await api.call("POST", "/v1/engines", {
          id: "opencode",
          driver: "acp",
          command: [process.execPath, peer, "opencode"],
          configuration: { adapter: "opencode" },
        })
      ).status,
      201,
    );
    const session = (
      await api.call<SessionRecord>("POST", "/v1/sessions", {
        engineId: "opencode",
      })
    ).value;
    const completed = await api.run(session.id, "migrated please");
    assert.equal(
      completed.status,
      "completed",
      JSON.stringify(completed.error),
    );
    assert.equal(up.seen.at(-1)!.model, "legacy-upstream-model");
    assert.equal(up.seen.at(-1)!.authorization, `Bearer ${UPSTREAM_KEY}`);
    const [report] = await reports(directory, "opencode");
    assert.equal(
      report!.url,
      `${new URL(hub.url).origin.replace("localhost", "127.0.0.1")}/v1`,
    );
    const calls = (
      await api.call<{ items: ModelCallEntry[] }>(
        "GET",
        `/api/v1/model-calls?sessionId=${session.id}`,
        undefined,
        true,
      )
    ).value.items;
    assert.equal(calls[0]!.runId, completed.id);
    assert.equal(calls[0]!.modelRef, "migrated/default");

    // A changed group/default is never overwritten; restarting does not migrate again.
    assert.equal(
      (
        await api.call(
          "PATCH",
          "/api/v1/route-groups/default",
          { strategy: "rotate" },
          true,
        )
      ).status,
      200,
    );
    await hub.server.close();
    hub = await start();
    api = client(hub, dataDir);
    const after = (
      await api.call<RouteGroup>(
        "GET",
        "/api/v1/route-groups/default",
        undefined,
        true,
      )
    ).value;
    assert.equal(after.strategy, "rotate");
    const providers = (
      await api.call<{ items: ProviderConfig[] }>(
        "GET",
        "/api/v1/providers",
        undefined,
        true,
      )
    ).value.items;
    assert.deepEqual(
      providers.map((entry) => entry.id),
      ["migrated"],
    );
    const log = await readFile(join(dataDir, "logs", "gateway.log"), "utf8");
    assert.equal(
      log.split("\n").filter((line) => line.includes('"model.migrated"'))
        .length,
      1,
    );
  },
);
