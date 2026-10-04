// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { Ajv } from "ajv";
import { isProviderConfig } from "@harnesshub/core/model-plane-records";
import {
  choosePreset,
  isProviderPreset,
  PresetChoiceError,
  presetForProvider,
  providerFromPreset,
  providerPresetSchema,
  type ProviderPreset,
} from "@harnesshub/core/provider-presets";
import {
  checkPreset,
  getPreset,
  listPresets,
  resolveMagpiePreset,
} from "@harnesshub/gateway/presets";

/** The shipped preset files, read from the gateway package. */
const directory = path.join(
  path.dirname(
    createRequire(import.meta.url).resolve("@harnesshub/gateway/presets"),
  ),
  "..",
  "..",
  "presets",
);
const files = readdirSync(directory).filter((name) => name.endsWith(".json"));

void test("every shipped preset matches the JSON Schema and expands to a valid provider", () => {
  // An independent compile of the published schema, strict, as a check of the data.
  const validate = new Ajv({ allErrors: true, strict: true }).compile(
    providerPresetSchema,
  );
  assert.ok(files.length >= 15);
  for (const file of files) {
    const value: unknown = JSON.parse(
      readFileSync(path.join(directory, file), "utf8"),
    );
    assert.equal(
      validate(value),
      true,
      `${file}: ${JSON.stringify(validate.errors)}`,
    );
    assert.equal(isProviderPreset(value), true, file);
  }
  const presets = listPresets();
  assert.deepEqual(
    presets.map((preset) => preset.id),
    files.map((file) => file.replace(/\.json$/, "")).sort(),
  );
  // Every region and plan of every preset expands to a valid provider that
  // records the choice; a preset whose URL the user supplies needs one.
  let choices = 0;
  for (const preset of presets)
    for (const region of preset.regions ?? [undefined])
      for (const plan of preset.plans ?? [undefined]) {
        choices += 1;
        const provider = providerFromPreset(preset, {
          ...(region ? { region: region.id } : {}),
          ...(plan ? { plan: plan.id } : {}),
          ...(preset.userEndpoint ? { endpoints: preset.endpoints } : {}),
          now: "2026-10-02T00:00:00.000Z",
        });
        const where = `${preset.id} ${region?.id ?? ""} ${plan?.id ?? ""}`;
        assert.ok(isProviderConfig(provider), where);
        assert.equal(provider.preset, preset.id);
        assert.equal(provider.region, region?.id);
        assert.equal(provider.plan, plan?.id);
        assert.deepEqual(provider.credentials, []);
        assert.deepEqual(
          provider.endpoints,
          plan?.endpoints ?? region?.endpoints ?? preset.endpoints,
          where,
        );
        if (preset.userEndpoint)
          assert.throws(
            () => providerFromPreset(preset, { now: provider.createdAt }),
            (error: unknown) =>
              error instanceof PresetChoiceError &&
              error.code === "ENDPOINT_REQUIRED",
          );
      }
  assert.ok(choices > presets.length, `${choices} choices`);
  // Data taken from Magpie says so, and is unverified unless checked again.
  for (const preset of presets)
    if (preset.source !== undefined)
      assert.equal(preset.source, "magpie@2e340f7", preset.id);
  assert.equal(getPreset("openai")?.name, "OpenAI");
  assert.equal(getPreset("nope"), undefined);
  // Overrides replace endpoints by protocol and keep the others.
  const deepseek = getPreset("deepseek")!;
  const custom = providerFromPreset(deepseek, {
    id: "team",
    name: "Team",
    endpoints: { chat: "https://relay.example.test/v1" },
    now: "2026-10-02T00:00:00.000Z",
  });
  assert.equal(custom.id, "team");
  assert.equal(custom.name, "Team");
  assert.equal(custom.endpoints.chat, "https://relay.example.test/v1");
  assert.equal(custom.endpoints.anthropic, deepseek.endpoints.anthropic);
});

void test("invalid preset files are refused with the reason", () => {
  const valid = {
    schemaVersion: 1,
    id: "sample",
    name: "Sample",
    kind: "vendor",
    verified: "2026-10-02",
    auth: { methods: ["api-key"], apiKeyHeader: "authorization-bearer" },
    endpoints: { chat: "https://api.example.test/v1" },
    models: { source: "live" },
  };
  assert.equal(checkPreset("sample.json", JSON.stringify(valid)).id, "sample");
  const cases: Array<[unknown, RegExp]> = [
    [{ ...valid, verified: "yesterday" }, /verified/],
    [{ ...valid, verified: undefined }, /verified/],
    [{ ...valid, kind: "cloud" }, /kind/],
    [{ ...valid, unknown: true }, /additional/],
    [{ ...valid, endpoints: {} }, /endpoints/],
    [
      { ...valid, endpoints: { sse: "https://api.example.test/v1" } },
      /additional/,
    ],
    [
      { ...valid, auth: { methods: [], apiKeyHeader: "authorization-bearer" } },
      /methods/,
    ],
    [{ ...valid, website: "http://example.test" }, /website/],
    [{ ...valid, models: { source: "manual" } }, /source/],
    // Rules beyond the schema: base-URL convention and file name.
    [
      {
        ...valid,
        endpoints: { chat: "https://api.example.test/v1/chat/completions" },
      },
      /endpoints\.chat must be the base URL/,
    ],
    [
      { ...valid, endpoints: { anthropic: "https://api.example.test/v1" } },
      /endpoints\.anthropic must not end with the API version/,
    ],
    [{ ...valid, endpoints: { chat: "http://api.example.test/v1" } }, /HTTPS/],
    [{ ...valid, id: "other" }, /its id is other/],
  ];
  for (const [sample, reason] of cases)
    assert.throws(
      () => checkPreset("sample.json", JSON.stringify(sample)),
      reason,
      JSON.stringify(sample),
    );
  assert.throws(() => checkPreset("sample.json", "{"), /not JSON/);
});

/** Magpie's 51 presets at yetone/magpie@2e340f7 (`internal/provider/presets.go:76-409`). */
const MAGPIE_PRESETS = [
  ...["anthropic", "openai", "google", "deepseek", "xai", "moonshot"],
  ...["moonshot-cn", "kimi-code", "kimi-code-cn", "zhipu", "zai", "minimax"],
  ...["minimax-cn", "stepfun", "stepfun-cn", "xiaomi", "baidu-qianfan"],
  ...["tencent-token-plan", "tencent-tokenhub", "tencent-tokenhub-cn"],
  ...["huaweicloud", "volcengine", "qwen", "qwen-cn", "mistral", "groq"],
  ...["bedrock", "azure", "ollama-cloud", "openrouter", "opencode-go"],
  ...["clinepass", "opencode-zen", "kilo", "commandcode", "together"],
  ...["fireworks", "siliconflow", "nvidia", "modelscope", "aihubmix"],
  ...["pipellm", "302ai", "cherryin", "yylx", "remote-magpie", "typesafe"],
  ...["vercel-jev", "cloudflare-jev", "ollama", "lmstudio"],
];
/** Decision APIs route groups and never chat; HarnessHub has no such provider. */
const MAGPIE_DECISION_PRESETS = ["typesafe", "vercel-jev", "cloudflare-jev"];

void test("every Magpie preset but its decision APIs maps to a shipped preset", () => {
  assert.equal(MAGPIE_PRESETS.length, 51);
  for (const id of MAGPIE_PRESETS) {
    const resolved = resolveMagpiePreset(id);
    if (MAGPIE_DECISION_PRESETS.includes(id)) {
      assert.equal(resolved, undefined, id);
      continue;
    }
    assert.ok(resolved, id);
    // The implied region and plan exist.
    choosePreset(resolved.preset, resolved);
  }
  // Pairs Magpie keeps apart are regions here, with Magpie's meaning kept.
  assert.deepEqual(
    [resolveMagpiePreset("moonshot"), resolveMagpiePreset("moonshot-cn")].map(
      (item) => [item?.preset.id, item?.region],
    ),
    [
      ["moonshot", "global"],
      ["moonshot", "cn"],
    ],
  );
  assert.equal(resolveMagpiePreset("qwen")?.preset.id, "dashscope");
  assert.equal(resolveMagpiePreset("google")?.preset.id, "gemini-openai");
  assert.equal(
    resolveMagpiePreset("qianfan-token-plan")?.preset.id,
    "baidu-qianfan",
  );
  assert.equal(
    resolveMagpiePreset("remote-magpie")?.preset.id,
    "magpie-remote",
  );
  // Magpie's single list of choices: a region, else a plan.
  assert.deepEqual(resolveMagpiePreset("zhipu", "coding"), {
    preset: getPreset("zhipu"),
    plan: "coding",
  });
  assert.deepEqual(resolveMagpiePreset("bedrock", "eu-west-1"), {
    preset: getPreset("bedrock"),
    region: "eu-west-1",
  });
  assert.equal(resolveMagpiePreset("zhipu", "mars")?.region, "mars");
  assert.equal(resolveMagpiePreset("vllm-nope"), undefined);
});

const sample: ProviderPreset = {
  schemaVersion: 1,
  id: "sample",
  name: "Sample",
  kind: "vendor",
  catalog: "sample",
  keysUrl: "https://example.test/keys",
  verified: "unverified",
  auth: { methods: ["api-key"], apiKeyHeader: "authorization-bearer" },
  endpoints: {
    chat: "https://cn.example.test/plan/v1",
    anthropic: "https://cn.example.test/plan",
  },
  regions: [
    {
      id: "cn",
      name: "China",
      endpoints: {
        chat: "https://cn.example.test/plan/v1",
        anthropic: "https://cn.example.test/plan",
      },
    },
    {
      id: "global",
      name: "Global",
      endpoints: { chat: "https://global.example.test/v1" },
      keysUrl: "https://global.example.test/keys",
      catalog: "sample-global",
    },
  ],
  plans: [
    { id: "plan", name: "Plan", models: ["a", "b"] },
    {
      id: "api",
      name: "Pay as you go",
      endpoints: { chat: "https://cn.example.test/v1" },
      modelSource: "live",
      catalog: "sample-api",
    },
  ],
  models: { source: "static" },
  fallbackModels: ["x"],
};

void test("a region and a plan choose endpoints, key page, catalog and models", () => {
  const defaults = choosePreset(sample);
  assert.equal(defaults.region?.id, "cn");
  assert.equal(defaults.plan?.id, "plan");
  assert.deepEqual(defaults.preset.endpoints, sample.endpoints);
  assert.deepEqual(defaults.preset.models, {
    source: "static",
    list: [{ id: "a" }, { id: "b" }],
  });
  // The region's endpoints and key page; the plan has no endpoints of its own.
  const global = choosePreset(sample, { region: "global" }).preset;
  assert.deepEqual(global.endpoints, {
    chat: "https://global.example.test/v1",
  });
  assert.equal(global.keysUrl, "https://global.example.test/keys");
  assert.equal(global.catalog, "sample-global");
  // The plan's endpoints, source and catalog win; models fall back to the preset's.
  const api = choosePreset(sample, { region: "global", plan: "api" }).preset;
  assert.deepEqual(api.endpoints, { chat: "https://cn.example.test/v1" });
  assert.equal(api.catalog, "sample-api");
  assert.deepEqual(api.models, { source: "live", list: [{ id: "x" }] });
  assert.equal(api.keysUrl, "https://global.example.test/keys");

  const provider = providerFromPreset(sample, {
    region: "global",
    plan: "api",
    now: "2026-10-04T00:00:00.000Z",
  });
  assert.equal(provider.region, "global");
  assert.equal(provider.plan, "api");
  assert.deepEqual(provider.models.list, [{ id: "x" }]);
  assert.equal(provider.models.source, "live");
  assert.ok(isProviderConfig(provider));

  for (const [choice, code] of [
    [{ region: "mars" }, "PRESET_REGION_NOT_FOUND"],
    [{ plan: "gold" }, "PRESET_PLAN_NOT_FOUND"],
  ] as const)
    assert.throws(
      () => choosePreset(sample, choice),
      (error: unknown) =>
        error instanceof PresetChoiceError &&
        error.code === code &&
        /it has /.test(error.message),
    );
  assert.throws(
    () => choosePreset(getPreset("openai")!, { region: "cn" }),
    /has no regions/,
  );

  // A stored provider whose region a newer preset dropped reads as the default.
  assert.deepEqual(
    presetForProvider(sample, { region: "gone", plan: "api" }).endpoints,
    { chat: "https://cn.example.test/v1" },
  );
  assert.equal(
    presetForProvider(sample, { region: "global" }).catalog,
    "sample-global",
  );
});

void test("required headers and user endpoints are enforced on expansion", () => {
  const hinted: ProviderPreset = {
    ...getPreset("openai")!,
    headerHints: [
      { name: "X-Workspace", required: true, notes: "the workspace" },
      { name: "X-Optional", required: false },
    ],
  };
  assert.throws(
    () => providerFromPreset(hinted, { now: "2026-10-04T00:00:00.000Z" }),
    (error: unknown) =>
      error instanceof PresetChoiceError &&
      error.code === "HEADER_REQUIRED" &&
      error.pointer === "/headers/X-Workspace",
  );
  assert.deepEqual(
    providerFromPreset(hinted, {
      headers: { "x-workspace": "w1" },
      now: "2026-10-04T00:00:00.000Z",
    }).headers,
    { "x-workspace": "w1" },
  );
  const azure = getPreset("azure")!;
  assert.equal(azure.userEndpoint, true);
  const resource = "https://team.openai.azure.com/openai/v1";
  assert.deepEqual(
    providerFromPreset(azure, {
      endpoints: { chat: resource, responses: resource },
      now: "2026-10-04T00:00:00.000Z",
    }).endpoints,
    { chat: resource, responses: resource },
  );
});

void test("invalid regions, plans, hints and Magpie IDs are refused", () => {
  const valid = {
    schemaVersion: 1,
    id: "sample",
    name: "Sample",
    kind: "vendor",
    verified: "unverified",
    auth: { methods: ["api-key"], apiKeyHeader: "authorization-bearer" },
    endpoints: { chat: "https://cn.example.test/v1" },
    regions: [
      {
        id: "cn",
        name: "China",
        endpoints: { chat: "https://cn.example.test/v1" },
      },
      {
        id: "global",
        name: "Global",
        endpoints: { chat: "https://global.example.test/v1" },
      },
    ],
    models: { source: "live" },
  };
  assert.equal(checkPreset("sample.json", JSON.stringify(valid)).id, "sample");
  const region = (index: number, change: object) =>
    valid.regions.map((item, at) =>
      at === index ? { ...item, ...change } : item,
    );
  const cases: Array<[unknown, RegExp]> = [
    [{ ...valid, regions: [valid.regions[0]] }, /regions/],
    [{ ...valid, regions: region(1, { id: "cn" }) }, /region cn appears twice/],
    [{ ...valid, regions: region(1, { id: "Global" }) }, /regions/],
    [
      {
        ...valid,
        regions: region(1, {
          endpoints: { chat: "http://global.example.test/v1" },
        }),
      },
      /regions\[1\]\.endpoints\.chat must use HTTPS/,
    ],
    [
      {
        ...valid,
        regions: region(1, {
          endpoints: { anthropic: "https://global.example.test/v1" },
        }),
      },
      /regions\[1\]\.endpoints\.anthropic must not end with the API version/,
    ],
    [{ ...valid, regions: region(1, { extra: true }) }, /additional/],
    // The top-level endpoints must be the default region's.
    [
      { ...valid, endpoints: { chat: "https://global.example.test/v1" } },
      /endpoints differ/,
    ],
    [
      {
        ...valid,
        plans: [
          {
            id: "plan",
            name: "Plan",
            endpoints: { chat: "https://cn.example.test/plan/v1" },
          },
          { id: "api", name: "API" },
        ],
      },
      /endpoints differ/,
    ],
    [
      {
        ...valid,
        plans: [
          { id: "plan", name: "Plan", models: [] },
          { id: "b", name: "B" },
        ],
      },
      /plans/,
    ],
    [
      {
        ...valid,
        plans: [
          { id: "plan", name: "Plan", modelSource: "manual" },
          { id: "b", name: "B" },
        ],
      },
      /plans/,
    ],
    [{ ...valid, fallbackModels: ["has space"] }, /fallbackModels/],
    [{ ...valid, fallbackModels: ["a", "a"] }, /fallbackModels/],
    [
      { ...valid, headerHints: [{ name: "Authorization", required: true }] },
      /headerHints/,
    ],
    [
      { ...valid, headerHints: [{ name: "x-api-key", required: false }] },
      /headerHints/,
    ],
    [
      { ...valid, headerHints: [{ name: "bad header", required: false }] },
      /headerHints/,
    ],
    [
      {
        ...valid,
        headerHints: [
          { name: "X-A", required: false },
          { name: "x-a", required: true },
        ],
      },
      /header hint x-a appears twice/,
    ],
    [{ ...valid, headerHints: [{ name: "X-A" }] }, /headerHints/],
    [{ ...valid, userEndpoint: false }, /userEndpoint/],
    [{ ...valid, icon: "Has Space" }, /icon/],
    [{ ...valid, source: "magpie" }, /source/],
    [{ ...valid, catalog: "Not A Slug" }, /catalog/],
    [
      { ...valid, magpie: [{ id: "sample", region: "mars" }] },
      /Magpie ID sample: .*no region "mars"/,
    ],
    [
      { ...valid, magpie: [{ id: "sample", plan: "api" }] },
      /Magpie ID sample: .*has no plans/,
    ],
    [
      { ...valid, magpie: [{ id: "a" }, { id: "a" }] },
      /Magpie ID a appears twice/,
    ],
  ];
  for (const [candidate, reason] of cases)
    assert.throws(
      () => checkPreset("sample.json", JSON.stringify(candidate)),
      reason,
      JSON.stringify(candidate),
    );
});
