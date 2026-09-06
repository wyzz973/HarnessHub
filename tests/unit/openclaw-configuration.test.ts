import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeEngine } from "../../src/engine/registry.js";
import { prepareConfiguration } from "../../src/drivers/configuration/prepare.js";
import type { RunId, SessionId } from "../../src/domain/types.js";

void test("OpenClaw provider uses per-session state, native wire protocols, and env SecretRefs without persisting keys", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hh-openclaw-provider-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const protocol of [
    "openai-completions",
    "openai-responses",
    "anthropic",
  ]) {
    const profile = normalizeEngine({
      id: "openclaw",
      driver: "acp",
      command: [process.execPath],
      model: "contest-model",
      configuration: {
        adapter: "openclaw",
        provider: {
          protocol,
          baseUrl: "https://api.example.invalid/v1",
          apiKey: { kind: "env", value: "CONTEST_KEY" },
        },
      },
    });
    const stateDir = join(root, protocol),
      secret = "synthetic-openclaw-key-only-in-memory";
    const result = await prepareConfiguration(
      {
        profile,
        cwd: root,
        stateDir,
        sessionId: "session" as SessionId,
        runId: "run" as RunId,
        generation: 1,
        input: { text: "", timeoutMs: 1000 },
      },
      { CONTEST_KEY: secret },
    );
    const text = await readFile(result.env.OPENCLAW_CONFIG_PATH!, "utf8"),
      config = JSON.parse(text) as {
        models: {
          providers: {
            harnesshub: {
              api: string;
              apiKey: unknown;
              models: { id: string }[];
            };
          };
        };
        agents: { defaults: { model: { primary: string }; workspace: string } };
      };
    assert.equal(
      result.env.OPENCLAW_STATE_DIR,
      join(stateDir, "configuration"),
    );
    assert.equal(result.env.HARNESSHUB_PROVIDER_KEY, secret);
    assert.equal(result.model, "harnesshub/contest-model");
    assert.equal(
      config.models.providers.harnesshub.api,
      protocol === "anthropic" ? "anthropic-messages" : protocol,
    );
    assert.deepEqual(config.models.providers.harnesshub.apiKey, {
      source: "env",
      provider: "harnesshub",
      id: "HARNESSHUB_PROVIDER_KEY",
    });
    assert.equal(config.agents.defaults.model.primary, result.model);
    assert.equal(config.agents.defaults.workspace, root);
    assert.equal(text.includes(secret), false);
    assert.equal(JSON.stringify(profile).includes(secret), false);
    assert.equal(
      result.command.some((arg) => arg.includes(secret)),
      false,
    );
  }
  for (const provider of [
    { protocol: "google", baseUrl: "https://example.invalid" },
    { protocol: "anthropic" },
  ])
    assert.throws(() =>
      normalizeEngine({
        id: "openclaw",
        driver: "acp",
        command: [process.execPath],
        model: "contest-model",
        configuration: { adapter: "openclaw", provider },
      }),
    );
});
