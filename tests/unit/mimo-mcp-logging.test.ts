import assert from "node:assert/strict";
import test from "node:test";
import { prepareConfiguration } from "../../src/drivers/configuration/prepare.js";
import { normalizeEngine } from "../../src/engine/registry.js";
import type { RunId, SessionId } from "../../src/domain/types.js";

void test("MiMo managed MCP requires a native log level that excludes resolved session credentials", async () => {
  const prepare = (args: string[], enabled = true) =>
    prepareConfiguration(
      {
        profile: normalizeEngine({
          id: "mimo",
          driver: "acp",
          command: [process.execPath, "mimo.js", "acp", ...args],
          configuration: {
            adapter: "mimo",
            mcpServers: [
              {
                name: "fixture",
                type: "stdio",
                enabled,
                command: process.execPath,
                secretEnv: {
                  FIXTURE_VALUE: { kind: "env", value: "FIXTURE_SECRET" },
                },
              },
            ],
          },
        }),
        cwd: process.cwd(),
        stateDir: process.cwd(),
        sessionId: "mimo-logging" as SessionId,
        runId: "mimo-logging" as RunId,
        generation: 1,
        input: { text: "fixture", timeoutMs: 1000 },
      },
      { FIXTURE_SECRET: "synthetic-mcp-key" },
    );
  const prepared = await prepare([]);
  assert.deepEqual(prepared.command.slice(-2), ["--log-level", "ERROR"]);
  assert.equal(prepared.mcpServers.length, 1);
  assert.ok("env" in prepared.mcpServers[0]!);
  assert.deepEqual(prepared.mcpServers[0].env, [
    { name: "FIXTURE_VALUE", value: "synthetic-mcp-key" },
  ]);
  for (const args of [["--log-level", "ERROR"], ["--log-level=ERROR"]])
    assert.deepEqual((await prepare(args)).command.slice(3), args);
  for (const args of [
    ["--log-level", "INFO"],
    ["--log-level=DEBUG"],
    ["--log-level", "WARN"],
    ["--log-level"],
    ["--log-level", "ERROR", "--log-level=INFO"],
  ])
    await assert.rejects(prepare(args), {
      code: "ENGINE_CONFIGURATION_UNSUPPORTED",
    });
  assert.deepEqual((await prepare(["--log-level=INFO"], false)).command, [
    process.execPath,
    "mimo.js",
    "acp",
    "--log-level=INFO",
  ]);
});
