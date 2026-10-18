import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { CapabilitiesView } from "../../src/contracts/capabilities.js";
import { application } from "../../src/cli/session-application.js";
import { prepareConfiguration } from "../../src/infrastructure/session/binding-factory.js";
import { startWebServer } from "../../src/web/server.js";
import { homePathsIn } from "../../src/web/shown-paths.js";
import { capabilityHome, SECRETS } from "../fixtures/capability-home.js";

async function file(path: string, text: string, mode = 0o644): Promise<void> { await mkdir(dirname(path), { recursive: true }); await writeFile(path, text, { mode }); }
async function link(target: string, path: string): Promise<void> { await mkdir(dirname(path), { recursive: true }); await symlink(target, path); }
/** A program that leaves a mark when anything runs it; the capability view must run none. */
const program = (name: string) => "#!/bin/sh\ntouch \"$HOME/ran-" + name + "\"\nexit 3\n";
const NPM: readonly (readonly [string, string, string])[] = [["@anthropic-ai/claude-code", "claude", "2.1.300"], ["@openai/codex", "codex", "0.162.1"], ["opencode-ai", "opencode", "1.18.35"],
  ["@google/gemini-cli", "gemini", "0.72.0"], ["openclaw", "openclaw", "2026.3.23-2"], ["@earendil-works/pi-coding-agent", "pi", "0.85.1"], ["@deepseek-ai/dsh", "dsh", "0.2.1-alpha.1"]];

test("G064-R5 through the formal Gateway, the capability view of nine official installations reads the user's files only, without values or home paths", { timeout: 60000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "capabilities-"))), closers: (() => Promise<void>)[] = [];
  t.after(async () => { for (const close of closers.reverse()) await close(); await rm(root, { recursive: true, force: true }); });
  const home = join(root, "home"), workspace = join(root, "workspace"), prefix = join(home, ".nvm", "versions", "node", "v26.0.0");
  await mkdir(workspace, { recursive: true }); await mkdir(home);
  await capabilityHome(home, join(root, "elsewhere"));
  // Official channels as their installers leave them (ADR-044): npm global packages, Cursor's and Hermes's install scripts.
  for (const [pkg, command, version] of NPM) {
    await file(join(prefix, "lib", "node_modules", pkg, "package.json"), JSON.stringify({ name: pkg, version, bin: { [command]: "cli.js" } }));
    await file(join(prefix, "lib", "node_modules", pkg, "cli.js"), program(command), 0o755);
    await link("../lib/node_modules/" + pkg + "/cli.js", join(prefix, "bin", command));
  }
  await file(join(home, ".local", "share", "cursor-agent", "versions", "2026.10.01-e373342", "cursor-agent"), program("cursor-agent"), 0o755);
  await link(join(home, ".local", "share", "cursor-agent", "versions", "2026.10.01-e373342", "cursor-agent"), join(home, ".local", "bin", "cursor-agent"));
  await file(join(home, ".hermes", "hermes-agent", "venv", "bin", "hermes"), program("hermes"), 0o755);
  await link(join(home, ".hermes", "hermes-agent", "venv", "bin", "hermes"), join(home, ".local", "bin", "hermes"));
  const environment = { home, values: { HOME: home, PATH: [join(home, ".local", "bin"), join(prefix, "bin"), "/usr/bin", "/bin"].join(":") } };
  const server = await startWebServer({ root: join(root, "data"), configuration: await prepareConfiguration({ workspace, pathOnly: true }), port: 0,
    application: (data, publish) => application(data, publish, { nativeEnvironment: environment, installations: "official", management: { installationMode: "private-fixture" }, workspaceLockRoot: join(root, "locks") }) });
  closers.push(() => server.close());
  const url = new URL(server.url), origin = url.origin;
  const boot = await fetch(origin + "/api/v1/auth/bootstrap", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ token: new URLSearchParams(url.hash.slice(1)).get("token") }) });
  const cookie = boot.headers.get("set-cookie")!.split(";", 1)[0]!;
  const response = await fetch(origin + "/api/v1/capabilities", { headers: { Cookie: cookie, Origin: origin } });
  assert.equal(response.status, 200);
  const view = await response.json() as CapabilitiesView;
  // Every official installation is covered, by the version its channel records, and said to be checked or not.
  assert.deepEqual(view.harnesses.map(item => [item.harnessId, item.version, item.table]), [["claude", "2.1.300", "verified"], ["codex", "0.162.1", "verified"], ["cursor", "2026.10.01-e373342", "verified"],
    ["opencode", "1.18.35", "verified"], ["gemini", "0.72.0", "unverified"], ["openclaw", "2026.3.23-2", "verified"], ["pi", "0.85.1", "verified"], ["hermes", null, "unverified"], ["dsh", "0.2.1-alpha.1", "verified"]]);
  // The entries, mechanisms, statuses and warnings of the user's files.
  const find = (kind: string, name: string) => view.entries.find(item => item.kind === kind && item.name === name)!;
  const alpha = find("skill", "alpha");
  assert.deepEqual(alpha.edges.map(edge => [edge.harnessId, edge.mechanism, edge.status]), [
    ["claude", "linked", "active"], ["claude", "linked", "duplicate"], ["codex", "native-shared", "active"], ["codex", "own-copy", "active"],
    // Cursor refuses alpha-again (its name is not its folder's) and does not say which of the other three it uses.
    ["cursor", "compat-root", "invalid"], ["cursor", "native-shared", "duplicate"], ["cursor", "compat-root", "duplicate"], ["cursor", "compat-root", "duplicate"], ["opencode", "compat-root", "duplicate"], ["opencode", "compat-root", "duplicate"],
    ["opencode", "native-shared", "duplicate"], ["gemini", "native-shared", "active"], ["gemini", "own-copy", "shadowed"], ["openclaw", "linked", "rejected"], ["openclaw", "native-shared", "active"],
    ["pi", "native-shared", "active"], ["hermes", "linked", "active"], ["hermes", "external-dir", "shadowed"], ["dsh", "native-shared", "active"]]);
  assert.deepEqual([...new Set(alpha.warnings.map(warning => warning.kind))].sort(), ["duplicate", "redundant", "shadow"]);
  // Beta is off in each Harness's own switch; OpenCode has it twice (through ~/.claude/skills too), off both times.
  assert.deepEqual(find("skill", "beta").edges.filter(edge => edge.status === "disabled").map(edge => edge.harnessId), ["claude", "codex", "opencode", "opencode", "gemini", "openclaw", "hermes"]);
  assert.deepEqual(find("mcp", "remote").edges.map(edge => [edge.harnessId, edge.status]), [["claude", "active"], ["codex", "disabled"]]);
  assert.deepEqual(find("hook", "PreToolUse（Bash）").edges.map(edge => edge.harnessId), ["claude", "cursor"]);
  assert.deepEqual(view.entries.reduce<Record<string, number>>((counts, item) => ({ ...counts, [item.kind]: (counts[item.kind] ?? 0) + 1 }), {}),
    { skill: 17, mcp: 8, instructions: 8, subagent: 2, command: 5, hook: 6, plugin: 7 });
  // A file that does not parse is listed, not guessed from; no value, home path or argument leaves the Gateway.
  assert.deepEqual(view.unreadable, [{ harnessId: "opencode", file: "~/.config/opencode/config.json", reason: view.unreadable[0]?.reason }]);
  const text = JSON.stringify(view);
  for (const secret of SECRETS) assert.equal(text.includes(secret), false, secret);
  assert.deepEqual(homePathsIn(view, [home], 1 << 20), []);
  // Reading is all it did: no Harness program ran, and the user's files are as they were.
  assert.deepEqual((await readdir(home)).filter(name => name.startsWith("ran-")), []);
});
