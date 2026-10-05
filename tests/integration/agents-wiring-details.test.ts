// SPDX-License-Identifier: MIT
/**
 * Magpie's wiring details for Claude Code and Codex through the daemon and
 * the real `hh` entry: the restart notice, Claude Code's managed settings
 * that override the wiring (read from a relocated system root, never
 * written), and Codex's provider table that stays after unwire, its
 * subagent settings, the Codex app's effort list and CC Switch's tables.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { editors } from "@harnesshub/agents/wiring/formats/index";
import { wiringAdapter } from "@harnesshub/agents/wiring/index";
import { startHub } from "@harnesshub/daemon/main";
import { connectLocal } from "@harnesshub/sdk/local";
import { HH_ENTRY } from "../support/entries.js";
import { startFakeProvider } from "../support/fake-provider.js";
import { temporaryDirectory } from "../support/temporary.js";

const UPSTREAM_KEY = "sk-synthetic-wiring-details-0001";
const POLICY = JSON.stringify({
  env: { ANTHROPIC_BASE_URL: "https://proxy.corp.example.test" },
  permissions: { deny: ["WebFetch"] },
});
const CODEX = [
  `model = "o3"`,
  ``,
  `[agents]`,
  `default_subagent_model = "gpt-5.1-codex-mini"`,
  ``,
  `[model_providers.custom]`,
  `name = "relay"`,
  `base_url = "https://relay.example.test/v1"`,
  `requires_openai_auth = true`,
  ``,
].join("\n");

async function setup(t: TestContext) {
  const { directory, defer } = await temporaryDirectory(t, "hh-wiredet-");
  const home = path.join(directory, "home");
  const codex = path.join(home, ".codex", "config.toml");
  await mkdir(path.dirname(codex), { recursive: true });
  await writeFile(codex, CODEX);
  // An administrator's Claude Code policy, where this platform keeps it.
  const systemRoot = path.join(directory, "system");
  const [managed] = wiringAdapter("claude").managedFiles!(process.platform);
  const policy = path.join(systemRoot, managed!.replace(/^[A-Za-z]:/, ""));
  await mkdir(path.dirname(policy), { recursive: true });
  await writeFile(policy, POLICY);
  const upstream = await startFakeProvider({
    models: ["big", "small"],
    keys: { upstream: UPSTREAM_KEY },
    chunkDelayMs: 0,
  });
  defer(() => upstream.close());
  const dataDir = path.join(directory, "data");
  const hub = await startHub({
    dataDir,
    configDir: path.join(directory, "config"),
    secretsBackend: "file",
    demo: true,
    cwd: directory,
    port: 0,
    host: "127.0.0.1",
    wiringHome: {
      home,
      env: { PATH: path.join(directory, "bin") },
      systemRoot,
    },
  });
  defer(() => hub.server.close());
  const client = await connectLocal({ dataDir, url: hub.url });
  await client.providers.create({
    id: "fake",
    endpoints: { chat: `${upstream.url}/v1` },
    models: {
      source: "manual",
      list: [
        { id: "big", contextWindow: 400_000, reasoning: true },
        { id: "small", contextWindow: 200_000 },
      ],
      expose: "all",
    },
    credential: { value: UPSTREAM_KEY },
  });
  const run = (...args: string[]) =>
    hh(home, [...args, "--url", hub.url, "--data-dir", dataDir]);
  return { client, home, codex, policy, managed: managed!, run };
}

void test("the restart notice and Claude Code's managed settings are in the preview, the view and hh wire's output; the policy is never written", async (t) => {
  const { client, policy, managed, run } = await setup(t);
  const plan = await client.agents.plan("claude", { model: "fake/small" });
  assert.match(plan.notice ?? "", /restart/i);
  assert.deepEqual(plan.managed, [
    { path: managed, keyPaths: [["env", "ANTHROPIC_BASE_URL"]] },
  ]);
  const wired = await client.agents.wire("claude", {
    model: "fake/small",
    expect: plan,
  });
  assert.equal(wired.notice, plan.notice);
  assert.deepEqual(wired.wiring?.managed, plan.managed);
  assert.deepEqual((await client.agents.get("claude")).wiring?.managed, [
    { path: managed, keyPaths: [["env", "ANTHROPIC_BASE_URL"]] },
  ]);
  // Agents without a policy or a notice have neither.
  const gemini = await client.agents.get("gemini");
  assert.equal(gemini.wiring, null);

  const cli = await run("wire", "claude", "fake/big", "--yes");
  assert.equal(cli.code, 0, cli.stderr);
  assert.ok(
    cli.stdout.includes(
      `Warning: ${managed} (an administrator's managed settings) sets env.ANTHROPIC_BASE_URL, which wins over the wiring.`,
    ),
    cli.stdout,
  );
  assert.ok(cli.stdout.includes(plan.notice!), cli.stdout);
  assert.equal(await readFile(policy, "utf8"), POLICY);

  // A directory where the policy should be (another user may make one in a
  // shared system path): a warning that it could not be read, not a 500.
  await rm(policy);
  await mkdir(policy);
  const again = await client.agents.plan("claude", { model: "fake/small" });
  assert.deepEqual(again.managed, [{ path: managed, keyPaths: [] }]);
  assert.deepEqual((await client.agents.get("claude")).wiring?.managed, [
    { path: managed, keyPaths: [] },
  ]);
});

void test("Codex keeps its provider table after unwire, follows the wired model for subagents, offers the levels the models take and takes CC Switch's table along", async (t) => {
  const { client, codex, run } = await setup(t);
  const plan = await client.agents.plan("codex", {
    model: "fake/big",
    effort: "high",
  });
  assert.match(plan.notice ?? "", /restart the Codex app/);
  assert.equal(plan.managed, undefined);
  const wired = await run(
    "wire",
    "codex",
    "fake/big",
    "--effort",
    "high",
    "--yes",
  );
  assert.equal(wired.code, 0, wired.stderr);
  assert.ok(wired.stdout.includes(plan.notice!), wired.stdout);
  const config = JSON.parse(
    JSON.stringify(editors.toml.parse(await readFile(codex, "utf8"))),
  ) as Record<string, Record<string, unknown>>;
  const key = (config.model_providers!.harnesshub as Record<string, string>)
    .experimental_bearer_token!;
  assert.match(key, /^hhk_a_/);
  assert.deepEqual(config.agents, {
    default_subagent_model: "fake/big",
    default_subagent_reasoning_effort: "high",
  });
  // The Codex app already offers every level these models take: untouched.
  assert.equal(config.desktop, undefined);
  assert.deepEqual(config.model_providers!.custom, {
    name: "relay",
    base_url: (config.model_providers!.harnesshub as Record<string, string>)
      .base_url,
    experimental_bearer_token: key,
  });

  const unwired = await run("unwire", "codex", "--yes");
  assert.equal(unwired.code, 0, unwired.stderr);
  assert.match(unwired.stdout, /^kept\s+model_providers\.harnesshub$/m);
  assert.ok(unwired.stdout.includes(plan.notice!), unwired.stdout);
  const after = await readFile(codex, "utf8");
  assert.ok(after.startsWith(CODEX), after);
  assert.doesNotMatch(after, /hhk_/);
  const left = JSON.parse(JSON.stringify(editors.toml.parse(after))) as Record<
    string,
    Record<string, unknown>
  >;
  assert.deepEqual(Object.keys(left.model_providers!), [
    "custom",
    "harnesshub",
  ]);
  assert.deepEqual(left.model_providers!.harnesshub, {
    name: "HarnessHub",
    base_url: (config.model_providers!.harnesshub as Record<string, string>)
      .base_url,
    wire_api: "responses",
  });
  assert.equal((await client.agents.get("codex")).wiring, null);
});

/** Run the real `hh` launcher with piped stdin, so it is never interactive. */
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
    child.stdout
      .setEncoding("utf8")
      .on("data", (chunk: string) => (stdout += chunk));
    child.stderr
      .setEncoding("utf8")
      .on("data", (chunk: string) => (stderr += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    child.stdin.end("");
  });
}
