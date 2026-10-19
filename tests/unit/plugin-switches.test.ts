import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import test from "node:test";
import { parse as parseToml } from "smol-toml";
import type { ClaudeManagedSettings, PluginSource } from "../../src/adapters/capability-reads.js";
import { dependencyIds, managedPluginSetting, readClaudePlugins, type PluginFileRead, type PluginFiles } from "../../src/infrastructure/capabilities/claude-plugins.js";
import { oneLineChange, onlyChanged, parsed, setTomlKey, tomlBlocks, tomlHeader, tomlTable, UnsafeEdit } from "../../src/infrastructure/capabilities/edits.js";
import type { LedgerEntry } from "../../src/infrastructure/capabilities/store.js";
import { claudePluginSwitch, codexPluginSwitch, heldValue, type SwitchContext, type SwitchPlan } from "../../src/infrastructure/capabilities/switches.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
const context = (entries: readonly Omit<LedgerEntry, "changeId" | "at">[] = []): SwitchContext =>
  ({ ledger: (file, key) => { const found = entries.find(item => item.file === file && item.key === key); return found ? { ...found, changeId: "c", at: "t" } : null; }, hash });
const ours = (file: string, key: string, value: unknown, previous: string | null) => context([{ harnessId: "x", file, key, valueHash: hash(value), previous }]);
type Edit = Extract<SwitchPlan, { kind: "edit" }>;
const edit = (plan: SwitchPlan): Edit => { assert.equal(plan.kind, "edit", plan.kind === "none" ? plan.reason : ""); return plan as Edit; };
/** The lines removed and added between two texts, in order: everything else must be byte for byte the same. */
function changedLines(before: string, after: string): { removed: string[]; added: string[] } {
  const left = before.split("\n"), right = after.split("\n");
  let start = 0; while (start < left.length && start < right.length && left[start] === right[start]) start++;
  let end = 0; while (end < left.length - start && end < right.length - start && left[left.length - 1 - end] === right[right.length - 1 - end]) end++;
  return { removed: left.slice(start, left.length - end), added: right.slice(start, right.length - end) };
}

// Codex's config.toml as it looks on this machine: model keys, other tables, a table array, plugin tables and their sub-tables.
const CODEX = ["model = \"gpt-5\"  # the model stays", "", "[features]", "web_search = true", "", "[mcp_servers.docs]", "command = \"uvx\"", "args = [\"docs-mcp\"]", "",
  "[[hooks]]", "event = \"PreToolUse\"", "command = [\"guard\"]", "",
  "[plugins.\"swift-lsp@claude-plugins-official\"]", "enabled = true  # keep this note", "",
  "[ plugins . 'playwright@claude-plugins-official' ]", "enabled = true", "", "[plugins.\"playwright@claude-plugins-official\".mcp_servers.playwright]", "enabled = false", "",
  "[plugins.\"bare@market\"]", "# no enabled yet", "", "[plugins.\"esc\\u0061pe@market\"]", "enabled = false", "",
  "[profiles.fast]", "model = \"gpt-5-mini\"", "note = \"\"\"", "[plugins.\"fake@market\"]", "enabled = true", "\"\"\"", ""].join("\n");
const CODEX_FILE = "/u/.codex/config.toml";

test("G064-P1 Codex's plugin tables are found by their header however it is quoted, and `enabled` changes in exactly one line; other forms and a second table are refused", () => {
  // Headers as TOML reads them: bare, "…" (escapes decoded) and '…' keys, whitespace around dots, a comment after; anything else is not a header.
  assert.deepEqual(tomlHeader("[ plugins . 'x@y' ]  # c"), { array: false, path: ["plugins", "x@y"] });
  assert.deepEqual(tomlHeader("[[skills.config]]"), { array: true, path: ["skills", "config"] });
  assert.deepEqual(tomlHeader("[a.\"b#c\"]"), { array: false, path: ["a", "b#c"] });
  assert.deepEqual(tomlHeader("[\"esc\\u0061pe\"]"), { array: false, path: ["escape"] });
  for (const line of ["  [1, 2],", "[a.]", "[a] x", "[\"bad\\q\"]", "a = [1]", "[[a]"]) assert.equal(tomlHeader(line), null, line);
  assert.equal(tomlBlocks(CODEX, "hooks").length, 1, "a table array is still found by its dotted name");
  // Each plugin's own table; one written inside a multi-line string is not a table.
  assert.equal(tomlTable(CODEX, ["plugins", "swift-lsp@claude-plugins-official"])?.keys.get("enabled")?.value, true);
  assert.equal(tomlTable(CODEX, ["plugins", "playwright@claude-plugins-official"])?.keys.get("enabled")?.value, true, "the sub-table's own enabled is not this table's");
  assert.equal(tomlTable(CODEX, ["plugins", "escape@market"])?.keys.get("enabled")?.value, false);
  assert.equal(tomlTable(CODEX, ["plugins", "fake@market"]), null);
  assert.throws(() => tomlTable("[plugins.\"a@m\"]\nenabled = true\n[plugins.\"a@m\"]\nenabled = false\n", ["plugins", "a@m"]), UnsafeEdit, "two tables of one name are refused");
  assert.equal(oneLineChange("a\nb\n", "a\nc\n"), true); assert.equal(oneLineChange("a\nb\n", "a\nx\nb\n"), true);
  assert.equal(oneLineChange("a\nb\n", "x\ny\n"), false); assert.equal(oneLineChange("a\nb\n", "a\n"), false); assert.equal(oneLineChange("a\n", "a\n"), false);

  const request = (id: string, enabled: boolean) => ({ harnessId: "codex", id, enabled });
  const check = (plan: Edit, id: string, expected: boolean) => {
    assert.ok(oneLineChange(CODEX, plan.after), "exactly one line changes"); assert.doesNotThrow(() => parseToml(plan.after));
    assert.ok(plan.check(parsed(CODEX, "toml"), parsed(plan.after, "toml"))); assert.equal(heldValue("codex", "plugin/" + id, plan.after, () => false), expected);
  };
  // In place, the comment on the line kept; in a table followed by its sub-tables; inserted where the table has none.
  const swift = edit(codexPluginSwitch(CODEX_FILE, CODEX, request("swift-lsp@claude-plugins-official", false), context(), []));
  assert.deepEqual(changedLines(CODEX, swift.after), { removed: ["enabled = true  # keep this note"], added: ["enabled = false  # keep this note"] });
  assert.deepEqual([swift.key, swift.written, swift.previous, swift.ledger], ["plugin/swift-lsp@claude-plugins-official", false, "true", "set"]); check(swift, "swift-lsp@claude-plugins-official", false);
  const playwright = edit(codexPluginSwitch(CODEX_FILE, CODEX, request("playwright@claude-plugins-official", false), context(), []));
  assert.deepEqual(changedLines(CODEX, playwright.after), { removed: ["enabled = true"], added: ["enabled = false"] });
  assert.ok(playwright.after.includes("[ plugins . 'playwright@claude-plugins-official' ]\nenabled = false\n\n[plugins.\"playwright@claude-plugins-official\".mcp_servers.playwright]\nenabled = false"));
  check(playwright, "playwright@claude-plugins-official", false);
  const bare = edit(codexPluginSwitch(CODEX_FILE, CODEX, request("bare@market", false), context(), []));
  assert.ok(bare.after.includes("[plugins.\"bare@market\"]\nenabled = false\n# no enabled yet\n")); assert.equal(bare.previous, null); check(bare, "bare@market", false);
  assert.ok(bare.notes.some(note => note.includes("缺省值没有核实")));
  // Turning on: a missing key is written out (Codex's default is not verified); HarnessHub's own false over an explicit true goes back to it.
  const bareOn = edit(codexPluginSwitch(CODEX_FILE, CODEX, request("bare@market", true), context(), []));
  assert.ok(bareOn.after.includes("[plugins.\"bare@market\"]\nenabled = true\n")); assert.equal(bareOn.ledger, "set"); check(bareOn, "bare@market", true);
  const back = edit(codexPluginSwitch(CODEX_FILE, swift.after, request("swift-lsp@claude-plugins-official", true), ours(CODEX_FILE, "plugin/swift-lsp@claude-plugins-official", false, "true"), []));
  assert.equal(back.after, CODEX, "turning it back on gives the file as it was"); assert.equal(back.ledger, "drop");
  const keep = edit(codexPluginSwitch(CODEX_FILE, bare.after, request("bare@market", true), ours(CODEX_FILE, "plugin/bare@market", false, null), []));
  assert.deepEqual([keep.ledger, keep.written, keep.current], ["set", true, "harnesshub"]); assert.ok(keep.notes.some(note => note.includes("不删这一行")));
  const theirs = edit(codexPluginSwitch(CODEX_FILE, CODEX, request("escape@market", true), context(), []));
  assert.ok(theirs.notes.some(note => note.includes("不是 HarnessHub 写的"))); assert.equal(theirs.current, "other"); check(theirs, "escape@market", true);
  assert.equal(codexPluginSwitch(CODEX_FILE, CODEX, request("escape@market", false), context(), []).kind, "none");
  assert.equal(codexPluginSwitch(CODEX_FILE, CODEX, request("swift-lsp@claude-plugins-official", true), context(), []).kind, "none");
  // Line endings stay what the file uses.
  const crlf = CODEX.replace(/\n/gu, "\r\n"), crlfPlan = edit(codexPluginSwitch(CODEX_FILE, crlf, request("bare@market", false), context(), []));
  assert.ok(crlfPlan.after.includes("[plugins.\"bare@market\"]\r\nenabled = false\r\n")); assert.equal(crlfPlan.after.replace("enabled = false\r\n# no enabled yet", "# no enabled yet"), crlf);
  // Refused (invalid samples): a plugin written with dotted keys or inline under [plugins], one that is not there, an enabled that is not a boolean.
  for (const [text, id, reason] of [["[plugins]\n\"dot@market\".enabled = true\n", "dot@market", /不是写成/u], ["[plugins]\n\"inline@market\" = { enabled = true }\n", "inline@market", /不是写成/u],
    [CODEX, "missing@market", /没有这个插件/u], ["model = \"m\"\n", "swift-lsp@claude-plugins-official", /没有这个插件/u], ["[plugins.\"odd@market\"]\nenabled = \"yes\"\n", "odd@market", /不是 true 或 false/u]] as const)
    assert.throws(() => codexPluginSwitch(CODEX_FILE, text, request(id, false), context(), []), (error: unknown) => error instanceof UnsafeEdit && reason.test(error.message), id);
  // An existing boolean keeps its line; another value's line is rewritten, so the guard (not the editor) has the last word.
  const block = tomlTable("[t]\nenabled = true # note\n", ["t"])!;
  assert.equal(setTomlKey("[t]\nenabled = true # note\n", block, "enabled", false), "[t]\nenabled = false # note\n");
  // A key added with CRLF line endings goes before the \r, for a table array (Codex's skill switch) as for a table.
  const element = "[[skills.config]]\r\npath = \"/p\"\r\n\r\n[other]\r\n";
  assert.equal(setTomlKey(element, tomlBlocks(element, "skills.config")[0]!, "enabled", false), "[[skills.config]]\r\npath = \"/p\"\r\nenabled = false\r\n\r\n[other]\r\n");
});

const SETTINGS = "{\n  \"model\": \"claude-opus-5-5\",\n  \"enabledPlugins\": {\n    \"tool@market\": true,\n    \"off@market\": false\n  },\n  \"permissions\": { \"allow\": [\"Bash(ls)\"] }\n}\n";
const SETTINGS_FILE = "/u/.claude/settings.json";

test("G064-P2 Claude Code's plugin switch edits only enabledPlugins.<id>, puts back what HarnessHub replaced, and writes true where removing the entry would leave the plugin off", () => {
  const request = (id: string, enabled: boolean) => ({ harnessId: "claude", id, enabled });
  const guard = (plan: Edit, before = SETTINGS) => assert.ok(plan.check(parsed(before, "jsonc"), parsed(plan.after, "jsonc")), "the guard passes");
  // Off: in place, or a new entry for a plugin on by its default.
  const off = edit(claudePluginSwitch(SETTINGS_FILE, SETTINGS, request("tool@market", false), true, context()));
  assert.deepEqual(changedLines(SETTINGS, off.after), { removed: ["    \"tool@market\": true,"], added: ["    \"tool@market\": false,"] });
  assert.deepEqual([off.key, off.written, off.previous, off.ledger, off.current], ["plugin/tool@market", false, "true", "set", "other"]); guard(off);
  const fresh = edit(claudePluginSwitch(SETTINGS_FILE, SETTINGS, request("new@market", false), true, context()));
  assert.equal(heldValue("claude", "plugin/new@market", fresh.after, () => false), false); assert.equal(fresh.previous, null); guard(fresh);
  assert.ok(fresh.notes.some(note => note.includes("按默认启用")));
  // Nothing to do: already off, already on, on by default.
  assert.equal(claudePluginSwitch(SETTINGS_FILE, SETTINGS, request("off@market", false), true, context()).kind, "none");
  assert.equal(claudePluginSwitch(SETTINGS_FILE, SETTINGS, request("tool@market", true), true, context()).kind, "none");
  assert.equal(claudePluginSwitch(SETTINGS_FILE, SETTINGS, request("new@market", true), true, context()).kind, "none");
  // On again after HarnessHub's own false: the true it replaced comes back, the file byte for byte as before.
  const back = edit(claudePluginSwitch(SETTINGS_FILE, off.after, request("tool@market", true), true, ours(SETTINGS_FILE, "plugin/tool@market", false, "true")));
  assert.equal(back.after, SETTINGS); assert.deepEqual([back.ledger, back.current], ["drop", "harnesshub"]); guard(back, off.after);
  // ...or no entry at all, when the plugin is on by its default; but true when its default is off (removing the entry would leave it off).
  const removed = edit(claudePluginSwitch(SETTINGS_FILE, fresh.after, request("new@market", true), true, ours(SETTINGS_FILE, "plugin/new@market", false, null)));
  assert.equal(removed.after, SETTINGS); assert.equal(removed.ledger, "drop");
  const written = edit(claudePluginSwitch(SETTINGS_FILE, fresh.after, request("new@market", true), false, ours(SETTINGS_FILE, "plugin/new@market", false, null)));
  assert.equal(heldValue("claude", "plugin/new@market", written.after, () => false), true); assert.deepEqual([written.ledger, written.written], ["set", true]);
  assert.ok(written.notes.some(note => note.includes("删掉这一项不会启用它")));
  // Someone else's false, and a plugin off by its default without an entry, are turned on with true.
  const theirs = edit(claudePluginSwitch(SETTINGS_FILE, SETTINGS, request("off@market", true), true, context()));
  assert.deepEqual([theirs.written, theirs.ledger, theirs.current], [true, "set", "other"]); assert.ok(theirs.notes.some(note => note.includes("不是 HarnessHub 写的"))); guard(theirs);
  const byDefault = edit(claudePluginSwitch(SETTINGS_FILE, SETTINGS, request("quiet@market", true), false, context()));
  assert.equal(heldValue("claude", "plugin/quiet@market", byDefault.after, () => false), true); assert.ok(byDefault.notes.some(note => note.includes("默认停用")));
  // Refused: an entry that is not a boolean. The guard refuses an edit that touches anything else (invalid sample).
  assert.throws(() => claudePluginSwitch(SETTINGS_FILE, "{\"enabledPlugins\":{\"odd@market\":\"yes\"}}", request("odd@market", false), true, context()), UnsafeEdit);
  assert.equal(off.check(parsed(SETTINGS, "jsonc"), parsed(off.after.replace("claude-opus-5-5", "other-model"), "jsonc")), false);
  assert.equal(onlyChanged(parsed(SETTINGS, "jsonc"), parsed(off.after, "jsonc"), ["enabledPlugins", "tool@market"]), true);
  assert.equal(heldValue("claude", "plugin/absent@market", SETTINGS, () => false), undefined);
});

/** Files in memory for the plugin model: JSON by path (`unreadable` for one that cannot be read), and directories by path. */
function memoryFiles(json: Readonly<Record<string, unknown>>, directories: Readonly<Record<string, readonly (readonly [string, boolean])[] | "unreadable">>, present: readonly string[] = []): PluginFiles {
  return {
    json: async path => (!Object.hasOwn(json, path) ? { state: "missing" } : json[path] === "unreadable" ? { state: "unreadable", reason: "无法读取（EACCES）" } : { state: "ok", value: json[path] }) as PluginFileRead,
    entries: async path => { const found = directories[path]; if (found === "unreadable") throw Object.assign(new Error("denied"), { code: "EACCES" }); return found === undefined ? null : found.map(([name, directory]) => ({ name, directory })); },
    exists: async path => present.includes(path) || Object.hasOwn(directories, path) || Object.keys(json).some(file => file.startsWith(path + "/")),
  };
}
const SOURCE: Extract<PluginSource, { kind: "claude" }> = { kind: "claude", installed: "/c/plugins/installed_plugins.json", settings: "/c/settings.json", marketplaces: "/c/plugins/known_marketplaces.json",
  synced: "/c/plugins/synced", managed: { file: "/sys/managed-settings.json", dropIns: "/sys/managed-settings.d", profiles: ["/sys/com.anthropic.claudecode.plist"] } };

test("G064-P3 Claude Code's plugins: installed and synced ones listed with their entry, default and dependencies by its documented rules; managed settings decide or make it unknown", async () => {
  const files = memoryFiles({
    [SOURCE.settings]: { enabledPlugins: { "a@m": true, "s1@synced": false, "x@inline": true, "stale@m": false } },
    [SOURCE.installed]: { version: 2, plugins: { "a@m": [{ scope: "user", installPath: "/p/a", version: "1.0.0" }], "b@m": [{ scope: "user", installPath: "/p/b" }], "c@other": [{ scope: "user", installPath: "/p/c" }],
      "d@m": [{ scope: "user", installPath: "/p/d" }], "gone@m": [{ scope: "user", installPath: "/p/gone" }], "proj@m": [{ scope: "project", projectPath: "/w" }] } },
    [SOURCE.marketplaces]: { m: { installLocation: "/mk/m" }, other: { installLocation: "/mk/other" } },
    "/mk/m/.claude-plugin/marketplace.json": { plugins: [{ name: "b", defaultEnabled: false }, { name: "d", defaultEnabled: false }, { name: "a", description: "Plugin a" }] },
    "/mk/other/.claude-plugin/marketplace.json": { plugins: [{ name: "c", dependencies: ["e"] }] },
    // The marketplace entry wins over plugin.json for defaultEnabled; dependencies come from both.
    "/p/a/.claude-plugin/plugin.json": { name: "a", defaultEnabled: false, dependencies: ["b", "c@other", { name: "d", marketplace: "m", version: "^1" }, "b"] },
    "/p/b/.claude-plugin/plugin.json": { name: "b", defaultEnabled: true }, "/p/d/.claude-plugin/plugin.json": { name: "d" },
    "/c/plugins/synced/acct1/manifest.json": { plugins: [{ name: "s1", generation: 2, marketplaceName: "kw", version: "0040" }, { name: "s2", generation: 1, marketplaceName: "kw" }] },
    "/c/plugins/synced/acct1/s2/.claude-plugin/plugin.json": { name: "s2", dependencies: ["b@m"] },
    "/c/plugins/synced/acct2/manifest.json": "unreadable",
  }, { [SOURCE.synced]: [["acct1", true], ["acct2", true], [".bucket-acct1", false]], "/p/a": [], "/p/b": [], "/p/c": [], "/p/d": [] });
  const state = await readClaudePlugins(SOURCE, files), by = (id: string) => state.plugins.find(item => item.id === id)!;
  assert.deepEqual(state.plugins.map(item => item.id), ["a@m", "b@m", "c@other", "d@m", "gone@m", "s1@synced", "s2@synced"]);
  assert.equal(state.projectOnly, 1);
  assert.deepEqual([by("a@m").entry, by("a@m").defaultEnabled, by("a@m").dependencies, by("a@m").description], [true, false, ["b@m", "c@other", "d@m"], "Plugin a"]);
  assert.equal(by("b@m").defaultEnabled, false, "the marketplace entry's defaultEnabled wins over plugin.json's");
  assert.deepEqual(by("c@other").dependencies, ["e@other"], "without plugin.json the marketplace entry is the manifest; a bare name is its marketplace's");
  assert.deepEqual([by("gone@m").dependencies, by("gone@m").problem], [null, "它的安装目录不存在"]);
  // On: the entry, else the default — and, unless the user set it, on when an enabled plugin depends on it.
  assert.deepEqual(Object.fromEntries(state.enabled), { "a@m": true, "b@m": true, "c@other": true, "d@m": true, "gone@m": true, "s1@synced": false, "s2@synced": true });
  // Synced plugins: by name across accounts, the generation's folder, bare dependencies in their marketplace; a manifest that cannot be read is named without its account.
  assert.deepEqual([by("s1@synced").synced, by("s1@synced").version, by("s1@synced").marketplace, by("s2@synced").dependencies], [true, "0040", "kw", ["b@m"]]);
  assert.deepEqual(state.unreadable, [{ file: "/c/plugins/synced/<账户>/manifest.json", reason: "无法读取（EACCES）" }]);
  const off = await readClaudePlugins(SOURCE, memoryFiles({ [SOURCE.settings]: { syncClaudeAiPlugins: false }, "/c/plugins/synced/acct1/manifest.json": { plugins: [{ name: "s2" }] } }, { [SOURCE.synced]: [["acct1", true]] }));
  assert.equal(off.enabled.get("s2@synced"), false, "syncClaudeAiPlugins: false turns every synced plugin off");
  // A marketplace that cannot be read is a problem for its plugins' dependencies.
  const blind = await readClaudePlugins(SOURCE, memoryFiles({ [SOURCE.installed]: { plugins: { "a@m": [{ scope: "user", installPath: "/p/a" }] } }, [SOURCE.marketplaces]: { m: { installLocation: "/mk/m" } },
    "/mk/m/.claude-plugin/marketplace.json": "unreadable" }, { "/p/a": [] }));
  assert.deepEqual([blind.plugins[0]!.dependencies, blind.plugins[0]!.problem], [null, "市场 m 的清单读不到（无法读取（EACCES））"]);

  // Dependencies' three spellings; a version constraint is not evaluated; anything else is a problem (invalid samples).
  assert.deepEqual(dependencyIds(["x", "y@o", { name: "z" }, { name: "w", marketplace: "o", version: ">=2" }, "x"], "m"), ["x@m", "y@o", "z@m", "w@o"]);
  for (const raw of ["x", [42], ["bad name"], [{ marketplace: "m" }]]) assert.ok("problem" in dependencyIds(raw, "m"), JSON.stringify(raw));
  assert.deepEqual(dependencyIds(undefined, "m"), []);

  // Managed settings: the file, then .d's .json files by name (a later value replaces an earlier one); a profile or an unreadable file makes it unknown.
  const managed: ClaudeManagedSettings = SOURCE.managed, layered = (more: Readonly<Record<string, unknown>> = {}, present: readonly string[] = [], dropIns: readonly (readonly [string, boolean])[] | "unreadable" = [["20-b.json", false], ["10-a.json", false], [".hidden.json", false], ["notes.txt", false]]) =>
    memoryFiles({ [managed.file]: { enabledPlugins: { "a@m": true } }, [join(managed.dropIns, "10-a.json")]: { enabledPlugins: { "a@m": false } }, [join(managed.dropIns, "20-b.json")]: { model: "x" },
      [join(managed.dropIns, ".hidden.json")]: { enabledPlugins: { "a@m": true } }, ...more }, { [managed.dropIns]: dropIns }, present);
  assert.deepEqual(await managedPluginSetting(managed, "a@m", layered()), { state: "set", value: false, file: join(managed.dropIns, "10-a.json") });
  assert.deepEqual(await managedPluginSetting(managed, "other@m", layered()), { state: "none" });
  assert.deepEqual(await managedPluginSetting(managed, "a@m", memoryFiles({}, {})), { state: "none" });
  assert.equal((await managedPluginSetting(managed, "other@m", layered({}, [managed.profiles[0]!]))).state, "unknown", "an MDM profile is not read, so nothing is certain");
  assert.equal((await managedPluginSetting(managed, "other@m", layered({ [join(managed.dropIns, "20-b.json")]: "unreadable" }))).state, "unknown");
  assert.equal((await managedPluginSetting(managed, "other@m", layered({}, [], "unreadable"))).state, "unknown");
  assert.equal((await managedPluginSetting(managed, "a@m", layered({ [join(managed.dropIns, "10-a.json")]: { enabledPlugins: { "a@m": "force" } } }))).state, "unknown");
});
