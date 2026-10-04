// SPDX-License-Identifier: MIT
/**
 * Gateway Key text put where the gateway does not take it from, through the
 * real daemon (security review 2026-10-05, L1 and L2): paths with dot
 * segments, encoded dots or slashes or a leading `//` are refused before
 * dispatch on both listeners; a key under `/K/` or `/%6b/` is not found
 * without the path repeated; a Codex passthrough segment that looks like a
 * key, or is no path Codex calls, is answered locally and never forwarded.
 * In none of these does key text reach a response, the gateway log, the
 * log echo on stderr, the ledger or a file of the data directory. The
 * upstream is the strict fake provider and ChatGPT a loopback stand-in.
 */
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { startHub } from "@harnesshub/daemon/main";
import { connectLocal } from "@harnesshub/sdk/local";
import { startFakeProvider } from "../support/fake-provider.js";
import { startCodexStub } from "../support/codex-stub.js";
import { temporaryDirectory } from "../support/temporary.js";

const UPSTREAM_KEY = "sk-synthetic-key-text-leaks-upstream-3b7e";
const MODEL = "fake/small";
const KEY_IN_PATH = /\/k\/(hhk_a_[a-z2-7]{12}_[A-Za-z0-9_-]{43})\/v1/;
const KEY_IN_CODEX =
  /backend-api\/codex\/(hhk_a_[a-z2-7]{12}_[A-Za-z0-9_-]{43})/;

/** Every file under `root`, recursively. */
async function files(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) found.push(...(await files(full)));
    else if (entry.isFile()) found.push(full);
  }
  return found;
}

/** A request whose path goes out exactly as written (no URL normalization). */
function raw(
  port: number,
  method: string,
  target: string,
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method,
        path: target,
        headers: {
          host: `127.0.0.1:${port}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...headers,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            text: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    outgoing.on("error", reject);
    outgoing.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

/** Everything written to stderr while the test runs (the daemon's log echo), not passed on. */
function captureStderr(t: TestContext): string[] {
  const written: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    written.push(
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
    );
    return true;
  }) as typeof process.stderr.write;
  t.after(() => {
    process.stderr.write = write;
  });
  return written;
}

/** A daemon as `hh serve` runs it (log echo on, debug log), with an agent-scoped provider. */
async function daemon(t: TestContext, prefix: string) {
  const saved = process.env.HARNESSHUB_LOG_LEVEL;
  process.env.HARNESSHUB_LOG_LEVEL = "debug";
  t.after(() => {
    if (saved === undefined) delete process.env.HARNESSHUB_LOG_LEVEL;
    else process.env.HARNESSHUB_LOG_LEVEL = saved;
  });
  const stderr = captureStderr(t);
  const fake = await startFakeProvider({
    models: ["small"],
    keys: { upstream: UPSTREAM_KEY },
    chunkDelayMs: 0,
  });
  t.after(() => fake.close());
  const codex = await startCodexStub(t);
  const { directory, defer } = await temporaryDirectory(t, prefix);
  const home = path.join(directory, "home");
  await mkdir(path.join(home, ".codex"), { recursive: true });
  const dataDir = path.join(directory, "data");
  const configDir = path.join(directory, "config");
  const hub = await startHub({
    dataDir,
    configDir,
    secretsBackend: "file",
    demo: true,
    cwd: directory,
    port: 0,
    host: "127.0.0.1",
    catalog: { autoRefresh: false },
    wiringHome: { home, env: { PATH: path.join(directory, "bin") } },
    codexBackend: codex.url,
    logEcho: true,
  });
  let running = true;
  defer(() => (running ? hub.server.close() : undefined));
  const client = await connectLocal({ dataDir, url: hub.url });
  await client.providers.create({
    id: "fake",
    endpoints: { chat: `${fake.url}/v1`, responses: `${fake.url}/v1` },
    models: { source: "manual", list: [{ id: "small" }], expose: "all" },
    credential: { value: UPSTREAM_KEY },
  });
  return {
    client,
    codex,
    home,
    stderr,
    port: Number(new URL(hub.url).port),
    /** Closes the daemon and returns what it left: the gateway log and every file of the data and config directories. */
    async close(): Promise<{ log: string; files: Map<string, Buffer> }> {
      running = false;
      await hub.server.close();
      const left = new Map<string, Buffer>();
      for (const file of [
        ...(await files(dataDir)),
        ...(await files(configDir)),
      ])
        left.set(path.relative(directory, file), await readFile(file));
      return {
        log: await readFile(path.join(dataDir, "logs", "gateway.log"), "utf8"),
        files: left,
      };
    },
  };
}

/** Fails when any of `secrets` is in `text`; `where` names the place. */
function holdsNone(text: string, secrets: readonly string[], where: string) {
  for (const secret of secrets)
    assert.ok(
      !text.includes(secret),
      `${where} holds ${secret.slice(0, 10)}…: ${text.slice(0, 300)}`,
    );
}

void test(
  "a key in a path the gateway does not take it from is refused or not found, and its text is kept and echoed nowhere",
  { timeout: 120_000 },
  async (t) => {
    const hub = await daemon(t, "hh-key-text-");
    const { client, port } = hub;
    const keys: Record<string, string> = {};
    for (const [id, file] of [
      ["fx", ".fx/settings.json"],
      ["muse", ".config/muse/settings.json"],
    ] as const) {
      await client.agents.wire(id, {
        model: MODEL,
        expect: await client.agents.plan(id, { model: MODEL }),
      });
      const match = KEY_IN_PATH.exec(
        await readFile(path.join(hub.home, file), "utf8"),
      );
      assert.ok(match, `${id}'s base URL holds its key`);
      keys[id] = match[1]!;
    }
    const A = keys.fx!;
    const B = keys.muse!;
    // One character short is no key, but gives all of it away but one.
    const near = A.slice(0, -1);
    const secrets = [A, near, B];
    const responses: string[] = [];
    const expect = async (
      listener: number,
      target: string,
      status: number,
      code?: string,
    ) => {
      const answer = await raw(listener, "GET", target);
      const shown = target.replace(A, "<A>").replace(near, "<A-1>");
      assert.equal(answer.status, status, `${shown}: ${answer.text}`);
      if (code)
        assert.ok(
          answer.text.includes(`"${code}"`),
          `${shown}: ${answer.text}`,
        );
      responses.push(answer.text);
    };

    // The forms the gateway takes still work.
    await expect(port, `/k/${A}/v1/models`, 200);
    await expect(port, `/k/${A}/v1/models/`, 200);
    // Not canonical: refused before dispatch, on the daemon's listener.
    for (const target of [
      `//k/${A}//v1//models`,
      `/k/${A}/../v1/models`,
      `/k/${A}/v1/../v1/models`,
      `/./k/${A}/v1/models`,
      `/x/../k/${A}/v1/models`,
      `/v1/../k/${A}/v1/models`,
      `/k%2F${A}/v1/models`,
      `/k%2f${A}/v1/models`,
      `/%2e/k/${A}/v1/models`,
      `/k/${A}%5Cv1/models`,
      `/k\\${A}/v1/models`,
    ])
      await expect(port, target, 400, "path_not_canonical");
    // Canonical but not the gateway's: not found, the path not repeated.
    for (const target of [
      `/K/${A}/v1/models`,
      `/%6b/${A}/v1/models`,
      `/K/${near}/v1/models`,
    ])
      await expect(port, target, 404);
    await expect(port, `/api/v1/k/${A}`, 401);
    // Not under /k/: no key is taken from the path, and the ledger entry of
    // the refusal does not get it either.
    await expect(port, `/v1beta/k/${A}/v1/models`, 401);
    await expect(port, `/k/${near}/v1/models`, 401);

    // The LAN listener refuses the same paths before choosing a route.
    const shared = await client.gatewayShare.update({
      lan: { enabled: true, host: "127.0.0.1", port: 0 },
    });
    const lan = shared.boundPort!;
    for (const target of [
      `/v1beta/../k/${A}/v1/models`,
      "/v1beta/../api/v1/system/info",
      "/v1beta/..%2Fapi/v1/system/info",
      `//k/${A}/v1/models`,
    ])
      await expect(lan, target, 400, "path_not_canonical");
    await expect(lan, `/k/${A}/v1/models`, 404);
    await client.gatewayShare.update({ lan: { enabled: false } });

    const calls = (await client.modelCalls.list({ limit: 100 })).items;
    assert.ok(
      calls.some(
        (call) =>
          call.status === 401 &&
          call.inbound.path === "/v1beta/k/[REDACTED]/v1/models",
      ),
      JSON.stringify(calls.map((call) => call.inbound.path)),
    );
    for (const call of calls) {
      assert.doesNotMatch(call.inbound.path, /hhk/i);
      holdsNone(JSON.stringify(call), secrets, `ledger ${call.callId}`);
    }

    const left = await hub.close();
    for (const [index, text] of responses.entries())
      holdsNone(text, secrets, `response ${index}`);
    holdsNone(hub.stderr.join(""), secrets, "stderr");
    holdsNone(left.log, secrets, "gateway.log");
    for (const [file, bytes] of left.files)
      holdsNone(bytes.toString("latin1"), secrets, file);
    // The requests were logged, with the key's place redacted.
    const logged = left.log
      .split("\n")
      .filter((line) => line.includes('"event":"http"'))
      .map((line) => JSON.parse(line) as { path?: string; status?: number });
    for (const [pathText, status] of [
      ["/K/[REDACTED]/v1/models", 404],
      ["/%6b/[REDACTED]/v1/models", 404],
      ["/x/../k/[REDACTED]/v1/models", 400],
      ["/api/v1/k/[REDACTED]", 401],
    ] as const)
      assert.ok(
        logged.some(
          (record) => record.path === pathText && record.status === status,
        ),
        `${pathText} ${status} in ${JSON.stringify(logged.map((record) => record.path))}`,
      );
  },
);

void test(
  "a Codex passthrough segment that looks like a key is refused, an unknown path is not found, and neither reaches ChatGPT",
  { timeout: 120_000 },
  async (t) => {
    const hub = await daemon(t, "hh-codex-segment-");
    const { client, codex, port } = hub;
    const options = { codexAuth: "chatgpt" as const };
    await client.agents.wire("codex", {
      model: MODEL,
      options,
      expect: await client.agents.plan("codex", { model: MODEL, options }),
    });
    const match = KEY_IN_CODEX.exec(
      await readFile(path.join(hub.home, ".codex", "config.toml"), "utf8"),
    );
    assert.ok(match, "openai_base_url holds the key");
    const key = match[1]!;
    const near = key.slice(0, -1);
    const upper = key.toUpperCase();
    const secrets = [key, near, upper];
    const signIn = {
      authorization: "Bearer synthetic-chatgpt-access-token-6d1f",
      "chatgpt-account-id": "acct-synthetic-codex-segment-2a9c",
    };
    const body = {
      model: "gpt-5.1-codex",
      stream: true,
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hello" }],
        },
      ],
    };
    const responses: string[] = [];
    const send = async (
      method: "GET" | "POST",
      target: string,
      status: number,
      forwarded: string | undefined,
    ) => {
      const before = codex.requests.length;
      const answer = await raw(
        port,
        method,
        target,
        signIn,
        method === "POST" ? body : undefined,
      );
      const shown = target
        .replace(key, "<KEY>")
        .replace(near, "<KEY-1>")
        .replace(upper, "<KEY upper>");
      assert.equal(answer.status, status, `${shown}: ${answer.text}`);
      assert.deepEqual(
        codex.requests.slice(before).map((request) => request.url),
        forwarded === undefined ? [] : [forwarded],
        shown,
      );
      responses.push(answer.text);
    };

    // ChatGPT's own models still go to ChatGPT, with and without the key.
    await send(
      "POST",
      `/backend-api/codex/${key}/responses`,
      200,
      "/backend-api/codex/responses",
    );
    await send(
      "POST",
      "/backend-api/codex/responses",
      200,
      "/backend-api/codex/responses",
    );
    await send(
      "GET",
      `/backend-api/codex/${key}/models?client_version=1`,
      200,
      "/backend-api/codex/models?client_version=1",
    );
    // Key-like segments that are no valid key: 401 here, nothing forwarded.
    for (const target of [
      `/backend-api/codex/${near}/responses`,
      `/backend-api/codex/${key}%20/responses`,
      `/backend-api/codex/${upper}/models`,
      "/backend-api/codex/hhk_a_garbage/models",
      "/backend-api/codex/HHK%5Fa_garbage/models",
    ])
      await send(
        target.endsWith("responses") ? "POST" : "GET",
        target,
        401,
        undefined,
      );
    // Paths Codex does not call: 404 here, nothing forwarded.
    for (const target of [
      `/backend-api/codex/${key}/wham/usage`,
      "/backend-api/codex/files",
      "/backend-api/codex",
    ])
      await send("GET", target, 404, undefined);

    const calls = (await client.modelCalls.list({ limit: 50 })).items;
    assert.ok(
      calls.some(
        (call) =>
          call.status === 401 &&
          call.inbound.path === "/backend-api/codex/responses",
      ),
      JSON.stringify(calls.map((call) => call.inbound.path)),
    );
    for (const call of calls) {
      assert.doesNotMatch(call.inbound.path, /hhk/i);
      holdsNone(JSON.stringify(call), secrets, `ledger ${call.callId}`);
    }
    const left = await hub.close();
    for (const [index, text] of responses.entries())
      holdsNone(text, secrets, `response ${index}`);
    holdsNone(hub.stderr.join(""), secrets, "stderr");
    holdsNone(left.log, secrets, "gateway.log");
    for (const [file, bytes] of left.files)
      holdsNone(bytes.toString("latin1"), secrets, file);
    for (const request of codex.requests)
      assert.doesNotMatch(request.url, /hhk/i);
  },
);
