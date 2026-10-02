import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startHub } from "../../src/main.js";
import { SESSION_WORKSPACE_PLACEHOLDER } from "../../src/tool-packages/index.js";
import {
  startMcp,
  substituteSessionWorkspace,
} from "../fixtures/tool-pack-mcp-client.js";

void test(
  "one-click Tool Pack apply publishes a new engine revision and exposes allow-listed CLI through MCP in the Session workspace",
  { timeout: 30_000 },
  async (t) => {
    const dataDir = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "hh-tool-apply-data-")),
    );
    const workspace = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "hh-tool-apply-workspace-")),
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
    t.after(async () => {
      await hub.server.close();
      await rm(dataDir, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    });

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
