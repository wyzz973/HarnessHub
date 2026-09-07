import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExecutionSpec } from "../../src/domain/ports.js";
import type { RunId, SessionId } from "../../src/domain/types.js";
import type { PreparedConfiguration } from "../../src/drivers/configuration/prepare.js";
import { prepareNativeMcp } from "../../src/drivers/configuration/native-mcp.js";

function fixture(directory: string, adapter: "pi" | "openclaw" | "kimi") {
  const spec: ExecutionSpec = {
    sessionId: "native-mcp" as SessionId,
    runId: "native-mcp-run" as RunId,
    generation: 1,
    stateDir: directory,
    cwd: directory,
    input: { text: "test", timeoutMs: 1000 },
    profile: {
      id: adapter,
      revision: "1",
      driver: adapter === "kimi" ? "cli" : "acp",
      enabled: true,
      maxConcurrency: 1,
      capabilities: { permissions: false, resume: false, images: false },
      configuration: { adapter },
    },
  };
  const prepared: PreparedConfiguration = {
    command: [process.execPath, "--quiet"],
    env: {},
    instructionPrefix: "",
    mcpServers: [
      {
        name: "local",
        command: process.execPath,
        args: ["peer.mjs"],
        env: [{ name: "SERVER_KEY", value: "private-value" }],
      },
      {
        name: "remote",
        type: "http",
        url: "https://example.com/mcp",
        headers: [{ name: "Authorization", value: "Bearer private-value" }],
      },
    ],
  };
  return { spec, prepared };
}

void test("OpenClaw native MCP consumes ACP entries once, preserves provider config, and writes only env references", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "native-mcp-"));
  t.after(() => rm(directory, { recursive: true }));
  const { spec, prepared } = fixture(directory, "openclaw");
  const root = path.join(directory, "configuration");
  await mkdir(root);
  const file = path.join(root, "openclaw.json");
  await writeFile(
    file,
    JSON.stringify({ models: { mode: "replace" }, tools: { deny: ["exec"] } }),
  );
  prepared.env.OPENCLAW_CONFIG_PATH = file;
  await prepareNativeMcp(spec, prepared);
  const bytes = await readFile(file, "utf8");
  const native = JSON.parse(bytes) as {
    models: unknown;
    tools: unknown;
    mcp: { servers: Record<string, unknown> };
  };
  assert.deepEqual(native.models, { mode: "replace" });
  assert.deepEqual(native.tools, { deny: ["exec"] });
  assert.deepEqual(native.mcp.servers.remote, {
    url: "https://example.com/mcp",
    transport: "streamable-http",
    headers: { Authorization: "${HARNESSHUB_NATIVE_MCP_1_0}" },
  });
  assert.equal(prepared.env.HARNESSHUB_NATIVE_MCP_0_0, "private-value");
  assert.equal(prepared.env.HARNESSHUB_NATIVE_MCP_1_0, "Bearer private-value");
  assert.ok(!bytes.includes("private-value"));
  assert.deepEqual(prepared.mcpServers, []);
  await prepareNativeMcp(spec, prepared);
  assert.equal(await readFile(file, "utf8"), bytes);
});

void test("Pi registers a local extension using the installed SDK without changing model settings", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "native-mcp-pi-"));
  t.after(() => rm(directory, { recursive: true }));
  const { spec, prepared } = fixture(directory, "pi");
  const root = path.join(directory, "configuration");
  const sdk = path.join(
    directory,
    "node_modules/@modelcontextprotocol/sdk/client",
  );
  await mkdir(root);
  await mkdir(sdk, { recursive: true });
  for (const name of ["index", "stdio", "streamableHttp", "sse"])
    await writeFile(path.join(sdk, `${name}.js`), "export {};\n");
  prepared.command = [process.execPath, path.join(directory, "adapter.mjs")];
  prepared.env.PI_CODING_AGENT_DIR = root;
  const file = path.join(root, "settings.json");
  await writeFile(
    file,
    JSON.stringify({ defaultModel: "fixture", extensions: ["existing.mjs"] }),
  );
  await prepareNativeMcp(spec, prepared);
  const settings = JSON.parse(await readFile(file, "utf8")) as {
    defaultModel: string;
    extensions: string[];
  };
  assert.equal(settings.defaultModel, "fixture");
  assert.equal(settings.extensions[0], "existing.mjs");
  assert.match(settings.extensions[1]!, /pi-extension\.mjs$/);
  assert.deepEqual(prepared.mcpServers, []);
  const bytes = await readFile(
    prepared.env.HARNESSHUB_NATIVE_MCP_CONFIG!,
    "utf8",
  );
  assert.ok(!bytes.includes("private-value"));
  assert.match(bytes, /HARNESSHUB_NATIVE_MCP_0_0/);
});

void test("native MCP refuses wrong driver, nonprivate configuration, and duplicate native owners", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "native-mcp-refuse-"));
  t.after(() => rm(directory, { recursive: true }));
  const { spec, prepared } = fixture(directory, "openclaw");
  spec.profile.driver = "cli";
  await assert.rejects(prepareNativeMcp(spec, prepared), {
    code: "ENGINE_CONFIGURATION_UNSUPPORTED",
  });
  spec.profile.driver = "acp";
  prepared.env.OPENCLAW_CONFIG_PATH = path.join(directory, "personal.json");
  await assert.rejects(
    prepareNativeMcp(spec, prepared),
    /private configuration/,
  );
  const file = path.join(directory, "configuration/openclaw.json");
  await writeFile(
    file,
    JSON.stringify({ mcp: { servers: { local: { command: "other" } } } }),
  );
  prepared.env.OPENCLAW_CONFIG_PATH = file;
  await assert.rejects(prepareNativeMcp(spec, prepared), /conflicts/);
});

void test("Kimi config maps native transports but rejects unresolved secrets and fixed config overrides", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "native-mcp-kimi-"));
  t.after(() => rm(directory, { recursive: true }));
  const { spec, prepared } = fixture(directory, "kimi");
  spec.profile.configuration!.mcpServers = [
    {
      name: "local",
      type: "stdio",
      command: "peer",
      enabled: true,
      secretEnv: { KEY: { kind: "env", value: "KEY_SOURCE" } },
    },
  ];
  await assert.rejects(
    prepareNativeMcp(spec, prepared),
    /cannot resolve MCP secretEnv/,
  );
  spec.profile.configuration!.mcpServers = [];
  prepared.mcpServers = [
    {
      name: "local",
      command: process.execPath,
      args: ["peer.mjs", "中文 a&b"],
      env: [{ name: "FIXTURE_MODE", value: "ordinary" }],
    },
  ];
  await prepareNativeMcp(spec, prepared);
  assert.equal(prepared.command.at(-2), "--mcp-config-file");
  const config = JSON.parse(
    await readFile(prepared.command.at(-1)!, "utf8"),
  ) as { mcpServers: Record<string, unknown> };
  assert.deepEqual(config.mcpServers.local, {
    command: process.execPath,
    args: ["peer.mjs", "中文 a&b"],
    env: { FIXTURE_MODE: "ordinary" },
  });
  prepared.mcpServers = fixture(directory, "kimi").prepared.mcpServers;
  await assert.rejects(
    prepareNativeMcp(spec, prepared),
    /Remove fixed Kimi MCP/,
  );
});
