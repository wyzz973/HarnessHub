import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { application } from "../../src/cli/session-application.js";
import type { PublicRun } from "../../src/contracts/session.js";
import { prepareConfiguration } from "../../src/infrastructure/session/binding-factory.js";

/**
 * Original-installation acceptance of a native question: the installed Harness asks the user through its own question
 * tool, the Hub shows it as a chat question, the test picks the second choice as a user would, and the Harness must act
 * on that answer. Evidence keeps the question's shape and the match, never the transcript.
 */
const harnesses = (process.env.HH_REAL_HARNESSES ?? "").split(",").map(value => value.trim()).filter(Boolean);
const evidencePath = process.env.HH_REAL_EVIDENCE;
const home = process.env.HOME ?? homedir();
const configFiles: Readonly<Record<string, readonly string[]>> = {
  claude: [join(home, ".claude", "settings.json")],
  codex: [join(home, ".codex", "config.toml")],
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

test("installed Harness asks the user through its own question tool and acts on the chosen answer", { timeout: 15 * 60 * 1000 }, async () => {
  assert.ok(harnesses.length, "set HH_REAL_HARNESSES"); assert.ok(evidencePath, "set HH_REAL_EVIDENCE");
  const root = await realpath(await mkdtemp(join(process.env.HH_REAL_TMP ?? tmpdir(), "hh-native-question-")));
  const results: Record<string, unknown>[] = [], failures: string[] = [];
  try {
    for (const harnessId of harnesses) {
      const files = configFiles[harnessId] ?? [], before = await Promise.all(files.map(digest));
      const data = join(root, harnessId + "-data"), workspace = join(root, harnessId + "-workspace");
      await mkdir(workspace);
      const configuration = await prepareConfiguration({ workspace, ...(process.env.HH_REAL_MANIFEST ? { manifestPath: process.env.HH_REAL_MANIFEST } : {}) });
      const proof: Record<string, unknown> = { harnessId, startedAt: new Date().toISOString() }, questions: Record<string, unknown>[] = [];
      proof.questions = questions;
      const app = application(data, () => {});
      try {
        const requested = process.env["HH_REAL_MODEL_" + harnessId.toUpperCase()];
        const session = await app.runtime.create(configuration, { harnessId, ...(requested === undefined ? {} : { nativeModel: requested }) }, "create-" + randomUUID());
        app.runtime.send(session.id, "在回答之前，请用你的提问工具（例如 AskUserQuestion）问我一个问题：“选择一种颜色”，选项只有“红色”和“蓝色”。拿到我的回答后，只回复我选择的颜色，不要调用其他工具。", "send-" + randomUUID());
        let chosen: string | null = null;
        const deadline = Date.now() + 8 * 60 * 1000;
        for (;;) {
          for (const request of app.runtime.permissionRequests(session.id).filter(item => !item.decided)) {
            const choices = request.options.filter(option => option.id.startsWith("answer-"));
            questions.push({ title: request.title.slice(0, 120), options: request.options.map(option => option.id), hasInput: request.input !== undefined, hasDetail: request.detail !== undefined });
            const option = choices[1] ?? request.options.find(option => /^(allow|accept|once)/iu.test(option.id) && !/always/iu.test(option.id));
            if (!option) throw new Error("no answer or one-time allow option");
            if (choices[1]) chosen = choices[1].name;
            await app.runtime.decidePermission(session.id, request.id, option.id, "answer-" + randomUUID());
          }
          const run = app.runtime.read(session.id).runs.at(-1)!;
          if (TERMINAL.has(run.status)) break;
          if (Date.now() > deadline) throw new Error("question turn did not settle in time");
          await new Promise(resolve => setTimeout(resolve, 200));
        }
        await app.runtime.wait(session.id);
        const run = app.runtime.read(session.id).runs.at(-1)!, reply = app.runtime.read(session.id).messages.find(row => row.id === run.assistantMessageId)?.text ?? "";
        proof.run = { status: run.status, error: run.error, cleanup: run.cleanup?.closed ?? null, chosen, matched: chosen !== null && reply.includes(chosen), replyBytes: Buffer.byteLength(reply) };
        if (run.status !== "completed") failures.push(harnessId + ": turn");
        if (chosen === null) failures.push(harnessId + ": no native question");
        else if (!reply.includes(chosen)) failures.push(harnessId + ": answer not used");
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
  assert.deepEqual(failures, [], "native question acceptance failed");
});
