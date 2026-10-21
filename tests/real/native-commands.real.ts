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
/** A development manifest (HH_REAL_MANIFEST) names non-official entries, which only the development policy reads (ADR-044). */
const realInstallations = process.env.HH_REAL_MANIFEST ? "any" as const : "official" as const;

/**
 * Original-installation acceptance of native session operations offered as commands: after one ordinary turn, `/compact`
 * must run the Harness's own compaction and `/export` must return its own transcript as an output. Each command is used
 * only when the installed catalog lists it. Evidence keeps statuses, activity kinds and output shapes, never transcripts.
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
async function turn(app: App, id: SessionId, text: string): Promise<PublicRun> {
  app.runtime.send(id, text, "send-" + randomUUID());
  const deadline = Date.now() + 6 * 60 * 1000;
  for (;;) {
    const run = app.runtime.read(id).runs.at(-1)!;
    if (TERMINAL.has(run.status)) { await app.runtime.wait(id); return app.runtime.read(id).runs.at(-1)!; }
    if (app.runtime.permissionRequests(id).length) throw new Error("a native command turn asked for an approval");
    if (Date.now() > deadline) throw new Error("native command turn did not settle in time");
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}
function summary(app: App, id: SessionId, run: PublicRun): Record<string, unknown> {
  const reply = app.runtime.read(id).messages.find(row => row.id === run.assistantMessageId)?.text ?? "";
  return { status: run.status, error: run.error, replyBytes: Buffer.byteLength(reply), activities: (run.activities ?? []).map(item => [item.kind, item.status, (item.detail ?? "").slice(0, 200)]),
    outputs: (run.outputs ?? []).map(output => output.kind === "content" ? { kind: output.content.kind, mediaType: output.content.mediaType, bytes: output.content.bytes } : { kind: "link" }), cleanup: run.cleanup?.closed ?? null };
}

test("installed Harness compacts and exports its own session through the unified commands", { timeout: 20 * 60 * 1000 }, async () => {
  assert.ok(harnesses.length, "set HH_REAL_HARNESSES"); assert.ok(evidencePath, "set HH_REAL_EVIDENCE"); guardTargets(harnesses);
  const root = await realpath(await mkdtemp(join(process.env.HH_REAL_TMP ?? tmpdir(), "hh-native-commands-")));
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
        const requested = process.env["HH_REAL_MODEL_" + harnessId.toUpperCase()];
        const catalog = await app.factory.discoverModels({ harnessId }, configuration, new AbortController().signal);
        const names = new Set((catalog.commands ?? []).map(command => command.name));
        proof.commands = { compact: names.has("compact"), export: names.has("export") };
        const created = await app.runtime.create(configuration, { harnessId, ...(requested === undefined ? {} : { nativeModel: requested }) }, "create-" + randomUUID());
        const first = await turn(app, created.id, "请记住数字 42。只回复“好的”，不要调用任何工具。");
        proof.first = summary(app, created.id, first);
        if (first.status !== "completed") failures.push(harnessId + ": first turn");
        // HH_REAL_FILL=n adds n reference messages so a Harness that keeps recent context uncompacted has something to compact.
        const fill = Number(process.env.HH_REAL_FILL ?? "0"), paragraph = "The reference archive describes routine maintenance of a fictional lighthouse, including lamp cleaning, log keeping and weather notes. ";
        for (let index = 0; index < fill; index++) {
          const filler = await turn(app, created.id, "以下是参考资料，不需要分析，只回复“收到”。\n" + paragraph.repeat(380));
          if (filler.status !== "completed") failures.push(harnessId + ": filler " + index);
        }
        proof.fill = fill;
        if (names.has("compact")) {
          const compact = await turn(app, created.id, "/compact");
          proof.compact = summary(app, created.id, compact);
          if (compact.status !== "completed") failures.push(harnessId + ": compact");
          // The native session still answers from its own (now compacted) context.
          const after = await turn(app, created.id, "我让你记住的数字是多少？只回复数字。");
          const reply = app.runtime.read(created.id).messages.find(row => row.id === after.assistantMessageId)?.text ?? "";
          proof.afterCompact = { ...summary(app, created.id, after), remembered: reply.includes("42"), sourceRunIds: after.sourceRunIds.length };
          if (after.status !== "completed" || !reply.includes("42")) failures.push(harnessId + ": context after compaction");
        }
        if (names.has("export")) {
          const exported = await turn(app, created.id, "/export");
          proof.export = summary(app, created.id, exported);
          if (exported.status !== "completed" || !(exported.outputs ?? []).some(output => output.kind === "content" && output.content.bytes > 0)) failures.push(harnessId + ": export");
        }
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
  assert.deepEqual(failures, [], "native command acceptance failed");
});
