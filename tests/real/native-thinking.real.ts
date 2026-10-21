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
/** A development manifest (HH_REAL_MANIFEST) names non-official entries, which only the development policy reads (ADR-044). */
const realInstallations = process.env.HH_REAL_MANIFEST ? "any" as const : "official" as const;

/**
 * Original-installation acceptance of thinking output: a small reasoning question in a session whose native settings ask
 * for thinking (HH_REAL_OPTIONS_<ID>, for example an effort level). The Run must keep the Harness's own thinking apart from
 * the reply. Evidence keeps sizes and the match, never the thinking text.
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

test("installed Harness thinking is kept on the Run apart from its reply", { timeout: 15 * 60 * 1000 }, async () => {
  assert.ok(harnesses.length, "set HH_REAL_HARNESSES"); assert.ok(evidencePath, "set HH_REAL_EVIDENCE"); guardTargets(harnesses);
  const root = await realpath(await mkdtemp(join(process.env.HH_REAL_TMP ?? tmpdir(), "hh-native-thinking-")));
  const results: Record<string, unknown>[] = [], failures: string[] = [];
  let header: EvidenceHeader | null = null;
  try {
    for (const harnessId of harnesses) {
      const before = await snapshot([harnessId], environment);
      const data = join(root, harnessId + "-data"), workspace = join(root, harnessId + "-workspace");
      await mkdir(workspace);
      const configuration = await prepareConfiguration({ workspace, ...(process.env.HH_REAL_MANIFEST ? { manifestPath: process.env.HH_REAL_MANIFEST } : {}) });
      const proof: Record<string, unknown> = { harnessId, startedAt: new Date().toISOString() };
      const app = application(data, () => {}, { installations: realInstallations, workspaceLockRoot: join(root, "locks") });
      try {
        header ??= await evidenceHeader(app, harnesses, { configuration });
        const requested = process.env["HH_REAL_MODEL_" + harnessId.toUpperCase()], optionsText = process.env["HH_REAL_OPTIONS_" + harnessId.toUpperCase()];
        const nativeOptions = optionsText === undefined ? undefined : JSON.parse(optionsText) as Record<string, string>;
        const session = await app.runtime.create(configuration, { harnessId, ...(requested === undefined ? {} : { nativeModel: requested }), ...(nativeOptions === undefined ? {} : { nativeOptions }) }, "create-" + randomUUID());
        app.runtime.send(session.id, "请先仔细思考再回答：一个班有 37 名学生，每人买 43 支铅笔，一共多少支？只回复最终的数字，不要调用任何工具。", "send-" + randomUUID());
        const deadline = Date.now() + 6 * 60 * 1000;
        while (!TERMINAL.has(app.runtime.read(session.id).runs.at(-1)!.status)) {
          if (Date.now() > deadline) throw new Error("thinking turn did not settle in time");
          if (app.runtime.permissionRequests(session.id).length) throw new Error("the thinking turn asked for an approval");
          await new Promise(resolve => setTimeout(resolve, 200));
        }
        await app.runtime.wait(session.id);
        const run = app.runtime.read(session.id).runs.at(-1)!, reply = app.runtime.read(session.id).messages.find(row => row.id === run.assistantMessageId)?.text ?? "";
        const thinking = run.thinking ?? "";
        proof.nativeOptions = nativeOptions ?? null;
        proof.run = { status: run.status, error: run.error, cleanup: run.cleanup?.closed ?? null, thinkingChars: thinking.length, replyMatched: reply.includes("1591"), thinkingInReply: thinking.length > 20 && reply.includes(thinking.slice(0, 20)) };
        if (run.status !== "completed") failures.push(harnessId + ": turn");
        if (!thinking.trim()) failures.push(harnessId + ": no thinking");
        if (!reply.includes("1591")) failures.push(harnessId + ": answer");
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
  assert.deepEqual(failures, [], "native thinking acceptance failed");
});
