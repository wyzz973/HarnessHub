import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import { capabilityReadTables } from "../../src/adapters/capability-reads.js";
import { readSubagent, renderSubagent, sameNamedSubagents, subagentFile, subagentProblem, subagentStyleProblem, type SubagentDefinition } from "../../src/infrastructure/capabilities/subagent-definitions.js";

const REVIEWER: SubagentDefinition = { description: "Reviews a diff for bugs: \"quotes\", colons: and 中文", prompt: "You review code.\n\n- Point out bugs first.\n- Say nothing else." };
const frontOf = (text: string) => parseYaml(/^---\n([\s\S]*?)\n---\n/u.exec(text)![1]!) as Record<string, unknown>;
const tables = capabilityReadTables({ home: "/Users/someone", values: {} }, { hermesHome: "/Users/someone/.hermes", openclawWorkspace: "/Users/someone/.openclaw/workspace" });
const reserved = new Map(tables.flatMap(table => (table.reservedSubagents ?? []).map(name => [name, table.harnessId] as const)));

test("G064-A1 a subagent is written in each Harness's own format with only the keys it requires, and reads back the same", () => {
  // Claude Code and Gemini: name and description in the frontmatter, the prompt as the body.
  for (const style of ["claude", "gemini"] as const) {
    const text = renderSubagent("reviewer", REVIEWER, style);
    assert.deepEqual(frontOf(text), { name: "reviewer", description: REVIEWER.description });
    assert.ok(text.endsWith("\n\n" + REVIEWER.prompt + "\n"));
    assert.deepEqual(readSubagent(text, style, "reviewer"), { name: "reviewer", description: REVIEWER.description, prompt: REVIEWER.prompt, keys: ["description", "name"] });
  }
  // OpenCode: its name is the file's; mode subagent keeps it out of the primary agents.
  const opencode = renderSubagent("reviewer", REVIEWER, "opencode");
  assert.deepEqual(frontOf(opencode), { description: REVIEWER.description, mode: "subagent" });
  assert.deepEqual(readSubagent(opencode, "opencode", "reviewer")?.name, "reviewer");
  // Codex: exactly name, description and developer_instructions, the prompt in a multi-line basic string.
  const codex = renderSubagent("reviewer", REVIEWER, "codex"), parsed = parseToml(codex) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed).sort(), ["description", "developer_instructions", "name"]);
  assert.deepEqual([parsed.name, parsed.description, parsed.developer_instructions], ["reviewer", REVIEWER.description, REVIEWER.prompt]);
  assert.ok(codex.includes('developer_instructions = """\nYou review code.'));
  // Quotes, backslashes, # and frontmatter-looking lines survive every format.
  const prompts = ['Say """hi""" back.', 'Ends with a quote "', "Tabs\tand \\backslashes\\", "line ending in a backslash \\\nnext", "# not a comment\n'''literal'''", "a: b\n---\nmiddle rule"];
  for (const prompt of prompts) for (const style of ["codex", "claude", "gemini", "opencode"] as const) {
    const read = readSubagent(renderSubagent("quoting", { description: 'Has "quotes" and # and \\', prompt }, style), style, "quoting");
    assert.deepEqual([read?.prompt, read?.description], [prompt, 'Has "quotes" and # and \\'], style + " " + JSON.stringify(prompt));
  }
  // What is stored and written: both texts trimmed, the prompt's line breaks LF.
  assert.equal(readSubagent(renderSubagent("tidy", { description: "  One line. ", prompt: "\n a\r\nb  \n\n" }, "claude"), "claude", null)?.prompt, "a\nb");
  assert.equal(subagentFile("/x/agents", "tidy", "codex"), "/x/agents/tidy.toml");
});

test("G064-A1 names, descriptions and prompts every Harness could misread are refused, and Gemini's templates are kept out", () => {
  const homes = ["/Users/someone"];
  for (const [name, reason] of [["Reviewer", /小写/u], ["-x", /小写/u], ["a_b", /小写/u], ["a:b", /小写/u], ["x".repeat(65), /64/u]] as const) assert.match(subagentProblem(name, REVIEWER, homes, reserved) ?? "", reason, name);
  // Every built-in the read tables list is refused, named with its Harness; the four Harnesses' lists are all there.
  assert.deepEqual([...new Set(reserved.values())].sort(), ["claude", "codex", "gemini", "opencode"]);
  for (const name of ["default", "explorer", "worker", "awaiter", "generalist", "build", "plan", "general", "explore", "compaction", "title", "summary", "general-purpose", "statusline-setup", "claude-code-guide", "claude", "teammate", "agent", "subagent", "main", "main-session", "comment-thread-analyst"]) {
    assert.ok(reserved.has(name), name);
    assert.match(subagentProblem(name, REVIEWER, homes, reserved) ?? "", new RegExp(reserved.get(name)! + " 的内置"), name);
  }
  for (const [definition, reason] of [
    [{ description: " ", prompt: "p" }, /要写说明/u], [{ description: "two\nlines", prompt: "p" }, /一行/u], [{ description: "x".repeat(1025), prompt: "p" }, /1024/u],
    [{ description: "d", prompt: "  \n" }, /要写正文/u], [{ description: "d", prompt: "x".repeat(32 * 1024 + 1) }, /32 KiB/u], [{ description: "d", prompt: "bell\u0007" }, /控制字符/u],
    [{ description: "d", prompt: "Look in /Users/someone/notes." }, /写成 ~/u], [{ description: "half \uD83D", prompt: "p" }, /代理项/u],
    [{ description: "d", prompt: "---\nname: other\n---\nbody" }, /--- 行开头/u],
  ] as const) assert.match(subagentProblem("ok-name", definition, homes, reserved) ?? "", reason, JSON.stringify(definition).slice(0, 60));
  assert.equal(subagentProblem("pr-reviewer2", REVIEWER, homes, reserved), null);
  assert.equal(subagentProblem("pr-reviewer2", { description: "  padded  ", prompt: "\n\nbody with --- inside\n" }, homes, reserved), null, "texts are checked as stored, trimmed");
  assert.match(subagentStyleProblem({ description: "d", prompt: "Use ${activeModel} or ${HOME}" }, "gemini") ?? "", /模板变量/u);
  assert.equal(subagentStyleProblem({ description: "d", prompt: "Use ${HOME}" }, "claude"), null, "only Gemini fills ${…}");
});

test("G064-A1 another definition of the same name is found by each Harness's own naming, never by file name alone", async t => {
  const root = await mkdtemp(join(tmpdir(), "subagent-names-")); t.after(() => rm(root, { recursive: true, force: true }));
  const codex = join(root, "codex"), claude = join(root, "claude"), gemini = join(root, "gemini"), opencode = join(root, "opencode");
  await mkdir(join(codex, "team"), { recursive: true }); await mkdir(join(claude, "nested"), { recursive: true }); await mkdir(join(gemini, "deeper"), { recursive: true }); await mkdir(join(opencode, "team"), { recursive: true });
  // Codex and Claude Code name a subagent by its `name` field, wherever the file is.
  await writeFile(join(codex, "team", "other-file.toml"), 'name = "reviewer"\ndescription = "x"\ndeveloper_instructions = "y"\n');
  await writeFile(join(claude, "nested", "whatever.md"), "---\nname: reviewer\ndescription: x\n---\nbody\n");
  await writeFile(join(claude, "no-name.md"), "---\ndescription: a document, not a subagent\n---\nbody\n");
  assert.deepEqual(sameNamedSubagents(codex, "reviewer", "codex", join(codex, "reviewer.toml")), [join(codex, "team", "other-file.toml")]);
  assert.deepEqual(sameNamedSubagents(claude, "reviewer", "claude", join(claude, "reviewer.md")), [join(claude, "nested", "whatever.md")]);
  // Gemini reads only regular files at the top of its directory and skips those starting with _.
  await writeFile(join(gemini, "deeper", "a.md"), "---\nname: reviewer\ndescription: x\n---\nb\n");
  await writeFile(join(gemini, "_draft.md"), "---\nname: reviewer\ndescription: x\n---\nb\n");
  await writeFile(join(root, "linked.md"), "---\nname: reviewer\ndescription: x\n---\nb\n"); await symlink(join(root, "linked.md"), join(gemini, "linked.md"));
  assert.deepEqual(sameNamedSubagents(gemini, "reviewer", "gemini", join(gemini, "reviewer.md")), []);
  await writeFile(join(gemini, "top.md"), "---\nname: reviewer\ndescription: x\n---\nb\n");
  assert.deepEqual(sameNamedSubagents(gemini, "reviewer", "gemini", join(gemini, "reviewer.md")), [join(gemini, "top.md")]);
  // OpenCode names by the path under its directory, unless the frontmatter names it.
  await writeFile(join(opencode, "team", "reviewer.md"), "plain prompt, no frontmatter\n");
  await writeFile(join(opencode, "renamed.md"), "---\nname: reviewer\n---\nb\n");
  assert.deepEqual(sameNamedSubagents(opencode, "reviewer", "opencode", join(opencode, "reviewer.md")), [join(opencode, "renamed.md")]);
  assert.deepEqual(sameNamedSubagents(opencode, "team/reviewer", "opencode", join(opencode, "x.md")), [join(opencode, "team", "reviewer.md")]);
  assert.deepEqual(sameNamedSubagents(join(root, "missing"), "reviewer", "codex", ""), [], "a directory that is not there has none");
});
