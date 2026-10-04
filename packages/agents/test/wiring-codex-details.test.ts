// SPDX-License-Identifier: MIT
/**
 * Codex wiring details carried over from Magpie (internal/agent/codex.go):
 * the provider table that stays after unwire, the app's effort list, the
 * subagent settings and CC Switch's provider tables.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import {
  applyWiring,
  detectDrift,
  planWiring,
  unwire,
  type WiringTarget,
} from "../src/wiring/index.js";
import {
  assertUnwound,
  KEY,
  sandbox,
  snapshot,
  TARGET,
  writeFiles,
} from "./wiring-support.js";

const BASE = TARGET.baseUrl;
const CONFIG = ".codex/config.toml";

/** Listed models with levels: `minimal` and `max` are outside the app's default offer. */
const LEVELS: WiringTarget = {
  ...TARGET,
  models: [
    {
      ref: "deepseek/deepseek-chat",
      efforts: ["low", "medium", "high"],
    },
    { ref: "openai/gpt-5", efforts: ["minimal", "low", "medium", "high"] },
    { ref: "anthropic/claude-opus-5-5", efforts: ["low", "high", "max"] },
  ],
};

async function document(home: string): Promise<Record<string, unknown>> {
  return JSON.parse(
    JSON.stringify(parseToml(await readFile(path.join(home, CONFIG), "utf8"))),
  ) as Record<string, unknown>;
}

void test("codex: unwire leaves the provider table without the key, in both modes, and says so", async (t) => {
  for (const options of [
    { codexAuth: "gateway-key" },
    { codexAuth: "chatgpt" },
  ]) {
    const context = await sandbox(t);
    const original = `model = "o3"\n`;
    await writeFiles(context.home, { [CONFIG]: original });
    const { record } = await applyWiring(
      "codex",
      { ...TARGET, options },
      context,
    );
    const wired = await document(context.home);
    assert.deepEqual(wired.model_providers, {
      harnesshub: {
        name: "HarnessHub",
        base_url: `${BASE}/v1`,
        wire_api: "responses",
        experimental_bearer_token: KEY.keyText,
      },
    });
    const result = await unwire(record, context);
    const config = result.files.find((file) =>
      file.path.endsWith("config.toml"),
    )!;
    assert.deepEqual(
      [config.action, config.kept],
      ["restored", [["model_providers", "harnesshub"]]],
    );
    await assertUnwound("codex", context.home, { [CONFIG]: original });
  }
});

void test("codex: a provider table the user had is restored as it was, not kept", async (t) => {
  const context = await sandbox(t);
  const original = `[model_providers.harnesshub]\nname = "mine"\nbase_url = "http://127.0.0.1:9/v1"\n`;
  await writeFiles(context.home, { [CONFIG]: original });
  const { record } = await applyWiring("codex", TARGET, context);
  const result = await unwire(record, context);
  assert.equal(
    result.files.find((file) => file.path.endsWith("config.toml"))!.kept,
    undefined,
  );
  assert.equal(
    await readFile(path.join(context.home, CONFIG), "utf8"),
    original,
  );
});

void test("codex: the app's effort list gains the levels the listed models take, after the user's, and only when one is missing", async (t) => {
  const efforts = async (home: string) =>
    ((await document(home)).desktop as Record<string, unknown> | undefined)?.[
      "enabled-reasoning-efforts"
    ];
  // No list: the app offers its defaults, which lack minimal and max.
  const fresh = await sandbox(t);
  let { record } = await applyWiring("codex", LEVELS, fresh);
  assert.deepEqual(await efforts(fresh.home), [
    "low",
    "medium",
    "high",
    "xhigh",
    "ultra",
    "persistent",
    "minimal",
    "max",
  ]);
  // Wired again, what the first wiring added stays.
  ({ record } = await applyWiring("codex", LEVELS, fresh, {
    previous: record,
  }));
  assert.equal(((await efforts(fresh.home)) as string[]).length, 8);
  assert.equal((await detectDrift(record, fresh)).drifted, false);

  // The user's own list keeps its order; only what is missing is added.
  const mine = await sandbox(t);
  const original = `[desktop]\nenabled-reasoning-efforts = ["high", "low"] # mine\n`;
  await writeFiles(mine.home, { [CONFIG]: original });
  ({ record } = await applyWiring("codex", LEVELS, mine));
  assert.deepEqual(await efforts(mine.home), [
    "high",
    "low",
    "minimal",
    "medium",
    "max",
  ]);
  await unwire(record, mine);
  await assertUnwound("codex", mine.home, { [CONFIG]: original });

  // Nothing missing from the defaults, or a list it cannot read: untouched.
  const covered = await sandbox(t);
  await applyWiring(
    "codex",
    { ...TARGET, models: [{ ref: TARGET.model, efforts: ["low", "high"] }] },
    covered,
  );
  assert.equal(await efforts(covered.home), undefined);
  const odd = await sandbox(t);
  await writeFiles(odd.home, {
    [CONFIG]: `[desktop]\nenabled-reasoning-efforts = "all"\n`,
  });
  await applyWiring("codex", LEVELS, odd);
  assert.equal(await efforts(odd.home), "all");
});

void test("codex: subagents follow the subagent tier or the wired model, and a level the model does not take goes", async (t) => {
  const agents = async (home: string) =>
    (await document(home)).agents as Record<string, unknown> | undefined;
  // Nothing of the user's and no tier: subagents follow the session.
  const plain = await sandbox(t);
  await applyWiring("codex", LEVELS, plain);
  assert.equal(await agents(plain.home), undefined);

  // A tier of their own.
  const tier = await sandbox(t);
  await applyWiring(
    "codex",
    { ...LEVELS, tiers: { subagent: "openai/gpt-5" } },
    tier,
  );
  assert.deepEqual(await agents(tier.home), {
    default_subagent_model: "openai/gpt-5",
  });

  // The user's subagent model and a level deepseek does not take.
  const mine = await sandbox(t);
  const original = `[agents]\ndefault_subagent_model = "gpt-5.1-codex-mini"\ndefault_subagent_reasoning_effort = "max"\nmax_threads = 4\n`;
  await writeFiles(mine.home, { [CONFIG]: original });
  let { record } = await applyWiring("codex", LEVELS, mine);
  assert.deepEqual(await agents(mine.home), {
    default_subagent_model: "deepseek/deepseek-chat",
    max_threads: 4,
  });
  // With an effort the model takes, the user's level becomes that.
  ({ record } = await applyWiring(
    "codex",
    { ...LEVELS, effort: "high" },
    mine,
    { previous: record },
  ));
  assert.deepEqual(await agents(mine.home), {
    default_subagent_model: "deepseek/deepseek-chat",
    default_subagent_reasoning_effort: "high",
    max_threads: 4,
  });
  await unwire(record, mine);
  await assertUnwound("codex", mine.home, { [CONFIG]: original });

  // Codex keeping its own model in ChatGPT mode keeps the user's subagents.
  const own = await sandbox(t);
  await writeFiles(own.home, { [CONFIG]: original });
  await applyWiring(
    "codex",
    {
      baseUrl: BASE,
      ...KEY,
      models: LEVELS.models,
      options: { codexAuth: "chatgpt" },
    },
    own,
  );
  assert.deepEqual(await agents(own.home), {
    default_subagent_model: "gpt-5.1-codex-mini",
    default_subagent_reasoning_effort: "max",
    max_threads: 4,
  });
});

void test("codex: CC Switch's provider tables go through the gateway with the key while wired, and come back on unwire", async (t) => {
  const context = await sandbox(t);
  const original = [
    `model_provider = "custom"`,
    ``,
    `[model_providers.custom]`,
    `name = "relay"`,
    `base_url = "https://relay.example.test/v1"`,
    `wire_api = "responses"`,
    `requires_openai_auth = true`,
    ``,
    `[model_providers.cc-switch-2]`,
    `name = "older"`,
    `base_url = "https://older.example.test/v1"`,
    `env_key = "OLDER_KEY"`,
    ``,
    `[model_providers.cc-switch-official]`,
    `name = "official"`,
    `base_url = "https://official.example.test/v1"`,
    ``,
    `[model_providers.cc-switch]`,
    `name = "picked"`,
    `base_url = "https://picked.example.test/v1"`,
    ``,
    `[profiles.work]`,
    `model_provider = "cc-switch"`,
    ``,
  ].join("\n");
  await writeFiles(context.home, { [CONFIG]: original });
  const plan = await planWiring("codex", TARGET, context);
  assert.ok(!JSON.stringify(plan).includes(KEY.keyText));
  const { record } = await applyWiring("codex", TARGET, context, {
    expect: plan,
  });
  const providers = (await document(context.home)).model_providers as Record<
    string,
    Record<string, unknown>
  >;
  const gateway = {
    base_url: `${BASE}/v1`,
    experimental_bearer_token: KEY.keyText,
  };
  assert.deepEqual(providers.custom, {
    name: "relay",
    wire_api: "responses",
    ...gateway,
  });
  assert.deepEqual(providers["cc-switch-2"], { name: "older", ...gateway });
  // CC Switch's own proxy to OpenAI, and a table a profile picks: left alone.
  assert.deepEqual(providers["cc-switch-official"], {
    name: "official",
    base_url: "https://official.example.test/v1",
  });
  assert.deepEqual(providers["cc-switch"], {
    name: "picked",
    base_url: "https://picked.example.test/v1",
  });
  assert.equal((await detectDrift(record, context)).drifted, false);
  await unwire(record, context);
  await assertUnwound("codex", context.home, { [CONFIG]: original });
  assert.ok(
    (await snapshot(context.home))[CONFIG]!.includes(
      `base_url = "https://relay.example.test/v1"`,
    ),
  );
});
