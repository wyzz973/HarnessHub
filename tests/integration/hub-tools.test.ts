import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { CapabilityError } from "../../src/contracts/capabilities.js";
import { TABLE_ENV, TABLE_MCP_NAME } from "../../src/contracts/table.js";
import { CapabilityChanges } from "../../src/infrastructure/capabilities/changes.js";

// The Hub's own tools written into a Harness's user-level MCP configuration and taken out again (docs/decisions/LOG.md,
// 2026-11-11), through the real capability service: its store, backups, guard and read-back. The files are fakes in a
// temporary home; Claude Code's own `mcp add-json` and `mcp remove` are played by a runner that edits the fake file.

const NODE = "/opt/fixture/bin/node";
const INSTALLED = [{ harnessId: "claude", name: "Claude Code", version: "2.1.302" }, { harnessId: "codex", name: "Codex", version: "0.162.1" },
  { harnessId: "opencode", name: "OpenCode", version: "2.2.5" }, { harnessId: "dsh", name: "DeepSeek Harness", version: "0.2.1" },
  { harnessId: "hermes", name: "Hermes Agent", version: "0.22.4" }, { harnessId: "openclaw", name: "OpenClaw", version: "2026.10.5" }];
const CLAUDE_BEFORE = { numStartups: 3, mcpServers: { other: { type: "stdio", command: "uvx", args: ["other-mcp"], env: { LOG_LEVEL: "info" } } }, projects: { "/tmp/p": { allowedTools: [] } } };
const CODEX_BEFORE = "model = \"fixture-model\" # the user's model stays\n\n[mcp_servers.docs]\ncommand = \"uvx\"\nargs = [\"docs-mcp\"]\nenv_vars = [\"DOCS_TOKEN\"]\nstartup_timeout_sec = 20\n\n[plugins.\"sample@market\"]\nenabled = false\n";

async function setup(t: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hub-tools-"))), home = join(root, "home"), claudeFile = join(home, ".claude.json"), codexFile = join(home, ".codex", "config.toml");
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(home, ".claude"), { recursive: true }); await mkdir(join(home, ".codex"), { recursive: true }); await mkdir(join(root, "data"));
  const tool = join(root, "dist", "hub-tools.js");
  await mkdir(join(root, "dist")); await writeFile(tool, "// the Hub's tool program\n");
  await writeFile(claudeFile, JSON.stringify(CLAUDE_BEFORE, null, 2)); await writeFile(codexFile, CODEX_BEFORE);
  const runs: (readonly string[])[] = [];
  // Claude Code as observed: `mcp add-json` and `mcp remove` rewrite its file (the prediction runs on a copy in CLAUDE_CONFIG_DIR).
  const claude = async (args: readonly string[], options: { readonly env: Readonly<Record<string, string>> }) => {
    runs.push(args);
    const target = options.env.CLAUDE_CONFIG_DIR ? join(options.env.CLAUDE_CONFIG_DIR, ".claude.json") : claudeFile;
    const value = JSON.parse(await readFile(target, "utf8")) as { mcpServers?: Record<string, unknown> };
    value.mcpServers ??= {};
    if (args[1] === "add-json") value.mcpServers[args[2]!] = JSON.parse(args[3]!); else delete value.mcpServers[args[2]!];
    await writeFile(target, JSON.stringify(value, null, 2));
  };
  const program = { node: NODE, tool };
  const changes = new CapabilityChanges({ root: join(root, "data"), generation: 1, assertOwner: () => {}, environment: { home, values: { HOME: home } }, homes: [home], processes: async () => "", claude, hubTools: program });
  t.after(() => changes.close());
  const claudeJson = async () => JSON.parse(await readFile(claudeFile, "utf8")) as typeof CLAUDE_BEFORE & { mcpServers: Record<string, unknown> };
  const codexToml = async () => JSON.parse(JSON.stringify(parseToml(await readFile(codexFile, "utf8")))) as { mcp_servers: Record<string, Record<string, unknown>> };
  const state = async (harnessId: string) => (await changes.hubTools(INSTALLED)).harnesses.find(row => row.harnessId === harnessId)!.state;
  const listed = async () => (await changes.mcpInventory(INSTALLED)).servers.map(server => server.name);
  return { root, home, claudeFile, codexFile, tool, program, runs, changes, claudeJson, codexToml, state, listed };
}
const refused = (code: string) => (error: unknown) => error instanceof CapabilityError && error.code === code;

test("Claude Code: the Hub's tools are written by its own command with the table variables named, once, beside what is there, and taken out clean", async t => {
  const f = await setup(t);
  assert.deepEqual(await f.listed(), []);
  assert.equal(await f.state("claude"), "absent");
  const installed = await f.changes.installHubTools("claude", INSTALLED);
  assert.deepEqual([installed.action, installed.status, installed.state, installed.changes.map(change => [change.kind, change.status])], ["install", "done", "synced", [["mcp-sync", "applied"]]]);
  const written = await f.claudeJson();
  assert.deepEqual(written.mcpServers[TABLE_MCP_NAME], { type: "stdio", command: NODE, args: [f.tool, "mcp"],
    env: { [TABLE_ENV.session]: "${" + TABLE_ENV.session + "}", [TABLE_ENV.url]: "${" + TABLE_ENV.url + "}" } }, "variables by name, never a token or an address");
  assert.deepEqual([written.mcpServers.other, written.numStartups, written.projects], [CLAUDE_BEFORE.mcpServers.other, 3, CLAUDE_BEFORE.projects], "what was there stays");
  assert.deepEqual(await f.listed(), [TABLE_MCP_NAME], "the server is in HarnessHub's list, visible and removable there");
  assert.equal(await f.state("claude"), "synced");
  // Again: nothing to do, and Claude's command is not run.
  const runsBefore = f.runs.length, again = await f.changes.installHubTools("claude", INSTALLED);
  assert.deepEqual([again.status, again.changes], ["unchanged", []]); assert.equal(f.runs.length, runsBefore);
  // The Hub moved: the entry points at a program that is not the Hub's now. The status says so, and installing again brings it up to date.
  const moved = join(f.root, "dist", "moved-hub-tools.js"); await writeFile(moved, "// moved\n");
  const old = f.program.tool; f.program.tool = moved;
  assert.equal(await f.state("claude"), "outdated");
  const updated = await f.changes.installHubTools("claude", INSTALLED);
  assert.deepEqual([updated.status, updated.state], ["done", "synced"]);
  assert.deepEqual((await f.claudeJson()).mcpServers[TABLE_MCP_NAME], { type: "stdio", command: NODE, args: [moved, "mcp"], env: { [TABLE_ENV.session]: "${" + TABLE_ENV.session + "}", [TABLE_ENV.url]: "${" + TABLE_ENV.url + "}" } });
  assert.notEqual(old, moved);
  // A running Claude Code writes its old copy of the file back: the entry is gone. The user's install writes it again.
  const lost = await f.claudeJson(); delete lost.mcpServers[TABLE_MCP_NAME]; await writeFile(f.claudeFile, JSON.stringify(lost, null, 2));
  assert.equal(await f.state("claude"), "removed");
  assert.equal((await f.changes.installHubTools("claude", INSTALLED)).status, "done");
  assert.equal(await f.state("claude"), "synced");
  // Taken out: only HarnessHub's entry goes, the list forgets the server with the last Harness that held it.
  const removed = await f.changes.uninstallHubTools("claude", INSTALLED);
  assert.deepEqual([removed.action, removed.status, removed.state, removed.changes.map(change => [change.kind, change.status])], ["uninstall", "done", "absent", [["mcp-remove", "applied"]]]);
  const after = await f.claudeJson();
  assert.deepEqual(after.mcpServers, CLAUDE_BEFORE.mcpServers); assert.deepEqual([after.numStartups, after.projects], [3, CLAUDE_BEFORE.projects]);
  assert.deepEqual(await f.listed(), []);
  assert.deepEqual((await f.changes.uninstallHubTools("claude", INSTALLED)).status, "unchanged");
});

test("Codex: the Hub's tools are a table of their own that forwards the table variables by name, every other byte of the file stays, and taking them out gives the file back", async t => {
  const f = await setup(t);
  assert.equal(await f.state("codex"), "absent");
  const installed = await f.changes.installHubTools("codex", INSTALLED);
  assert.deepEqual([installed.status, installed.state, installed.changes.map(change => change.kind)], ["done", "synced", ["mcp-sync"]]);
  const text = await readFile(f.codexFile, "utf8");
  assert.ok(text.startsWith(CODEX_BEFORE), "the file as it was, then the new table");
  const entry = (await f.codexToml()).mcp_servers[TABLE_MCP_NAME];
  assert.deepEqual(entry, { command: NODE, args: [f.tool, "mcp"], env_vars: [TABLE_ENV.session, TABLE_ENV.url] }, "Codex's stdio server sees only what env_vars names; no token, no address");
  assert.equal(Object.hasOwn(entry ?? {}, "env"), false);
  assert.deepEqual((await f.codexToml()).mcp_servers.docs, { command: "uvx", args: ["docs-mcp"], env_vars: ["DOCS_TOKEN"], startup_timeout_sec: 20 });
  assert.equal(await f.state("codex"), "synced");
  // Again changes nothing, byte for byte.
  const same = await f.changes.installHubTools("codex", INSTALLED);
  assert.equal(same.status, "unchanged"); assert.equal(await readFile(f.codexFile, "utf8"), text);
  // Out again: the file is exactly what it was, comment and all.
  const removed = await f.changes.uninstallHubTools("codex", INSTALLED);
  assert.deepEqual([removed.status, removed.state], ["done", "absent"]);
  assert.equal(await readFile(f.codexFile, "utf8"), CODEX_BEFORE);
  assert.deepEqual(await f.listed(), []);
  assert.equal((await f.changes.uninstallHubTools("codex", INSTALLED)).status, "unchanged");
  // The user adds a setting of their own to the Hub's table; an update to the new program keeps it.
  await f.changes.installHubTools("codex", INSTALLED);
  await writeFile(f.codexFile, (await readFile(f.codexFile, "utf8")) + "startup_timeout_sec = 45\n"); // the Hub's table is the last in the file
  const moved = join(f.root, "dist", "moved-hub-tools.js"); await writeFile(moved, "// moved\n"); f.program.tool = moved;
  assert.equal(await f.state("codex"), "outdated");
  await f.changes.installHubTools("codex", INSTALLED);
  assert.deepEqual((await f.codexToml()).mcp_servers[TABLE_MCP_NAME], { command: NODE, args: [moved, "mcp"], env_vars: [TABLE_ENV.session, TABLE_ENV.url], startup_timeout_sec: 45 });
});

test("an entry of the same name that someone else wrote is never overwritten or removed, and a Harness the tools are not written into is refused with what is known of it", async t => {
  const f = await setup(t);
  // Claude Code and Codex each have a harnesshub of the user's own.
  const claude = await f.claudeJson(); claude.mcpServers[TABLE_MCP_NAME] = { type: "stdio", command: "/usr/bin/mine", args: ["--mine"] };
  await writeFile(f.claudeFile, JSON.stringify(claude, null, 2));
  const mine = CODEX_BEFORE + "\n[mcp_servers." + TABLE_MCP_NAME + "]\ncommand = \"/usr/bin/mine\"\n";
  await writeFile(f.codexFile, mine);
  const claudeBytes = await readFile(f.claudeFile, "utf8"), runs = f.runs.length;
  for (const id of ["claude", "codex"]) {
    assert.equal(await f.state(id), "different");
    await assert.rejects(f.changes.installHubTools(id, INSTALLED), refused("CAPABILITY_TARGET_REFUSED"));
    await assert.rejects(f.changes.uninstallHubTools(id, INSTALLED), refused("CAPABILITY_TARGET_REFUSED"));
  }
  assert.equal(await readFile(f.claudeFile, "utf8"), claudeBytes); assert.equal(await readFile(f.codexFile, "utf8"), mine); assert.equal(f.runs.length, runs, "Claude's command never ran");
  assert.deepEqual(await f.listed(), [], "a refusal leaves nothing in the list");
  // The other four can be written too; the two whose gateway runs the tools say that they cannot tell the conversation.
  const view = await f.changes.hubTools(INSTALLED);
  assert.deepEqual(view.harnesses.map(row => [row.harnessId, row.state, row.writable]), [["claude", "different", true], ["codex", "different", true], ["opencode", "absent", true], ["dsh", "absent", true], ["hermes", "absent", true], ["openclaw", "absent", true]]);
  const reason = (id: string) => view.harnesses.find(row => row.harnessId === id)?.reason ?? "";
  assert.match(reason("hermes"), /网关/u); assert.match(reason("hermes"), /mcpServers/u);
  assert.match(reason("openclaw"), /Gateway/u);
  assert.equal(reason("opencode"), ""); assert.equal(reason("dsh"), "");
  await assert.rejects(f.changes.installHubTools("codex", INSTALLED.filter(row => row.harnessId !== "codex")), refused("CAPABILITY_NOT_FOUND"));
  // The tool program is not there: nothing is written.
  await rm(f.tool);
  await writeFile(f.codexFile, CODEX_BEFORE);
  assert.equal((await f.changes.hubTools(INSTALLED)).tool.present, false);
  await assert.rejects(f.changes.installHubTools("codex", INSTALLED), (error: unknown) => refused("CAPABILITY_UNSUPPORTED")(error) && /还没有构建/u.test((error as Error).message));
  assert.equal(await readFile(f.codexFile, "utf8"), CODEX_BEFORE);
});

test("the view names the program with the home as ~, and an identical entry nobody recorded becomes HarnessHub's without a file change", async t => {
  const f = await setup(t);
  const real = join(f.home, "Hub", "dist", "hub-tools.js"); await mkdir(join(f.home, "Hub", "dist"), { recursive: true }); await writeFile(real, "//\n"); f.program.tool = real;
  const view = await f.changes.hubTools(INSTALLED);
  assert.deepEqual([view.name, view.tool], [TABLE_MCP_NAME, { command: NODE + " ~/Hub/dist/hub-tools.js mcp", present: true }]);
  assert.equal(JSON.stringify(view).includes(f.home + "/"), false, "no absolute spelling of the home");
  // The entry already there is the very one the Hub would write (restored from a backup, say): recorded as HarnessHub's, the file untouched.
  await writeFile(f.codexFile, CODEX_BEFORE + "\n[mcp_servers." + TABLE_MCP_NAME + "]\nargs = [\"" + real + "\", \"mcp\"]\ncommand = \"" + NODE + "\"\nenv_vars = [\"" + TABLE_ENV.session + "\", \"" + TABLE_ENV.url + "\"]\n");
  const bytes = await readFile(f.codexFile, "utf8");
  assert.equal(await f.state("codex"), "claimable");
  const claimed = await f.changes.installHubTools("codex", INSTALLED);
  assert.deepEqual([claimed.status, claimed.state, claimed.changes.map(change => [change.kind, change.diff])], ["done", "synced", [["mcp-claim", null]]]);
  assert.equal(await readFile(f.codexFile, "utf8"), bytes);
  const out = await f.changes.uninstallHubTools("codex", INSTALLED);
  assert.deepEqual([out.status, out.state], ["done", "absent"]);
  assert.equal(await readFile(f.codexFile, "utf8"), CODEX_BEFORE);
});

test("without a program given, the entry runs this build's cli/hub-tools.js on the Node that runs the Hub", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hub-tools-default-"))), home = join(root, "home");
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(home); await mkdir(join(root, "data"));
  const changes = new CapabilityChanges({ root: join(root, "data"), generation: 1, assertOwner: () => {}, environment: { home, values: { HOME: home } }, homes: [home], processes: async () => "" });
  t.after(() => changes.close());
  // Next to the Gateway's own entry points (dist/src/cli/web.js): where the compiled tool program is put.
  const sibling = fileURLToPath(new URL("../../src/cli/hub-tools.js", import.meta.url)), view = await changes.hubTools(INSTALLED);
  assert.equal(view.tool.command, process.execPath + " " + sibling + " mcp");
  assert.equal(view.tool.present, existsSync(sibling));
});

test("OpenCode, DeepSeek Harness, Hermes and OpenClaw: the tools go into each one's user-level file as it writes a server, and out again byte for byte", async t => {
  const f = await setup(t);
  const opencodeFile = join(f.home, ".config", "opencode", "opencode.json"), dshFile = join(f.home, ".dsh", "cordis.patch.yml");
  const hermesFile = join(f.home, ".hermes", "config.yaml"), openclawFile = join(f.home, ".openclaw", "openclaw.json");
  for (const file of [opencodeFile, dshFile, hermesFile, openclawFile]) await mkdir(join(file, ".."), { recursive: true });
  // Each file already holds the user's own settings, which stay.
  const before = {
    opencode: JSON.stringify({ $schema: "https://opencode.ai/config.json", mcp: { servers: { docs: { type: "local", command: ["uvx", "docs-mcp"] } } } }, null, 2) + "\n",
    dsh: "- insert:\n    - name: '@deepseek-ai/dsh-mcp-client'\n      id: mine\n      config:\n        serverName: docs\n        transport: stdio\n        command: uvx\n        args: [docs-mcp]\n",
    hermes: "model:\n  default: fixture-model\nmcp_servers:\n  docs:\n    command: uvx\n    args: [docs-mcp]\n",
    openclaw: JSON.stringify({ gateway: { port: 18789 }, mcp: { servers: { docs: { command: "uvx", args: ["docs-mcp"] } } } }, null, 2) + "\n",
  };
  await writeFile(opencodeFile, before.opencode); await writeFile(dshFile, before.dsh); await writeFile(hermesFile, before.hermes); await writeFile(openclawFile, before.openclaw);
  const env = (style: "opencode" | "dollar" | "js") => Object.fromEntries([TABLE_ENV.session, TABLE_ENV.url].map(name => [name, style === "opencode" ? "{env:" + name + "}" : style === "dollar" ? "${" + name + "}" : "process.env." + name]));
  const readJson = async (file: string) => JSON.parse(await readFile(file, "utf8")) as Record<string, any>;
  const { parse: parseYaml, parseDocument } = await import("yaml");
  for (const id of ["opencode", "dsh", "hermes", "openclaw"]) {
    const installed = await f.changes.installHubTools(id, INSTALLED);
    assert.deepEqual([installed.status, installed.state], ["done", "synced"], id + ": " + JSON.stringify(installed.notes));
    assert.equal(await f.state(id), "synced");
  }
  assert.deepEqual((await readJson(opencodeFile)).mcp.servers, { docs: { type: "local", command: ["uvx", "docs-mcp"] }, [TABLE_MCP_NAME]: { type: "local", command: [NODE, f.tool, "mcp"], environment: env("opencode") } });
  assert.deepEqual((parseYaml(await readFile(hermesFile, "utf8")) as Record<string, any>).mcp_servers[TABLE_MCP_NAME], { command: NODE, args: [f.tool, "mcp"], env: env("dollar") });
  assert.deepEqual((await readJson(openclawFile)).mcp.servers, { docs: { command: "uvx", args: ["docs-mcp"] }, [TABLE_MCP_NAME]: { command: NODE, args: [f.tool, "mcp"], env: env("dollar") } });
  assert.equal((await readJson(openclawFile)).gateway.port, 18789);
  // DeepSeek Harness: a client row of its own beside the user's, every variable read explicitly (its bridge drops names that look like credentials).
  const rows = (parseDocument(await readFile(dshFile, "utf8"), { customTags: [{ tag: "!!js", resolve: (text: string) => text }] }).toJS() as { insert: { id: string; config: Record<string, unknown> }[] }[]).flatMap(patch => patch.insert);
  assert.deepEqual(rows.map(row => row.config.serverName), ["docs", TABLE_MCP_NAME]);
  assert.deepEqual(rows[1]!.config, { serverName: TABLE_MCP_NAME, transport: "stdio", command: NODE, args: [f.tool, "mcp"], env: env("js") });
  assert.match(await readFile(dshFile, "utf8"), /HARNESSHUB_SESSION: !!js "process\.env\.HARNESSHUB_SESSION"/u, "a JavaScript expression, never a value");
  // The two whose gateway runs the tools are written but never said to have them; the two whose process the Hub starts are.
  assert.deepEqual(await Promise.all(["opencode", "dsh", "hermes", "openclaw"].map(id => f.changes.hubToolsInstalled(id, INSTALLED))), [true, true, false, false]);
  const notes = (await f.changes.installHubTools("hermes", INSTALLED)).notes;
  assert.ok(notes.some(note => /已经装好/u.test(note)));
  for (const id of ["opencode", "dsh", "hermes", "openclaw"]) {
    const out = await f.changes.uninstallHubTools(id, INSTALLED);
    assert.deepEqual([out.status, out.state], ["done", "absent"], id);
  }
  assert.deepEqual([await readFile(opencodeFile, "utf8"), await readFile(dshFile, "utf8"), await readFile(hermesFile, "utf8"), await readFile(openclawFile, "utf8")], [before.opencode, before.dsh, before.hermes, before.openclaw], "each file is as it was");
  // An openclaw.json in JSON5's own syntax is not rewritten.
  await writeFile(openclawFile, "{ gateway: { port: 18789 } }\n");
  await assert.rejects(f.changes.installHubTools("openclaw", INSTALLED), (error: unknown) => error instanceof CapabilityError && /JSON5/u.test(error.message));
  assert.equal(await readFile(openclawFile, "utf8"), "{ gateway: { port: 18789 } }\n");
});
