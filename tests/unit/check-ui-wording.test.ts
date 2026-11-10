import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// The wording check (tools/check-ui-wording.mjs) is exercised through its command line, as a person or CI runs it: on the
// repository itself, and on small trees written here, among them the invalid samples that prove it rejects.
const repository = fileURLToPath(new URL("../../../", import.meta.url));
const script = join(repository, "tools", "check-ui-wording.mjs");

interface Reported { readonly file: string; readonly line: number; readonly rule: string; readonly text: string }
interface Report { readonly status: number | null; readonly stdout: string; readonly stderr: string; readonly problems: readonly Reported[] }

function check(args: readonly string[]): Report {
  const run = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", timeout: 120000, maxBuffer: 16 * 1024 * 1024, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C" } });
  assert.equal(run.error, undefined, String(run.error));
  const problems = run.stdout.split("\n").flatMap(line => {
    const match = /^(\S+):(\d+) (W\d) (.*)$/u.exec(line);
    return match === null ? [] : [{ file: match[1]!, line: Number(match[2]), rule: match[3]!, text: match[4]! }];
  });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr, problems };
}
/** `file:line RULE` of every problem, in the order reported. */
const keys = (report: Report): string[] => report.problems.map(item => `${item.file}:${item.line} ${item.rule}`);

async function tree(t: test.TestContext, files: Readonly<Record<string, string>>, bare = false): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "harness-wording-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Both scan roots get a module of no words unless the files bring their own or `bare` is set.
  const all = bare ? files : { "web/src/index.ts": "export {};\n", "src/web/index.ts": "export {};\n", ...files };
  for (const [name, text] of Object.entries(all)) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), text);
  }
  return root;
}

test("G073 the interface of this repository names the concept Harness in every word it shows", () => {
  const report = check([]);
  assert.deepEqual(report.problems, [], report.stdout);
  assert.equal(report.status, 0, report.stdout + report.stderr);
  // It read the whole interface: both scan roots, thousands of strings (a check that read nothing would pass anything).
  const summary = /^ui-wording: (\d+) files, (\d+) strings, 0 problem\(s\)$/mu.exec(report.stdout);
  assert.ok(summary !== null, report.stdout);
  assert.ok(Number(summary[1]) >= 30 && Number(summary[2]) >= 2000, report.stdout);
});

test("G073 an invalid sample is rejected: every kind of string a person can read, each with its line", async t => {
  const root = await tree(t, {
    // The old navigation label, an accessible name, a title in a template, text on the second line of a JSX element, a plural.
    "web/src/Bad.tsx": [
      "export const Nav = (props: { readonly name: string }) => <nav aria-label=\"我的 Agent\">",
      "  <p>",
      "    第二行的 Agent 也要抓到",
      "  </p>",
      "  <span title={`Agent ${props.name}`}>x</span>",
      "  <span>Agents</span>",
      "</nav>;",
    ].join("\n"),
    // The Gateway's own web server: a message that reaches the page.
    "src/web/bad.ts": "export const message = \"这个 Agent 不可用\";\nexport const other = ['Agent'].join();\n",
  });
  const report = check(["--root", root]);
  assert.equal(report.status, 1, report.stdout);
  assert.deepEqual(keys(report).sort(), ["src/web/bad.ts:1 W1", "src/web/bad.ts:2 W1", "web/src/Bad.tsx:1 W1", "web/src/Bad.tsx:3 W1", "web/src/Bad.tsx:5 W1", "web/src/Bad.tsx:6 W1"].sort());
  assert.match(report.problems[0]!.text, /Harness/u);
});

test("G073 a command's search words are not words of the interface, and the same words as a label are", async t => {
  // The palette keeps the page's old names as search words, so they still find it: matched, never drawn.
  const kept = check(["--root", await tree(t, { "web/src/App.tsx": "export const command = { id: \"harnesses\", label: \"Harness\", keywords: \"我的 Agent 安装 升级 更新 卸载\" };\nexport const other = { \"keywords\": `Agent` };\n" })]);
  assert.equal(kept.status, 0, kept.stdout); assert.deepEqual(kept.problems, []);
  // The same words drawn are rejected: as a label, a hint, a title or an accessible name; and only that property is let through.
  const drawn = check(["--root", await tree(t, { "web/src/App.tsx": [
    "export const command = { id: \"harnesses\", label: \"我的 Agent\", hint: \"Agent\", keywords: \"Agent\", words: \"Agent\" };",
    "export const Page = () => <a title=\"Agent\" aria-label=\"Agent\">keywords</a>;",
  ].join("\n") })]);
  assert.equal(drawn.status, 1, drawn.stdout);
  assert.deepEqual(keys(drawn), ["web/src/App.tsx:1 W1", "web/src/App.tsx:1 W1", "web/src/App.tsx:1 W1", "web/src/App.tsx:2 W1", "web/src/App.tsx:2 W1"]);
});

test("G073 the fixed exceptions pass, and what is not a word of the interface is not read", async t => {
  const root = await tree(t, {
    "web/src/Good.tsx": [
      "import { Agent } from \"./Agent.js\";",
      "import(\"./AgentLazy.js\");",
      "// Agent in a comment is the code's word, not the page's.",
      "type Kind = \"Agent\" | \"task\";",
      "const AgentCard = () => <p>Hermes Agent 已回复，Claude Agent 与子 Agent 的工具；Hermes Agent</p>;",
      "export const Page = () => <AgentCard aria-label=\"子 Agent 的工具\" data-agent=\"agent\" title=\"claude-agent-acp\"/>;",
      "export const names = [\"Hermes Agent\", \"Claude Agent\", \"子 Agent\", \"UserAgent\", \"agent\", \"fast-agent\"] as const;",
      "export const use = [Agent, {} as Kind];",
    ].join("\n"),
  });
  const report = check(["--root", root]);
  assert.equal(report.status, 0, report.stdout + report.stderr);
  assert.deepEqual(report.problems, []);
});

test("G073 an exception is the whole phrase, not a prefix of a longer word", async t => {
  const root = await tree(t, { "web/src/Phrase.tsx": "export const a = \"Hermes Agents\";\nexport const b = \"子 Agent2\";\nexport const c = \"Mini Hermes Agent\";\nexport const d = \"Claude Agent SDK\";\n" });
  const report = check(["--root", root]);
  // "Hermes Agents" names the concept in the plural; "子 Agent2" is part of a longer name (not the concept as a word) and "Mini Hermes
  // Agent" and "Claude Agent SDK" contain an exception whole, so only the plural is a violation.
  assert.deepEqual(keys(report), ["web/src/Phrase.tsx:1 W1"], report.stdout);
});

test("G073 a check that cannot read what it must is a failure, never a pass", async t => {
  // A file that does not parse: none of its strings could be read.
  const broken = check(["--root", await tree(t, { "web/src/Broken.tsx": "export const x = <p>Agent\nexport const y = ;\n" })]);
  assert.equal(broken.status, 1, broken.stdout);
  assert.ok(broken.problems.length > 0 && broken.problems.every(item => item.rule === "W0" && item.file === "web/src/Broken.tsx"), broken.stdout);
  // A scan root that is missing, or has no sources.
  const missing = check(["--root", await tree(t, { "web/src/index.ts": "export {};\n" }, true)]);
  assert.equal(missing.status, 1, missing.stdout);
  assert.deepEqual(keys(missing), ["src/web:1 W0"]);
  const empty = check(["--root", await tree(t, { "web/src/notes.md": "no source here\n", "src/web/index.ts": "export {};\n" }, true)]);
  assert.equal(empty.status, 1, empty.stdout);
  assert.deepEqual(keys(empty), ["web/src:1 W0"]);
});

test("G073 unusable arguments and roots exit with 2 and scan nothing", async t => {
  const unknown = check(["--no-such-option"]);
  assert.equal(unknown.status, 2); assert.equal(unknown.problems.length, 0); assert.match(unknown.stderr, /check-ui-wording/u);
  const absent = check(["--root", join(await tree(t, {}), "no-such-directory")]);
  assert.equal(absent.status, 2); assert.match(absent.stderr, /not a directory/u);
  const help = check(["--help"]);
  assert.equal(help.status, 0); assert.match(help.stdout, /usage: node tools\/check-ui-wording\.mjs/u);
});
