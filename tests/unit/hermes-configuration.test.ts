import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { normalizeEngine } from "../../src/engine/registry.js";
import { prepareConfiguration } from "../../src/drivers/configuration/prepare.js";
import type { RunId, SessionId } from "../../src/domain/types.js";

void test("Hermes uses a named bare-custom provider key_env that survives ACP model selection without persisting keys", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hh-hermes-key-env-"));
  t.after(() => rm(root, { recursive: true, force: true }));
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
  const text = await readFile(
    join(prepared.env.HERMES_HOME!, "config.yaml"),
    "utf8",
  );
  assert.deepEqual(parse(text), {
    model: {
      provider: "custom",
      default: "contest-model",
      base_url: "http://127.0.0.1:9/v1",
    },
    providers: {
      custom: {
        base_url: "http://127.0.0.1:9/v1",
        default_model: "contest-model",
        transport: "chat_completions",
        key_env: "HARNESSHUB_PROVIDER_KEY",
      },
    },
    security: { allow_lazy_installs: false },
  });
  assert.equal(prepared.env.HARNESSHUB_PROVIDER_KEY, secret);
  assert.equal(prepared.env.OPENAI_API_KEY, undefined);
  assert.equal(prepared.env.CUSTOM_API_KEY, undefined);
  assert.equal(prepared.model, "custom:contest-model");
  assert.equal(text.includes(secret), false);
  assert.equal(
    prepared.command.some((arg) => arg.includes(secret)),
    false,
  );
});
