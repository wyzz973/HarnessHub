// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { runInit, type Prompter } from "@harnesshub/cli/init";
import { startHub } from "@harnesshub/daemon/main";
import type { HarnessHubClient } from "@harnesshub/sdk/client";
import { connectLocal } from "@harnesshub/sdk/local";
import { HH_ENTRY } from "../support/entries.js";
import {
  startFakeProvider,
  type FakeProvider,
} from "../support/fake-provider.js";
import { temporaryDirectory } from "../support/temporary.js";

// Synthetic values only: they never reach a real service.
const KEY = "sk-synthetic-init-upstream-0001";
const PRESET = "harnesshub-remote";
const MODEL = `${PRESET}/upstream-sim`;

interface Machine {
  client: HarnessHubClient;
  url: string;
  dataDir: string;
  home: string;
  directory: string;
  fake: FakeProvider;
}

/**
 * A daemon whose wiring home has `claude` and `codex` commands (never run)
 * on its PATH, the strict fake upstream that serves the four protocols at
 * its origin, and the file secret backend.
 */
async function machine(t: TestContext): Promise<Machine> {
  const { directory, defer } = await temporaryDirectory(t, "hh-init-");
  const home = path.join(directory, "home");
  const bin = path.join(directory, "bin");
  await mkdir(path.join(home, ".codex"), { recursive: true });
  await mkdir(bin);
  for (const name of ["claude", "codex"]) {
    const command = path.join(
      bin,
      process.platform === "win32" ? `${name}.cmd` : name,
    );
    await writeFile(command, "exit 1\n");
    await chmod(command, 0o755);
  }
  const fake = await startFakeProvider({
    models: ["upstream-sim"],
    keys: { upstream: KEY },
    chunkDelayMs: 0,
  });
  defer(() => fake.close());
  const dataDir = path.join(directory, "data");
  const hub = await startHub({
    dataDir,
    configDir: path.join(directory, "config"),
    secretsBackend: "file",
    demo: true,
    cwd: directory,
    port: 0,
    host: "127.0.0.1",
    catalog: { autoRefresh: false },
    wiringHome: { home, env: { PATH: bin } },
  });
  defer(() => hub.server.close());
  return {
    client: await connectLocal({ dataDir, url: hub.url }),
    url: hub.url,
    dataDir,
    home,
    directory,
    fake,
  };
}

/** Run the real `hh` launcher; stdin is piped, so it is never interactive. */
function hh(
  cwd: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(HH_ENTRY), ...args], {
      cwd,
      env: { ...process.env, ...env },
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
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
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

/** The key Claude Code was wired with, used for one call through the gateway. */
async function callAsClaude(on: Machine): Promise<string | null> {
  const settings = JSON.parse(
    await readFile(path.join(on.home, ".claude", "settings.json"), "utf8"),
  ) as { env: Record<string, string> };
  const info = await on.client.system.info();
  const before = on.fake.records().length;
  const response = await fetch(
    `${info.gateway!.openaiBaseUrl}/chat/completions`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${settings.env.ANTHROPIC_AUTH_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: "hello" }],
      }),
    },
  );
  const text = await response.text();
  assert.equal(response.status, 200, text);
  await on.fake.idle();
  return on.fake.records(before).at(-1)?.keyId ?? null;
}

void test("hh init without a terminal: preset, key from the environment, agents and model from options, wired after --yes", async (t) => {
  const on = await machine(t);
  const common = ["--url", on.url, "--data-dir", on.dataDir];
  const options = [
    "init",
    "--preset",
    PRESET,
    "--base",
    on.fake.url,
    "--credential-from-env",
    "INIT_UPSTREAM_KEY",
    "--agents",
    "claude,codex",
    "--model",
    MODEL,
    "--tier",
    `haiku=${MODEL}`,
    ...common,
  ];
  const env = { INIT_UPSTREAM_KEY: KEY };

  // Missing answers fail with 2 before anything is added.
  const noModel = await hh(
    on.directory,
    options.filter(
      (item, index, all) => item !== "--model" && all[index - 1] !== "--model",
    ),
    env,
  );
  assert.equal(noModel.code, 2, noModel.stderr);
  assert.match(noModel.stderr, /--model/);
  const typo = await hh(on.directory, [
    "init",
    "--preset",
    "deepseak",
    ...common,
  ]);
  assert.equal(typo.code, 2);
  assert.match(typo.stderr, /did you mean deepseek/);
  const noKey = await hh(on.directory, [
    "init",
    "--preset",
    PRESET,
    "--base",
    on.fake.url,
    ...common,
  ]);
  assert.equal(noKey.code, 2);
  assert.match(noKey.stderr, /needs an API key/);
  assert.deepEqual((await on.client.providers.list()).items, []);

  // Without --yes the agents' changes are shown and nothing is wired.
  const unconfirmed = await hh(on.directory, options, env);
  assert.equal(unconfirmed.code, 4, unconfirmed.stderr);
  assert.match(unconfirmed.stdout, /Claude Code \(claude\):/);
  assert.match(unconfirmed.stderr, /pass --yes/);
  assert.equal((await on.client.agents.get("claude")).wiring, null);

  // With --yes: the provider is reused, its models are refreshed, both
  // agents are wired, and Claude Code's call reaches the upstream with the key.
  const done = await hh(on.directory, [...options, "--yes"], env);
  assert.equal(done.code, 0, done.stderr);
  assert.match(
    done.stdout,
    /Provider harnesshub-remote: 1 model \(it was here already\)\./,
  );
  assert.match(
    done.stdout,
    new RegExp(`Wired claude to ${MODEL} \\(haiku=${MODEL}\\)\\.`),
  );
  assert.match(done.stdout, new RegExp(`Wired codex to ${MODEL}\\.`));
  assert.match(done.stdout, /Next: hh usage/);
  assert.doesNotMatch(
    done.stdout + done.stderr + unconfirmed.stdout,
    new RegExp(KEY),
  );
  const provider = await on.client.providers.get(PRESET);
  assert.equal(provider.credentials[0]?.ref.kind, "store");
  assert.equal(provider.endpoints.chat, `${on.fake.url}/v1`);
  const claude = (await on.client.agents.get("claude")).wiring!;
  assert.equal(claude.model, MODEL);
  assert.deepEqual(claude.tiers, { haiku: MODEL });
  assert.equal((await on.client.agents.get("codex")).wiring?.model, MODEL);
  assert.equal(await callAsClaude(on), "upstream");

  // Again: nothing changes, and --json gives the result.
  const again = await hh(on.directory, [...options, "--yes", "--json"], env);
  assert.equal(again.code, 0, again.stderr);
  const result = JSON.parse(again.stdout) as {
    provider: { id: string; created: boolean; models: number };
    agents: Array<{ agent: string; outcome: string }>;
  };
  assert.deepEqual(result.provider, { id: PRESET, created: false, models: 1 });
  assert.deepEqual(
    result.agents.map((item) => [item.agent, item.outcome]),
    [
      ["claude", "unchanged"],
      ["codex", "unchanged"],
    ],
  );
});

void test("hh init explains hh serve when the daemon does not run", async (t) => {
  const { directory } = await temporaryDirectory(t, "hh-init-off-");
  const off = await hh(directory, [
    "init",
    "--url",
    "http://127.0.0.1:9",
    "--data-dir",
    path.join(directory, "data"),
  ]);
  assert.equal(off.code, 3);
  assert.match(off.stderr, /Start it in another terminal with: hh serve/);
});

/** A prompter answering from a script; it fails on a question the script does not expect. */
function scripted(
  answers: Array<[RegExp, string]>,
): Prompter & { notes: string[]; asked: string[] } {
  const notes: string[] = [];
  const asked: string[] = [];
  const next = (question: string) => {
    asked.push(question);
    const answer = answers.shift();
    assert.ok(answer, `no answer scripted for: ${question}`);
    assert.match(question, answer[0]);
    return Promise.resolve(answer[1]);
  };
  return {
    notes,
    asked,
    ask: next,
    secret: next,
    note: (text) => notes.push(text),
  };
}

void test("hh init in a terminal: search a preset, give its base URL and key, pick agents, the model and tiers, confirm", async (t) => {
  const on = await machine(t);
  const prompter = scripted([
    [/^Preset/, "remote"],
    [/^Preset/, "nothing-like-this"],
    [/^Preset/, PRESET],
    [/^Base URL/, "not a url"],
    [/^Base URL/, on.fake.url],
    [/^API key for HarnessHub/, KEY],
    [/^Agents to wire/, "claude, codex"],
    [/^Default model .*Enter for harnesshub-remote\/upstream-sim/, ""],
    [/^Claude Code tiers/, "lunch=x"],
    [/^Claude Code tiers/, `haiku=${MODEL}`],
    [/^Write these changes to claude, codex\? \[y\/N\]/, "y"],
  ]);
  const shown: string[] = [];
  const result = await runInit(on.client, { yes: false }, prompter, (text) =>
    shown.push(text),
  );
  assert.deepEqual(result.provider, { id: PRESET, created: true, models: 1 });
  assert.deepEqual(
    result.agents.map((item) => [item.agent, item.outcome]),
    [
      ["claude", "wired"],
      ["codex", "wired"],
    ],
  );
  const menus = prompter.notes.join("\n");
  assert.match(menus, /Vendors:\n/);
  assert.match(menus, /Relays:\n/);
  assert.match(menus, /Local:\n/);
  assert.match(menus, /No preset matches "nothing-like-this"/);
  assert.match(menus, /lunch is not a tier of Claude Code/);
  assert.match(menus, /Agents installed here:\n.*claude/s);
  // The search narrowed the menu to the remote presets.
  const narrowed = prompter.notes[1]!;
  assert.match(narrowed, /harnesshub-remote/);
  assert.doesNotMatch(narrowed, /deepseek/);
  assert.match(shown.join("\n"), /Claude Code \(claude\):/);
  assert.equal(
    (await on.client.agents.get("claude")).wiring?.tiers?.haiku,
    MODEL,
  );
  assert.equal(await callAsClaude(on), "upstream");
});

void test("hh init in a terminal: declining leaves the agents as they were; a local preset needs no key", async (t) => {
  const on = await machine(t);
  const prompter = scripted([
    [/^Agents to wire/, "codex"],
    [/^Default model/, MODEL],
    [/^Write these changes to codex\?/, "n"],
  ]);
  await assert.rejects(
    runInit(
      on.client,
      { preset: PRESET, base: on.fake.url, credential: KEY, yes: false },
      prompter,
      () => undefined,
    ),
    /Cancelled; no agent was changed/,
  );
  assert.equal((await on.client.agents.get("codex")).wiring, null);
  assert.equal((await on.client.providers.get(PRESET)).credentials.length, 1);

  // Ollama takes no key; its server is a fake upstream that asks for none.
  const keyless = await startFakeProvider({
    models: ["local-sim"],
    chunkDelayMs: 0,
  });
  t.after(() => keyless.close());
  const local = scripted([[/^Agents to wire/, "none"]]);
  const result = await runInit(
    on.client,
    { preset: "ollama", base: keyless.url, yes: false },
    local,
    () => undefined,
  );
  assert.deepEqual(result.provider, { id: "ollama", created: true, models: 1 });
  assert.deepEqual(result.agents, []);
  assert.equal(
    local.asked.some((question) => /API key/.test(question)),
    false,
  );
});
