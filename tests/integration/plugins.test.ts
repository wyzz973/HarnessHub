import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { CapabilitiesView, CapabilityChangeCheck, CapabilityChangeView, CapabilityHistory } from "../../src/contracts/capabilities.js";
import { application } from "../../src/cli/session-application.js";
import { prepareConfiguration } from "../../src/infrastructure/session/binding-factory.js";
import { startWebServer } from "../../src/web/server.js";
import { homePathsIn } from "../../src/web/shown-paths.js";
import { capabilityHome, CREDENTIALS, officialInstalls } from "../fixtures/capability-home.js";

/** The lines removed and added between two texts, in order: everything else must be byte for byte the same. */
function changedLines(before: string, after: string): { removed: string[]; added: string[] } {
  const left = before.split("\n"), right = after.split("\n");
  let start = 0; while (start < left.length && start < right.length && left[start] === right[start]) start++;
  let end = 0; while (end < left.length - start && end < right.length - start && left[left.length - 1 - end] === right[right.length - 1 - end]) end++;
  return { removed: left.slice(start, left.length - end), added: right.slice(start, right.length - end) };
}
const put = async (path: string, content: string) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, content); };

/**
 * A Gateway on a private home with the official installations' fixture files, through its formal entry. Claude Code has
 * three plugins of one marketplace (tool depends on needed, which is off by default) and a synced one; Codex has the
 * same tool and a table without `enabled`. Managed settings are read under a private system root.
 */
async function gateway(t: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "plugin-switch-"))), closers: (() => Promise<void>)[] = [];
  t.after(async () => { for (const close of closers.reverse()) await close(); await rm(root, { recursive: true, force: true }); });
  const home = join(root, "home"), workspace = join(root, "workspace"), system = join(root, "system");
  await mkdir(home); await mkdir(workspace); await mkdir(system); await capabilityHome(home, join(root, "elsewhere"));
  const claude = join(home, ".claude"), market = join(claude, "plugins", "marketplaces", "market"), cache = (name: string) => join(claude, "plugins", "cache", "market", name, "1.0.0");
  const settings = JSON.parse(await readFile(join(claude, "settings.json"), "utf8")) as Record<string, unknown>;
  await writeFile(join(claude, "settings.json"), JSON.stringify({ ...settings, enabledPlugins: { "tool@market": true, "lone@market": true, "x@inline": true } }, null, 2) + "\n");
  await put(join(claude, "plugins", "known_marketplaces.json"), JSON.stringify({ market: { installLocation: market } }));
  await put(join(market, ".claude-plugin", "marketplace.json"), JSON.stringify({ plugins: [{ name: "tool" }, { name: "lone" }, { name: "needed", defaultEnabled: false }] }));
  await put(join(claude, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: Object.fromEntries(["tool", "lone", "needed"].map(name => [name + "@market", [{ scope: "user", version: "1.0.0", installPath: cache(name) }]])) }));
  await put(join(cache("tool"), ".claude-plugin", "plugin.json"), JSON.stringify({ name: "tool", dependencies: ["needed"] }));
  await mkdir(cache("lone"), { recursive: true }); await mkdir(cache("needed"), { recursive: true });
  await put(join(claude, "plugins", "synced", "acct", "manifest.json"), JSON.stringify({ plugins: [{ name: "s-one", marketplaceName: "kw" }] }));
  const codex = join(home, ".codex", "config.toml");
  await writeFile(codex, (await readFile(codex, "utf8")) + "\n# plugins\n[plugins.\"tool@market\"]\nenabled = true # mine\n\n[plugins.\"tool@market\".mcp_servers.x]\nenabled = false\n\n[plugins.\"bare@market\"]\n");
  const environment = { home, values: { HOME: home, PATH: [...await officialInstalls(home), "/usr/bin", "/bin"].join(":") }, system };
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
  const check = (harnessId: string, id: string, enabled: boolean) => call<CapabilityChangeCheck & { code?: string; message?: string }>("/capabilities/plugin-switch?" + new URLSearchParams({ harnessId, id, enabled: String(enabled) }));
  const confirm = (checked: { status: number; value: CapabilityChangeCheck }) => call<CapabilityChangeView & { code?: string }>("/capabilities/changes", { fingerprint: checked.value.fingerprint, commandId: "plugin-" + Math.random().toString(16).slice(2) });
  const apply = async (checked: { status: number; value: CapabilityChangeCheck }) => {
    assert.equal(checked.status, 200, JSON.stringify(checked.value)); assert.equal(checked.value.blocked, null, checked.value.blocked ?? "");
    const applied = await confirm(checked);
    assert.equal(applied.value.status, "applied", JSON.stringify(applied.value));
    return applied.value;
  };
  const edge = async (name: string, harnessId: string) => (await call<CapabilitiesView>("/capabilities")).value.entries.find(item => item.kind === "plugin" && item.name === name)?.edges.find(item => item.harnessId === harnessId);
  const history = async () => (await call<CapabilityHistory>("/capabilities/history")).value;
  const clean = () => {
    const text = JSON.stringify(answers);
    for (const secret of CREDENTIALS) assert.equal(text.includes(secret), false, secret);
    assert.deepEqual(homePathsIn(answers, [home], 1 << 20), []);
  };
  return { home, system, settings: join(claude, "settings.json"), installed: join(claude, "plugins", "installed_plugins.json"), codex, check, confirm, apply, edge, history, call, clean };
}

test("G064-P4 a plugin is turned off and on in Claude Code's settings.json and Codex's config.toml through the formal entry, one line each, refused where dependencies or managed settings say so, and tracked afterwards", { timeout: 180000 }, async t => {
  const f = await gateway(t), original = await readFile(f.settings, "utf8"), codexOriginal = await readFile(f.codex, "utf8");
  // Claude Code: off and on again — one line, then the file byte for byte as it was, nothing left in the ledger.
  const off = await f.check("claude", "lone@market", false);
  assert.match(off.value.diff ?? "", /^-\s+"lone@market": true,$/mu); assert.match(off.value.diff ?? "", /^\+\s+"lone@market": false,$/mu);
  for (const pattern of [/新开的 Claude Code 会话/u, /\/reload-plugins/u, /settings\.local\.json、--settings 与组织的管理设置/u, /桌面应用与 VS Code 扩展/u])
    assert.ok(off.value.notes.some(note => pattern.test(note)), pattern.source);
  assert.equal(off.value.file, "~/.claude/settings.json");
  await f.apply(off);
  assert.deepEqual(changedLines(original, await readFile(f.settings, "utf8")), { removed: ["    \"lone@market\": true,"], added: ["    \"lone@market\": false,"] });
  assert.deepEqual([(await f.edge("lone@market", "claude"))?.status, (await f.edge("lone@market", "claude"))?.facts], ["disabled", { kind: "plugin", version: "1.0.0", enabled: false, switchable: true }]);
  const on = await f.check("claude", "lone@market", true);
  assert.equal(on.value.current, "harnesshub");
  await f.apply(on);
  assert.equal(await readFile(f.settings, "utf8"), original);
  assert.deepEqual((await f.history()).drift, []);

  // Dependencies are never changed along with a plugin: needed is on only because tool needs it.
  assert.match((await f.check("claude", "needed@market", false)).value.blocked ?? "", /启用中的 tool@market 依赖它/u);
  await f.apply(await f.check("claude", "tool@market", false));
  assert.equal((await f.edge("needed@market", "claude"))?.status, "disabled", "off by its default once nothing enabled needs it");
  const blocked = (await f.check("claude", "tool@market", true)).value.blocked ?? "";
  assert.match(blocked, /它依赖的 needed@market 已停用/u); assert.match(blocked, /claude plugin enable 会连带启用已装的依赖/u);
  const needed = await f.check("claude", "needed@market", true);
  assert.ok(needed.value.notes.some(note => note.includes("默认停用，所以写入 true")));
  await f.apply(needed); await f.apply(await f.check("claude", "tool@market", true));
  assert.equal((await f.edge("tool@market", "claude"))?.status, "active");

  // Not switched here: Claude's uninstalled sources, synced plugins, plugins not installed, and the Harnesses whose plugins are read only.
  assert.match((await f.check("claude", "x@inline", false)).value.blocked ?? "", /从 inline 加载/u);
  assert.match((await f.check("claude", "s-one@synced", false)).value.blocked ?? "", /账户同步的插件/u);
  assert.match((await f.check("claude", "nothere@market", false)).value.blocked ?? "", /用户级没有安装/u);
  const hermes = await f.check("hermes", "plug-one@market", false);
  assert.equal(hermes.value.code, "CAPABILITY_UNSUPPORTED"); assert.match(hermes.value.message ?? "", /save_config 整份重写/u);
  assert.deepEqual([(await f.check("claude", "no id", false)).status, (await f.check("claude", "no id", false)).value.code], [400, "INVALID_INPUT"]);

  // Managed settings decide a plugin, or make HarnessHub unable to tell: the file, then its drop-in directory; an MDM profile.
  const managed = join(f.system, "Library", "Application Support", "ClaudeCode");
  await put(join(managed, "managed-settings.json"), JSON.stringify({ enabledPlugins: { "lone@market": false } }));
  assert.match((await f.check("claude", "lone@market", true)).value.blocked ?? "", /组织的管理设置阻止了它/u);
  await put(join(managed, "managed-settings.d", "50-org.json"), JSON.stringify({ enabledPlugins: { "lone@market": true } }));
  assert.match((await f.check("claude", "lone@market", false)).value.blocked ?? "", /强制启用了它/u);
  await rm(managed, { recursive: true });
  await put(join(f.system, "Library", "Managed Preferences", "com.anthropic.claudecode.plist"), "<plist/>");
  assert.match((await f.check("claude", "lone@market", false)).value.blocked ?? "", /MDM/u);
  await rm(join(f.system, "Library"), { recursive: true });

  // A check is good only while the file is as it was read.
  const stale = await f.check("claude", "lone@market", false);
  await writeFile(f.settings, (await readFile(f.settings, "utf8")).replace("\"tool@market\": true", "\"tool@market\":  true"));
  const refused = await f.confirm(stale);
  assert.equal(refused.value.code, "CAPABILITY_TARGET_CHANGED");

  // Drift: HarnessHub's false put back to true by someone else is listed; re-applied through its check; then forgotten.
  await f.apply(await f.check("claude", "lone@market", false));
  const rewrite = async (value: boolean) => { const text = await readFile(f.settings, "utf8"); await writeFile(f.settings, text.replace(/"lone@market": (?:true|false)/u, "\"lone@market\": " + String(value))); };
  await rewrite(true);
  const drift = (await f.history()).drift.filter(item => item.kind === "plugin");
  assert.deepEqual(drift.map(item => [item.harnessId, item.subject, item.state]), [["claude", "lone@market", "changed"]]);
  const again = await f.call<CapabilityChangeCheck>("/capabilities/drift/" + drift[0]!.id + "/reapply");
  assert.equal(again.value.enabled, false); await f.apply(again);
  assert.deepEqual((await f.history()).drift, []);
  await rewrite(true);
  const forgotten = await f.call<{ forgotten: boolean }>("/capabilities/forget", { id: (await f.history()).drift[0]!.id });
  assert.equal(forgotten.value.forgotten, true); assert.deepEqual((await f.history()).drift, []);

  // An orphan: HarnessHub's false for a plugin uninstalled since; clearing it puts back what it replaced.
  await f.apply(await f.check("claude", "lone@market", false));
  const record = JSON.parse(await readFile(f.installed, "utf8")) as { plugins: Record<string, unknown> };
  delete record.plugins["lone@market"]; await writeFile(f.installed, JSON.stringify(record));
  const orphans = (await f.history()).orphans;
  assert.deepEqual(orphans.map(item => [item.kind, item.harnessId, item.subject]), [["plugin", "claude", "lone@market"]]);
  const clear = await f.call<CapabilityChangeCheck>("/capabilities/orphans/" + orphans[0]!.id + "/clear");
  assert.equal(clear.value.current, "harnesshub"); await f.apply(clear);
  assert.match(await readFile(f.settings, "utf8"), /"lone@market": true/u); assert.deepEqual((await f.history()).orphans, []);

  // Codex: the value in its table changes in place (the comment kept, the sub-table untouched), then back to the file as it was.
  const codexOff = await f.check("codex", "tool@market", false);
  assert.ok(codexOff.value.notes.some(note => note.includes("新开的 Codex 线程")) && codexOff.value.notes.some(note => note.includes("受信任项目的 .codex/config.toml")));
  await f.apply(codexOff);
  assert.deepEqual(changedLines(codexOriginal, await readFile(f.codex, "utf8")), { removed: ["enabled = true # mine"], added: ["enabled = false # mine"] });
  assert.equal((await f.edge("tool@market", "codex"))?.status, "disabled");
  assert.equal((await f.edge("tool@market", "claude"))?.status, "active", "each Harness's switch is its own");
  await f.apply(await f.check("codex", "tool@market", true));
  assert.equal(await readFile(f.codex, "utf8"), codexOriginal);
  // A table without enabled: the line is added, and turning it on writes it out instead of removing it.
  await f.apply(await f.check("codex", "bare@market", false));
  assert.deepEqual(changedLines(codexOriginal, await readFile(f.codex, "utf8")), { removed: [], added: ["enabled = false"] });
  await f.apply(await f.check("codex", "bare@market", true));
  assert.deepEqual(changedLines(codexOriginal, await readFile(f.codex, "utf8")), { removed: [], added: ["enabled = true"] });
  await writeFile(f.codex, (await readFile(f.codex, "utf8")).replace("[plugins.\"bare@market\"]\nenabled = true", "[plugins.\"bare@market\"]\nenabled = false"));
  assert.deepEqual((await f.history()).drift.map(item => [item.kind, item.harnessId, item.subject, item.state]), [["plugin", "codex", "bare@market", "changed"]]);
  f.clean();
});
