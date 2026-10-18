import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { capabilityReadTables } from "../../src/adapters/capability-reads.js";
import type { CapabilitiesView, CapabilityEntry } from "../../src/contracts/capabilities.js";
import { frontmatter, parseConfig } from "../../src/infrastructure/capabilities/formats.js";
import { CapabilityScan } from "../../src/infrastructure/capabilities/scan.js";
import { resolveHermesHome, resolveOpenClawWorkspace } from "../../src/infrastructure/capabilities/service.js";
import { homePathsIn } from "../../src/web/shown-paths.js";
import { capabilityHome, SECRETS, SYNCED_BUCKET } from "../fixtures/capability-home.js";

const INSTALLED = [["claude", "Claude Code", "2.1.300"], ["codex", "Codex", "0.162.1"], ["cursor", "Cursor", "2026.10.01-e373342"], ["opencode", "OpenCode", "1.18.35"], ["gemini", "Gemini CLI", "0.72.0"],
  ["openclaw", "OpenClaw", "2026.3.23-2"], ["pi", "Pi", "0.85.1"], ["hermes", "Hermes Agent", null], ["dsh", "DeepSeek Harness", "0.2.1-alpha.1"]].map(([harnessId, name, version]) => ({ harnessId: harnessId!, name: name!, version: version ?? null }));

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
  assert.deepEqual(alpha.facts, { kind: "skill", files: 2, bytes: alpha.facts?.kind === "skill" ? alpha.facts.bytes : -1 });
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
  // Only the recursive readers find a nested skill: OpenCode's glob and Hermes's external directory. Hidden folders are never read.
  assert.deepEqual(entry(view, "skill", "inner").edges.map(edge => edge.harnessId), ["opencode", "hermes"]);
  assert.equal(view.entries.some(item => item.name === "hidden"), false);
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
  // Versions: inside the checked range or not.
  assert.deepEqual(view.harnesses.map(item => [item.harnessId, item.table]), [["claude", "verified"], ["codex", "verified"], ["cursor", "verified"], ["opencode", "verified"], ["gemini", "unverified"],
    ["openclaw", "verified"], ["pi", "verified"], ["hermes", "unverified"], ["dsh", "verified"]]);
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
  // Subagents and commands: Cursor uses Claude's and Codex's subagents, said as a cross read; nested commands are namespaced.
  assert.deepEqual(entry(view, "subagent", "reviewer").edges.map(edge => [edge.harnessId, edge.mechanism]), [["claude", "own-copy"], ["cursor", "compat-root"]]);
  assert.ok(entry(view, "subagent", "reviewer").warnings.some(warning => warning.kind === "cross" && warning.harnessId === "cursor"));
  assert.deepEqual(entry(view, "subagent", "helper").edges.map(edge => [edge.harnessId, edge.mechanism]), [["codex", "own-copy"], ["cursor", "compat-root"]]);
  assert.deepEqual(["frontend:review", "fix", "deploy", "git:commit", "hello"].map(name => entry(view, "command", name).edges.map(edge => edge.harnessId)), [["claude"], ["codex"], ["opencode"], ["gemini"], ["pi"]]);
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
