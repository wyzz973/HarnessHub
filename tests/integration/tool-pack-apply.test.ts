import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface, type Interface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startHub } from "../../src/main.js";

async function nextJsonLine(
  lines: Interface,
): Promise<Record<string, unknown>> {
  const [line] = (await once(lines, "line")) as [string];
  return JSON.parse(line) as Record<string, unknown>;
}

void test(
  "one-click Tool Pack apply publishes a new engine revision and exposes allow-listed CLI through MCP",
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
      revision: string;
      capabilities: { cli: string[]; mcp: string[] };
    }>();
    assert.equal(result.ok, true);
    assert.notEqual(result.revision, before);
    assert.deepEqual(result.capabilities.cli, ["cli_echo"]);
    assert.deepEqual(result.capabilities.mcp, ["developer-cli-cli"]);

    const profile = hub.app.engineProfile("pack-engine");
    assert.equal(profile.revision, result.revision);
    const mcp = profile.configuration?.mcpServers?.find(
      (server) => server.name === "developer-cli-cli",
    );
    assert.ok(mcp);
    assert.equal(mcp.type, "stdio");
    assert.ok(mcp.command);
    assert.ok(mcp.args?.length);
    assert.equal(mcp.env?.HHCAP_CLI_WORKSPACE, workspace);

    const child = spawn(mcp.command, mcp.args ?? [], {
      cwd: workspace,
      env: { ...process.env, ...mcp.env },
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    t.after(() => {
      if (!child.killed) child.kill();
    });
    const lines = createInterface({ input: child.stdout });
    t.after(() => lines.close());

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25" },
      })}\n`,
    );
    const initialized = await nextJsonLine(lines);
    assert.equal(initialized.id, 1);

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      })}\n`,
    );
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`,
    );
    const listed = await nextJsonLine(lines);
    const tools = (listed.result as { tools: { name: string }[] }).tools;
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ["cli_echo"],
    );

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "cli_echo",
          arguments: { args: ["alpha", "beta"] },
        },
      })}\n`,
    );
    const called = await nextJsonLine(lines);
    const callResult = called.result as {
      isError: boolean;
      content: { type: string; text: string }[];
    };
    assert.equal(callResult.isError, false);
    const output = JSON.parse(callResult.content[0]!.text) as {
      tool: string;
      args: string[];
      cwd: string;
    };
    assert.equal(output.tool, "echo");
    assert.deepEqual(output.args, ["alpha", "beta"]);
    assert.equal(await realpath(output.cwd), workspace);

    child.stdin.end();
  },
);
