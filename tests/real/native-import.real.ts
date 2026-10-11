import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { application } from "../../src/cli/session-application.js";
import type { PublicRun, SessionId } from "../../src/contracts/session.js";
import { prepareConfiguration } from "../../src/infrastructure/session/binding-factory.js";
import { inventory } from "../../src/infrastructure/catalog/inventory-composition.js";
import { createNativeControl } from "../../src/adapters/control/factory.js";

/**
 * Original-installation acceptance of continuing a native session (ADR-029): the installed program itself creates a session
 * in a new workspace and is told a tag, the Hub lists that workspace's sessions, continues the session as a conversation
 * and asks for the tag, which only the native session knows. Evidence keeps counts, flags and statuses, never transcripts.
 * The native sessions created here stay in the program's own storage, like the sessions earlier acceptance runs created.
 */
const harnesses = (process.env.HH_REAL_HARNESSES ?? "").split(",").map(value => value.trim()).filter(Boolean);
const evidencePath = process.env.HH_REAL_EVIDENCE;
const home = process.env.HOME ?? homedir();
const configFiles: Readonly<Record<string, readonly string[]>> = {
  codex: [join(home, ".codex", "config.toml")],
  opencode: [join(home, ".config", "opencode", "opencode.json")],
  claude: [join(home, ".claude", "settings.json")],
  hermes: [join(home, ".hermes", "config.yaml")],
  dsh: [join(home, ".dsh", "settings.yaml"), join(home, ".dsh", "profiles", "acp", "cordis.patch.yml")],
};
/** How each installed program starts a session of its own in a directory, outside the Hub. */
const nativeStart: Readonly<Record<string, (prompt: string) => readonly [string, readonly string[]]>> = {
  codex: prompt => ["codex", ["exec", "--skip-git-repo-check", prompt]],
  opencode: prompt => ["opencode", ["run", prompt]],
  claude: prompt => ["claude", ["-p", prompt]],
};
/**
 * Harnesses whose own listable sessions come from ACP clients such as editors (Hermes lists only ACP sessions; dsh's ACP
 * profile is its automation entry): another ACP client creates the session through the program's own ACP entry, found by
 * the Hub's discovery, outside any Hub conversation.
 */
const acpStarted = new Set(["hermes", "dsh"]);
/** Agents that can resume a session but never replay it (dsh's ACP has no session/load): continuing them has no history to quote. */
const resumeOnly = new Set(["dsh"]);
async function acpStart(harnessId: string, workspace: string, prompt: string): Promise<void> {
  const observed = await inventory({ ...(process.env.HH_REAL_MANIFEST ? { manifest: process.env.HH_REAL_MANIFEST } : {}), searchDirs: [], packageRoots: [], pathOnly: false });
  const control = observed.report.harnesses.find(harness => harness.id === harnessId)?.controls.find(item => item.state === "candidate" && item.protocol === "acp-v1");
  if (!control?.command) throw new Error("no ACP entry was discovered for " + harnessId);
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const driver = await createNativeControl(harnessId, { protocol: "acp-v1", executable: control.command.executable, args: [...control.command.args], env: { ...control.command.env } },
    { cwd: workspace, env, requestTimeoutMs: 30_000, runTimeoutMs: 5 * 60_000, maxFrameBytes: 8 * 1024 * 1024, maxDiagnosticBytes: 64 * 1024, closeGraceMs: 5_000 });
  try {
    await driver.initialize();
    if (!driver.open || !driver.startText) throw new Error("the ACP entry cannot hold a conversation");
    const id = await driver.open(workspace), result = await (await driver.startText(id, prompt, () => {})).result;
    if (result.status !== "completed") throw new Error("the native session start ended " + result.status);
  } finally { await driver.close(); }
}
const TERMINAL = new Set<PublicRun["status"]>(["completed", "failed", "cancelled", "unknown"]);
async function digest(path: string): Promise<string> {
  try { return createHash("sha256").update(await readFile(path)).digest("hex"); }
  catch (error) { if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return "missing"; throw error; }
}
type App = ReturnType<typeof application>;
async function closeApp(app: App): Promise<void> {
  try { await app.runtime.close(); } finally { try { await app.management.shutdown(); } finally { try { await app.providers.shutdown(); } finally { app.store.close(); } } }
}
function run(command: string, args: readonly string[], cwd: string): Promise<void> {
  // stdin is closed at once: `codex exec` otherwise waits for more prompt input on a pipe.
  return new Promise((resolve, reject) => { execFile(command, args, { cwd, env: process.env, timeout: 6 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 }, error => error ? reject(error) : resolve()).stdin?.end(); });
}
async function turn(app: App, id: SessionId, text: string): Promise<{ run: PublicRun; reply: string }> {
  app.runtime.send(id, text, "send-" + randomUUID());
  const deadline = Date.now() + 6 * 60 * 1000;
  for (;;) {
    const current = app.runtime.read(id).runs.at(-1)!;
    if (TERMINAL.has(current.status)) { await app.runtime.wait(id); const done = app.runtime.read(id).runs.at(-1)!; return { run: done, reply: app.runtime.read(id).messages.find(row => row.id === done.assistantMessageId)?.text ?? "" }; }
    if (app.runtime.permissionRequests(id).length) throw new Error("the continued turn asked for an approval");
    if (Date.now() > deadline) throw new Error("continued turn did not settle in time");
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

test("installed Harness continues its own session of the workspace in the Hub, which then answers from that session", { timeout: 25 * 60 * 1000 }, async () => {
  assert.ok(harnesses.length, "set HH_REAL_HARNESSES"); assert.ok(evidencePath, "set HH_REAL_EVIDENCE");
  const root = await realpath(await mkdtemp(join(process.env.HH_REAL_TMP ?? tmpdir(), "hh-native-import-")));
  const results: Record<string, unknown>[] = [], failures: string[] = [];
  try {
    for (const harnessId of harnesses) {
      const files = configFiles[harnessId] ?? [], before = await Promise.all(files.map(digest)), start = nativeStart[harnessId];
      const data = join(root, harnessId + "-data"), workspace = join(root, harnessId + "-workspace");
      await mkdir(workspace);
      const proof: Record<string, unknown> = { harnessId, startedAt: new Date().toISOString() };
      const app = application(data, () => {});
      try {
        assert.ok(start || acpStarted.has(harnessId), "no native session starter for " + harnessId);
        const tag = "T-" + randomUUID().slice(0, 6).toUpperCase(), prompt = "请记住标记 " + tag + "。只回复“好的”，不要调用任何工具，也不要保存到长期记忆。";
        // A start that the account refuses (Claude's exhausted quota) can still leave a native session to list and read.
        try { if (start) { const [command, args] = start(prompt); await run(command, args, workspace); } else await acpStart(harnessId, workspace, prompt); proof.nativeStart = start ? "completed" : "completed through the program's own ACP entry"; }
        catch (error) { proof.nativeStart = error instanceof Error ? error.message.split("\n").at(-2)?.slice(0, 200) ?? error.message.slice(0, 200) : "failed"; }
        const configuration = await prepareConfiguration({ workspace, ...(process.env.HH_REAL_MANIFEST ? { manifestPath: process.env.HH_REAL_MANIFEST } : {}) });
        const page = await app.factory.listNativeSessions({ harnessId }, configuration, AbortSignal.timeout(120_000));
        proof.listed = page === null ? null : { sessions: page.sessions.length, titled: page.sessions.filter(row => row.title !== null).length, sources: page.sessions.map(row => row.source ?? null) };
        const native = page?.sessions[0];
        if (!native) throw new Error("the Harness listed no session for the workspace");
        const imported = await app.runtime.importNative(configuration, { harnessId }, native.id, "import-" + randomUUID());
        const origin = imported.origin?.kind === "import" ? imported.origin : null;
        proof.imported = origin === null ? null : { messages: origin.history.length, omitted: origin.omitted, complete: origin.complete, historyRead: origin.historyRead, tagQuoted: origin.history.some(row => row.role === "user" && row.text.includes(tag)) };
        if (resumeOnly.has(harnessId) ? origin?.historyRead !== false || origin.history.length !== 0 : !origin?.historyRead || !origin.history.some(row => row.text.includes(tag))) failures.push(harnessId + ": quoted history");
        try { await app.runtime.importNative(configuration, { harnessId }, native.id, "import-" + randomUUID()); proof.secondImport = "accepted"; failures.push(harnessId + ": second holder"); }
        catch (error) { proof.secondImport = error !== null && typeof error === "object" && "code" in error ? String(error.code) : "failed"; }
        const asked = await turn(app, imported.id, "我之前让你记住的标记是什么？只回复那个标记本身，不要调用任何工具。");
        proof.turn = { status: asked.run.status, matched: asked.reply.includes(tag), sourceRunIds: asked.run.sourceRunIds.length, binding: app.runtime.read(imported.id).nativeBindings?.map(row => row.status) ?? [] };
        if (asked.run.status !== "completed" || !asked.reply.includes(tag) || asked.run.sourceRunIds.length) failures.push(harnessId + ": continued answer");
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
  assert.deepEqual(failures, [], "native session continuation acceptance failed");
});
