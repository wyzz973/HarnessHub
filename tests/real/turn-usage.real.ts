import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { application } from "../../src/cli/session-application.js";
import { turnUsage } from "../../src/contexts/session/domain/protocol/usage.js";
import type { PublicRun, SessionId } from "../../src/contracts/session.js";
import { prepareConfiguration } from "../../src/infrastructure/session/binding-factory.js";
import { captureNativeEnvironment } from "../../src/infrastructure/session/native-environment.js";
import { describeGuard, evidenceHeader, guardTargets, recheck, snapshot, type EvidenceHeader, type GuardCheck } from "./guard.js";
import { oldShape } from "../fixtures/old-shape.js";

/*
 * Original-installation acceptance of a Turn's usage (the footnote's 输入 / 输出): two short Turns, a restart of the Hub (a new owner of the
 * same data root), and two more, on the user's installed Harness. Each Turn's numbers are recorded as the Driver passed them on and as the
 * page shows them (turnUsage), with the checks the Harness's own definitions allow: the page's input plus output against the Harness's own
 * total, and what is left of the total once input, cache and output are taken away. For Hermes the session's record (`/export`, which the Hub
 * runs with `hermes sessions export`, nothing sent to the model) is compared with the sum of the first two Turns.
 *
 * Evidence keeps numbers, statuses and flags, never a word of the conversation.
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
async function turn(app: App, id: SessionId, text: string): Promise<PublicRun> {
  app.runtime.send(id, text, "send-" + randomUUID());
  for (const deadline = Date.now() + 6 * 60 * 1000; ;) {
    const run = oldShape(app.runtime, id).runs.at(-1)!;
    if (TERMINAL.has(run.status)) { await app.runtime.wait(id); return oldShape(app.runtime, id).runs.at(-1)!; }
    if (app.runtime.permissionRequests(id).length) throw new Error("a usage turn asked for an approval");
    if (Date.now() > deadline) throw new Error("usage turn did not settle in time");
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}
function numbers(harnessId: string, run: PublicRun): Record<string, unknown> {
  const native = run.usage?.turn, shown = turnUsage(harnessId, run.usage, run.status);
  const rest = native?.total === undefined || native.input === undefined || native.output === undefined ? null : native.total - native.input - (native.cachedInput ?? 0) - (native.cacheWrite ?? 0) - native.output;
  return { status: run.status, native: native ?? null, context: run.usage?.context ?? null, shown,
    // The page's input and output together against the Harness's own total; what the total holds beyond input, cache and output.
    shownSumIsTotal: native?.total === undefined || shown.input === undefined || shown.output === undefined ? null : shown.input + shown.output === native.total,
    totalLeft: rest };
}

test("installed Harness Turns report their own usage, read in one meaning", { timeout: 30 * 60 * 1000 }, async () => {
  assert.ok(harnesses.length, "set HH_REAL_HARNESSES"); assert.ok(evidencePath, "set HH_REAL_EVIDENCE"); guardTargets(harnesses);
  const root = await realpath(await mkdtemp(join(process.env.HH_REAL_TMP ?? tmpdir(), "hh-turn-usage-")));
  const results: Record<string, unknown>[] = [], failures: string[] = [];
  let header: EvidenceHeader | null = null;
  try {
    for (const harnessId of harnesses) {
      const before = await snapshot([harnessId], environment);
      const data = join(root, harnessId + "-data"), workspace = join(root, harnessId + "-workspace");
      await mkdir(workspace);
      const configuration = await prepareConfiguration({ workspace });
      const proof: Record<string, unknown> = { harnessId, startedAt: new Date().toISOString() };
      let app: App | null = application(data, () => {}, { installations: realInstallations, workspaceLockRoot: join(root, "locks") });
      try {
        header ??= await evidenceHeader(app, harnesses, { configuration });
        const requested = process.env["HH_REAL_MODEL_" + harnessId.toUpperCase()];
        const created = await app.runtime.create(configuration, { harnessId, ...(requested === undefined ? {} : { nativeModel: requested }) }, "create-" + randomUUID());
        const turns: Record<string, unknown>[] = [];
        proof.turns = turns;
        const ask = "这是一次用量验收。只回复 OK 两个字母，不要调用任何工具。";
        for (const label of ["first", "second"]) turns.push({ label, ...numbers(harnessId, await turn(app, created.id, ask)) });
        if (harnessId === "hermes") {
          // The session's own record: its counters since it was created, which are these two Turns.
          const exported = await turn(app, created.id, "/export");
          const output = (exported.outputs ?? []).flatMap(item => item.kind === "link" ? [] : [item])[0];
          const record = output === undefined ? null : JSON.parse((await readFile(app.content.read(output.content.id).path, "utf8")).trim()) as Record<string, unknown>;
          const pick = (key: string) => typeof record?.[key] === "number" ? record[key] as number : null;
          proof.hermesRecord = record === null ? null : { input: pick("input_tokens"), output: pick("output_tokens"), cacheRead: pick("cache_read_tokens"), cacheWrite: pick("cache_write_tokens"), reasoning: pick("reasoning_tokens"),
            keys: Object.keys(record).filter(key => /token/u.test(key)).sort() };
        }
        // A new owner of the same data root: the native session is restored, and the Driver knows nothing of its counters.
        await closeApp(app); app = null;
        app = application(data, () => {}, { installations: realInstallations, workspaceLockRoot: join(root, "locks") });
        for (const label of ["after restart", "after restart, second"]) turns.push({ label, ...numbers(harnessId, await turn(app, created.id, ask)) });
        const counted = turns.filter(row => (row.shown as { completeness: string }).completeness === "complete").length;
        proof.checks = { allCompleted: turns.every(row => row.status === "completed"), counted, sumsMatch: turns.every(row => row.shownSumIsTotal !== false), nothingLeftNegative: turns.every(row => row.totalLeft === null || (row.totalLeft as number) >= 0) };
        for (const [name, passed] of Object.entries(proof.checks as Record<string, unknown>)) if (passed === false) failures.push(harnessId + ": " + name);
      } catch (error) {
        proof.failure = { code: error !== null && typeof error === "object" && "code" in error ? String(error.code) : "ASSERTION", message: error instanceof Error ? error.message.slice(0, 512) : "failed" };
        failures.push(harnessId + ": " + (proof.failure as { code: string }).code);
      } finally {
        if (app) await closeApp(app);
        const guard: GuardCheck = await recheck(before, environment);
        proof.guard = guard;
        if (!guard.unchanged) failures.push(harnessId + ": " + describeGuard(guard));
        proof.finishedAt = new Date().toISOString();
        results.push(proof);
        await writeFile(evidencePath, JSON.stringify({ header, results }, null, 2) + "\n", { mode: 0o600 });
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
  assert.deepEqual(failures, [], "turn usage acceptance failed");
});
