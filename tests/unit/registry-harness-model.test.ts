import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HarnessModelService } from "../../src/application/harness-model.js";
import { builtinConfigurationAdapter } from "../../src/engine/builtins.js";
import { loadConfig, normalizeEngine } from "../../src/engine/registry.js";
import { HubError } from "../../src/domain/errors.js";

const model = {
  model: "GLM-V5_1-DX",
  provider: {
    protocol: "openai-completions",
    baseUrl: "http://aigateway.example/v1",
    apiKey: { kind: "env", value: "COMPANY_MODEL_API_KEY" },
    contextWindow: 131072,
  },
};

void test("source configuration files accept a top-level unified model and reject malformed ones", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hh-config-model-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "engines.yaml");
  await writeFile(
    file,
    [
      "model:",
      "  model: GLM-V5_1-DX",
      "  provider:",
      "    protocol: openai-completions",
      "    baseUrl: http://aigateway.example/v1",
      "    apiKey: { kind: env, value: COMPANY_MODEL_API_KEY }",
      "    contextWindow: 131072",
      "engines: []",
      "",
    ].join("\n"),
  );
  const config = await loadConfig({ cwd: directory, demo: false, file });
  assert.deepEqual(config.model, model);
  assert.equal(
    (await loadConfig({ cwd: directory, demo: false })).model,
    undefined,
  );
  for (const invalid of [
    { model: "GLM" },
    { model: { model: "GLM" } },
    { model: { ...model, surprise: true } },
    {
      model: { ...model, provider: { ...model.provider, apiKey: "sk-inline" } },
    },
    { model: { ...model, alias: "has space" } },
  ]) {
    await writeFile(file, JSON.stringify(invalid));
    await assert.rejects(
      loadConfig({ cwd: directory, demo: false, file }),
      (error: unknown) =>
        error instanceof HubError && error.code === "INVALID_CONFIG",
      JSON.stringify(invalid),
    );
  }
  // Shape is checked while loading; the upstream protocol rule belongs to the service.
  await writeFile(
    file,
    JSON.stringify({
      model: {
        ...model,
        provider: { ...model.provider, protocol: "anthropic" },
      },
    }),
  );
  const shaped = await loadConfig({ cwd: directory, demo: false, file });
  await assert.rejects(
    HarnessModelService.load({
      environment: {},
      settings: shaped.model,
      ports: {
        normalize: normalizeEngine,
        inferAdapter: builtinConfigurationAdapter,
      },
    }),
    (error: unknown) =>
      error instanceof HubError &&
      error.code === "HARNESS_MODEL_PROTOCOL_UNSUPPORTED",
  );
});
