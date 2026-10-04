// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { claudeModelAlias } from "@harnesshub/core/model-plane";
import { startHub } from "@harnesshub/daemon/main";
import type { HarnessHubClient } from "@harnesshub/sdk/client";
import { connectLocal } from "@harnesshub/sdk/local";
import { startFakeProvider } from "../support/fake-provider.js";
import { temporaryDirectory } from "../support/temporary.js";

const UPSTREAM_KEY = "sk-synthetic-wiring-sync-0001";

type Listed = { id: string; contextWindow?: number };

/**
 * A daemon with a temporary wiring home and a provider on the strict fake
 * upstream offering `models` (of the fake's big, small, other and later).
 */
async function setup(
  t: TestContext,
  models: Listed[],
  wiring?: { autoSync: boolean },
) {
  const { directory, defer } = await temporaryDirectory(t, "hh-wiresync-");
  const home = path.join(directory, "home");
  await mkdir(home, { recursive: true });
  const upstream = await startFakeProvider({
    models: ["big", "small", "other", "later"],
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
    catalog: { autoRefresh: false },
    wiringHome: { home, env: { PATH: path.join(directory, "bin") } },
    ...(wiring ? { wiring } : {}),
  });
  defer(() => hub.server.close());
  const client = await connectLocal({ dataDir, url: hub.url });
  const setModels = (list: Listed[]) =>
    client.providers.update("fake", {
      models: { source: "manual", list, expose: "all" },
    });
  await client.providers.create({
    id: "fake",
    name: "Fake",
    kind: "custom",
    endpoints: { chat: `${upstream.url}/v1` },
    models: { source: "manual", list: models, expose: "all" },
    credential: { value: UPSTREAM_KEY },
  });
  const info = await client.system.info();
  return { client, home, setModels, v1: info.gateway!.openaiBaseUrl };
}

async function wire(
  client: HarnessHubClient,
  id: string,
  model: string,
): Promise<void> {
  await client.agents.wire(id, {
    model,
    expect: await client.agents.plan(id, { model }),
  });
}

/** Polls `check` until it holds or ten seconds pass. */
async function eventually(
  check: () => Promise<boolean>,
  what: string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await delay(50);
  }
}

async function json(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
}

async function listed(v1: string, key: string): Promise<string[]> {
  const response = await fetch(`${v1}/models`, {
    headers: { authorization: `Bearer ${key}` },
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { data: Array<{ id: string }> };
  return body.data.map((model) => model.id).sort();
}

void test("a model added to or removed from the gateway reaches the model lists in wired agents' files, through the same key", async (t) => {
  const { client, home, setModels, v1 } = await setup(t, [
    { id: "big" },
    { id: "small" },
  ]);
  const opencode = path.join(home, ".config", "opencode", "opencode.json");
  await wire(client, "opencode", "fake/small");
  // Droid keeps the user's custom models beside ours.
  await mkdir(path.join(home, ".factory"), { recursive: true });
  await writeFile(
    path.join(home, ".factory", "settings.json"),
    '{"customModels": [{"id": "custom:mine", "model": "mine"}]}\n',
  );
  await wire(client, "droid", "fake/small");
  const providerModels = async () =>
    Object.keys(
      (
        (await json(opencode)).provider as Record<
          string,
          Record<string, unknown>
        >
      ).harnesshub!.models as object,
    ).sort();
  const droidIds = async () =>
    (
      (await json(path.join(home, ".factory", "settings.json")))
        .customModels as Array<{ id: string }>
    ).map((item) => item.id);
  const key = (
    (await json(opencode)).provider as Record<
      string,
      Record<string, Record<string, string>>
    >
  ).harnesshub!.options!.apiKey!;
  assert.deepEqual(await providerModels(), ["fake/big", "fake/small"]);

  await setModels([
    { id: "big" },
    { id: "small", contextWindow: 64_000 },
    { id: "later" },
  ]);
  await eventually(
    async () => (await providerModels()).includes("fake/later"),
    "the new model in OpenCode's list",
  );
  await eventually(
    async () => (await droidIds()).includes("custom:harnesshub/fake/later"),
    "the new model in Droid's list",
  );
  assert.deepEqual(await droidIds(), [
    "custom:mine",
    "custom:harnesshub/fake/big",
    "custom:harnesshub/fake/small",
    "custom:harnesshub/fake/later",
  ]);
  // The window changed too, and the key is the one the agent already had.
  const small = (
    (await json(opencode)).provider as Record<
      string,
      Record<string, Record<string, Record<string, unknown>>>
    >
  ).harnesshub!.models!["fake/small"]!;
  assert.deepEqual(small.limit, { context: 64_000, output: 0 });
  assert.equal(
    (
      (await json(opencode)).provider as Record<
        string,
        Record<string, Record<string, string>>
      >
    ).harnesshub!.options!.apiKey,
    key,
  );
  assert.deepEqual(await listed(v1, key), [
    "fake/big",
    "fake/later",
    "fake/small",
  ]);

  await setModels([{ id: "small" }, { id: "later" }]);
  await eventually(
    async () => !(await providerModels()).includes("fake/big"),
    "the removed model gone from OpenCode's list",
  );
  const agents = (await client.agents.list()).items;
  for (const id of ["opencode", "droid"]) {
    const agent = agents.find((item) => item.id === id)!;
    assert.equal(agent.wiring?.attention, undefined, id);
    assert.equal(agent.wiring?.drift?.drifted, false, id);
  }
});

void test("a sync leaves files the user changed alone and marks the agent; one whose model left the gateway too", async (t) => {
  const { client, home, setModels } = await setup(t, [
    { id: "big" },
    { id: "small" },
  ]);
  const pi = path.join(home, ".pi", "agent", "models.json");
  await wire(client, "pi", "fake/small");
  await wire(client, "crush", "fake/big");
  // The user renames one of HarnessHub's models in Pi's list.
  const edited = (await readFile(pi, "utf8")).replace(
    '"name": "fake/big"',
    '"name": "Big one"',
  );
  await writeFile(pi, edited);

  await setModels([{ id: "small" }, { id: "later" }]);
  const attention = async (id: string) =>
    (await client.agents.get(id)).wiring?.attention;
  await eventually(
    async () => (await attention("pi")) !== undefined,
    "Pi marked",
  );
  assert.equal((await attention("pi"))?.code, "AGENT_FILES_CHANGED");
  assert.equal(await readFile(pi, "utf8"), edited);
  await eventually(
    async () => (await attention("crush")) !== undefined,
    "Crush marked",
  );
  assert.equal((await attention("crush"))?.code, "AGENT_MODEL_UNAVAILABLE");

  // Wiring again takes the user's change over and clears the mark.
  await wire(client, "pi", "fake/small");
  assert.equal(await attention("pi"), undefined);
  assert.match(await readFile(pi, "utf8"), /fake\/later/);
});

void test("Codex keeps its web search while the gateway has a search backend, and its file follows backends coming and going", async (t) => {
  const { client, home } = await setup(t, [{ id: "big" }, { id: "small" }]);
  const config = path.join(home, ".codex", "config.toml");
  const webSearch = async () =>
    /^web_search = "disabled"$/m.test(await readFile(config, "utf8"));
  // The fake provider speaks Chat only: Codex's hosted tool would fail.
  await wire(client, "codex", "fake/small");
  assert.equal(await webSearch(), true);
  // The backend is never contacted here; registering it is enough.
  const { search } = await client.gatewayFeatures.addSearch({
    kind: "searxng",
    baseUrl: "http://127.0.0.1:9/search",
  });
  await eventually(async () => !(await webSearch()), "web search on");
  assert.equal(
    (await client.agents.get("codex")).wiring?.drift?.drifted,
    false,
  );
  await client.gatewayFeatures.removeSearch(search!.backends[0]!.id);
  await eventually(webSearch, "web search off again");
  assert.equal((await client.agents.get("codex")).wiring?.attention, undefined);
});

void test("wiring.autoSync false leaves the agents' files as they were written", async (t) => {
  const { client, home, setModels } = await setup(
    t,
    [{ id: "big" }, { id: "small" }],
    { autoSync: false },
  );
  await wire(client, "opencode", "fake/small");
  const file = path.join(home, ".config", "opencode", "opencode.json");
  const written = await readFile(file, "utf8");
  await setModels([{ id: "big" }, { id: "small" }, { id: "later" }]);
  await delay(1500);
  assert.equal(await readFile(file, "utf8"), written);
});

void test("invalid wiring settings fail the start", async (t) => {
  const { directory } = await temporaryDirectory(t, "hh-wiresettings-");
  for (const wiring of [{ autoSync: "no" }, { autosync: false }, []])
    await assert.rejects(
      startHub({
        dataDir: path.join(directory, "data"),
        configDir: path.join(directory, "config"),
        secretsBackend: "file",
        demo: true,
        cwd: directory,
        port: 0,
        host: "127.0.0.1",
        wiring,
      }),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "WIRING_SETTINGS_INVALID",
    );
});

void test("Claude Desktop is shown every model by a Claude-style alias and asks for it by that alias", async (t) => {
  const { client, home, v1 } = await setup(t, [{ id: "big" }, { id: "small" }]);
  await wire(client, "claude-desktop", "fake/small");
  const base =
    process.platform === "darwin"
      ? path.join(home, "Library", "Application Support")
      : process.platform === "win32"
        ? path.join(home, "AppData", "Local")
        : path.join(home, ".config");
  const profile = await json(
    path.join(
      base,
      "Claude-3p",
      "configLibrary",
      "00000000-0000-4000-8000-6861726e6573.json",
    ),
  );
  const key = profile.inferenceGatewayApiKey as string;
  assert.equal(profile.inferenceGatewayBaseUrl, new URL(v1).origin);
  assert.equal(
    (await json(path.join(base, "Claude", "claude_desktop_config.json")))
      .deploymentMode,
    "3p",
  );
  const keys = (await client.gatewayKeys.list()).items;
  assert.equal(
    keys.find((item) => item.scope.kind === "agent")?.modelIdStyle,
    "claude-alias",
  );
  const response = await fetch(`${v1}/models`, {
    headers: { authorization: `Bearer ${key}` },
  });
  const body = (await response.json()) as {
    data: Array<{ id: string; display_name: string }>;
  };
  assert.deepEqual(
    body.data.map((model) => [model.id, model.display_name]).sort(),
    [
      [claudeModelAlias("fake/big"), "fake/big"],
      [claudeModelAlias("fake/small"), "fake/small"],
    ].sort(),
  );
  for (const model of [
    claudeModelAlias("fake/small"),
    `${claudeModelAlias("fake/small")}[1m]`,
    "fake/small",
  ]) {
    const call = await fetch(`${v1}/chat/completions`, {
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
    await call.arrayBuffer();
    assert.equal(call.status, 200, model);
  }
  await client.agents.unwire("claude-desktop");
});
