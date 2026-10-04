// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { startHub } from "@harnesshub/daemon/main";
import { HarnessHubError } from "@harnesshub/sdk/client";
import { connectLocal } from "@harnesshub/sdk/local";
import { HH_ENTRY } from "../support/entries.js";
import { startFakeProvider } from "../support/fake-provider.js";
import { temporaryDirectory } from "../support/temporary.js";

const UPSTREAM_KEY = "sk-synthetic-wiring-semantics-0001";
const BIG = "fake/big";
const SMALL = "fake/small";
const OTHER = "fake/other";
const CODEX_ORIGINAL = `model = "gpt-5.5-codex" # mine\n`;

function problem(code: string, status?: number) {
  return (error: unknown) => {
    assert.ok(error instanceof HarnessHubError, String(error));
    assert.equal(error.code, code, JSON.stringify(error.problem));
    if (status !== undefined) assert.equal(error.status, status);
    return true;
  };
}

/**
 * A daemon whose wiring home is a temporary directory holding a Codex
 * configuration, and a provider on the strict fake upstream with a 1M
 * reasoning model that takes images, a small one and a third one.
 */
async function setup(t: TestContext) {
  const { directory, defer } = await temporaryDirectory(t, "hh-wiresem-");
  const home = path.join(directory, "home");
  await mkdir(path.join(home, ".codex"), { recursive: true });
  await writeFile(path.join(home, ".codex", "config.toml"), CODEX_ORIGINAL);
  const upstream = await startFakeProvider({
    models: ["big", "small", "other", "later"],
    keys: { upstream: UPSTREAM_KEY },
    // Translated calls (ChatGPT-mode Codex's Responses) ask for streamed usage.
    fields: { chat: { allowed: { topLevel: ["stream_options"] } } },
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
    wiringHome: { home, env: { PATH: path.join(directory, "bin") } },
  });
  defer(() => hub.server.close());
  const client = await connectLocal({ dataDir, url: hub.url });
  await client.providers.create({
    id: "fake",
    name: "Fake",
    kind: "custom",
    endpoints: { chat: `${upstream.url}/v1` },
    models: {
      source: "manual",
      list: [
        {
          id: "big",
          contextWindow: 1_000_000,
          maxOutputTokens: 64_000,
          reasoning: true,
          inputModalities: ["text", "image"],
        },
        { id: "small", contextWindow: 200_000, maxOutputTokens: 8_192 },
        { id: "other", contextWindow: 128_000, maxOutputTokens: 4_096 },
      ],
      expose: "all",
    },
    credential: { value: UPSTREAM_KEY },
  });
  const info = await client.system.info();
  return {
    client,
    url: hub.url,
    home,
    dataDir,
    origin: info.gateway!.anthropicBaseUrl,
    v1: info.gateway!.openaiBaseUrl,
    codex: path.join(home, ".codex", "config.toml"),
  };
}

async function json(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, "utf8")) as unknown;
}

/** The value at a path of parsed JSON, or undefined. */
function at(value: unknown, ...keys: Array<string | number>): unknown {
  let current = value;
  for (const key of keys)
    current =
      typeof current === "object" && current !== null
        ? (current as Record<string | number, unknown>)[key]
        : undefined;
  return current;
}

async function listed(v1: string, key: string): Promise<string[]> {
  const response = await fetch(`${v1}/models`, {
    headers: { authorization: `Bearer ${key}` },
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { data: Array<{ id: string }> };
  return body.data.map((model) => model.id).sort();
}

/** A Responses call on the Codex passthrough, as ChatGPT-mode Codex sends one; `key` goes in the path. */
async function codexResponses(
  origin: string,
  key: string | undefined,
  model: string,
): Promise<{ status: number; text: string }> {
  const response = await fetch(
    `${origin}/backend-api/codex${key ? `/${key}` : ""}/responses`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Codex's own ChatGPT sign-in, which never leaves for a HarnessHub model.
        authorization: "Bearer synthetic-chatgpt-token",
        "chatgpt-account-id": "acct-synthetic",
      },
      body: JSON.stringify({
        model,
        stream: false,
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "hello" }],
          },
        ],
      }),
    },
  );
  return { status: response.status, text: await response.text() };
}

async function chat(v1: string, key: string, model: string): Promise<number> {
  const response = await fetch(`${v1}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "hello" }],
    }),
  });
  await response.arrayBuffer();
  return response.status;
}

async function exists(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false,
  );
}

void test("Claude Code gets its tiers, the [1m] mark for a 1M model, the window for the unmarked tiers, capabilities and effort, and the key calls every tier's model", async (t) => {
  const { client, home, v1 } = await setup(t);
  const settings = path.join(home, ".claude", "settings.json");
  const plan = await client.agents.plan("claude", {
    model: BIG,
    tiers: { haiku: SMALL, sonnet: OTHER },
    effort: "high",
  });
  const agent = await client.agents.wire("claude", {
    model: BIG,
    tiers: { haiku: SMALL, sonnet: OTHER },
    effort: "high",
    expect: plan,
  });
  assert.deepEqual(agent.capabilities.tiers, [
    "opus",
    "sonnet",
    "haiku",
    "fable",
    "subagent",
  ]);
  assert.equal(agent.wiring?.model, BIG);
  assert.deepEqual(agent.wiring?.tiers, { haiku: SMALL, sonnet: OTHER });
  assert.equal(agent.wiring?.effort, "high");
  const wired = await json(settings);
  const env = at(wired, "env") as Record<string, string>;
  assert.equal(env.ANTHROPIC_MODEL, `${BIG}[1m]`);
  assert.equal(at(wired, "model"), `${BIG}[1m]`);
  assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, `${BIG}[1m]`);
  assert.equal(env.ANTHROPIC_DEFAULT_FABLE_MODEL, `${BIG}[1m]`);
  assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, OTHER);
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, SMALL);
  assert.equal(env.ANTHROPIC_SMALL_FAST_MODEL, SMALL);
  assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, undefined);
  // The smallest window of the tiers that are not marked [1m].
  assert.equal(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "128000");
  // Only the reasoning model takes an effort.
  assert.equal(env.CLAUDE_CODE_MODEL_CAPABILITIES, `${BIG}=effort`);
  // Another vendor's model reads the top-level effort.
  assert.equal(at(wired, "effortLevel"), "high");
  // Claude Code strips [1m] before asking; the key may call every tier's model.
  for (const model of [BIG, SMALL, OTHER])
    assert.equal(await chat(v1, env.ANTHROPIC_AUTH_TOKEN!, model), 200);

  // Tiers back on the main model: subagents follow it again.
  await client.agents.wire("claude", {
    tiers: {},
    expect: await client.agents.plan("claude", { tiers: {} }),
  });
  const again = at(await json(settings), "env") as Record<string, string>;
  assert.equal(again.ANTHROPIC_DEFAULT_HAIKU_MODEL, `${BIG}[1m]`);
  assert.equal(again.CLAUDE_CODE_SUBAGENT_MODEL, `${BIG}[1m]`);
  assert.equal(again.CLAUDE_CODE_MAX_CONTEXT_TOKENS, undefined);
  await assert.rejects(
    client.agents.plan("claude", { effort: "minimal" }),
    problem("WIRING_TARGET_INVALID", 400),
  );
  await assert.rejects(
    client.agents.plan("claude", { tiers: { haiku: "fake/absent" } }),
    problem("AGENT_MODEL_UNAVAILABLE", 400),
  );
  await client.agents.unwire("claude");
  assert.equal(await exists(settings), false);
});

void test("Codex in API mode lists a generated catalog; in ChatGPT mode it keeps its sign-in and gets openai_base_url with its key, and a model only when named", async (t) => {
  const { client, codex, home, origin, v1 } = await setup(t);
  const catalog = path.join(home, ".codex", "harnesshub-models.json");

  // ChatGPT mode from scratch: one line, the key in its path, Codex's own model.
  const chatgptPlan = await client.agents.plan("codex", {
    options: { codexAuth: "chatgpt" },
  });
  assert.equal(chatgptPlan.model, undefined);
  const signedIn = await client.agents.wire("codex", {
    options: { codexAuth: "chatgpt" },
    expect: chatgptPlan,
  });
  const wired = await readFile(codex, "utf8");
  const base = new RegExp(
    `^${CODEX_ORIGINAL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}openai_base_url = "${origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/backend-api/codex/(hhk_a_[a-z2-7]{12}_[A-Za-z0-9_-]{43})"\n$`,
  ).exec(wired);
  assert.ok(base, wired);
  const chatgptKey = base[1]!;
  assert.equal(await exists(catalog), false);
  assert.equal(signedIn.wiring?.keyState, "active");
  assert.equal(signedIn.wiring?.model, undefined);
  assert.deepEqual(signedIn.wiring?.options, { codexAuth: "chatgpt" });
  assert.equal(signedIn.wiring?.drift?.drifted, false);
  // The key serves HarnessHub's models on the Codex path, never on its own.
  const served = await codexResponses(origin, chatgptKey, SMALL);
  assert.equal(served.status, 200, served.text);
  assert.equal(
    (await codexResponses(origin, undefined, SMALL)).status,
    401,
    "without the key a HarnessHub model fails here",
  );
  // Tiers or an effort need a model; a named one becomes Codex's default.
  await assert.rejects(
    client.agents.plan("codex", { effort: "high" }),
    problem("AGENT_WIRING_INVALID", 400),
  );
  const named = await client.agents.wire("codex", {
    model: BIG,
    effort: "high",
    expect: await client.agents.plan("codex", { model: BIG, effort: "high" }),
  });
  assert.equal(named.wiring?.model, BIG);
  assert.match(await readFile(codex, "utf8"), /^model = "fake\/big"/m);
  assert.match(
    await readFile(codex, "utf8"),
    /^model_reasoning_effort = "high"$/m,
  );
  // The key changed with the wiring: the old one is revoked.
  assert.equal((await codexResponses(origin, chatgptKey, SMALL)).status, 401);
  const own = await client.agents.wire("codex", {
    model: null,
    expect: await client.agents.plan("codex", { model: null }),
  });
  assert.equal(own.wiring?.model, undefined);
  assert.doesNotMatch(
    await readFile(codex, "utf8"),
    /^model_reasoning_effort/m,
  );
  assert.match(
    await readFile(codex, "utf8"),
    /^model = "gpt-5.5-codex" # mine$/m,
  );

  // API mode: a key, the provider, the catalog with each model's metadata.
  const apiPlan = await client.agents.plan("codex", {
    model: SMALL,
    effort: "medium",
    options: { codexAuth: "gateway-key" },
  });
  assert.match(
    apiPlan.files.find((file) => file.path === catalog)!.diff,
    /generated by HarnessHub: absent -> \d+ bytes/,
  );
  const api = await client.agents.wire("codex", {
    model: SMALL,
    effort: "medium",
    options: { codexAuth: "gateway-key" },
    expect: apiPlan,
  });
  assert.equal(api.wiring?.keyState, "active");
  const config = await readFile(codex, "utf8");
  assert.doesNotMatch(config, /openai_base_url/);
  assert.match(config, /^model_provider = "harnesshub"$/m);
  assert.match(config, /^model_reasoning_effort = "medium"$/m);
  assert.ok(config.includes(`model_catalog_json = ${JSON.stringify(catalog)}`));
  const models = at(await json(catalog), "models") as Array<
    Record<string, unknown>
  >;
  assert.deepEqual(
    models.map((model) => [
      model.slug,
      model.context_window,
      model.default_reasoning_level,
      model.input_modalities,
    ]),
    [
      [BIG, 1_000_000, "medium", ["text", "image"]],
      [SMALL, 200_000, undefined, ["text"]],
      [OTHER, 128_000, undefined, ["text"]],
    ],
  );
  const key = /^experimental_bearer_token = "(hhk_a_[^"]+)"$/m.exec(
    config,
  )![1]!;
  assert.equal(await chat(v1, key, SMALL), 200);

  // Back to ChatGPT mode: the provider entries go, the model with them, and
  // the API mode's key is revoked.
  const back = await client.agents.wire("codex", {
    options: { codexAuth: "chatgpt" },
    expect: await client.agents.plan("codex", {
      options: { codexAuth: "chatgpt" },
    }),
  });
  assert.equal(back.wiring?.model, undefined);
  assert.match(
    await readFile(codex, "utf8"),
    new RegExp(
      `^model = "gpt-5\\.5-codex" # mine\nopenai_base_url = ".+/backend-api/codex/hhk_a_[^"]+"\n$`,
    ),
  );
  assert.equal(await chat(v1, key, SMALL), 401);
  const unwired = await client.agents.unwire("codex");
  assert.equal(unwired.agent.wiring, null);
  assert.equal(await readFile(codex, "utf8"), CODEX_ORIGINAL);
  assert.equal(await exists(catalog), false);
});

void test("hiding and showing models changes the agent's written list and what its key may list and call, without a new key", async (t) => {
  const { client, home, v1, url, dataDir } = await setup(t);
  const config = path.join(home, ".config", "opencode", "opencode.json");
  const written = async () =>
    Object.keys(
      at(await json(config), "provider", "harnesshub", "models") as object,
    ).sort();
  const keyOf = async () =>
    at(
      await json(config),
      "provider",
      "harnesshub",
      "options",
      "apiKey",
    ) as string;

  const plan = await client.agents.plan("opencode", { model: SMALL });
  const wired = await client.agents.wire("opencode", {
    model: SMALL,
    expect: plan,
  });
  const key = await keyOf();
  assert.deepEqual(wired.wiring?.models, [BIG, SMALL, OTHER]);
  assert.deepEqual(wired.wiring?.hidden, []);
  assert.deepEqual(await written(), [BIG, OTHER, SMALL]);
  assert.deepEqual(await listed(v1, key), [BIG, OTHER, SMALL]);

  const hidden = await client.agents.setHidden("opencode", [BIG]);
  assert.equal(hidden.wiring?.keyId, wired.wiring?.keyId);
  assert.deepEqual(hidden.wiring?.models, [SMALL, OTHER]);
  assert.deepEqual(hidden.wiring?.hidden, [BIG]);
  assert.equal(await keyOf(), key);
  assert.deepEqual(await written(), [OTHER, SMALL]);
  assert.deepEqual(await listed(v1, key), [OTHER, SMALL]);
  assert.equal(await chat(v1, key, BIG), 403);
  assert.equal(await chat(v1, key, SMALL), 200);
  assert.equal(hidden.wiring?.drift?.drifted, false);

  // A model added to the gateway later is shown by default.
  await client.providers.update("fake", {
    models: {
      source: "manual",
      list: [
        { id: "big", contextWindow: 1_000_000, reasoning: true },
        { id: "small", contextWindow: 200_000 },
        { id: "other", contextWindow: 128_000 },
        { id: "later" },
      ],
      expose: "all",
    },
  });
  assert.deepEqual(await listed(v1, key), ["fake/later", OTHER, SMALL]);

  await assert.rejects(
    client.agents.setHidden("opencode", [SMALL]),
    problem("AGENT_MODEL_IN_USE", 409),
  );
  await assert.rejects(
    client.agents.setHidden("opencode", ["not a ref"]),
    problem("INVALID_REQUEST", 400),
  );
  await assert.rejects(
    client.agents.plan("opencode", { model: BIG }),
    problem("AGENT_MODEL_IN_USE", 409),
  );

  // Shown again, through the real hh entry.
  const shown = await hh(home, [
    "agents",
    "models",
    "opencode",
    "--show",
    BIG,
    "--json",
    "--url",
    url,
    "--data-dir",
    dataDir,
  ]);
  assert.equal(shown.code, 0, shown.stderr);
  const view = JSON.parse(shown.stdout) as {
    wiring: { models: string[]; hidden: string[] };
  };
  assert.deepEqual(view.wiring.hidden, []);
  assert.deepEqual(await written(), [BIG, "fake/later", OTHER, SMALL]);
  assert.deepEqual(await listed(v1, key), [BIG, "fake/later", OTHER, SMALL]);
  assert.equal(await chat(v1, key, BIG), 200);
});

void test("a profile saves every wired agent's choices and applying it switches them back, previewed and confirmed", async (t) => {
  const { client, codex, home, origin, url, dataDir } = await setup(t);
  const settings = path.join(home, ".claude", "settings.json");
  for (const [id, input] of [
    ["claude", { model: BIG, tiers: { haiku: SMALL }, effort: "high" }],
    ["codex", { model: SMALL }],
  ] as const)
    await client.agents.wire(id, {
      ...input,
      expect: await client.agents.plan(id, input),
    });
  const saved = await client.profiles.save("work");
  assert.deepEqual(saved.agents, {
    claude: { model: BIG, tiers: { haiku: SMALL }, effort: "high" },
    codex: { model: SMALL, options: { codexAuth: "gateway-key" } },
  });
  const workClaude = await readFile(settings, "utf8");

  // Switch both away: Claude to another model, Codex to its ChatGPT sign-in.
  await client.agents.wire("claude", {
    model: OTHER,
    tiers: {},
    effort: null,
    expect: await client.agents.plan("claude", {
      model: OTHER,
      tiers: {},
      effort: null,
    }),
  });
  await client.agents.wire("codex", {
    options: { codexAuth: "chatgpt" },
    expect: await client.agents.plan("codex", {
      options: { codexAuth: "chatgpt" },
    }),
  });
  assert.match(await readFile(codex, "utf8"), /backend-api\/codex/);
  await client.profiles.save("chatgpt");

  const plan = await client.profiles.plan("work");
  assert.deepEqual(
    plan.agents.map((agent) => [agent.adapterId, agent.changed]),
    [
      ["claude", true],
      ["codex", true],
    ],
  );
  const applied = await client.profiles.apply("work", plan);
  assert.deepEqual(
    applied.agents.map((agent) => [agent.adapterId, agent.outcome]),
    [
      ["claude", "applied"],
      ["codex", "applied"],
    ],
  );
  // The same files as when saved, with the new key in place of the old.
  const restored = await readFile(settings, "utf8");
  assert.equal(
    restored.replace(/hhk_a_[\w-]+/g, "KEY"),
    workClaude.replace(/hhk_a_[\w-]+/g, "KEY"),
  );
  const config = await readFile(codex, "utf8");
  assert.match(config, /^model = "fake\/small"/m);
  assert.doesNotMatch(config, /openai_base_url/);
  assert.deepEqual(
    (await client.profiles.plan("work")).agents.map((agent) => agent.changed),
    [false, false],
  );

  // A plan made before a change no longer applies.
  const stale = await client.profiles.plan("chatgpt");
  await client.agents.wire("claude", {
    model: SMALL,
    expect: await client.agents.plan("claude", { model: SMALL }),
  });
  await client.agents.unwire("codex");
  await assert.rejects(
    client.profiles.apply("chatgpt", {
      agents: stale.agents.filter((agent) => agent.adapterId === "claude"),
    }),
    problem("PROFILE_PLAN_STALE", 409),
  );
  assert.equal(await readFile(codex, "utf8"), CODEX_ORIGINAL);

  // Through the real hh entry: list, apply with --yes, remove.
  const run = (...args: string[]) =>
    hh(home, [...args, "--url", url, "--data-dir", dataDir]);
  const list = await run("profile", "list");
  assert.equal(list.code, 0, list.stderr);
  assert.match(list.stdout, /^chatgpt\s+claude,codex/m);
  const cliApply = await run("profile", "apply", "chatgpt", "--yes");
  assert.equal(cliApply.code, 0, cliApply.stderr);
  assert.match(cliApply.stdout, /^applied\s+codex$/m);
  const cliWired = await readFile(codex, "utf8");
  assert.ok(
    cliWired.startsWith(
      `${CODEX_ORIGINAL}openai_base_url = "${origin}/backend-api/codex/hhk_a_`,
    ),
    cliWired,
  );
  assert.doesNotMatch(cliApply.stdout + cliApply.stderr, /hhk_a_\w{12}_/);
  assert.equal((await run("profile", "rm", "chatgpt")).code, 0);
  await assert.rejects(
    client.profiles.get("chatgpt"),
    problem("PROFILE_NOT_FOUND", 404),
  );
  await assert.rejects(
    client.profiles.save("bad name"),
    problem("INVALID_REQUEST", 400),
  );
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
