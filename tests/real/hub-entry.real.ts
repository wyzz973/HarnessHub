import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { application } from "../../src/cli/session-application.js";
import type { PermissionRequest, PublicRun, SessionId } from "../../src/contracts/session.js";
import type { TableGrants } from "../../src/contracts/table.js";
import { isHubToolCall } from "../../src/contexts/session/domain/protocol/tools.js";
import { prepareConfiguration } from "../../src/infrastructure/session/binding-factory.js";
import { captureNativeEnvironment } from "../../src/infrastructure/session/native-environment.js";
import { MemoryTableGrants } from "../../src/infrastructure/session/table-grants.js";
import { TableMount } from "../../src/infrastructure/table/mount.js";
import { startWebServer } from "../../src/web/server.js";
import { oldShape } from "../fixtures/old-shape.js";
import { describeGuard, evidenceHeader, guardTargets, recheck, snapshot, type EvidenceHeader, type GuardCheck } from "./guard.js";

/**
 * The Hub's tools and session instructions on the user's installed Harnesses (flavors/<id>.ts capabilities sessionMcp, systemPrompt): a
 * real Hub (its web server on a free port, its table mounted, its own data in a temporary directory) runs two Turns of one conversation
 * in a fresh workspace. The first is a three-step task that does not name the tools: did the model show a task list (hub_update_plan) and
 * wrap the turn up (hub_wrap_up) on its own? The second asks for the first Turn back: did it read the conversation (a read of the table)?
 * The ground truth is what reached the Hub (the table's token reads and the progress the Runtime took), not the reply. The user's
 * configuration is snapshotted before and compared after. Evidence keeps kinds, counts and statuses, never the conversation's words.
 *
 * HH_REAL_HARNESSES=<ids>, HH_REAL_EVIDENCE=<file>, HH_REAL_MODEL_<ID>=<model>, HH_REAL_LEVEL_<ID>=<level> (default "auto"),
 * HH_REAL_READONLY=1 for a Harness whose tools act outside the workspace (OpenClaw: echo only, and no second Turn).
 */
const harnesses = (process.env.HH_REAL_HARNESSES ?? "").split(",").map(value => value.trim()).filter(Boolean);
const evidencePath = process.env.HH_REAL_EVIDENCE, readOnly = process.env.HH_REAL_READONLY === "1";
const environment = captureNativeEnvironment();
const TERMINAL = new Set<PublicRun["status"]>(["completed", "failed", "cancelled", "unknown"]);

/** Token reads counted per resolve: every call of the Hub's tool program asks the table once (TableApi resolves its bearer token). */
class CountingGrants extends MemoryTableGrants implements TableGrants {
  resolves = 0;
  override resolve(token: string) { this.resolves++; return super.resolve(token); }
}
/** A one-time allow, never a standing rule. */
function allowOnce(request: PermissionRequest): string | null {
  return request.options.find(option => /^(allow|accept|approve|once|yes|proceed)/iu.test(option.id) && !/\b(always|session|forever|remember)\b/iu.test(option.id + " " + option.name))?.id ?? null;
}
type App = ReturnType<typeof application>;
async function settle(app: App, id: SessionId, asked: Record<string, unknown>[], deadline: number): Promise<PublicRun> {
  for (;;) {
    for (const request of app.runtime.permissionRequests(id).filter(item => !item.decided)) {
      const option = allowOnce(request);
      asked.push({ hubTool: isHubToolCall({ title: request.title }), options: request.options.length, chosen: option !== null });
      if (option === null) throw new Error("no one-time allow option among the native approval options");
      await app.runtime.decidePermission(id, request.id, option, "allow-" + randomUUID());
    }
    const run = oldShape(app.runtime, id).runs.at(-1)!;
    if (TERMINAL.has(run.status)) { await app.runtime.wait(id); return oldShape(app.runtime, id).runs.at(-1)!; }
    if (Date.now() > deadline) throw new Error("the turn did not settle in time");
    await new Promise(resolve => setTimeout(resolve, 300));
  }
}

const TASK = "这是一次三步小任务，只在当前工作目录内操作：\n1. 用命令行运行 `ls`。\n2. 读出 notes.txt 的内容。\n3. 新建 count.txt，只写入 notes.txt 的行数（一个数字）。\n做完后用一句话告诉我结果。";
const TASK_READONLY = "这是一次只读的三步小任务：\n1. 用命令执行工具运行 `echo HH-A`。\n2. 再运行 `echo HH-B`。\n3. 再运行 `echo HH-C`。\n不要做其他任何操作，最后只回复三次的输出。";
const RECALL = "不要凭记忆回答：先用 HarnessHub 的工具（hub_turns 或 hub_read_turn）读回这段对话的第 1 回合，再只回答第 1 回合里我让你做的第一步是什么。";

test("the Hub's tools and session instructions reach the installed Harness, which shows its task list, wraps up and reads the conversation back", { timeout: 40 * 60 * 1000 }, async () => {
  assert.ok(harnesses.length, "set HH_REAL_HARNESSES"); assert.ok(evidencePath, "set HH_REAL_EVIDENCE"); guardTargets(harnesses);
  const root = await realpath(await mkdtemp(join(process.env.HH_REAL_TMP ?? tmpdir(), "hh-entry-")));
  const results: Record<string, unknown>[] = [], failures: string[] = [];
  let header: EvidenceHeader | null = null;
  try {
    for (const harnessId of harnesses) {
      const before = await snapshot([harnessId], environment);
      const data = join(root, harnessId + "-data"), workspace = join(root, harnessId + "-workspace"), locks = join(root, harnessId + "-locks");
      await mkdir(workspace); await mkdir(locks, { mode: 0o700 });
      await writeFile(join(workspace, "notes.txt"), "alpha\nbravo\ncharlie\n");
      const grants = new CountingGrants(), table = new TableMount(grants);
      const proof: Record<string, unknown> = { harnessId, startedAt: new Date().toISOString() };
      const progress = { plan: 0, recap: 0, refused: 0 };
      let app: App | undefined, server: Awaited<ReturnType<typeof startWebServer>> | undefined;
      try {
        const configuration = await prepareConfiguration({ workspace });
        server = await startWebServer({ root: data, configuration, port: 0, workspaceLockRoot: locks, installations: "official", table, tableGrants: grants,
          application: (dataRoot, publish) => {
            const made = application(dataRoot, publish, { installations: "official", workspaceLockRoot: locks, table, tableGrants: grants });
            // What the Hub's tool program told the Runtime (the task list, the wrap-up), counted as it arrives.
            const take = made.runtime.hubProgress.bind(made.runtime);
            made.runtime.hubProgress = (id, from, value) => { try { take(id, from, value); progress[value.kind]++; } catch (error) { progress.refused++; throw error; } };
            app = made;
            return made;
          } });
        header ??= await evidenceHeader(app!, harnesses, { configuration });
        const model = process.env["HH_REAL_MODEL_" + harnessId.toUpperCase()], level = process.env["HH_REAL_LEVEL_" + harnessId.toUpperCase()] ?? "auto";
        const created = await app!.runtime.create(configuration, { harnessId, ...(model === undefined ? {} : { nativeModel: model }), nativeOptions: { hub_permission: level } }, "create-" + randomUUID());
        proof.level = level;
        const turn = async (words: string) => {
          const reads = grants.resolves, plans = progress.plan, recaps = progress.recap, asked: Record<string, unknown>[] = [];
          app!.runtime.send(created.id, words, "send-" + randomUUID());
          const run = await settle(app!, created.id, asked, Date.now() + 10 * 60 * 1000);
          const tools = run.tools ?? [];
          const hubCalls = tools.filter(tool => isHubToolCall({ title: tool.title, ...(tool.name === undefined ? {} : { name: tool.name }) }));
          const plan = progress.plan - plans, recap = progress.recap - recaps;
          return { status: run.status, error: run.error?.code ?? null, tools: tools.length, kinds: tools.map(tool => tool.name ?? tool.kind ?? null),
            // The identifier a title starts with (a tool name, never the words after it).
            names: tools.map(tool => /^[A-Za-z][A-Za-z0-9_.-]{0,64}/u.exec(tool.title)?.[0] ?? null), hubCalls: hubCalls.map(tool => ({ status: tool.status })), asked,
            // Reads of the conversation: every request of the tool program resolves the token once; the progress ones are counted apart.
            plan, recap, reads: grants.resolves - reads - plan - recap, planEntries: run.plan?.entries.length ?? 0, cleanup: run.cleanup?.closed ?? null };
        };
        const first = await turn(readOnly ? TASK_READONLY : TASK);
        proof.first = first;
        const binding = { hubToolsSeen: first.hubCalls.length > 0 || first.plan + first.recap > 0 };
        proof.binding = binding;
        const second = readOnly ? null : await turn(RECALL);
        proof.second = second;
        proof.progressRefused = progress.refused;
        const checks = readOnly
          ? { completed: first.status === "completed" }
          : { completed: first.status === "completed" && second!.status === "completed", plan: first.plan > 0, wrapUp: first.recap > 0, readBack: second!.reads > 0 };
        proof.checks = checks;
        for (const [name, passed] of Object.entries(checks)) if (!passed) failures.push(harnessId + ": " + name);
      } catch (error) {
        proof.failure = { code: error !== null && typeof error === "object" && "code" in error ? String(error.code) : "ASSERTION", message: error instanceof Error ? error.message.slice(0, 300) : "failed" };
        failures.push(harnessId + ": " + (proof.failure as { code: string }).code);
      } finally {
        if (server !== undefined) await server.close();
        const guard: GuardCheck = await recheck(before, environment);
        proof.guard = guard;
        if (!guard.unchanged) failures.push(harnessId + ": " + describeGuard(guard));
        proof.finishedAt = new Date().toISOString();
        results.push(proof);
        await writeFile(evidencePath, JSON.stringify({ header, results }, null, 2) + "\n", { mode: 0o600 });
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
  assert.deepEqual(failures, [], "the Hub's tools and instructions acceptance failed");
});
