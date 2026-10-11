import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { application } from "../../src/cli/session-application.js";
import type { PublicRun, SessionId, SessionSnapshot } from "../../src/contracts/session.js";
import { prepareConfiguration } from "../../src/infrastructure/session/binding-factory.js";

/**
 * Original-installation acceptance: the user's installed Harness, its own configuration/login and model.
 * The Hub owner is restarted between turns, so the second answer can only come from native recovery.
 * Missing prerequisites fail; nothing here is a skipped pass. Evidence never contains checkpoints or environment values.
 */
const harnesses = (process.env.HH_REAL_HARNESSES ?? "").split(",").map(value => value.trim()).filter(Boolean);
const evidencePath = process.env.HH_REAL_EVIDENCE;
const home = process.env.HOME ?? homedir();
const configFiles: Readonly<Record<string, readonly string[]>> = {
  codex: [join(home, ".codex", "config.toml")],
  claude: [join(home, ".claude", "settings.json")],
  opencode: [join(home, ".config", "opencode", "opencode.json")],
  openclaw: [join(home, ".openclaw", "openclaw.json")],
  pi: [join(home, ".pi", "agent", "settings.json"), join(home, ".pi", "agent", "models.json")],
  cursor: [join(home, ".cursor", "cli-config.json")],
  gemini: [join(home, ".gemini", "settings.json")],
  hermes: [join(home, ".hermes", "config.yaml")],
  dsh: [join(home, ".dsh", "settings.yaml"), join(home, ".dsh", "profiles", "acp", "cordis.patch.yml")],
};
async function digest(path: string): Promise<string> {
  try { return createHash("sha256").update(await readFile(path)).digest("hex"); }
  catch (error) { if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return "missing"; throw error; }
}
type App = ReturnType<typeof application>;
async function closeApp(app: App): Promise<void> {
  try { await app.runtime.close(); } finally { try { await app.management.shutdown(); } finally { try { await app.providers.shutdown(); } finally { app.store.close(); } } }
}
function runSummary(run: PublicRun, reply: string): Record<string, unknown> {
  return { status: run.status, backend: run.backend, cleanup: run.cleanup, error: run.error, sourceRunIds: run.sourceRunIds, replyBytes: Buffer.byteLength(reply), selection: { harnessId: run.selection.harnessId, controlId: run.selection.controlId, nativeModel: run.selection.nativeModel ?? null, nativeOptions: run.selection.nativeOptions ?? {} } };
}

test("installed Harness resumes its own native session across a Hub owner restart", { timeout: 15 * 60 * 1000 }, async () => {
  assert.ok(harnesses.length, "set HH_REAL_HARNESSES to the installed Harness identities under acceptance");
  assert.ok(evidencePath, "set HH_REAL_EVIDENCE to an ignored evidence file path");
  const root = await realpath(await mkdtemp(join(process.env.HH_REAL_TMP ?? tmpdir(), "hh-native-resume-")));
  const results: Record<string, unknown>[] = [];
  try {
    for (const harnessId of harnesses) {
      const files = configFiles[harnessId] ?? [];
      const before = await Promise.all(files.map(digest));
      const data = join(root, harnessId + "-data"), workspace = join(root, harnessId + "-workspace");
      await mkdir(workspace);
      const configuration = await prepareConfiguration({ workspace, ...(process.env.HH_REAL_MANIFEST ? { manifestPath: process.env.HH_REAL_MANIFEST } : {}) });
      const tag = "HH_NATIVE_" + randomUUID().slice(0, 8).toUpperCase();
      const proof: Record<string, unknown> = { harnessId, startedAt: new Date().toISOString() };
      let app: App | null = application(data, () => {});
      let id: SessionId | null = null;
      try {
        const catalog = await app.factory.discoverModels({ harnessId }, configuration, new AbortController().signal);
        const requested = process.env["HH_REAL_MODEL_" + harnessId.toUpperCase()];
        const model = requested ?? catalog.defaultModel ?? undefined;
        assert.ok(model === undefined || catalog.models.some(row => row.id === model), "requested native model is not in the installed catalog");
        proof.catalog = { models: catalog.models.length, defaultModel: catalog.defaultModel, authentication: catalog.authentication, chosenModel: model ?? null };
        const created: SessionSnapshot = await app.runtime.create(configuration, { harnessId, ...(requested === undefined ? {} : { nativeModel: requested }) }, "create-" + randomUUID());
        id = created.id;
        app.runtime.send(id, "请记住这个标记：" + tag + "。只回复“已记住”，不要调用任何工具。", "first-" + randomUUID());
        await app.runtime.wait(id);
        let state = app.runtime.read(id);
        const first = state.runs.at(-1)!, firstReply = state.messages.find(row => row.id === first.assistantMessageId)?.text ?? "";
        proof.first = runSummary(first, firstReply);
        proof.bindingAfterFirst = (state.nativeBindings ?? []).map(binding => ({ harnessId: binding.harnessId, controlId: binding.controlId, status: binding.status, throughRunIsFirst: binding.throughRunId === first.id }));
        assert.equal(first.status, "completed", "first native turn must complete");
        assert.ok(state.nativeBindings?.some(binding => binding.harnessId === harnessId && binding.status === "ready"), "first turn must leave a ready native binding");
        // A new owner of the same data root: no in-memory connection, process, or prompt history survives.
        await closeApp(app); app = null;
        app = application(data, () => {});
        app.runtime.send(id, "上一条用户消息里的标记是什么？只原样回复那个标记，不要调用任何工具。", "second-" + randomUUID());
        await app.runtime.wait(id);
        state = app.runtime.read(id);
        const second = state.runs.at(-1)!, reply = state.messages.find(row => row.id === second.assistantMessageId)?.text ?? "";
        proof.second = runSummary(second, reply);
        proof.matched = reply.includes(tag);
        // Replayed native history must never be appended to the recovered reply.
        proof.replayMixed = firstReply.trim().length > 0 && reply.includes(firstReply.trim());
        proof.bindings = (state.nativeBindings ?? []).map(binding => ({ harnessId: binding.harnessId, controlId: binding.controlId, status: binding.status, throughRunIsSecond: binding.throughRunId === second.id }));
        proof.events = app.store.events(id, 0, 100).filter(event => ["native.binding_prepared", "run.context_prepared"].includes(event.type)).map(event => ({ type: event.type, data: event.type === "run.context_prepared" ? { sourceRunIds: event.data.sourceRunIds } : event.data }));
        assert.equal(second.status, "completed", "recovered native turn must complete");
        assert.deepEqual(second.sourceRunIds, [], "recovery must not inject public history into the native session");
        assert.ok(proof.matched, "the native session must answer from its own recovered context");
        assert.equal(proof.replayMixed, false, "native replay leaked into the recovered reply");
        assert.equal(second.cleanup?.closed, true);
      } catch (error) {
        proof.failure = { code: error !== null && typeof error === "object" && "code" in error ? String(error.code) : "ASSERTION", message: error instanceof Error ? error.message.slice(0, 512) : "failed" };
        throw error;
      } finally {
        if (app) await closeApp(app);
        const after = await Promise.all(files.map(digest));
        proof.configuration = files.map((path, index) => ({ path, unchanged: before[index] === after[index] }));
        proof.finishedAt = new Date().toISOString();
        results.push(proof);
        await writeFile(evidencePath, JSON.stringify(results, null, 2) + "\n", { mode: 0o600 });
      }
      assert.ok((proof.configuration as { unchanged: boolean }[]).every(row => row.unchanged), "native model configuration must remain unchanged");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
