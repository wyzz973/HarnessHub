// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";
import ts from "typescript";
import { consoleModule } from "./console-module.mjs";

// The assertions below read Chinese texts, the catalogs' source language.
(await consoleModule("lib/i18n.ts")).setLocale("zh-CN");

// Execute the actual browser schemas without a Next server. Only import paths
// change; TypeScript's compiler erases types before Node loads the modules.
async function consoleContracts() {
  const require = createRequire(
    new URL("../packages/console/package.json", import.meta.url),
  );
  const zod = pathToFileURL(require.resolve("zod")).href;
  const asModule = (source) =>
    `data:text/javascript;base64,${Buffer.from(
      ts.transpileModule(source, {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2024,
        },
      }).outputText,
    ).toString("base64")}`;
  const configuration = asModule(
    (
      await readFile(
        new URL("../packages/console/lib/engine-configuration.ts", import.meta.url),
        "utf8",
      )
    ).replace('from "zod"', `from ${JSON.stringify(zod)}`),
  );
  const contract = asModule(
    (
      await readFile(
        new URL("../packages/console/lib/contracts.ts", import.meta.url),
        "utf8",
      )
    )
      .replace('from "zod"', `from ${JSON.stringify(zod)}`)
      .replace(
        'from "./engine-configuration"',
        `from ${JSON.stringify(configuration)}`,
      ),
  );
  return import(contract);
}

test("console engine list and edit schemas preserve bounded ACP initialization without requiring resume", async () => {
  const { engineSchema, registrationSchema, candidateSchema } =
    await consoleContracts();
  const registration = {
    id: "openclaw",
    driver: "acp",
    command: ["node.exe", "launch-openclaw-bundled.mjs"],
    // The bundled OpenClaw budget, above the former 60 s bound.
    acp: { initializeTimeoutMs: 180000 },
  };
  assert.deepEqual(
    registrationSchema.parse(registration).acp,
    registration.acp,
  );
  const engine = engineSchema.parse({
    ...registration,
    revision: "revision",
    enabled: true,
    maxConcurrency: 1,
    capabilities: {
      configured: { resume: false, permissions: true, images: false },
      observed: null,
      validated: null,
    },
  });
  assert.deepEqual(engine.acp, registration.acp);
  assert.deepEqual(
    candidateSchema.parse({
      id: "openclaw",
      name: "OpenClaw",
      executable: "node.exe",
      source: "manifest",
      status: "ready",
      registration,
      notes: [],
    }).registration.acp,
    registration.acp,
  );
  for (const acp of [
    { initializeTimeoutMs: 0 },
    { initializeTimeoutMs: 300001 },
    { initializeTimeoutMs: 1.5 },
    { initializeTimeoutMs: "60000" },
    { sessionMode: "invalid" },
    { timeout: 1000 },
  ]) {
    assert.equal(
      registrationSchema.safeParse({ ...registration, acp }).success,
      false,
    );
    assert.equal(engineSchema.safeParse({ ...engine, acp }).success, false);
  }
  assert.deepEqual(
    registrationSchema.parse({
      ...registration,
      acp: { sessionMode: "resume", initializeTimeoutMs: 60000 },
    }).acp,
    { sessionMode: "resume", initializeTimeoutMs: 60000 },
  );
});

test("console reads Session diagnostics pages with free-form records and rejects malformed pages", async () => {
  const { sessionLogsSchema } = await consoleContracts();
  const page = {
    source: "gateway",
    file: "C:\\hh\\data\\logs\\gateway.log",
    exists: true,
    records: [
      {
        time: "2026-09-19T12:00:00.000Z",
        level: "info",
        event: "model.call",
        runId: "r1",
        usage: { input: 3 },
      },
      {
        time: "2026-09-19T12:00:01.000Z",
        level: "debug",
        event: "acp.update",
        params: "{}",
      },
    ],
    cursor: "123456789:4096",
    truncated: false,
    skipped: 0,
  };
  const parsed = sessionLogsSchema.parse(page);
  assert.equal(
    parsed.records[0].usage.input,
    3,
    "event-specific fields are kept",
  );
  assert.equal(
    sessionLogsSchema.parse({
      ...page,
      exists: false,
      records: [],
      cursor: null,
    }).cursor,
    null,
  );
  for (const invalid of [
    { ...page, source: "worker" },
    { ...page, cursor: undefined },
    { ...page, skipped: -1 },
    { ...page, records: [{ level: "info", event: "no-time" }] },
    { ...page, records: [{ time: "2026-09-19T12:00:00.000Z", level: "info" }] },
  ])
    assert.equal(
      sessionLogsSchema.safeParse(invalid).success,
      false,
      JSON.stringify(invalid),
    );
});

test("every console page has a path the daemon's console fallback serves", async () => {
  const { pagePaths } = await consoleModule("lib/router.ts", {
    'import { useSyncExternalStore } from "react";': "const useSyncExternalStore = undefined;",
  });
  const { consolePagePath } = await import(
    new URL("../packages/daemon/dist/src/http/console-static.js", import.meta.url).href
  );
  const paths = Object.values(pagePaths);
  assert.equal(new Set(paths).size, paths.length, "one page per path");
  for (const path of paths) assert.equal(consolePagePath(path), true, path);
  // Rejection samples: the API, the legacy routes and the gateway's paths.
  for (const path of ["/api/v1/providers", "/v1/engines", "/v1beta/models", "/models", "/responses", "/health/ready", "/assets/x.js"])
    assert.equal(consolePagePath(path), false, path);
});

test("the model-plane pages build API requests and read problem details", async () => {
  // modelPlane() needs a browser session; these helpers do not.
  const lib = await consoleModule("lib/model-plane.ts", {
    'import { apiClient } from "./session";': "const apiClient = undefined;",
  });
  const { HarnessHubError } = await import(
    new URL("../packages/sdk/dist/src/client.js", import.meta.url).href
  );
  const form = {
    ...lib.emptyProviderForm(),
    id: " deepseek ",
    name: "DeepSeek",
    endpoints: {
      chat: " https://api.deepseek.com/v1 ",
      responses: "",
      anthropic: "https://api.deepseek.com/anthropic",
      gemini: "",
    },
    models: "deepseek-chat\n\n deepseek-reasoner \ndeepseek-chat\n",
    expose: ["deepseek-reasoner", "gone"],
  };
  assert.deepEqual(lib.providerInput(form), {
    id: "deepseek",
    name: "DeepSeek",
    kind: "vendor",
    auth: { apiKeyHeader: "authorization-bearer" },
    endpoints: {
      chat: "https://api.deepseek.com/v1",
      anthropic: "https://api.deepseek.com/anthropic",
    },
    models: {
      source: "manual",
      list: [{ id: "deepseek-chat" }, { id: "deepseek-reasoner" }],
      expose: ["deepseek-reasoner"],
    },
  });
  const previous = {
    schemaVersion: 1,
    id: "deepseek",
    name: "DeepSeek",
    kind: "vendor",
    endpoints: { chat: "https://api.deepseek.com/v1", gemini: "https://g.example" },
    auth: { apiKeyHeader: "authorization-bearer" },
    credentials: [],
    models: {
      source: "live",
      list: [{ id: "deepseek-chat", contextWindow: 64000 }],
      expose: "all",
    },
    createdAt: "2026-10-02T00:00:00.000Z",
    updatedAt: "2026-10-02T00:00:00.000Z",
  };
  const edited = lib.providerFormOf(previous);
  const patch = lib.providerPatch(
    {
      ...edited,
      name: "",
      endpoints: { ...edited.endpoints, gemini: "" },
      models: "deepseek-chat\nnew-model",
    },
    previous,
  );
  // A cleared endpoint is removed with null; kept models keep their metadata.
  assert.deepEqual(patch.endpoints, { chat: "https://api.deepseek.com/v1", gemini: null });
  assert.equal(patch.name, "deepseek");
  assert.deepEqual(patch.models, {
    source: "live",
    list: [{ id: "deepseek-chat", contextWindow: 64000 }, { id: "new-model" }],
    expose: "all",
  });
  assert.equal("imageEndpoint" in patch, false, "no image endpoint before or after: none sent");
  // The image endpoint: sent trimmed, and removed with null once cleared.
  assert.equal(
    lib.providerInput({ ...form, imageEndpoint: " https://api.openai.com/v1 " }).imageEndpoint,
    "https://api.openai.com/v1",
  );
  const withImages = { ...previous, imageEndpoint: "https://api.openai.com/v1" };
  assert.equal(lib.providerFormOf(withImages).imageEndpoint, "https://api.openai.com/v1");
  assert.equal(lib.providerPatch({ ...lib.providerFormOf(withImages), imageEndpoint: " " }, withImages).imageEndpoint, null);

  // Model metadata cells show the resolved values; tooltips name the source.
  const cells = lib.modelMetadataCells({
    ref: "deepseek/deepseek-chat",
    listed: true,
    fields: {
      contextWindow: { value: 128000, source: "catalog", at: "2026-10-02T00:00:00.000Z" },
      "price.input": { value: 0.27, source: "override", at: "2026-10-02T00:00:00.000Z" },
      maxOutputTokens: { value: 8192, source: "preset", at: "2026-09-30" },
    },
    unknown: ["price.output"],
    overrides: [],
  });
  assert.equal(cells.context.text, (128000).toLocaleString());
  assert.match(cells.context.note, /^来源：models\.dev 目录快照，/);
  assert.equal(cells.output.note, "来源：provider 预设，核对于 2026-09-30");
  assert.equal(cells.price.text, "US$0.27 / ?", "a USD amount in the locale's currency format");
  assert.match(cells.price.note, /^输入：来源：模型覆盖，.*\n输出：未知：没有来源提供此值/);
  const empty = lib.modelMetadataCells(undefined);
  assert.deepEqual(
    [empty.context.text, empty.output.text, empty.price.text],
    ["—", "—", "—"],
  );
  assert.match(empty.context.note, /^未知/);
  // The same cells in English.
  const i18n = await consoleModule("lib/i18n.ts");
  i18n.setLocale("en");
  try {
    const english = lib.modelMetadataCells({
      ref: "deepseek/deepseek-chat",
      listed: true,
      fields: { maxOutputTokens: { value: 8192, source: "preset", at: "2026-09-30" } },
      unknown: [],
      overrides: [],
    });
    assert.equal(english.output.text, "8,192");
    assert.equal(english.output.note, "Source: Provider preset, checked on 2026-09-30");
    assert.equal(lib.failureOf(new HarnessHubError({ type: "x", title: "Conflict", status: 409, code: "PROVIDER_IN_USE", requestId: "r" })).message, "Route groups or Gateway Keys still refer to this provider");
  } finally {
    i18n.setLocale("zh-CN");
  }

  const now = Date.parse("2026-10-02T00:00:00.000Z");
  assert.equal(lib.expiresAtFor("never", now), null);
  assert.equal(lib.expiresAtFor("30d", now), "2026-11-01T00:00:00.000Z");
  assert.equal(lib.rangeStart("all", now), undefined);
  assert.equal(lib.rangeStart("24h", now), "2026-10-01T00:00:00.000Z");
  assert.equal(lib.addAmounts(["0.1", "0.2", "0.0000001", "3"]), "3.3000001");
  assert.equal(lib.addAmounts([]), "0");

  const failure = lib.failureOf(
    new HarnessHubError({
      type: "https://harnesshub.dev/problems/provider-invalid",
      title: "Bad Request",
      status: 400,
      code: "PROVIDER_INVALID",
      requestId: "req-1",
      errors: [
        { pointer: "/endpoints/chat", detail: "must be the base URL" },
        { parameter: "limit", detail: "must be <= 200" },
      ],
    }),
  );
  assert.equal(failure.code, "PROVIDER_INVALID");
  assert.deepEqual(failure.fields, {
    "/endpoints/chat": "must be the base URL",
    limit: "must be <= 200",
  });
  const blocked = lib.failureOf(
    new HarnessHubError({
      type: "x",
      title: "Conflict",
      status: 409,
      code: "SOMETHING_NEW",
      requestId: "req-2",
      detail: "Daemon detail",
      references: [{ type: "route-group", id: "fast" }],
    }),
  );
  // Unknown codes keep the daemon's detail; references are kept for display.
  assert.equal(blocked.message, "Daemon detail");
  assert.deepEqual(blocked.references, [{ type: "route-group", id: "fast" }]);
  assert.equal(lib.failureOf(new Error("plain")).message, "plain");
});

test("the key form sends LAN access as hh key create --lan does, and a LAN key always expires", async () => {
  const lib = await consoleModule("lib/model-plane.ts", {
    'import { apiClient } from "./session";': "const apiClient = undefined;",
  });
  const { gatewayKeyCreateSchema } = await import(
    new URL("../packages/daemon/dist/src/http/api-v1-schemas.js", import.meta.url).href
  );
  const now = Date.UTC(2026, 9, 5);
  const form = { name: " lan-box ", modelAllow: ["p/small", "group/fast"], expiry: "30d", allowLan: true };
  const body = lib.keyCreateInput(form, now);
  assert.deepEqual(body, {
    name: "lan-box",
    modelAllow: ["p/small", "group/fast"],
    expiresAt: new Date(now + 30 * 86_400_000).toISOString(),
    allowLan: true,
  });
  // The daemon's create schema takes every field the form sends, LAN access included.
  for (const field of Object.keys(body)) assert.ok(field in gatewayKeyCreateSchema.properties, field);
  assert.equal("allowLan" in lib.keyCreateInput({ ...form, allowLan: false }, now), false, "a loopback-only key");
  const quota = { requestsPerMinute: 5, budgets: [] };
  assert.deepEqual(lib.keyCreateInput({ ...form, quota }, now).quota, quota);
  assert.equal(lib.keyCreateInput({ ...form, allowLan: false, expiry: "never" }, now).expiresAt, null);
  // The daemon refuses a LAN key that never expires; the form does not offer it.
  assert.deepEqual(
    lib.expiryChoices.filter((choice) => lib.expiryAllowed(choice.id, true)).map((choice) => choice.id),
    ["30d", "90d", "365d"],
  );
  assert.equal(lib.expiryAllowed("never", false), true);
  // The dialog builds its request with keyCreateInput and passes the LAN choice; the list marks LAN keys.
  const page = await readFile(new URL("../packages/console/components/keys-page.tsx", import.meta.url), "utf8");
  assert.match(page, /gatewayKeys\.create\(\s*keyCreateInput\(\s*\{[^}]*\ballowLan\b[^}]*\}/);
  assert.match(page, /key\.allowLan \?/);
});

test("the agent pages derive wiring requests, shown models and attention from the API records", async () => {
  const agents = await consoleModule("lib/agents.ts");
  const gateway = await consoleModule("lib/gateway-models.ts", {
    'import { modelPlane } from "./model-plane";': "const modelPlane = undefined;",
  });
  const provider = (id, models, expose = "all") => ({
    id,
    name: id,
    preset: id === "deepseek" ? "deepseek" : undefined,
    models: { source: "manual", list: models, expose },
  });
  const models = gateway.gatewayModels(
    [
      provider("deepseek", [{ id: "chat", contextWindow: 128000, price: { input: 0.27, output: 1.1 } }, { id: "secret" }], ["chat"]),
      provider("lab", [{ id: "fast" }, { id: "slow" }]),
    ],
    [{ id: "deepseek", icon: "deepseek-color" }],
    [{ id: "fast", members: ["lab/fast", "deepseek/chat"] }],
    [{ id: "auto-chat", members: ["a/chat", "b/chat"], hidden: false }, { id: "auto-gone", members: [], hidden: true }],
  );
  assert.deepEqual(
    models.sections.map((section) => [section.id, section.icon, section.options.map((option) => option.ref)]),
    [
      ["deepseek", "deepseek-color", ["deepseek/chat"]],
      ["lab", undefined, ["lab/fast", "lab/slow"]],
      ["group", undefined, ["group/fast"]],
      ["auto-group", undefined, ["group/auto-chat"]],
    ],
    "unexposed models and hidden automatic groups are left out",
  );
  assert.equal(models.byRef.get("deepseek/chat").contextWindow, 128000);
  assert.equal(gateway.tokenCount(128000), "128K");
  assert.equal(gateway.tokenCount(1048576), "1M");
  assert.equal(gateway.tokenCount(undefined), "—");
  assert.equal(gateway.priceText({ input: 0.27 }), "US$0.27 / ?", "a USD price in the locale's currency format");
  assert.equal(gateway.priceText(undefined), "价格未知");

  const claude = {
    id: "claude",
    name: "Claude Code",
    installation: { status: "installed", configDirectories: [] },
    capabilities: { tiers: ["opus", "haiku"], efforts: ["low", "high"], options: {}, ownModel: [] },
    wiring: {
      model: "deepseek/chat",
      tiers: { haiku: "lab/fast" },
      effort: "high",
      options: {},
      models: ["deepseek/chat", "lab/fast", "group/fast"],
      hidden: ["lab/slow"],
      keyState: "active",
      drift: null,
    },
  };
  const draft = agents.draftOf(claude);
  assert.deepEqual(
    agents.wiringInput(claude, { ...draft, tiers: { haiku: undefined } }),
    { model: "deepseek/chat", tiers: {}, effort: "high" },
    "a cleared tier is sent as an empty map so the daemon removes it",
  );
  assert.deepEqual(
    agents.wiringInput(claude, { ...draft, effort: undefined }).effort,
    null,
  );
  // The model list no longer holds hidden models: they count towards M, not N.
  const visibility = agents.modelVisibility(claude, models);
  assert.deepEqual(visibility.allowed, ["deepseek/chat", "lab/fast", "lab/slow", "group/fast"]);
  assert.deepEqual(visibility.shown, ["deepseek/chat", "lab/fast", "group/fast"]);
  assert.deepEqual(agents.attention(claude, models), []);
  assert.deepEqual(
    agents.attention(
      {
        ...claude,
        installation: { status: "not-found", configDirectories: [] },
        wiring: { ...claude.wiring, model: "gone/model", keyState: "revoked", drift: { drifted: true, kinds: ["replaced"], findings: [] } },
      },
      models,
    ),
    [
      "已接线，但本机找不到这个 Agent",
      "配置文件被改动：接线字段被改",
      "它的 Key 已失效",
      "网关不再提供 gone/model",
    ],
  );
  // The same rules in English, and a value the daemon sends that has no label.
  const i18n = await consoleModule("lib/i18n.ts");
  i18n.setLocale("en");
  try {
    assert.deepEqual(
      agents.attention(
        { ...claude, wiring: { ...claude.wiring, keyState: "revoked", drift: { drifted: true, kinds: ["replaced", "new-kind"], findings: [] } } },
        models,
      ),
      ["Its configuration files were changed: Wired fields changed, new-kind", "Its key no longer works"],
    );
    assert.equal(agents.tierLabel("opus"), "Opus tier");
    assert.equal(agents.tierLabel("future"), "future");
    assert.equal(gateway.priceText({ input: 0.27 }), "$0.27 / ?");
  } finally {
    i18n.setLocale("zh-CN");
  }

  const codex = {
    id: "codex",
    capabilities: {
      tiers: [],
      efforts: ["low"],
      options: { codexAuth: ["gateway-key", "chatgpt"] },
      ownModel: [{ codexAuth: "chatgpt" }],
    },
    wiring: null,
  };
  const codexDraft = agents.draftOf(codex);
  assert.deepEqual(codexDraft.options, { codexAuth: "gateway-key" }, "options default to the first value");
  // ChatGPT mode (ADR 0030): a key is issued, and a HarnessHub model is optional.
  assert.deepEqual(
    agents.wiringInput(codex, { ...codexDraft, model: "lab/fast", effort: "low", options: { codexAuth: "chatgpt" } }),
    { model: "lab/fast", effort: "low", options: { codexAuth: "chatgpt" } },
  );
  assert.deepEqual(
    agents.wiringInput(codex, { ...codexDraft, model: undefined, effort: "low", options: { codexAuth: "chatgpt" } }),
    { model: null, options: { codexAuth: "chatgpt" } },
    "without a model the agent keeps its own, and takes no effort",
  );
  // Which options keep the agent's own model comes from the daemon's capabilities, not from the console.
  assert.equal(agents.modelOptional(codex, { codexAuth: "chatgpt" }), true);
  assert.equal(agents.modelOptional(codex, { codexAuth: "gateway-key" }), false);
  assert.equal(agents.modelOptional(codex, undefined), false);
  const several = { capabilities: { ownModel: [{ auth: "login", mode: "own" }, { auth: "none" }] } };
  assert.equal(agents.modelOptional(several, { auth: "login", mode: "own" }), true, "every option of a combination must match");
  assert.equal(agents.modelOptional(several, { auth: "login", mode: "gateway" }), false);
  assert.equal(agents.modelOptional(several, { auth: "none", mode: "gateway" }), true);
  assert.equal(
    agents.modelOptional({ capabilities: { ownModel: [] } }, { codexAuth: "chatgpt" }),
    false,
    "an agent without ownModel combinations always takes a model, whatever its options are called",
  );
  assert.deepEqual(
    agents.wiringInput(
      { ...codex, capabilities: { ...codex.capabilities, ownModel: [] } },
      { ...codexDraft, model: undefined, options: { codexAuth: "chatgpt" } },
    ),
    { effort: null, options: { codexAuth: "chatgpt" } },
    "without the capability no null model is sent",
  );
  const chatgpt = { ...codex, wiring: { options: { codexAuth: "chatgpt" } } };
  assert.equal(agents.legacyKeyless(chatgpt), true, "a ChatGPT wiring from before keys has none");
  assert.equal(agents.legacyKeyless({ ...codex, wiring: { options: { codexAuth: "chatgpt" }, keyId: "hhk_a_1" } }), false);
  assert.equal(agents.legacyKeyless({ ...codex, wiring: { options: { codexAuth: "gateway-key" } } }), false);
  assert.equal(agents.legacyKeyless({ ...codex, wiring: null }), false);
});

test("the agent pages show the restart notice and an administrator's managed settings where the daemon sends them", async () => {
  const agents = await consoleModule("lib/agents.ts");
  // The fields as the daemon publishes them.
  const openapi = JSON.parse(await readFile(new URL("../docs/api/openapi.json", import.meta.url), "utf8"));
  const schema = (route, method, status = "200") => openapi.paths[route][method].responses[status].content["application/json"].schema;
  const view = schema("/api/v1/agents/{id}", "get");
  assert.equal(view.properties.notice.type, "string");
  assert.deepEqual(view.properties.wiring.properties.managed.items.required, ["path", "keyPaths"]);
  const plan = schema("/api/v1/agents/{id}/wiring/plan", "post");
  assert.ok(plan.properties.notice && plan.properties.managed);
  const wired = Object.values(openapi.paths["/api/v1/agents/{id}/wiring"].post.responses).find((item) => item.content)?.content["application/json"].schema;
  assert.ok(wired.properties.notice && wired.properties.wiring.properties.managed, "the wiring result");
  assert.ok(schema("/api/v1/agents/{id}/wiring", "delete").properties.agent.properties.notice, "the unwire result");

  const managed = [
    { path: "/Library/Application Support/ClaudeCode/managed-settings.json", keyPaths: [["env", "ANTHROPIC_BASE_URL"], ["model"]] },
    { path: "/etc/claude-code/managed-settings.json", keyPaths: [] },
  ];
  assert.deepEqual(agents.managedLines(managed), [
    "/Library/Application Support/ClaudeCode/managed-settings.json 设置了 env.ANTHROPIC_BASE_URL、model，接线写入的这些项不会生效。",
    "/etc/claude-code/managed-settings.json 无法解析，其中的设置可能覆盖接线。",
  ]);
  assert.deepEqual(agents.managedLines(undefined), []);
  const agent = {
    id: "claude",
    name: "Claude Code",
    installation: { status: "installed", configDirectories: [] },
    wiring: { keyState: "active", drift: null, managed },
  };
  assert.ok(agents.attention(agent).includes("管理员的托管设置覆盖了接线写入的项，这些项不会生效"));
  assert.deepEqual(agents.attention({ ...agent, wiring: { ...agent.wiring, managed: [] } }), []);
  assert.equal(agents.withNotice("Claude Code 已接线", "Restart it."), "Claude Code 已接线。Restart it.");
  assert.equal(agents.withNotice("Claude Code 已接线", undefined), "Claude Code 已接线");
  // Every place that changes wiring passes the daemon's notice on.
  const read = (file) => readFile(new URL(`../packages/console/components/${file}`, import.meta.url), "utf8");
  const dialog = await read("wire-plan-dialog.tsx");
  assert.match(dialog, /notice=\{plan\.changed \? plan\.notice : undefined\}/);
  assert.match(dialog, /managed=\{plan\.managed\}/);
  assert.match(dialog, /notice=\{wired\.notice\}/);
  assert.match(dialog, /managed=\{wired\.wiring\?\.managed\}/);
  const detail = await read("agent-detail.tsx");
  for (const used of [/agent\.notice/, /managed=\{wiring\?\.managed\}/, /rotated\.notice/, /updated\.notice/, /result\.agent\.notice/])
    assert.match(detail, used);
  assert.match(await read("agents-page.tsx"), /result\.agent\.notice/);
  assert.match(await read("first-run.tsx"), /notice: wired\.notice/);
});

test("the backup page reads backup files and builds sync settings without dropping secrets it must send", async () => {
  const backup = await consoleModule("lib/backup.ts");
  assert.equal(backup.backupFileName(new Date(2026, 9, 4, 23, 59)), "harnesshub-2026-10-04.harnesshub-backup");
  const envelope = { format: "harnesshub-backup", version: 1, kdf: "pbkdf2-sha256", iterations: 600000, salt: "s", nonce: "n", data: "d" };
  assert.deepEqual(backup.readBackupFile(JSON.stringify(envelope)), envelope);
  // Rejection samples: not JSON, not an object, another format.
  for (const text of ["not json", "[]", "null", JSON.stringify({ ...envelope, format: "magpie-backup" })])
    assert.throws(() => backup.readBackupFile(text), /不是 HarnessHub 备份文件/, text);

  const off = { enabled: false, intervalMs: 180000, secretBackend: "file" };
  const form = { ...backup.syncFormOf(off), url: " https://dav.example.com/me ", user: "me", secret: "dav-pass", passphrase: "p", confirm: "p" };
  assert.deepEqual(backup.syncSettings(form, off), {
    settings: { kind: "webdav", url: "https://dav.example.com/me", user: "me", secret: "dav-pass", passphrase: "p", keys: true, agents: true },
  });
  assert.match(backup.syncSettings({ ...form, url: "" }, off).error, /WebDAV/);
  assert.match(backup.syncSettings({ ...form, passphrase: "", confirm: "" }, off).error, /口令/, "turning sync on needs a passphrase");
  assert.match(backup.syncSettings({ ...form, confirm: "q" }, off).error, /不一致/);
  assert.match(backup.syncSettings({ ...form, kind: "s3", url: "s3://bucket", user: "" }, off).error, /Access Key ID/);
  const on = { ...off, enabled: true, kind: "s3", url: "s3://bucket/team", user: "AKIA", region: "auto", pathStyle: true, keys: false, agents: true };
  const edit = backup.syncFormOf(on);
  assert.equal(edit.pathStyle, "yes");
  assert.equal(edit.keys, false);
  assert.deepEqual(
    backup.syncSettings({ ...edit, endpoint: "https://r2.example.com" }, on),
    { settings: { kind: "s3", url: "s3://bucket/team", user: "AKIA", endpoint: "https://r2.example.com", region: "auto", pathStyle: true, keys: false, agents: true } },
    "once on, empty secrets keep the stored ones",
  );
  assert.equal(
    "endpoint" in backup.syncSettings({ ...form, endpoint: "https://ignored" }, off).settings,
    false,
    "WebDAV sends no S3 fields",
  );

  const summary = (library) => ({ library });
  const none = { added: [], replaced: [], removed: [] };
  assert.equal(backup.libraryChanged(summary(null)), false);
  assert.equal(backup.libraryChanged(summary({ instructions: none, mcp: { ...none, needSecret: [] }, skills: { ...none, incomplete: [] }, refused: [] })), false);
  assert.equal(backup.libraryChanged(summary({ instructions: { ...none, added: ["team"] }, mcp: { ...none, needSecret: [] }, skills: { ...none, incomplete: [] }, refused: [] })), true);
});

test("the restore summary and the sync status show the gateway features, redaction turned off and search keys to add", async () => {
  const backup = await consoleModule("lib/backup.ts");
  // The daemon's published shapes hold every field the page reads.
  const openapi = JSON.parse(await readFile(new URL("../docs/api/openapi.json", import.meta.url), "utf8"));
  const restored = openapi.paths["/api/v1/restore"].post.responses["200"].content["application/json"].schema.properties.gatewayFeatures;
  assert.equal(restored.nullable, true, "a backup from before the part has none");
  assert.deepEqual(restored.properties.redaction.required, ["enabled", "turnsOff", "turnsOn"]);
  assert.deepEqual(restored.properties.rules.required, ["added", "replaced", "removed"]);
  assert.deepEqual(restored.properties.search.required, ["added", "replaced", "removed", "needKey", "refused"]);
  assert.deepEqual(Object.keys(restored.properties.vision.properties), ["model", "changed", "unresolved"]);
  const notice = openapi.paths["/api/v1/sync"].get.responses["200"].content["application/json"].schema.properties.notice;
  assert.ok(notice.properties.redactionOff && notice.properties.needKey);
  assert.ok(notice.properties.here.items.enum.includes("features"));
  assert.equal(backup.syncPartName("features"), "网关功能");

  const none = { added: [], replaced: [], removed: [] };
  const off = backup.restoreFeatures({
    redaction: { enabled: false, turnsOff: true, turnsOn: false },
    rules: { ...none, added: ["codename"] },
    vision: { model: "gone/vision", changed: true, unresolved: "no provider gone" },
    search: { ...none, replaced: ["tavily"], needKey: ["brave", "searxng https://search.example"] },
    alerts: { usagePercent: null, changed: false },
  });
  assert.deepEqual(off.redaction, { label: "出站脱敏：由备份关闭", tone: "warn" });
  assert.deepEqual(off.vision, {
    label: "视觉模型改为 gone/vision",
    unresolved: "本机没有这个模型或路由组（no provider gone），仍按备份设置。",
  });
  assert.deepEqual(
    off.parts.filter((part) => part.items.length),
    [
      { label: "新增的脱敏规则", items: ["codename"] },
      { label: "替换的搜索后端", items: ["tavily"] },
      { label: "需要 Key、不带入的搜索后端", items: ["brave", "searxng https://search.example"], tone: "warn" },
    ],
  );
  const same = backup.restoreFeatures({
    redaction: { enabled: true, turnsOff: false, turnsOn: false },
    rules: none,
    vision: null,
    search: { ...none, needKey: [] },
    alerts: { usagePercent: null, changed: false },
  });
  assert.deepEqual(same.redaction, { label: "出站脱敏：开启", tone: "" });
  assert.equal(same.vision.label, "视觉模型：备份中没有，保持本机的");
  assert.equal(
    backup.restoreFeatures({ redaction: { enabled: true, turnsOff: false, turnsOn: true }, rules: none, vision: { model: "lab/v", changed: false }, search: { ...none, needKey: [] }, alerts: { usagePercent: null, changed: false } }).redaction.tone,
    "good",
  );

  // The links land on the cards: the features page has their IDs and reads ?section=.
  const page = await readFile(new URL("../packages/console/components/gateway-features-page.tsx", import.meta.url), "utf8");
  const { featureSections } = await consoleModule("lib/gateway-features.ts");
  for (const [section, search] of Object.entries(featureSections)) {
    assert.equal(search, `?section=${section}`);
    assert.ok(page.includes(`id="features-${section}"`), section);
  }
  const view = await readFile(new URL("../packages/console/components/backup-page.tsx", import.meta.url), "utf8");
  assert.match(view, /gatewayFeatures\?\.redaction\.turnsOff/, "the preview and the result warn when redaction goes off");
  assert.match(view, /notice\?\.redactionOff/, "the sync status warns when redaction went off");
  assert.match(view, /notice\?\.needKey/);
});

test("usage CSV downloads go through the session client, and usage alerts read and dismiss as the daemon lists them", async () => {
  const noSession = { 'import { apiClient } from "./session";': "const apiClient = undefined;" };
  const exporter = await consoleModule("lib/usage-export.ts", noSession);
  assert.equal(exporter.csvFileName({ kind: "calls" }, new Date(2026, 9, 5, 23, 59)), "harnesshub-calls-2026-10-05.csv");
  assert.equal(exporter.csvFileName({ kind: "usage", groupBy: "credential" }, new Date(2026, 0, 2)), "harnesshub-usage-by-credential-2026-01-02.csv");
  // A cookie-only GET is 401 now: the download is the SDK's request with the
  // tab's token, never a plain link to the API.
  const source = await readFile(new URL("../packages/console/lib/usage-export.ts", import.meta.url), "utf8");
  assert.match(source, /client\.modelCalls\.csv\(filter\)/);
  assert.match(source, /client\.usage\.csv\(\{ \.\.\.filter, groupBy: what\.groupBy \}\)/);
  const pages = (await Promise.all(
    ["components/usage-page.tsx", "lib/usage-export.ts"].map((file) => readFile(new URL(`../packages/console/${file}`, import.meta.url), "utf8")),
  )).join("\n");
  assert.doesNotMatch(pages, /href=\{?[`"']\/api\/v1/, "no plain link to the API");
  // The SDK sends the token and asks for CSV.
  const { HarnessHubClient } = await import(new URL("../packages/sdk/dist/src/client.js", import.meta.url).href);
  const seen = [];
  const client = new HarnessHubClient({
    url: "http://127.0.0.1:1",
    csrfToken: "t".repeat(43),
    fetch: async (url, init) => {
      seen.push({ url: String(url), headers: new Headers(init.headers) });
      return new Response("model,calls\n", { headers: { "content-type": "text/csv; charset=utf-8" } });
    },
  });
  await (await client.usage.csv({ groupBy: "model", from: "2026-10-01T00:00:00.000Z" })).cancel();
  assert.equal(new URL(seen[0].url).pathname, "/api/v1/usage");
  assert.equal(new URL(seen[0].url).searchParams.get("format"), "csv");
  assert.equal(seen[0].headers.get("x-hh-csrf"), "t".repeat(43));

  const alerts = await consoleModule("lib/usage-alerts.ts", noSession);
  const list = {
    usagePercent: 80,
    items: [
      { at: "2026-10-05T10:00:00.000Z", provider: "copilot", credential: "acct-1", credentialName: "work", window: "premium_interactions", usedPercent: 91.6, resetsAt: "2026-11-01T00:00:00.000Z" },
      { at: "2026-10-04T10:00:00.000Z", provider: "lab", credential: "key-1", window: "x-custom", usedPercent: 80 },
    ],
  };
  assert.equal(alerts.freshAlerts(list, undefined).length, 2);
  assert.deepEqual(alerts.freshAlerts(list, "2026-10-04T10:00:00.000Z").map((item) => item.provider), ["copilot"], "dismissed up to the newest seen");
  assert.deepEqual(alerts.freshAlerts(list, "2026-10-05T10:00:00.000Z"), []);
  assert.deepEqual(alerts.freshAlerts(undefined, undefined), []);
  assert.equal(alerts.alertText(list.items[0]), "copilot/work 的高级请求窗口已用 92%");
  assert.equal(alerts.alertText(list.items[1]), "lab/key-1 的x-custom窗口已用 80%", "an unknown window and a removed credential show as named");
  // The daemon's published list has the fields read here.
  const openapi = JSON.parse(await readFile(new URL("../docs/api/openapi.json", import.meta.url), "utf8"));
  const item = openapi.paths["/api/v1/usage/alerts"].get.responses["200"].content["application/json"].schema.properties.items.items;
  for (const field of ["at", "provider", "credential", "credentialName", "window", "usedPercent", "resetsAt"])
    assert.ok(field in item.properties, field);

  const features = await consoleModule("lib/gateway-features.ts");
  assert.deepEqual(["80", " 1 ", "100", "0", "101", "8.5", "x", ""].map(features.alertPercentOf), [80, 1, 100, undefined, undefined, undefined, undefined, undefined]);
  const put = openapi.paths["/api/v1/gateway/features/alerts"].put.requestBody.content["application/json"].schema.properties.usagePercent;
  assert.deepEqual([put.minimum, put.maximum], [1, 100], "the field's range is the daemon's");
  const backup = await consoleModule("lib/backup.ts");
  const base = {
    redaction: { enabled: true, turnsOff: false, turnsOn: false },
    rules: { added: [], replaced: [], removed: [] },
    vision: null,
    search: { added: [], replaced: [], removed: [], needKey: [] },
  };
  assert.deepEqual(
    [
      { usagePercent: 80, changed: false },
      { usagePercent: 90, changed: true },
      { usagePercent: null, changed: false },
      { usagePercent: null, changed: true },
    ].map((value) => backup.restoreFeatures({ ...base, alerts: value }).alerts),
    ["用量提醒：80% 时提醒", "用量提醒改为 90% 时提醒", "用量提醒：关闭", "用量提醒：由备份关闭"],
  );
  const restored = openapi.paths["/api/v1/restore"].post.responses["200"].content["application/json"].schema.properties.gatewayFeatures;
  assert.deepEqual(restored.properties.alerts.required, ["usagePercent", "changed"]);
});

test("the Library page sends MCP secrets as references or values and points at the rows a refusal names", async () => {
  const library = await consoleModule("lib/library.ts");
  const stored = { kind: "store", value: "secret-ref-1" };
  const server = {
    name: "github",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: { LOG_LEVEL: "info" },
    secretEnv: { GITHUB_TOKEN: { kind: "env", value: "MY_GITHUB_TOKEN" }, EXTRA: stored },
    agents: ["claude", "opencode"],
  };
  const form = library.mcpFormOf(server);
  assert.deepEqual(form.secretEnv.map((row) => row.kind), ["env", "keep"], "a stored secret is kept, never shown");
  assert.deepEqual(library.mcpInput(form), {
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: { LOG_LEVEL: "info" },
    secretEnv: { GITHUB_TOKEN: { kind: "env", value: "MY_GITHUB_TOKEN" }, EXTRA: stored },
    agents: ["claude", "opencode"],
  });
  const replaced = { ...form, secretEnv: [{ name: "GITHUB_TOKEN", kind: "value", value: "new-value" }] };
  assert.deepEqual(library.mcpInput(replaced).secretEnv, { GITHUB_TOKEN: { secret: "new-value" } });
  const http = { ...form, transport: "http", url: " https://mcp.example.com/mcp ", headers: "X-Team: platform", secretHeaders: [{ name: "Authorization", kind: "file", value: "/home/me/token" }] };
  assert.deepEqual(library.mcpInput(http), {
    transport: "http",
    url: "https://mcp.example.com/mcp",
    headers: { "X-Team": "platform" },
    secretHeaders: { Authorization: { kind: "file", value: "/home/me/token" } },
    agents: ["claude", "opencode"],
  }, "an HTTP server sends no command, environment or environment secrets");
  // Rejection samples: a line without its separator, a reference without its name or path.
  assert.throws(() => library.mcpInput({ ...form, env: "LOG_LEVEL" }), /第 1 行/);
  assert.throws(() => library.mcpInput({ ...form, secretEnv: [{ name: "TOKEN", kind: "env", value: " " }] }), /环境变量名/);
  assert.throws(() => library.mcpInput({ ...form, secretEnv: [{ name: "TOKEN", kind: "value", value: "" }] }), /填写值/);

  const marked = { ...form, secretEnv: [{ name: "GITHUB_TOKEN", kind: "env", value: "HH_ADMIN_TOKEN" }, { name: "OTHER", kind: "env", value: "FINE" }] };
  assert.deepEqual([...library.rowsNamedBy("HH_ADMIN_TOKEN is one of HarnessHub's own environment variables", marked)], ["secretEnv:GITHUB_TOKEN"]);
  assert.deepEqual([...library.rowsNamedBy("secretEnv.OTHER is the value of one of HarnessHub's own credentials", marked)], ["secretEnv:OTHER"]);
  assert.deepEqual([...library.rowsNamedBy("Something else", marked)], []);

  const agent = (id, status) => ({ id, installation: { status } });
  assert.deepEqual(
    library.installedLibraryAgents([agent("opencode", "installed"), agent("droid", "installed"), agent("claude", "configured"), agent("kimi", "not-found")]),
    ["claude", "opencode"],
    "Library agents found here, in the Library's order",
  );
  assert.equal(library.bytes(2048), "2.0 KiB");
});

test("the subscription page explains account states and the first run mirrors hh init", async () => {
  const subscriptions = await consoleModule("lib/subscriptions.ts");
  const account = { signedIn: true, noticeAccepted: true, enabled: true, usable: true };
  assert.equal(subscriptions.accountState(account).label, "可用");
  assert.equal(subscriptions.accountState({ ...account, signedIn: false, noticeAccepted: false, usable: false }).label, "已退出登录", "signing out is the first reason");
  assert.equal(subscriptions.accountState({ ...account, noticeAccepted: false, usable: false }).label, "需要接受新的告知");
  assert.equal(subscriptions.accountState({ ...account, enabled: false, usable: false }).label, "已停用");
  const setup = { sdkDirectory: "/addons", supportedSdkVersion: "1.0.16", installCommand: "npm install" };
  assert.deepEqual(subscriptions.copilotReadiness(setup), { sdk: "missing", cli: false, ready: false });
  assert.deepEqual(subscriptions.copilotReadiness({ ...setup, sdkVersion: "1.0.15", cliPath: "/bin/copilot" }), { sdk: "other-version", cli: true, ready: false });
  assert.equal(subscriptions.copilotReadiness({ ...setup, sdkVersion: "1.0.16", cliPath: "/bin/copilot" }).ready, true);
  assert.equal(subscriptions.secondsLeft("2026-10-04T12:10:00.000Z", Date.parse("2026-10-04T12:00:00.000Z")), 600);
  assert.equal(subscriptions.secondsLeft("2026-10-04T12:00:00.000Z", Date.parse("2026-10-04T12:01:00.000Z")), 0);

  const gateway = await consoleModule("lib/gateway-models.ts", {
    'import { modelPlane } from "./model-plane";': "const modelPlane = undefined;",
  });
  const plan = { id: "chatgpt", name: "ChatGPT plan", subscription: { backend: "siwc" }, models: { source: "live", list: [{ id: "gpt-plan" }], expose: "all" } };
  assert.equal(gateway.gatewayModels([plan], [], [], []).sections[0].icon, "openai", "a subscription provider shows its vendor's mark");

  const firstRun = await consoleModule("lib/first-run.ts");
  assert.deepEqual(
    firstRun.exposedModels({ id: "lab", models: { list: [{ id: "a" }, { id: "b" }], expose: ["b"] } }),
    ["lab/b"],
  );
  const wired = {
    wiring: { model: "lab/b", tiers: { haiku: "lab/a" }, keyState: "active", drift: { drifted: false, kinds: [], findings: [] } },
  };
  assert.equal(firstRun.sameWiring(wired, { model: "lab/b", tiers: { haiku: "lab/a" } }), true);
  // An agent wired another way, with a dead key or with drift is wired again.
  assert.equal(firstRun.sameWiring(wired, { model: "lab/b" }), false);
  assert.equal(firstRun.sameWiring({ wiring: { ...wired.wiring, keyState: "revoked" } }, { model: "lab/b", tiers: { haiku: "lab/a" } }), false);
  assert.equal(firstRun.sameWiring({ wiring: { ...wired.wiring, drift: { drifted: true, kinds: ["replaced"], findings: [] } } }, { model: "lab/b", tiers: { haiku: "lab/a" } }), false);
  assert.equal(firstRun.sameWiring({ wiring: null }, { model: "lab/b" }), false);
});

test("the routing state and gateway features pages present the gateway's state and send its settings", async () => {
  const routing = await consoleModule("lib/routing-state.ts");
  const now = Date.parse("2026-10-04T12:00:00.000Z");
  assert.deepEqual(
    routing.readingView({ window: "premium_interactions", usedPercent: 91.6, resetsAt: "2026-11-01T00:00:00.000Z", observedAt: "2026-10-04T11:00:00.000Z" }, now),
    { name: "高级请求", percent: 92, tone: "warn", renewed: false },
  );
  assert.deepEqual(
    routing.readingView({ window: "requests", usedPercent: 99, resetsAt: "2026-10-04T11:59:00.000Z", observedAt: "2026-10-04T11:00:00.000Z" }, now),
    { name: "请求数", percent: 0, tone: "good", renewed: true },
    "a window past its reset counts as unused, as the router counts it",
  );
  assert.equal(routing.readingView({ window: "x-custom", usedPercent: 98, observedAt: "2026-10-04T11:00:00.000Z" }, now).tone, "error");
  assert.equal(routing.readingView({ window: "x-custom", usedPercent: 140, observedAt: "2026-10-04T11:00:00.000Z" }, now).percent, 100);
  assert.equal(routing.failureText({ kind: "rate_limited", status: 429, at: "2026-10-04T11:00:00.000Z" }), "被限流（HTTP 429）");
  assert.equal(routing.failureText({ kind: "something_new", status: 500, at: "2026-10-04T11:00:00.000Z" }), "something_new（HTTP 500）");
  assert.equal(routing.restLeft("2026-10-04T12:09:52.000Z", now), "9:52");
  assert.equal(routing.restLeft("2026-10-04T13:02:03.000Z", now), "1:02:03");
  assert.equal(routing.restLeft("2026-10-04T12:00:00.000Z", now), undefined, "a rest that has ended has no time left");
  const byCredential = routing.statesByCredential([{ provider: "lab", credential: "default", state: "open", readings: [] }]);
  assert.equal(byCredential.get(routing.stateKey("lab", "default")).state, "open");

  const features = await consoleModule("lib/gateway-features.ts");
  assert.deepEqual(Object.keys(features.searchKinds), ["tavily", "brave", "exa", "firecrawl", "searxng"]);
  assert.deepEqual(features.ruleOf({ name: " codename ", pattern: "falcon-[0-9]+", ignoreCase: true }), { name: "codename", pattern: "falcon-[0-9]+", flags: "i" });
  assert.deepEqual(features.ruleOf({ name: "ticket", pattern: "T-\\d+", ignoreCase: false }), { name: "ticket", pattern: "T-\\d+" });
  const view = { schemaVersion: 1, redaction: { enabled: true, rules: [{ name: "codename", pattern: "a" }, { name: "ticket", pattern: "b" }] } };
  assert.deepEqual(
    features.rulesWith(view, { add: { name: "CodeName", pattern: "c" } }),
    [{ name: "ticket", pattern: "b" }, { name: "CodeName", pattern: "c" }],
    "a rule of the same name, case aside, is replaced and the new one goes last, as hh gateway does",
  );
  assert.deepEqual(features.rulesWith(view, { remove: "ticket" }), [{ name: "codename", pattern: "a" }]);
});

test("the provider form sends the provider's own proxy, Settings shows the daemon's, and proxy failures read as words", async () => {
  const lib = await consoleModule("lib/model-plane.ts", {
    'import { apiClient } from "./session";': "const apiClient = undefined;",
  });
  const { providerCreateSchema, providerPatchSchema } = await import(
    new URL("../packages/daemon/dist/src/http/api-v1-schemas.js", import.meta.url).href
  );
  const { HarnessHubError } = await import(new URL("../packages/sdk/dist/src/client.js", import.meta.url).href);
  const form = {
    ...lib.emptyProviderForm(),
    id: "lab",
    endpoints: { chat: "https://lab.example/v1", responses: "", anthropic: "", gemini: "" },
  };
  assert.equal("proxy" in lib.providerInput(form), false, "the daemon's proxy is the absent field");
  assert.equal(lib.providerInput({ ...form, proxy: "direct" }).proxy, "direct");
  assert.equal(lib.providerInput({ ...form, proxy: "url", proxyUrl: " socks5://127.0.0.1:1080 " }).proxy, "socks5://127.0.0.1:1080");
  assert.equal(
    lib.providerInput({ ...form, proxy: "url", proxyUrl: "  " }).proxy,
    "",
    "an empty address is sent, so the daemon's refusal names the field",
  );
  assert.ok("proxy" in providerCreateSchema.properties);
  assert.deepEqual(providerPatchSchema.properties.proxy.type, ["string", "null"], "null returns a provider to the daemon's proxy");

  const previous = {
    schemaVersion: 1,
    id: "lab",
    name: "Lab",
    kind: "relay",
    endpoints: { chat: "https://lab.example/v1" },
    auth: { apiKeyHeader: "authorization-bearer" },
    credentials: [],
    models: { source: "manual", list: [], expose: "all" },
    proxy: "http://127.0.0.1:7890",
  };
  const { proxy: _ignored, ...noProxy } = previous;
  const edited = lib.providerFormOf(previous);
  assert.deepEqual([edited.proxy, edited.proxyUrl], ["url", "http://127.0.0.1:7890"]);
  assert.deepEqual([lib.providerFormOf({ ...previous, proxy: "direct" }).proxy, lib.providerFormOf(noProxy).proxy], ["direct", "daemon"]);
  assert.equal(lib.providerPatch(edited, previous).proxy, "http://127.0.0.1:7890");
  assert.equal(lib.providerPatch({ ...edited, proxy: "direct" }, previous).proxy, "direct");
  assert.equal(lib.providerPatch({ ...edited, proxy: "daemon" }, previous).proxy, null, "back to the daemon's proxy");
  assert.equal("proxy" in lib.providerPatch({ ...edited, proxy: "daemon" }, noProxy), false);
  assert.deepEqual(
    [lib.proxyText(noProxy), lib.proxyText({ ...previous, proxy: "direct" }), lib.proxyText(previous)],
    ["使用守护进程的代理", "直连，不经代理", "http://127.0.0.1:7890"],
  );
  const refused = lib.failureOf(
    new HarnessHubError({
      type: "x",
      title: "Bad Request",
      status: 400,
      code: "PROVIDER_INVALID",
      requestId: "r",
      errors: [{ pointer: "/proxy", detail: "must not hold credentials" }],
    }),
  );
  assert.equal(refused.fields["/proxy"], "must not hold credentials", "the daemon's words, on the proxy field");

  // The daemon's own proxy, read-only in Settings, as /system/info gives it.
  const { systemInfoSchema } = await import(
    new URL("../packages/daemon/dist/src/http/api-v1-schemas.js", import.meta.url).href
  );
  assert.ok(systemInfoSchema.required.includes("network"));
  assert.deepEqual(systemInfoSchema.properties.network.required, ["proxy", "noProxy", "source"]);
  assert.deepEqual(
    lib.outboundProxyView({ proxy: "http://alice:***@proxy.corp:3128", noProxy: [".corp.example", "10.0.0.0/8"], source: "env" }),
    { proxy: "http://alice:***@proxy.corp:3128", address: true, source: "环境变量（HTTPS_PROXY 等）", noProxy: ".corp.example, 10.0.0.0/8" },
  );
  assert.deepEqual(lib.outboundProxyView({ proxy: null, noProxy: [], source: null }), {
    proxy: "直连，没有代理",
    address: false,
    source: "未设置",
    noProxy: "—",
  });
  assert.equal(lib.outboundProxyView({ proxy: null, noProxy: [], source: "flag" }).source, "hh serve 的 --proxy 参数", "--proxy direct");
  for (const source of systemInfoSchema.properties.network.properties.source.enum.filter(Boolean))
    assert.notEqual(lib.outboundProxyView({ proxy: null, noProxy: [], source }).source, "未设置", source);

  // Every ledger class of an upstream failure has words, proxy_failed included.
  const routing = await consoleModule("lib/routing-state.ts");
  const { failureClass } = await import(new URL("../packages/gateway/dist/src/routing.js", import.meta.url).href);
  const classes = new Set(
    ["proxy", "verify", "auth", "credit", "quota", "rate", "model", "other", "request"].flatMap((kind) => [
      failureClass(kind, 500, false),
      failureClass(kind, 504, true),
    ]),
  );
  classes.add("upstream_unreachable");
  for (const errorClass of classes) assert.notEqual(routing.errorClassText(errorClass), errorClass, errorClass);
  assert.equal(routing.errorClassText("proxy_failed"), "代理连接失败");
  assert.equal(routing.errorClassText("something_new"), "something_new");
  assert.equal(routing.failureText({ kind: "proxy_failed", status: 502, at: "2026-10-05T00:00:00.000Z" }), "代理连接失败（HTTP 502）");
});

test("the provider form sends its per-credential limits, clears them with null, and shows the gateway's defaults", async () => {
  const lib = await consoleModule("lib/model-plane.ts", {
    'import { apiClient } from "./session";': "const apiClient = undefined;",
  });
  const i18n = await consoleModule("lib/i18n.ts");
  const { providerCreateSchema, providerPatchSchema } = await import(
    new URL("../packages/daemon/dist/src/http/api-v1-schemas.js", import.meta.url).href
  );
  const { DEFAULT_HANDLER_LIMITS } = await import(new URL("../packages/gateway/dist/src/limits.js", import.meta.url).href);
  const { PROVIDER_LIMIT_RANGES } = await import(new URL("../packages/core/dist/src/model-plane.js", import.meta.url).href);
  assert.deepEqual(lib.gatewayCredentialLimits, {
    concurrentPerCredential: DEFAULT_HANDLER_LIMITS.maxConcurrentPerCredential,
    queuePerCredential: DEFAULT_HANDLER_LIMITS.maxQueuedPerCredential,
  });
  assert.deepEqual([...lib.limitNames], Object.keys(providerCreateSchema.properties.limits.properties));
  for (const name of lib.limitNames)
    assert.deepEqual(providerPatchSchema.properties.limits.properties[name].type, ["integer", "null"], name);
  // The hint states the daemon's ranges, in both languages.
  for (const locale of ["zh-CN", "en"]) {
    i18n.setLocale(locale);
    for (const [low, high] of Object.values(PROVIDER_LIMIT_RANGES))
      assert.ok(i18n.t("providers.limits.hint").includes(`${low}–${high}`), `${locale} ${low}–${high}`);
  }
  i18n.setLocale("zh-CN");

  const form = {
    ...lib.emptyProviderForm(),
    id: "lab",
    endpoints: { chat: "https://lab.example/v1", responses: "", anthropic: "", gemini: "" },
  };
  assert.equal("limits" in lib.providerInput(form), false, "empty fields follow the gateway");
  assert.deepEqual(lib.providerInput({ ...form, limits: { concurrentPerCredential: " 2 ", queuePerCredential: "" } }).limits, { concurrentPerCredential: 2 });
  assert.deepEqual(lib.providerInput({ ...form, limits: { concurrentPerCredential: "1", queuePerCredential: "0" } }).limits, { concurrentPerCredential: 1, queuePerCredential: 0 }, "0 waiting is a limit");
  for (const typed of ["abc", "1.5", "-1", "2 3"]) {
    const failure = lib.providerFormFailure({ ...form, limits: { concurrentPerCredential: "", queuePerCredential: typed } });
    assert.deepEqual(failure.fields, { "/limits/queuePerCredential": "请填写整数" }, typed);
  }
  assert.equal(lib.providerFormFailure({ ...form, limits: { concurrentPerCredential: "4096", queuePerCredential: "" } }), null, "the range is the daemon's to refuse");

  const previous = {
    schemaVersion: 1,
    id: "lab",
    name: "Lab",
    kind: "relay",
    endpoints: { chat: "https://lab.example/v1" },
    auth: { apiKeyHeader: "authorization-bearer" },
    credentials: [],
    models: { source: "manual", list: [], expose: "all" },
    limits: { concurrentPerCredential: 2, queuePerCredential: 10 },
  };
  const edited = lib.providerFormOf(previous);
  assert.deepEqual(edited.limits, { concurrentPerCredential: "2", queuePerCredential: "10" });
  assert.equal(lib.providerPatch(edited, previous).limits.concurrentPerCredential, 2);
  assert.deepEqual(
    lib.providerPatch({ ...edited, limits: { concurrentPerCredential: "3", queuePerCredential: "" } }, previous).limits,
    { concurrentPerCredential: 3, queuePerCredential: null },
  );
  assert.deepEqual(
    lib.providerPatch({ ...edited, limits: { concurrentPerCredential: "", queuePerCredential: "" } }, previous).limits,
    { concurrentPerCredential: null, queuePerCredential: null },
    "both cleared: the daemon drops the empty limits",
  );
  const { limits: _limits, ...unlimited } = previous;
  assert.equal("limits" in lib.providerPatch(lib.providerFormOf(unlimited), unlimited), false);
  assert.equal(lib.limitsText(previous), "每个凭据同时 2 个，排队 10 个");
  assert.equal(lib.limitsText({ ...previous, limits: { queuePerCredential: 0 } }), "同时发出按网关的上限，排队 0 个");
  assert.equal(lib.limitsText(unlimited), undefined);
});

test("the provider check dialog names every doctor check and states the plan's cost", async () => {
  const doctor = await consoleModule("lib/provider-doctor.ts");
  const { doctorChecks } = await import(
    new URL("../packages/core/dist/src/provider-doctor.js", import.meta.url).href
  );
  assert.deepEqual(Object.keys(doctor.doctorCheckKeys), [...doctorChecks], "every check the daemon runs has a name, in its order");
  assert.equal(doctor.doctorCheckName("max-tokens"), "输出上限字段");
  const plan = { estimatedCostUsd: null, estimatedTokens: { input: 980, output: 480 } };
  assert.equal(doctor.planCost(plan), "价格未知，约 980 输入与 480 输出 token");
  assert.equal(doctor.planCost({ ...plan, estimatedCostUsd: 0.00213 }), "预计 US$0.0021", "a USD estimate to 4 decimals in the locale's currency format");
  assert.deepEqual(
    doctor.statusCounts([{ status: "pass" }, { status: "fail" }, { status: "pass" }, { status: "skip" }]),
    { pass: 2, warn: 0, fail: 1, skip: 1 },
  );
});

/** A zip archive of `entries` (Unix-made, so modes count), stored or deflated. */
async function zipOf(entries) {
  const { deflateRawSync } = await import("node:zlib");
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path);
    const content = Buffer.from(entry.content ?? "");
    const data = entry.deflate ? deflateRawSync(content) : content;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(entry.flags ?? 0, 6);
    local.writeUInt16LE(entry.deflate ? 8 : 0, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 30, 4);
    central.writeUInt16LE(entry.flags ?? 0, 8);
    central.writeUInt16LE(entry.deflate ? 8 : 0, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  const all = Buffer.concat([...locals, directory, end]);
  return all.buffer.slice(all.byteOffset, all.byteOffset + all.length);
}

test("the Library page reads a skill from a zip or folder and checks the daemon's limits first", async () => {
  const upload = await consoleModule("lib/skill-upload.ts");
  const skillText = "---\nname: pdf-tools\ndescription: PDFs\n---\n# PDF tools\n";
  const files = await upload.readZip(
    await zipOf([
      { path: "pdf-tools/", mode: 0o040755 },
      { path: "pdf-tools/SKILL.md", content: skillText, deflate: true },
      { path: "pdf-tools/scripts/merge.sh", content: "#!/bin/sh\necho merge\n", mode: 0o100755 },
      { path: "pdf-tools/.DS_Store", content: "junk" },
      { path: "pdf-tools/.git/HEAD", content: "ref" },
    ]),
  );
  assert.deepEqual(
    files.map((file) => [file.path, file.exec, new TextDecoder().decode(file.bytes)]),
    [
      ["pdf-tools/SKILL.md", false, skillText],
      ["pdf-tools/scripts/merge.sh", true, "#!/bin/sh\necho merge\n"],
    ],
    "deflated and stored entries are read, the executable bit is kept and ignored entries are left out",
  );
  const skill = upload.skillOf(files, "archive");
  assert.equal(skill.name, "pdf-tools", "a single top folder names the skill");
  assert.deepEqual(skill.files.map((file) => file.path), ["SKILL.md", "scripts/merge.sh"]);
  assert.deepEqual(skill.problems, []);
  const input = upload.uploadInput(skill.name, skill.files, ["claude"]);
  assert.deepEqual(Object.keys(input.files), ["SKILL.md", "scripts/merge.sh"]);
  assert.equal(Buffer.from(input.files["SKILL.md"], "base64").toString(), skillText);
  assert.deepEqual(input.exec, ["scripts/merge.sh"]);
  assert.equal("exec" in upload.uploadInput("x", [{ path: "SKILL.md", bytes: new Uint8Array(1), exec: false }], []), false);
  const big = new Uint8Array(200000).map((_, index) => index % 251);
  assert.equal(upload.base64(big), Buffer.from(big).toString("base64"), "large files encode in chunks");

  // Rejection samples: not a zip, links, encrypted entries, too many files, no SKILL.md, too large.
  await assert.rejects(upload.readZip(new TextEncoder().encode("not a zip").buffer), /不是 zip/);
  await assert.rejects(upload.readZip(await zipOf([{ path: "a/link", content: "x", mode: 0o120777 }])), /链接/);
  await assert.rejects(upload.readZip(await zipOf([{ path: "a/b", content: "x", flags: 1 }])), /加密/);
  await assert.rejects(
    upload.readZip(await zipOf(Array.from({ length: 501 }, (_, index) => ({ path: `s/f${index}`, content: "x" })))),
    /超过 500 个/,
  );
  assert.deepEqual(upload.skillOf([{ path: "README.md", bytes: new Uint8Array(1), exec: false }], "x").problems, ["顶层没有 SKILL.md"]);
  assert.match(
    upload.skillOf([{ path: "SKILL.md", bytes: new Uint8Array(20 * 1024 * 1024 + 1), exec: false }], "x").problems[0],
    /超过 20 MiB/,
  );
});
