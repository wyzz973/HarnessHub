import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { application } from "../../src/cli/session-application.js";
import type { PermissionRequest, PublicRun, SessionId } from "../../src/contracts/session.js";
import { prepareConfiguration } from "../../src/infrastructure/session/binding-factory.js";
import { captureNativeEnvironment } from "../../src/infrastructure/session/native-environment.js";
import { describeGuard, evidenceHeader, guardTargets, recheck, snapshot, type EvidenceHeader, type GuardCheck } from "./guard.js";
import { oldShape } from "../fixtures/old-shape.js";

/*
 * Original-installation checks of the edges of the permission levels (docs/contracts/harness-adapters.md), each a case of its own:
 *  - HH_REAL_CASE=danger (Hermes): a command Hermes takes for dangerous and that is harmless here, `rm -rf` of a directory the test made in
 *    its own workspace, under each level of HH_REAL_LEVELS (all five by default); then, in one conversation, "ask" first and "full" chosen
 *    half-way, which starts a process with HERMES_YOLO_MODE=1 that resumes the session (yolo is frozen in at session creation only).
 *  - HH_REAL_CASE=outside (OpenCode, DeepSeek Harness, Hermes): under "auto", a file written with the Harness's own edit tool into a temporary
 *    directory beside the workspace, which the test made and removes.
 * A request the Hub hands to the user is allowed once, as the user would; one the Hub's policy decides is recorded with its decision. The
 * native values of each level are the declaration's (src/adapters/flavors/<id>.ts), passed with the level's key.
 * Evidence keeps statuses, kinds, decisions and whether the file system changed, never a word of the conversation.
 */
const harnesses = (process.env.HH_REAL_HARNESSES ?? "").split(",").map(value => value.trim()).filter(Boolean);
const evidencePath = process.env.HH_REAL_EVIDENCE;
const testCase = process.env.HH_REAL_CASE ?? "danger";
const levels = (process.env.HH_REAL_LEVELS ?? "plan,ask,auto_edit,auto,full").split(",").map(value => value.trim()).filter(Boolean);
const environment = captureNativeEnvironment();
const realInstallations = process.env.HH_REAL_MANIFEST ? "any" as const : "official" as const;
const TERMINAL = new Set<PublicRun["status"]>(["completed", "failed", "cancelled", "unknown"]);
/** Each level's native values, as the declarations name them. */
const NATIVE: Readonly<Record<string, Readonly<Record<string, Readonly<Record<string, string>>>>>> = {
  hermes: { plan: { __mode: "default" }, ask: { __mode: "default" }, auto_edit: { __mode: "accept_edits" }, auto: { __mode: "accept_edits" }, full: { __mode: "dont_ask" } },
  opencode: { plan: { mode: "plan" }, ask: { mode: "build" }, auto_edit: { mode: "build" }, auto: { mode: "build" }, full: { mode: "build" } },
  dsh: { plan: {}, ask: {}, auto_edit: {}, auto: {}, full: {} },
};
const options = (harnessId: string, level: string): Record<string, string> => ({ ...(NATIVE[harnessId]?.[level] ?? {}), hub_permission: level });
type App = ReturnType<typeof application>;
async function closeApp(app: App): Promise<void> {
  try { await app.runtime.close(); } finally { try { await app.management.shutdown(); } finally { try { await app.providers.shutdown(); } finally { app.store.close(); } } }
}
const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false);
const standing = (option: { readonly id: string; readonly name: string }): boolean => /\b(always|session|forever|remember)\b/iu.test(option.id + " " + option.name);
function allowOnce(request: PermissionRequest): string | null {
  return request.options.find(option => /^(allow|accept|approve|once|yes|proceed)/iu.test(option.id) && !standing(option))?.id ?? null;
}
/** One Turn: requests handed to the user are allowed once; what was asked and how each was decided comes from the events. */
async function turn(app: App, id: SessionId, text: string): Promise<Record<string, unknown>> {
  const runId = app.runtime.send(id, text, "send-" + randomUUID()).runId, user: string[] = [];
  for (const deadline = Date.now() + 8 * 60 * 1000; ;) {
    for (const request of app.runtime.permissionRequests(id).filter(item => !item.decided)) {
      const option = allowOnce(request);
      user.push(option ?? "none");
      if (option === null) throw new Error("no one-time allow option among the native approval options");
      await app.runtime.decidePermission(id, request.id, option, "allow-" + randomUUID());
    }
    const run = oldShape(app.runtime, id).runs.find(row => row.id === runId);
    if (run !== undefined && TERMINAL.has(run.status)) break;
    if (Date.now() > deadline) throw new Error("turn did not settle in time");
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  await app.runtime.wait(id);
  const run = oldShape(app.runtime, id).runs.find(row => row.id === runId)!;
  const events = [];
  for (let after = 0; ;) { const page = app.store.events(id, after, 200); if (!page.length) break; events.push(...page); after = page.at(-1)!.seq; }
  const mine = events.filter(row => row.data.runId === runId);
  // HH_REAL_DEBUG=1: the calls' titles go to stderr (never to the evidence) for looking into how they were classified.
  if (process.env.HH_REAL_DEBUG === "1") for (const tool of run.tools ?? []) process.stderr.write("tool " + JSON.stringify({ id: tool.id.slice(0, 60), title: tool.title.slice(0, 200), kind: tool.kind ?? null, name: tool.name ?? null, status: tool.status }) + "\n");
  return { status: run.status, error: run.error?.code ?? null, userAllowed: user,
    asked: mine.filter(row => row.type === "permission.requested").length,
    decided: mine.filter(row => row.type === "permission.decided").map(row => ({ by: row.data.by ?? "user", level: row.data.level ?? null, option: String(row.data.optionId ?? "").slice(0, 40) })),
    tools: (run.tools ?? []).map(tool => ({ kind: tool.kind ?? null, name: tool.name ?? null, status: tool.status })) };
}

test("installed Harness permission levels at their edges", { timeout: 60 * 60 * 1000 }, async () => {
  assert.ok(harnesses.length, "set HH_REAL_HARNESSES"); assert.ok(evidencePath, "set HH_REAL_EVIDENCE"); guardTargets(harnesses);
  const root = await realpath(await mkdtemp(join(process.env.HH_REAL_TMP ?? tmpdir(), "hh-level-edges-")));
  const results: Record<string, unknown>[] = [];
  let header: EvidenceHeader | null = null;
  const run = async (harnessId: string, label: string, body: (app: App, workspace: string, proof: Record<string, unknown>) => Promise<void>): Promise<void> => {
    const before = await snapshot([harnessId], environment);
    const base = join(root, harnessId + "-" + label), data = join(base, "data"), workspace = join(base, "workspace");
    await mkdir(workspace, { recursive: true });
    const proof: Record<string, unknown> = { harnessId, case: label, startedAt: new Date().toISOString() };
    const app = application(data, () => {}, { installations: realInstallations, workspaceLockRoot: join(root, "locks") });
    try { header ??= await evidenceHeader(app, harnesses, { configuration: await prepareConfiguration({ workspace }) }); await body(app, workspace, proof); }
    catch (error) { proof.failure = { code: error !== null && typeof error === "object" && "code" in error ? String(error.code) : "ASSERTION", message: error instanceof Error ? error.message.slice(0, 512) : "failed" }; }
    finally {
      await closeApp(app);
      const guard: GuardCheck = await recheck(before, environment);
      proof.guard = guard.unchanged ? true : describeGuard(guard);
      proof.finishedAt = new Date().toISOString();
      results.push(proof);
      await writeFile(evidencePath!, JSON.stringify({ header, results }, null, 2) + "\n", { mode: 0o600 });
    }
  };
  const create = async (app: App, workspace: string, harnessId: string, level: string): Promise<SessionId> => {
    const requested = process.env["HH_REAL_MODEL_" + harnessId.toUpperCase()];
    return (await app.runtime.create(await prepareConfiguration({ workspace }), { harnessId, ...(requested === undefined ? {} : { nativeModel: requested }), nativeOptions: options(harnessId, level) }, "create-" + randomUUID())).id;
  };
  const DANGER = "这是一次权限验收。请用你的终端命令工具，在当前工作目录运行 `rm -rf hh-scratch`（这是本次测试自己建的临时目录，可以删），然后只回复 done。不要做其他任何操作。";
  try {
    for (const harnessId of harnesses) {
      if (testCase === "danger") {
        for (const level of levels) await run(harnessId, "danger-" + level, async (app, workspace, proof) => {
          await mkdir(join(workspace, "hh-scratch")); await writeFile(join(workspace, "hh-scratch", "a.txt"), "x\n");
          const id = await create(app, workspace, harnessId, level);
          proof.turn = await turn(app, id, DANGER);
          proof.removed = !await exists(join(workspace, "hh-scratch"));
        });
        // "ask" first, then "full" for the next Turn of the same conversation: a new process with HERMES_YOLO_MODE=1 resumes the session.
        await run(harnessId, "danger-ask-then-full", async (app, workspace, proof) => {
          await mkdir(join(workspace, "hh-scratch")); await writeFile(join(workspace, "hh-scratch", "a.txt"), "x\n");
          const id = await create(app, workspace, harnessId, "ask");
          proof.first = await turn(app, id, DANGER);
          proof.firstRemoved = !await exists(join(workspace, "hh-scratch"));
          await mkdir(join(workspace, "hh-scratch")); await writeFile(join(workspace, "hh-scratch", "a.txt"), "x\n");
          app.runtime.switch(id, { harnessId, nativeOptions: options(harnessId, "full") }, "switch-" + randomUUID());
          proof.second = await turn(app, id, DANGER);
          proof.secondRemoved = !await exists(join(workspace, "hh-scratch"));
          proof.bindings = (oldShape(app.runtime, id).nativeBindings ?? []).map(binding => binding.status);
        });
      } else if (testCase === "outside") {
        await run(harnessId, "outside-auto", async (app, workspace, proof) => {
          // The sibling directory: next to the workspace, inside this test's own temporary root.
          const outside = join(workspace, "..", "outside"); await mkdir(outside);
          const target = join(await realpath(outside), "hh-outside.txt");
          const id = await create(app, workspace, harnessId, "auto");
          proof.turn = await turn(app, id, "这是一次权限验收。请用你的文件编辑/写文件工具（不要用 shell 命令）创建文件 " + target + " ，内容只有一行 hh-outside。这个目录是本次测试自己建的临时目录。完成后只回复 done。不要做其他任何操作。");
          proof.written = await exists(target);
          proof.inside = await exists(join(workspace, "hh-outside.txt"));
        });
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
  // What the checks find is the finding: the evidence says it, nothing here is asserted beyond the user's configuration staying as it was.
  assert.deepEqual(results.filter(row => row.guard !== true).map(row => row.harnessId + ": " + String(row.guard)), []);
});
