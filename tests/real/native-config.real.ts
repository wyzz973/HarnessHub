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
/** A development manifest (HH_REAL_MANIFEST) names non-official entries, which only the development policy reads (ADR-044). */
const realInstallations = process.env.HH_REAL_MANIFEST ? "any" as const : "official" as const;

/**
 * Original-installation acceptance of native configuration sync (ADR-028): the conversation selects an option value, a
 * native command typed in the chat changes it, the next Turn keeps the native value instead of reverting it, and an
 * explicit switch to the same selection applies the selection again. Evidence keeps statuses and option values only.
 *
 * HH_REAL_HARNESSES=openclaw HH_REAL_CONFIG_OPTION=thought_level HH_REAL_CONFIG_FROM=low HH_REAL_CONFIG_TO=high
 * HH_REAL_CONFIG_COMMAND="/think high" HH_REAL_EVIDENCE=<file>. HH_REAL_CONFIG_OPTION=model selects and observes the model instead.
 */
const harnesses = (process.env.HH_REAL_HARNESSES ?? "").split(",").map(value => value.trim()).filter(Boolean);
const evidencePath = process.env.HH_REAL_EVIDENCE;
const option = process.env.HH_REAL_CONFIG_OPTION, from = process.env.HH_REAL_CONFIG_FROM, to = process.env.HH_REAL_CONFIG_TO, command = process.env.HH_REAL_CONFIG_COMMAND;
/** The user's home and environment as the Harness runs with them; the shared guard (./guard.ts) snapshots its configuration from them. */
const environment = captureNativeEnvironment();
const TERMINAL = new Set<PublicRun["status"]>(["completed", "failed", "cancelled", "unknown"]);
type App = ReturnType<typeof application>;
async function closeApp(app: App): Promise<void> {
  try { await app.runtime.close(); } finally { try { await app.management.shutdown(); } finally { try { await app.providers.shutdown(); } finally { app.store.close(); } } }
}
async function settle(app: App, id: SessionId, count: number): Promise<PublicRun> {
  const deadline = Date.now() + 6 * 60 * 1000;
  for (;;) {
    const state = oldShape(app.runtime, id), run = state.runs.at(-1);
    if (run !== undefined && state.runs.length === count && TERMINAL.has(run.status)) { await app.runtime.wait(id); return oldShape(app.runtime, id).runs.at(-1)!; }
    if (app.runtime.permissionRequests(id).length) throw new Error("a configuration turn asked for an approval");
    if (Date.now() > deadline) throw new Error("configuration turn did not settle in time");
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

test("installed Harness keeps a setting its own command changed, until an explicit switch applies the selection", { timeout: 20 * 60 * 1000 }, async () => {
  assert.ok(harnesses.length, "set HH_REAL_HARNESSES"); assert.ok(evidencePath, "set HH_REAL_EVIDENCE"); guardTargets(harnesses);
  assert.ok(option && from && to && command && from !== to, "set HH_REAL_CONFIG_OPTION, HH_REAL_CONFIG_FROM, HH_REAL_CONFIG_TO and HH_REAL_CONFIG_COMMAND");
  const root = await realpath(await mkdtemp(join(process.env.HH_REAL_TMP ?? tmpdir(), "hh-native-config-")));
  const results: Record<string, unknown>[] = [], failures: string[] = [];
  let header: EvidenceHeader | null = null;
  try {
    for (const harnessId of harnesses) {
      const before = await snapshot([harnessId], environment);
      const data = join(root, harnessId + "-data"), workspace = join(root, harnessId + "-workspace");
      await mkdir(workspace);
      const configuration = await prepareConfiguration({ workspace, ...(process.env.HH_REAL_MANIFEST ? { manifestPath: process.env.HH_REAL_MANIFEST } : {}) });
      const proof: Record<string, unknown> = { harnessId, option, from, to, startedAt: new Date().toISOString() };
      const app = application(data, () => {}, { installations: realInstallations, workspaceLockRoot: join(root, "locks") });
      try {
        header ??= await evidenceHeader(app, harnesses, { configuration });
        const requested = process.env["HH_REAL_MODEL_" + harnessId.toUpperCase()];
        const byModel = option === "model", selection = byModel ? { harnessId, nativeModel: from } : { harnessId, ...(requested === undefined ? {} : { nativeModel: requested }), nativeOptions: { [option]: from } };
        const session = await app.runtime.create(configuration, selection, "create-" + randomUUID());
        const observed = () => { const reported = oldShape(app.runtime, session.id).nativeBindings?.find(binding => binding.status === "ready")?.observed; return (byModel ? reported?.model : reported?.options[option]) ?? null; };
        const turn = async (text: string) => { const count = oldShape(app.runtime, session.id).runs.length + 1; app.runtime.send(session.id, text, "send-" + randomUUID()); const run = await settle(app, session.id, count); return { status: run.status, error: run.error?.code ?? null, observed: observed() }; };
        const ask = "只回复“好的”，不要调用任何工具。";
        proof.first = await turn(ask);
        proof.command = await turn(command);
        proof.next = await turn(ask);
        const carried = app.store.events(session.id, 0, 100).filter(row => row.type === "native.config_carried").map(row => { const data = row.data as { model?: string; options?: Record<string, string> }; return (byModel ? data.model : data.options?.[option]) ?? null; });
        proof.carried = carried;
        app.runtime.switch(session.id, selection, "reassert-" + randomUUID()); await app.runtime.wait(session.id);
        proof.epoch = oldShape(app.runtime, session.id).epoch;
        proof.afterSwitch = await turn(ask);
        const steps = proof as { first: { status: string; observed: string | null }; command: { status: string; observed: string | null }; next: { status: string; observed: string | null }; afterSwitch: { status: string; observed: string | null } };
        if ([steps.first, steps.command, steps.next, steps.afterSwitch].some(step => step.status !== "completed")) failures.push(harnessId + ": a turn did not complete");
        if (steps.first.observed !== from) failures.push(harnessId + ": the selection was not applied first");
        if (steps.command.observed !== to) failures.push(harnessId + ": the native command did not change the setting");
        if (steps.next.observed !== to || !carried.includes(to)) failures.push(harnessId + ": the next turn reverted the native change");
        if (steps.afterSwitch.observed !== from) failures.push(harnessId + ": the explicit switch did not apply the selection");
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
  assert.deepEqual(failures, [], "native configuration sync acceptance failed");
});
