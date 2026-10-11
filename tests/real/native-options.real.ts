import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { application } from "../../src/cli/session-application.js";
import type { PublicRun, SessionId } from "../../src/contracts/session.js";
import { prepareConfiguration } from "../../src/infrastructure/session/binding-factory.js";

/**
 * Original-installation acceptance of selected native settings and of a native command:
 * - HH_REAL_OPTIONS_<ID> (JSON): the session's native options; after a turn that asks for an edit, the native session must
 *   report the same values, and HH_REAL_EXPECT_UNCHANGED=1 requires the file to stay unchanged (for example a plan mode);
 * - HH_REAL_COMMAND and HH_REAL_COMMAND_FILE: a native command run as its own turn must create that file in the workspace.
 * Evidence keeps values, statuses and flags only.
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
  hermes: [join(home, ".hermes", "config.yaml")],
  dsh: [join(home, ".dsh", "settings.yaml"), join(home, ".dsh", "profiles", "acp", "cordis.patch.yml")],
};
const TERMINAL = new Set<PublicRun["status"]>(["completed", "failed", "cancelled", "unknown"]);
async function digest(path: string): Promise<string> {
  try { return createHash("sha256").update(await readFile(path)).digest("hex"); }
  catch (error) { if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return "missing"; throw error; }
}
type App = ReturnType<typeof application>;
async function closeApp(app: App): Promise<void> {
  try { await app.runtime.close(); } finally { try { await app.management.shutdown(); } finally { try { await app.providers.shutdown(); } finally { app.store.close(); } } }
}
async function turn(app: App, id: SessionId, text: string): Promise<PublicRun> {
  const count = app.runtime.read(id).runs.length + 1;
  app.runtime.send(id, text, "send-" + randomUUID());
  const deadline = Date.now() + 8 * 60 * 1000;
  for (;;) {
    const state = app.runtime.read(id), run = state.runs.at(-1)!;
    if (state.runs.length === count && TERMINAL.has(run.status)) { await app.runtime.wait(id); return app.runtime.read(id).runs.at(-1)!; }
    if (app.runtime.permissionRequests(id).length) throw new Error("the turn asked for an approval");
    if (Date.now() > deadline) throw new Error("turn did not settle in time");
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

test("installed Harness applies the selected native settings and runs a native command", { timeout: 20 * 60 * 1000 }, async () => {
  assert.ok(harnesses.length, "set HH_REAL_HARNESSES"); assert.ok(evidencePath, "set HH_REAL_EVIDENCE");
  const root = await realpath(await mkdtemp(join(process.env.HH_REAL_TMP ?? tmpdir(), "hh-native-options-")));
  const results: Record<string, unknown>[] = [], failures: string[] = [];
  try {
    for (const harnessId of harnesses) {
      const files = configFiles[harnessId] ?? [], before = await Promise.all(files.map(digest));
      const data = join(root, harnessId + "-data"), workspace = join(root, harnessId + "-workspace");
      await mkdir(workspace); await writeFile(join(workspace, "notes.txt"), "alpha\nbravo\ncharlie\n");
      const configuration = await prepareConfiguration({ workspace, ...(process.env.HH_REAL_MANIFEST ? { manifestPath: process.env.HH_REAL_MANIFEST } : {}) });
      const proof: Record<string, unknown> = { harnessId, startedAt: new Date().toISOString() };
      const app = application(data, () => {});
      try {
        const requested = process.env["HH_REAL_MODEL_" + harnessId.toUpperCase()], optionsText = process.env["HH_REAL_OPTIONS_" + harnessId.toUpperCase()];
        const nativeOptions = optionsText === undefined ? undefined : JSON.parse(optionsText) as Record<string, string>;
        const session = await app.runtime.create(configuration, { harnessId, ...(requested === undefined ? {} : { nativeModel: requested }), ...(nativeOptions === undefined ? {} : { nativeOptions }) }, "create-" + randomUUID());
        if (nativeOptions !== undefined) {
          const run = await turn(app, session.id, "请用你的文件编辑工具把 notes.txt 里的 bravo 改成 delta；如果当前模式不允许修改文件，就只说明你会怎么改。");
          const observed = app.runtime.read(session.id).nativeBindings?.find(binding => binding.status === "ready")?.observed?.options ?? {};
          const unchanged = (await readFile(join(workspace, "notes.txt"), "utf8")).includes("bravo");
          proof.options = { requested: nativeOptions, observed: Object.fromEntries(Object.keys(nativeOptions).map(key => [key, observed[key] ?? null])), status: run.status, fileUnchanged: unchanged };
          if (run.status !== "completed") failures.push(harnessId + ": options turn");
          if (Object.entries(nativeOptions).some(([key, value]) => observed[key] !== value)) failures.push(harnessId + ": options not reported as applied");
          if (process.env.HH_REAL_EXPECT_UNCHANGED === "1" && !unchanged) failures.push(harnessId + ": the file changed under the selected setting");
        }
        const command = process.env.HH_REAL_COMMAND, expected = process.env.HH_REAL_COMMAND_FILE;
        if (command && expected) {
          const run = await turn(app, session.id, command);
          let created = false; try { await access(join(workspace, expected)); created = true; } catch { /* the command did not create it */ }
          proof.command = { command, status: run.status, created, nativeCommand: app.store.events(session.id, 0, 100).some(row => row.type === "run.native_command") };
          if (run.status !== "completed" || !created) failures.push(harnessId + ": native command");
        }
      } catch (error) {
        proof.failure = { code: error !== null && typeof error === "object" && "code" in error ? String(error.code) : "ASSERTION", message: error instanceof Error ? error.message.slice(0, 512) : "failed" };
        failures.push(harnessId + ": " + (proof.failure as { code: string }).code);
      } finally {
        await closeApp(app);
        const after = await Promise.all(files.map(digest));
        proof.configuration = files.map((path, index) => ({ path, unchanged: before[index] === after[index] }));
        if (!(proof.configuration as { unchanged: boolean }[]).every(row => row.unchanged)) failures.push(harnessId + ": configuration changed");
        proof.finishedAt = new Date().toISOString();
        results.push(proof);
        await writeFile(evidencePath, JSON.stringify(results, null, 2) + "\n", { mode: 0o600 });
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
  assert.deepEqual(failures, [], "native options acceptance failed");
});
