import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { application } from "../../src/cli/session-application.js";
import type { PublicRun, SessionId } from "../../src/contracts/session.js";
import { prepareConfiguration } from "../../src/infrastructure/session/binding-factory.js";

/**
 * Original-installation acceptance of branching: the source remembers a tag, the branch must answer it (from a native
 * fork when the Harness can fork, from quoted public history otherwise), and a fact told only to the branch must not
 * reach the source. Evidence keeps statuses, continuity and match flags, never transcripts or native references.
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
async function turn(app: App, id: SessionId, text: string): Promise<{ run: PublicRun; reply: string }> {
  app.runtime.send(id, text, "send-" + randomUUID());
  const deadline = Date.now() + 6 * 60 * 1000;
  for (;;) {
    const run = app.runtime.read(id).runs.at(-1)!;
    if (TERMINAL.has(run.status)) { await app.runtime.wait(id); const done = app.runtime.read(id).runs.at(-1)!; return { run: done, reply: app.runtime.read(id).messages.find(row => row.id === done.assistantMessageId)?.text ?? "" }; }
    if (app.runtime.permissionRequests(id).length) throw new Error("a branch turn asked for an approval");
    if (Date.now() > deadline) throw new Error("branch turn did not settle in time");
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

test("installed Harness branches a conversation natively when it can, and the branch stays separate from its source", { timeout: 20 * 60 * 1000 }, async () => {
  assert.ok(harnesses.length, "set HH_REAL_HARNESSES"); assert.ok(evidencePath, "set HH_REAL_EVIDENCE");
  const root = await realpath(await mkdtemp(join(tmpdir(), "hh-native-branch-")));
  const results: Record<string, unknown>[] = [], failures: string[] = [];
  try {
    for (const harnessId of harnesses) {
      const files = configFiles[harnessId] ?? [], before = await Promise.all(files.map(digest));
      const data = join(root, harnessId + "-data"), workspace = join(root, harnessId + "-workspace");
      await mkdir(workspace);
      const configuration = await prepareConfiguration({ workspace });
      const proof: Record<string, unknown> = { harnessId, startedAt: new Date().toISOString() };
      const app = application(data, () => {});
      try {
        const requested = process.env["HH_REAL_MODEL_" + harnessId.toUpperCase()];
        const source = await app.runtime.create(configuration, { harnessId, ...(requested === undefined ? {} : { nativeModel: requested }) }, "create-" + randomUUID());
        const tagA = "A-" + randomUUID().slice(0, 6).toUpperCase(), tagB = "B-" + randomUUID().slice(0, 6).toUpperCase();
        const first = await turn(app, source.id, "请记住标记 " + tagA + "。只回复“好的”，不要调用任何工具。");
        proof.source = { status: first.run.status, binding: app.runtime.read(source.id).nativeBindings?.map(binding => binding.status) ?? [] };
        if (first.run.status !== "completed") failures.push(harnessId + ": source turn");
        const branch = app.runtime.fork(source.id, "fork-" + randomUUID());
        await app.runtime.wait(branch.id);
        const forked = app.runtime.read(branch.id), events = app.store.events(branch.id, 0, 100).filter(row => row.type.startsWith("native.")).map(row => {
          const data = row.data as { error?: { code?: string } | null; cleanup?: { exitCode?: number | null; protocolFailure?: { code?: string } | null } | null };
          return { type: row.type, error: data.error?.code ?? null, exitCode: data.cleanup?.exitCode ?? null, protocolFailure: data.cleanup?.protocolFailure?.code ?? null };
        });
        proof.fork = { quoted: forked.origin?.history.length ?? 0, binding: forked.nativeBindings?.map(binding => binding.status) ?? [], events };
        const asked = await turn(app, branch.id, "我之前让你记住的标记是什么？只回复那个标记本身，不要调用任何工具。");
        proof.branch = { status: asked.run.status, matched: asked.reply.includes(tagA), sourceRunIds: asked.run.sourceRunIds.length, native: forked.nativeBindings?.some(binding => binding.status === "ready") ?? false };
        if (asked.run.status !== "completed" || !asked.reply.includes(tagA)) failures.push(harnessId + ": branch answer");
        const told = await turn(app, branch.id, "请记住第二个标记 " + tagB + "。只回复“好的”，不要调用任何工具。");
        if (told.run.status !== "completed") failures.push(harnessId + ": branch second turn");
        const check = await turn(app, source.id, "你是否知道一个以 B- 开头的标记？知道就只回复它，不知道就只回复“不知道”。不要调用任何工具。");
        proof.isolation = { status: check.run.status, leaked: check.reply.includes(tagB) };
        if (check.run.status !== "completed" || check.reply.includes(tagB)) failures.push(harnessId + ": source isolation");
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
  assert.deepEqual(failures, [], "native branch acceptance failed");
});
