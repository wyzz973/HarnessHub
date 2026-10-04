// SPDX-License-Identifier: MIT
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import {
  applyWiring,
  detectDrift,
  planWiring,
  unwire,
  wiredKeyText,
  WiringError,
  type WiringModel,
  type WiringTarget,
} from "../src/wiring/index.js";
import {
  KEY,
  NEW_KEY,
  sandbox,
  snapshot,
  writeFiles,
} from "./wiring-support.js";

const BASE = "http://127.0.0.1:3180";

/** Gateway models with the metadata wiring writes: windows, levels, image input and native protocols. */
const MODELS: WiringModel[] = [
  {
    ref: "anthropic/claude-opus-5-5",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    efforts: ["low", "medium", "high", "xhigh", "max"],
    images: true,
    nativeProtocols: ["anthropic"],
  },
  {
    ref: "deepseek/deepseek-chat",
    contextWindow: 128_000,
    maxOutputTokens: 384_000,
    efforts: ["low", "medium", "high"],
    nativeProtocols: ["chat", "anthropic"],
  },
  {
    ref: "openai/gpt-5",
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    efforts: ["minimal", "low", "medium", "high"],
    images: true,
    nativeProtocols: ["responses"],
  },
  { ref: "group/fast", contextWindow: 64_000 },
];

const TARGET: WiringTarget = {
  baseUrl: BASE,
  ...KEY,
  model: "deepseek/deepseek-chat",
  models: MODELS,
};

async function rejectsWith(promise: Promise<unknown>, code: string) {
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof WiringError && error.code === code,
  );
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

void test("claude: tiers get their own models, 1M models are marked [1m], and the window, capabilities and effort go where Claude Code reads them", async (t) => {
  const context = await sandbox(t);
  const settings = path.join(context.home, ".claude", "settings.json");
  await writeFiles(context.home, {
    ".claude/settings.json": `{
  "model": "opus",
  "env": { "CLAUDE_CODE_SUBAGENT_MODEL": "claude-haiku-4-5", "CLAUDE_CODE_EFFORT_LEVEL": "max" }
}
`,
  });
  const original = await readFile(settings, "utf8");
  const { record } = await applyWiring(
    "claude",
    {
      ...TARGET,
      model: "anthropic/claude-opus-5-5",
      tiers: { haiku: "deepseek/deepseek-chat", sonnet: "group/fast" },
      effort: "high",
    },
    context,
  );
  const wired = await json(settings);
  assert.equal(at(wired, "model"), "anthropic/claude-opus-5-5[1m]");
  assert.deepEqual(at(wired, "env"), {
    ANTHROPIC_BASE_URL: BASE,
    ANTHROPIC_AUTH_TOKEN: KEY.keyText,
    ANTHROPIC_MODEL: "anthropic/claude-opus-5-5[1m]",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "anthropic/claude-opus-5-5[1m]",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "group/fast",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek/deepseek-chat",
    ANTHROPIC_DEFAULT_FABLE_MODEL: "anthropic/claude-opus-5-5[1m]",
    ANTHROPIC_SMALL_FAST_MODEL: "deepseek/deepseek-chat",
    // The main model is marked [1m], so the window is the smallest of the unmarked tiers'.
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: "64000",
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: "128000",
    // The chosen models first; Claude Code's own levels for its models.
    CLAUDE_CODE_MODEL_CAPABILITIES:
      "anthropic/claude-opus-5-5=effort,xhigh_effort,max_effort;deepseek/deepseek-chat=effort;openai/gpt-5=effort",
  });
  // Tiers of their own: one subagent model would override them, so it is
  // removed; so is the user's environment effort, which outranks settings.
  // Opus 5.5 reads only modelSettings.
  assert.deepEqual(at(wired, "modelSettings"), {
    "claude-opus-5-5": { effortLevel: "high" },
  });
  assert.equal(at(wired, "effortLevel"), undefined);
  assert.deepEqual(record.tiers, {
    haiku: "deepseek/deepseek-chat",
    sonnet: "group/fast",
  });
  assert.equal(record.effort, "high");
  assert.equal((await detectDrift(record, context)).drifted, false);

  // Re-adding a removed entry overrides the wiring: drift.
  await writeFile(
    settings,
    (await readFile(settings, "utf8")).replace(
      '"env": {',
      '"env": {\n    "CLAUDE_CODE_SUBAGENT_MODEL": "x/y",',
    ),
  );
  const drift = await detectDrift(record, context);
  assert.deepEqual(drift.kinds, ["replaced"]);
  assert.deepEqual(drift.findings[0]?.keyPath, [
    "env",
    "CLAUDE_CODE_SUBAGENT_MODEL",
  ]);
  // The file changed since wiring: HarnessHub's entries get their original values back.
  const result = await unwire(record, context);
  assert.deepEqual(
    result.files.map((file) => file.action),
    ["reverse-patched"],
  );
  assert.deepEqual(await json(settings), JSON.parse(original));
});

void test("claude: with every tier on the main model, subagents follow it, max effort goes to the environment, and another vendor's model reads the top-level effort", async (t) => {
  const context = await sandbox(t);
  const settings = path.join(context.home, ".claude", "settings.json");
  const first = await applyWiring(
    "claude",
    { ...TARGET, effort: "max" },
    context,
  );
  let wired = await json(settings);
  assert.equal(
    at(wired, "env", "CLAUDE_CODE_SUBAGENT_MODEL"),
    "deepseek/deepseek-chat",
  );
  assert.equal(at(wired, "env", "CLAUDE_CODE_EFFORT_LEVEL"), "max");
  assert.equal(at(wired, "env", "CLAUDE_CODE_MAX_CONTEXT_TOKENS"), "128000");
  assert.equal(at(wired, "effortLevel"), undefined);

  const second = await applyWiring(
    "claude",
    { ...TARGET, ...NEW_KEY, effort: "medium" },
    context,
    { previous: first.record },
  );
  wired = await json(settings);
  assert.equal(at(wired, "env", "CLAUDE_CODE_EFFORT_LEVEL"), undefined);
  assert.equal(at(wired, "effortLevel"), "medium");
  assert.equal(at(wired, "modelSettings"), undefined);
  const result = await unwire(second.record, context);
  assert.deepEqual(
    result.files.map((file) => file.action),
    ["deleted"],
  );
});

void test("claude: tiers and effort outside what Claude Code takes are refused", async (t) => {
  const context = await sandbox(t);
  await rejectsWith(
    planWiring("claude", { ...TARGET, effort: "minimal" }, context),
    "WIRING_TARGET_INVALID",
  );
  await rejectsWith(
    planWiring(
      "claude",
      { ...TARGET, tiers: { large: "a/b" } as unknown as { opus: string } },
      context,
    ),
    "WIRING_TARGET_INVALID",
  );
  await rejectsWith(
    planWiring("codex", { ...TARGET, tiers: { opus: "a/b" } }, context),
    "WIRING_TARGET_INVALID",
  );
  await rejectsWith(
    planWiring("gemini", { ...TARGET, effort: "high" }, context),
    "WIRING_TARGET_INVALID",
  );
});

void test("codex: the API mode generates a model catalog with windows, levels and image input, and the preview summarises it", async (t) => {
  const context = await sandbox(t);
  const plan = await planWiring(
    "codex",
    { ...TARGET, model: "openai/gpt-5", effort: "high" },
    context,
  );
  const shown = plan.files.find((file) => file.id === "catalog")!;
  assert.match(
    shown.diff,
    /^@@ generated by HarnessHub: absent -> \d+ bytes, \d+ lines @@$/m,
  );
  assert.match(shown.changes[0]!.after!, /… \(\d+ characters\)$/);
  const { record } = await applyWiring(
    "codex",
    { ...TARGET, model: "openai/gpt-5", effort: "high" },
    context,
    { expect: plan },
  );
  const config = parseToml(
    await readFile(path.join(context.home, ".codex", "config.toml"), "utf8"),
  );
  const catalogPath = path.join(
    context.home,
    ".codex",
    "harnesshub-models.json",
  );
  assert.equal(config.model_catalog_json, catalogPath);
  assert.equal(config.model_reasoning_effort, "high");
  assert.equal(config.model_provider, "harnesshub");
  assert.equal(config.model_context_window, undefined);
  const catalog = at(await json(catalogPath), "models") as Array<
    Record<string, unknown>
  >;
  assert.deepEqual(
    catalog.map((model) => [
      model.slug,
      model.context_window,
      model.default_reasoning_level,
      (model.supported_reasoning_levels as Array<{ effort: string }>).map(
        (level) => level.effort,
      ),
      model.input_modalities,
      model.priority,
    ]),
    [
      [
        "anthropic/claude-opus-5-5",
        1_000_000,
        "medium",
        ["low", "medium", "high", "xhigh", "max"],
        ["text", "image"],
        1,
      ],
      [
        "deepseek/deepseek-chat",
        128_000,
        "medium",
        ["low", "medium", "high"],
        ["text"],
        2,
      ],
      [
        "openai/gpt-5",
        400_000,
        "medium",
        ["minimal", "low", "medium", "high"],
        ["text", "image"],
        3,
      ],
      ["group/fast", 64_000, undefined, [], ["text"], 4],
    ],
  );
  if (process.platform !== "win32")
    assert.equal((await stat(catalogPath)).mode & 0o777, 0o600);
  const result = await unwire(record, context);
  assert.deepEqual(
    result.files.map((file) => file.action),
    ["deleted", "deleted"],
  );
  assert.deepEqual(await snapshot(context.home), {});
});

void test("codex: web search stays on only for a model whose provider takes Responses natively", async (t) => {
  // Codex 0.144.5 sends its hosted web_search tool on every turn; the
  // gateway cannot translate it, so Codex failed against a Chat upstream.
  const settings = async (model: string) => {
    const context = await sandbox(t);
    await applyWiring("codex", { ...TARGET, model }, context);
    return parseToml(
      await readFile(path.join(context.home, ".codex", "config.toml"), "utf8"),
    );
  };
  assert.equal(
    (await settings("deepseek/deepseek-chat")).web_search,
    "disabled",
  );
  assert.equal((await settings("group/fast")).web_search, "disabled");
  assert.equal((await settings("openai/gpt-5")).web_search, undefined);
  // An unknown model (no metadata) has no native protocols either.
  const context = await sandbox(t);
  await applyWiring(
    "codex",
    { baseUrl: BASE, ...KEY, model: "other/m", models: [] },
    context,
  );
  assert.match(
    await readFile(path.join(context.home, ".codex", "config.toml"), "utf8"),
    /^web_search = "disabled"$/m,
  );
});

void test("codex: the ChatGPT mode writes only openai_base_url, takes no key or model, and switching modes restores what the other wrote", async (t) => {
  const context = await sandbox(t);
  const original = `model = "gpt-5.5-codex"\n`;
  await writeFiles(context.home, { ".codex/config.toml": original });
  const chatgpt: WiringTarget = {
    baseUrl: BASE,
    models: [],
    options: { codexAuth: "chatgpt" },
  };
  for (const wrong of [
    { ...chatgpt, ...KEY },
    { ...chatgpt, model: "deepseek/deepseek-chat" },
    { ...chatgpt, effort: "high" as const },
  ])
    await rejectsWith(
      planWiring("codex", wrong, context),
      "WIRING_TARGET_INVALID",
    );
  await rejectsWith(
    planWiring(
      "codex",
      { ...TARGET, options: { codexAuth: "other" } },
      context,
    ),
    "WIRING_TARGET_INVALID",
  );
  await rejectsWith(
    planWiring("codex", { ...TARGET, options: { mode: "x" } }, context),
    "WIRING_TARGET_INVALID",
  );
  // Gateway-key mode needs a key.
  await rejectsWith(
    planWiring("codex", { baseUrl: BASE, models: [], model: "a/b" }, context),
    "WIRING_TARGET_INVALID",
  );

  const plan = await planWiring("codex", chatgpt, context);
  assert.equal(plan.keyId, undefined);
  assert.equal(plan.model, undefined);
  assert.deepEqual(
    plan.files.flatMap((file) => file.changes.map((change) => change.keyPath)),
    [["openai_base_url"]],
  );
  const { record } = await applyWiring("codex", chatgpt, context, {
    expect: plan,
  });
  assert.equal(record.keyId, undefined);
  assert.equal(record.model, undefined);
  assert.deepEqual(record.options, { codexAuth: "chatgpt" });
  const config = path.join(context.home, ".codex", "config.toml");
  assert.equal(
    await readFile(config, "utf8"),
    `${original}openai_base_url = "${BASE}/backend-api/codex"\n`,
  );
  assert.deepEqual(Object.keys(await snapshot(context.home)), [
    ".codex/config.toml",
  ]);
  assert.equal(await wiredKeyText(record, context), undefined);
  assert.equal((await detectDrift(record, context)).drifted, false);
  await writeFile(
    config,
    `${original}openai_base_url = "https://elsewhere.example/backend-api/codex"\n`,
  );
  assert.deepEqual((await detectDrift(record, context)).kinds, [
    "foreign-gateway",
  ]);
  await writeFile(
    config,
    `${original}openai_base_url = "${BASE}/backend-api/codex"\n`,
  );

  // Switching to the API mode drops openai_base_url; back again drops the provider.
  const api = await applyWiring("codex", TARGET, context, { previous: record });
  const text = await readFile(config, "utf8");
  assert.doesNotMatch(text, /openai_base_url/);
  assert.match(text, /^model_provider = "harnesshub"$/m);
  const back = await applyWiring("codex", chatgpt, context, {
    previous: api.record,
  });
  assert.equal(
    await readFile(config, "utf8"),
    `${original}openai_base_url = "${BASE}/backend-api/codex"\n`,
  );
  await unwire(back.record, context);
  assert.deepEqual(await snapshot(context.home), {
    ".codex/config.toml": original,
  });
});

void test("opencode, pi and crush carry each model's limits, reasoning levels, image input and, for Pi, its native protocol", async (t) => {
  const context = await sandbox(t);
  const target = { ...TARGET, effort: "high" as const };
  await applyWiring("opencode", TARGET, context);
  await applyWiring("pi", target, context);
  await applyWiring("crush", target, context);

  const models = at(
    await json(path.join(context.home, ".config", "opencode", "opencode.json")),
    "provider",
    "harnesshub",
    "models",
  );
  assert.deepEqual(at(models, "anthropic/claude-opus-5-5"), {
    name: "anthropic/claude-opus-5-5",
    attachment: true,
    modalities: { input: ["text", "image"], output: ["text"] },
    limit: { context: 1_000_000, output: 128_000 },
    variants: {
      low: { reasoningEffort: "low" },
      medium: { reasoningEffort: "medium" },
      high: { reasoningEffort: "high" },
      xhigh: { reasoningEffort: "xhigh" },
      max: { reasoningEffort: "max" },
    },
  });
  // An output above the window is cut to it; a group without levels gets no variants.
  assert.deepEqual(at(models, "deepseek/deepseek-chat", "limit"), {
    context: 128_000,
    output: 128_000,
  });
  assert.deepEqual(at(models, "group/fast"), {
    name: "group/fast",
    limit: { context: 64_000, output: 0 },
    variants: {},
  });

  const pi = await json(path.join(context.home, ".pi", "agent", "models.json"));
  const piModels = Object.fromEntries(
    (at(pi, "providers", "harnesshub", "models") as Array<{ id: string }>).map(
      (model) => [model.id, model],
    ),
  );
  assert.deepEqual(piModels["anthropic/claude-opus-5-5"], {
    id: "anthropic/claude-opus-5-5",
    name: "anthropic/claude-opus-5-5",
    api: "anthropic-messages",
    baseUrl: BASE,
    reasoning: true,
    input: ["text", "image"],
    thinkingLevelMap: {
      minimal: "low",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  });
  assert.equal(at(piModels, "openai/gpt-5", "api"), "openai-responses");
  assert.equal(at(piModels, "openai/gpt-5", "baseUrl"), undefined);
  assert.equal(at(piModels, "deepseek/deepseek-chat", "api"), undefined);
  assert.deepEqual(at(piModels, "deepseek/deepseek-chat", "thinkingLevelMap"), {
    minimal: "low",
    low: "low",
    medium: "medium",
    high: "high",
  });
  assert.deepEqual(piModels["group/fast"], {
    id: "group/fast",
    name: "group/fast",
    reasoning: false,
    input: ["text"],
    contextWindow: 64_000,
  });
  const piSettings = await json(
    path.join(context.home, ".pi", "agent", "settings.json"),
  );
  assert.equal(at(piSettings, "defaultThinkingLevel"), "high");

  const crush = await json(
    path.join(context.home, ".config", "crush", "crush.json"),
  );
  assert.deepEqual(at(crush, "providers", "harnesshub", "models", 0), {
    id: "anthropic/claude-opus-5-5",
    name: "anthropic/claude-opus-5-5",
    context_window: 1_000_000,
    default_max_tokens: 128_000,
    can_reason: true,
    reasoning_levels: ["low", "medium", "high", "xhigh", "max"],
    default_reasoning_effort: "medium",
    supports_attachments: true,
  });
  assert.equal(
    at(crush, "providers", "harnesshub", "models", 3, "can_reason"),
    false,
  );
  assert.deepEqual(at(crush, "models", "large"), {
    model: "deepseek/deepseek-chat",
    provider: "harnesshub",
    reasoning_effort: "high",
  });
  await rejectsWith(
    planWiring("crush", { ...TARGET, effort: "max" }, context),
    "WIRING_TARGET_INVALID",
  );
});

void test("gemini: a window below the 1M Gemini assumes sets the compression threshold", async (t) => {
  const context = await sandbox(t);
  const file = path.join(context.home, ".gemini", "settings.json");
  await applyWiring("gemini", TARGET, context);
  // 80% of 128K, as a fraction of 1,048,576, rounded up to four places.
  assert.equal(at(await json(file), "model", "compressionThreshold"), 0.0977);
  // A window at least as large as Gemini's own assumption changes nothing.
  const large = await sandbox(t);
  await applyWiring(
    "gemini",
    {
      ...TARGET,
      model: "google/gemini-3-pro",
      models: [{ ref: "google/gemini-3-pro", contextWindow: 2_000_000 }],
    },
    large,
  );
  assert.equal(
    at(
      await json(path.join(large.home, ".gemini", "settings.json")),
      "model",
      "compressionThreshold",
    ),
    undefined,
  );
});

void test("wiredKeyText recovers the wired key from the files until the user replaces it", async (t) => {
  const context = await sandbox(t);
  const { record } = await applyWiring("opencode", TARGET, context);
  assert.equal(await wiredKeyText(record, context), KEY.keyText);
  const file = path.join(context.home, ".config", "opencode", "opencode.json");
  await writeFile(
    file,
    (await readFile(file, "utf8")).replace(KEY.keyText, NEW_KEY.keyText),
  );
  assert.equal(await wiredKeyText(record, context), undefined);

  // A key inside a list item (T3 Code's environment list) is found too.
  const t3 = await sandbox(t);
  const wired = await applyWiring("t3code", TARGET, t3);
  assert.equal(await wiredKeyText(wired.record, t3), KEY.keyText);
});
