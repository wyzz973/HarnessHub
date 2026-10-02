// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { RunId, SessionId } from "@harnesshub/core/types";
import { assetPath } from "../src/assets.js";
import { prepareConfiguration } from "../src/configuration/prepare.js";
import { normalizeEngine } from "../src/engine/registry.js";

/** This checkout: packages/agents/assets/launch-engine.mjs is four levels below it. */
const checkout = path.resolve(assetPath("launch-engine.mjs"), "../../../..");

void test("a stored binding that names a former command MCP entry needs the current entry from the composition root", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "harnesshub-entry-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const former = path.join(
    checkout,
    "packages/agents/dist/src/tool-command/command-mcp.js",
  );
  const spec = {
    profile: normalizeEngine({
      id: "pack-engine",
      driver: "acp",
      command: [process.execPath, "agent.js"],
      configuration: {
        adapter: "generic",
        mcpServers: [
          {
            name: "pack-cli",
            type: "stdio",
            enabled: true,
            command: process.execPath,
            args: [former, "--workspace", directory],
          },
        ],
      },
    }),
    stateDir: directory,
    cwd: directory,
    sessionId: "s" as SessionId,
    runId: "r" as RunId,
    generation: 1,
    input: { text: "test", timeoutMs: 1000 },
  };
  await assert.rejects(prepareConfiguration(spec, {}), {
    code: "COMMAND_MCP_ENTRY_NOT_INJECTED",
  });
  const current = path.join(directory, "command-mcp-main.js");
  const prepared = await prepareConfiguration(
    spec,
    {},
    { commandMcpEntry: current },
  );
  const server = prepared.mcpServers.find((entry) => entry.name === "pack-cli");
  assert.ok(server && "command" in server);
  assert.ok(server.args.includes(current), server.args.join(" "));
  assert.equal(server.args.includes(former), false);
  // A record stays as stored.
  assert.equal(spec.profile.configuration!.mcpServers![0]!.args![0], former);
});
