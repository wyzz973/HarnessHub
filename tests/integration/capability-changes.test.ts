import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { CapabilitiesView, CapabilityChangeCheck, CapabilityChangeView, CapabilityHistory, CapabilityRestoreCheck } from "../../src/contracts/capabilities.js";
import { application } from "../../src/cli/session-application.js";
import { CapabilityChanges } from "../../src/infrastructure/capabilities/changes.js";
import type { ClaudeRunner } from "../../src/infrastructure/capabilities/claude-mcp.js";
import { prepareConfiguration } from "../../src/infrastructure/session/binding-factory.js";
import { startWebServer } from "../../src/web/server.js";
import { homePathsIn } from "../../src/web/shown-paths.js";
import { capabilityHome, CREDENTIALS, officialInstalls } from "../fixtures/capability-home.js";

const macOnly = { skip: process.platform !== "darwin" && "capability changes run their Harness commands under macOS's sandbox (ADR-045)", timeout: 90000 };
/** A Gateway on a private home with the nine official installations and their user-level files, through its formal entry. */
async function gateway(t: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "capability-changes-"))), closers: (() => Promise<void>)[] = [];
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
    const response = await fetch(origin + "/api/v1" + path, { method: body === undefined ? "GET" : "POST", headers: { Cookie: cookie, Origin: origin, ...(body === undefined ? {} : { "Content-Type": "application/json", "X-CSRF-Token": csrf }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json() as T; answers.push(value);
    return { status: response.status, value };
  };
  const check = (harnessId: string, name: string, enabled: boolean, via?: string) => call<CapabilityChangeCheck>("/capabilities/skill-switch?" + new URLSearchParams({ harnessId, name, enabled: String(enabled), ...(via === undefined ? {} : { via }) }));
  const apply = (fingerprint: string, commandId: string) => call<CapabilityChangeView>("/capabilities/changes", { fingerprint, commandId });
  /** Every answer masked the credentials and named no absolute home path, and no Harness program ran outside a sandbox. */
  const clean = async () => {
    const text = JSON.stringify(answers);
    for (const secret of CREDENTIALS) assert.equal(text.includes(secret), false, secret);
    assert.deepEqual(homePathsIn(answers, [home], 1 << 20), []);
    assert.deepEqual((await readdir(home)).filter(name => name.startsWith("ran-")), []);
  };
  return { root, home, call, check, apply, clean };
}

test("G064-W3 through the formal Gateway, turning a skill off in Claude Code shows the exact change first, writes only that setting with a backup, and turning it on again restores the original bytes", macOnly, async t => {
  const f = await gateway(t), settings = join(f.home, ".claude", "settings.json"), original = await readFile(settings, "utf8");
  const offCheck = await f.check("claude", "alpha", false);
  assert.equal(offCheck.status, 200, JSON.stringify(offCheck.value));
  assert.deepEqual([offCheck.value.file, offCheck.value.current, offCheck.value.blocked, offCheck.value.command], ["~/.claude/settings.json", "other", null, null]);
  assert.ok(offCheck.value.notes.some(note => note.includes("原来是 user-invocable-only")));
  assert.match(offCheck.value.diff ?? "", /^--- a\/~\/\.claude\/settings\.json\n\+\+\+ b\/~\/\.claude\/settings\.json\n@@/u);
  assert.equal(await readFile(settings, "utf8"), original, "a check writes nothing");
  const off = await f.apply(offCheck.value.fingerprint, "switch-alpha-off");
  assert.equal(off.status, 200, JSON.stringify(off.value));
  assert.equal(off.value.status, "applied"); assert.notEqual(off.value.backupId, null); assert.equal(off.value.diff, offCheck.value.diff, "the change made is the change shown");
  // Only the one value changed: every other byte, the model included, is as it was.
  assert.equal(await readFile(settings, "utf8"), original.replace("\"alpha\":\"user-invocable-only\"", "\"alpha\":\"off\""));
  // The same command again returns its first result; the same confirmation under another command is spent.
  const replay = await f.apply(offCheck.value.fingerprint, "switch-alpha-off");
  assert.deepEqual([replay.status, replay.value.id], [200, off.value.id]);
  const reused = await f.apply(offCheck.value.fingerprint, "switch-alpha-off-again");
  assert.deepEqual([reused.status, (reused.value as unknown as { code: string }).code], [409, "CAPABILITY_CHECK_EXPIRED"]);
  const history = await f.call<CapabilityHistory>("/capabilities/history");
  assert.deepEqual([history.value.changes[0]?.id, history.value.backups[0]?.file, history.value.backups[0]?.subject], [off.value.id, "~/.claude/settings.json", "alpha"]);
  const view = await f.call<CapabilitiesView>("/capabilities");
  assert.deepEqual(view.value.entries.find(item => item.kind === "skill" && item.name === "alpha")?.edges.filter(edge => edge.harnessId === "claude").map(edge => edge.status), ["disabled", "disabled"]);
  // Turning it on again: HarnessHub wrote the "off", so the value it replaced comes back and the file is byte for byte the original.
  const onCheck = await f.check("claude", "alpha", true);
  assert.deepEqual([onCheck.value.current, onCheck.value.blocked], ["harnesshub", null]);
  const on = await f.apply(onCheck.value.fingerprint, "switch-alpha-on");
  assert.equal(on.value.status, "applied");
  assert.equal(await readFile(settings, "utf8"), original);
  const already = await f.check("claude", "alpha", true);
  assert.match(already.value.blocked ?? "", /^无需修改/u);
  await f.clean();
});

test("G064-W3 under the Gateway's umask 077 a switched file keeps its own mode and its backup stays private, as under a permissive umask", macOnly, async t => {
  const { chmod, stat } = await import("node:fs/promises");
  const f = await gateway(t), settings = join(f.home, ".claude", "settings.json"), mode = async (path: string) => (await stat(path)).mode & 0o777;
  const backup = (id: string | null) => join(f.root, "data", "capabilities", "backups", id ?? "missing");
  await chmod(settings, 0o644);
  // 4317 runs with umask 077: the replaced file is still 0644, like the one it replaced, and the backup is 0600.
  const strict = process.umask(0o077);
  let off: { status: number; value: CapabilityChangeView };
  try { off = await f.apply((await f.check("claude", "alpha", false)).value.fingerprint, "umask-strict"); } finally { process.umask(strict); }
  assert.equal(off.value.status, "applied", JSON.stringify(off.value));
  assert.deepEqual([await mode(settings), await mode(backup(off.value.backupId))], [0o644, 0o600]);
  // A permissive umask widens neither.
  const loose = process.umask(0);
  let on: { status: number; value: CapabilityChangeView };
  try { on = await f.apply((await f.check("claude", "alpha", true)).value.fingerprint, "umask-loose"); } finally { process.umask(loose); }
  assert.equal(on.value.status, "applied", JSON.stringify(on.value));
  assert.deepEqual([await mode(settings), await mode(backup(on.value.backupId))], [0o644, 0o600]);
  await f.clean();
});

test("G064-W13 through the formal Gateway, an OpenCode file in OpenCode 2's dialect gets its skill rule appended to permissions whatever line is installed, and enabling brings the file back byte for byte", macOnly, async t => {
  const f = await gateway(t), opencodeFile = join(f.home, ".config", "opencode", "opencode.jsonc");
  await writeFile(join(f.home, ".config", "opencode", "config.json"), "{}\n");
  // The fixture's OpenCode is npm opencode-ai (OpenCode 1); this file already uses OpenCode 2's permissions array, which decides the dialect.
  const V2 = "{\n  // OpenCode 2's dialect\n  \"permissions\": [\n    { \"action\": \"skill\", \"resource\": \"*\", \"effect\": \"allow\" },\n    { \"action\": \"shell\", \"resource\": \"git push *\", \"effect\": \"ask\" }\n  ],\n}\n";
  await writeFile(opencodeFile, V2);
  const off = await f.check("opencode", "alpha", false);
  assert.equal(off.value.blocked, null, JSON.stringify(off.value));
  assert.ok(off.value.notes.some(note => note === "写法：文件里已有 OpenCode 2 的写法（permissions）。"), off.value.notes.join(" | "));
  assert.ok(off.value.diff?.includes("+    { \"action\": \"skill\", \"resource\": \"alpha\", \"effect\": \"deny\" }") || off.value.diff?.includes("\"resource\": \"alpha\""), off.value.diff ?? "");
  assert.equal((await f.apply(off.value.fingerprint, "switch-opencode-v2")).value.status, "applied");
  const after = await readFile(opencodeFile, "utf8");
  assert.ok(after.includes("// OpenCode 2's dialect") && !after.includes("\"permission\":"), after);
  assert.deepEqual((JSON.parse(after.replace(/^\s*\/\/.*$/gmu, "").replace(/,(\s*[}\]])/gu, "$1")) as { permissions: unknown[] }).permissions.at(-1), { action: "skill", resource: "alpha", effect: "deny" });
  const view = await f.call<CapabilitiesView>("/capabilities");
  const alpha = view.value.entries.find(item => item.kind === "skill" && item.name === "alpha")!;
  assert.ok(alpha.edges.filter(edge => edge.harnessId === "opencode").every(edge => edge.status === "disabled" && edge.reason?.includes("permissions 里 action 为 skill 的规则拒绝它（resource alpha）")), JSON.stringify(alpha.edges));
  const on = await f.check("opencode", "alpha", true);
  assert.equal(on.value.blocked, null, JSON.stringify(on.value));
  assert.equal((await f.apply(on.value.fingerprint, "switch-opencode-v2-back")).value.status, "applied");
  assert.equal(await readFile(opencodeFile, "utf8"), V2);
  await f.clean();
});

test("G064-W3 a file changed after its check, a linked file, a Harness without a switch and a skill it does not see are refused before anything is written", macOnly, async t => {
  const f = await gateway(t), settings = join(f.home, ".claude", "settings.json");
  const stale = await f.check("claude", "epsilon", false);
  assert.equal(stale.value.blocked, null);
  const edited = JSON.stringify({ ...JSON.parse(await readFile(settings, "utf8")) as object, theme: "dark" });
  await writeFile(settings, edited);
  const refused = await f.apply(stale.value.fingerprint, "switch-stale");
  assert.deepEqual([refused.status, (refused.value as unknown as { code: string }).code], [409, "CAPABILITY_TARGET_CHANGED"]);
  assert.equal(await readFile(settings, "utf8"), edited, "the user's change is kept and nothing is written over it");
  assert.deepEqual((await f.call<CapabilityHistory>("/capabilities/history")).value, { changes: [], backups: [], drift: [], orphans: [], snapshots: { count: 0, bytes: 0, keep: 50 } });
  // A configuration file that is a link (dotfiles managers) is shown as refused and cannot be confirmed.
  const gemini = join(f.home, ".gemini", "settings.json");
  await writeFile(join(f.root, "dotfiles-settings.json"), await readFile(gemini)); await rm(gemini); await symlink(join(f.root, "dotfiles-settings.json"), gemini);
  const linked = await f.check("gemini", "gamma", false);
  assert.equal(linked.status, 200); assert.match(linked.value.blocked ?? "", /符号链接/u); assert.equal(linked.value.diff, null);
  const linkedApply = await f.apply(linked.value.fingerprint, "switch-linked");
  assert.deepEqual([linkedApply.status, (linkedApply.value as unknown as { code: string }).code], [409, "CAPABILITY_TARGET_REFUSED"]);
  for (const [query, status, code] of [[["cursor", "alpha", false], 409, "CAPABILITY_UNSUPPORTED"], [["claude", "no-such-skill", false], 404, "CAPABILITY_NOT_FOUND"],
    [["codex", "alpha", false, "~/.claude/skills/alpha"], 404, "CAPABILITY_NOT_FOUND"], [["claude", "../x", false], 400, "INVALID_INPUT"]] as const) {
    const [harnessId, name, enabled, via] = query, answer = await f.check(harnessId, name, enabled, via);
    assert.deepEqual([answer.status, (answer.value as unknown as { code: string }).code], [status, code], query.join(" "));
  }
  await f.clean();
});

test("G064-W3 Codex, Hermes and OpenCode switches keep their files' comments and other keys, the shown diff writes the home as ~, and a backup restores a file", macOnly, async t => {
  const f = await gateway(t);
  // Codex switches the copy in ~/.agents/skills by its full path; the answer shows it with ~.
  const config = join(f.home, ".codex", "config.toml"), configBefore = await readFile(config, "utf8");
  const codex = await f.check("codex", "alpha", false, "~/.agents/skills/alpha");
  assert.equal(codex.value.blocked, null);
  assert.ok(codex.value.diff?.includes("+path = \"~/.agents/skills/alpha/SKILL.md\""), codex.value.diff ?? "");
  const codexApplied = await f.apply(codex.value.fingerprint, "switch-codex");
  assert.equal(codexApplied.value.status, "applied");
  assert.equal(await readFile(config, "utf8"), configBefore + "\n[[skills.config]]\npath = \"" + join(f.home, ".agents", "skills", "alpha", "SKILL.md") + "\"\nenabled = false\n");
  // Hermes: the flow list grows in place, the comments stay.
  const hermesFile = join(f.home, ".hermes", "config.yaml"), hermesBefore = await readFile(hermesFile, "utf8");
  const hermes = await f.check("hermes", "alpha", false);
  assert.equal((await f.apply(hermes.value.fingerprint, "switch-hermes")).value.status, "applied");
  assert.equal(await readFile(hermesFile, "utf8"), hermesBefore.replace("disabled: [beta]", "disabled: [beta, alpha]"));
  // OpenCode cannot weigh its permissions while an earlier configuration file does not parse; once it does, the rule goes last.
  const blocked = await f.check("opencode", "alpha", false);
  assert.match(blocked.value.blocked ?? "", /无法安全修改/u);
  await writeFile(join(f.home, ".config", "opencode", "config.json"), "{}\n");
  const opencodeFile = join(f.home, ".config", "opencode", "opencode.jsonc"), opencode = await f.check("opencode", "alpha", false);
  assert.equal(opencode.value.blocked, null);
  assert.equal((await f.apply(opencode.value.fingerprint, "switch-opencode")).value.status, "applied");
  const opencodeAfter = await readFile(opencodeFile, "utf8");
  assert.ok(opencodeAfter.includes("// the user's notes") && /"be\*": "deny",\s*"alpha": "deny"/u.test(opencodeAfter), opencodeAfter);
  // OpenClaw's own command is tried first in its sandbox; a failed dry run blocks the change and leaves the file alone.
  const clawFile = join(f.home, ".openclaw", "openclaw.json"), clawBefore = await readFile(clawFile, "utf8");
  const claw = await f.check("openclaw", "omega", false);
  assert.match(claw.value.blocked ?? "", /预演没有通过/u); assert.match(claw.value.command ?? "", /^openclaw config set skills\.entries\.omega\.enabled false --strict-json$/u);
  assert.ok(claw.value.notes.some(note => note.includes("注释")), "the comments OpenClaw would drop are said");
  assert.equal(await readFile(clawFile, "utf8"), clawBefore);
  // A backup restores the file, after a backup of the file as it is now; a file changed since HarnessHub's change says so.
  const history = await f.call<CapabilityHistory>("/capabilities/history"), backup = history.value.backups.find(item => item.file === "~/.codex/config.toml")!;
  const restoreCheck = await f.call<CapabilityRestoreCheck>("/capabilities/backups/" + backup.id + "/restore");
  assert.equal(restoreCheck.value.changedSince, false); assert.ok(restoreCheck.value.diff.includes("-path = \"~/.agents/skills/alpha/SKILL.md\""));
  const restored = await f.call<CapabilityChangeView>("/capabilities/restores", { fingerprint: restoreCheck.value.fingerprint, commandId: "restore-codex" });
  assert.deepEqual([restored.value.status, restored.value.kind], ["applied", "restore"]);
  assert.equal(await readFile(config, "utf8"), configBefore);
  await writeFile(config, configBefore + "\n# edited by hand\n");
  const again = await f.call<CapabilityRestoreCheck>("/capabilities/backups/" + backup.id + "/restore");
  assert.equal(again.value.changedSince, true);
  assert.equal((await f.call<CapabilityHistory>("/capabilities/history")).value.backups.filter(item => item.file === "~/.codex/config.toml").length, 2);
  await f.clean();
});

test("G064-W5 Hermes reads the shared directory through skills.external_dirs, redundant links are removed and put back, and Claude Code takes a shared skill by a link of its own", macOnly, async t => {
  const f = await gateway(t), { readlink, readdir: list } = await import("node:fs/promises");
  const hermesConfig = join(f.home, ".hermes", "config.yaml");
  const shared = (harnessId: string, present: boolean) => f.call<CapabilityChangeCheck>("/capabilities/shared-dir?" + new URLSearchParams({ harnessId, present: String(present) }));
  const link = (name: string, present: boolean) => f.call<CapabilityChangeCheck>("/capabilities/skill-link?" + new URLSearchParams({ harnessId: "claude", name, present: String(present) }));
  const cleanup = (harnessId: string) => f.call<CapabilityChangeCheck>("/capabilities/link-cleanup?" + new URLSearchParams({ harnessId }));
  const reads = async (harnessId: string) => (await f.call<CapabilitiesView>("/capabilities")).value.harnesses.find(item => item.harnessId === harnessId)?.shared;
  // Hermes already reads it in this home; stopping removes the entry and leaves its own links.
  assert.match((await shared("hermes", true)).value.blocked ?? "", /^无需修改/u);
  const stop = await shared("hermes", false);
  assert.equal(stop.value.blocked, null); assert.ok(stop.value.diff?.includes("-    - ~/.agents/skills"), stop.value.diff ?? "");
  assert.equal((await f.apply(stop.value.fingerprint, "hermes-stop")).value.status, "applied");
  assert.ok((await readFile(hermesConfig, "utf8")).includes("  external_dirs: []\n"));
  assert.deepEqual(await reads("hermes"), { reads: "links", links: 1, redundant: 0, placeable: "shared-dir" });
  // Its links are not redundant while it does not read the shared directory, so they are not offered for removal.
  assert.match((await cleanup("hermes")).value.blocked ?? "", /还没有读取共享目录/u);
  const start = await shared("hermes", true);
  assert.equal(start.value.blocked, null); assert.ok(start.value.notes.some(note => note.startsWith("Hermes 会多看到")) && start.value.notes.some(note => note.includes("不会被 HarnessHub 重启")));
  assert.equal((await f.apply(start.value.fingerprint, "hermes-start")).value.status, "applied");
  assert.ok((await readFile(hermesConfig, "utf8")).includes("  external_dirs: [\"~/.agents/skills\"]\n"), "a value starting with ~ is quoted, as YAML reads it safely");
  assert.deepEqual(await reads("hermes"), { reads: "external-dir", links: 1, redundant: 1, placeable: "shared-dir" });
  // The redundant link goes, and the skill still reaches Hermes through the shared directory; an undo puts the link back as it was.
  const hermesLinks = await cleanup("hermes");
  assert.deepEqual(hermesLinks.value.links, [{ path: "~/.hermes/skills/alpha", target: "../../.agents/skills/alpha", action: "remove" }]);
  const removed = await f.apply(hermesLinks.value.fingerprint, "hermes-cleanup");
  assert.equal(removed.value.status, "applied"); assert.deepEqual(removed.value.links, hermesLinks.value.links);
  assert.equal((await list(join(f.home, ".hermes", "skills"))).includes("alpha"), false);
  const alpha = (await f.call<CapabilitiesView>("/capabilities")).value.entries.find(item => item.kind === "skill" && item.name === "alpha")!;
  assert.deepEqual(alpha.edges.filter(edge => edge.harnessId === "hermes").map(edge => [edge.mechanism, edge.status]), [["external-dir", "active"]]);
  const undo = await f.call<CapabilityChangeCheck>("/capabilities/changes/" + removed.value.id + "/undo");
  assert.deepEqual(undo.value.links, [{ path: "~/.hermes/skills/alpha", target: "../../.agents/skills/alpha", action: "create" }]);
  assert.equal((await f.apply(undo.value.fingerprint, "hermes-undo")).value.status, "applied");
  assert.equal(await readlink(join(f.home, ".hermes", "skills", "alpha")), "../../.agents/skills/alpha");
  // A link changed after its check is not touched.
  const clawCheck = await cleanup("openclaw");
  assert.equal(clawCheck.value.links.length, 1);
  await rm(join(f.home, ".openclaw", "skills", "alpha")); await symlink(join(f.root, "elsewhere", "outside"), join(f.home, ".openclaw", "skills", "alpha"));
  const stale = await f.apply(clawCheck.value.fingerprint, "claw-cleanup-stale");
  assert.deepEqual([stale.status, (stale.value as unknown as { code: string }).code], [409, "CAPABILITY_TARGET_CHANGED"]);
  assert.equal(await readlink(join(f.home, ".openclaw", "skills", "alpha")), join(f.root, "elsewhere", "outside"));
  // Claude Code: a shared skill it does not see is placed by an absolute link; only that link, which HarnessHub made, can be removed.
  const place = await link("gamma", true);
  assert.equal(place.value.blocked, null);
  assert.deepEqual(place.value.links, [{ path: "~/.claude/skills/gamma", target: "~/.agents/skills/gamma", action: "create" }]);
  assert.equal((await f.apply(place.value.fingerprint, "place-gamma")).value.status, "applied");
  assert.equal(await readlink(join(f.home, ".claude", "skills", "gamma")), join(f.home, ".agents", "skills", "gamma"));
  const gamma = (await f.call<CapabilitiesView>("/capabilities")).value.entries.find(item => item.kind === "skill" && item.name === "gamma")!;
  assert.deepEqual(gamma.edges.filter(edge => edge.harnessId === "claude").map(edge => [edge.mechanism, edge.status]), [["linked", "active"]]);
  assert.deepEqual(gamma.shared, { folder: "~/.agents/skills/gamma", placed: ["~/.claude/skills/gamma"] });
  assert.match((await link("alpha", true)).value.blocked ?? "", /^无需修改：Claude Code 已经能看到它/u);
  assert.match((await link("alpha", false)).value.blocked ?? "", /不是 HarnessHub 建的/u);
  const unplace = await link("gamma", false);
  assert.deepEqual([unplace.value.blocked, unplace.value.current], [null, "harnesshub"]);
  assert.equal((await f.apply(unplace.value.fingerprint, "unplace-gamma")).value.status, "applied");
  assert.equal((await list(join(f.home, ".claude", "skills"))).includes("gamma"), false);
  for (const [answer, code] of [[await shared("codex", true), "CAPABILITY_UNSUPPORTED"], [await f.call<CapabilityChangeCheck>("/capabilities/skill-link?" + new URLSearchParams({ harnessId: "hermes", name: "alpha", present: "true" })), "CAPABILITY_UNSUPPORTED"],
    [await cleanup("claude"), "CAPABILITY_UNSUPPORTED"], [await link("no-such-skill", true), "CAPABILITY_NOT_FOUND"]] as const) assert.equal((answer.value as unknown as { code: string }).code, code);
  await f.clean();
});

test("G064-W7 what HarnessHub wrote and someone else then removed or changed is shown as such and left alone, until the user re-applies it or stops tracking it", macOnly, async t => {
  const f = await gateway(t), { readlink } = await import("node:fs/promises");
  const hermesConfig = join(f.home, ".hermes", "config.yaml"), settings = join(f.home, ".claude", "settings.json"), gammaLink = join(f.home, ".claude", "skills", "gamma");
  const drift = async () => (await f.call<CapabilityHistory>("/capabilities/history")).value.drift;
  const shared = (present: boolean) => f.call<CapabilityChangeCheck>("/capabilities/shared-dir?" + new URLSearchParams({ harnessId: "hermes", present: String(present) }));
  const reapply = (id: string) => f.call<CapabilityChangeCheck>("/capabilities/drift/" + id + "/reapply");
  const forget = (id: string) => f.call<{ forgotten: boolean }>("/capabilities/forget", { id });
  // HarnessHub's own entry in Hermes's external_dirs, its "off" for alpha in Claude Code and its link for gamma: all in place.
  assert.equal((await f.apply((await shared(false)).value.fingerprint, "drift-stop")).value.status, "applied");
  const start = await f.apply((await shared(true)).value.fingerprint, "drift-start");
  const off = await f.apply((await f.check("claude", "alpha", false)).value.fingerprint, "drift-alpha-off");
  const place = await f.apply((await f.call<CapabilityChangeCheck>("/capabilities/skill-link?" + new URLSearchParams({ harnessId: "claude", name: "gamma", present: "true" }))).value.fingerprint, "drift-place");
  assert.deepEqual([start.value.status, off.value.status, place.value.status], ["applied", "applied", "applied"]);
  assert.deepEqual(await drift(), []);
  // Hermes rewrites its whole file without the entry, the user sets alpha back by hand, and the link is deleted.
  const rewritten = "# rewritten by Hermes\nmodel:\n  default: model-key-value\nskills:\n  disabled:\n  - beta\n  external_dirs: []\n";
  await writeFile(hermesConfig, rewritten);
  await writeFile(settings, (await readFile(settings, "utf8")).replace("\"alpha\":\"off\"", "\"alpha\":\"on\""));
  await rm(gammaLink);
  const found = await drift();
  assert.deepEqual(found.map(item => [item.kind, item.harnessId, item.subject, item.file, item.state, item.changeId]), [
    ["shared-dir", "hermes", "~/.agents/skills", "~/.hermes/config.yaml", "removed", start.value.id],
    ["skill-switch", "claude", "alpha", "~/.claude/settings.json", "changed", off.value.id],
    ["skill-link", "claude", "gamma", "~/.claude/skills/gamma", "removed", place.value.id]]);
  // Nothing is put back by itself: reading the drift again and reading the view leave every file as it is.
  assert.equal((await drift()).length, 3);
  assert.equal(await readFile(hermesConfig, "utf8"), rewritten);
  assert.equal((await f.call<CapabilitiesView>("/capabilities")).value.harnesses.find(item => item.harnessId === "hermes")?.shared.reads, "links");
  assert.ok((await readFile(settings, "utf8")).includes("\"alpha\":\"on\""));
  await assert.rejects(readlink(gammaLink));
  // Re-applying goes through the usual check: the link comes back after its confirmation.
  const link = await reapply(found[2]!.id);
  assert.deepEqual([link.value.kind, link.value.blocked, link.value.links], ["skill-link", null, [{ path: "~/.claude/skills/gamma", target: "~/.agents/skills/gamma", action: "create" }]]);
  assert.equal((await f.apply(link.value.fingerprint, "drift-relink")).value.status, "applied");
  assert.equal(await readlink(gammaLink), join(f.home, ".agents", "skills", "gamma"));
  // alpha's "off" again replaces the user's "on", which is now the value turning it on restores; the older value is gone with the drift.
  const again = await reapply(found[1]!.id);
  assert.deepEqual([again.value.kind, again.value.current, again.value.blocked], ["skill-switch", "other", null]);
  assert.ok(again.value.diff?.includes("\"alpha\":\"off\""), again.value.diff ?? "");
  assert.equal((await f.apply(again.value.fingerprint, "drift-alpha-again")).value.status, "applied");
  assert.deepEqual((await drift()).map(item => item.kind), ["shared-dir"]);
  const turnOn = await f.check("claude", "alpha", true);
  assert.equal(turnOn.value.current, "harnesshub");
  assert.equal((await f.apply(turnOn.value.fingerprint, "drift-alpha-on")).value.status, "applied");
  assert.ok((await readFile(settings, "utf8")).includes("\"alpha\":\"on\""), "turning it on restores the value it replaced, the user's own");
  // A file that no longer parses cannot be checked, which is said rather than taken as removed.
  const offAgain = await f.apply((await f.check("claude", "alpha", false)).value.fingerprint, "drift-alpha-off-again");
  assert.equal(offAgain.value.status, "applied");
  const settingsText = await readFile(settings, "utf8");
  await writeFile(settings, "{ not json");
  assert.deepEqual((await drift()).map(item => [item.kind, item.state]), [["shared-dir", "removed"], ["skill-switch", "unreadable"]]);
  await writeFile(settings, settingsText);
  // Stopping tracking the Hermes entry changes no file; it is refused for what still holds HarnessHub's value.
  const hermes = found[0]!;
  assert.deepEqual((await forget(hermes.id)).value, { forgotten: true });
  assert.deepEqual(await drift(), []);
  assert.equal(await readFile(hermesConfig, "utf8"), rewritten);
  assert.deepEqual((await forget(hermes.id)).value, { forgotten: false });
  const alphaId = found[1]!.id, refused = await forget(alphaId);
  assert.deepEqual([refused.status, (refused.value as unknown as { code: string }).code], [409, "CAPABILITY_TARGET_REFUSED"]);
  assert.deepEqual([(await reapply("0".repeat(32))).status, (await forget("not-an-id")).status], [404, 400]);
  await f.clean();
});

test("G064-W3 a write that fails after its confirmation is answered and recorded as failed with its code and the file with ~, never the system's message, and the history keeps answering", macOnly, async t => {
  const { chmod, stat } = await import("node:fs/promises");
  const f = await gateway(t), settings = join(f.home, ".claude", "settings.json"), gemini = join(f.home, ".gemini"), geminiSettings = join(gemini, "settings.json");
  // Something HarnessHub wrote and the user then changed by hand: drift for the history to show beside the failure.
  assert.equal((await f.apply((await f.check("claude", "alpha", false)).value.fingerprint, "failure-drift")).value.status, "applied");
  await writeFile(settings, (await readFile(settings, "utf8")).replace("\"alpha\":\"off\"", "\"alpha\":\"on\""));
  const check = await f.check("gemini", "gamma", false), before = await readFile(geminiSettings, "utf8"), mode = (await stat(gemini)).mode & 0o777;
  assert.equal(check.value.blocked, null, JSON.stringify(check.value));
  // ~/.gemini turns read-only after the confirmation, so the temporary file beside settings.json cannot be made, and Node's own
  // message names it by its absolute path: "EACCES: permission denied, open '<home>/.gemini/.settings.json.harnesshub-….tmp'".
  // Mutation check (run by hand, not kept): recording `failure.message` again in applyEdit makes this answer 500 PRIVACY_GUARD.
  await chmod(gemini, 0o500);
  let failed: { status: number; value: CapabilityChangeView };
  try { failed = await f.apply(check.value.fingerprint, "failure-read-only"); } finally { await chmod(gemini, mode); }
  assert.equal(failed.status, 200, JSON.stringify(failed.value));
  assert.deepEqual([failed.value.status, failed.value.file, failed.value.error, failed.value.diff, failed.value.backupId],
    ["failed", "~/.gemini/settings.json", { code: "CAPABILITY_WRITE_FAILED", message: "写入 ~/.gemini/settings.json 失败（EACCES）" }, null, null]);
  assert.equal(await readFile(geminiSettings, "utf8"), before, "nothing was written");
  // The history answers with the failure, and with the drift and the orphaned settings beside it.
  const history = await f.call<CapabilityHistory>("/capabilities/history");
  assert.equal(history.status, 200, JSON.stringify(history.value));
  assert.deepEqual(history.value.changes[0], failed.value);
  assert.deepEqual(history.value.drift.map(item => [item.kind, item.harnessId, item.subject, item.state]), [["skill-switch", "claude", "alpha", "changed"]]);
  assert.deepEqual(history.value.orphans, []);
  // The same command answers the same record; with the folder writable again, a new check makes the change.
  assert.deepEqual(await f.apply(check.value.fingerprint, "failure-read-only"), { status: 200, value: failed.value });
  assert.equal((await f.apply((await f.check("gemini", "gamma", false)).value.fingerprint, "failure-writable")).value.status, "applied");
  await f.clean();
});

test("G064-W3 a restore and a change of skill folders that fail are recorded the same way: the error's code and the place with ~", macOnly, async t => {
  const { chmod, stat } = await import("node:fs/promises");
  const f = await gateway(t), claude = join(f.home, ".claude"), settings = join(claude, "settings.json"), agents = join(f.home, ".agents"), shared = join(agents, "skills");
  const off = await f.apply((await f.check("claude", "alpha", false)).value.fingerprint, "restore-source");
  assert.equal(off.value.status, "applied", JSON.stringify(off.value));
  const switched = await readFile(settings, "utf8"), backup = (await f.call<CapabilityHistory>("/capabilities/history")).value.backups.find(item => item.changeId === off.value.id)!;
  const restoreCheck = await f.call<CapabilityRestoreCheck>("/capabilities/backups/" + backup.id + "/restore"), claudeMode = (await stat(claude)).mode & 0o777;
  await chmod(claude, 0o500);
  let restored: { status: number; value: CapabilityChangeView };
  try { restored = await f.call<CapabilityChangeView>("/capabilities/restores", { fingerprint: restoreCheck.value.fingerprint, commandId: "restore-read-only" }); } finally { await chmod(claude, claudeMode); }
  assert.equal(restored.status, 200, JSON.stringify(restored.value));
  assert.deepEqual([restored.value.kind, restored.value.status, restored.value.error], ["restore", "failed", { code: "CAPABILITY_WRITE_FAILED", message: "恢复 ~/.claude/settings.json 失败（EACCES）" }]);
  assert.equal(await readFile(settings, "utf8"), switched, "nothing was restored");
  // A new skill whose folder cannot be put into the shared directory: the change rolls back and names the folder.
  const create = await f.call<CapabilityChangeCheck>("/capabilities/skill-create", { name: "kappa", description: "Checks how a failure is recorded", body: "Do nothing.\n" });
  assert.equal(create.value.blocked, null, JSON.stringify(create.value));
  const sharedMode = (await stat(shared)).mode & 0o777;
  await chmod(shared, 0o500);
  let created: { status: number; value: CapabilityChangeView };
  try { created = await f.apply(create.value.fingerprint, "skill-read-only"); } finally { await chmod(shared, sharedMode); }
  assert.equal(created.status, 200, JSON.stringify(created.value));
  assert.deepEqual([created.value.kind, created.value.status, created.value.error, created.value.notes],
    ["skill-create", "failed", { code: "CAPABILITY_WRITE_FAILED", message: "修改 ~/.agents/skills/kappa 失败（EACCES）" }, ["已全部回滚，没有留下改动。"]]);
  assert.deepEqual([(await readdir(shared)).includes("kappa"), (await readdir(agents)).filter(name => name.startsWith(".harnesshub-staging-"))], [false, []]);
  const history = await f.call<CapabilityHistory>("/capabilities/history");
  assert.equal(history.status, 200, JSON.stringify(history.value));
  assert.deepEqual(history.value.changes.slice(0, 2).map(change => [change.kind, change.status]), [["skill-create", "failed"], ["restore", "failed"]]);
  await f.clean();
});

test("G064-W3 a change an older build recorded with an absolute home path is shown with ~ in the history and in its replay instead of failing them, and what stays absolute is still refused", macOnly, async t => {
  const f = await gateway(t);
  /** Puts a record into the capability storage as an older build kept it; `fingerprint` is the confirmation that replays it. */
  const record = (view: Readonly<Record<string, unknown>>, commandId: string, fingerprint: string) => {
    const database = new DatabaseSync(join(f.root, "data", "capabilities", "capabilities.sqlite"));
    try { database.prepare("INSERT INTO capability_changes(id,command_id,payload_hash,at,view_json) VALUES(?,?,?,?,?)").run(String(view.id), commandId, createHash("sha256").update(fingerprint).digest("hex"), String(view.at), JSON.stringify(view)); }
    finally { database.close(); }
  };
  // What applyEdit kept for a failed write before: Node's own message, naming the temporary file beside the target by its absolute path.
  const temporary = ".config.toml.harnesshub-0f1e2d3c-4b5a-4968-8776-655443322110.tmp", fingerprint = "a".repeat(64);
  const old = { id: "6c0f9a52-1b8e-4f3a-9d2c-7e5b4a3f2e10", kind: "skill-switch", harnessId: "codex", subject: "alpha", file: "~/.codex/config.toml", status: "failed", diff: null, backupId: null,
    error: { code: "CAPABILITY_WRITE_FAILED", message: "ENOENT: no such file or directory, open '" + join(f.home, ".codex", temporary) + "'" }, notes: ["HOME=" + f.home], at: "2026-01-02T03:04:05.000Z" };
  record(old, "old-failure", fingerprint);
  // Mutation check (run by hand, not kept): without `recorded` in history(), this answer is 500 PRIVACY_GUARD.
  const shown = { ...old, error: { code: "CAPABILITY_WRITE_FAILED", message: "ENOENT: no such file or directory, open '~/.codex/" + temporary + "'" }, notes: ["HOME=~"] };
  const history = await f.call<CapabilityHistory>("/capabilities/history");
  assert.equal(history.status, 200, JSON.stringify(history.value));
  assert.deepEqual(history.value.changes, [shown]);
  assert.deepEqual(await f.apply(fingerprint, "old-failure"), { status: 200, value: shown }, "its command replays it the same way");
  // The privacy guard is still the last line: what stays absolute is refused (here a key, which records never have and which is not rewritten).
  record({ ...old, id: "7d1fab63-2c9f-4a4b-8e3d-8f6c5b4a3f21", at: "2026-01-02T04:04:05.000Z", [join(f.home, "key")]: true }, "malformed", "b".repeat(64));
  const refused = await f.call<{ code: string }>("/capabilities/history");
  assert.deepEqual([refused.status, refused.value.code], [500, "PRIVACY_GUARD"]);
  await f.clean();
});

test("G064-W3 a Claude Code command that fails is recorded with its code and the file with ~, and an older record shows ~ for either spelling of the home", { timeout: 90000 }, async t => {
  // A home reached through a link whose real path ends with the given one, as /var/folders/… is /private/var/folders/… on macOS:
  // HarnessHub knows the home by both spellings, and the longer must be written as ~ first.
  const root = await realpath(await mkdtemp(join(tmpdir(), "capability-failures-"))), home = join(root, "home"), resolved = join(root, root.slice(1), "home"), closers: (() => Promise<void>)[] = [];
  t.after(async () => { for (const close of closers.reverse()) await close(); await rm(root, { recursive: true, force: true }); });
  await mkdir(join(resolved, ".claude"), { recursive: true }); await symlink(resolved, home); await mkdir(join(root, "data"));
  assert.equal(await realpath(home), resolved);
  await writeFile(join(home, ".claude.json"), JSON.stringify({ mcpServers: {} }, null, 2));
  // Claude Code's own command, faked: on the private copy it adds the server; on the user's file it fails as the system reports it.
  const claude: ClaudeRunner = async (args, options) => {
    const config = options.env.CLAUDE_CONFIG_DIR;
    if (config === undefined) throw Object.assign(new Error("EACCES: permission denied, open '" + join(resolved, ".claude.json.tmp.4242") + "'"), { code: "EACCES" });
    const copy = join(config, ".claude.json"), value = JSON.parse(await readFile(copy, "utf8")) as { mcpServers?: Record<string, unknown> };
    await writeFile(copy, JSON.stringify({ ...value, mcpServers: { ...value.mcpServers, [args[2]!]: JSON.parse(args[3]!) as unknown } }, null, 2));
  };
  const changes = new CapabilityChanges({ root: join(root, "data"), generation: 1, assertOwner: () => {}, environment: { home, values: { HOME: home } }, homes: [home, resolved], processes: async () => "", claude });
  closers.push(() => changes.close());
  const installed = [{ harnessId: "claude", name: "Claude Code", version: "2.1.302" }];
  await changes.saveMcpServer("docs", { transport: "stdio", command: "npx", args: ["-y", "@acme/docs-mcp"], cwd: null, url: null, env: [], headers: [] }, false);
  const check = await changes.checkMcpSync("docs", "claude", false, installed);
  assert.equal(check.blocked, null, JSON.stringify(check));
  const failed = await changes.apply(check.fingerprint, "claude-fails");
  assert.deepEqual([failed.status, failed.file, failed.error], ["failed", "~/.claude.json", { code: "CAPABILITY_WRITE_FAILED", message: "写入 ~/.claude.json 失败（EACCES）" }]);
  // An older record of such a failure names the file by the resolved spelling and the home by the given one.
  // Mutation check (run by hand, not kept): with the shorter spelling written as ~ first, the file shows as "<root>~/.claude.json.tmp.4242".
  const database = new DatabaseSync(join(root, "data", "capabilities", "capabilities.sqlite"));
  try {
    database.prepare("INSERT INTO capability_changes(id,command_id,payload_hash,at,view_json) VALUES(?,?,?,?,?)").run("8e2a0b74-3d0a-4b5c-9f4e-9a7d6c5b4a32", "older", "0".repeat(64), "2026-01-02T03:04:05.000Z",
      JSON.stringify({ ...failed, id: "8e2a0b74-3d0a-4b5c-9f4e-9a7d6c5b4a32", at: "2026-01-02T03:04:05.000Z", error: { code: "CAPABILITY_WRITE_FAILED", message: "EACCES: permission denied, open '" + join(resolved, ".claude.json.tmp.4242") + "' (HOME=" + home + ")" } }));
  } finally { database.close(); }
  const history = await changes.history();
  assert.deepEqual(history.changes.map(change => change.error?.message), ["写入 ~/.claude.json 失败（EACCES）", "EACCES: permission denied, open '~/.claude.json.tmp.4242' (HOME=~)"]);
  assert.deepEqual(homePathsIn(history, [home, resolved]), []);
});
