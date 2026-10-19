import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CapabilitiesView, CapabilityChangeCheck, CapabilityChangeView, SkillUpdateView } from "../../src/contracts/capabilities.js";
import { application } from "../../src/cli/session-application.js";
import { renderSkillText } from "../../src/infrastructure/capabilities/skill-text.js";
import { prepareConfiguration } from "../../src/infrastructure/session/binding-factory.js";
import { startWebServer } from "../../src/web/server.js";
import { homePathsIn } from "../../src/web/shown-paths.js";
import { capabilityHome, CREDENTIALS, officialInstalls } from "../fixtures/capability-home.js";

/** A Gateway on a private home with the official installations' fixture files, through its formal entry; GitHub answers nothing. */
async function gateway(t: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "skill-create-"))), closers: (() => Promise<void>)[] = [];
  t.after(async () => { for (const close of closers.reverse()) await close(); await rm(root, { recursive: true, force: true }); });
  const home = join(root, "home"), workspace = join(root, "workspace");
  await mkdir(home); await mkdir(workspace); await capabilityHome(home, join(root, "elsewhere"));
  const environment = { home, values: { HOME: home, PATH: [...await officialInstalls(home), "/usr/bin", "/bin"].join(":") } };
  const server = await startWebServer({ root: join(root, "data"), configuration: await prepareConfiguration({ workspace, pathOnly: true }), port: 0, github: async () => new Response("not here", { status: 404 }),
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
  const create = (name: string, description: string, body: string) => call<CapabilityChangeCheck & { message: string }>("/capabilities/skill-create", { name, description, body });
  const edit = (name: string, description: string, body: string, overwrite = false) => call<CapabilityChangeCheck & { message: string }>("/capabilities/skill-edit", { name, description, body, overwrite });
  const apply = async (checked: { status: number; value: CapabilityChangeCheck }) => {
    assert.equal(checked.status, 200, JSON.stringify(checked.value)); assert.equal(checked.value.blocked, null, checked.value.blocked ?? "");
    const applied = await call<CapabilityChangeView>("/capabilities/changes", { fingerprint: checked.value.fingerprint, commandId: "skill-create-" + Math.random().toString(16).slice(2) });
    assert.equal(applied.value.status, "applied", JSON.stringify(applied.value));
    return applied.value;
  };
  const clean = async () => {
    const text = JSON.stringify(answers);
    for (const secret of CREDENTIALS) assert.equal(text.includes(secret), false, secret);
    assert.deepEqual(homePathsIn(answers, [home], 1 << 20), []);
  };
  return { root, home, call, create, edit, apply, clean };
}
const mode = async (path: string) => ((await stat(path)).mode & 0o777).toString(8);

test("G064-A4 a skill written from the user's texts goes into the shared directory as HarnessHub's own, is changed, undone and deleted through the usual checks, and is not taken for one with an upstream", { timeout: 180000 }, async t => {
  const f = await gateway(t), shared = join(f.home, ".agents", "skills"), folder = join(shared, "standup-notes"), lockBefore = await readFile(join(f.home, ".agents", ".skill-lock.json"), "utf8");
  // What is refused before anything is prepared: a bad name, shell commands OpenCode would run unasked, the home written out.
  for (const [name, body, reason] of [["Bad", "b", /小写字母/u], ["a--b", "b", /连续/u], ["shell", "Run !`ls` first.", /!`…`/u], ["fenced", "x\n```!\nrm -rf x\n```", /!`…`/u], ["home", "Notes in " + f.home + "/notes", /写成 ~/u]] as const) {
    const refused = await f.create(name, "d", body);
    assert.deepEqual([refused.status, reason.test(refused.value.message)], [400, true], name + " " + refused.value.message);
  }
  // A name some folder has, without case, is taken; one a Harness has built in is warned about.
  assert.match((await f.create("mismatch", "d", "b")).value.blocked ?? "", /已有 Mismatch（不分大小写）/u);
  const builtIn = await f.create("review", "d", "b");
  assert.equal(builtIn.value.blocked, null);
  assert.ok(["Claude Code", "OpenCode"].every(name => builtIn.value.notes.some(note => note.startsWith(name + " 有同名的内置命令或捆绑技能 /review"))), JSON.stringify(builtIn.value.notes));
  // Writing: the folder and its SKILL.md, shown first; recorded as HarnessHub's own, the lock untouched.
  const description = "Writes my standup notes", body = "Summarize what I did yesterday.\n\nArguments: $ARGUMENTS";
  const checked = await f.create("standup-notes", "  " + description + "  ", body + "\n");
  assert.match(checked.value.diff ?? "", /^\+name: standup-notes$/mu);
  assert.ok(checked.value.notes.some(note => /\$0 是第一个参数.*Codex 的技能没有参数/u.test(note)) && checked.value.notes.some(note => /放到 Claude Code/u.test(note)), JSON.stringify(checked.value.notes));
  const created = await f.apply(checked);
  assert.equal(await readFile(join(folder, "SKILL.md"), "utf8"), renderSkillText("standup-notes", { description, body }));
  assert.deepEqual([await mode(folder), await mode(join(folder, "SKILL.md"))], ["755", "644"]);
  assert.equal(await readFile(join(f.home, ".agents", ".skill-lock.json"), "utf8"), lockBefore, "no lock entry is written");
  const view = (await f.call<CapabilitiesView>("/capabilities")).value, entry = view.entries.find(item => item.kind === "skill" && item.name === "standup-notes");
  assert.deepEqual([entry?.owner, entry?.source], ["harnesshub", "HarnessHub 新建"]);
  assert.match((await f.create("standup-notes", "d", "b")).value.blocked ?? "", /已有 standup-notes/u);
  // Not one with an upstream: the update check says so instead of asking GitHub.
  const updates = (await f.call<SkillUpdateView>("/capabilities/skill-updates?refresh=1")).value;
  assert.deepEqual(updates.skills.filter(item => item.name === "standup-notes").map(item => [item.state, item.reason]), [["unsupported", "HarnessHub 新建的技能，没有上游；要改它请用“编辑”"]]);
  // Editing: the texts read back for the editor, the change shown as a diff, the old folder kept as a snapshot.
  assert.deepEqual((await f.call<{ text: { description: string; body: string } }>("/capabilities/skill-text?name=standup-notes")).value.text, { description, body });
  assert.match((await f.edit("standup-notes", description, body)).value.blocked ?? "", /无需修改/u);
  const edited = await f.apply(await f.edit("standup-notes", description, body + "\nKeep it short."));
  assert.ok((await readFile(join(folder, "SKILL.md"), "utf8")).endsWith("Keep it short.\n"));
  // A folder changed by someone since is replaced only on request, and the change can be undone.
  await writeFile(join(folder, "extra.md"), "mine\n");
  const guarded = await f.edit("standup-notes", description, "Shorter.");
  assert.match(guarded.value.blocked ?? "", /被改过/u);
  assert.equal(guarded.value.skills?.[0]?.overwrites, 2, "SKILL.md changes and extra.md goes");
  const overwritten = await f.apply(await f.edit("standup-notes", description, "Shorter.", true));
  assert.deepEqual(await readdir(folder), ["SKILL.md"]);
  await f.apply(await f.call<CapabilityChangeCheck>("/capabilities/changes/" + overwritten.id + "/undo"));
  assert.deepEqual((await readdir(folder)).sort(), ["SKILL.md", "extra.md"]);
  // Deleting goes through the usual deletion; a skill created and then undone leaves nothing.
  await rm(join(folder, "extra.md"));
  await f.apply(await f.call<CapabilityChangeCheck>("/capabilities/skill-delete?name=standup-notes"));
  await assert.rejects(stat(folder), { code: "ENOENT" });
  const temporary = await f.apply(await f.create("temp-skill", "d", "b"));
  await f.apply(await f.call<CapabilityChangeCheck>("/capabilities/changes/" + temporary.id + "/undo"));
  await assert.rejects(stat(join(shared, "temp-skill")), { code: "ENOENT" });
  assert.equal((await f.call<{ code: string }>("/capabilities/skill-text?name=temp-skill")).status, 404, "its record went with it");
  assert.deepEqual([created.kind, edited.kind, overwritten.kind], ["skill-create", "skill-edit", "skill-edit"]);
  await f.clean();
});
