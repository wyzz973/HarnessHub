import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse as parseToml } from "smol-toml";
import type { CapabilityChangeCheck, CapabilityChangeView, CapabilityHistory, SubagentInventoryView } from "../../src/contracts/capabilities.js";
import { application } from "../../src/cli/session-application.js";
import { renderSubagent } from "../../src/infrastructure/capabilities/subagent-definitions.js";
import { prepareConfiguration } from "../../src/infrastructure/session/binding-factory.js";
import { startWebServer } from "../../src/web/server.js";
import { homePathsIn } from "../../src/web/shown-paths.js";
import { capabilityHome, CREDENTIALS, officialInstalls } from "../fixtures/capability-home.js";

/** A Gateway on a private home with the official installations' fixture files, through its formal entry. */
async function gateway(t: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "subagents-"))), closers: (() => Promise<void>)[] = [];
  t.after(async () => { for (const close of closers.reverse()) await close(); await rm(root, { recursive: true, force: true }); });
  const home = join(root, "home"), workspace = join(root, "workspace");
  await mkdir(home); await mkdir(workspace); await capabilityHome(home, join(root, "elsewhere"));
  const environment = { home, values: { HOME: home, PATH: [...await officialInstalls(home), "/usr/bin", "/bin"].join(":") } };
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
  const view = async () => (await call<SubagentInventoryView>("/capabilities/subagents")).value;
  const save = (name: string, description: string, prompt: string, replace = false) => call<{ name: string; message: string }>("/capabilities/subagents/save", { name, definition: { description, prompt }, replace });
  const check = (action: "sync" | "remove", name: string, harnessId: string, overwrite = false) => call<CapabilityChangeCheck>("/capabilities/subagents/" + action + "?" + new URLSearchParams({ name, harnessId, ...(overwrite ? { overwrite: "true" } : {}) }));
  const apply = async (checked: { status: number; value: CapabilityChangeCheck }, commandId = "subagents-" + Math.random().toString(16).slice(2)) => {
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
const state = (view: SubagentInventoryView, name: string, harnessId: string) => view.subagents.find(item => item.name === name)?.targets.find(target => target.harnessId === harnessId);
const mode = async (path: string) => ((await stat(path)).mode & 0o777).toString(8);
const CHECKER = { description: "Checks a change for what it breaks", prompt: "You check one change.\n\nSay what it breaks, then stop." };

test("G064-A2 through the formal Gateway, a listed subagent is written into each Harness in its own format, kept in a directory HarnessHub creates when needed, and removed again", { timeout: 180000 }, async t => {
  const f = await gateway(t), home = f.home;
  // Who can take subagents, and why the others cannot.
  let view = await f.view();
  assert.deepEqual(view.subagents, []);
  assert.deepEqual(Object.fromEntries(view.harnesses.map(item => [item.harnessId, item.writable])), { claude: true, codex: true, cursor: false, opencode: true, gemini: true, openclaw: false, pi: false, hermes: false, dsh: false });
  assert.match(view.harnesses.find(item => item.harnessId === "cursor")?.reason ?? "", /只读工作区里的子 Agent/u);
  // What the list refuses: a built-in's name, a bad name, a prompt that would read as frontmatter, the home written out.
  for (const [name, description, prompt, reason] of [["explore", "d", "p", /内置/u], ["default", "d", "p", /codex 的内置/u], ["Bad_Name", "d", "p", /小写/u], ["ok", "d", "---\nx: y\n---\nbody", /--- 行开头/u],
    ["ok", "d", "See " + home + "/notes", /写成 ~/u], ["ok", "two\nlines", "p", /一行/u]] as const) {
    const refused = await f.save(name, description, prompt);
    assert.deepEqual([refused.status, reason.test(refused.value.message)], [400, true], name + " " + refused.value.message);
  }
  assert.equal((await f.save("checker", "  " + CHECKER.description + "  ", "\n" + CHECKER.prompt + "\n\n")).status, 200);
  assert.equal((await f.save("checker", "x", "y")).status, 409, "a listed name is changed only with replace");
  view = await f.view();
  assert.deepEqual(view.subagents[0]?.definition, CHECKER, "both texts are stored trimmed");
  assert.deepEqual(["claude", "codex", "gemini", "opencode"].map(id => state(view, "checker", id)?.state), ["absent", "absent", "absent", "absent"]);
  // OpenCode's agents directory is not there: it is created for the file (0700) and goes again with it.
  await rm(join(home, ".config", "opencode", "agents"), { recursive: true });
  const files = { claude: join(home, ".claude", "agents", "checker.md"), codex: join(home, ".codex", "agents", "checker.toml"), gemini: join(home, ".gemini", "agents", "checker.md"), opencode: join(home, ".config", "opencode", "agents", "checker.md") };
  const fingerprints = new Map<string, string>();
  for (const harnessId of ["opencode", "gemini", "codex", "claude"] as const) {
    const checked = await f.check("sync", "checker", harnessId); fingerprints.set(harnessId, checked.value.fingerprint);
    assert.match(checked.value.notes[0] ?? "", /^只新建 HarnessHub 自己的文件 .*不写工具、权限、hooks、MCP，不改模型与登录配置/u, harnessId);
    assert.ok(checked.value.notes.some(note => /继承|不能放宽/u.test(note)), harnessId + " says what it inherits");
    assert.match(checked.value.diff ?? "", /^--- \/dev\/null$/mu, harnessId);
    if (harnessId === "opencode") assert.ok(checked.value.notes.some(note => /会新建目录 ~\/\.config\/opencode\/agents（0700）/u.test(note)), JSON.stringify(checked.value.notes));
    const applied = await f.apply(checked, "write-" + harnessId);
    assert.equal(applied.backupId, null);
    assert.equal(await readFile(files[harnessId], "utf8"), renderSubagent("checker", CHECKER, harnessId));
    assert.equal(await mode(files[harnessId]), "600");
  }
  assert.equal(await mode(join(home, ".config", "opencode", "agents")), "700");
  assert.deepEqual({ ...parseToml(await readFile(files.codex, "utf8")) }, { name: "checker", description: CHECKER.description, developer_instructions: CHECKER.prompt });
  view = await f.view();
  assert.deepEqual(["claude", "codex", "gemini", "opencode"].map(id => state(view, "checker", id)?.state), ["synced", "synced", "synced", "synced"]);
  // A confirmation is used once; replaying the command returns its first result.
  const again = await f.call<CapabilityChangeView>("/capabilities/changes", { fingerprint: fingerprints.get("claude"), commandId: "write-claude" });
  assert.deepEqual([again.status, again.value.kind, again.value.harnessId], [200, "subagent-sync", "claude"]);
  // A change of the list leaves the files outdated; an update rewrites HarnessHub's file only.
  assert.equal((await f.save("checker", CHECKER.description, CHECKER.prompt + "\nBe brief.", true)).status, 200);
  assert.equal(state(await f.view(), "checker", "codex")?.state, "outdated");
  const late = await f.check("sync", "checker", "codex");
  await appendFile(files.codex, "# someone's note\n");
  assert.deepEqual([(await f.call<{ code: string }>("/capabilities/changes", { fingerprint: late.value.fingerprint, commandId: "late" })).status], [409]);
  assert.equal(state(await f.view(), "checker", "codex")?.state, "changed");
  await f.apply(await f.check("sync", "checker", "codex", true));
  assert.equal(parseToml(await readFile(files.codex, "utf8")).developer_instructions, CHECKER.prompt + "\nBe brief.");
  // The list keeps a subagent while HarnessHub's files are out there.
  assert.equal((await f.call("/capabilities/subagents/delete", { name: "checker" })).status, 409);
  // Removal: HarnessHub's files only; the directory it created goes with its last file, the others stay.
  for (const harnessId of ["opencode", "gemini", "codex", "claude"] as const) {
    const removing = await f.check("remove", "checker", harnessId);
    if (harnessId === "opencode") assert.ok(removing.value.notes.some(note => /目录 ~\/\.config\/opencode\/agents 是 HarnessHub 新建的，移除后为空，会一并删除/u.test(note)), JSON.stringify(removing.value.notes));
    await f.apply(removing);
    await assert.rejects(stat(files[harnessId]), { code: "ENOENT" });
  }
  await assert.rejects(stat(join(home, ".config", "opencode", "agents")), { code: "ENOENT" });
  assert.deepEqual((await readdir(join(home, ".claude", "agents"))).sort(), ["reviewer.md", "team"]);
  assert.deepEqual((await readdir(join(home, ".codex", "agents"))).sort(), ["helper.toml", "team"]);
  assert.equal((await f.call("/capabilities/subagents/delete", { name: "checker" })).status, 200);
  const changes = (await f.history()).changes.map(change => change.kind + ":" + change.harnessId);
  assert.equal(changes.filter(kind => kind.startsWith("subagent-sync")).length, 5, "four writes and the overwrite; the refused one left no record");
  assert.equal(changes.filter(kind => kind.startsWith("subagent-remove")).length, 4);
  assert.deepEqual((await f.history()).drift, []);
  await f.clean();
});

test("G064-A3 another definition of the name, by each Harness's naming, is never overwritten; identical files are claimed; what someone changed or removed is shown and put back on request", { timeout: 180000 }, async t => {
  const f = await gateway(t), home = f.home;
  // Claude's team/lead.md is named lead; OpenCode's modes/focus.md is the agent focus; Codex declares a role in config.toml.
  await appendFile(join(home, ".codex", "config.toml"), "\n[agents.scoutx]\ndescription = \"Declared in config\"\n");
  for (const name of ["lead", "focus", "scoutx", "draft", "linked", "templated"]) assert.equal((await f.save(name, "d " + name, name === "templated" ? "Use ${today}." : "p " + name)).status, 200, name);
  let view = await f.view();
  assert.deepEqual([state(view, "lead", "claude")?.state, state(view, "lead", "codex")?.state], ["different", "absent"]);
  assert.match(state(view, "lead", "claude")?.reason ?? "", /~\/\.claude\/agents\/team\/lead\.md/u);
  assert.deepEqual([state(view, "focus", "opencode")?.state, state(view, "scoutx", "codex")?.state], ["different", "different"]);
  assert.match(state(view, "scoutx", "codex")?.reason ?? "", /config\.toml 的 \[agents\.scoutx\]/u);
  // Gemini does not read a name starting with _, so _draft.md is no conflict there; it fills ${…}, so a prompt with one is not
  // written there; and where the file would go is a link (Gemini skips it), HarnessHub does not write through it.
  assert.deepEqual([state(view, "draft", "gemini")?.state, state(view, "templated", "gemini")?.state, state(view, "templated", "claude")?.state], ["absent", "unsupported", "absent"]);
  assert.deepEqual([state(view, "linked", "gemini")?.state, /符号链接/u.test(state(view, "linked", "gemini")?.reason ?? "")], ["unsupported", true]);
  assert.match((await f.check("sync", "lead", "claude")).value.blocked ?? "", /同名的定义/u);
  // Codex's config.toml that does not parse: no telling, so nothing is written there.
  const config = join(home, ".codex", "config.toml"), configText = await readFile(config, "utf8");
  await writeFile(config, "not = [valid toml");
  assert.match(state(await f.view(), "draft", "codex")?.reason ?? "", /读不了 ~\/\.codex\/config\.toml/u);
  await writeFile(config, configText);
  // An identical file of the user's is claimed, not rewritten.
  const draftFile = join(home, ".claude", "agents", "draft.md"), draftText = renderSubagent("draft", { description: "d draft", prompt: "p draft" }, "claude");
  await writeFile(draftFile, draftText);
  assert.equal(state(await f.view(), "draft", "claude")?.state, "claimable");
  const claimed = await f.call<CapabilityChangeView[]>("/capabilities/subagents/claim", { name: "draft", harnessIds: ["claude"] });
  assert.deepEqual([claimed.status, claimed.value.map(change => change.kind)], [200, ["subagent-claim"]]);
  assert.equal(await readFile(draftFile, "utf8"), draftText);
  // HarnessHub's file changed by someone: shown and in the drift list, put back only with overwrite; removed: put back through re-apply.
  await f.apply(await f.check("sync", "draft", "gemini"));
  const geminiFile = join(home, ".gemini", "agents", "draft.md");
  await writeFile(geminiFile, (await readFile(geminiFile, "utf8")).replace("p draft", "p changed"));
  let history = await f.history();
  assert.deepEqual(history.drift.map(item => [item.kind, item.harnessId, item.state, item.subject]), [["subagent", "gemini", "changed", "draft"]]);
  assert.match((await f.check("sync", "draft", "gemini")).value.blocked ?? "", /重新写入/u);
  await f.apply(await f.check("sync", "draft", "gemini", true));
  await rm(geminiFile);
  history = await f.history();
  assert.deepEqual(history.drift.map(item => [item.kind, item.state]), [["subagent", "removed"]]);
  await f.apply(await f.call<CapabilityChangeCheck>("/capabilities/drift/" + history.drift[0]!.id + "/reapply"));
  assert.equal(state(await f.view(), "draft", "gemini")?.state, "synced");
  // Another definition appearing beside HarnessHub's file: further writes wait, but HarnessHub's own file can still be removed.
  await writeFile(join(home, ".gemini", "agents", "other.md"), "---\nname: draft\ndescription: x\n---\nmine\n");
  view = await f.view();
  assert.deepEqual([state(view, "draft", "gemini")?.state, /只会用其中一个/u.test(state(view, "draft", "gemini")?.reason ?? "")], ["synced", true]);
  await f.apply(await f.check("remove", "draft", "gemini"));
  assert.deepEqual((await f.history()).orphans, [], "a subagent record is not a skill switch");
  // A Harness whose configuration directory is missing is not written; HarnessHub does not create it.
  await rm(join(home, ".gemini"), { recursive: true });
  assert.match(state(await f.view(), "draft", "gemini")?.reason ?? "", /没有 ~\/\.gemini.*不替它新建/u);
  await f.clean();
});
