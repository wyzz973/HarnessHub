import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse as parseToml } from "smol-toml";
import type { HubToolsResult, HubToolsView } from "../../src/contracts/capabilities.js";
import { TABLE_ENV, TABLE_MCP_NAME } from "../../src/contracts/table.js";
import { application } from "../../src/cli/session-application.js";
import { prepareConfiguration } from "../../src/infrastructure/session/binding-factory.js";
import { startWebServer } from "../../src/web/server.js";
import { homePathsIn } from "../../src/web/shown-paths.js";
import { capabilityHome, CREDENTIALS, officialInstalls } from "../fixtures/capability-home.js";

// The manager's operation for the Hub's own tools, through the formal Gateway (docs/decisions/LOG.md, 2026-11-11): reading where
// they stand, installing them into Claude Code and Codex and taking them out, over HTTP with the same login and write checks as
// every other capability route. The user's files are the fixture's, in a private home; Claude Code's command is a runner that
// edits the fixture's file, since the fixture's `claude` program only proves nothing ran outside the sandbox.

const macOnly = { skip: process.platform !== "darwin" && "capability changes run their Harness commands under macOS's sandbox (ADR-045)", timeout: 120000 };
const NODE = "/opt/fixture/bin/node";

test("the Hub's tools are read, installed into Claude Code and Codex, refused where they cannot go, and taken out, each in one request", macOnly, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hub-tools-web-"))), closers: (() => Promise<void>)[] = [];
  t.after(async () => { for (const close of closers.reverse()) await close(); await rm(root, { recursive: true, force: true }); });
  const home = join(root, "home"), workspace = join(root, "workspace"), tool = join(home, "Hub", "dist", "hub-tools.js");
  await mkdir(home); await mkdir(workspace); await capabilityHome(home, join(root, "elsewhere"));
  await mkdir(join(home, "Hub", "dist"), { recursive: true }); await writeFile(tool, "// the Hub's tool program\n");
  const claudeFile = join(home, ".claude.json"), codexFile = join(home, ".codex", "config.toml");
  const claudeBefore = JSON.parse(await readFile(claudeFile, "utf8")) as { mcpServers: Record<string, unknown> }, codexBefore = await readFile(codexFile, "utf8");
  const claude = async (args: readonly string[], options: { readonly env: Readonly<Record<string, string>> }) => {
    const target = options.env.CLAUDE_CONFIG_DIR ? join(options.env.CLAUDE_CONFIG_DIR, ".claude.json") : claudeFile;
    const value = JSON.parse(await readFile(target, "utf8")) as { mcpServers?: Record<string, unknown> };
    value.mcpServers ??= {};
    if (args[1] === "add-json") value.mcpServers[args[2]!] = JSON.parse(args[3]!); else delete value.mcpServers[args[2]!];
    await writeFile(target, JSON.stringify(value, null, 2));
  };
  const environment = { home, values: { HOME: home, PATH: [...await officialInstalls(home), "/usr/bin", "/bin"].join(":"), LINEAR_TOKEN: "set-but-never-shown" } };
  const server = await startWebServer({ root: join(root, "data"), configuration: await prepareConfiguration({ workspace, pathOnly: true }), port: 0, hubTools: { node: NODE, tool }, claude,
    application: (data, publish) => application(data, publish, { nativeEnvironment: environment, installations: "official", management: { installationMode: "private-fixture" }, workspaceLockRoot: join(root, "locks") }) });
  closers.push(() => server.close());
  const url = new URL(server.url), origin = url.origin;
  const boot = await fetch(origin + "/api/v1/auth/bootstrap", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ token: new URLSearchParams(url.hash.slice(1)).get("token") }) });
  const csrf = (await boot.json() as { csrfToken: string }).csrfToken, cookie = boot.headers.get("set-cookie")!.split(";", 1)[0]!;
  const answers: unknown[] = [];
  const call = async <T>(path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; value: T }> => {
    const response = await fetch(origin + "/api/v1" + path, { method: body === undefined ? "GET" : "POST", headers: { Cookie: cookie, Origin: origin, ...(body === undefined ? {} : { "Content-Type": "application/json", "X-CSRF-Token": csrf }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json() as T; answers.push(value);
    return { status: response.status, value };
  };
  const view = async () => (await call<HubToolsView>("/capabilities/hub-tools")).value;
  const row = (v: HubToolsView, id: string) => v.harnesses.find(item => item.harnessId === id)!;

  // Where they stand: a program built where this Hub expects it, nothing written yet; the Harnesses the tools do not go into say why.
  let state = await view();
  assert.deepEqual([state.name, state.tool], [TABLE_MCP_NAME, { command: NODE + " ~/Hub/dist/hub-tools.js mcp", present: true }]);
  assert.deepEqual(["claude", "codex"].map(id => [row(state, id).state, row(state, id).writable]), [["absent", true], ["absent", true]]);
  assert.deepEqual(["opencode", "dsh", "hermes", "openclaw"].map(id => [row(state, id).state, row(state, id).writable]), [["absent", true], ["absent", true], ["absent", true], ["absent", true]]);
  assert.match(row(state, "openclaw").reason ?? "", /Gateway/u);

  // Into Codex: one request, a table of its own beside everything else, the variables forwarded by name.
  const codex = await call<HubToolsResult>("/capabilities/hub-tools/install", { harnessId: "codex" });
  assert.equal(codex.status, 200, JSON.stringify(codex.value));
  assert.deepEqual([codex.value.action, codex.value.status, codex.value.state, codex.value.changes.map(change => change.kind)], ["install", "done", "synced", ["mcp-sync"]]);
  const text = await readFile(codexFile, "utf8");
  assert.ok(text.startsWith(codexBefore));
  const toml = JSON.parse(JSON.stringify(parseToml(text))) as { mcp_servers: Record<string, unknown> };
  assert.deepEqual(toml.mcp_servers[TABLE_MCP_NAME], { command: NODE, args: [tool, "mcp"], env_vars: [TABLE_ENV.session, TABLE_ENV.url] });
  assert.equal(row(await view(), "codex").state, "synced");
  assert.equal((await call<HubToolsResult>("/capabilities/hub-tools/install", { harnessId: "codex" })).value.status, "unchanged");
  assert.equal(await readFile(codexFile, "utf8"), text);

  // Into Claude Code by its own command; its other servers stay.
  const claudeInstalled = await call<HubToolsResult>("/capabilities/hub-tools/install", { harnessId: "claude" });
  assert.equal(claudeInstalled.status, 200, JSON.stringify(claudeInstalled.value));
  assert.equal(claudeInstalled.value.status, "done");
  const claudeAfter = JSON.parse(await readFile(claudeFile, "utf8")) as { mcpServers: Record<string, unknown> };
  assert.deepEqual(claudeAfter.mcpServers[TABLE_MCP_NAME], { type: "stdio", command: NODE, args: [tool, "mcp"], env: { [TABLE_ENV.session]: "${" + TABLE_ENV.session + "}", [TABLE_ENV.url]: "${" + TABLE_ENV.url + "}" } });
  assert.deepEqual(Object.keys(claudeAfter.mcpServers).filter(name => name !== TABLE_MCP_NAME), Object.keys(claudeBefore.mcpServers));
  // The manager's list shows it like any server, without asking the user for the two variables the Hub sets itself.
  const inventory = (await call<{ servers: { name: string; variables: unknown[]; targets: { harnessId: string; state: string }[] }[] }>("/capabilities/mcp")).value;
  const listed = inventory.servers.find(server => server.name === TABLE_MCP_NAME);
  assert.deepEqual([listed?.variables, listed?.targets.filter(target => ["claude", "codex"].includes(target.harnessId)).map(target => target.state)], [[], ["synced", "synced"]]);

  // Where they cannot go: refused with the reason, nothing written; a bad request is a bad request.
  const files = async () => [await readFile(claudeFile, "utf8"), await readFile(codexFile, "utf8")];
  const written = await files();
  for (const [id, status, code] of [["nonesuch", 404, "CAPABILITY_NOT_FOUND"]] as const) {
    const refused = await call<{ code: string; message: string }>("/capabilities/hub-tools/install", { harnessId: id });
    assert.deepEqual([refused.status, refused.value.code], [status, code], id + " " + refused.value.message);
  }
  assert.equal((await call("/capabilities/hub-tools/install", { harnessId: "codex", extra: 1 })).status, 400);
  assert.equal((await call("/capabilities/hub-tools/install", { })).status, 400);
  assert.equal((await call("/capabilities/hub-tools/install", { harnessId: "codex" }, { Origin: "http://evil.example" })).status, 403, "a write from another origin is refused");
  assert.deepEqual(await files(), written);

  // Taken out: Codex's file is what it was, Claude Code's servers are what they were, and the list forgets the server.
  const out = await call<HubToolsResult>("/capabilities/hub-tools/uninstall", { harnessId: "codex" });
  assert.deepEqual([out.status, out.value.status, out.value.state], [200, "done", "absent"]);
  assert.equal(await readFile(codexFile, "utf8"), codexBefore);
  assert.equal((await call<HubToolsResult>("/capabilities/hub-tools/uninstall", { harnessId: "codex" })).value.status, "unchanged");
  assert.equal((await call<HubToolsResult>("/capabilities/hub-tools/uninstall", { harnessId: "claude" })).value.status, "done");
  assert.deepEqual((JSON.parse(await readFile(claudeFile, "utf8")) as { mcpServers: Record<string, unknown> }).mcpServers, claudeBefore.mcpServers);
  state = await view();
  assert.deepEqual(["claude", "codex"].map(id => row(state, id).state), ["absent", "absent"]);
  assert.equal((await call<{ servers: { name: string }[] }>("/capabilities/mcp")).value.servers.some(server => server.name === TABLE_MCP_NAME), false);

  // Nothing private is in what was answered: no credential of the fixture, no absolute spelling of the home, nothing ran unconfined.
  const everything = JSON.stringify(answers);
  for (const secret of [...CREDENTIALS, "set-but-never-shown"]) assert.equal(everything.includes(secret), false, secret);
  assert.deepEqual(homePathsIn(answers, [home], 1 << 20), []);
  assert.deepEqual((await readdir(home)).filter(name => name.startsWith("ran-")), []);
});
