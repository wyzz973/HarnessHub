import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeEngine } from "../../src/engine/registry.js";
import { prepareConfiguration } from "../../src/drivers/configuration/prepare.js";
import type { RunId, SessionId } from "../../src/domain/types.js";

void test("Qwen selected MCP servers finish discovery before prompting, including without a managed provider", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hh-qwen-mcp-ready-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const secret = "synthetic-qwen-mcp-key-only-in-memory";
  const base = {
    cwd: root,
    stateDir: root,
    sessionId: "session" as SessionId,
    runId: "run" as RunId,
    generation: 1,
    input: { text: "", timeoutMs: 1000 },
  };
  for (const type of ["stdio", "http", "sse"] as const) {
    const server = {
      name: "selected",
      type,
      enabled: true,
      ...(type === "stdio"
        ? {
            command: process.execPath,
            args: ["fixture.mjs"],
            secretEnv: { MCP_KEY: { kind: "env", value: "SYNTHETIC_MCP_KEY" } },
          }
        : {
            url: "http://127.0.0.1:9/mcp",
            secretHeaders: {
              Authorization: { kind: "env", value: "SYNTHETIC_MCP_KEY" },
            },
          }),
    };
    const profile = normalizeEngine({
      id: "qwen",
      driver: "acp",
      command: [process.execPath],
      configuration: {
        adapter: "qwen",
        env: { QWEN_CODE_LEGACY_MCP_BLOCKING: "0" },
        mcpServers: [server],
      },
    });
    const prepared = await prepareConfiguration(
      { ...base, profile },
      { SYNTHETIC_MCP_KEY: secret },
    );
    assert.equal(prepared.env.QWEN_CODE_LEGACY_MCP_BLOCKING, "1");
    assert.equal(prepared.mcpServers.length, 1);
    const runtimeServer = prepared.mcpServers[0]!;
    assert.equal(
      ("command" in runtimeServer
        ? runtimeServer.env
        : runtimeServer.headers)[0]!.value,
      secret,
    );
    assert.deepEqual(prepared.command, [process.execPath]);
    assert.equal(prepared.nativeModelSelection, undefined);
    assert.equal(prepared.model, undefined);
  }
  assert.deepEqual(
    await readdir(root),
    [],
    "Preparing MCP must not write resolved credentials or native configuration",
  );
  const disabled = normalizeEngine({
    id: "qwen",
    driver: "acp",
    command: [process.execPath],
    configuration: {
      adapter: "qwen",
      mcpServers: [
        {
          name: "disabled",
          type: "stdio",
          command: process.execPath,
          enabled: false,
          secretEnv: { MCP_KEY: { kind: "env", value: "MISSING_KEY" } },
        },
      ],
    },
  });
  const inactive = await prepareConfiguration(
    { ...base, profile: disabled },
    {},
  );
  assert.equal(inactive.env.QWEN_CODE_LEGACY_MCP_BLOCKING, undefined);
  assert.deepEqual(inactive.mcpServers, []);
});
