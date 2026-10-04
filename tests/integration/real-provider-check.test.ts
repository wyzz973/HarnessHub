// SPDX-License-Identifier: MIT
/**
 * `pnpm test:real` (tests/real/check.ts) checked against the strict fake
 * provider, never a real one: its secret scan finds a key wherever it is,
 * and a whole run reports an upstream that drops tools, passes against one
 * that behaves, and sends nothing in a dry run.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { findSecret } from "../real/scan.js";
import {
  credentialFingerprint,
  startFakeProvider,
  type FakeProvider,
} from "../support/fake-provider.js";
import { temporaryDirectory } from "../support/temporary.js";

const CHECK = fileURLToPath(new URL("../real/check.js", import.meta.url));
const KEY = "sk-synthetic-real-check-6c1f2a";

/** The optional OpenAI fields that `hh provider doctor` probes, which OpenAI's own API takes. */
const OPENAI_FIELDS = {
  chat: {
    declared: {
      topLevel: [
        "stream_options",
        "store",
        "metadata",
        "service_tier",
        "user",
        "parallel_tool_calls",
        "prompt_cache_key",
        "prompt_cache_retention",
        "safety_identifier",
        "verbosity",
        "max_completion_tokens",
      ],
      message: ["refusal"],
    },
  },
};

const OK_TURN = {
  when: { contains: "exactly the word OK" },
  repeat: true,
  text: "OK",
};

async function upstream(
  t: TestContext,
  turns: unknown[],
): Promise<FakeProvider> {
  const fake = await startFakeProvider({
    mode: "whitelist",
    fields: OPENAI_FIELDS,
    chunkDelayMs: 0,
    script: { turns },
  });
  t.after(() => fake.close());
  return fake;
}

/** Runs the check on the fake's four endpoints with one Bearer key. */
function check(
  fake: FakeProvider,
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        CHECK,
        "--chat",
        `${fake.url}/v1`,
        "--responses",
        `${fake.url}/v1`,
        "--anthropic",
        fake.url,
        "--gemini",
        fake.url,
        "--api-key-header",
        "authorization-bearer",
        "--model",
        "upstream-sim",
        "--provider",
        "fake",
        ...args,
      ],
      { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout
      .setEncoding("utf8")
      .on("data", (chunk: string) => (stdout += chunk));
    child.stderr
      .setEncoding("utf8")
      .on("data", (chunk: string) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

void test("the secret scan names every file and output that holds the key, and nothing else", async (t) => {
  const { directory } = await temporaryDirectory(t, "hh-real-scan-");
  await mkdir(path.join(directory, "data", "logs"), { recursive: true });
  await writeFile(
    path.join(directory, "data", "logs", "gateway.log"),
    `upstream key ${KEY} leaked\n`,
  );
  await writeFile(
    path.join(directory, "data", "clean.json"),
    `{"key":"sk-synthetic-other"}`,
  );
  await writeFile(
    path.join(directory, "agent.toml"),
    Buffer.from(`token = "${KEY}"`, "utf8"),
  );
  const roots = [{ label: "<tmp>", directory }];
  const hits = await findSecret(KEY, roots, [
    { name: "hh serve (stderr)", text: `boot ${KEY}` },
    { name: "hh serve (stdout)", text: "ready" },
  ]);
  assert.deepEqual(hits, [
    "<tmp>/agent.toml",
    "<tmp>/data/logs/gateway.log",
    "hh serve (stderr)",
  ]);
  assert.ok(
    hits.every((hit) => !hit.includes(KEY)),
    "names only",
  );
  assert.deepEqual(await findSecret("sk-synthetic-absent-0000", roots), []);
  await assert.rejects(findSecret("short", roots), RangeError);
});

void test("an upstream that drops tools fails every tool round trip after its attempts, in the report", async (t) => {
  const fake = await upstream(t, [
    OK_TURN,
    {
      when: { contains: "weather" },
      repeat: true,
      text: "I cannot look that up.",
    },
  ]);
  const { directory } = await temporaryDirectory(t, "hh-real-key-");
  const keyFile = path.join(directory, "key");
  await writeFile(keyFile, `${KEY}\n`);
  const run = await check(fake, ["--key-file", keyFile, "--attempts", "2"]);
  assert.equal(run.code, 1, run.stderr);
  const rows = run.stdout
    .split("\n")
    .filter((line) => /^\| fake(-chat)?\/upstream-sim \|/.test(line));
  assert.equal(
    rows.length,
    16,
    "both providers, four protocols, streamed and not",
  );
  for (const row of rows) {
    const [, , , text, tool] = row.split(" | ");
    assert.match(text!, /^✓ "OK"/, row);
    assert.match(
      tool!,
      /^✗ answered without calling get_weather .* — failed on attempt 2; earlier: answered without calling get_weather/,
      row,
    );
  }
  assert.match(
    run.stdout,
    /\| tools \| warn \| The model answered without calling get_weather \|/,
    "the doctor reports it as well",
  );
  assert.match(run.stdout, /✓ The upstream key's plaintext is in no file/);
  assert.ok(
    !run.stdout.includes(KEY) && !run.stderr.includes(KEY),
    "no key in the output",
  );
  assert.deepEqual(fake.violations(), []);
});

void test("against an upstream that behaves every check passes, and a dry run sends nothing", async (t) => {
  const fake = await upstream(t, [
    OK_TURN,
    {
      when: { contains: "weather", toolResult: false },
      repeat: true,
      toolCalls: [{ name: "get_weather", arguments: { city: "Paris" } }],
    },
    {
      when: { toolResultContains: "sunny" },
      repeat: true,
      text: "It is sunny in Paris.",
    },
  ]);
  const dry = await check(fake, ["--dry-run"], { HH_REAL_KEY: KEY });
  assert.equal(dry.code, 0, dry.stdout + dry.stderr);
  assert.match(dry.stdout, /Nothing was sent to the provider/);
  assert.match(dry.stdout, /Doctor: \d+ model calls/);
  await fake.idle();
  assert.equal(
    fake.records().filter((record) => record.method === "POST").length,
    0,
  );

  const run = await check(fake, [], { HH_REAL_KEY: KEY });
  assert.equal(run.code, 0, run.stdout);
  assert.match(run.stdout, /\*\*All checks passed\.\*\*/);
  assert.match(
    run.stdout,
    /\| fake\/upstream-sim \| anthropic \| yes \| ✓ "OK".* \| ✓ get_weather\(\{"city":"Paris"\}\) → "It is sunny in Paris\." \| ✓ anthropic, passthrough \|/,
  );
  assert.match(
    run.stdout,
    /\| fake-chat\/upstream-sim \| gemini \| no \| .* \| ✓ chat, translated \|/,
  );
  assert.ok(!run.stdout.includes(KEY) && !run.stderr.includes(KEY));
  assert.deepEqual(fake.violations(), []);
  // The key reached the upstream in the provider's header.
  const fingerprint = await credentialFingerprint(KEY);
  assert.ok(
    fake.records().some((record) => record.keyFingerprint === fingerprint),
  );
});

void test("the key comes from --key-file or HH_REAL_KEY, never both, and arguments are checked first", async (t) => {
  const fake = await upstream(t, [OK_TURN]);
  const { directory } = await temporaryDirectory(t, "hh-real-args-");
  const keyFile = path.join(directory, "key");
  await writeFile(keyFile, KEY);
  const both = await check(fake, ["--key-file", keyFile, "--dry-run"], {
    HH_REAL_KEY: KEY,
  });
  assert.equal(both.code, 2);
  assert.match(both.stderr, /not both/);
  const none = await check(fake, ["--dry-run"], { HH_REAL_KEY: "" });
  assert.equal(none.code, 2);
  assert.match(none.stderr, /No key/);
  const agent = await check(fake, ["--agents", "nobody", "--dry-run"], {
    HH_REAL_KEY: KEY,
  });
  assert.equal(agent.code, 2);
  assert.match(agent.stderr, /Unknown agent nobody/);
});
