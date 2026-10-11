import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { application } from "../../src/cli/session-application.js";
import type { PublicRun } from "../../src/contracts/session.js";
import { prepareConfiguration } from "../../src/infrastructure/session/binding-factory.js";

/**
 * Original-installation acceptance of native extensions: the listing comes from the installed Harness, and a skill defined
 * only in the test workspace (never in the user's own skill folders) is invoked through its command. Evidence keeps counts
 * and status tallies, never skill bodies, server names or plugin details of the user's installation.
 */
const harnesses = (process.env.HH_REAL_HARNESSES ?? "").split(",").map(value => value.trim()).filter(Boolean);
const evidencePath = process.env.HH_REAL_EVIDENCE;
const home = process.env.HOME ?? homedir();
const configFiles: Readonly<Record<string, readonly string[]>> = {
  codex: [join(home, ".codex", "config.toml")],
  claude: [join(home, ".claude", "settings.json")],
  pi: [join(home, ".pi", "agent", "settings.json"), join(home, ".pi", "agent", "models.json")],
  opencode: [join(home, ".config", "opencode", "opencode.json")],
  openclaw: [join(home, ".openclaw", "openclaw.json")],
  hermes: [join(home, ".hermes", "config.yaml")],
  dsh: [join(home, ".dsh", "settings.yaml"), join(home, ".dsh", "profiles", "acp", "cordis.patch.yml")],
};
const TERMINAL = new Set<PublicRun["status"]>(["completed", "failed", "cancelled", "unknown"]);
const SKILL = "---\nname: hh-echo\ndescription: Replies with a fixed acceptance word.\n---\nWhen this skill is used, reply with exactly HH-SKILL-OK and nothing else. Do not run any tools.\n";
async function digest(path: string): Promise<string> {
  try { return createHash("sha256").update(await readFile(path)).digest("hex"); }
  catch (error) { if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return "missing"; throw error; }
}
function tally(values: readonly string[]): Record<string, number> { const result: Record<string, number> = {}; for (const value of values) result[value] = (result[value] ?? 0) + 1; return result; }
type App = ReturnType<typeof application>;
async function closeApp(app: App): Promise<void> {
  try { await app.runtime.close(); } finally { try { await app.management.shutdown(); } finally { try { await app.providers.shutdown(); } finally { app.store.close(); } } }
}

test("installed Harness lists its native extensions and runs a workspace skill through its command", { timeout: 15 * 60 * 1000 }, async () => {
  assert.ok(harnesses.length, "set HH_REAL_HARNESSES"); assert.ok(evidencePath, "set HH_REAL_EVIDENCE");
  const root = await realpath(await mkdtemp(join(process.env.HH_REAL_TMP ?? tmpdir(), "hh-native-extensions-")));
  const results: Record<string, unknown>[] = [], failures: string[] = [];
  try {
    for (const harnessId of harnesses) {
      const files = configFiles[harnessId] ?? [], before = await Promise.all(files.map(digest));
      const data = join(root, harnessId + "-data"), workspace = join(root, harnessId + "-workspace");
      await mkdir(join(workspace, ".agents", "skills", "hh-echo"), { recursive: true });
      await writeFile(join(workspace, ".agents", "skills", "hh-echo", "SKILL.md"), SKILL);
      const configuration = await prepareConfiguration({ workspace, ...(process.env.HH_REAL_MANIFEST ? { manifestPath: process.env.HH_REAL_MANIFEST } : {}) });
      const proof: Record<string, unknown> = { harnessId, startedAt: new Date().toISOString() };
      const app = application(data, () => {}, { workspaceLockRoot: join(root, "locks") });
      try {
        const extensions = await app.factory.discoverExtensions({ harnessId }, configuration, new AbortController().signal);
        const local = extensions?.skills.find(skill => skill.name === "hh-echo");
        proof.extensions = extensions === null ? null : { skills: extensions.skills.length, enabledSkills: extensions.skills.filter(skill => skill.enabled).length, scopes: tally(extensions.skills.map(skill => skill.scope ?? "none")),
          mcpServers: extensions.mcpServers.length, mcpStatus: tally(extensions.mcpServers.map(server => server.failed ? "failed" : server.status)), plugins: extensions.plugins.length, truncated: extensions.truncated ?? false,
          workspaceSkill: local ? { scope: local.scope ?? null, command: local.command ?? null } : null };
        if (extensions !== null && local?.command) {
          const requested = process.env["HH_REAL_MODEL_" + harnessId.toUpperCase()];
          const session = await app.runtime.create(configuration, { harnessId, ...(requested === undefined ? {} : { nativeModel: requested }) }, "create-" + randomUUID());
          app.runtime.send(session.id, "/" + local.command + " 请按技能说明回复。", "skill-" + randomUUID());
          const deadline = Date.now() + 6 * 60 * 1000;
          while (!TERMINAL.has(app.runtime.read(session.id).runs.at(-1)!.status)) {
            if (Date.now() > deadline) throw new Error("skill turn did not settle in time");
            if (app.runtime.permissionRequests(session.id).length) throw new Error("the skill turn asked for an approval");
            await new Promise(resolve => setTimeout(resolve, 200));
          }
          await app.runtime.wait(session.id);
          const run = app.runtime.read(session.id).runs.at(-1)!, reply = app.runtime.read(session.id).messages.find(row => row.id === run.assistantMessageId)?.text ?? "";
          const events = app.store.events(session.id, 0, 100).filter(row => row.type === "run.native_command").length;
          proof.skillTurn = { status: run.status, matched: reply.includes("HH-SKILL-OK"), nativeCommand: events > 0, reply: reply.slice(0, 120) };
          if (run.status !== "completed" || !reply.includes("HH-SKILL-OK")) failures.push(harnessId + ": workspace skill");
        }
        // A Harness that loads project skills only from trusted projects (Pi) does not list one in a new workspace; that is recorded, not invented.
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
  assert.deepEqual(failures, [], "native extension acceptance failed");
});
