import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { normalizeEngine } from "../../src/engine/registry.js";
import { prepareConfiguration } from "../../src/drivers/configuration/prepare.js";
import type { RunId, SessionId } from "../../src/domain/types.js";

void test("Hermes selects the gateway alias natively through a named custom provider key_env without persisting keys", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hh-hermes-key-env-"));
  const secret = "synthetic-hermes-key-only-in-memory";
  const profile = normalizeEngine({
    id: "hermes",
    driver: "acp",
    command: [process.execPath],
    model: "contest-model",
    configuration: {
      adapter: "hermes",
      provider: {
        protocol: "openai-completions",
        baseUrl: "http://127.0.0.1:9/v1",
        apiKey: { kind: "env", value: "CONTEST_KEY" },
      },
    },
  });
  const prepared = await prepareConfiguration(
    {
      profile,
      cwd: root,
      stateDir: root,
      sessionId: "session" as SessionId,
      runId: "run" as RunId,
      generation: 1,
      input: { text: "", timeoutMs: 1000 },
    },
    { CONTEST_KEY: secret },
  );
  t.after(async () => {
    await prepared.modelBridge?.close();
    await rm(root, { recursive: true, force: true });
  });
  const gateway = prepared.modelBridge;
  assert.ok(gateway);
  const v1 = `${gateway.baseUrl}/v1`;
  const text = await readFile(
    join(prepared.env.HERMES_HOME!, "config.yaml"),
    "utf8",
  );
  const config = parse(text) as {
    model: Record<string, unknown>;
    providers: { custom: Record<string, unknown> };
    security: Record<string, unknown>;
  };
  assert.deepEqual(config.model, {
    provider: "custom",
    default: "harnesshub-model",
    base_url: v1,
    // Unified-model defaults when the provider declares no limits.
    context_length: 131072,
    max_tokens: 16384,
  });
  assert.deepEqual(config.providers.custom, {
    base_url: v1,
    default_model: "harnesshub-model",
    transport: "chat_completions",
    key_env: "HARNESSHUB_PROVIDER_KEY",
    models: { "harnesshub-model": { context_length: 131072 } },
  });
  assert.equal(config.security.allow_lazy_installs, false);
  assert.equal(prepared.env.HARNESSHUB_PROVIDER_KEY, gateway.token);
  assert.equal(prepared.env.OPENAI_API_KEY, gateway.token);
  assert.equal(prepared.env.CUSTOM_API_KEY, undefined);
  // Hermes re-resolves providers on ACP model selection, so none is sent.
  assert.equal(prepared.nativeModelSelection, true);
  assert.equal(prepared.model, "custom:harnesshub-model");
  assert.equal(text.includes(secret), false);
  assert.equal(JSON.stringify(prepared.env).includes(secret), false);
  assert.equal(
    prepared.command.some((arg) => arg.includes(secret)),
    false,
  );
});
