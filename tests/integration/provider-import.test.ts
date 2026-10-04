// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { startHub } from "@harnesshub/daemon/main";
import { HarnessHubError } from "@harnesshub/sdk/client";
import { connectLocal } from "@harnesshub/sdk/local";
import { temporaryDirectory } from "../support/temporary.js";

const LINK_KEY = "sk-synthetic-import-link-key-00001";
const CLAUDE_KEY = "sk-synthetic-import-claude-key-0002";
const CODEX_KEY = "sk-synthetic-import-codex-key-00003";

/** A daemon whose wiring home is a temporary directory (never the real home). */
async function daemon(t: TestContext, options: { home?: boolean } = {}) {
  const { directory, defer } = await temporaryDirectory(
    t,
    "harnesshub-import-",
  );
  const dataDir = path.join(directory, "data");
  const home = path.join(directory, "home");
  await mkdir(home);
  const hub = await startHub({
    dataDir,
    configDir: path.join(directory, "config"),
    secretsBackend: "file",
    demo: true,
    cwd: directory,
    port: 0,
    host: "127.0.0.1",
    ...(options.home === false ? {} : { wiringHome: { home, env: {} } }),
  });
  let running = true;
  defer(() => (running ? hub.server.close() : undefined));
  const stop = async () => {
    running = false;
    await hub.server.close();
  };
  const bodies: string[] = [];
  const client = await connectLocal({
    dataDir,
    url: hub.url,
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      bodies.push(await response.clone().text());
      return response;
    },
  });
  return { hub, client, bodies, home, dataDir, stop };
}

function problem(code: string, status: number) {
  return (error: unknown) => {
    assert.ok(error instanceof HarnessHubError, String(error));
    assert.equal(error.code, code, JSON.stringify(error.problem));
    assert.equal(error.status, status);
    return true;
  };
}

async function files(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) found.push(...(await files(full)));
    else if (entry.isFile()) found.push(full);
  }
  return found;
}

void test("an import link is previewed, applied once, and its key reaches only the secret store", async (t) => {
  const { hub, client, bodies, dataDir, stop } = await daemon(t);

  // A preset link with a region: nothing is written before apply.
  const preview = await client.imports.preview({
    link: `harnesshub://import?v=1&preset=moonshot&region=global&models=kimi-k3&key=${LINK_KEY}`,
  });
  assert.equal(preview.source, "link");
  assert.deepEqual(preview.warnings, []);
  assert.equal(preview.items.length, 1);
  const [item] = preview.items;
  assert.equal(item?.status, "new");
  assert.deepEqual(item?.provider, {
    id: "moonshot",
    name: "Moonshot AI (Kimi)",
    kind: "vendor",
    preset: "moonshot",
    region: "global",
    endpoints: {
      chat: "https://api.moonshot.ai/v1",
      responses: "https://api.moonshot.ai/v1",
      anthropic: "https://api.moonshot.ai/anthropic",
    },
    apiKeyHeader: "authorization-bearer",
    models: ["kimi-k3"],
    headers: [],
  });
  assert.deepEqual(item?.hosts, ["api.moonshot.ai"]);
  assert.deepEqual(item?.key, { kind: "value", last4: LINK_KEY.slice(-4) });
  // The region's own key page.
  assert.equal(item?.keysUrl, "https://platform.kimi.ai/console/api-keys");
  assert.deepEqual((await client.providers.list()).items, []);

  const applied = await client.imports.apply(preview.previewId);
  assert.equal(applied.items[0]?.status, "created");
  const created = await client.providers.get("moonshot");
  assert.equal(created.region, "global");
  assert.equal(created.credentials[0]?.ref.kind, "store");
  assert.deepEqual(
    created.models.list.map((model) => model.id),
    ["kimi-k3"],
  );
  // A preview is used once.
  await assert.rejects(
    client.imports.apply(preview.previewId),
    problem("IMPORT_PREVIEW_NOT_FOUND", 404),
  );
  // The same link again: the ID is taken, so apply skips it.
  const again = await client.imports.preview({
    link: `harnesshub://import?preset=moonshot&key=${LINK_KEY}`,
  });
  assert.equal(again.items[0]?.status, "exists");
  assert.deepEqual((await client.imports.apply(again.previewId)).items, [
    {
      ref: "link",
      status: "skipped",
      reason: "A provider with the ID moonshot exists; it is left as it is",
    },
  ]);

  // A Magpie link: Magpie's IDs and its single list of choices.
  const magpie = await client.imports.preview({
    link: "magpie://import?preset=zhipu&region=coding&id=glm-plan",
  });
  assert.deepEqual(
    [
      magpie.items[0]?.provider?.preset,
      magpie.items[0]?.provider?.plan,
      magpie.items[0]?.provider?.endpoints.chat,
      magpie.items[0]?.key,
    ],
    [
      "zhipu",
      "coding",
      "https://open.bigmodel.cn/api/coding/paas/v4",
      { kind: "none" },
    ],
  );
  assert.equal(
    (await client.imports.preview({ link: "magpie://import?preset=qwen-cn" }))
      .items[0]?.provider?.region,
    "cn",
  );

  // A custom provider with a catalog: metadata comes from that catalog.
  const custom = await client.imports.preview({
    link: `https://harnesshub.dev/import#name=Team%20Relay&anthropic=http://127.0.0.1:9&models=deepseek-v4-flash&catalog=deepseek&key=${LINK_KEY}&icon=https://relay.example.test/i.png`,
  });
  assert.equal(custom.items[0]?.provider?.id, "team-relay");
  assert.equal(custom.items[0]?.provider?.kind, "custom");
  assert.equal(custom.warnings.length, 2);
  await client.imports.apply(custom.previewId);
  const relay = await client.providers.get("team-relay");
  assert.equal(relay.catalog, "deepseek");
  assert.ok(relay.models.list[0]?.contextWindow, JSON.stringify(relay.models));

  // Refusals: a bad link, an unknown preset or region, a Magpie decision API.
  for (const [link, code] of [
    ["harnesshub://import?preset=moonshot&color=red", "IMPORT_LINK_INVALID"],
    ["harnesshub://import?preset=nope", "PRESET_NOT_FOUND"],
    [
      "harnesshub://import?preset=moonshot&region=mars",
      "PRESET_REGION_NOT_FOUND",
    ],
    ["harnesshub://import?preset=zhipu&plan=gold", "PRESET_PLAN_NOT_FOUND"],
    ["magpie://import?preset=typesafe", "PRESET_NOT_FOUND"],
    [`harnesshub://import?preset=azure&key=${LINK_KEY}`, "PROVIDER_INVALID"],
  ] as const)
    await assert.rejects(client.imports.preview({ link }), (error: unknown) => {
      problem(code, 400)(error);
      assert.equal(
        JSON.stringify((error as HarnessHubError).problem).includes(LINK_KEY),
        false,
      );
      return true;
    });
  await assert.rejects(
    client.imports.apply("AAAAAAAAAAAAAAAAAAAAAA"),
    problem("IMPORT_PREVIEW_NOT_FOUND", 404),
  );

  await stop();
  const log = await readFile(hub.logFile, "utf8");
  for (const text of [bodies.join("\n"), log])
    assert.equal(text.includes(LINK_KEY), false);
  for (const file of await files(dataDir))
    assert.equal((await readFile(file)).includes(LINK_KEY), false, file);
});

void test("Claude Code and Codex configuration in the wiring home become providers", async (t) => {
  const { hub, client, bodies, home, stop } = await daemon(t);
  const gateway = new URL(hub.url).origin;

  // Nothing configured yet: an empty preview with a warning.
  const empty = await client.imports.preview({ app: "codex" });
  assert.deepEqual(empty.items, []);
  assert.match(empty.warnings[0] ?? "", /No Codex config.toml/);

  await mkdir(path.join(home, ".claude"));
  await writeFile(
    path.join(home, ".claude", "settings.json"),
    JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic/",
        ANTHROPIC_AUTH_TOKEN: CLAUDE_KEY,
        ANTHROPIC_MODEL: "deepseek-v4-pro",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek-v4-flash",
      },
    }),
  );
  const claude = await client.imports.preview({ app: "claude-code" });
  assert.equal(claude.source, "claude-code");
  assert.equal(claude.file, path.join(home, ".claude", "settings.json"));
  // The base URL is the DeepSeek preset's own endpoint, so it is that preset.
  assert.deepEqual(claude.items, [
    {
      ref: "settings",
      status: "new",
      provider: {
        id: "deepseek",
        name: "DeepSeek",
        kind: "vendor",
        preset: "deepseek",
        endpoints: {
          chat: "https://api.deepseek.com",
          responses: "https://api.deepseek.com",
          anthropic: "https://api.deepseek.com/anthropic",
        },
        apiKeyHeader: "authorization-bearer",
        models: ["deepseek-v4-pro", "deepseek-v4-flash"],
        headers: [],
      },
      hosts: ["api.deepseek.com"],
      key: { kind: "value", last4: CLAUDE_KEY.slice(-4) },
    },
  ]);

  await mkdir(path.join(home, ".codex"));
  await writeFile(
    path.join(home, ".codex", "config.toml"),
    [
      'model_provider = "relay"',
      'model = "gpt-6-sol"',
      "",
      "[profiles.fast]",
      'model = "gpt-6-luna"',
      "",
      "[profiles.other]",
      'model_provider = "envkeyed"',
      'model = "m-1"',
      "",
      "[model_providers.relay]",
      'name = "Team Relay"',
      'base_url = "https://relay.example.test/v1"',
      `experimental_bearer_token = "${CODEX_KEY}"`,
      'http_headers = { "X-Team" = "blue" }',
      "",
      "[model_providers.envkeyed]",
      'base_url = "https://other.example.test/v1"',
      'wire_api = "chat"',
      'env_key = "OTHER_API_KEY"',
      "",
      "[model_providers.lowerenv]",
      'base_url = "https://lower.example.test/v1"',
      'env_key = "lower_key"',
      "",
      "[model_providers.keyless]",
      'base_url = "https://keyless.example.test/v1"',
      "",
      // HarnessHub's own wiring is never imported back.
      "[model_providers.harnesshub]",
      `base_url = "${gateway}/v1"`,
      'experimental_bearer_token = "hhk_a_abcdefghijkl_synthetic"',
      "",
      "[model_providers.loop]",
      `base_url = "${gateway}/v1"`,
      'experimental_bearer_token = "sk-synthetic-loop"',
      "",
    ].join("\n"),
  );
  const codex = await client.imports.preview({ app: "codex" });
  const byRef = new Map(codex.items.map((item) => [item.ref, item]));
  assert.deepEqual(
    [...byRef.keys()],
    ["envkeyed", "harnesshub", "keyless", "loop", "lowerenv", "relay"],
  );
  assert.deepEqual(byRef.get("relay"), {
    ref: "relay",
    status: "new",
    provider: {
      id: "relay",
      name: "Team Relay",
      kind: "custom",
      endpoints: { responses: "https://relay.example.test/v1" },
      apiKeyHeader: "authorization-bearer",
      models: ["gpt-6-sol", "gpt-6-luna"],
      headers: ["X-Team"],
    },
    hosts: ["relay.example.test"],
    key: { kind: "value", last4: CODEX_KEY.slice(-4) },
  });
  assert.deepEqual(byRef.get("envkeyed")?.key, {
    kind: "env",
    variable: "OTHER_API_KEY",
  });
  assert.deepEqual(byRef.get("envkeyed")?.provider?.endpoints, {
    chat: "https://other.example.test/v1",
  });
  assert.deepEqual(
    ["harnesshub", "loop", "keyless", "lowerenv"].map((ref) => [
      byRef.get(ref)?.status,
      byRef.get(ref)?.reason,
    ]),
    [
      ["skipped", "It points at HarnessHub itself"],
      ["skipped", "It points at HarnessHub itself"],
      ["skipped", "It has no API key"],
      [
        "skipped",
        "Its key variable is not an environment variable name (A-Z, 0-9, _)",
      ],
    ],
  );

  // Only the chosen items are created; skipped ones stay skipped.
  await assert.rejects(
    client.imports.apply(codex.previewId, ["nope"]),
    problem("INVALID_REQUEST", 400),
  );
  const again = await client.imports.preview({ app: "codex" });
  const result = await client.imports.apply(again.previewId, [
    "relay",
    "envkeyed",
    "keyless",
  ]);
  assert.deepEqual(
    result.items.map((item) => [item.ref, item.status]),
    [
      ["envkeyed", "created"],
      ["keyless", "skipped"],
      ["relay", "created"],
    ],
  );
  const relay = await client.providers.get("relay");
  assert.deepEqual(relay.headers, { "X-Team": "blue" });
  assert.equal(relay.credentials[0]?.ref.kind, "store");
  assert.deepEqual(
    (await client.providers.get("envkeyed")).credentials[0]?.ref,
    {
      kind: "env",
      value: "OTHER_API_KEY",
    },
  );
  const claudeApplied = await client.imports.apply(claude.previewId);
  assert.equal(claudeApplied.items[0]?.status, "created");
  assert.equal((await client.providers.get("deepseek")).credentials.length, 1);

  // The source files are only read.
  assert.match(
    await readFile(path.join(home, ".codex", "config.toml"), "utf8"),
    /\[model_providers\.keyless\]/,
  );
  // An unparseable file is refused without its content.
  await writeFile(
    path.join(home, ".codex", "config.toml"),
    `x = "${CODEX_KEY}`,
  );
  await assert.rejects(
    client.imports.preview({ app: "codex" }),
    (error: unknown) => {
      problem("WIRING_CONFIG_UNPARSEABLE", 409)(error);
      assert.equal(
        JSON.stringify((error as HarnessHubError).problem).includes(CODEX_KEY),
        false,
      );
      return true;
    },
  );

  await stop();
  const log = await readFile(hub.logFile, "utf8");
  for (const key of [CLAUDE_KEY, CODEX_KEY])
    for (const text of [bodies.join("\n"), log])
      assert.equal(text.includes(key), false);
});

void test("without a wiring home, imports from apps are refused", async (t) => {
  const { client } = await daemon(t, { home: false });
  await assert.rejects(
    client.imports.preview({ app: "claude-code" }),
    problem("IMPORT_SOURCE_UNAVAILABLE", 409),
  );
  // Links need no home.
  assert.equal(
    (
      await client.imports.preview({
        link: "harnesshub://import?preset=openai",
      })
    ).items[0]?.status,
    "new",
  );
});
