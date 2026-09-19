import assert from "node:assert/strict";
import test from "node:test";
import { applyFullAccessToRegistration } from "../../src/distribution/full-access.js";
import type { ConfigurationAdapter } from "../../src/domain/engine-configuration.js";
import type { EngineRegistration } from "../../src/domain/engines.js";

const enabled = { HARNESSHUB_FULL_ACCESS: "1" };
function bundled(
  adapter: ConfigurationAdapter,
  extra: Partial<EngineRegistration> = {},
): EngineRegistration {
  return {
    id: adapter,
    driver: "acp",
    command: [
      "node.exe",
      "launch-engine.mjs",
      "HOME=C:/bundle/state/engine-homes/x",
      "--",
      "engine.exe",
      "acp",
    ],
    configuration: { adapter },
    model: "upstream-model",
    ...extra,
  };
}

void test("OpenCode full access relies on ACP approve-all and injects no OPENCODE_PERMISSION", () => {
  const input = bundled("opencode");
  const output = applyFullAccessToRegistration(input, enabled);
  assert.deepEqual(output.command, input.command);
  assert.equal(
    output.command.some((argument) =>
      argument.startsWith("OPENCODE_PERMISSION="),
    ),
    false,
  );
});

void test("MiMo full access relies on ACP approve-all because mimo acp rejects --yolo", () => {
  const input = bundled("mimo");
  const output = applyFullAccessToRegistration(input, enabled);
  assert.deepEqual(output.command, input.command);
  assert.equal(output.command.includes("--yolo"), false);
});

void test("full access only changes native approval switches and never model, provider or credentials", () => {
  const provider = {
    protocol: "openai-completions" as const,
    baseUrl: "https://model.example/v1",
    apiKey: { kind: "env" as const, value: "HARNESSHUB_MODEL_API_KEY" },
    modelAlias: "harnesshub-model",
  };
  const expected: Partial<Record<ConfigurationAdapter, string[]>> = {
    codex: ["INITIAL_AGENT_MODE=agent-full-access"],
    gemini: ["GEMINI_CLI_TRUST_WORKSPACE=true", "--approval-mode", "yolo"],
    qwen: ["--approval-mode", "yolo"],
    hermes: ["HERMES_YOLO_MODE=1"],
  };
  for (const adapter of [
    "codex",
    "opencode",
    "gemini",
    "qwen",
    "mimo",
    "hermes",
    "pi",
    "dsh",
    "openclaw",
    "claude",
    "copilot",
  ] as const) {
    const input = bundled(adapter, {
      configuration: { adapter, provider },
    });
    const output = applyFullAccessToRegistration(input, enabled);
    assert.equal(output.model, input.model, adapter);
    assert.deepEqual(output.configuration, input.configuration, adapter);
    const added = output.command.filter(
      (argument) => !input.command.includes(argument),
    );
    assert.deepEqual(added, expected[adapter] ?? [], adapter);
    assert.equal(
      output.command.some((argument) =>
        /MODEL|PROVIDER|API_KEY/.test(argument),
      ),
      false,
      adapter,
    );
  }
  const safe = bundled("opencode");
  assert.equal(applyFullAccessToRegistration(safe, {}), safe);
});
