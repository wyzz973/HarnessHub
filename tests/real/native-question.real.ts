import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { application } from "../../src/cli/session-application.js";
import type { PublicRun } from "../../src/contracts/session.js";
import { prepareConfiguration } from "../../src/infrastructure/session/binding-factory.js";
import { captureNativeEnvironment } from "../../src/infrastructure/session/native-environment.js";
import { describeGuard, evidenceHeader, guardTargets, recheck, snapshot, type EvidenceHeader, type GuardCheck } from "./guard.js";
import { oldShape } from "../fixtures/old-shape.js";
/** A development manifest (HH_REAL_MANIFEST) names non-official entries, which only the development policy reads (ADR-044). */
const realInstallations = process.env.HH_REAL_MANIFEST ? "any" as const : "official" as const;

/**
 * Original-installation acceptance of a native question: the installed Harness asks the user through its own question
 * tool, the Hub shows it as a chat question, the test picks the second choice as a user would, and the Harness must act
 * on that answer. Evidence keeps the question's shape and the match, never the transcript.
 */
const harnesses = (process.env.HH_REAL_HARNESSES ?? "").split(",").map(value => value.trim()).filter(Boolean);
const evidencePath = process.env.HH_REAL_EVIDENCE;
/** The user's home and environment as the Harness runs with them; the shared guard (./guard.ts) snapshots its configuration from them. */
const environment = captureNativeEnvironment();
const TERMINAL = new Set<PublicRun["status"]>(["completed", "failed", "cancelled", "unknown"]);
type App = ReturnType<typeof application>;
async function closeApp(app: App): Promise<void> {
  try { await app.runtime.close(); } finally { try { await app.management.shutdown(); } finally { try { await app.providers.shutdown(); } finally { app.store.close(); } } }
}

test("installed Harness asks the user through its own question tool and acts on the chosen answer", { timeout: 15 * 60 * 1000 }, async () => {
  assert.ok(harnesses.length, "set HH_REAL_HARNESSES"); assert.ok(evidencePath, "set HH_REAL_EVIDENCE"); guardTargets(harnesses);
  const root = await realpath(await mkdtemp(join(process.env.HH_REAL_TMP ?? tmpdir(), "hh-native-question-")));
  const results: Record<string, unknown>[] = [], failures: string[] = [];
  let header: EvidenceHeader | null = null;
  try {
    for (const harnessId of harnesses) {
      const before = await snapshot([harnessId], environment);
      const data = join(root, harnessId + "-data"), workspace = join(root, harnessId + "-workspace");
      await mkdir(workspace);
      const configuration = await prepareConfiguration({ workspace, ...(process.env.HH_REAL_MANIFEST ? { manifestPath: process.env.HH_REAL_MANIFEST } : {}) });
      const proof: Record<string, unknown> = { harnessId, startedAt: new Date().toISOString() }, questions: Record<string, unknown>[] = [];
      proof.questions = questions;
      const app = application(data, () => {}, { installations: realInstallations, workspaceLockRoot: join(root, "locks") });
      try {
        header ??= await evidenceHeader(app, harnesses, { configuration });
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
          const run = oldShape(app.runtime, session.id).runs.at(-1)!;
          if (TERMINAL.has(run.status)) break;
          if (Date.now() > deadline) throw new Error("question turn did not settle in time");
          await new Promise(resolve => setTimeout(resolve, 200));
        }
        await app.runtime.wait(session.id);
        const run = oldShape(app.runtime, session.id).runs.at(-1)!, reply = oldShape(app.runtime, session.id).messages.find(row => row.id === run.assistantMessageId)?.text ?? "";
        proof.run = { status: run.status, error: run.error, cleanup: run.cleanup?.closed ?? null, chosen, matched: chosen !== null && reply.includes(chosen), replyBytes: Buffer.byteLength(reply) };
        if (run.status !== "completed") failures.push(harnessId + ": turn");
        if (chosen === null) failures.push(harnessId + ": no native question");
        else if (!reply.includes(chosen)) failures.push(harnessId + ": answer not used");
      } catch (error) {
        proof.failure = { code: error !== null && typeof error === "object" && "code" in error ? String(error.code) : "ASSERTION", message: error instanceof Error ? error.message.slice(0, 512) : "failed" };
        failures.push(harnessId + ": " + (proof.failure as { code: string }).code);
      } finally {
        await closeApp(app);
        const guard: GuardCheck = await recheck(before, environment);
        proof.guard = guard;
        if (!guard.unchanged) failures.push(harnessId + ": " + describeGuard(guard));
        proof.finishedAt = new Date().toISOString();
        results.push(proof);
        await writeFile(evidencePath, JSON.stringify({ header, results }, null, 2) + "\n", { mode: 0o600 });
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
  assert.deepEqual(failures, [], "native question acceptance failed");
});
