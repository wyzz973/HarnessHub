import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setImmediate as nextTick } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { LocalHarnessManagement } from "../../src/infrastructure/management/service.js";
import { appStore } from "../fixtures/runtime-store.js";
import type { SqliteConversationStore } from "../../src/infrastructure/session/conversation-store.js";
import type { ManagementRecipe } from "../../src/contracts/management.js";
import { inventory } from "../../src/infrastructure/catalog/inventory-composition.js";
const peer = fileURLToPath(new URL("../../../tests/fixtures/managed-inventory-peer.mjs", import.meta.url));
const recipe: ManagementRecipe = { harnessId: "codex", controlId: "codex-native", kind: "npm", packageName: "@openai/codex", referenceVersion: "1.0.0", binName: "codex", args: ["app-server", "--listen", "stdio://"], archiveUrl: null, archiveSha256: null, relativeExecutable: null, dependencies: [] };
function record(value: unknown): Record<string, unknown> { assert.ok(value !== null && typeof value === "object" && !Array.isArray(value)); return value as Record<string, unknown>; }
async function child(root: string, system: string, manifest?: string, validate = false): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const worker = spawn(process.execPath, [peer, join(root, "data"), ...(manifest ? [manifest] : []), ...(validate ? ["validate"] : [])], { env: { PATH: system + ":" + dirname(process.execPath) + ":/usr/bin:/bin", HOME: root, LANG: "C.UTF-8" }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", diagnostics = ""; const timer = setTimeout(() => worker.kill("SIGKILL"), 10000);
    worker.stdout.on("data", bytes => { output += String(bytes); if (output.length > 1024 * 1024) worker.kill("SIGKILL"); }); worker.stderr.on("data", bytes => { diagnostics += String(bytes); });
    worker.once("error", error => { clearTimeout(timer); reject(error); });
    worker.once("close", code => { clearTimeout(timer); if (code !== 0) reject(new Error(diagnostics)); else { try { resolve(record(JSON.parse(output))); } catch (error) { reject(error); } } });
  });
}
test("original system PATH wins over a private copy; absent controls use the local copy and blocked overrides never fall back", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "harness-managed-discovery-"))), data = join(root, "data"), system = join(root, "system"); await mkdir(system);
  const store = appStore(data);
  const manager = new LocalHarnessManagement(data, { installationMode: "private-fixture", assertOwner: () => store.assertOwner(), ownerGeneration: store.ownerGeneration, recipes: [recipe],
    metadata: { resolve: async original => ({ recipe: original, version: "1.0.0", artifactUrl: null, integrity: null, engines: {}, dependencies: [] }) },
    installer: { install: async (spec, context) => {
      const directory = join(context.stage, "node_modules", "@openai", "codex"); await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "package.json"), JSON.stringify({ name: "@openai/codex", version: spec.version, bin: { codex: "bin.mjs" } }));
      const entry = join(directory, "bin.mjs"); await writeFile(entry, 'throw new Error("discovery must not execute this managed program");');
      return { observedVersion: spec.version, artifactSha256: null, command: { executable: process.execPath, args: [entry, ...spec.recipe.args], env: {} } };
    } } });
  t.after(async () => { await manager.shutdown(); store.close(); await rm(root, { recursive: true, force: true }); });
  const job = manager.submit({ harnessId: "codex", action: "install", commandId: "install-managed" });
  const until = Date.now() + 5000;
  while (!["completed", "failed", "unknown"].includes(manager.readJob(job.id).status)) { assert.ok(Date.now() < until); await nextTick(); }
  assert.equal(manager.readJob(job.id).status, "completed"); const managed = manager.resolveControl("codex", "codex-native"); assert.ok(managed);
  await writeFile(join(system, "codex"), "#!/bin/sh\nexit 77\n", { mode: 0o700 });
  await manager.shutdown(); store.close();
  const located = await child(root, system); assert.equal(located.state, "candidate"); assert.equal(located.source, "path"); assert.equal(record(located.command).executable, join(system, "codex"));
  assert.equal(located.managedCount, 0);
  const alternatives = join(root, "alternatives.json");
  await writeFile(alternatives, JSON.stringify({ version: 2, definitions: [], overrides: { "codex-acp-npm": { executable: join(system, "codex") } } }));
  const selected = await child(root, system, alternatives, true);
  assert.equal(selected.defaultSelection, "requires-explicit-control", "two local control entries require an explicit selection");
  assert.equal(selected.explicitSelection, "codex-acp-npm", "explicit requested control remains exclusive");
  const blocked = join(root, "blocked"), manifest = join(root, "manifest.json"); await writeFile(blocked, "blocked", { mode: 0o600 });
  await writeFile(manifest, JSON.stringify({ version: 2, definitions: [], overrides: { "codex-native": { executable: blocked } } }));
  const exclusive = await child(root, system, manifest); assert.equal(exclusive.state, "blocked"); assert.equal(exclusive.command, null); assert.equal(exclusive.managedCount, 0);
  assert.ok((await readFile(managed.command.args[0]!)).includes(Buffer.from("discovery must not execute")));
});
test("an original local control with a missing dependency is not replaced by a different private installation", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "native-missing-runtime-"))), entry = join(root, "native-only"), manifest = join(root, "catalog.json");
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(entry, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await writeFile(manifest, JSON.stringify({ version: 2, definitions: [{ id: "native-fixture", name: "Native fixture", aliases: [], binaryNames: ["native-only"], configHints: [], controls: [{
    id: "native-fixture-control", protocol: "acp-v1", executableNames: ["native-only"], args: [], env: {}, package: null, distribution: null, requiredExecutables: ["missing-fixture-runtime"],
    source: { repository: "fixture", revision: "pinned", upstreamId: "fixture", url: "https://example.invalid/source" } }] }] }));
  let replacementReads = 0;
  const observed = await inventory({ manifest, environment: { PATH: root }, home: root, pathOnly: true, searchDirs: [], packageRoots: [], installations: "any", managedResolver: { resolveControl: (_harness, id) => {
    if (id !== "native-fixture-control") return null; replacementReads++;
    return { installationId: "installation-private", revision: 1, version: "2.0.0", command: { executable: process.execPath, args: ["--version"], env: {} } };
  } } });
  const selected = observed.report.harnesses.find(row => row.id === "native-fixture")!.controls[0]!;
  assert.equal(selected.state, "missing_dependency"); assert.equal(selected.command, null); assert.equal(selected.installation.selected?.resolvedPath, entry);
  assert.equal(replacementReads, 0); assert.equal(observed.managedBindings.has(selected.id), false);
});
