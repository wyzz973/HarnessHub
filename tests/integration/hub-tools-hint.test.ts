import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { application } from "../../src/cli/session-application.js";
import { prepareConfiguration } from "../../src/infrastructure/session/binding-factory.js";
import { TableMount } from "../../src/infrastructure/table/mount.js";
import { startWebServer } from "../../src/web/server.js";
import { capabilityHome, officialInstalls } from "../fixtures/capability-home.js";

// Where the fact "this Harness's configuration holds the Hub's tools" comes from when the Hub runs (docs/decisions/LOG.md,
// 2026-11-11): the web server gives the table's mount a probe that asks the capability service about the Harnesses the last scan
// found, and takes it back when it stops. The files are the fixture's, in a private home; Claude Code's own command is a runner
// that edits the fixture's file. How a process uses the answer is in tests/integration/table-hint.test.ts.

const macOnly = { skip: process.platform !== "darwin" && "capability changes run their Harness commands under macOS's sandbox (ADR-045)", timeout: 120000 };
const NODE = "/opt/fixture/bin/node";

test("a process the Hub starts is known to have the Hub's tools once its Harness's configuration holds them: no before the install, yes after, no after the uninstall, and no once the Hub has stopped", macOnly, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hub-tools-hint-"))), closers: (() => Promise<void>)[] = [];
  t.after(async () => { for (const close of closers.reverse()) await close(); await rm(root, { recursive: true, force: true }); });
  const home = join(root, "home"), workspace = join(root, "workspace"), tool = join(home, "Hub", "dist", "hub-tools.js");
  await mkdir(home); await mkdir(workspace); await capabilityHome(home, join(root, "elsewhere"));
  await mkdir(join(home, "Hub", "dist"), { recursive: true }); await writeFile(tool, "// the Hub's tool program\n");
  const claudeFile = join(home, ".claude.json");
  const claude = async (args: readonly string[], options: { readonly env: Readonly<Record<string, string>> }) => {
    const target = options.env.CLAUDE_CONFIG_DIR ? join(options.env.CLAUDE_CONFIG_DIR, ".claude.json") : claudeFile;
    const value = JSON.parse(await readFile(target, "utf8")) as { mcpServers?: Record<string, unknown> };
    value.mcpServers ??= {};
    if (args[1] === "add-json") value.mcpServers[args[2]!] = JSON.parse(args[3]!); else delete value.mcpServers[args[2]!];
    await writeFile(target, JSON.stringify(value, null, 2));
  };
  const environment = { home, values: { HOME: home, PATH: [...await officialInstalls(home), "/usr/bin", "/bin"].join(":") } };
  const mount = new TableMount();
  assert.equal(await mount.hasTools("codex"), false, "no probe, no tools");
  const server = await startWebServer({ root: join(root, "data"), configuration: await prepareConfiguration({ workspace, pathOnly: true }), port: 0, hubTools: { node: NODE, tool }, claude, table: mount,
    application: (data, publish) => application(data, publish, { nativeEnvironment: environment, installations: "official", management: { installationMode: "private-fixture" }, workspaceLockRoot: join(root, "locks"), table: mount }) });
  let stopped = false;
  closers.push(async () => { if (!stopped) await server.close(); });
  const url = new URL(server.url), origin = url.origin;
  assert.equal(mount.url, origin, "the server gave the mount its address");
  const boot = await fetch(origin + "/api/v1/auth/bootstrap", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ token: new URLSearchParams(url.hash.slice(1)).get("token") }) });
  const csrf = (await boot.json() as { csrfToken: string }).csrfToken, cookie = boot.headers.get("set-cookie")!.split(";", 1)[0]!;
  const post = async (path: string, body: unknown) => (await fetch(origin + "/api/v1" + path, { method: "POST", headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json", "X-CSRF-Token": csrf }, body: JSON.stringify(body) })).status;
  const holding = async () => Object.fromEntries(await Promise.all(["claude", "codex", "opencode", "hermes", "nonesuch"].map(async id => [id, await mount.hasTools(id)] as const)));

  assert.deepEqual(await holding(), { claude: false, codex: false, opencode: false, hermes: false, nonesuch: false }, "nothing written yet");
  assert.equal(await post("/capabilities/hub-tools/install", { harnessId: "codex" }), 200);
  assert.deepEqual(await holding(), { claude: false, codex: true, opencode: false, hermes: false, nonesuch: false });
  assert.equal(await post("/capabilities/hub-tools/install", { harnessId: "claude" }), 200);
  assert.deepEqual(await holding(), { claude: true, codex: true, opencode: false, hermes: false, nonesuch: false });
  assert.equal(await post("/capabilities/hub-tools/uninstall", { harnessId: "codex" }), 200);
  assert.deepEqual(await holding(), { claude: true, codex: false, opencode: false, hermes: false, nonesuch: false }, "taken out again");
  // The entry is lost from the file (a running Claude Code wrote its old copy back): the next process is not told it has tools.
  const kept = await readFile(claudeFile, "utf8"), lost = JSON.parse(kept) as { mcpServers: Record<string, unknown> };
  delete lost.mcpServers.harnesshub; await writeFile(claudeFile, JSON.stringify(lost, null, 2));
  assert.equal(await mount.hasTools("claude"), false, "the file is read each time, not remembered");
  await writeFile(claudeFile, kept);
  assert.equal(await mount.hasTools("claude"), true);

  stopped = true; await server.close();
  assert.equal(await mount.hasTools("claude"), false, "a Hub that stopped answers for no Harness");
  assert.equal(mount.url, null);
});
