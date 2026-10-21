import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { application } from "../../src/cli/session-application.js";
import type { PermissionRequest, PublicRun, SessionId } from "../../src/contracts/session.js";
import { prepareConfiguration } from "../../src/infrastructure/session/binding-factory.js";
import { captureNativeEnvironment } from "../../src/infrastructure/session/native-environment.js";
import { describeGuard, evidenceHeader, guardTargets, recheck, snapshot, type EvidenceHeader, type GuardCheck } from "./guard.js";
/** A development manifest (HH_REAL_MANIFEST) names non-official entries, which only the development policy reads (ADR-044). */
const realInstallations = process.env.HH_REAL_MANIFEST ? "any" as const : "official" as const;

/**
 * Original-installation acceptance of native tool activity: the user's installed Harness runs a shell command and an edit
 * in a fresh workspace, and the Hub must commit the tool summaries and store readable details. The edited file is the
 * ground truth; the reply is not. Native approvals inside that workspace are answered once, as the user would.
 * Evidence keeps shapes and flags, never tool output, checkpoints or environment values.
 */
const harnesses = (process.env.HH_REAL_HARNESSES ?? "").split(",").map(value => value.trim()).filter(Boolean);
const evidencePath = process.env.HH_REAL_EVIDENCE;
/** The user's home and environment as the Harness runs with them; the shared guard (./guard.ts) snapshots its configuration from them. */
const environment = captureNativeEnvironment();
/** HH_REAL_APPROVAL=1: the workspace's own project configuration asks before edits and commands (never the user's global file). */
const approvalConfig: Readonly<Record<string, { readonly file: string; readonly text: string }>> = {
  opencode: { file: "opencode.json", text: JSON.stringify({ $schema: "https://opencode.ai/config.json", permission: { edit: "ask", bash: "ask" } }) + "\n" },
};
const askApproval = process.env.HH_REAL_APPROVAL === "1";
/** HH_REAL_PLAN=1: the turn must use the Harness's own plan tool, and the Hub must commit the plan. */
const askPlan = process.env.HH_REAL_PLAN === "1";
/** HH_REAL_READONLY=1: only a harmless echo through the Harness's command tool, for Harnesses whose tools act outside the test workspace (OpenClaw's agent workspace). */
const readOnly = process.env.HH_REAL_READONLY === "1";
const TERMINAL = new Set<PublicRun["status"]>(["completed", "failed", "cancelled", "unknown"]);
type App = ReturnType<typeof application>;
async function closeApp(app: App): Promise<void> {
  try { await app.runtime.close(); } finally { try { await app.management.shutdown(); } finally { try { await app.providers.shutdown(); } finally { app.store.close(); } } }
}
/** A one-time allow, never a standing rule: the approval must not outlive this workspace. */
function allowOnce(request: PermissionRequest): string | null {
  const choice = request.options.find(option => /^(allow|accept|approve|once|yes|proceed)/iu.test(option.id) && !/\b(always|session|forever|remember)\b/iu.test(option.id + " " + option.name));
  return choice?.id ?? null;
}
async function settle(app: App, id: SessionId, permissions: Record<string, unknown>[], deadline: number): Promise<PublicRun> {
  for (;;) {
    for (const request of app.runtime.permissionRequests(id).filter(item => !item.decided)) {
      const option = allowOnce(request);
      permissions.push({ title: request.title.slice(0, 160), detailLines: (request.detail ?? "").split("\n").filter(Boolean).length, detailHasDiff: (request.detail ?? "").includes("+delta"), options: request.options.map(item => item.id), chosen: option });
      if (option === null) throw new Error("no one-time allow option among the native approval options");
      await app.runtime.decidePermission(id, request.id, option, "allow-" + randomUUID());
    }
    const run = app.runtime.read(id).runs.at(-1)!;
    if (TERMINAL.has(run.status)) { await app.runtime.wait(id); return app.runtime.read(id).runs.at(-1)!; }
    if (Date.now() > deadline) throw new Error("native tool turn did not settle in time");
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

test("installed Harness tool activity is committed with stored, readable details", { timeout: 20 * 60 * 1000 }, async () => {
  assert.ok(harnesses.length, "set HH_REAL_HARNESSES to the installed Harness identities under acceptance");
  assert.ok(evidencePath, "set HH_REAL_EVIDENCE to an ignored evidence file path"); guardTargets(harnesses);
  const root = await realpath(await mkdtemp(join(process.env.HH_REAL_TMP ?? tmpdir(), "hh-native-activity-")));
  const results: Record<string, unknown>[] = [], failures: string[] = [];
  let header: EvidenceHeader | null = null;
  try {
    for (const harnessId of harnesses) {
      const before = await snapshot([harnessId], environment);
      const data = join(root, harnessId + "-data"), workspace = join(root, harnessId + "-workspace");
      await mkdir(workspace);
      await writeFile(join(workspace, "notes.txt"), "alpha\nbravo\ncharlie\n");
      // HH_REAL_OPTIONS_<ID>: session-level native settings (for example Codex approval_policy/sandbox) instead of a project file.
      const optionsText = process.env["HH_REAL_OPTIONS_" + harnessId.toUpperCase()], nativeOptions = optionsText === undefined ? undefined : JSON.parse(optionsText) as Record<string, string>;
      if (askApproval && nativeOptions === undefined) {
        const project = approvalConfig[harnessId];
        assert.ok(project, "no workspace-level approval configuration is known for " + harnessId);
        await writeFile(join(workspace, project.file), project.text);
      }
      const configuration = await prepareConfiguration({ workspace, ...(process.env.HH_REAL_MANIFEST ? { manifestPath: process.env.HH_REAL_MANIFEST } : {}) });
      const proof: Record<string, unknown> = { harnessId, startedAt: new Date().toISOString() };
      const permissions: Record<string, unknown>[] = [];
      proof.permissions = permissions;
      const app = application(data, () => {}, { installations: realInstallations, workspaceLockRoot: join(root, "locks") });
      try {
        header ??= await evidenceHeader(app, harnesses, { configuration });
        const requested = process.env["HH_REAL_MODEL_" + harnessId.toUpperCase()];
        const created = await app.runtime.create(configuration, { harnessId, ...(requested === undefined ? {} : { nativeModel: requested }), ...(nativeOptions === undefined ? {} : { nativeOptions }) }, "create-" + randomUUID());
        proof.nativeOptions = nativeOptions ?? null;
        if (readOnly) app.runtime.send(created.id, "这是一次只读的工具链路验收：用你的命令执行工具运行 `echo HH-TOOL-OK`，不要做其他任何操作，然后只回复命令输出。", "send-" + randomUUID());
        else app.runtime.send(created.id, "这是一次工具链路验收，只在当前工作目录内操作：\n1. 用命令行工具运行 `cat notes.txt`。\n2. 用你的文件编辑工具（不要用 shell 命令）把 notes.txt 里的 bravo 改成 delta。\n" + (askPlan ? "开始前必须先用你的计划/待办工具（例如 update_plan 或 TodoWrite）列出这两步，并在每步完成后更新状态。" : "如果你有计划或待办工具，先用它列出这两步。") + "完成后只回复 notes.txt 第二行的新内容。不要创建或修改其他文件。", "send-" + randomUUID());
        const run = await settle(app, created.id, permissions, Date.now() + 8 * 60 * 1000);
        const state = app.runtime.read(created.id), reply = state.messages.find(row => row.id === run.assistantMessageId)?.text ?? "";
        const edited = (await readFile(join(workspace, "notes.txt"), "utf8")).split("\n")[1] ?? "";
        const tools = run.tools ?? [];
        const details = await Promise.all(tools.filter(tool => tool.detail !== undefined).map(async tool => {
          const stored = app.content.read(tool.detail!.id), parsed = JSON.parse(await readFile(stored.path, "utf8")) as Record<string, unknown>;
          return { toolId: tool.id, kind: parsed.kind ?? null, name: parsed.name ?? null, input: typeof parsed.input === "string" && parsed.input.length > 0, output: typeof parsed.output === "string" && parsed.output.length > 0,
            diff: typeof parsed.diff === "string" && parsed.diff.includes("delta"), locations: Array.isArray(parsed.locations) ? parsed.locations.length : 0, exitCode: parsed.exitCode ?? null, truncated: parsed.truncated === true, bytes: stored.ref.bytes };
        }));
        proof.run = { status: run.status, error: run.error, cleanup: run.cleanup?.closed ?? null, selection: { controlId: run.selection.controlId, nativeModel: run.selection.nativeModel ?? null }, replyBytes: Buffer.byteLength(reply), replyHasDelta: reply.includes("delta"), replyPreview: reply.slice(0, 300) };
        proof.fileEdited = edited === "delta";
        proof.tools = tools.map(tool => ({ id: tool.id.slice(0, 80), title: tool.title.slice(0, 120), status: tool.status, kind: tool.kind ?? null, name: tool.name ?? null, exitCode: tool.exitCode ?? null, detail: tool.detail !== undefined }));
        proof.details = details;
        proof.plan = run.plan ? { entries: run.plan.entries.length, statuses: run.plan.entries.map(entry => entry.status) } : null;
        proof.usage = run.usage ? { turn: Object.keys(run.usage.turn ?? {}).sort(), context: run.usage.context ? { used: run.usage.context.used > 0, size: run.usage.context.size ?? null } : null, cost: run.usage.cost ? { scope: run.usage.cost.scope, currency: run.usage.cost.currency } : null } : null;
        proof.notices = (run.notices ?? []).map(notice => ({ severity: notice.severity, title: notice.title.slice(0, 120) }));
        proof.activities = (run.activities ?? []).map(activity => ({ kind: activity.kind, status: activity.status }));
        proof.outputs = (run.outputs ?? []).map(output => output.kind === "link" ? { kind: "link" } : { kind: output.content.kind, mediaType: output.content.mediaType, bytes: output.content.bytes });
        // The event log carries summaries; stored details are referenced, never inlined.
        const events = [];
        for (let after = 0; ;) { const page = app.store.events(created.id, after, 100); if (!page.length) break; events.push(...page); after = page.at(-1)!.seq; }
        const diagnostics = events.flatMap(row => { const value = row.data.event as { type?: string; message?: string } | undefined; return row.type === "run.output" && value?.type === "diagnostic" ? [String(value.message).slice(0, 200)] : []; });
        proof.events = { toolDetail: events.filter(row => row.type === "run.tool_detail").length, outputs: events.filter(row => row.type === "run.output").length, diagnostics };
        const checks = {
          completed: run.status === "completed",
          ...(readOnly ? { echoed: details.some(row => row.output) && reply.includes("HH-TOOL-OK") } : { fileEdited: edited === "delta" }),
          toolsCommitted: tools.length > 0 && tools.every(tool => !["pending", "in_progress", "inProgress", "running"].includes(tool.status)),
          detailsReadable: details.length > 0 && details.some(row => row.input || row.output),
          ...(readOnly ? {} : { editDiff: details.some(row => row.diff) }),
          cleanup: run.cleanup?.closed === true,
          ...(askApproval ? { approved: permissions.length > 0 && permissions.every(row => row.chosen !== null) } : {}),
          ...(askPlan ? { plan: (run.plan?.entries.length ?? 0) >= 2 } : {}),
        };
        proof.checks = checks;
        for (const [name, passed] of Object.entries(checks)) if (!passed) failures.push(harnessId + ": " + name);
      } catch (error) {
        // The last Run's own outcome explains a blocked Session (for example cleanup that could not be confirmed).
        try { const last = app.runtime.read([...app.store.list(10)][0]!.id).runs.at(-1); if (last) proof.lastRun = { status: last.status, error: last.error, cleanup: last.cleanup ?? null }; } catch { /* the Session itself may be unreadable */ }
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
  assert.deepEqual(failures, [], "native tool activity acceptance failed");
});
