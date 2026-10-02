// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startHub } from "@harnesshub/daemon/main";
import { SESSION_WORKSPACE_PLACEHOLDER } from "@harnesshub/agents/tool-packages/index";
import { prepareConfiguration } from "@harnesshub/agents/configuration/prepare";
import {
  COMMAND_MCP_ENTRY,
  LEGACY_COMMAND_MCP_ENTRY,
} from "@harnesshub/agents/tool-command/entry";
import type { RunId, SessionId } from "@harnesshub/core/types";
import type { EngineMcpServer } from "@harnesshub/core/engine-configuration";
import {
  startMcp,
  substituteSessionWorkspace,
} from "../fixtures/tool-pack-mcp-client.js";
import { temporaryDirectory } from "../support/temporary.js";

void test(
  "one-click Tool Pack apply publishes a new engine revision and exposes allow-listed CLI through MCP in the Session workspace",
  { timeout: 30_000 },
  async (t) => {
    const data = await temporaryDirectory(t, "hh-tool-apply-data-");
    const dataDir = await realpath(data.directory);
    const workspace = await realpath(
      (await temporaryDirectory(t, "hh-tool-apply-workspace-")).directory,
    );
    const source = fileURLToPath(
      new URL("../../../examples/tool-packages/developer-cli", import.meta.url),
    );
    const hub = await startHub({
      dataDir,
      cwd: dataDir,
      demo: true,
      port: 0,
    });
    data.defer(() => hub.server.close());

    const registered = await hub.server.inject({
      method: "POST",
      url: "/v1/engines",
      payload: {
        id: "pack-engine",
        driver: "acp",
        command: [process.execPath, "non-executed-peer.js"],
        configuration: { adapter: "generic" },
      },
    });
    assert.equal(registered.statusCode, 201, registered.body);
    const before = hub.app.engineProfile("pack-engine").revision;

    // Legacy single-engine request: `workspace` is still accepted but ignored.
    const applied = await hub.server.inject({
      method: "POST",
      url: "/v1/tool-packs/apply",
      payload: {
        engineId: "pack-engine",
        source,
        workspace,
      },
    });
    assert.equal(applied.statusCode, 200, applied.body);
    const result = applied.json<{
      ok: boolean;
      engineId: string;
      revision: string;
      capabilities: { cli: string[]; mcp: string[] };
      results: { engineId: string; status: string; revision: string }[];
      warnings: string[];
    }>();
    assert.equal(result.ok, true);
    assert.equal(result.engineId, "pack-engine");
    assert.notEqual(result.revision, before);
    assert.deepEqual(result.capabilities.cli, ["cli_echo"]);
    assert.deepEqual(result.capabilities.mcp, ["developer-cli-cli"]);
    assert.deepEqual(result.results, [
      {
        engineId: "pack-engine",
        status: "applied",
        revision: result.revision,
        capabilities: result.capabilities,
      },
    ]);
    assert.match(result.warnings.join("\n"), /workspace is ignored/);

    const profile = hub.app.engineProfile("pack-engine");
    assert.equal(profile.revision, result.revision);
    const mcp = profile.configuration?.mcpServers?.find(
      (server) => server.name === "developer-cli-cli",
    );
    assert.ok(mcp);
    assert.equal(mcp.type, "stdio");
    assert.deepEqual(mcp.args?.slice(1), [
      "--workspace",
      SESSION_WORKSPACE_PLACEHOLDER,
    ]);
    assert.deepEqual(Object.keys(mcp.env ?? {}), ["HHCAP_CLI_TOOLS_JSON"]);
    assert.equal(JSON.stringify(profile).includes(workspace), false);

    // Without the Worker's substitution the command MCP refuses to start.
    const raw = startMcp(t, {
      command: mcp.command!,
      args: mcp.args!,
      env: mcp.env!,
    });
    assert.notEqual(await raw.exited, 0);
    assert.match(raw.stderr(), /placeholder was not substituted/);

    const client = startMcp(t, substituteSessionWorkspace(mcp, workspace));
    assert.equal((await client.initialize()).id, 1);
    const listed = await client.request("tools/list");
    assert.deepEqual(
      listed.result!.tools!.map((tool) => tool.name),
      ["cli_echo"],
    );
    const called = await client.call("cli_echo", { args: ["alpha", "beta"] });
    assert.equal(called.isError, false);
    const execution = JSON.parse(called.text) as {
      exitCode: number | null;
      stdout: string;
      stderr: string;
      timedOut: boolean;
      truncated: boolean;
    };
    assert.equal(execution.exitCode, 0);
    assert.equal(execution.timedOut, false);
    assert.equal(execution.truncated, false);
    assert.equal(execution.stderr, "");
    const output = JSON.parse(execution.stdout) as {
      tool: string;
      args: string[];
      cwd: string;
    };
    assert.equal(output.tool, "echo");
    assert.deepEqual(output.args, ["alpha", "beta"]);
    assert.equal(await realpath(output.cwd), workspace);
    assert.equal(await client.close(), 0);
  },
);

void test(
  "a Tool Pack binding stored before the agents package existed keeps its record and starts the command MCP from its new entry",
  { timeout: 30_000 },
  async (t) => {
    const data = await temporaryDirectory(t, "hh-tool-legacy-data-");
    const dataDir = await realpath(data.directory);
    const workspace = await realpath(
      (await temporaryDirectory(t, "hh-tool-legacy-workspace-")).directory,
    );
    const source = fileURLToPath(
      new URL("../../../examples/tool-packages/developer-cli", import.meta.url),
    );
    const options = { dataDir, cwd: dataDir, demo: true, port: 0 };
    let hub = await startHub(options);
    data.defer(() => hub.server.close());
    const registered = await hub.server.inject({
      method: "POST",
      url: "/v1/engines",
      payload: {
        id: "pack-engine",
        driver: "acp",
        command: [process.execPath, "non-executed-peer.js"],
        configuration: { adapter: "generic" },
      },
    });
    assert.equal(registered.statusCode, 201, registered.body);
    const applied = await hub.server.inject({
      method: "POST",
      url: "/v1/tool-packs/apply",
      payload: { engineId: "pack-engine", source },
    });
    assert.equal(applied.statusCode, 200, applied.body);
    const bound = hub.app
      .engineProfile("pack-engine")
      .configuration!.mcpServers!.find(
        (server) => server.name === "developer-cli-cli",
      )!;
    assert.equal(bound.args![0], COMMAND_MCP_ENTRY);
    // The same binding as one made before the move stored it in SQLite.
    const legacy: EngineMcpServer = {
      ...bound,
      args: [LEGACY_COMMAND_MCP_ENTRY, ...bound.args!.slice(1)],
    };
    const stored = await hub.server.inject({
      method: "POST",
      url: "/v1/engines",
      payload: {
        id: "legacy-engine",
        driver: "acp",
        command: [process.execPath, "non-executed-peer.js"],
        configuration: { adapter: "generic", mcpServers: [legacy] },
      },
    });
    assert.equal(stored.statusCode, 201, stored.body);

    // A restarted Gateway reads the record back unchanged from SQLite.
    await hub.server.close();
    hub = await startHub(options);
    const profile = hub.app.engineProfile("legacy-engine");
    const record = profile.configuration!.mcpServers![0]!;
    assert.equal(record.args![0], LEGACY_COMMAND_MCP_ENTRY);

    const prepared = await prepareConfiguration(
      {
        profile,
        cwd: workspace,
        stateDir: path.join(dataDir, "legacy-state"),
        sessionId: "legacy-session" as SessionId,
        runId: "legacy-run" as RunId,
        generation: 1,
        input: { text: "", timeoutMs: 1000 },
      },
      {},
    );
    const server = prepared.mcpServers.find(
      (entry) => entry.name === "developer-cli-cli",
    );
    assert.ok(server && "command" in server);
    assert.ok(server.args.includes(COMMAND_MCP_ENTRY), server.args.join(" "));
    assert.equal(server.args.includes(LEGACY_COMMAND_MCP_ENTRY), false);

    const client = startMcp(t, {
      command: server.command,
      args: server.args,
      env: Object.fromEntries(
        server.env.map((entry) => [entry.name, entry.value]),
      ),
    });
    assert.equal((await client.initialize()).id, 1);
    const listed = await client.request("tools/list");
    assert.deepEqual(
      listed.result!.tools!.map((tool) => tool.name),
      ["cli_echo"],
    );
    assert.equal(await client.close(), 0);
  },
);
