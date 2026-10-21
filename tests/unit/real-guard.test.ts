import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { application } from "../../src/cli/session-application.js";
import { protectedConfigurationPaths } from "../../src/infrastructure/management/native.js";
import { versionVerification } from "../../src/infrastructure/management/verified-versions.js";
import { prepareConfiguration } from "../../src/infrastructure/session/binding-factory.js";
import { homePathsIn } from "../../src/web/shown-paths.js";
import { GUARD_TARGETS, GuardError, compare, describeGuard, evidenceHeader, guardTargets, guardedFiles, guardedPath, isCredentialPath, main, parseSnapshot, recheck, snapshot, snapshotPaths,
  standaloneHeader, type GuardEnvironment, type GuardSnapshot } from "../real/guard.js";

/** A string written into guarded files: a snapshot that contained content would contain it. */
const MARKER = "HH-GUARD-CONTENT-" + randomUUID();
const GUARD = fileURLToPath(new URL("../real/guard.js", import.meta.url)), REPOSITORY = fileURLToPath(new URL("../../../", import.meta.url));

async function temporary(t: TestContext, prefix: string): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function put(path: string, text: string, mode = 0o600): Promise<void> { await mkdir(dirname(path), { recursive: true }); await writeFile(path, text, { mode }); }
function guardError(code: GuardError["code"], ...mentions: readonly string[]): (error: unknown) => boolean {
  return error => { assert.ok(error instanceof GuardError, String(error)); assert.equal(error.code, code, error.message); for (const text of mentions) assert.ok(error.message.includes(text), error.message); return true; };
}
function entry(taken: GuardSnapshot, path: string) { return taken.paths.find(item => item.path === path); }

test("G060-NC14 each guard list follows the variables of the capability read tables, covers the product's protected configuration files and knows no other Harness", () => {
  const home = "/Users/guard-fixture", tilde = (path: string) => path.startsWith(home + "/") ? "~/" + path.slice(home.length + 1) : path;
  const list = (id: string, env: GuardEnvironment) => guardedFiles(id, env).map(item => [tilde(item.path), item.kind, item.part ?? null]);
  const plain: GuardEnvironment = { home, values: { HOME: home } };
  assert.deepEqual(list("claude", plain), [["~/.claude/settings.json", "file", null], ["~/.claude/settings.local.json", "file", null], ["~/.claude.json", "file", "mcpServers"], ["~/.claude/CLAUDE.md", "file", null]]);
  assert.deepEqual(list("codex", plain), [["~/.codex/config.toml", "file", null], ["~/.codex/AGENTS.md", "file", null], ["~/.codex/AGENTS.override.md", "file", null]]);
  assert.deepEqual(list("opencode", plain), [["~/.config/opencode/opencode.json", "file", null], ["~/.config/opencode/opencode.jsonc", "file", null], ["~/.config/opencode/AGENTS.md", "file", null]]);
  assert.deepEqual(list("openclaw", plain), [["~/.openclaw/openclaw.json", "file", null], ["~/.openclaw/workspace/AGENTS.md", "file", null], ["~/.openclaw/skills", "dir", null]]);
  assert.deepEqual(list("hermes", plain), [["~/.hermes/config.yaml", "file", null], ["~/.hermes/SOUL.md", "file", null], ["~/.hermes/skills", "dir", null], ["~/.agents/skills", "dir", null]]);
  assert.deepEqual(list("dsh", plain), [["~/.dsh/settings.yaml", "file", null], ["~/.dsh/settings.yaml.imported", "file", null], ["~/.dsh/cordis.patch.yml", "file", null],
    ["~/.dsh/profiles/acp/cordis.patch.yml", "file", null], ["~/.dsh/profiles/acp/package.json", "file", null], ["~/.dsh/AGENTS.md", "file", null]]);
  assert.deepEqual(list("cursor", plain), [["~/.cursor/cli-config.json", "file", null]]);
  assert.deepEqual(list("gemini", plain), [["~/.gemini/settings.json", "file", null]]);
  assert.deepEqual(list("pi", plain), [["~/.pi/agent/settings.json", "file", null], ["~/.pi/agent/models.json", "file", null]]);
  assert.deepEqual(list("shared", plain), [["~/.agents/skills", "dir", null], ["~/.zshrc", "file", null], ["~/.zprofile", "file", null], ["~/.bashrc", "file", null],
    ["~/.bash_profile", "file", null], ["~/.profile", "file", null], ["~/.npmrc", "file", null]]);
  // Each variable moves its Harness's files where that Harness reads them; ~/ in a variable is the home.
  const moved: GuardEnvironment = { home, values: { HOME: home, CODEX_HOME: "/srv/codex", CLAUDE_CONFIG_DIR: "~/claude-alt", XDG_CONFIG_HOME: "/srv/xdg", OPENCLAW_STATE_DIR: "/srv/openclaw",
    OPENCLAW_CONFIG_PATH: "/srv/openclaw.json", OPENCLAW_PROFILE: "work", HERMES_HOME: "/srv/hermes", DSH_HOME: "/srv/dsh", PI_CODING_AGENT_DIR: "/srv/pi", GEMINI_CLI_HOME: "/srv/gemini" } };
  assert.deepEqual(list("claude", moved).map(row => row[0]), ["~/claude-alt/settings.json", "~/claude-alt/settings.local.json", "~/claude-alt/.claude.json", "~/.claude.json", "~/claude-alt/CLAUDE.md"]);
  assert.deepEqual(list("codex", moved).map(row => row[0]), ["/srv/codex/config.toml", "/srv/codex/AGENTS.md", "/srv/codex/AGENTS.override.md"]);
  assert.deepEqual(list("opencode", moved).map(row => row[0]), ["/srv/xdg/opencode/opencode.json", "/srv/xdg/opencode/opencode.jsonc", "/srv/xdg/opencode/AGENTS.md"]);
  assert.deepEqual(list("opencode", { home, values: { ...moved.values, OPENCODE_CONFIG_DIR: "/srv/opencode" } }).map(row => row[0]), ["/srv/opencode/opencode.json", "/srv/opencode/opencode.jsonc", "/srv/opencode/AGENTS.md"]);
  assert.deepEqual(list("openclaw", moved).map(row => row[0]), ["/srv/openclaw.json", "~/.openclaw/workspace-work/AGENTS.md", "/srv/openclaw/skills"]);
  assert.deepEqual(list("hermes", moved).map(row => row[0]), ["/srv/hermes/config.yaml", "/srv/hermes/SOUL.md", "/srv/hermes/skills", "~/.agents/skills"]);
  assert.deepEqual(list("dsh", moved).map(row => row[0]).slice(0, 2), ["/srv/dsh/settings.yaml", "/srv/dsh/settings.yaml.imported"]);
  assert.deepEqual([...list("pi", moved), ...list("gemini", moved)].map(row => row[0]), ["/srv/pi/settings.json", "/srv/pi/models.json", "/srv/gemini/.gemini/settings.json"]);
  // Hermes's sticky profile and OpenClaw's configured workspace, once resolved, are what the lists use.
  assert.deepEqual(list("hermes", { ...plain, hermesHome: home + "/.hermes/profiles/work" }).map(row => row[0]).slice(0, 2), ["~/.hermes/profiles/work/config.yaml", "~/.hermes/profiles/work/SOUL.md"]);
  assert.equal(list("openclaw", { ...plain, openclawWorkspace: "/srv/agent" })[1]![0], "/srv/agent/AGENTS.md");
  // The product's own definition of user configuration (the upgrade sandbox's protected files) is guarded, wherever the variables put it.
  for (const values of [{ HOME: home }, { HOME: home, CLAUDE_CONFIG_DIR: "/srv/claude", OPENCLAW_CONFIG_PATH: "/srv/oc.json", OPENCLAW_STATE_DIR: "/srv/oc" }]) {
    const guarded = new Set(["shared", ...GUARD_TARGETS].flatMap(id => guardedFiles(id, { home, values }).map(item => item.path)));
    for (const file of protectedConfigurationPaths({ home, values }).files) assert.ok(guarded.has(file), file + " is protected by the product but not guarded");
  }
  // A Harness without a list is refused, not snapshotted as if it had none.
  assert.throws(() => guardedFiles("workbuddy", plain), guardError("UNKNOWN_HARNESS", "workbuddy"));
  assert.throws(() => guardTargets(["claude", "constructor"]), guardError("UNKNOWN_HARNESS", "constructor"));
  assert.deepEqual(guardTargets(["dsh", "claude", "dsh"]), ["claude", "dsh"]);
});

test("G060-NC14 a snapshot holds digests, entry names and link targets only; compare finds a changed byte, a relinked skill, a deleted file and a new entry by their ~ paths", async t => {
  const home = await temporary(t, "real-guard-home-"), source = { home, values: { HOME: home } }, ids = ["claude", "dsh", "hermes"];
  // A home as a user's looks: configuration, a Claude file with counters and MCP servers, skills with a link.
  await put(join(home, ".claude", "settings.json"), '{"model":"' + MARKER + '"}\n');
  const claudeJson = (startups: number, servers: Record<string, unknown>) => JSON.stringify({ numStartups: startups, projects: { ["/work/" + startups]: { lastCost: startups } }, mcpServers: servers });
  await put(join(home, ".claude.json"), claudeJson(7, { docs: { command: "npx", args: [MARKER], env: { TOKEN: "${TOKEN}" } } }));
  await put(join(home, ".dsh", "settings.yaml"), "profile: " + MARKER + "\n");
  await put(join(home, ".dsh", "profiles", "acp", "cordis.patch.yml"), "[]\n");
  await put(join(home, ".hermes", "config.yaml"), "model: " + MARKER + "\n");
  await put(join(home, ".hermes", "SOUL.md"), MARKER + "\n");
  await mkdir(join(home, ".hermes", "skills", "local-skill"), { recursive: true });
  for (const name of ["alpha", "beta", "gamma"]) await put(join(home, "library", name, "SKILL.md"), MARKER);
  await mkdir(join(home, ".agents", "skills", "alpha"), { recursive: true });
  const link = join(home, ".agents", "skills", "beta"); await symlink(join(home, "library", "beta"), link);
  await put(join(home, ".zshrc"), "export PATH=" + MARKER + "\n");
  const before = await snapshot(ids, source), text = JSON.stringify(before);
  assert.ok(!text.includes(MARKER), "a snapshot carries no file content");
  assert.ok(!text.includes(home) && homePathsIn(before, [home]).length === 0, "and no absolute home path");
  assert.deepEqual(before.harnesses, ["claude", "dsh", "hermes"]);
  assert.deepEqual(entry(before, "~/.agents/skills"), { path: "~/.agents/skills", groups: ["hermes", "shared"], kind: "dir",
    entries: [{ name: "alpha", type: "dir" }, { name: "beta", type: "link", target: "~/library/beta" }], links: 1 });
  assert.deepEqual(entry(before, "~/.hermes/skills"), { path: "~/.hermes/skills", groups: ["hermes"], kind: "dir", entries: [{ name: "local-skill", type: "dir" }], links: 0 });
  assert.deepEqual(entry(before, "~/.dsh/AGENTS.md"), { path: "~/.dsh/AGENTS.md", groups: ["dsh"], kind: "missing" });
  const settings = entry(before, "~/.claude/settings.json");
  assert.ok(settings?.kind === "file" && /^[0-9a-f]{64}$/u.test(settings.sha256) && settings.part === undefined);
  assert.equal(entry(before, "~/.claude.json")?.kind === "file" && entry(before, "~/.claude.json")?.groups.join(), "claude");
  assert.deepEqual([...new Set(before.paths.map(item => item.path))].length, before.paths.length, "each location once");
  // Nothing changed: unchanged, also after the snapshot went through a file.
  assert.deepEqual(compare(before, await snapshot(ids, source)), { unchanged: true, changed: [] });
  assert.deepEqual(compare(parseSnapshot(JSON.parse(text)), before), { unchanged: true, changed: [] });
  // Every running Claude Code rewrites its counters and projects: those are not configuration; its MCP servers are.
  await writeFile(join(home, ".claude.json"), claudeJson(8, { docs: { env: { TOKEN: "${TOKEN}" }, args: [MARKER], command: "npx" } }));
  assert.deepEqual(compare(before, await snapshot(ids, source)), { unchanged: true, changed: [] }, "counters, projects and key order are not compared");
  await put(join(home, ".agents", "skills", ".DS_Store"), "Finder");
  assert.deepEqual(compare(before, await snapshot(ids, source)), { unchanged: true, changed: [] }, "a Finder record is not a skill");
  // Invalid samples: each change is found, by its ~ path alone.
  const changes: readonly (readonly [what: string, change: () => Promise<unknown>, path: string])[] = [
    ["one byte of a configuration file", () => writeFile(join(home, ".claude", "settings.json"), '{"model":"' + MARKER + '!"}\n'), "~/.claude/settings.json"],
    ["a skill link pointed elsewhere", async () => { await unlink(link); await symlink(join(home, "library", "gamma"), link); }, "~/.agents/skills"],
    ["a configuration file deleted", () => rm(join(home, ".dsh", "settings.yaml")), "~/.dsh/settings.yaml"],
    ["a new entry in a skills directory", () => mkdir(join(home, ".hermes", "skills", "added")), "~/.hermes/skills"],
    ["a missing configuration file created", () => put(join(home, ".claude", "CLAUDE.md"), "notes"), "~/.claude/CLAUDE.md"],
    ["Claude's user-level MCP servers changed", () => writeFile(join(home, ".claude.json"), claudeJson(9, {})), "~/.claude.json"],
    ["a shell startup file edited", () => appendFile(join(home, ".zshrc"), "alias x=y\n"), "~/.zshrc"],
    ["a configuration file replaced by a link to the same bytes", async () => {
      const bytes = await readFile(join(home, ".claude", "settings.json")); await put(join(home, "dotfiles", "settings.json"), bytes.toString());
      await rm(join(home, ".claude", "settings.json")); await symlink(join(home, "dotfiles", "settings.json"), join(home, ".claude", "settings.json"));
    }, "~/.claude/settings.json"],
  ];
  let previous = before;
  for (const [what, change, path] of changes) {
    await change();
    const next = await snapshot(ids, source);
    assert.deepEqual(compare(previous, next), { unchanged: false, changed: [path] }, what);
    previous = next;
  }
  assert.equal(entry(previous, "~/.claude/settings.json")?.link, "~/dotfiles/settings.json");
  // Hermes switched to another profile mid-run: its files are now elsewhere, and the locations of both count as changed.
  await put(join(home, ".hermes", "profiles", "work", "config.yaml"), MARKER); await put(join(home, ".hermes", "active_profile"), "work\n");
  assert.deepEqual(compare(previous, await snapshot(ids, source)).changed, ["~/.hermes/SOUL.md", "~/.hermes/config.yaml", "~/.hermes/profiles/work/SOUL.md",
    "~/.hermes/profiles/work/config.yaml", "~/.hermes/profiles/work/skills", "~/.hermes/skills"]);
  await rm(join(home, ".hermes", "active_profile"));
  const all = compare(before, previous);
  assert.deepEqual(all.changed, [...new Set(changes.map(change => change[2]))].sort(), "against the first snapshot every change is listed once, sorted");
  assert.ok(!JSON.stringify(all).includes(home));
  // Snapshots of different Harnesses or formats say nothing about each other.
  assert.throws(() => compare(before, { ...before, harnesses: ["claude"] }), guardError("SNAPSHOT_MISMATCH"));
  assert.throws(() => parseSnapshot({ ...before, format: "other/1" }), guardError("INVALID_SNAPSHOT"));
  assert.throws(() => parseSnapshot({ ...before, extra: true }), guardError("INVALID_SNAPSHOT", "extra"));
  assert.throws(() => parseSnapshot({ ...before, paths: [{ path: "~/x", groups: ["shared"], kind: "file", sha256: "not-a-digest" }] }), guardError("INVALID_SNAPSHOT", "sha256"));
  assert.throws(() => parseSnapshot({ ...before, paths: [{ path: "~/x", groups: ["shared"], kind: "dir", entries: [{ name: "a", type: "link", target: "b" }], links: 0 }] }), guardError("INVALID_SNAPSHOT", "links"));
  // recheck: the same comparison at the end of a run, in one line for an assertion.
  const check = await recheck(before, source);
  assert.equal(check.unchanged, false); assert.equal(describeGuard(check), "configuration changed: " + all.changed.join(", "));
});

test("G060-NC14 credential files are never read or named, even when present; forcing one into a list, or reaching one through a link, is refused", async t => {
  const home = await temporary(t, "real-guard-credentials-"), env: GuardEnvironment = { home, values: { HOME: home } }, secret = "HH-GUARD-SECRET-" + randomUUID();
  const required = [".hermes/.env", ".hermes/auth.json", ".dsh/.credentials.yaml", ".codex/auth.json", ".claude/.credentials.json"];
  const known = [...required, ".local/share/opencode/auth.json", ".gemini/oauth_creds.json", ".pi/agent/auth.json", ".netrc"];
  for (const file of known) await put(join(home, file), secret);
  // Configuration around them, and credential-named entries inside guarded directories.
  await put(join(home, ".codex", "config.toml"), "model = \"" + MARKER + "\"\n");
  await put(join(home, ".hermes", "config.yaml"), MARKER);
  await put(join(home, ".agents", "skills", ".env"), secret); await put(join(home, ".openclaw", "skills", "auth.json"), secret);
  await put(join(home, ".openclaw", "skills", "kept", "SKILL.md"), MARKER);
  const taken = await snapshot([...GUARD_TARGETS], env), text = JSON.stringify(taken);
  assert.ok(!text.includes(secret) && !text.includes(MARKER), "no content");
  for (const name of [".env", "auth.json", ".credentials", "oauth_creds", ".netrc"]) assert.ok(!text.includes(name), name + " is named in the snapshot");
  assert.deepEqual(entry(taken, "~/.openclaw/skills"), { path: "~/.openclaw/skills", groups: ["openclaw"], kind: "dir", entries: [{ name: "kept", type: "dir" }], links: 0 });
  // No list names a credential, at the default locations or where the variables move them.
  const moved: GuardEnvironment = { home, values: { HOME: home, HERMES_HOME: join(home, "alt", "hermes"), DSH_HOME: join(home, "alt", "dsh"), CODEX_HOME: join(home, "alt", "codex"), CLAUDE_CONFIG_DIR: join(home, "alt", "claude") } };
  for (const environment of [env, moved]) for (const id of ["shared", ...GUARD_TARGETS]) for (const item of guardedFiles(id, environment)) assert.equal(isCredentialPath(item.path, environment), false, item.path);
  // Forcing one into a list fails at once, naming it with ~ only.
  for (const file of required) assert.throws(() => guardedPath(join(home, file), "file", "shared", env), guardError("CREDENTIAL_PATH", "~/" + file), file);
  for (const path of [join(home, "Library", "Keychains", "login.keychain-db"), join(home, ".ssh", "id_ed25519"), join(home, ".CODEX", "AUTH.JSON"), join(home, ".config", "service", ".env.local")])
    assert.throws(() => guardedPath(path, "file", "shared", env), guardError("CREDENTIAL_PATH"), path);
  assert.throws(() => guardedPath(join(home, "alt", "hermes", ".env"), "file", "hermes", moved), guardError("CREDENTIAL_PATH"));
  assert.throws(() => guardedPath(join(home, ".dsh", ".credentials.yaml"), "file", "dsh", moved), guardError("CREDENTIAL_PATH"), "the default location stays refused when a variable moves the home");
  assert.throws(() => guardedPath(join(home, ".codex", "auth.json"), "file", "codex", env), (error: unknown) => error instanceof GuardError && !error.message.includes(home));
  // A hand-made entry that bypasses guardedPath is refused before anything is opened.
  await assert.rejects(snapshotPaths([{ path: join(home, ".codex", "auth.json"), kind: "file", groups: ["codex"] }], env, ["codex"]), guardError("CREDENTIAL_PATH", "~/.codex/auth.json"));
  // A configuration file that is a link to a credential is refused, not followed; at the end of a run that is a failed guard.
  const before = await snapshot(["codex"], env);
  await rm(join(home, ".codex", "config.toml")); await symlink(join(home, ".codex", "auth.json"), join(home, ".codex", "config.toml"));
  await assert.rejects(snapshot(["codex"], env), guardError("CREDENTIAL_PATH", "~/.codex/auth.json"));
  const check = await recheck(before, env);
  assert.deepEqual([check.unchanged, check.changed], [false, []]); assert.match(check.failure ?? "", /^CREDENTIAL_PATH: /u);
  assert.match(describeGuard(check), /could not take its second snapshot/u); assert.ok(!describeGuard(check).includes(home));
});

test("G060-NC14 the command line: snapshot writes a new 0600 file of digests, compare exits 0 or 1 with ~ paths, and bad arguments exit 64", async t => {
  const home = await temporary(t, "real-guard-cli-"), out = (name: string) => join(home, name);
  await put(join(home, ".claude", "settings.json"), MARKER); await put(join(home, ".dsh", "settings.yaml"), MARKER);
  // The command run as a user runs it: only this test's home is read.
  const run = (...args: readonly string[]) => spawnSync(process.execPath, [GUARD, ...args], { cwd: home, env: { HOME: home, PATH: "/usr/bin:/bin", LANG: "C.UTF-8" }, encoding: "utf8", timeout: 60_000 });
  const first = run("snapshot", "claude,dsh", out("before.json"));
  assert.equal(first.status, 0, first.stderr); assert.match(first.stdout, /locations of claude, dsh and the shared list, digests only/u);
  assert.equal((await stat(out("before.json"))).mode & 0o777, 0o600);
  const written = await readFile(out("before.json"), "utf8");
  assert.ok(!written.includes(MARKER) && !written.includes(home) && !(first.stdout + first.stderr).includes(MARKER));
  assert.deepEqual(parseSnapshot(JSON.parse(written)).harnesses, ["claude", "dsh"]);
  assert.equal(run("snapshot", "claude,dsh", out("before.json")).status, 73, "a snapshot never replaces a file");
  const same = run("compare", out("before.json"), out("before.json"));
  assert.equal(same.status, 0, same.stderr); assert.match(same.stdout, /^guard: unchanged \(\d+ locations\)\n$/u);
  await writeFile(join(home, ".dsh", "settings.yaml"), MARKER + "!");
  assert.equal(run("snapshot", "dsh,claude", out("after.json")).status, 0);
  const changed = run("compare", out("before.json"), out("after.json"));
  assert.equal(changed.status, 1, changed.stderr); assert.equal(changed.stdout, "guard: changed\n  ~/.dsh/settings.yaml\n");
  for (const args of [[], ["snapshot"], ["snapshot", "claude"], ["snapshot", "claude,workbuddy", out("x.json")], ["snapshot", " , ", out("x.json")], ["compare", out("before.json")], ["diff", "a", "b"], ["snapshot", "claude", out("y.json"), "extra"]])
    assert.equal(run(...args).status, 64, JSON.stringify(args));
  assert.equal(run("snapshot", "claude", out("claude.json")).status, 0);
  assert.equal(run("compare", out("before.json"), out("claude.json")).status, 64, "snapshots of different Harnesses");
  await writeFile(out("broken.json"), "{");
  await writeFile(out("forged.json"), JSON.stringify({ ...JSON.parse(written), paths: [{ path: "~/x", groups: ["shared"], kind: "file", sha256: MARKER }] }));
  for (const file of ["broken.json", "forged.json", "absent.json"]) {
    const result = run("compare", out(file), out("after.json"));
    assert.equal(result.status, 65, file); assert.ok(!result.stderr.includes(MARKER), "an invalid snapshot is named, never echoed");
  }
  // main() is the same command with the environment given, for callers in this process.
  const lines: string[] = [];
  assert.equal(await main(["compare", out("before.json"), out("after.json")], { output: text => { lines.push(text); }, errors: text => { lines.push(text); } }), 1);
  assert.deepEqual(lines, ["guard: changed\n  ~/.dsh/settings.yaml\n"]);
  assert.equal(await main(["snapshot", "dsh", out("main.json")], { source: { home, values: { HOME: home } }, output: () => {}, errors: () => {} }), 0);
  // As a file of `node --test` the module runs no command (nor does it when imported by the suites).
  const asTest = spawnSync(process.execPath, ["--test", GUARD], { cwd: home, env: { HOME: home, PATH: "/usr/bin:/bin", LANG: "C.UTF-8" }, encoding: "utf8", timeout: 120_000 });
  assert.equal(asTest.status, 0, asTest.stdout + asTest.stderr); assert.doesNotMatch(asTest.stdout + asTest.stderr, /usage:/u);
});

test("G060-NC15 the evidence header names the commit, policy and each Harness's channel, version and role from discovery, with no path and no program started", async t => {
  const root = await temporary(t, "real-guard-header-"), home = join(root, "home"), prefix = join(home, ".nvm", "versions", "node", "v26.11.1"), bin = join(prefix, "bin");
  const started = join(root, "started"), program = "#!/bin/sh\necho started >> '" + started + "'\nexit 3\n";
  await mkdir(bin, { recursive: true });
  // npm global installations as `npm install -g` leaves them; each program leaves a mark if anything starts it.
  const npm = async (name: string, version: string, command: string, file: string) => {
    const directory = join(prefix, "lib", "node_modules", ...name.split("/"));
    await put(join(directory, "package.json"), JSON.stringify({ name, version, bin: { [command]: file } }), 0o644);
    await put(join(directory, file), program, 0o755); await symlink(join(directory, file), join(bin, command));
  };
  await npm("@deepseek-ai/dsh", "0.2.0-rc.2", "dsh", "bin/dsh.js");
  await npm("@anthropic-ai/claude-code", "2.1.306", "claude", "cli.js");
  await npm("@agentclientprotocol/claude-agent-acp", "0.89.1", "claude-agent-acp", "dist/index.js");
  await symlink(process.execPath, join(bin, "node"));
  // A development entry that only the discovery manifest names.
  const hermes = join(root, "dev", "hermes"); await put(hermes, program, 0o755);
  const manifest = join(root, "manifest.json"); await writeFile(manifest, JSON.stringify({ version: 2, definitions: [], overrides: { "hermes-native": { executable: hermes } } }));
  const workspace = join(root, "workspace"); await mkdir(workspace);
  const configuration = await prepareConfiguration({ workspace, manifestPath: manifest, pathOnly: true }), environment = { home, values: { HOME: home, PATH: bin } };
  const app = application(join(root, "data"), () => {}, { installations: "any", nativeEnvironment: environment, management: { installationMode: "private-fixture" }, workspaceLockRoot: join(root, "locks") });
  try {
    const header = await evidenceHeader(app, ["dsh", "claude", "hermes"], { configuration });
    const git = spawnSync("git", ["rev-parse", "HEAD"], { cwd: REPOSITORY, encoding: "utf8" });
    assert.equal(header.commit, git.status === 0 ? git.stdout.trim() : "unknown");
    assert.ok(typeof header.uncommittedChanges === "boolean" || header.uncommittedChanges === null);
    assert.equal(header.commitNote === undefined, header.uncommittedChanges === false, "a note exactly when the commit does not describe the tree");
    assert.deepEqual([header.policy, header.platform], ["any", "macOS"]); assert.ok(!Number.isNaN(Date.parse(header.recordedAt)));
    const pathless = (id: string) => header.harnesses.find(item => item.harnessId === id)?.installations.map(({ ref, ...rest }) => (assert.match(ref, /^[0-9a-f]{64}$/u), rest));
    const facts = (id: string) => { const item = header.harnesses.find(row => row.harnessId === id)!; return [item.source, item.controls, item.entryVersion, item.programVersion, item.programVersionFrom, item.verification]; };
    assert.deepEqual(header.harnesses.map(item => item.harnessId), ["dsh", "claude", "hermes"]);
    // dsh: an npm installation whose package records the version; management reads it without running dsh.
    assert.deepEqual(pathless("dsh"), [{ channel: "npm", label: "npm 全局（nvm v26.11.1）", command: "dsh", version: "0.2.0-rc.2", role: "product", active: true }]);
    assert.deepEqual(facts("dsh"), ["system", [{ id: "dsh-native", protocol: "acp-v1", entry: "path" }], "0.2.0-rc.2", "0.2.0-rc.2", "management", versionVerification("dsh", "0.2.0-rc.2", "0.2.0-rc.2")]);
    // Claude Code: the product and the adapter in front of it; the product's version only a probe would read, so it is the installation's record.
    assert.deepEqual(pathless("claude")?.sort((left, right) => left.role.localeCompare(right.role)), [
      { channel: "npm", label: "npm 全局（nvm v26.11.1）", command: "claude-agent-acp", version: "0.89.1", role: "adapter", active: true },
      { channel: "npm", label: "npm 全局（nvm v26.11.1）", command: "claude", version: "2.1.306", role: "product", active: true }]);
    assert.deepEqual(facts("claude"), ["system", [{ id: "claude-acp-npm", protocol: "acp-v1", entry: "path" }], "0.89.1", "2.1.306", "installation", versionVerification("claude", "2.1.306", "0.89.1")]);
    // Hermes through the discovery manifest only: no installation describes it, and the entry says it is a custom one.
    assert.deepEqual(pathless("hermes"), []);
    assert.deepEqual(facts("hermes"), ["system", [{ id: "hermes-native", protocol: "acp-v1", entry: "custom-entry" }], null, null, null, null]);
    // Nothing leaves a path, and no program was started for any of it.
    assert.deepEqual(homePathsIn(header, [home, root]), []); assert.ok(!JSON.stringify(header).includes(root));
    await assert.rejects(stat(started), (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT");
    await assert.rejects(evidenceHeader(app, ["no-such-harness"], { configuration }), guardError("UNKNOWN_HARNESS", "no-such-harness"));
    // A directory that is no git work tree: the commit is "unknown" and says why.
    const outside = await evidenceHeader(app, [], { repository: root });
    assert.deepEqual([outside.commit, outside.uncommittedChanges, outside.harnesses], ["unknown", null, []]); assert.match(outside.commitNote ?? "", /git rev-parse HEAD/u);
    // A suite without an application of its own gets the same header from a short-lived one, which leaves nothing behind.
    const standalone = await standaloneHeader(["dsh", "claude", "hermes"], { root, workspaceLockRoot: join(root, "locks"), policy: "any", environment, configuration });
    assert.deepEqual(standalone.harnesses, header.harnesses); assert.equal(standalone.policy, "any");
    await assert.rejects(stat(join(root, "evidence-header")), (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT");
    const none = await standaloneHeader([], { root, workspaceLockRoot: join(root, "locks"), policy: "official" });
    assert.deepEqual([none.policy, none.harnesses], ["official", []]);
    await assert.rejects(stat(started), (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT");
  } finally { try { await app.runtime.close(); } finally { await app.management.shutdown(); await app.providers.shutdown(); app.store.close(); } }
});
