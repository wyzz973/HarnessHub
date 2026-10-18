import assert from "node:assert/strict";
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CapabilityChangeCheck, CapabilityChangeView, CapabilityHistory, CapabilityRestoreCheck, InstructionsView } from "../../src/contracts/capabilities.js";
import { application } from "../../src/cli/session-application.js";
import { bodySha } from "../../src/infrastructure/capabilities/instruction-blocks.js";
import { CapabilityStore } from "../../src/infrastructure/capabilities/store.js";
import { prepareConfiguration } from "../../src/infrastructure/session/binding-factory.js";
import { startWebServer } from "../../src/web/server.js";
import { homePathsIn } from "../../src/web/shown-paths.js";
import { capabilityHome, CREDENTIALS, officialInstalls } from "../fixtures/capability-home.js";

/** A Gateway on a private home with the official installations' fixture files, through its formal entry; `without` leaves those Harnesses uninstalled. */
async function gateway(t: test.TestContext, without: readonly string[] = []) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "instructions-"))), closers: (() => Promise<void>)[] = [];
  t.after(async () => { for (const close of closers.reverse()) await close(); await rm(root, { recursive: true, force: true }); });
  const home = join(root, "home"), workspace = join(root, "workspace");
  await mkdir(home); await mkdir(workspace); await capabilityHome(home, join(root, "elsewhere"));
  const path = await officialInstalls(home);
  for (const command of without) await rm(join(home, ".nvm", "versions", "node", "v26.0.0", "bin", command));
  const environment = { home, values: { HOME: home, PATH: [...path, "/usr/bin", "/bin"].join(":") } };
  const server = await startWebServer({ root: join(root, "data"), configuration: await prepareConfiguration({ workspace, pathOnly: true }), port: 0,
    application: (data, publish) => application(data, publish, { nativeEnvironment: environment, installations: "official", management: { installationMode: "private-fixture" }, workspaceLockRoot: join(root, "locks") }) });
  closers.push(() => server.close());
  const url = new URL(server.url), origin = url.origin;
  const boot = await fetch(origin + "/api/v1/auth/bootstrap", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ token: new URLSearchParams(url.hash.slice(1)).get("token") }) });
  const csrf = (await boot.json() as { csrfToken: string }).csrfToken, cookie = boot.headers.get("set-cookie")!.split(";", 1)[0]!;
  const answers: unknown[] = [];
  const call = async <T>(path: string, body?: unknown): Promise<{ status: number; value: T }> => {
    const response = await fetch(origin + "/api/v1" + path, { method: body === undefined ? "GET" : "POST", headers: { Cookie: cookie, Origin: origin, ...(body === undefined ? {} : { "Content-Type": "application/json", "X-CSRF-Token": csrf }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json() as T; answers.push(value);
    return { status: response.status, value };
  };
  const view = async () => (await call<InstructionsView>("/capabilities/instructions")).value;
  const save = (shared: string, additions: Record<string, string> = {}) => call<InstructionsView & { message: string }>("/capabilities/instructions", { shared, additions });
  const check = (action: "sync" | "remove", harnessId: string, options: readonly string[] = []) => call<CapabilityChangeCheck>("/capabilities/instructions/" + action + "?" + new URLSearchParams({ harnessId, ...(options.length ? { options: options.join(",") } : {}) }));
  const apply = async (checked: { status: number; value: CapabilityChangeCheck }, commandId = "instructions-" + Math.random().toString(16).slice(2)) => {
    assert.equal(checked.status, 200, JSON.stringify(checked.value)); assert.equal(checked.value.blocked, null, checked.value.blocked ?? "");
    const applied = await call<CapabilityChangeView>("/capabilities/changes", { fingerprint: checked.value.fingerprint, commandId });
    assert.equal(applied.value.status, "applied", JSON.stringify(applied.value));
    return applied.value;
  };
  const history = async () => (await call<CapabilityHistory>("/capabilities/history")).value;
  const clean = async () => {
    const text = JSON.stringify(answers);
    for (const secret of CREDENTIALS) assert.equal(text.includes(secret), false, secret);
    assert.deepEqual(homePathsIn(answers, [home], 1 << 20), []);
  };
  return { root, home, call, view, save, check, apply, history, clean };
}
const state = (view: InstructionsView, harnessId: string) => view.targets.find(target => target.harnessId === harnessId);
const block = (body: string, eol = "\n") => "<!-- harnesshub:begin id=instructions sha=" + bodySha(body) + " -->" + eol + body.split("\n").join(eol) + eol + "<!-- harnesshub:end id=instructions -->" + eol;
const mode = async (path: string) => ((await stat(path)).mode & 0o777).toString(8);

test("G064-I2 through the formal Gateway, the instructions are saved, written as a block into the file each Harness reads, brought up to date and removed back to the old bytes", { timeout: 180000 }, async t => {
  const f = await gateway(t), home = f.home, dshFile = join(home, ".dsh", "AGENTS.md"), override = join(home, ".codex", "AGENTS.override.md"), codexBase = join(home, ".codex", "AGENTS.md");
  // Where each Harness stands before anything is saved: the file it reads, or why HarnessHub writes none.
  let view = await f.view();
  assert.deepEqual(view.shared, { text: "", updatedAt: null });
  assert.deepEqual(Object.fromEntries(view.targets.map(target => [target.harnessId, [target.state, target.file]])), {
    claude: ["unreadable", "~/.claude/CLAUDE.md"], codex: ["absent", "~/.codex/AGENTS.override.md"], cursor: ["unsupported", null], opencode: ["absent", "~/.config/opencode/AGENTS.md"],
    gemini: ["absent", "~/.gemini/GEMINI.md"], openclaw: ["absent", "~/claw-ws/AGENTS.md"], pi: ["absent", "~/.pi/agent/AGENTS.md"], hermes: ["unsupported", null], dsh: ["absent", "~/.dsh/AGENTS.md"] });
  assert.match(state(view, "claude")?.reason ?? "", /无法识别的 HarnessHub 标记/u, "the fixture's old-style markers are not HarnessHub's block");
  assert.match(state(view, "hermes")?.reason ?? "", /SOUL\.md 是人格文件/u);
  assert.match(state(view, "cursor")?.reason ?? "", /应用设置里/u);
  assert.match(state(view, "opencode")?.cautions.join("") ?? "", /不再回退读 ~\/\.claude\/CLAUDE\.md/u);
  assert.match(state(view, "openclaw")?.effect ?? "", /不重启网关/u);
  // Which file each one reads: Codex skips a blank override; Gemini takes the first existing name `context.fileName` gives.
  await writeFile(override, "  \n");
  assert.equal(state(await f.view(), "codex")?.file, "~/.codex/AGENTS.md");
  await writeFile(override, "Override rules\n");
  await rm(join(home, ".gemini", "GEMINI.md"));
  assert.equal(state(await f.view(), "gemini")?.file, "~/.gemini/AGENTS.md");
  await writeFile(join(home, ".gemini", "GEMINI.md"), "Gemini rules\n");
  // Nothing to write until the texts are saved; texts with the home written out, a control character or HarnessHub's marker are refused.
  assert.match((await f.check("sync", "dsh")).value.blocked ?? "", /都是空的/u);
  for (const [text, reason] of [["Projects are in " + home + "/projects.", /写成 ~/u], ["bell\u0007", /控制字符/u], ["x <!-- harnesshub:end id=instructions --> y", /区块标记/u], ["half \uD83D", /代理项/u]] as const) {
    const refused = await f.save(text);
    assert.deepEqual([refused.status, reason.test(refused.value.message)], [400, true], text);
  }
  assert.equal((await f.save("Reply in Chinese.", { nobody: "x" })).status, 400);
  const saved = await f.save("Reply in Chinese.\r\nKeep commits small.", { dsh: "Use pnpm.", codex: "Codex only." });
  assert.equal(saved.status, 200, JSON.stringify(saved.value));
  assert.equal(saved.value.shared.text, "Reply in Chinese.\nKeep commits small.");
  assert.deepEqual(saved.value.additions.map(item => [item.harnessId, item.text]), [["codex", "Codex only."], ["dsh", "Use pnpm."]]);
  // DeepSeek Harness: the block goes after the user's own text, one empty line between; nothing else changes.
  const dshBody = "Reply in Chinese.\nKeep commits small.\n\nUse pnpm.", dshCheck = await f.check("sync", "dsh");
  assert.equal(dshCheck.value.current, "none");
  assert.match(dshCheck.value.notes[0] ?? "", /^只改 ~\/\.dsh\/AGENTS\.md 里带 HarnessHub 标记的区块.*不改任何模型、Provider 或登录配置/u);
  assert.match(dshCheck.value.diff ?? "", /^\+<!-- harnesshub:begin id=instructions sha=[0-9a-f]{12} -->$/mu);
  assert.ok(dshCheck.value.notes.some(note => /下一步就会收到更新/u.test(note)) && dshCheck.value.notes.some(note => /总预算是 64 KiB/u.test(note)), JSON.stringify(dshCheck.value.notes));
  // A confirmation is used once; replaying the same command returns its first result without writing again.
  const dshWrite = await f.apply(dshCheck, "dsh-first");
  const replayed = await f.call<CapabilityChangeView>("/capabilities/changes", { fingerprint: dshCheck.value.fingerprint, commandId: "dsh-first" });
  assert.deepEqual([replayed.status, replayed.value.id], [200, dshWrite.id]);
  assert.equal(await readFile(dshFile, "utf8"), "dsh rules\n\n" + block(dshBody));
  assert.equal(await mode(dshFile), "644", "the file keeps its mode");
  assert.ok(dshWrite.backupId !== null);
  assert.equal(state(await f.view(), "dsh")?.state, "synced");
  // Codex reads its non-empty override, so the block goes there with Codex's own addition; AGENTS.md is left alone.
  const codexCheck = await f.check("sync", "codex");
  assert.ok(codexCheck.value.notes.some(note => /AGENTS\.override\.md/u.test(note)));
  assert.ok(!codexCheck.value.notes.some(note => /32 KiB/u.test(note)), "Codex reads its user-level file whole");
  await f.apply(codexCheck);
  assert.equal(await readFile(override, "utf8"), "Override rules\n\n" + block("Reply in Chinese.\nKeep commits small.\n\nCodex only."));
  assert.equal(await readFile(codexBase, "utf8"), "Base rules\n");
  // A change of the texts leaves the blocks outdated; an update replaces the block in place, a removal gives the old bytes back.
  assert.equal((await f.save("Reply in Chinese.", { dsh: "Use pnpm." })).status, 200);
  view = await f.view();
  assert.deepEqual([state(view, "dsh")?.state, state(view, "codex")?.state], ["outdated", "outdated"]);
  // A file changed after its check is not written.
  const late = await f.check("sync", "dsh");
  await writeFile(dshFile, (await readFile(dshFile, "utf8")) + "Added later.\n");
  const conflict = await f.call<{ code: string }>("/capabilities/changes", { fingerprint: late.value.fingerprint, commandId: "dsh-late" });
  assert.deepEqual([conflict.status, conflict.value.code], [409, "CAPABILITY_TARGET_CHANGED"]);
  await f.apply(await f.check("sync", "dsh"));
  assert.equal(await readFile(dshFile, "utf8"), "dsh rules\n\n" + block("Reply in Chinese.\n\nUse pnpm.") + "Added later.\n", "the user's line after the block stays");
  await writeFile(dshFile, "dsh rules\n\n" + block("Reply in Chinese.\n\nUse pnpm."));
  const dshRemove = await f.check("remove", "dsh");
  assert.equal(dshRemove.value.current, "harnesshub");
  assert.match(dshRemove.value.notes[0] ?? "", /^只删 ~\/\.dsh\/AGENTS\.md 里带 HarnessHub 标记的区块/u);
  await f.apply(dshRemove);
  assert.equal(await readFile(dshFile, "utf8"), "dsh rules\n", "the file reads as before HarnessHub's first write");
  assert.equal(state(await f.view(), "dsh")?.state, "absent");
  assert.match((await f.check("remove", "dsh")).value.blocked ?? "", /没有 HarnessHub 区块/u);
  // A file HarnessHub creates is private and deleted again once its block is removed; its backup puts it back, nothing having changed since.
  await rm(dshFile);
  const created = await f.apply(await f.check("sync", "dsh"));
  assert.equal(created.backupId, null, "a new file has nothing to back up");
  assert.equal(await mode(dshFile), "600");
  const deleting = await f.check("remove", "dsh");
  assert.ok(deleting.value.notes.some(note => /会删除它/u.test(note)) && deleting.value.notes.includes("会删除这个文件。"), JSON.stringify(deleting.value.notes));
  const deleted = await f.apply(deleting);
  await assert.rejects(stat(dshFile), { code: "ENOENT" });
  assert.match(deleted.diff ?? "", /^-<!-- harnesshub:end id=instructions -->$/mu);
  const restoreCheck = await f.call<CapabilityRestoreCheck>("/capabilities/backups/" + deleted.backupId + "/restore");
  assert.deepEqual([restoreCheck.status, restoreCheck.value.changedSince], [200, false], JSON.stringify(restoreCheck.value));
  assert.ok(restoreCheck.value.notes.some(note => /重新建立它（权限 0600）/u.test(note)));
  const restored = await f.call<CapabilityChangeView>("/capabilities/restores", { fingerprint: restoreCheck.value.fingerprint, commandId: "restore-dsh" });
  assert.equal(restored.value.status, "applied", JSON.stringify(restored.value));
  assert.equal(await readFile(dshFile, "utf8"), block("Reply in Chinese.\n\nUse pnpm."));
  assert.equal(await mode(dshFile), "600");
  assert.equal(state(await f.view(), "dsh")?.state, "claimable", "a restore leaves the block as the file's, not as a record of HarnessHub's");
  // A target that is a link is never written through.
  await rm(dshFile); await writeFile(join(home, "elsewhere-agents.md"), "Linked rules\n"); await symlink(join(home, "elsewhere-agents.md"), dshFile);
  assert.match(state(await f.view(), "dsh")?.reason ?? "", /符号链接/u);
  assert.match((await f.check("sync", "dsh")).value.blocked ?? "", /符号链接/u);
  // The history records each change; the documented downgrade to v3 drops the texts, the instruction history and ledger entries and keeps the rest.
  const changes = (await f.history()).changes.map(change => change.kind);
  assert.ok(changes.filter(kind => kind === "instructions-sync").length >= 4 && changes.includes("instructions-remove") && changes.includes("restore"), JSON.stringify(changes));
  const copy = join(f.root, "downgrade.sqlite");
  await writeFile(copy, await readFile(join(f.root, "data", "capabilities", "capabilities.sqlite")));
  const db = new DatabaseSync(copy);
  try {
      assert.ok((db.prepare("SELECT COUNT(*) AS n FROM capability_ledger WHERE key LIKE 'instructions/%'").get()?.n as number) > 0);
      db.exec(await readFile(new URL("../../../tools/capabilities-v4-to-v3.sql", import.meta.url), "utf8"));
      assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 3);
      assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name), ["capability_backups", "capability_changes", "capability_ledger", "capability_owner", "mcp_servers", "skill_sources", "skill_undo"]);
      assert.deepEqual([db.prepare("SELECT COUNT(*) AS n FROM capability_ledger WHERE key LIKE 'instructions/%'").get()?.n, db.prepare("SELECT COUNT(*) AS n FROM capability_changes WHERE json_extract(view_json, '$.kind') LIKE 'instructions-%'").get()?.n], [0, 0]);
      assert.ok((db.prepare("SELECT COUNT(*) AS n FROM capability_changes WHERE json_extract(view_json, '$.kind') = 'restore'").get()?.n as number) > 0, "other changes stay");
      assert.ok((db.prepare("SELECT COUNT(*) AS n FROM capability_backups").get()?.n as number) > 0, "the backups stay");
    } finally { db.close(); }
    await f.clean();
  });

  test("G064-I2 OpenCode's fallback, Claude Code's file it falls back to, OpenClaw's workspace and cc-switch's files each say what a write means before it is made", { timeout: 180000 }, async t => {
    const f = await gateway(t), home = f.home, claudeFile = join(home, ".claude", "CLAUDE.md"), opencodeFile = join(home, ".config", "opencode", "AGENTS.md");
    assert.equal((await f.save("Reply in Chinese.")).status, 200);
    // OpenCode falls back to ~/.claude/CLAUDE.md, which holds the user's own text: its own file waits for the user, and the other way is named.
    const asked = await f.check("sync", "opencode");
    assert.match(asked.value.blocked ?? "", /读不到那些内容.*也可以改为写入 Claude Code 的 ~\/\.claude\/CLAUDE\.md/u);
    assert.deepEqual(asked.value.proceed, { option: "create-own", label: "新建 OpenCode 自己的文件" });
    // With neither file, OpenCode's own file is created without asking; the check says the fallback ends, the removal that it comes back.
    await rm(claudeFile);
    assert.equal(state(await f.view(), "claude")?.state, "absent");
    const direct = await f.check("sync", "opencode");
    assert.ok(direct.value.notes.some(note => /会新建 ~\/\.config\/opencode\/AGENTS\.md；之后 OpenCode 不再回退读 ~\/\.claude\/CLAUDE\.md/u.test(note)), JSON.stringify(direct.value.notes));
    await f.apply(direct);
    assert.equal(await readFile(opencodeFile, "utf8"), block("Reply in Chinese."));
    assert.equal(await mode(opencodeFile), "600", "a file HarnessHub creates is private");
    const back = await f.check("remove", "opencode");
    assert.ok(back.value.notes.some(note => /会删除它，OpenCode 随后重新回退读 ~\/\.claude\/CLAUDE\.md/u.test(note)), JSON.stringify(back.value.notes));
    await f.apply(back);
    await assert.rejects(stat(opencodeFile), { code: "ENOENT" });
    // Claude Code's file is the one OpenCode falls back to: its write and removal say so; OpenCode then shows it reads Claude's block.
    const claudeCheck = await f.check("sync", "claude");
    assert.ok(claudeCheck.value.notes.some(note => /OpenCode 没有自己的指令文件，也会经回退读到这个文件/u.test(note)), JSON.stringify(claudeCheck.value.notes));
    await f.apply(claudeCheck);
    let view = await f.view();
    assert.deepEqual([state(view, "claude")?.state, state(view, "opencode")?.state], ["synced", "elsewhere"]);
    const claudeRemove = await f.check("remove", "claude");
    assert.ok(claudeRemove.value.notes.some(note => /删除后它也读不到这些指令/u.test(note)), JSON.stringify(claudeRemove.value.notes));
    // From there OpenCode's own file is created without asking, since the fallback holds nothing but HarnessHub's block.
    await f.apply(await f.check("sync", "opencode"));
    assert.equal(state(await f.view(), "opencode")?.state, "synced");
    // OpenClaw: only its default agent's workspace file, never created, never past its per-file limit; the channels it answers in are named.
    const config = join(home, ".openclaw", "openclaw.json"), workspaceFile = join(home, "claw-ws", "AGENTS.md");
    await writeFile(config, "{\n  // JSON5\n  agents: { defaults: { workspace: '~/claw-ws', bootstrapMaxChars: 120 }, list: [{ id: 'main', default: true }, { id: 'helper' }] },\n"
      + "  channels: { feishu: { appSecret: 'sk-literal-secret' }, 'openclaw-weixin': {} },\n}\n");
    await mkdir(join(home, "claw-ws", ".git"));
    const tooLong = await f.check("sync", "openclaw");
    assert.match(tooLong.value.blocked ?? "", /超过 OpenClaw 的单个文件上限 120 个字符.*挖掉中间的部分/u);
    await writeFile(config, "{ agents: { defaults: { workspace: '~/claw-ws' }, list: [{ id: 'main', default: true }, { id: 'helper' }] }, channels: { feishu: {}, 'openclaw-weixin': {} } }\n");
    const openclaw = await f.check("sync", "openclaw");
    assert.equal(openclaw.value.blocked, null, openclaw.value.blocked ?? "");
    for (const pattern of [/OpenClaw 配置的频道：feishu、openclaw-weixin。这些频道里的新会话或重置后的会话会按新指令回答；运行中的会话不变；HarnessHub 不重启网关/u, /配置了 2 个 agent，这里只写默认 agent 的工作区/u, /git status/u])
      assert.ok(openclaw.value.notes.some(note => pattern.test(note)), pattern.source + " " + JSON.stringify(openclaw.value.notes));
    await rm(workspaceFile);
    assert.match((await f.check("sync", "openclaw")).value.blocked ?? "", /还没有生成工作区里的 AGENTS\.md.*不替它新建/u);
    // cc-switch writes GEMINI.md whole: once it is set up here, a first write waits for the user and an update of HarnessHub's block does not.
    // Its directory is unreadable here: only that it exists is looked at.
    await writeFile(join(home, ".gemini", "GEMINI.md"), "");
    await mkdir(join(home, ".cc-switch")); await writeFile(join(home, ".cc-switch", "cc-switch.db"), "not read"); await chmod(join(home, ".cc-switch"), 0o000);
  try {
    view = await f.view();
    assert.match(state(view, "gemini")?.cautions.join("") ?? "", /cc-switch 启用或切换提示词时会整份改写 ~\/\.gemini\/GEMINI\.md.*现在是 0 字节，与 cc-switch 停用提示词后的状态一致/u);
    assert.deepEqual(state(view, "dsh")?.cautions, []);
    const geminiAsked = await f.check("sync", "gemini");
    assert.deepEqual(geminiAsked.value.proceed, { option: "acknowledge-cc-switch", label: "我知道，仍然写入" });
    await f.apply(await f.check("sync", "gemini", ["acknowledge-cc-switch"]));
    assert.equal(await readFile(join(home, ".gemini", "GEMINI.md"), "utf8"), block("Reply in Chinese."), "a 0-byte file gets the block with nothing before it");
    assert.equal((await f.save("Reply in Chinese, briefly.")).status, 200);
    const update = await f.check("sync", "gemini");
    assert.equal(update.value.blocked, null, "updating HarnessHub's own block asks nothing more");
    assert.ok(update.value.notes.some(note => /cc-switch 启用或切换提示词时会整份改写这个文件/u.test(note)));
    await f.apply(update);
    const geminiRemove = await f.apply(await f.check("remove", "gemini"));
    assert.equal(await readFile(join(home, ".gemini", "GEMINI.md"), "utf8"), "", "back to the 0-byte file");
    assert.ok(geminiRemove.backupId !== null);
  } finally { await chmod(join(home, ".cc-switch"), 0o700); }
  await f.clean();
});

test("G064-I3 what HarnessHub wrote and someone then changed, removed or moved is shown, kept as the user's and put back only on request; a Harness not installed is not listed", { timeout: 180000 }, async t => {
  const f = await gateway(t, ["pi"]), home = f.home, dshFile = join(home, ".dsh", "AGENTS.md");
  let view = await f.view();
  assert.equal(state(view, "pi"), undefined, "Pi is not installed here");
  assert.equal((await f.save("Reply in Chinese.")).status, 200);
  // A block someone edited is the user's: shown as changed and in the drift list, overwritten or removed only on request.
  await f.apply(await f.check("sync", "dsh"));
  await writeFile(dshFile, (await readFile(dshFile, "utf8")).replace("Reply in Chinese.", "Reply in English."));
  assert.deepEqual([state(await f.view(), "dsh")?.state, state(await f.view(), "dsh")?.reason], ["changed", "区块里的内容被改过，现在归你"]);
  let history = await f.history();
  assert.deepEqual(history.drift.map(item => [item.kind, item.harnessId, item.state, item.subject]), [["instructions", "dsh", "changed", "指令"]]);
  assert.deepEqual(history.orphans, [], "an instructions record is not a skill switch");
  assert.equal((await f.check("sync", "dsh")).value.proceed?.option, "overwrite");
  assert.equal((await f.check("remove", "dsh")).value.proceed?.option, "overwrite");
  await f.apply(await f.check("sync", "dsh", ["overwrite"]));
  assert.equal(await readFile(dshFile, "utf8"), "dsh rules\n\n" + block("Reply in Chinese."));
  // An older version of HarnessHub's own block written back (as another tool may do) is named so, and is not taken as current.
  await writeFile(dshFile, "dsh rules\n\n" + block("An older text."));
  assert.match(state(await f.view(), "dsh")?.reason ?? "", /HarnessHub 更早写的版本（可能被别的工具写回）/u);
  await writeFile(dshFile, "dsh rules\n\n" + block("Reply in Chinese."));
  // A block removed by hand shows as removed and comes back through the re-apply check.
  await writeFile(dshFile, "dsh rules\n");
  history = await f.history();
  assert.deepEqual(history.drift.map(item => [item.kind, item.state]), [["instructions", "removed"]]);
  await f.apply(await f.call<CapabilityChangeCheck>("/capabilities/drift/" + history.drift[0]!.id + "/reapply"));
  assert.equal(await readFile(dshFile, "utf8"), "dsh rules\n\n" + block("Reply in Chinese."));
  // Markers HarnessHub cannot use make the file unreadable for it; it can stop tracking what it wrote there, and the file stays.
  await writeFile(dshFile, "dsh rules\n\n<!-- harnesshub:begin id=instructions sha=000000000000 -->\nReply in Chinese.\n");
  history = await f.history();
  assert.deepEqual(history.drift.map(item => [item.kind, item.state]), [["instructions", "unreadable"]]);
  assert.match((await f.check("sync", "dsh")).value.blocked ?? "", /只有开始标记/u);
  assert.deepEqual((await f.call<{ forgotten: boolean }>("/capabilities/forget", { id: history.drift[0]!.id })).value, { forgotten: true });
  assert.deepEqual((await f.history()).drift, []);
  await writeFile(dshFile, "dsh rules\n");
  // The same block already in a file without a record can be claimed, no file changing; a different one cannot.
  const workspaceFile = join(home, "claw-ws", "AGENTS.md");
  await writeFile(workspaceFile, "Workspace rules\n\n" + block("Another text."));
  assert.equal(state(await f.view(), "openclaw")?.state, "changed");
  assert.equal((await f.call("/capabilities/instructions/claim", { harnessId: "openclaw" })).status, 409);
  const same = "Workspace rules\n\n" + block("Reply in Chinese.");
  await writeFile(workspaceFile, same);
  assert.equal(state(await f.view(), "openclaw")?.state, "claimable");
  const claimed = await f.call<CapabilityChangeView>("/capabilities/instructions/claim", { harnessId: "openclaw" });
  assert.deepEqual([claimed.status, claimed.value.kind, claimed.value.diff], [200, "instructions-claim", null]);
  assert.equal(await readFile(workspaceFile, "utf8"), same);
  assert.equal(state(await f.view(), "openclaw")?.state, "synced");
  // Codex after its override appears: HarnessHub's block in AGENTS.md is shadowed and removed from there first.
  const override = join(home, ".codex", "AGENTS.override.md"), base = join(home, ".codex", "AGENTS.md");
  await rm(override);
  await f.apply(await f.check("sync", "codex"));
  await writeFile(override, "Override rules\n");
  view = await f.view();
  assert.deepEqual([state(view, "codex")?.state, state(view, "codex")?.file], ["shadowed", "~/.codex/AGENTS.md"]);
  assert.match((await f.check("sync", "codex")).value.blocked ?? "", /请先移除/u);
  await f.apply(await f.check("remove", "codex"));
  assert.equal(await readFile(base, "utf8"), "Base rules\n");
  assert.equal(state(await f.view(), "codex")?.state, "absent");
  // A record of a block that left the file Codex read before goes when the block is written into the file it reads now.
  await rm(override);
  await f.apply(await f.check("sync", "codex"));
  await writeFile(base, "Base rules\n"); await writeFile(override, "Override rules\n");
  history = await f.history();
  assert.deepEqual(history.drift.map(item => [item.kind, item.harnessId, item.state, item.file]), [["instructions", "codex", "removed", "~/.codex/AGENTS.md"]]);
  await f.apply(await f.check("sync", "codex"));
  assert.deepEqual((await f.history()).drift, [], "the stale record went with the new write");
  assert.equal(await readFile(override, "utf8"), "Override rules\n\n" + block("Reply in Chinese."));
  assert.equal((await readdir(join(home, ".codex"))).some(name => name.includes(".harnesshub-")), false, "no temporary file is left");
  // Storage: a reader refuses a schema newer than it knows, as a v3 build refuses v4; after the downgrade, the v3 database opens and comes back to v4.
  const data = join(f.root, "data", "capabilities"), newer = join(f.root, "newer"), older = join(f.root, "older");
  for (const target of [newer, older]) {
    await mkdir(target); await cp(data, join(target, "capabilities"), { recursive: true });
    await chmod(target, 0o700); await chmod(join(target, "capabilities"), 0o700); await chmod(join(target, "capabilities", "backups"), 0o700);
    for (const name of await readdir(join(target, "capabilities"))) if (name !== "backups" && name !== "skills") await chmod(join(target, "capabilities", name), 0o600);
  }
  let db = new DatabaseSync(join(newer, "capabilities", "capabilities.sqlite")); db.exec("PRAGMA user_version=5"); db.close();
  assert.throws(() => CapabilityStore.open(newer, 1_000_000), /unknown capability storage schema/u);
  db = new DatabaseSync(join(older, "capabilities", "capabilities.sqlite"));
  const backups = db.prepare("SELECT COUNT(*) AS n FROM capability_backups").get()?.n;
  db.exec(await readFile(new URL("../../../tools/capabilities-v4-to-v3.sql", import.meta.url), "utf8")); db.close();
  const reopened = CapabilityStore.open(older, 1_000_000);
  try { assert.deepEqual([reopened.instructionTexts(), reopened.backups().length, reopened.ledgerEntries().filter(item => item.key.startsWith("instructions/")).length], [[], backups, 0]); } finally { reopened.close(); }
  db = new DatabaseSync(join(older, "capabilities", "capabilities.sqlite"));
  try { assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 4); } finally { db.close(); }
  await f.clean();
});
