import assert from "node:assert/strict";
import test from "node:test";
import { skillVisibility, type ScannedRoot, type ScannedSkill, type SkillRules } from "../../src/contexts/capabilities/domain/visibility.js";

const skill = (dirName: string, root: string, real: string, extra: Partial<ScannedSkill> = {}): ScannedSkill =>
  ({ dirName, shown: root + "/" + dirName, realPath: real, skillFile: true, name: dirName, description: "about " + dirName, frontmatter: true, ...extra });
const root = (role: ScannedRoot["role"], shown: string, entries: readonly ScannedSkill[], precedence = 1, containment = false): ScannedRoot =>
  ({ role, shown, realPath: "/r" + shown.slice(1), precedence, containment, entries });
const rules = (duplicates: SkillRules["duplicates"], extra: Partial<SkillRules> = {}): SkillRules =>
  ({ duplicates, requiresDescription: true, nameMustMatchDirectory: false, disabled: () => null, ...extra });
const states = (edges: readonly { via: string; status: string; mechanism: string }[]) => edges.map(edge => [edge.via, edge.mechanism, edge.status]);
const SHARED = "~/.agents/skills";

test("G064-R1 each Harness's mechanism follows the role of the directory and whether the entry is a link", () => {
  const { edges } = skillVisibility("x", "X", [
    root("shared", SHARED, [skill("a", SHARED, "/r/.agents/skills/a")]),
    root("own", "~/.x/skills", [skill("b", "~/.x/skills", "/r/.agents/skills/b", { link: { target: "/r/.agents/skills/b" } }), skill("c", "~/.x/skills", "/r/.x/skills/c")]),
    root("compat", "~/.claude/skills", [skill("d", "~/.claude/skills", "/r/.claude/skills/d")]),
    root("external", "~/extra", [skill("e", "~/extra", "/r/extra/e")]),
    root("bundled", "~/.x/skills/.system", [skill("f", "~/.x/skills/.system", "/r/.x/skills/.system/f")]),
    root("synced", "~/.x/skills/synced", [skill("g", "~/.x/skills/synced", "/r/.x/skills/synced/g")]),
  ], rules("all-visible"));
  assert.deepEqual(edges.map(edge => [edge.name, edge.mechanism, edge.status]), [["a", "native-shared", "active"], ["b", "linked", "active"], ["c", "own-copy", "active"],
    ["d", "compat-root", "active"], ["e", "external-dir", "active"], ["f", "bundled", "active"], ["g", "synced", "active"]]);
});

test("G064-R1 several skills of one name follow each Harness's documented or verified rule", () => {
  const same = "/r/.agents/skills/a", other = "/r/.x/skills/a";
  // Claude Code: one folder reached through two links loads once; a different folder of the same name is shadowed.
  const claude = skillVisibility("claude", "Claude Code", [root("own", "~/.claude/skills", [
    skill("a", "~/.claude/skills", same, { link: { target: same } }), skill("a-again", "~/.claude/skills", same, { link: { target: same }, name: "a" }), skill("a-copy", "~/.claude/skills", other, { name: "a" })])],
    rules("dedupe-realpath", { requiresDescription: false }));
  assert.deepEqual(claude.edges.map(edge => edge.status), ["active", "duplicate", "shadowed"]);
  assert.match(claude.edges[1]!.reason!, /同一份，只加载一次/u);
  assert.deepEqual(claude.warnings.map(warning => warning.kind), ["shadow"]);
  // Codex: both copies are listed.
  const codex = skillVisibility("codex", "Codex", [root("shared", SHARED, [skill("a", SHARED, same)]), root("own", "~/.codex/skills", [skill("a", "~/.codex/skills", other)])], rules("all-visible"));
  assert.deepEqual(codex.edges.map(edge => edge.status), ["active", "active"]);
  assert.match(codex.warnings[0]!.text, /同时列出 2 个名为 a 的技能/u);
  // OpenCode 1.18.35: one copy is kept and which one is not determined, even for one folder reached twice.
  const opencode = skillVisibility("opencode", "OpenCode", [root("compat", "~/.claude/skills", [skill("a", "~/.claude/skills", same, { link: { target: same } })]), root("shared", SHARED, [skill("a", SHARED, same)])], rules("last-wins-unordered"));
  assert.deepEqual(opencode.edges.map(edge => edge.status), ["duplicate", "duplicate"]);
  assert.match(opencode.edges[0]!.reason!, /取决于加载先后/u);
  // Gemini, OpenClaw, Pi, Hermes: the higher-precedence root wins.
  const gemini = skillVisibility("gemini", "Gemini CLI", [root("own", "~/.gemini/skills", [skill("a", "~/.gemini/skills", "/r/.gemini/skills/a")], 1), root("shared", SHARED, [skill("a", SHARED, same)], 2)], rules("precedence"));
  assert.deepEqual(states(gemini.edges), [[SHARED + "/a", "native-shared", "active"], ["~/.gemini/skills/a", "own-copy", "shadowed"]]);
  // Cursor does not say: every copy is a duplicate, and the warning says so.
  const cursor = skillVisibility("cursor", "Cursor", [root("shared", SHARED, [skill("a", SHARED, same)]), root("compat", "~/.claude/skills", [skill("a", "~/.claude/skills", same, { link: { target: same } })])], rules("unknown"));
  assert.deepEqual(cursor.edges.map(edge => edge.status), ["duplicate", "duplicate"]);
  assert.match(cursor.warnings[0]!.text, /没有说明会用哪一份/u);
  // Claude's synced skills are loaded beside its own: both stay in use, and the shared name is warned about.
  const synced = skillVisibility("claude", "Claude Code", [root("own", "~/.claude/skills", [skill("e", "~/.claude/skills", "/r/own/e")]), root("synced", "~/.claude/skills/synced", [skill("e", "~/.claude/skills/synced", "/r/synced/e")])],
    rules("dedupe-realpath", { separate: ["synced"] }));
  assert.deepEqual(synced.edges.map(edge => [edge.mechanism, edge.status]), [["own-copy", "active"], ["synced", "active"]]);
  assert.match(synced.warnings[0]!.text, /用名字调用时用哪一份没有说明/u);
});

test("G064-R1 OpenClaw skips a link leaving its root, and says when the target is read from another root anyway", () => {
  const { edges, warnings } = skillVisibility("openclaw", "OpenClaw", [
    root("own", "~/.openclaw/skills", [skill("a", "~/.openclaw/skills", "/r/.agents/skills/a", { link: { target: "/r/.agents/skills/a" } })], 3, true),
    root("shared", SHARED, [skill("a", SHARED, "/r/.agents/skills/a"), skill("dev", SHARED, "/r/elsewhere/dev", { link: { target: "/r/elsewhere/dev" } })], 4, true),
  ], rules("precedence"));
  assert.deepEqual(states(edges), [["~/.openclaw/skills/a", "linked", "rejected"], [SHARED + "/dev", "native-shared", "rejected"], [SHARED + "/a", "native-shared", "active"]]);
  assert.deepEqual(warnings.map(warning => [warning.kind, warning.name]), [["redundant", "a"]]);
  assert.match(warnings[0]!.text, /已从 ~\/\.agents\/skills 读取 a/u);
});

test("G064-R1 entries a Harness cannot use have their own status, and its own switch turns a skill off", () => {
  const entries = [skill("broken", SHARED, "", { link: { target: null }, realPath: null }), skill("nofile", SHARED, "/r/n", { skillFile: false }), skill("bad", SHARED, "/r/b", { frontmatter: false, name: null }),
    skill("bare", SHARED, "/r/bare", { description: null }), skill("Folder", SHARED, "/r/f", { name: "other-name" }), skill("off", SHARED, "/r/off"), skill("on", SHARED, "/r/on")];
  const { edges } = skillVisibility("cursor", "Cursor", [root("shared", SHARED, entries)], rules("unknown", { nameMustMatchDirectory: true, disabled: name => name === "off" ? "配置停用了它" : null }));
  assert.deepEqual(edges.map(edge => [edge.name, edge.status]), [["broken", "broken-link"], ["nofile", "invalid"], ["bad", "invalid"], ["bare", "invalid"], ["other-name", "invalid"], ["off", "disabled"], ["on", "active"]]);
  assert.match(edges[3]!.reason!, /要求 frontmatter 写明 name 和 description/u);
  assert.match(edges[4]!.reason!, /要求 name 与目录同名/u);
  assert.equal(edges[5]!.reason, "配置停用了它");
  // A Harness that does not require a description accepts the same entry; the switch is asked by name and real path.
  const asked: (string | null)[] = [];
  const claude = skillVisibility("claude", "Claude Code", [root("own", "~/.claude/skills", [skill("bare", "~/.claude/skills", "/r/bare", { description: null })])],
    rules("dedupe-realpath", { requiresDescription: false, disabled: (name, real) => { asked.push(name + "@" + real); return null; } }));
  assert.deepEqual(claude.edges.map(edge => edge.status), ["active"]);
  assert.deepEqual(asked, ["bare@/r/bare"]);
});
