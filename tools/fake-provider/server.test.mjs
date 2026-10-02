// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  credentialFingerprint,
  parseCommandLine,
  startFakeProvider,
} from "./index.mjs";
import { authHeaders, callPath, KEY, minimalBody, send } from "./testing.mjs";

const SCRIPT = fileURLToPath(new URL("./index.mjs", import.meta.url));

async function provider(t, options = {}) {
  const fake = await startFakeProvider({
    keys: { main: KEY },
    chunkDelayMs: 0,
    ...options,
  });
  t.after(() => fake.close());
  return fake;
}

async function temporary(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hh-fake-provider-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** Poll `condition` until it holds; fail with `message` after `ms`. */
async function until(condition, message, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(message());
    await delay(10);
  }
}

const timeouts = () =>
  process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;

test("a non-loopback host is rejected before anything listens", async () => {
  for (const host of ["0.0.0.0", "::", "192.0.2.10", "example.com"])
    await assert.rejects(
      startFakeProvider({ host }),
      /listens on loopback only; host .* is not a loopback address/,
      host,
    );
});

test("localhost and 127.0.0.0/8 addresses are accepted", async (t) => {
  for (const host of ["localhost", "127.0.0.1"]) {
    const fake = await provider(t, { host });
    assert.match(fake.url, /^http:\/\/(127\.0\.0\.1|\[::1\]):\d+$/);
    assert.equal((await send(fake, "chat")).answer.text, "OK");
  }
});

/** A stream that waits 30 s between frames: only a cancelled timer ends sooner. */
const STALLED = {
  turns: [{ repeat: true, text: ["first", "second"], chunkDelayMs: 30_000 }],
};

test("a client that disconnects mid-stream leaves no response, timer or socket behind", async (t) => {
  const fake = await provider(t, { script: STALLED });
  const baseline = timeouts();
  const controller = new AbortController();
  const response = await fetch(fake.url + callPath("chat", { stream: true }), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...authHeaders("chat", KEY),
    },
    body: JSON.stringify(minimalBody("chat", { stream: true })),
    signal: controller.signal,
  });
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), /^data: /);
  await until(
    () => fake.activity().timers === 1,
    () =>
      `the stream should wait on one timer: ${JSON.stringify(fake.activity())}`,
  );
  controller.abort();
  await reader.cancel().catch(() => undefined);
  await until(
    () => {
      const { responses, timers, sockets } = fake.activity();
      return responses === 0 && timers === 0 && sockets === 0;
    },
    () =>
      `resources left after the disconnect: ${JSON.stringify(fake.activity())}`,
    2000,
  );
  await fake.idle();
  assert.equal(timeouts(), baseline, "the stream's timer is cleared");
  const [record] = fake.records();
  assert.deepEqual(
    [record.turn, record.status, record.aborted],
    ["script", 200, true],
  );
});

test("close aborts open streams, is idempotent and stops listening", async () => {
  const fake = await startFakeProvider({ script: STALLED });
  const response = await fetch(
    fake.url + callPath("messages", { stream: true }),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(minimalBody("messages", { stream: true })),
    },
  );
  const body = response.text();
  await until(
    () => fake.activity().timers === 1,
    () => "the stream should be waiting",
  );
  const started = Date.now();
  await Promise.all([fake.close(), fake.close()]);
  assert.ok(Date.now() - started < 2000);
  await body.catch(() => undefined);
  assert.deepEqual(fake.activity(), { responses: 0, timers: 0, sockets: 0 });
  await assert.rejects(fetch(`${fake.url}/__fake/health`));
  assert.equal(fake.records()[0].aborted, true);
});

test("the request log endpoint and file hold no prompt, completion or key value", async (t) => {
  const directory = await temporary(t);
  const log = path.join(directory, "requests.jsonl");
  const fake = await provider(t, { logFile: log });
  const prompt = "prompt-canary-7d1e";
  await send(fake, "chat", { text: prompt });
  await send(fake, "gemini", { text: prompt, key: "presented-canary-4c2b" });
  await fake.idle();
  const health = await (await fetch(`${fake.url}/__fake/health`)).json();
  assert.deepEqual(health, {
    ok: true,
    models: ["upstream-sim"],
    mode: "blacklist",
  });
  const listed = await (await fetch(`${fake.url}/__fake/requests`)).json();
  assert.equal(listed.last, 2);
  assert.deepEqual(
    listed.requests.map((record) => [
      record.seq,
      record.protocol,
      record.auth,
      record.keyId,
      record.keyFingerprint,
    ]),
    [
      [1, "chat", "ok", "main", credentialFingerprint(KEY)],
      [
        2,
        "gemini",
        "invalid",
        null,
        credentialFingerprint("presented-canary-4c2b"),
      ],
    ],
  );
  const after = await (
    await fetch(`${fake.url}/__fake/requests?after=1`)
  ).json();
  assert.deepEqual(
    after.requests.map((record) => record.seq),
    [2],
  );
  await fake.close();
  const lines = (await readFile(log, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(lines, fake.records());
  for (const text of [JSON.stringify(listed), await readFile(log, "utf8")])
    for (const secret of [
      prompt,
      KEY,
      "presented-canary-4c2b",
      "OK",
      "short acknowledgement",
    ])
      assert.equal(text.includes(secret), false, secret);
});

test("a log write failure is reported by close", async (t) => {
  const directory = await temporary(t);
  const fake = await startFakeProvider({
    logFile: path.join(directory, "missing", "log.jsonl"),
  });
  await send(fake, "chat", { key: null });
  await fake.idle();
  await assert.rejects(fake.close(), /ENOENT/);
});

test("the command line parses keys from the environment, quirks and files", async (t) => {
  const directory = await temporary(t);
  const script = path.join(directory, "script.json");
  await writeFile(script, JSON.stringify({ turns: [{ text: "scripted" }] }));
  const parsed = await parseCommandLine(
    [
      "--port",
      "0",
      "--model",
      "m1",
      "--model",
      "m2",
      "--key-env",
      "HH_FAKE_KEY",
      "--quirk",
      "noUsage",
      "--quirk",
      'retryAfter={"status":503,"seconds":2}',
      "--quirk",
      "abnormalFinish=OTHER",
      "--script",
      script,
      "--stream-only",
      "--no-reasoning-replay",
    ],
    { HH_FAKE_KEY: KEY },
  );
  assert.deepEqual(parsed.options, {
    port: 0,
    models: ["m1", "m2"],
    keys: { HH_FAKE_KEY: KEY },
    quirks: {
      noUsage: true,
      retryAfter: { status: 503, seconds: 2 },
      abnormalFinish: "OTHER",
    },
    script: { turns: [{ text: "scripted" }] },
    streamOnly: true,
    reasoningReplay: false,
  });
  await assert.rejects(
    parseCommandLine(["--key-env", "HH_FAKE_KEY"], {}),
    /--key-env HH_FAKE_KEY: the environment variable is empty/,
  );
  await assert.rejects(
    parseCommandLine(["--port", "-1"], {}),
    /--port must be a non-negative integer|Unknown option|argument/,
  );
  await assert.rejects(
    parseCommandLine(["--api-key-env", "X"], {}),
    /Unknown option '--api-key-env'/,
  );
  await assert.rejects(
    parseCommandLine(["--script", path.join(directory, "absent.json")], {}),
    /--script .*ENOENT/,
  );
});

test("the command line writes a ready file, serves requests and stops on a signal; a public host fails", async (t) => {
  const directory = await temporary(t);
  const ready = path.join(directory, "ready.json");
  const child = spawn(
    process.execPath,
    [
      SCRIPT,
      "--port",
      "0",
      "--ready-file",
      ready,
      "--key-env",
      "HH_FAKE_KEY",
      "--chunk-delay-ms",
      "0",
    ],
    {
      env: { ...process.env, HH_FAKE_KEY: KEY },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const exited = once(child, "exit");
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  });
  // The ready file appears whole (written, then renamed).
  const deadline = Date.now() + 15_000;
  let announced;
  while (!announced) {
    assert.ok(Date.now() < deadline, "the ready file was not written");
    announced = await readFile(ready, "utf8").then(JSON.parse, () => undefined);
    if (!announced) await delay(20);
  }
  assert.equal(announced.event, "fake-provider.ready");
  assert.equal(announced.mode, "blacklist");
  const result = await send({ url: announced.url }, "messages", {
    stream: true,
  });
  assert.equal(result.answer.text, "OK");
  child.kill("SIGTERM");
  const [code, signal] = await exited;
  if (process.platform !== "win32") assert.equal(code, 0, `signal ${signal}`);

  const rejected = spawn(process.execPath, [SCRIPT, "--host", "0.0.0.0"], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  rejected.stderr.setEncoding("utf8").on("data", (text) => (stderr += text));
  const [status] = await once(rejected, "exit");
  assert.equal(status, 2);
  assert.match(
    stderr,
    /listens on loopback only; host "0.0.0.0" is not a loopback address/,
  );
});
