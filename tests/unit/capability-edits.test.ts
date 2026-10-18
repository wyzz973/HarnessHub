import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CapabilityError, type CapabilityChangeView } from "../../src/contracts/capabilities.js";
import { appendJsonItem, appendTomlBlock, appendYamlItem, onlyChanged, parsed, removeJsonItem, removeTomlBlock, removeYamlItem, setJson, setTomlKey, tomlBlocks } from "../../src/infrastructure/capabilities/edits.js";
import { CapabilityStore } from "../../src/infrastructure/capabilities/store.js";
import { claudeSwitch, codexSwitch, heldValue, listSwitch, opencodePermission, opencodeSwitch, openclawSwitch, sharedDirPlan, type SwitchContext, type SwitchRequest } from "../../src/infrastructure/capabilities/switches.js";
import type { LedgerEntry } from "../../src/infrastructure/capabilities/store.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
const context = (entries: readonly Omit<LedgerEntry, "changeId" | "at">[] = []): SwitchContext =>
  ({ ledger: (file, key) => { const found = entries.find(item => item.file === file && item.key === key); return found ? { ...found, changeId: "c", at: "t" } : null; }, hash });
const request = (name: string, enabled: boolean, folder: string | null = null): SwitchRequest => ({ harnessId: "x", name, enabled, folder });
/** The lines removed and added between two texts, in order: everything else must be byte for byte the same. */
function changedLines(before: string, after: string): { removed: string[]; added: string[] } {
  const left = before.split("\n"), right = after.split("\n");
  let start = 0; while (start < left.length && start < right.length && left[start] === right[start]) start++;
  let end = 0; while (end < left.length - start && end < right.length - start && left[left.length - 1 - end] === right[right.length - 1 - end]) end++;
  return { removed: left.slice(start, left.length - end), added: right.slice(start, right.length - end) };
}

const CLAUDE = "{\n  \"model\": \"claude-opus-5-5\",\n  \"env\": { \"ANTHROPIC_BASE_URL\": \"https://example.invalid\" },\n  \"skillOverrides\": {\n    \"alpha\": \"user-invocable-only\"\n  },\n  \"permissions\": { \"allow\": [\"Bash(ls)\"] }\n}\n";
const CODEX = "model = \"gpt-5\"            # the model stays\nmodel_reasoning_effort = \"high\"\n\n[[skills.config]]\npath = \"/u/.agents/skills/beta/SKILL.md\"\nenabled = false\n\n"
  + "# MCP servers\n[mcp_servers.docs]\ncommand = \"uvx\"\nargs = [\"docs-mcp\"]\nnote = \"\"\"\n[[skills.config]]\npath = \"/not/a/header\"\n\"\"\"\n\n[profiles.fast]\nmodel = \"gpt-5-mini\"\n";
const HERMES = "# Hermes settings\nmodel:\n  default: deepseek-v4  # chosen\nskills:\n  disabled: [beta]\n  external_dirs:\n    - ~/.agents/skills\nmcp_servers: {}\n";
const OPENCODE = "{\n  // the user's note\n  \"model\": \"deepseek/deepseek-v4\",\n  \"permission\": {\n    \"skill\": {\n      \"*\": \"allow\",\n      \"be*\": \"deny\"\n    }\n  },\n}\n";

test("G064-W1 JSON and JSONC edits change only the setting: comments, order, indentation, the model and every other key stay byte for byte", () => {
  const off = setJson(CLAUDE, ["skillOverrides", "alpha"], "off");
  assert.deepEqual(changedLines(CLAUDE, off), { removed: ["    \"alpha\": \"user-invocable-only\""], added: ["    \"alpha\": \"off\""] });
  assert.equal(setJson(off, ["skillOverrides", "alpha"], "user-invocable-only"), CLAUDE, "turning it back restores the original bytes");
  const added = setJson(CLAUDE, ["skillOverrides", "beta"], "off");
  assert.deepEqual(changedLines(CLAUDE, added), { removed: ["    \"alpha\": \"user-invocable-only\""], added: ["    \"alpha\": \"user-invocable-only\",", "    \"beta\": \"off\""] });
  // A removal that empties its object removes the object too; four-space and tab files keep their indentation.
  assert.equal(setJson("{\n    \"model\": \"m\",\n    \"skillOverrides\": {\n        \"s\": \"off\"\n    }\n}\n", ["skillOverrides", "s"], undefined), "{\n    \"model\": \"m\"\n}\n");
  assert.equal(setJson("{\n\t\"model\": \"m\"\n}\n", ["skillOverrides", "s"], "off"), "{\n\t\"model\": \"m\",\n\t\"skillOverrides\": {\n\t\t\"s\": \"off\"\n\t}\n}\n");
  assert.equal(setJson("", ["skillOverrides", "s"], "off"), "{\n  \"skillOverrides\": {\n    \"s\": \"off\"\n  }\n}\n");
  assert.equal(setJson("\uFEFF{\r\n  \"a\": 1\r\n}\r\n", ["b"], 2), "\uFEFF{\r\n  \"a\": 1,\r\n  \"b\": 2\r\n}\r\n", "a byte-order mark and CRLF line endings are kept");
  // Lists: a one-line list stays on one line; comments in JSONC stay.
  const settings = "{\n  // keep\n  \"model\": { \"name\": \"gemini-3-pro\" },\n  \"skills\": { \"disabled\": [\"beta\"] }\n}\n";
  assert.equal(appendJsonItem(settings, ["skills", "disabled"], "alpha"), settings.replace("[\"beta\"]", "[\"beta\", \"alpha\"]"));
  assert.equal(removeJsonItem(appendJsonItem(settings, ["skills", "disabled"], "alpha"), ["skills", "disabled"], "alpha"), settings);
  assert.equal(removeJsonItem(settings, ["skills", "disabled"], "beta"), settings.replace("[\"beta\"]", "[]"));
  assert.equal(appendJsonItem("{\n  \"model\": \"m\"\n}\n", ["skills", "disabled"], "alpha"), "{\n  \"model\": \"m\",\n  \"skills\": {\n    \"disabled\": [\n      \"alpha\"\n    ]\n  }\n}\n");
});

test("G064-W1 TOML edits keep Codex's real shape: table arrays, comments, multi-line strings and model keys", () => {
  const blocks = tomlBlocks(CODEX, "skills.config");
  assert.equal(blocks.length, 1, "a header inside a multi-line string is not an element");
  assert.equal(blocks[0]!.keys.get("path")?.value, "/u/.agents/skills/beta/SKILL.md");
  const appended = appendTomlBlock(CODEX, "skills.config", [["path", "/u/.agents/skills/alpha/SKILL.md"], ["enabled", false]]);
  assert.equal(appended, CODEX + "\n[[skills.config]]\npath = \"/u/.agents/skills/alpha/SKILL.md\"\nenabled = false\n");
  const removed = removeTomlBlock(CODEX, blocks[0]!);
  assert.deepEqual(changedLines(CODEX, removed), { removed: ["[[skills.config]]", "path = \"/u/.agents/skills/beta/SKILL.md\"", "enabled = false", ""], added: [] });
  assert.ok(removed.includes("# MCP servers\n[mcp_servers.docs]"), "the comment after the element belongs to what follows and stays");
  assert.deepEqual(changedLines(CODEX, setTomlKey(CODEX, blocks[0]!, "enabled", true)), { removed: ["enabled = false"], added: ["enabled = true"] });
  const before = parsed(CODEX, "toml"), after = parsed(appended, "toml");
  assert.ok(onlyChanged(before, after, ["skills", "config"]));
  assert.deepEqual(JSON.parse(JSON.stringify(after)).model, "gpt-5");
  assert.equal(appendTomlBlock("", "skills.config", [["path", "/p"], ["enabled", false]]), "[[skills.config]]\npath = \"/p\"\nenabled = false\n");
  assert.equal(appendTomlBlock("a = 1\r\n", "skills.config", [["path", "C:\\\\x\"y"]]), "a = 1\r\n\r\n[[skills.config]]\r\npath = \"C:\\\\\\\\x\\\"y\"\r\n");
});

test("G064-W1 YAML edits splice the list in place: comments, quoting and the other keys stay", () => {
  assert.deepEqual(changedLines(HERMES, appendYamlItem(HERMES, ["skills", "disabled"], "alpha")), { removed: ["  disabled: [beta]"], added: ["  disabled: [beta, alpha]"] });
  assert.equal(removeYamlItem(appendYamlItem(HERMES, ["skills", "disabled"], "alpha"), ["skills", "disabled"], "alpha"), HERMES);
  const block = "skills:\n  disabled:\n    - beta  # why\n  external_dirs: []\nplugins:\n  enabled: [one]\n";
  assert.equal(appendYamlItem(block, ["skills", "disabled"], "alpha"), "skills:\n  disabled:\n    - beta  # why\n    - alpha\n  external_dirs: []\nplugins:\n  enabled: [one]\n");
  assert.equal(removeYamlItem(block, ["skills", "disabled"], "beta"), "skills:\n  disabled: []  # why\n  external_dirs: []\nplugins:\n  enabled: [one]\n");
  assert.equal(appendYamlItem("skills:\n  external_dirs:\n    - x\nmcp_servers: {}\n", ["skills", "disabled"], "a"), "skills:\n  external_dirs:\n    - x\n  disabled:\n    - a\nmcp_servers: {}\n");
  assert.equal(appendYamlItem("model:\n  default: m\n", ["skills", "disabled"], "a"), "model:\n  default: m\nskills:\n  disabled:\n    - a\n");
  assert.equal(appendYamlItem("skills:\n  disabled:\n", ["skills", "disabled"], "a: b"), "skills:\n  disabled: [\"a: b\"]\n", "a name YAML would misread is quoted");
  assert.throws(() => appendYamlItem("skills: {disabled: [a]}\n", ["skills", "disabled"], "b"), /不是普通的映射/u);
});

test("G064-W1 the guard refuses any edit that changes more than its setting (invalid samples)", () => {
  const before = parsed(CLAUDE, "jsonc");
  assert.equal(onlyChanged(before, parsed(CLAUDE.replace("claude-opus-5-5", "other-model"), "jsonc"), ["skillOverrides", "alpha"]), false);
  assert.equal(onlyChanged(before, parsed(CLAUDE.replace("\"alpha\": \"user-invocable-only\"", "\"alpha\": \"off\""), "jsonc"), ["skillOverrides", "alpha"]), true);
  const plan = claudeSwitch("/s.json", CLAUDE, request("alpha", false), context());
  assert.equal(plan.kind, "edit");
  if (plan.kind !== "edit") return;
  assert.equal(plan.check(before, parsed(plan.after, "jsonc")), true);
  // An editor that also touched the model, or wrote another value, is caught before anything is written.
  assert.equal(plan.check(before, parsed(plan.after.replace("claude-opus-5-5", "x"), "jsonc")), false);
  assert.equal(plan.check(before, parsed(CLAUDE, "jsonc")), false, "the setting must actually hold the planned value");
  const hermes = listSwitch("/c.yaml", HERMES, "yaml", request("alpha", false), context(), []);
  if (hermes.kind !== "edit") return assert.fail("Hermes plans an edit");
  assert.equal(hermes.check(parsed(HERMES, "yaml"), parsed(hermes.after.replace("deepseek-v4", "other"), "yaml")), false);
});

test("G064-W2 each Harness's switch plans its own setting, restores what HarnessHub replaced, and leaves what is already so", () => {
  // Claude: the replaced value comes back on enabling when the ledger says HarnessHub wrote the "off".
  const off = claudeSwitch("/s.json", CLAUDE, request("alpha", false), context());
  assert.ok(off.kind === "edit" && off.written === "off" && off.previous === "\"user-invocable-only\"" && off.current === "other" && off.ledger === "set");
  const offText = off.kind === "edit" ? off.after : "";
  const restored = claudeSwitch("/s.json", offText, request("alpha", true), context([{ harnessId: "x", file: "/s.json", key: "skillOverrides/alpha", valueHash: hash("off"), previous: "\"user-invocable-only\"" }]));
  assert.ok(restored.kind === "edit" && restored.current === "harnesshub" && restored.ledger === "drop");
  assert.equal(restored.kind === "edit" ? restored.after : "", CLAUDE);
  const foreign = claudeSwitch("/s.json", offText, request("alpha", true), context());
  assert.ok(foreign.kind === "edit" && foreign.current === "other" && foreign.notes.some(note => note.includes("不是 HarnessHub 写的")));
  assert.equal(claudeSwitch("/s.json", offText, request("alpha", false), context()).kind, "none");
  // Codex: a copy is switched by the path of its SKILL.md; enabling removes an element that only switched it.
  const codexOff = codexSwitch("/c.toml", CODEX, request("alpha", false, "/u/.agents/skills/alpha"), context());
  assert.ok(codexOff.kind === "edit" && codexOff.after.endsWith("[[skills.config]]\npath = \"/u/.agents/skills/alpha/SKILL.md\"\nenabled = false\n"));
  const codexOn = codexSwitch("/c.toml", CODEX, request("beta", true, "/u/.agents/skills/beta"), context());
  assert.ok(codexOn.kind === "edit" && !codexOn.after.includes("beta/SKILL.md") && codexOn.check(parsed(CODEX, "toml"), parsed(codexOn.after, "toml")));
  assert.equal(codexSwitch("/c.toml", CODEX, request("beta", false, "/u/.agents/skills/beta"), context()).kind, "none");
  // Gemini and Hermes: the name in skills.disabled.
  const gemini = listSwitch("/g.json", "{\n  \"skills\": { \"disabled\": [\"beta\"] }\n}\n", "jsonc", request("beta", true), context(), []);
  assert.ok(gemini.kind === "edit" && gemini.after.includes("\"disabled\": []") && gemini.ledger === "drop");
  // OpenCode: the last matching pattern decides; "deny" goes last, and a user's own "allow" is never removed.
  const value = parsed(OPENCODE, "jsonc");
  assert.equal(opencodePermission([value], "beta"), "deny"); assert.equal(opencodePermission([value], "alpha"), "allow");
  const ocOff = opencodeSwitch("/o.jsonc", OPENCODE, [], request("alpha", false), context());
  assert.ok(ocOff.kind === "edit" && ocOff.after.includes("// the user's note") && opencodePermission([parsed(ocOff.after, "jsonc")], "alpha") === "deny");
  const ocOn = opencodeSwitch("/o.jsonc", OPENCODE, [], request("beta", true), context());
  assert.ok(ocOn.kind === "edit" && opencodePermission([parsed(ocOn.after, "jsonc")], "beta") === "allow" && ocOn.ledger === "set"
    && ocOn.notes.some(note => note.includes("你现有的规则 \"be*\": \"deny\" 拒绝了它") && note.includes("\"beta\": \"allow\"")), "the user's own deny it overrides is named");
  assert.ok(ocOn.kind === "edit" && ocOn.check(value, parsed(ocOn.after, "jsonc")));
  const global = opencodeSwitch("/o.json", "{ \"permission\": { \"skill\": \"allow\" } }", [], request("alpha", false), context());
  assert.ok(global.kind === "edit" && JSON.stringify(parsed(global.after, "jsonc")) === JSON.stringify({ permission: { skill: { "*": "allow", alpha: "deny" } } }));
  // OpenClaw: its own command, with the comments it would drop said first.
  const claw = openclawSwitch("/o/openclaw.json", "{ // c\n skills: { entries: {} } }", request("alpha", false), context());
  assert.ok(claw.kind === "command" && claw.args.join(" ") === "config set skills.entries.alpha.enabled false --strict-json" && claw.comments);
  assert.throws(() => openclawSwitch("/o/openclaw.json", "{}", request("a.b", false), context()), /点号/u);
  const clawOn = openclawSwitch("/o/openclaw.json", "{\"skills\":{\"entries\":{\"alpha\":{\"enabled\":false}}}}", request("alpha", true), context());
  assert.ok(clawOn.kind === "command" && clawOn.args.join(" ") === "config unset skills.entries.alpha.enabled" && !clawOn.comments && clawOn.check({ skills: { entries: { alpha: {} } } }));
});

test("G064-W2 the ledger reads what HarnessHub wrote back from each file as its switch reads it, so a removed or changed value is told from one still in place", () => {
  const shared = (raw: string) => raw === "~/.agents/skills";
  const held = (harnessId: string, key: string, text: string) => heldValue(harnessId, key, text, shared);
  // Claude Code: the override itself, whatever it is now.
  assert.deepEqual([held("claude", "skillOverrides/alpha", CLAUDE), held("claude", "skillOverrides/beta", CLAUDE)], ["user-invocable-only", undefined]);
  // Codex: false while any copy at that path is off; the copy's own value once someone turned it back; nothing once its element is gone.
  const skill = "/u/.agents/skills/beta/SKILL.md";
  assert.equal(held("codex", "skills.config/" + skill, CODEX), false);
  assert.equal(held("codex", "skills.config/" + skill, CODEX.replace("enabled = false", "enabled = true")), true);
  assert.equal(held("codex", "skills.config//u/.agents/skills/alpha/SKILL.md", CODEX), undefined);
  // Gemini and Hermes: whether the name is in skills.disabled.
  assert.deepEqual([held("hermes", "skills.disabled/beta", HERMES), held("hermes", "skills.disabled/alpha", HERMES), held("gemini", "skills.disabled/beta", "{ \"skills\": { \"disabled\": [\"beta\"] } }")], [true, undefined, true]);
  // OpenCode: its own rule for the name; a single rule for every skill is not one.
  assert.deepEqual([held("opencode", "permission.skill/be*", OPENCODE), held("opencode", "permission.skill/alpha", "{ \"permission\": { \"skill\": \"deny\" } }")], ["deny", undefined]);
  // OpenClaw: the entry's enabled, true once someone turned it back on.
  assert.deepEqual([held("openclaw", "skills.entries/alpha", "{ skills: { entries: { alpha: { enabled: false } } } }"), held("openclaw", "skills.entries/alpha", "{ skills: { entries: { alpha: { enabled: true } } } }"),
    held("openclaw", "skills.entries/alpha", "{}")], [false, true, undefined]);
  // Hermes's external_dirs: the entries that are the shared directory, a single string included; none once it is rewritten without them.
  assert.deepEqual(held("hermes", "skills.external_dirs/shared", "skills:\n  external_dirs: [/team/skills, \"~/.agents/skills\"]\n"), ["~/.agents/skills"]);
  assert.deepEqual(held("hermes", "skills.external_dirs/shared", "skills:\n  external_dirs: ~/.agents/skills\n"), ["~/.agents/skills"]);
  assert.equal(held("hermes", "skills.external_dirs/shared", "# rewritten\nskills:\n  external_dirs: [/team/skills]\n"), undefined);
  // Invalid samples: a key this build does not write, one for another Harness, and a file that does not parse are refused, never read as removed.
  assert.throws(() => held("cursor", "skillOverrides/alpha", "{}"), /不认识/u);
  assert.throws(() => held("claude", "skills.disabled/alpha", "{}"), /不认识/u);
  assert.throws(() => held("claude", "skillOverrides", "{}"), /不认识/u);
  assert.throws(() => held("hermes", "skills.disabled/alpha", "skills: [unclosed\n"));
  assert.throws(() => held("codex", "skills.config//x/SKILL.md", "[[skills.config]\npath = 1\n"));
});

test("G064-W2 the ledger keeps the value from before HarnessHub's first write while it replaces its own value, and starts again once someone else changed the setting", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "capability-ledger-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = CapabilityStore.open(root, 1);
  t.after(() => store.close());
  const entry = (valueHash: string, previous: string | null, changeId: string): LedgerEntry => ({ harnessId: "opencode", file: "/o.json", key: "permission.skill/alpha", valueHash, previous, changeId, at: "2026-10-18T00:00:00.000Z" });
  store.setLedger(entry(hash("deny"), "\"ask\"", "c1"), false);
  // Turning it on over another rule replaces HarnessHub's own "deny" with an "allow": the user's "ask" is still the value to restore.
  store.setLedger(entry(hash("allow"), "\"deny\"", "c2"), true);
  assert.deepEqual(store.ledgerEntries().map(item => [item.valueHash, item.previous, item.changeId]), [[hash("allow"), "\"ask\"", "c2"]]);
  // Someone else changed it since: the old value is no longer the one to restore.
  store.setLedger(entry(hash("deny"), "\"allow-by-hand\"", "c3"), false);
  assert.deepEqual(store.ledgerEntries().map(item => [item.previous, item.changeId]), [["\"allow-by-hand\"", "c3"]]);
});

test("G064-W2 the capability store keeps the newest ten backups per file, replays a command's change, and is fenced by a newer owner", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "capability-store-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = CapabilityStore.open(root, 1);
  const ids = Array.from({ length: 12 }, (_, index) => "00000000-0000-4000-8000-0000000000" + String(index).padStart(2, "0"));
  ids.forEach((id, index) => store.saveBackup({ id, file: "/f", createdAt: "2026-10-18T00:00:" + String(index).padStart(2, "0") + ".000Z", changeId: "c" + index, subject: "s" }, Buffer.from("v" + index)));
  assert.deepEqual(store.backups().map(item => item.id), ids.slice(2).reverse());
  assert.equal(store.backupBytes(ids[11]!).toString(), "v11"); assert.throws(() => store.backupBytes(ids[0]!), (error: unknown) => error instanceof CapabilityError && error.code === "CAPABILITY_NOT_FOUND");
  const view: CapabilityChangeView = { id: "c1", kind: "skill-switch", harnessId: "claude", subject: "alpha", file: "~/.claude/settings.json", status: "applied", diff: null, backupId: null, error: null, notes: [], at: "2026-10-18T00:00:00.000Z" };
  store.saveChange("command-1", "h", view);
  assert.deepEqual(store.change("command-1"), { payloadHash: "h", view });
  store.close();
  // A newer owner fences this one off; an older generation cannot open the storage again.
  const newer = CapabilityStore.open(root, 2);
  assert.throws(() => CapabilityStore.open(root, 1), (error: unknown) => error instanceof CapabilityError && error.code === "OWNERSHIP_LOST");
  newer.close();
});

test("G064-W1 a shown diff masks credentials by key name, token shape, flag and URL, and keeps references, numbers and ordinary values", async () => {
  const { maskSecrets } = await import("../../src/infrastructure/capabilities/masking.js");
  const masked = [["env = { DOCS_KEY = \"literal-docs-secret\" }", "env = { DOCS_KEY = \"•••\" }"], ["\"X-Api-Key\": \"abc123\"", "\"X-Api-Key\": \"•••\""], ["    API_KEY: abcdef123456", "    API_KEY: •••"],
    ["\"command\": \"/u/bin/guard.sh --token sk-hook-secret\"", "\"command\": \"/u/bin/guard.sh --token •••\""], ["args = [\"docs\", \"--api-key\", \"plain123\"]", "args = [\"docs\", \"--api-key\", \"•••\"]"],
    ["url = \"https://user:pass@h.example/p?q=secret\"", "url = \"https://•••@h.example/p?•••\""], ["Authorization: Bearer abc.def", "Authorization: •••"], ["note ghp_0123456789abcdefABCD here", "note ••• here"],
    ["x = \"AKIAABCDEFGHIJKLMNOP\"", "x = \"•••\""]] as const;
  for (const [line, expected] of masked) assert.equal(maskSecrets(line), expected, line);
  for (const line of ["    FS_TOKEN: ${FS_TOKEN}", "\"TOKEN\": \"{env:OC_TOKEN}\"", "\"X-Key\": \"$GEM_KEY\"", "token_limit = 4000", "auth_enabled: true", "model = \"gpt-5\"  # chosen",
    "path = \"~/.agents/skills/alpha/SKILL.md\"", "\"skillOverrides\": { \"alpha\": \"off\" }", "@@ -1,3 +1,4 @@"]) assert.equal(maskSecrets(line), line, line);
});

test("G064-W1 a shown diff ends a line at a final newline: a new file has no empty last line, and a change of the final newline alone is shown with git's marker", async () => {
  const { unifiedDiff } = await import("../../src/infrastructure/control/unified-diff.js");
  assert.equal(unifiedDiff("~/.dsh/cordis.patch.yml", null, "- insert:\n    - id: x\n"), "--- /dev/null\n+++ b/~/.dsh/cordis.patch.yml\n@@ -0,0 +1,2 @@\n+- insert:\n+    - id: x\n");
  assert.equal(unifiedDiff("f", "a\nb\n", "a\nb\nc\n"), "--- a/f\n+++ b/f\n@@ -1,2 +1,3 @@\n a\n b\n+c\n", "no blank context line after the last line");
  assert.equal(unifiedDiff("f", "a\nb", "a\nb\n"), "--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+b\n");
  assert.equal(unifiedDiff("f", "a\n", "a\n"), "--- a/f\n+++ b/f\n", "no change, no hunk");
  assert.equal(unifiedDiff("f", "a\n", ""), "--- a/f\n+++ b/f\n@@ -1,1 +0,0 @@\n-a\n");
});
test("G064-W2 OpenClaw's rewrite is predicted on a private copy, summarized for the confirmation, and refused when it would touch keys that need a Gateway restart", async t => {
  const { mkdir, writeFile, readFile } = await import("node:fs/promises");
  const { CapabilityChanges } = await import("../../src/infrastructure/capabilities/changes.js");
  const root = await realpath(await mkdtemp(join(tmpdir(), "capability-openclaw-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home"), state = join(home, ".openclaw"), config = join(state, "openclaw.json");
  await mkdir(join(state, "skills", "omega"), { recursive: true }); await mkdir(join(root, "data"));
  await writeFile(join(state, "skills", "omega", "SKILL.md"), "---\nname: omega\ndescription: d\n---\n");
  const original = "{\n  // mine\n  skills: { entries: {} },\n  gateway: { port: 18789 },\n}\n";
  await writeFile(config, original);
  let touchGateway = false;
  const runs: { args: readonly string[]; env: Readonly<Record<string, string>>; writable: readonly string[] }[] = [];
  // OpenClaw 2026.3.23-2 as observed: it rewrites the whole file as JSON and adds its own defaults.
  const openclaw = async (args: readonly string[], options: { readonly env: Readonly<Record<string, string>>; readonly writable: readonly string[] }) => {
    runs.push({ args, ...options });
    const file = options.env.OPENCLAW_CONFIG_PATH ?? config, value = JSON.parse(JSON.stringify((await import("json5")).default.parse(await readFile(file, "utf8")))) as Record<string, any>;
    value.skills.entries.omega = { enabled: false }; value.commands = { native: "auto" }; value.meta = { lastTouchedAt: String(runs.length) };
    if (touchGateway) value.gateway.port = 19000;
    await writeFile(file, JSON.stringify(value, null, 2) + "\n");
  };
  const changes = new CapabilityChanges({ root: join(root, "data"), generation: 1, assertOwner: () => {}, environment: { home, values: { HOME: home } }, homes: [home], processes: async () => "", openclaw });
  t.after(() => changes.close());
  const installed = [{ harnessId: "openclaw", name: "OpenClaw", version: "2026.3.23-2" }];
  const check = await changes.checkSkillSwitch({ harnessId: "openclaw", name: "omega", enabled: false, via: null }, installed);
  assert.equal(check.blocked, null);
  assert.deepEqual(check.rewrite, { target: "skills.entries.omega.enabled", before: null, after: "false", added: ["commands", "meta"], removed: [], changed: [], commentLines: 1 });
  assert.equal(await readFile(config, "utf8"), original, "the prediction ran on a copy");
  assert.equal(runs[0]!.writable.length, 1); assert.notEqual(runs[0]!.writable[0], state); assert.equal(runs[0]!.env.OPENCLAW_CONFIG_PATH, join(runs[0]!.writable[0]!, "openclaw.json"));
  const applied = await changes.apply(check.fingerprint, "claw-off");
  assert.equal(applied.status, "applied", JSON.stringify(applied.error));
  assert.deepEqual(runs[1]!.writable, [state], "the real run may write only OpenClaw's own directory");
  // A command that would also change the Gateway's settings is refused before anything is written.
  await writeFile(config, original); touchGateway = true;
  const refused = await changes.checkSkillSwitch({ harnessId: "openclaw", name: "omega", enabled: false, via: null }, installed);
  assert.match(refused.blocked ?? "", /需要重启 Gateway 的设置（gateway\.port）/u);
  assert.equal(await readFile(config, "utf8"), original);
});

test("G064-W1 an atomic replacement keeps the file's mode whatever the Gateway's umask, and refuses a file changed since its check", async t => {
  const { writeFile, stat, readFile, chmod } = await import("node:fs/promises");
  const { replaceTarget, readTarget } = await import("../../src/infrastructure/capabilities/files.js");
  const root = await realpath(await mkdtemp(join(tmpdir(), "capability-files-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "settings.json");
  await writeFile(file, "{}\n"); await chmod(file, 0o644);
  const read = readTarget(file);
  assert.ok(read.state === "ok" && read.mode === 0o644);
  // 4317 runs with umask 077: the replacement must still be 0644, like the file it replaces.
  const previous = process.umask(0o077);
  try { replaceTarget(file, createHash("sha256").update("{}\n").digest("hex"), Buffer.from("{\"a\":1}\n"), read.state === "ok" ? read.mode : 0o600); }
  finally { process.umask(previous); }
  assert.equal((await stat(file)).mode & 0o777, 0o644);
  assert.equal(await readFile(file, "utf8"), "{\"a\":1}\n");
  assert.throws(() => replaceTarget(file, createHash("sha256").update("{}\n").digest("hex"), Buffer.from("x"), 0o644), (error: unknown) => error instanceof CapabilityError && error.code === "CAPABILITY_TARGET_CHANGED");
  assert.equal(await readFile(file, "utf8"), "{\"a\":1}\n");
});

test("G064-W6 Hermes's shared directory entry is added once, removed by any spelling that resolves to it, and a single-string form is left alone", () => {
  const resolves = (raw: string) => raw === "~/.agents/skills" || raw === "/u/.agents/skills";
  const block = "# kept\nskills:\n  external_dirs:\n    - /team/skills  # theirs\n  disabled: []\n";
  const add = sharedDirPlan("/c.yaml", block, true, "~/.agents/skills", resolves, context(), []);
  assert.ok(add.kind === "edit" && add.after === "# kept\nskills:\n  external_dirs:\n    - /team/skills  # theirs\n    - \"~/.agents/skills\"\n  disabled: []\n" && add.ledger === "set");
  assert.ok(add.kind === "edit" && add.check(parsed(block, "yaml"), parsed(add.after, "yaml")));
  const absolute = "skills:\n  external_dirs: [/team/skills, /u/.agents/skills]\n";
  const remove = sharedDirPlan("/c.yaml", absolute, false, "~/.agents/skills", resolves, context(), []);
  assert.ok(remove.kind === "edit" && remove.after === "skills:\n  external_dirs: [/team/skills]\n" && remove.current === "other");
  assert.equal(sharedDirPlan("/c.yaml", absolute, true, "~/.agents/skills", resolves, context(), []).kind, "none");
  assert.throws(() => sharedDirPlan("/c.yaml", "skills:\n  external_dirs: ~/.agents/skills\n", false, "~/.agents/skills", resolves, context(), []), /单个字符串/u);
});
