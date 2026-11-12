import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { application } from "../../src/cli/session-application.js";
import type { PublicRun, SessionId } from "../../src/contracts/session.js";
import { prepareConfiguration } from "../../src/infrastructure/session/binding-factory.js";
import { captureNativeEnvironment } from "../../src/infrastructure/session/native-environment.js";
import { describeGuard, evidenceHeader, guardTargets, recheck, snapshot, type EvidenceHeader, type GuardCheck } from "./guard.js";
import { oldShape } from "../fixtures/old-shape.js";

/*
 * Original-installation acceptance of a branch inside a conversation (the page's 编辑并重发): the user's installed Harness is told a tag A, then
 * a tag B; the message that told B is edited and sent again as a question about the tags. The new branch's reply may know only what its path
 * holds (A), never B. Then the old branch is selected again and the same question asked: that path holds A and B. Each step records how the
 * Hub carried it: the native sessions given up, a new one opened, the history handed over (sourceRunIds) or not.
 *
 * Evidence keeps statuses, counts and match flags, never a word of the conversation.
 */
const harnesses = (process.env.HH_REAL_HARNESSES ?? "").split(",").map(value => value.trim()).filter(Boolean);
const evidencePath = process.env.HH_REAL_EVIDENCE;
const environment = captureNativeEnvironment();
const realInstallations = process.env.HH_REAL_MANIFEST ? "any" as const : "official" as const;
const TERMINAL = new Set<PublicRun["status"]>(["completed", "failed", "cancelled", "unknown"]);
type App = ReturnType<typeof application>;
async function closeApp(app: App): Promise<void> {
  try { await app.runtime.close(); } finally { try { await app.management.shutdown(); } finally { try { await app.providers.shutdown(); } finally { app.store.close(); } } }
}
async function settle(app: App, id: SessionId, runId: string): Promise<{ run: PublicRun; reply: string }> {
  for (const deadline = Date.now() + 6 * 60 * 1000; ;) {
    const state = oldShape(app.runtime, id), run = state.runs.find(row => row.id === runId);
    if (run !== undefined && TERMINAL.has(run.status)) {
      await app.runtime.wait(id);
      const done = oldShape(app.runtime, id), finished = done.runs.find(row => row.id === runId)!;
      return { run: finished, reply: done.messages.find(row => row.id === finished.assistantMessageId)?.text ?? "" };
    }
    if (app.runtime.permissionRequests(id).length) throw new Error("a branch turn asked for an approval");
    if (Date.now() > deadline) throw new Error("branch turn did not settle in time");
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}
function bindings(app: App, id: SessionId): readonly string[] { return (oldShape(app.runtime, id).nativeBindings ?? []).map(binding => binding.status); }
function prepared(app: App, id: SessionId): readonly boolean[] {
  const rows = [];
  for (let after = 0; ;) { const page = app.store.events(id, after, 100); if (!page.length) break; rows.push(...page); after = page.at(-1)!.seq; }
  return rows.filter(row => row.type === "native.binding_prepared").map(row => row.data.resumed === true);
}

test("installed Harness answers an edited message from its branch's path only", { timeout: 30 * 60 * 1000 }, async () => {
  assert.ok(harnesses.length, "set HH_REAL_HARNESSES"); assert.ok(evidencePath, "set HH_REAL_EVIDENCE"); guardTargets(harnesses);
  const root = await realpath(await mkdtemp(join(process.env.HH_REAL_TMP ?? tmpdir(), "hh-edit-resend-")));
  const results: Record<string, unknown>[] = [], failures: string[] = [];
  let header: EvidenceHeader | null = null;
  try {
    for (const harnessId of harnesses) {
      const before = await snapshot([harnessId], environment);
      const data = join(root, harnessId + "-data"), workspace = join(root, harnessId + "-workspace");
      await mkdir(workspace);
      const configuration = await prepareConfiguration({ workspace });
      const proof: Record<string, unknown> = { harnessId, startedAt: new Date().toISOString() };
      const app = application(data, () => {}, { installations: realInstallations, workspaceLockRoot: join(root, "locks") });
      try {
        header ??= await evidenceHeader(app, harnesses, { configuration });
        const requested = process.env["HH_REAL_MODEL_" + harnessId.toUpperCase()];
        const { id } = await app.runtime.create(configuration, { harnessId, ...(requested === undefined ? {} : { nativeModel: requested }) }, "create-" + randomUUID());
        const tagA = "A-" + randomUUID().slice(0, 6).toUpperCase(), tagB = "B-" + randomUUID().slice(0, 6).toUpperCase();
        const say = async (text: string, branchFrom?: string) => settle(app, id, app.runtime.send(id, text, "send-" + randomUUID(), [], undefined, branchFrom).runId);
        const first = await say("请记住标记 " + tagA + "。只回复“好的”，不要调用任何工具。");
        const second = await say("请再记住一个标记 " + tagB + "。只回复“好的”，不要调用任何工具。");
        proof.told = { first: first.run.status, second: second.run.status, bindings: bindings(app, id) };
        // Asked as what the conversation holds, not as what the model was told to remember: a handoff packet calls its record history, not
        // instructions, and a model may then say it was told nothing (Hermes with deepseek-v4-pro did, 2026-11-13).
        const question = "这段对话里（包括交给你的记录）出现过哪些以 A- 或 B- 开头的标记？把它们原样列出来，只回复标记本身；一个都没有就只回复“没有”。不要调用任何工具。";
        // 编辑并重发: the message that told B, edited into the question, sent again in its place.
        const edited = await say(question, second.run.id);
        proof.edited = { relay: edited.run.relay === undefined ? null : { kind: edited.run.relay.kind, continuity: edited.run.relay.continuity }, status: edited.run.status, knowsA: edited.reply.includes(tagA), knowsB: edited.reply.includes(tagB), sourceRunIds: edited.run.sourceRunIds.length,
          ordinal: oldShape(app.runtime, id).runs.findIndex(row => row.id === edited.run.id), bindings: bindings(app, id), resumedFlags: prepared(app, id) };
        // HH_REAL_DEBUG=1: the replies go to stderr (never to the evidence) for looking into a failure.
        if (process.env.HH_REAL_DEBUG === "1") {
          process.stderr.write(harnessId + " edited reply: " + edited.reply.slice(0, 400) + "\n" + JSON.stringify(edited.run.relay ?? null) + "\n");
          for (const row of app.store.events(id, 0, 500)) if (row.data.runId === edited.run.id && /relay|context|dispatch/u.test(row.type)) process.stderr.write(row.type + " " + JSON.stringify(row.data).slice(0, 1500) + "\n");
        }
        if (edited.run.status !== "completed" || !edited.reply.includes(tagA) || edited.reply.includes(tagB)) failures.push(harnessId + ": edited branch");
        // Back to the first branch, which holds both tags.
        app.runtime.selectBranch(id, second.run.id, "branch-" + randomUUID());
        const back = await say(question);
        proof.back = { relay: back.run.relay === undefined ? null : { kind: back.run.relay.kind, continuity: back.run.relay.continuity }, status: back.run.status, knowsA: back.reply.includes(tagA), knowsB: back.reply.includes(tagB), sourceRunIds: back.run.sourceRunIds.length, bindings: bindings(app, id), resumedFlags: prepared(app, id) };
        if (back.run.status !== "completed" || !back.reply.includes(tagA) || !back.reply.includes(tagB)) failures.push(harnessId + ": selected branch");
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
  assert.deepEqual(failures, [], "edit and resend acceptance failed");
});
