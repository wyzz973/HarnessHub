import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TABLE_MCP_NAME } from "../../src/contracts/table.js";
import { CapabilityChanges } from "../../src/infrastructure/capabilities/changes.js";

// Whether a Harness's configuration holds the Hub's tools as an install now would write them (HubTools.isInstalled), the fact a native
// process the Hub starts is told about itself (docs/decisions/LOG.md, 2026-11-11). Through the real capability service on fake files in
// a temporary home; Claude Code's own `mcp add-json` and `mcp remove` are played by a runner that edits the fake file.

const NODE = "/opt/fixture/bin/node";
const INSTALLED = [{ harnessId: "claude", name: "Claude Code", version: "2.1.302" }, { harnessId: "codex", name: "Codex", version: "0.162.1" },
  { harnessId: "opencode", name: "OpenCode", version: "2.2.5" }, { harnessId: "dsh", name: "DeepSeek Harness", version: "0.2.1" },
  { harnessId: "hermes", name: "Hermes Agent", version: "0.22.4" }, { harnessId: "openclaw", name: "OpenClaw", version: "2026.10.5" }];

async function setup(t: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hub-tools-installed-"))), home = join(root, "home"), claudeFile = join(home, ".claude.json"), codexFile = join(home, ".codex", "config.toml");
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(home, ".claude"), { recursive: true }); await mkdir(join(home, ".codex"), { recursive: true });
  const tool = join(root, "dist", "hub-tools.js");
  await mkdir(join(root, "dist")); await writeFile(tool, "// the Hub's tool program\n");
  await writeFile(claudeFile, JSON.stringify({ mcpServers: {} }, null, 2)); await writeFile(codexFile, "model = \"fixture-model\"\n");
  const claude = async (args: readonly string[], options: { readonly env: Readonly<Record<string, string>> }) => {
    const target = options.env.CLAUDE_CONFIG_DIR ? join(options.env.CLAUDE_CONFIG_DIR, ".claude.json") : claudeFile;
    const value = JSON.parse(await readFile(target, "utf8")) as { mcpServers?: Record<string, unknown> };
    value.mcpServers ??= {};
    if (args[1] === "add-json") value.mcpServers[args[2]!] = JSON.parse(args[3]!); else delete value.mcpServers[args[2]!];
    await writeFile(target, JSON.stringify(value, null, 2));
  };
  const program = { node: NODE, tool };
  // Each service has a data root of its own, so one has recorded what it wrote and another has not: the second is a Hub the entry was installed from elsewhere.
  const service = async (name: string) => {
    await mkdir(join(root, name));
    const changes = new CapabilityChanges({ root: join(root, name), generation: 1, assertOwner: () => {}, environment: { home, values: { HOME: home } }, homes: [home], processes: async () => "", claude, hubTools: program });
    t.after(() => changes.close());
    return changes;
  };
  return { root, claudeFile, codexFile, program, service };
}

test("the Hub's tools are installed in a Harness when its configuration holds them as an install now would write them, whoever recorded them; every other state and every other Harness says no", async t => {
  const f = await setup(t), writer = await f.service("writer"), stranger = await f.service("stranger");
  const held = async (changes: typeof writer, harnessId: string) => changes.hubToolsInstalled(harnessId, INSTALLED);
  for (const harnessId of ["claude", "codex"]) assert.equal(await held(writer, harnessId), false, harnessId + ": nothing written yet");
  await writer.installHubTools("claude", INSTALLED); await writer.installHubTools("codex", INSTALLED);
  const claudeText = await readFile(f.claudeFile, "utf8"), codexText = await readFile(f.codexFile, "utf8");
  for (const harnessId of ["claude", "codex"]) assert.equal(await held(writer, harnessId), true, harnessId + ": written by this Hub");
  // A Hub with another data directory (a ruler's, a second copy) never recorded the write: the identical entry is as good.
  for (const harnessId of ["claude", "codex"]) assert.equal(await held(stranger, harnessId), true, harnessId + ": an identical entry nobody recorded");
  assert.equal((await stranger.hubTools(INSTALLED)).harnesses.find(row => row.harnessId === "claude")!.state, "claimable");
  // Asking writes nothing.
  assert.deepEqual([await readFile(f.claudeFile, "utf8"), await readFile(f.codexFile, "utf8")], [claudeText, codexText]);

  // The Harnesses the tools are not written into yet, and one that is not installed.
  for (const harnessId of ["opencode", "dsh", "hermes", "openclaw", "gemini"]) assert.equal(await held(writer, harnessId), false, harnessId);

  // The program moved (another build, another path): the entry points at a program the Hub no longer names, and says no until it is installed again.
  const moved = join(f.root, "dist", "moved-hub-tools.js"); await writeFile(moved, "// moved\n");
  const old = f.program.tool; f.program.tool = moved;
  for (const changes of [writer, stranger]) for (const harnessId of ["claude", "codex"]) assert.equal(await held(changes, harnessId), false, harnessId + ": the entry names another program");
  await writer.installHubTools("claude", INSTALLED);
  assert.equal(await held(writer, "claude"), true); assert.equal(await held(writer, "codex"), false, "codex was not updated");
  // A tool program that is not built where the Hub expects it is nothing to run.
  f.program.tool = join(f.root, "dist", "not-built.js");
  assert.equal(await held(writer, "claude"), false);
  f.program.tool = old;
  assert.equal(await held(writer, "codex"), true, "back where it was");

  // Someone else's entry of the same name, and an entry that was removed after HarnessHub wrote it.
  await writeFile(f.claudeFile, JSON.stringify({ mcpServers: { [TABLE_MCP_NAME]: { type: "stdio", command: "uvx", args: ["somebody-elses-server"] } } }, null, 2));
  assert.equal(await held(stranger, "claude"), false, "a same-named entry that is not the Hub's");
  await writeFile(f.claudeFile, JSON.stringify({ mcpServers: {} }, null, 2));
  assert.equal(await held(writer, "claude"), false, "removed");
});
