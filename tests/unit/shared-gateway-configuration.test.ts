// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { prepareConfiguration } from "@harnesshub/agents/configuration/prepare";
import type { EngineProfile, RunId, SessionId } from "@harnesshub/core/types";
import { temporaryDirectory } from "../support/temporary.js";

const KEY = "hhk_s_aaaaaaaaaaaa_syntheticsessionkeysyntheticsessionkey01";

function profile(
  id: string,
  configuration?: EngineProfile["configuration"],
): EngineProfile {
  return {
    id,
    driver: "acp",
    command: [process.execPath, "engine.js"],
    revision: "r1",
    enabled: true,
    maxConcurrency: 1,
    capabilities: { resume: false, permissions: true, images: false },
    ...(configuration ? { configuration } : {}),
  };
}

void test("engines on the shared gateway get the daemon origin, the session key and the alias; nothing is started", async (t) => {
  const { directory } = await temporaryDirectory(t, "hh-shared-prepare-");
  const secrets = new Set<string>();
  const spec = (engine: EngineProfile, stateDir: string) => ({
    profile: engine,
    cwd: directory,
    stateDir: path.join(directory, stateDir),
    sessionId: "session" as SessionId,
    runId: "run" as RunId,
    generation: 1,
    input: { text: "", timeoutMs: 1000 },
    modelGateway: {
      baseUrl: "http://127.0.0.1:3180",
      key: KEY,
      adapter: "claude" as const,
      contextWindow: 65536,
    },
  });
  // No startModelGateway hook: the shared gateway needs none.
  const claude = await prepareConfiguration(
    spec(profile("claude", { adapter: "claude" }), "claude"),
    {
      ANTHROPIC_API_KEY: "sk-vendor-must-not-reach-engines",
      OPENAI_API_KEY: "sk-vendor",
    },
    { secrets },
  );
  assert.equal(claude.modelBridge, undefined);
  assert.equal(claude.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:3180");
  assert.equal(claude.env.ANTHROPIC_AUTH_TOKEN, KEY);
  assert.equal(claude.env.ANTHROPIC_MODEL, "harnesshub-model");
  assert.ok(
    claude.unsetEnv?.includes("ANTHROPIC_API_KEY") ||
      claude.env.ANTHROPIC_API_KEY === KEY,
  );
  assert.ok(secrets.has(KEY), "the key is redacted in the Worker's logs");

  // An engine without a declared configuration is wired by the adapter the daemon inferred.
  const inferred = await prepareConfiguration(
    {
      ...spec(profile("opencode"), "opencode"),
      modelGateway: {
        baseUrl: "http://127.0.0.1:3180",
        key: KEY,
        adapter: "opencode",
      },
    },
    {},
    {},
  );
  const config = JSON.parse(inferred.env.OPENCODE_CONFIG_CONTENT!) as {
    provider: { harnesshub: { options: { baseURL: string } } };
  };
  assert.equal(
    config.provider.harnesshub.options.baseURL,
    "http://127.0.0.1:3180/v1",
  );
  assert.equal(inferred.env.HARNESSHUB_PROVIDER_KEY, KEY);

  // A unified-model profile keeps its own alias in the engine configuration.
  const aliased = await prepareConfiguration(
    spec(
      profile("claude-unified", {
        adapter: "claude",
        provider: {
          protocol: "openai-completions",
          baseUrl: "http://upstream.example/v1",
          modelAlias: "contest-model",
        },
      }),
      "unified",
    ),
    {},
    {},
  );
  assert.equal(aliased.env.ANTHROPIC_MODEL, "contest-model");
  assert.equal(aliased.modelBridge, undefined);

  await assert.rejects(
    prepareConfiguration(
      {
        ...spec(profile("cursor", { adapter: "cursor" }), "cursor"),
        modelGateway: {
          baseUrl: "http://127.0.0.1:3180",
          key: KEY,
          adapter: "cursor",
        },
      },
      {},
      {},
    ),
    /cannot be routed through the HarnessHub model gateway/,
  );
  // Configuration files never hold the key beyond the engine's own settings directory.
  void readFile;
});
