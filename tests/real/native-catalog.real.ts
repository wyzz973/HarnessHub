import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { application } from "../../src/cli/session-application.js";
import { prepareConfiguration } from "../../src/infrastructure/session/binding-factory.js";
/** A development manifest (HH_REAL_MANIFEST) names non-official entries, which only the development policy reads (ADR-044). */
const realInstallations = process.env.HH_REAL_MANIFEST ? "any" as const : "official" as const;

/**
 * Directory-level evidence from each installed Harness: initialize capabilities and the native catalog read through the
 * production binding (original installation, configuration and login). No prompt is sent. This is discovery evidence,
 * never task or capability acceptance.
 */
const harnesses = (process.env.HH_REAL_HARNESSES ?? "").split(",").map(value => value.trim()).filter(Boolean);
const evidencePath = process.env.HH_REAL_EVIDENCE;
const home = process.env.HOME ?? homedir();
const watched = [join(home, ".codex", "config.toml"), join(home, ".claude", "settings.json"), join(home, ".config", "opencode", "opencode.json"), join(home, ".openclaw", "openclaw.json"),
  join(home, ".pi", "agent", "settings.json"), join(home, ".pi", "agent", "models.json"), join(home, ".cursor", "cli-config.json"), join(home, ".gemini", "settings.json")];
async function digest(path: string): Promise<string> {
  try { return createHash("sha256").update(await readFile(path)).digest("hex"); }
  catch (error) { if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return "missing"; throw error; }
}
function keys(value: unknown): string[] { return value !== null && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).sort() : []; }

test("installed Harnesses report their native capabilities and catalogs without a prompt", { timeout: 10 * 60 * 1000 }, async () => {
  assert.ok(harnesses.length, "set HH_REAL_HARNESSES"); assert.ok(evidencePath, "set HH_REAL_EVIDENCE");
  const root = await realpath(await mkdtemp(join(process.env.HH_REAL_TMP ?? tmpdir(), "hh-native-catalog-"))), before = await Promise.all(watched.map(digest));
  const app = application(join(root, "data"), () => {}, { installations: realInstallations, workspaceLockRoot: join(root, "locks") }), results: Record<string, unknown>[] = [];
  try {
    for (const harnessId of harnesses) {
      const workspace = join(root, harnessId); await mkdir(workspace);
      const configuration = await prepareConfiguration({ workspace, ...(process.env.HH_REAL_MANIFEST ? { manifestPath: process.env.HH_REAL_MANIFEST } : {}) });
      const proof: Record<string, unknown> = { harnessId, observedAt: new Date().toISOString() };
      let binding: Awaited<ReturnType<typeof app.factory.prepare>> | null = null;
      try {
        const selection = await app.factory.validate({ harnessId }, configuration);
        const session = await app.runtime.create(configuration, { harnessId }, "catalog-" + harnessId);
        binding = await app.factory.prepare(selection, configuration, session.id, "catalog-read");
        const observation = await binding.control.initialize(), capabilities = observation.capabilities, prompt = capabilities.promptCapabilities, sessions = capabilities.sessionCapabilities;
        proof.protocol = observation.protocol; proof.agent = { name: observation.agentName, version: observation.agentVersion };
        proof.capabilities = { loadSession: capabilities.loadSession === true, sessionCapabilities: keys(sessions), promptCapabilities: prompt !== null && typeof prompt === "object" ? Object.fromEntries(Object.entries(prompt).filter(([, value]) => typeof value === "boolean")) : {}, mcpCapabilities: keys(capabilities.mcpCapabilities) };
        if (observation.protocol === "acp-v1") { await binding.control.open(workspace); await new Promise(resolve => setTimeout(resolve, 1500)); }
        const catalog = await binding.control.models?.();
        proof.catalog = catalog === undefined ? null : { models: catalog.models.length, defaultModel: catalog.defaultModel, canSelect: catalog.canSelect, authentication: catalog.authentication,
          selectionError: catalog.selectionError?.code ?? null, options: [...(catalog.options ?? []), ...(catalog.models.find(row => row.id === catalog.defaultModel)?.options ?? [])].map(option => ({ id: option.id, category: option.category, values: option.values.length })),
          commands: catalog.commands?.length ?? 0 };
      } catch (error) {
        proof.failure = { code: error !== null && typeof error === "object" && "code" in error ? String(error.code) : "CATALOG_READ_FAILED", message: error instanceof Error ? error.message.slice(0, 300) : "failed" };
      } finally {
        if (binding) { try { proof.cleanup = await binding.close(); } catch (error) { proof.cleanupFailure = error instanceof Error ? error.message.slice(0, 300) : "cleanup failed"; } }
        results.push(proof);
        await writeFile(evidencePath, JSON.stringify({ results }, null, 2) + "\n", { mode: 0o600 });
      }
    }
  } finally {
    try { await app.runtime.close(); } finally { try { await app.management.shutdown(); } finally { try { await app.providers.shutdown(); } finally { app.store.close(); } } }
    const after = await Promise.all(watched.map(digest));
    await writeFile(evidencePath, JSON.stringify({ results, configuration: watched.map((path, index) => ({ path, unchanged: before[index] === after[index] })) }, null, 2) + "\n", { mode: 0o600 });
    await rm(root, { recursive: true, force: true });
  }
  for (const result of results) assert.ok(result.cleanup !== undefined, String(result.harnessId) + " cleanup must be confirmed");
});
