import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeEngine } from "../../src/engine/registry.js";
import { prepareConfiguration } from "../../src/drivers/configuration/prepare.js";
import type { RunId, SessionId } from "../../src/domain/types.js";

void test("DSH private overlay configures native routes and ACP model selectors without persisting credentials", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hh-dsh-provider-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const protocol of [
    "openai-completions",
    "openai-responses",
    "anthropic",
  ]) {
    const profile = normalizeEngine({
      id: "dsh",
      driver: "acp",
      command: [process.execPath, "dsh.js", "--profile", "acp"],
      model: "contest/model",
      configuration: {
        adapter: "dsh",
        provider: {
          protocol,
          baseUrl: "https://api.example.invalid/v1",
          apiKey: { kind: "env", value: "CONTEST_KEY" },
        },
      },
    });
    const stateDir = join(root, protocol),
      secret = "synthetic-dsh-key-only-in-memory";
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
    assert.equal(result.env.DSH_HOME, join(stateDir, "configuration"));
    assert.equal(result.env.DSH_TELEMETRY_DISABLED, "1");
    assert.equal(result.env.HARNESSHUB_PROVIDER_KEY, secret);
    assert.equal(result.model, JSON.stringify(["harnesshub", "contest/model"]));
    const filename = join(stateDir, "configuration", "dsh.patch.json"),
      text = await readFile(filename, "utf8");
    assert.deepEqual(result.command.slice(-2), ["--patch", filename]);
    assert.deepEqual(JSON.parse(text), [
      {
        id: "llm-pi-ai",
        config: {
          providers: {
            harnesshub: {
              api: protocol === "anthropic" ? "anthropic-messages" : protocol,
              baseURL: "https://api.example.invalid/v1",
              apiKeyEnv: "HARNESSHUB_PROVIDER_KEY",
              models: [{ id: "contest/model", name: "contest/model" }],
            },
          },
        },
      },
      {
        id: "agent-default-model",
        config: { provider: "harnesshub", model: "contest/model" },
      },
      { id: "acp", config: { provider: "harnesshub", model: "contest/model" } },
    ]);
    assert.equal(text.includes(secret), false);
    assert.equal(JSON.stringify(profile).includes(secret), false);
    assert.equal(
      result.command.some((arg) => arg.includes(secret)),
      false,
    );
  }
});

void test("DSH managed provider rejects unimplemented protocols and implicit endpoints", () => {
  for (const provider of [
    { protocol: "google", baseUrl: "https://example.invalid" },
    { protocol: "anthropic" },
  ])
    assert.throws(() =>
      normalizeEngine({
        id: "dsh",
        driver: "acp",
        command: [process.execPath],
        model: "contest-model",
        configuration: { adapter: "dsh", provider },
      }),
    );
});

void test("DSH managed provider rejects templates whose app arguments or existing patches could bypass the generated overlay", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hh-dsh-template-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const args of [
    ["--profile", "web"],
    ["--profile", "acp", "--debug"],
    ["--patch", "custom.yml", "--profile", "acp"],
    ["--patch=custom.yml", "--profile", "acp"],
  ]) {
    const profile = normalizeEngine({
      id: "dsh",
      driver: "acp",
      command: [process.execPath, "dsh.js", ...args],
      model: "contest-model",
      configuration: {
        adapter: "dsh",
        provider: {
          protocol: "openai-completions",
          baseUrl: "http://127.0.0.1:9/v1",
        },
      },
    });
    await assert.rejects(
      prepareConfiguration(
        {
          profile,
          cwd: root,
          stateDir: root,
          sessionId: "session" as SessionId,
          runId: "run" as RunId,
          generation: 1,
          input: { text: "", timeoutMs: 1000 },
        },
        {},
      ),
      /standard --profile acp/,
    );
  }
});
