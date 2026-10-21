import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { satisfies } from "semver";
import { capabilityReadTables } from "../../src/adapters/capability-reads.js";
import type { CapabilitiesView, CapabilityEntry } from "../../src/contracts/capabilities.js";
import { frontmatter, parseConfig } from "../../src/infrastructure/capabilities/formats.js";
import { CapabilityScan } from "../../src/infrastructure/capabilities/scan.js";
import { resolveHermesHome, resolveOpenClawWorkspace } from "../../src/infrastructure/capabilities/service.js";
import { homePathsIn } from "../../src/web/shown-paths.js";
import { capabilityHome, SECRETS, SYNCED_BUCKET } from "../fixtures/capability-home.js";

const INSTALLED = [["claude", "Claude Code", "2.1.300"], ["codex", "Codex", "0.162.1"], ["cursor", "Cursor", "2026.10.01-e373342"], ["opencode", "OpenCode", "1.18.35"], ["gemini", "Gemini CLI", "0.72.0"],
  ["openclaw", "OpenClaw", "2026.3.23-2"], ["pi", "Pi", "0.85.1"], ["hermes", "Hermes Agent", null], ["dsh", "DeepSeek Harness", "0.2.0-rc.2"]].map(([harnessId, name, version]) => ({ harnessId: harnessId!, name: name!, version: version ?? null }));

/** The view of the fixture home, read the way the Gateway reads it; the home's real path and its link form are both home. */
async function scanned(t: test.TestContext, values: Readonly<Record<string, string>> = {}): Promise<{ view: CapabilitiesView; home: string; outside: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "capability-readers-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home"), outside = join(root, "elsewhere");
  await mkdir(home); await capabilityHome(home, outside);
  const environment = { home, values: { HOME: home, ...values } }, hermesHome = await resolveHermesHome(environment), openclawWorkspace = await resolveOpenClawWorkspace(environment);
  const view = await new CapabilityScan(environment, [home], hermesHome).view(capabilityReadTables(environment, { hermesHome, openclawWorkspace }), INSTALLED, "2026-10-18T00:00:00.000Z");
  return { view, home, outside };
}
const entry = (view: CapabilitiesView, kind: CapabilityEntry["kind"], name: string): CapabilityEntry => {
  const found = view.entries.find(item => item.kind === kind && item.name === name); assert.ok(found, kind + " " + name + " is listed"); return found;
};
const cells = (item: CapabilityEntry, harnessId: string) => item.edges.filter(edge => edge.harnessId === harnessId).map(edge => [edge.mechanism, edge.status, edge.via]);

test("G064-R2 configuration is read tolerantly by format, and a file that does not parse is never guessed from", () => {
  assert.deepEqual(parseConfig("{\n  // note\n  \"a\": [1, 2,],\n}\n", "jsonc"), { ok: true, value: { a: [1, 2] } });
  const toml = parseConfig("[[skills.config]]\npath = \"/p\"\nenabled = false\n[[skills.config]]\nname = \"n\"\n", "toml");
  assert.deepEqual(JSON.parse(JSON.stringify(toml)), { ok: true, value: { skills: { config: [{ path: "/p", enabled: false }, { name: "n" }] } } });
  assert.deepEqual(parseConfig("env:\n  KEY: !!js process.env.KEY\n", "yaml"), { ok: true, value: { env: { KEY: { jsExpression: "process.env.KEY" } } } });
  assert.deepEqual(parseConfig("{ a: 'b', // c\n }", "json5"), { ok: true, value: { a: "b" } });
  for (const [text, format] of [["{ \"a\": ", "json"], ["a = ", "toml"], ["a: [b", "yaml"], ["{ a: ", "json5"]] as const) assert.equal(parseConfig(text, format).ok, false, format);
  assert.deepEqual(frontmatter("---\nname: x\ndescription: y\n---\nbody"), { found: true, value: { name: "x", description: "y" } });
  assert.deepEqual(frontmatter("no frontmatter"), { found: false, value: null });
  assert.deepEqual(frontmatter("---\nname: [x\n---\n"), { found: true, value: null });
});

test("G064-R2 skills are seen by each Harness by its read table, and each Harness's own switch shows them as disabled", async t => {
  const { view } = await scanned(t);
  const alpha = entry(view, "skill", "alpha"), beta = entry(view, "skill", "beta");
  assert.equal(alpha.location, "~/.agents/skills/alpha"); assert.equal(alpha.owner, "skills-cli"); assert.equal(alpha.source, "https://github.com/owner/repo.git");
  assert.deepEqual(alpha.facts, { kind: "skill", files: 3, bytes: alpha.facts?.kind === "skill" ? alpha.facts.bytes : -1 }, "SKILL.md, a script and a file under .git");
  // Claude: two links to one folder load once; Claude's user-invocable-only is not "off".
  assert.deepEqual(cells(alpha, "claude"), [["linked", "active", "~/.claude/skills/alpha"], ["linked", "duplicate", "~/.claude/skills/alpha-again"]]);
  // Codex lists its own copy beside the shared one; OpenClaw skips its redundant link; Hermes's own link wins over the external directory.
  assert.deepEqual(cells(alpha, "codex"), [["native-shared", "active", "~/.agents/skills/alpha"], ["own-copy", "active", "~/.codex/skills/alpha"]]);
  assert.deepEqual(cells(alpha, "openclaw"), [["linked", "rejected", "~/.openclaw/skills/alpha"], ["native-shared", "active", "~/.agents/skills/alpha"]]);
  assert.deepEqual(cells(alpha, "hermes"), [["linked", "active", "~/.hermes/skills/alpha"], ["external-dir", "shadowed", "~/.agents/skills/alpha"]]);
  assert.deepEqual(cells(alpha, "gemini"), [["native-shared", "active", "~/.agents/skills/alpha"], ["own-copy", "shadowed", "~/.gemini/skills/alpha"]]);
  // OpenCode reads ~/.claude/skills too: two links and the folder itself are three copies, one kept without a defined order.
  assert.deepEqual(cells(alpha, "opencode").map(cell => cell[1]), ["duplicate", "duplicate", "duplicate"]);
  assert.ok(alpha.warnings.some(warning => warning.kind === "redundant" && warning.harnessId === "openclaw"));
  // Beta is off in every Harness that has a switch, read from that Harness's own file; Cursor, Pi and dsh have none.
  const reasons = Object.fromEntries(beta.edges.filter(edge => edge.status === "disabled").map(edge => [edge.harnessId, edge.reason]));
  assert.deepEqual(Object.keys(reasons).sort(), ["claude", "codex", "gemini", "hermes", "openclaw", "opencode"]);
  assert.match(reasons.claude!, /skillOverrides/u); assert.match(reasons.codex!, /\[\[skills\.config\]\]/u); assert.match(reasons.gemini!, /skills\.disabled/u);
  assert.match(reasons.opencode!, /permission\.skill 拒绝它（规则 be\*）/u); assert.match(reasons.hermes!, /config\.yaml 的 skills\.disabled/u); assert.match(reasons.openclaw!, /skills\.entries/u);
  assert.deepEqual(beta.edges.filter(edge => ["cursor", "pi", "dsh"].includes(edge.harnessId)).map(edge => edge.status), ["duplicate", "duplicate", "active", "active"]);
  // Entries a Harness cannot use, by its own rules.
  assert.deepEqual(cells(entry(view, "skill", "gamma"), "codex"), [["native-shared", "invalid", "~/.agents/skills/gamma"]]);
  assert.deepEqual(cells(entry(view, "skill", "delta"), "codex"), [["native-shared", "invalid", "~/.agents/skills/delta"]]);
  assert.deepEqual(cells(entry(view, "skill", "mismatch-name"), "cursor").map(cell => cell[1]), ["invalid"]);
  assert.deepEqual(cells(entry(view, "skill", "broken"), "codex"), [["native-shared", "broken-link", "~/.agents/skills/broken"]]);
  assert.deepEqual(cells(entry(view, "skill", "outside"), "openclaw").map(cell => cell[1]), ["rejected"]);
  assert.deepEqual(cells(entry(view, "skill", "outside"), "codex").map(cell => cell[1]), ["active"]);
  // Only the readers that take every SKILL.md find a nested skill: OpenCode's glob and Hermes's walk of its external directory.
  // Hidden folders are skipped by all but Hermes, whose walk skips only .git, .github, .hub and .archive.
  assert.deepEqual(entry(view, "skill", "inner").edges.map(edge => edge.harnessId), ["opencode", "hermes"]);
  assert.deepEqual(entry(view, "skill", "hidden").edges.map(edge => edge.harnessId), ["hermes"]);
  // A skill inside another skill's folder is found by the same two (OpenCode twice: also through Claude's link to beta);
  // .git is skipped by every reader.
  assert.deepEqual(entry(view, "skill", "beta-part").edges.map(edge => edge.harnessId), ["opencode", "opencode", "hermes"]);
  assert.equal(view.entries.some(item => item.name === "in-git"), false);
  // Claude's synced skills, Codex's bundled ones, Hermes's bundled category folder, OpenClaw's workspace and extra directory.
  assert.deepEqual(cells(entry(view, "skill", "zeta"), "claude"), [["synced", "active", "~/.claude/skills/synced/" + SYNCED_BUCKET + "/zeta"]]);
  assert.equal(entry(view, "skill", "zeta").owner, "synced");
  assert.deepEqual(cells(entry(view, "skill", "epsilon"), "claude").map(cell => cell.slice(0, 2)), [["own-copy", "active"], ["synced", "active"]]);
  assert.ok(entry(view, "skill", "epsilon").warnings.some(warning => warning.kind === "duplicate" && warning.harnessId === "claude"));
  assert.deepEqual(cells(entry(view, "skill", "imagegen"), "codex").map(cell => cell.slice(0, 2)), [["bundled", "active"]]);
  assert.equal(entry(view, "skill", "imagegen").owner, "bundled");
  assert.deepEqual([entry(view, "skill", "sigma").owner, cells(entry(view, "skill", "sigma"), "hermes")[0]?.[1]], ["bundled", "active"]);
  assert.deepEqual(cells(entry(view, "skill", "omega"), "openclaw").map(cell => cell.slice(0, 2)), [["own-copy", "active"]]);
  assert.deepEqual(cells(entry(view, "skill", "kappa"), "openclaw").map(cell => cell.slice(0, 2)), [["external-dir", "active"]]);
  // A configuration that does not parse is listed and nothing is taken from it; the readable one still counts.
  assert.deepEqual(view.unreadable.map(item => [item.harnessId, item.file]), [["opencode", "~/.config/opencode/config.json"]]);
  // Versions: inside the checked range or not; DeepSeek Harness's official prerelease is inside, an unknown version is not.
  assert.deepEqual(view.harnesses.map(item => [item.harnessId, item.table]), [["claude", "verified"], ["codex", "verified"], ["cursor", "verified"], ["opencode", "verified"], ["gemini", "unverified"],
    ["openclaw", "verified"], ["pi", "verified"], ["hermes", "unverified"], ["dsh", "verified"]]);
});

test("G064-R2 DeepSeek Harness's read table covers the prerelease its official channel carries, prereleases compared as such", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "capability-readers-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home"); await mkdir(home);
  const environment = { home, values: { HOME: home } }, hermesHome = await resolveHermesHome(environment), openclawWorkspace = await resolveOpenClawWorkspace(environment);
  const tables = capabilityReadTables(environment, { hermesHome, openclawWorkspace }), range = tables.find(table => table.harnessId === "dsh")!.verified;
  assert.equal(satisfies("0.2.0-rc.2", range, { includePrerelease: true }), true, range);
  const mark = async (version: string) => (await new CapabilityScan(environment, [home], hermesHome).view(tables, [{ harnessId: "dsh", name: "DeepSeek Harness", version }], "2026-10-21T00:00:00.000Z")).harnesses.map(item => item.table);
  assert.deepEqual(await mark("0.2.0-rc.2"), ["verified"], "npm's latest, on which the rules were checked");
  assert.deepEqual(await mark("0.2.1-alpha.1"), ["verified"], "the source build verified for real");
  assert.deepEqual(await mark("0.2.0-rc.1"), ["unverified"], "the prerelease before it");
  assert.deepEqual(await mark("0.3.0"), ["unverified"]);
});

test("G064-R3 MCP servers are read as facts without values: transport, program, host, variable names and how they are given", async t => {
  const { view, home } = await scanned(t);
  const facts = (name: string, harnessId: string) => entry(view, "mcp", name).edges.find(edge => edge.harnessId === harnessId)?.facts;
  assert.deepEqual(facts("github", "claude"), { kind: "mcp", transport: "stdio", program: "npx @modelcontextprotocol/server-github", host: null, variables: ["GITHUB_TOKEN", "API_KEY"], headers: [], references: 1, literal: 1, enabled: true });
  assert.deepEqual(facts("remote", "claude"), { kind: "mcp", transport: "http", program: null, host: "mcp.example.com", variables: [], headers: ["Authorization"], references: 1, literal: 0, enabled: true });
  assert.deepEqual(facts("docs", "codex"), { kind: "mcp", transport: "stdio", program: "uvx docs-mcp", host: null, variables: ["DOCS_KEY", "DOCS_TOKEN"], headers: [], references: 1, literal: 1, enabled: true });
  assert.deepEqual(facts("remote", "codex"), { kind: "mcp", transport: "http", program: null, host: "remote.example.com", variables: ["REMOTE_BEARER"], headers: ["X-Api-Key", "Authorization"], references: 1, literal: 1, enabled: false });
  assert.deepEqual(facts("linear", "cursor"), { kind: "mcp", transport: "http", program: null, host: "mcp.linear.app", variables: [], headers: ["Authorization"], references: 1, literal: 0, enabled: true });
  assert.deepEqual(facts("local-one", "opencode"), { kind: "mcp", transport: "stdio", program: "bunx some-mcp", host: null, variables: ["TOKEN"], headers: [], references: 1, literal: 0, enabled: true });
  assert.deepEqual([facts("srv", "gemini")?.kind === "mcp" && facts("srv", "gemini"), facts("legacy", "gemini")], [{ kind: "mcp", transport: "http", program: null, host: "g.example.com", variables: [], headers: ["X-Key"], references: 1, literal: 0, enabled: true },
    { kind: "mcp", transport: "sse", program: null, host: "sse.example.com", variables: [], headers: [], references: 0, literal: 0, enabled: false }]);
  assert.deepEqual(facts("fs", "hermes"), { kind: "mcp", transport: "stdio", program: "npx @modelcontextprotocol/server-filesystem", host: null, variables: ["FS_TOKEN"], headers: [], references: 1, literal: 0, enabled: true });
  // Disabled servers have the status, a literal secret-looking value is warned about by name, and the same name defined two ways is said.
  assert.deepEqual(entry(view, "mcp", "remote").edges.map(edge => [edge.harnessId, edge.status]), [["claude", "active"], ["codex", "disabled"]]);
  assert.ok(entry(view, "mcp", "github").warnings.some(warning => warning.kind === "literal" && warning.text.includes("API_KEY")));
  assert.ok(entry(view, "mcp", "remote").warnings.some(warning => warning.kind === "duplicate"));
  // Free text naming the home directory is shown with ~; the Gateway's guard would refuse the absolute form.
  assert.equal(entry(view, "skill", "notes").description, "Keeps notes in ~/notes and ~");
  assert.notDeepEqual(homePathsIn({ description: "Keeps notes in " + home + "/notes" }, [home], 1 << 20), []);
  // No value, URL path or query, home path or argument other than a launcher's package leaves the reader.
  const text = JSON.stringify(view);
  for (const secret of SECRETS) assert.equal(text.includes(secret), false, secret);
  assert.deepEqual(homePathsIn(view, [home], 1 << 20), []);
  assert.deepEqual(view.harnesses.find(item => item.harnessId === "pi")?.kinds.mcp, "unsupported");
});

test("G064-R4 instructions, subagents, commands, hooks and plugins are read with each Harness's rules and cross reads", async t => {
  const { view } = await scanned(t);
  // Instructions: the override wins in Codex; OpenCode falls back to Claude's file and a new file of its own would end that.
  assert.deepEqual(cells(entry(view, "instructions", "~/.codex/AGENTS.override.md"), "codex").map(cell => cell[1]), ["active"]);
  assert.deepEqual(cells(entry(view, "instructions", "~/.codex/AGENTS.md"), "codex").map(cell => cell[1]), ["shadowed"]);
  const claudeFile = entry(view, "instructions", "~/.claude/CLAUDE.md");
  assert.deepEqual(claudeFile.edges.map(edge => [edge.harnessId, edge.mechanism, edge.status]), [["claude", "config", "active"], ["opencode", "compat-root", "active"]]);
  assert.ok(claudeFile.warnings.some(warning => warning.kind === "shadow" && warning.text.includes("~/.config/opencode/AGENTS.md")));
  assert.deepEqual(claudeFile.facts, { kind: "instructions", bytes: claudeFile.facts?.kind === "instructions" ? claudeFile.facts.bytes : -1, managedBlocks: ["HarnessHub"] });
  // Gemini reads every file context.fileName names; OpenClaw its workspace's AGENTS.md; Hermes has none, Cursor's are not on disk.
  assert.deepEqual(["~/.gemini/GEMINI.md", "~/.gemini/AGENTS.md"].map(name => cells(entry(view, "instructions", name), "gemini")[0]?.[1]), ["active", "active"]);
  assert.deepEqual(cells(entry(view, "instructions", "~/claw-ws/AGENTS.md"), "openclaw").map(cell => cell[1]), ["active"]);
  const reads = Object.fromEntries(view.harnesses.map(item => [item.harnessId, item]));
  assert.equal(reads.hermes?.kinds.instructions, "unsupported"); assert.ok(reads.hermes?.notes.some(note => note.includes("SOUL.md")));
  assert.equal(reads.cursor?.kinds.instructions, "invisible"); assert.equal(reads.cursor?.kinds.plugin, "invisible");
  // Subagents, as each installed version reads them: Claude and Codex recursively by `name`; OpenCode by path with / and its
  // modes too; Gemini only regular files at the top, the others listed as not read. Cursor's CLI reads none at user level.
  assert.deepEqual(["reviewer", "lead", "helper", "scout", "review/strict", "focus", "scribe"].map(name => entry(view, "subagent", name).edges.map(edge => [edge.harnessId, edge.status])),
    [[["claude", "active"]], [["claude", "active"]], [["codex", "active"]], [["codex", "active"]], [["opencode", "active"]], [["opencode", "active"]], [["gemini", "active"]]]);
  assert.deepEqual(["draft", "linked"].map(name => entry(view, "subagent", name).edges.map(edge => [edge.harnessId, edge.status, edge.reason])), [[["gemini", "rejected", "不读以 _ 开头的文件"]], [["gemini", "rejected", "不读符号链接"]]]);
  assert.equal(reads.cursor?.kinds.subagent, "unsupported");
  assert.ok(reads.cursor?.notes.some(note => note.includes("只读工作区里的子 Agent")));
  // Commands: Codex no longer reads its prompts; Cursor's CLI reads its own and Claude's top-level commands; OpenCode names nested ones with /.
  assert.equal(reads.codex?.kinds.command, "unsupported");
  assert.equal(view.entries.some(item => item.kind === "command" && item.name === "fix"), false);
  assert.deepEqual(["frontend:review", "standup", "ship", "deploy", "ops/restart", "git:commit", "hello"].map(name => entry(view, "command", name).edges.map(edge => [edge.harnessId, edge.mechanism])),
    [[["claude", "own-copy"]], [["claude", "own-copy"], ["cursor", "compat-root"]], [["cursor", "own-copy"]], [["opencode", "own-copy"]], [["opencode", "own-copy"]], [["gemini", "own-copy"]], [["pi", "own-copy"]]]);
  assert.ok(entry(view, "command", "standup").warnings.some(warning => warning.kind === "cross" && warning.harnessId === "cursor"));
  // Hooks: a program by its base name only; Cursor also runs Claude's; OpenClaw's own switch is read.
  const guard = view.entries.find(item => item.kind === "hook" && item.name === "PreToolUse（Bash）");
  assert.deepEqual(guard?.facts, { kind: "hook", event: "PreToolUse", matcher: "Bash", program: "guard.sh" });
  assert.deepEqual(guard?.edges.map(edge => [edge.harnessId, edge.mechanism]), [["claude", "config"], ["cursor", "compat-root"]]);
  assert.ok(guard?.warnings.some(warning => warning.kind === "cross"));
  assert.deepEqual(view.entries.filter(item => item.kind === "hook").map(item => [item.name, item.edges.map(edge => edge.harnessId + ":" + edge.status).join(",")]).sort(),
    [["BeforeTool（write_file）", "gemini:active"], ["PreToolUse（Bash）", "claude:active,cursor:active"], ["Stop", "codex:active"], ["beforeShellExecution", "cursor:active"], ["my-hook", "openclaw:disabled"], ["pre_tool_call", "hermes:active"]]);
  // Plugins from each Harness's own records; project-scoped Claude plugins are left out and counted in a note.
  const plugins = view.entries.filter(item => item.kind === "plugin").map(item => [item.name, item.edges[0]?.harnessId, item.edges[0]?.status, item.facts?.kind === "plugin" ? item.facts.version : null]);
  assert.deepEqual(plugins.sort(), [["ext-a", "openclaw", "disabled", "1.0.0"], ["ext-one", "gemini", "active", "0.3.0"], ["off@market", "claude", "disabled", "0.1.0"], ["opencode-foo@1.0.0", "opencode", "active", null],
    ["plug-one", "hermes", "active", "0.1.0"], ["sample@openai", "codex", "disabled", null], ["tool@market", "claude", "active", "1.2.0"]]);
  assert.ok(reads.claude?.notes.some(note => note.includes("1 个插件只装在项目里")));
});

test("G064-R2 Hermes is read from its active profile, and OpenClaw's workspace from its own configuration", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "capability-homes-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { writeFile } = await import("node:fs/promises");
  await mkdir(join(root, ".hermes", "profiles", "work"), { recursive: true }); await writeFile(join(root, ".hermes", "active_profile"), "work\n");
  assert.equal(await resolveHermesHome({ home: root, values: {} }), join(root, ".hermes", "profiles", "work"));
  assert.equal(await resolveHermesHome({ home: root, values: { HERMES_HOME: "~/elsewhere" } }), join(root, "elsewhere"));
  await writeFile(join(root, ".hermes", "active_profile"), "missing\n");
  assert.equal(await resolveHermesHome({ home: root, values: {} }), join(root, ".hermes"));
  assert.equal(await resolveOpenClawWorkspace({ home: root, values: {} }), join(root, ".openclaw", "workspace"));
  assert.equal(await resolveOpenClawWorkspace({ home: root, values: { OPENCLAW_PROFILE: "lab" } }), join(root, ".openclaw", "workspace-lab"));
  await mkdir(join(root, ".openclaw")); await writeFile(join(root, ".openclaw", "openclaw.json"), "{ agents: { list: [{ id: 'a', default: true, workspace: '~/ws-a' }], defaults: { workspace: '~/ws' } } }");
  assert.equal(await resolveOpenClawWorkspace({ home: root, values: {} }), join(root, "ws-a"));
});

test("G064-R6 plugins are read by each Harness's rules: Claude Code's entries, defaults, dependencies and synced plugins, Codex's tables, OpenCode's lists and folders, Hermes's kinds, DeepSeek Harness's profiles", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "capability-plugins-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home"), outside = join(root, "elsewhere");
  await mkdir(home); await capabilityHome(home, outside);
  const put = async (path: string, content: string) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, content); };
  const claude = join(home, ".claude"), market = join(claude, "plugins", "marketplaces", "market"), bucket = "11111111-2222-4333-8444-555555555555_66666666-7777-4888-9999-000000000000";
  // Claude Code: tool depends on needed (off by default, so on only through tool); quiet is off by default; entries without an install.
  await put(join(claude, "settings.json"), JSON.stringify({ enabledPlugins: { "tool@market": true, "stale@market": false, "x@inline": true, "s-one@synced": false } }));
  await put(join(claude, "plugins", "known_marketplaces.json"), JSON.stringify({ market: { installLocation: market } }));
  await put(join(market, ".claude-plugin", "marketplace.json"), JSON.stringify({ plugins: [{ name: "tool", description: "A tool" }, { name: "quiet", defaultEnabled: false }, { name: "needed", defaultEnabled: false }] }));
  await put(join(claude, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "tool@market": [{ scope: "user", version: "1.2.0", installPath: join(claude, "plugins", "cache", "market", "tool", "1.2.0") }],
    "quiet@market": [{ scope: "user", installPath: join(claude, "plugins", "cache", "market", "quiet", "1.0.0") }], "needed@market": [{ scope: "user", installPath: join(claude, "plugins", "cache", "market", "needed", "1.0.0") }],
    "project@market": [{ scope: "project", projectPath: "/p" }] } }));
  await put(join(claude, "plugins", "cache", "market", "tool", "1.2.0", ".claude-plugin", "plugin.json"), JSON.stringify({ name: "tool", dependencies: ["needed"] }));
  await mkdir(join(claude, "plugins", "cache", "market", "quiet", "1.0.0"), { recursive: true }); await mkdir(join(claude, "plugins", "cache", "market", "needed", "1.0.0"), { recursive: true });
  // Synced from claude.ai: one manifest per account; s-one is in two accounts and shown once, its newest copy in s-one~g2.
  await put(join(claude, "plugins", "synced", bucket, "manifest.json"), JSON.stringify({ plugins: [{ name: "s-one", generation: 2, marketplaceName: "kw", version: "0040" }, { name: "s-two", marketplaceName: "kw" }] }));
  await put(join(claude, "plugins", "synced", "second-account", "manifest.json"), JSON.stringify({ plugins: [{ name: "s-one", generation: 1, marketplaceName: "kw" }] }));
  await put(join(claude, "plugins", "synced", ".bucket-" + bucket), "{}");
  // Codex: the same tool in its own table with its own cached version, and a bundled plugin whose table has no enabled.
  await writeFile(join(home, ".codex", "config.toml"), (await readFile(join(home, ".codex", "config.toml"), "utf8")) + "\n[plugins.\"tool@market\"]\nenabled = true\n\n[plugins.\"bundled-one@openai-bundled\"]\n");
  await mkdir(join(home, ".codex", "plugins", "cache", "market", "tool", "1.1.0"), { recursive: true });
  // OpenCode: a tuple with options, the same spec twice, both plugin folders (dot files and links too, .mjs and folders not), and the TUI's list.
  const opencode = join(home, ".config", "opencode");
  await put(join(opencode, "opencode.jsonc"), "{\n  \"plugin\": [\"opencode-foo@1.0.0\", [\"tuple-plugin@2.0.0\", { \"level\": 1 }], \"opencode-foo@1.0.0\"],\n}\n");
  await put(join(opencode, "plugin", "one.ts"), "export default {}\n"); await put(join(opencode, "plugin", ".dotted.js"), "export default {}\n");
  await put(join(opencode, "plugin", "skip.mjs"), "export default {}\n"); await mkdir(join(opencode, "plugins", "folder.js"), { recursive: true });
  await put(join(root, "linked-plugin.js"), "export default {}\n"); await symlink(join(root, "linked-plugin.js"), join(opencode, "plugins", "two.js"));
  await put(join(opencode, "tui.json"), JSON.stringify({ plugin: ["tui-thing"] }));
  // Hermes: disabled wins over enabled, a category folder with plugin.yml, a memory provider told by its __init__.py, a model provider, a hidden folder.
  const hermes = join(home, ".hermes");
  await put(join(hermes, "config.yaml"), "plugins:\n  enabled: [plug-one, memo, image_gen/openai-off]\n  disabled: [plug-one]\n");
  await put(join(hermes, "plugins", "image_gen", "openai", "plugin.yml"), "name: openai\nkind: backend\n");
  await put(join(hermes, "plugins", "memo", "plugin.yaml"), "name: memo\n"); await put(join(hermes, "plugins", "memo", "__init__.py"), "def register(ctx):\n    ctx.register_memory_provider(Memo())\n");
  await put(join(hermes, "plugins", "prov", "plugin.yaml"), "name: prov\nkind: model-provider\n"); await put(join(hermes, "plugins", ".hidden-plug", "plugin.yaml"), "name: hidden-plug\n");
  // DeepSeek Harness: a profile's dependency is a plugin; node_modules is not a profile.
  await put(join(home, ".dsh", "profiles", "acp", "package.json"), JSON.stringify({ name: "acp", private: true, dependencies: { "@x/dsh-plugin-a": "^1.0.0" } }));
  await put(join(home, ".dsh", "profiles", "node_modules", "package.json"), JSON.stringify({ dependencies: { "not-a-plugin": "1" } }));

  const environment = { home, values: { HOME: home } }, hermesHome = await resolveHermesHome(environment), openclawWorkspace = await resolveOpenClawWorkspace(environment);
  const view = await new CapabilityScan(environment, [home], hermesHome).view(capabilityReadTables(environment, { hermesHome, openclawWorkspace }), INSTALLED, "2026-10-19T00:00:00.000Z");
  const reads = Object.fromEntries(view.harnesses.map(item => [item.harnessId, [item.pluginSwitch, item.pluginReason !== null]]));
  assert.deepEqual(reads, { claude: ["file", false], codex: ["file", false], cursor: [null, true], opencode: [null, true], gemini: [null, true], openclaw: [null, true], pi: [null, false], hermes: [null, true], dsh: [null, true] });
  const plugin = (name: string, harnessId?: string) => { const found = view.entries.find(item => item.kind === "plugin" && item.name === name && (harnessId === undefined || item.edges.some(edge => edge.harnessId === harnessId))); assert.ok(found, name); return found; };
  const edge = (name: string, harnessId: string) => { const found = plugin(name, harnessId).edges.find(item => item.harnessId === harnessId)!;
    return [found.status, found.facts?.kind === "plugin" ? found.facts.enabled : "?", found.facts?.kind === "plugin" ? found.facts.switchable : "?", found.reason]; };
  // One row for the plugin both Claude Code and Codex have, each with its own version and place.
  const tool = plugin("tool@market");
  assert.equal(tool.key, "plugin:tool@market");
  assert.deepEqual(tool.edges.map(item => [item.harnessId, item.status, item.via, item.facts?.kind === "plugin" ? item.facts.version : null]),
    [["claude", "active", "~/.claude/plugins/installed_plugins.json", "1.2.0"], ["codex", "active", "~/.codex/config.toml", "1.1.0"]]);
  assert.equal(tool.description, "A tool");
  assert.deepEqual(edge("quiet@market", "claude"), ["disabled", false, true, "按默认停用（enabledPlugins 里没有这一项）"]);
  assert.deepEqual(edge("needed@market", "claude"), ["active", true, true, "按默认启用（enabledPlugins 里没有这一项）"], "an enabled plugin depending on it turns it on");
  assert.deepEqual(edge("stale@market", "claude").slice(0, 3), ["rejected", false, false]); assert.match(String(edge("stale@market", "claude")[3]), /有条目但未安装/u);
  assert.deepEqual(edge("x@inline", "claude").slice(0, 3), ["active", true, false]); assert.match(String(edge("x@inline", "claude")[3]), /从 inline 加载/u);
  const synced = view.entries.filter(item => item.kind === "plugin" && item.name.endsWith("@synced"));
  assert.deepEqual(synced.map(item => [item.name, item.owner, item.edges[0]?.mechanism, item.edges[0]?.status, item.edges[0]?.via]),
    [["s-one@synced", "synced", "synced", "disabled", "~/.claude/plugins/synced"], ["s-two@synced", "synced", "synced", "active", "~/.claude/plugins/synced"]]);
  assert.ok(synced.every(item => item.edges[0]?.facts?.kind === "plugin" && !item.edges[0].facts.switchable));
  assert.equal(JSON.stringify(view).includes(bucket), false, "the account a synced plugin belongs to is never shown");
  assert.ok(view.harnesses.find(item => item.harnessId === "claude")?.notes.includes("另有 1 个插件只装在项目里，这里不列出。"));
  assert.deepEqual(edge("bundled-one@openai-bundled", "codex"), ["active", null, true, "表里没有 enabled，Codex 的缺省值没有核实"]);
  assert.equal(plugin("bundled-one@openai-bundled").owner, "bundled");
  // OpenCode: what its loader reads, each once; .mjs files and folders are not plugins; the TUI's plugins are marked.
  const opencodes = view.entries.filter(item => item.kind === "plugin" && item.edges.some(item2 => item2.harnessId === "opencode")).map(item => item.name).sort();
  assert.deepEqual(opencodes, [".dotted.js", "one.ts", "opencode-foo@1.0.0", "tui-thing", "tuple-plugin@2.0.0", "two.js"]);
  assert.match(String(edge("tui-thing", "opencode")[3]), /TUI 插件/u);
  // Hermes: disabled first; memory providers by their provider setting; model providers always; a category's key is its path.
  assert.deepEqual(edge("plug-one", "hermes").slice(0, 2), ["disabled", false]); assert.match(String(edge("plug-one", "hermes")[3]), /plugins\.disabled/u);
  assert.deepEqual(edge("image_gen/openai", "hermes").slice(0, 2), ["disabled", false]); assert.equal(edge("image_gen/openai", "hermes")[3], "不在 plugins.enabled 里");
  assert.deepEqual(edge("memo", "hermes").slice(0, 2), ["active", null]); assert.match(String(edge("memo", "hermes")[3]), /memory\.provider/u);
  assert.deepEqual(edge("prov", "hermes").slice(0, 2), ["active", true]); assert.deepEqual(edge("hidden-plug", "hermes").slice(0, 2), ["disabled", false]);
  // DeepSeek Harness: each profile's dependencies, node_modules is not a profile.
  assert.deepEqual(edge("@x/dsh-plugin-a", "dsh"), ["active", true, false, "装在 profile acp 里，装上即启用"]);
  assert.equal(view.entries.some(item => item.name === "not-a-plugin"), false);
  assert.deepEqual(homePathsIn(view, [home], 1 << 20), []);

  // Hermes without a plugins.enabled list enables none of the user's plugins.
  await writeFile(join(hermes, "config.yaml"), "model:\n  default: x\n");
  const plain = await new CapabilityScan(environment, [home], hermesHome).view(capabilityReadTables(environment, { hermesHome, openclawWorkspace }), INSTALLED, "2026-10-19T00:00:00.000Z");
  const prov = plain.entries.find(item => item.kind === "plugin" && item.name === "hidden-plug")?.edges[0];
  assert.deepEqual([prov?.status, prov?.reason], ["disabled", "config.yaml 没有 plugins.enabled，Hermes 一个用户插件都不启用"]);
});
