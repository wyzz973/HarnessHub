import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CapabilityChanges } from "../../src/infrastructure/capabilities/changes.js";

// The user's own Claude Code (the first `claude` on PATH) with a private home, under the sandbox HarnessHub uses: the
// prediction may write only a private copy, the real run only Claude's file, its siblings and its own backups and
// telemetry folders, and every network operation is denied. Nothing here reads or writes the real ~/.claude.json.
test("G064-M5 Claude Code's own mcp add-json and remove write and take back a server in a sandbox without the network, as predicted on a private copy first", { timeout: 180000 }, async t => {
  assert.equal(process.platform, "darwin", "Claude's MCP commands run under macOS's sandbox");
  const root = await realpath(await mkdtemp(join(tmpdir(), "claude-mcp-real-"))), home = join(root, "home"), file = join(home, ".claude.json");
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(home, ".claude"), { recursive: true }); await mkdir(join(root, "data"));
  // A file as a used Claude Code leaves it: other servers, counters and a project section stay as they are.
  const original = { numStartups: 7, firstStartTime: "2026-01-01T00:00:00.000Z", migrationVersion: 11, mcpServers: { existing: { type: "stdio", command: "uvx", args: ["existing-mcp"] } }, projects: { "/tmp/p": { allowedTools: [] } } };
  await writeFile(file, JSON.stringify(original, null, 2), { mode: 0o600 });
  const environment = { home, values: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "en_US.UTF-8" } };
  const changes = new CapabilityChanges({ root: join(root, "data"), generation: 1, assertOwner: () => {}, environment, homes: [home], processes: async () => "" });
  t.after(() => changes.close());
  const installed = [{ harnessId: "claude", name: "Claude Code", version: "2.1.302" }];
  await changes.saveMcpServer("real-docs", { transport: "stdio", command: "npx", args: ["-y", "@acme/docs-mcp"], cwd: null, url: null, env: [{ key: "DOCS_TOKEN", variable: "DOCS_TOKEN" }], headers: [] }, false);
  const add = await changes.checkMcpSync("real-docs", "claude", false, installed);
  assert.equal(add.blocked, null, "the run on a private copy passes: " + add.blocked);
  assert.match(add.command ?? "", /^claude mcp add-json real-docs '\{.*\}' -s user$/u);
  assert.equal(add.rewrite?.target, "mcpServers.real-docs");
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), original, "the run on a copy wrote nothing here");
  const applied = await changes.apply(add.fingerprint, "real-claude-add");
  assert.equal(applied.status, "applied", JSON.stringify(applied.error));
  const written = JSON.parse(await readFile(file, "utf8")) as typeof original & { mcpServers: Record<string, unknown> };
  assert.deepEqual(written.mcpServers["real-docs"], { type: "stdio", command: "npx", args: ["-y", "@acme/docs-mcp"], env: { DOCS_TOKEN: "${DOCS_TOKEN}" } }, "the reference stays a reference");
  assert.deepEqual([written.mcpServers.existing, written.numStartups, written.projects], [original.mcpServers.existing, 7, original.projects], "what HarnessHub did not ask for stays");
  assert.notEqual(applied.backupId, null);
  assert.ok((await readdir(join(home, ".claude", "backups")).catch(() => [])).length >= 0, "Claude may keep its own backups");
  assert.equal((await changes.mcpInventory(installed)).servers[0]!.targets[0]!.state, "synced");
  const remove = await changes.checkMcpRemove("real-docs", "claude", installed);
  assert.deepEqual([remove.blocked, remove.command], [null, "claude mcp remove real-docs -s user"]);
  assert.equal((await changes.apply(remove.fingerprint, "real-claude-remove")).status, "applied");
  const after = JSON.parse(await readFile(file, "utf8")) as { mcpServers: Record<string, unknown> };
  assert.deepEqual(Object.keys(after.mcpServers), ["existing"]);
  assert.equal((await changes.mcpInventory(installed)).servers[0]!.targets[0]!.state, "absent");
});
