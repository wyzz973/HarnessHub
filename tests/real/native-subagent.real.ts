import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { application } from "../../src/cli/session-application.js";
import type { PermissionRequest, PublicRun, SessionId } from "../../src/contracts/session.js";
import { prepareConfiguration } from "../../src/infrastructure/session/binding-factory.js";

/**
 * Original-installation acceptance of sub-agent activity: the installed Harness delegates a command to its own sub-agent,
 * and the Hub must commit the sub-agent call and the tools it ran, linked to that call, without the sub-agent's work
 * becoming the main reply. Evidence keeps tool names, links and statuses, never tool output.
 */
const harnesses = (process.env.HH_REAL_HARNESSES ?? "").split(",").map(value => value.trim()).filter(Boolean);
const evidencePath = process.env.HH_REAL_EVIDENCE;
const home = process.env.HOME ?? homedir();
const configFiles: Readonly<Record<string, readonly string[]>> = {
  claude: [join(home, ".claude", "settings.json")],
  codex: [join(home, ".codex", "config.toml")],
  opencode: [join(home, ".config", "opencode", "opencode.json")],
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
/** A one-time allow inside the test workspace, never a standing rule. */
function allowOnce(request: PermissionRequest): string | null {
  return request.options.find(option => /^(allow|accept|approve|once|yes|proceed)/iu.test(option.id) && !/\b(always|session|forever|remember)\b/iu.test(option.id + " " + option.name))?.id ?? null;
}
async function settle(app: App, id: SessionId, deadline: number): Promise<PublicRun> {
  for (;;) {
    for (const request of app.runtime.permissionRequests(id).filter(item => !item.decided)) {
      const option = allowOnce(request); if (option === null) throw new Error("no one-time allow option");
      await app.runtime.decidePermission(id, request.id, option, "allow-" + randomUUID());
    }
    const run = app.runtime.read(id).runs.at(-1)!;
    if (TERMINAL.has(run.status)) { await app.runtime.wait(id); return app.runtime.read(id).runs.at(-1)!; }
    if (Date.now() > deadline) throw new Error("sub-agent turn did not settle in time");
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

test("installed Harness delegates to its own sub-agent and the Hub links the sub-agent's tools to that call", { timeout: 15 * 60 * 1000 }, async () => {
  assert.ok(harnesses.length, "set HH_REAL_HARNESSES"); assert.ok(evidencePath, "set HH_REAL_EVIDENCE");
  const root = await realpath(await mkdtemp(join(tmpdir(), "hh-native-subagent-")));
  const results: Record<string, unknown>[] = [], failures: string[] = [];
  try {
    for (const harnessId of harnesses) {
      const files = configFiles[harnessId] ?? [], before = await Promise.all(files.map(digest));
      const data = join(root, harnessId + "-data"), workspace = join(root, harnessId + "-workspace");
      await mkdir(workspace);
      const configuration = await prepareConfiguration({ workspace });
      const proof: Record<string, unknown> = { harnessId, startedAt: new Date().toISOString() };
      const app = application(data, () => {});
      try {
        const requested = process.env["HH_REAL_MODEL_" + harnessId.toUpperCase()], tag = "SUB-" + randomUUID().slice(0, 6).toUpperCase();
        const session = await app.runtime.create(configuration, { harnessId, ...(requested === undefined ? {} : { nativeModel: requested }) }, "create-" + randomUUID());
        app.runtime.send(session.id, "请用你的子代理工具（例如 Task/Agent）启动一个子代理，让它在当前目录用命令行运行 `echo " + tag + "` 并把输出报告给你。然后你只回复一句：主代理收到。", "send-" + randomUUID());
        const run = await settle(app, session.id, Date.now() + 8 * 60 * 1000), state = app.runtime.read(session.id);
        const reply = state.messages.find(row => row.id === run.assistantMessageId)?.text ?? "", tools = run.tools ?? [];
        const ids = new Set(tools.map(tool => tool.id)), children = tools.filter(tool => tool.parentId !== undefined && ids.has(tool.parentId));
        const parents = [...new Set(children.map(tool => tool.parentId!))].map(id => tools.find(tool => tool.id === id)!);
        proof.run = { status: run.status, error: run.error, cleanup: run.cleanup?.closed ?? null, replyBytes: Buffer.byteLength(reply), replyHasTag: reply.includes(tag) };
        proof.tools = tools.map(tool => ({ name: tool.name ?? null, kind: tool.kind ?? null, status: tool.status, linked: tool.parentId !== undefined && ids.has(tool.parentId), parentOf: children.filter(child => child.parentId === tool.id).length }));
        const checks = { completed: run.status === "completed", subAgentCall: parents.length > 0, linkedTools: children.length > 0, settled: tools.every(tool => !["pending", "in_progress", "running"].includes(tool.status)), cleanup: run.cleanup?.closed === true };
        proof.checks = checks;
        for (const [name, passed] of Object.entries(checks)) if (!passed) failures.push(harnessId + ": " + name);
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
  assert.deepEqual(failures, [], "native sub-agent acceptance failed");
});
