import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// The boundary check (tools/check-boundaries.mjs) is exercised through its command line, as `pnpm check:boundaries` runs it:
// on the repository itself, on the invalid samples of tools/fixtures/boundaries, and on small trees written here.
const repository = fileURLToPath(new URL("../../../", import.meta.url));
const script = join(repository, "tools", "check-boundaries.mjs");
const rulesFile = join(repository, "tools", "boundary-rules.json");
const samples = join(repository, "tools", "fixtures", "boundaries");

/** Adding an exception is a decision: it is listed here and, with its reason, in tools/boundary-rules.json. */
const registered = [
  { rule: "B3", file: "src/contracts/control.ts", key: "src/contexts/catalog/domain/catalog.js" },
  { rule: "B3", file: "src/contracts/control.ts", key: "src/contexts/catalog/domain/discovery.js" },
  { rule: "B3", file: "src/contracts/management.ts", key: "src/contexts/catalog/domain/catalog.js" },
];

interface Reported { readonly file: string; readonly line: number; readonly rule: string; readonly text: string }
interface Report { readonly status: number | null; readonly stdout: string; readonly stderr: string; readonly violations: readonly Reported[]; readonly exceptions: readonly string[] }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function recordOf(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value), "expected an object"); return value;
}
function listOf(value: unknown): unknown[] {
  assert.ok(Array.isArray(value), "expected an array"); return value;
}

function check(args: readonly string[]): Report {
  const run = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", timeout: 120000, maxBuffer: 16 * 1024 * 1024, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C" } });
  assert.equal(run.error, undefined, String(run.error));
  const lines = run.stdout.split("\n");
  const violations = lines.flatMap(line => {
    const match = /^(\S+):(\d+) (B\d+) (.*)$/u.exec(line);
    return match === null ? [] : [{ file: match[1]!, line: Number(match[2]), rule: match[3]!, text: match[4]! }];
  });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr, violations, exceptions: lines.filter(line => line.startsWith("registered exception ")) };
}
/** `file:line RULE` of every violation, once each, in a fixed order. */
const keys = (report: Report): string[] => [...new Set(report.violations.map(item => `${item.file}:${item.line} ${item.rule}`))].sort();

async function directory(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "harness-g063-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
/** Writes the files under a new root. The three scan roots get an empty module unless the files bring their own or `bare` is set. */
async function tree(t: test.TestContext, files: Readonly<Record<string, string>>, bare = false): Promise<string> {
  const root = await directory(t);
  const all = bare ? files : { "src/index.ts": "export {};\n", "web/src/index.ts": "export {};\n", "tests/index.test.ts": "export {};\n", ...files };
  for (const [name, text] of Object.entries(all)) {
    await mkdir(dirname(join(root, name)), { recursive: true }); await writeFile(join(root, name), text);
  }
  return root;
}
/** A copy of the real rules with every exception withdrawn, for trees that are not this repository. */
async function rulesWithoutExceptions(t: test.TestContext): Promise<string> {
  const document = recordOf(JSON.parse(await readFile(rulesFile, "utf8")));
  const file = join(await directory(t), "rules.json");
  await writeFile(file, JSON.stringify({ ...document, rules: listOf(document.rules).map(rule => ({ ...recordOf(rule), exceptions: [] })) }));
  return file;
}
async function rulesWith(t: test.TestContext, change: (document: Record<string, unknown>) => unknown): Promise<string> {
  const file = join(await directory(t), "rules.json");
  await writeFile(file, JSON.stringify(change(recordOf(JSON.parse(await readFile(rulesFile, "utf8"))))));
  return file;
}
async function ruleIds(): Promise<string[]> {
  return listOf(recordOf(JSON.parse(await readFile(rulesFile, "utf8"))).rules).map(rule => String(recordOf(rule).id));
}

interface Marked { readonly files: Readonly<Record<string, string>>; readonly expected: readonly string[] }
/**
 * Splits a sample into the virtual files it describes (`// @@ file: <path>` starts one) and reads the violations it expects
 * (`// expect: B1, B10` at the end of a line, counted in the line numbers of the virtual file).
 */
function marked(source: string): Marked {
  const files: Record<string, string[]> = {}, expected = new Set<string>();
  let current: string[] | null = null, name = "";
  for (const line of source.split("\n")) {
    const start = /^\/\/ @@ file: (\S+)$/u.exec(line);
    if (start !== null) { name = start[1]!; assert.equal(files[name], undefined, "virtual file listed twice: " + name); current = files[name] = []; continue; }
    if (current === null) continue;
    current.push(line);
    const mark = /\/\/ expect: (B\d+(?:, B\d+)*)\s*$/u.exec(line);
    if (mark !== null) for (const rule of mark[1]!.split(", ")) expected.add(`${name}:${current.length} ${rule}`);
  }
  return { files: Object.fromEntries(Object.entries(files).map(([path, lines]) => [path, lines.join("\n")])), expected: [...expected].sort() };
}

test("G063-C01 the repository satisfies every boundary rule and only its registered exceptions are reported", () => {
  const report = check([]);
  assert.equal(report.status, 0, report.stdout + report.stderr);
  assert.deepEqual(report.violations, [], report.stdout);
  assert.deepEqual(report.exceptions.map(line => /^registered exception (B\d+) (\S+?):\d+ (\S+)/u.exec(line)!.slice(1).join(" ")).sort(), registered.map(item => `${item.rule} ${item.file} ${item.key}`).sort());
  // A pass over nothing is not a pass: every scan root contributed files.
  const scanned = /scanned (\d+) files \(src (\d+), web\/src (\d+), tests (\d+)\)/u.exec(report.stdout);
  assert.ok(scanned !== null, report.stdout);
  for (const count of scanned.slice(1)) assert.ok(Number(count) > 0, report.stdout);
});

test("G063-C01 code that keeps to its layer passes, in every form the rules accept", async t => {
  const lines = (...text: string[]) => text.join("\n") + "\n";
  const root = await tree(t, {
    "src/contexts/session/domain/state.ts": lines('import { join } from "node:path";', 'import { createHash } from "node:crypto";', 'import type { SessionId } from "../../../contracts/session.js";', 'import { other } from "./context.js";', "export const state = [join, createHash, other] as unknown as SessionId;"),
    "src/contexts/session/application/runtime.ts": lines('import { EventEmitter } from "node:events";', 'import { performance } from "node:perf_hooks";', 'import { reduce } from "../domain/state.js";', 'import { next } from "./queue.js";', "export const runtime = [EventEmitter, performance, reduce, next];"),
    "src/contexts/catalog/application/discover.ts": lines('import { parse } from "../domain/catalog-parser.js";', 'import type { SessionId } from "../../../contracts/session.js";', "export const discover = parse as unknown as SessionId;"),
    "src/contracts/session.ts": lines('import type { ProviderId } from "./provider.js";', 'export type Pending = import("./control.js").ControlSession;', "export type Id = ProviderId;"),
    "src/infrastructure/session/store.ts": lines('import { DatabaseSync } from "node:sqlite";', 'import { spawn } from "node:child_process";', 'import YAML from "yaml";', 'import { reduce } from "../../contexts/session/domain/state.js";', "export const store = [DatabaseSync, spawn, YAML, reduce];"),
    "src/adapters/control/openclaw.ts": lines('import JSON5 from "json5";', 'import { store } from "../../infrastructure/session/store.js";', 'import type { ControlSession } from "../../contracts/control.js";', "export const adapter = [JSON5, store] as unknown as ControlSession;"),
    "src/cli/web.ts": lines('import { createServer } from "node:http";', 'import { readFileSync } from "fs";', 'import { gunzipSync } from "zlib";', 'import { startWebServer } from "../web/server.js";', 'import { adapter } from "../adapters/control/openclaw.js";', "export const web = [createServer, readFileSync, gunzipSync, startWebServer, adapter];"),
    "src/web/server.ts": lines('import { createServer } from "node:http";', 'import { application } from "../cli/session-application.js";', "export const startWebServer = [createServer, application];"),
    "web/src/App.tsx": lines('import React from "react";', 'import type { SessionSnapshot } from "../../src/contracts/session.js";', 'import { cn } from "./lib/cn.js";', 'export const lazy = () => import("react-markdown");', "export const App = (props: { readonly view: SessionSnapshot }) => <div className={cn(String(props.view))}><React.Fragment /></div>;"),
    "tests/integration/forms.test.ts": lines(
      'import { spawn as launch, spawnSync } from "node:child_process";', 'import * as childProcess from "node:child_process";', 'import { join } from "node:path";', 'import { fileURLToPath } from "node:url";',
      'import { application as compose } from "../../src/cli/session-application.js";', 'import { startWebServer } from "../../src/web/server.js";',
      'const chat = fileURLToPath(new URL("../../src/cli/chat.js", import.meta.url));', 'const web = fileURLToPath(new URL("../../src/cli/web.js", import.meta.url));', 'const discover = fileURLToPath(new URL("../../src/cli/discover.js", import.meta.url));',
      'const locks = join(root, "locks"), common = ["--data-dir", data, "--workspace-lock-root", locks], options = { installations: "any" as const, workspaceLockRoot: locks };',
      "compose(data, () => {}, options); compose(data, () => {}, { ...options, nativeEnvironment });",
      "startWebServer({ root, configuration, port: 0, ...(own === undefined ? { workspaceLockRoot: locks } : { application: own }) });",
      'launch(process.execPath, [chat, "--allow-unofficial", ...common, "--manifest", manifest]);',
      'childProcess.spawnSync(process.execPath, [web, ...common, "--port", "0"]);',
      "const through = (args: readonly string[]) => spawnSync(process.execPath, [web, ...args]);", 'through(common); through([...common, "--port", "0"]);',
      'spawnSync(process.execPath, [web, "--help"]); spawnSync(process.execPath, [discover, "--json", "--manifest", manifest]); spawnSync("npm", ["pack"]);',
    ),
  });
  const report = check(["--root", root, "--rules", await rulesWithoutExceptions(t)]);
  assert.equal(report.status, 0, report.stdout + report.stderr);
  assert.deepEqual(report.violations, [], report.stdout);
  assert.deepEqual(report.exceptions, []);
});

test("G063-C02 every invalid sample is rejected line by line, with the rule that forbids it", async t => {
  const rules = await rulesWithoutExceptions(t), covered = new Set<string>();
  const names = (await readdir(samples)).filter(name => name.endsWith(".ts")).sort();
  assert.ok(names.length > 0, "no invalid samples found in " + samples);
  for (const name of names) {
    const sample = marked(await readFile(join(samples, name), "utf8"));
    assert.ok(sample.expected.length > 0, name + " marks no violation");
    const report = check(["--root", await tree(t, sample.files), "--rules", rules]);
    assert.equal(report.status, 1, name + "\n" + report.stdout + report.stderr);
    // Exactly the marked lines: a line the sample does not mark must stay clean, so the accepted forms in the samples hold too.
    assert.deepEqual(keys(report), sample.expected, name + "\n" + report.stdout);
    for (const key of sample.expected) covered.add(key.split(" ")[1]!);
  }
  for (const id of await ruleIds()) assert.ok(covered.has(id), `rule ${id} has no invalid sample in tools/fixtures/boundaries`);
});

test("G063-C02 flags that come from another file are reported as not visible, with the way out", async t => {
  const root = await tree(t, { "tests/integration/unseen.test.ts": [
    'import { spawnSync } from "node:child_process";', 'import { fileURLToPath } from "node:url";', 'import { importedFlags } from "../fixtures/flags.js";',
    'const chat = fileURLToPath(new URL("../../src/cli/chat.js", import.meta.url));', "spawnSync(process.execPath, [chat, ...importedFlags]);", "",
  ].join("\n") });
  const report = check(["--root", root, "--rules", await rulesWithoutExceptions(t)]);
  assert.equal(report.status, 1, report.stdout);
  assert.deepEqual(keys(report), ["tests/integration/unseen.test.ts:5 B9"], report.stdout);
  assert.match(report.violations[0]!.text, /part of the argument list is not visible here, so write the flag out/u);
});

test("G063-C02 the real code is rejected once the registered exceptions are withdrawn", async t => {
  const report = check(["--rules", await rulesWithoutExceptions(t)]);
  assert.equal(report.status, 1, report.stdout + report.stderr);
  assert.deepEqual(report.violations.map(item => `${item.rule} ${item.file}`).sort(), registered.map(item => `${item.rule} ${item.file}`).sort(), report.stdout);
});

test("G063-C02 an exception covers only its own file, import and kind, and no more occurrences than registered", async t => {
  const catalog = "src/contexts/catalog/domain/catalog.js";
  const register = await rulesWith(t, document => ({ ...document, rules: listOf(document.rules).map(rule => {
    const item = recordOf(rule);
    return item.id === "B3"
      ? { ...item, exceptions: [{ file: "src/contracts/control.ts", key: catalog, typeOnly: true, reason: "test" }, { file: "src/contracts/management.ts", key: catalog, typeOnly: true, reason: "test" }] }
      : { ...item, exceptions: [] };
  }) }));
  const lines = (...text: string[]) => text.join("\n") + "\n";
  // Registered: an `import type` of catalog.js from control.ts, and an `export type ... from` it in management.ts.
  const registered = { "src/contracts/management.ts": lines('export type { ResolvedCommand } from "../contexts/catalog/domain/catalog.js";') };
  const covered = await tree(t, { ...registered, "src/contracts/control.ts": lines('import type { ResolvedCommand } from "../contexts/catalog/domain/catalog.js";') });
  const clean = check(["--root", covered, "--rules", register]);
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  assert.equal(clean.exceptions.length, 2);
  // A second occurrence, another file and another target are still violations.
  const wider = await tree(t, {
    ...registered,
    "src/contracts/control.ts": lines('import type { ResolvedCommand } from "../contexts/catalog/domain/catalog.js";', 'import type { Again } from "../contexts/catalog/domain/catalog.js";', 'import type { Other } from "../contexts/catalog/domain/discovery.js";'),
    "src/contracts/web.ts": lines('import type { ResolvedCommand } from "../contexts/catalog/domain/catalog.js";'),
  });
  assert.deepEqual(keys(check(["--root", wider, "--rules", register])), ["src/contracts/control.ts:2 B3", "src/contracts/control.ts:3 B3", "src/contracts/web.ts:1 B3"]);
  // `import { type X }` still loads the module under verbatimModuleSyntax, so it is not the registered type-only import; and the register no longer matches anything.
  const value = check(["--root", await tree(t, { ...registered, "src/contracts/control.ts": lines('import { type ResolvedCommand } from "../contexts/catalog/domain/catalog.js";') }), "--rules", register]);
  assert.equal(value.status, 1);
  assert.deepEqual(value.violations.map(item => item.rule).sort(), ["B0", "B3"], value.stdout);
  assert.ok(value.violations.some(item => item.rule === "B3" && item.file === "src/contracts/control.ts"), value.stdout);
  // A value re-export of the registered target is not the registered `export type` either.
  const reexport = check(["--root", await tree(t, { "src/contracts/management.ts": lines('export { ResolvedCommand } from "../contexts/catalog/domain/catalog.js";'), "src/contracts/control.ts": lines('import type { ResolvedCommand } from "../contexts/catalog/domain/catalog.js";') }), "--rules", register]);
  assert.deepEqual(reexport.violations.map(item => item.rule).sort(), ["B0", "B3"], reexport.stdout);
});

test("G063-C03 a file that does not parse fails the check and is listed, and the rest is still checked", async t => {
  const root = await tree(t, { "src/broken.ts": 'import { from "x";\nconst = ;\nexport function ( {\n', "src/cli/other.ts": 'import YAML from "yaml";\nexport default YAML;\n' });
  const report = check(["--root", root, "--rules", await rulesWithoutExceptions(t)]);
  assert.equal(report.status, 1, report.stdout);
  const broken = report.violations.filter(item => item.file === "src/broken.ts");
  assert.ok(broken.length >= 1 && broken.every(item => item.rule === "B0" && /does not parse/u.test(item.text)), report.stdout);
  assert.ok(keys(report).includes("src/cli/other.ts:1 B10"), report.stdout);
});

test("G063-C03 a root, scan root or rule file that cannot be used fails instead of passing", async t => {
  const rules = await rulesWithoutExceptions(t);
  // A root that does not exist: nothing was scanned.
  const missing = check(["--root", join(await directory(t), "absent"), "--rules", rules]);
  assert.equal(missing.status, 2); assert.equal(missing.stdout, ""); assert.match(missing.stderr, /is not a directory, so nothing was scanned/u);
  // A scan root that is missing, or present without a source.
  const noTests = check(["--root", await tree(t, { "src/index.ts": "export {};\n", "web/src/index.ts": "export {};\n" }, true), "--rules", rules]);
  assert.equal(noTests.status, 1); assert.deepEqual(keys(noTests), ["tests:1 B0"]); assert.match(noTests.stdout, /scan root tests does not exist/u);
  const empty = check(["--root", await tree(t, { "src/index.ts": "export {};\n", "web/src/index.ts": "export {};\n", "tests/notes.md": "no source here\n" }, true), "--rules", rules]);
  assert.equal(empty.status, 1); assert.deepEqual(keys(empty), ["tests:1 B0"]); assert.match(empty.stdout, /has no \.ts\/\.tsx\/\.mts\/\.cts sources/u);
  // Unusable rules and options are refused before anything is scanned.
  const root = await tree(t, {});
  const refused = async (name: string, content: string | null, pattern: RegExp) => {
    const file = join(await directory(t), name);
    if (content !== null) await writeFile(file, content);
    const report = check(["--root", root, "--rules", file]);
    assert.equal(report.status, 2, name + report.stdout); assert.equal(report.stdout, ""); assert.match(report.stderr, pattern, name);
  };
  const real = recordOf(JSON.parse(await readFile(rulesFile, "utf8"))), firstRule = recordOf(listOf(real.rules)[0]);
  await refused("absent.json", null, /cannot read rule file/u);
  await refused("broken.json", "{ not json", /cannot read rule file/u);
  await refused("unknown-field.json", JSON.stringify({ ...real, extra: 1 }), /unknown field "extra"/u);
  await refused("duplicate.json", JSON.stringify({ ...real, rules: [firstRule, firstRule] }), /not a unique rule id/u);
  await refused("integrity-id.json", JSON.stringify({ ...real, rules: [{ ...firstRule, id: "B0" }] }), /not a unique rule id/u);
  await refused("unknown-kind.json", JSON.stringify({ ...real, rules: [{ ...firstRule, kind: "magic" }] }), /unknown rule kind "magic"/u);
  await refused("no-reason.json", JSON.stringify({ ...real, rules: [{ ...firstRule, exceptions: [{ file: "a.ts", key: "x" }] }] }), /exceptions\[0\]\.reason/u);
  await refused("bad-pattern.json", JSON.stringify({ ...real, rules: [{ ...firstRule, appliesTo: ["src/**x"] }] }), /invalid path pattern/u);
  const option = check(["--root", root, "--rules", rules, "--fast"]);
  assert.equal(option.status, 2); assert.match(option.stderr, /--fast/u);
});

test("G063-C03 an exception that no longer matches anything fails the check", async t => {
  const stale = await rulesWith(t, document => ({ ...document, rules: listOf(document.rules).map(rule => {
    const item = recordOf(rule);
    return item.id === "B10" ? { ...item, exceptions: [{ file: "src/cli/gone.ts", key: "yaml", count: 2, reason: "test" }] } : { ...item, exceptions: [] };
  }) }));
  const root = await tree(t, { "src/cli/gone.ts": 'import YAML from "yaml";\nexport default YAML;\n' });
  const report = check(["--root", root, "--rules", stale]);
  assert.equal(report.status, 1, report.stdout);
  assert.deepEqual(report.violations.map(item => item.rule), ["B0"]);
  assert.match(report.stdout, /expects 2 occurrence\(s\) but found 1/u);
  assert.equal(report.exceptions.length, 1, "the occurrence it does cover is still set aside");
});

test("G063-C03 an import the check cannot place is reported, never skipped", async t => {
  const root = await tree(t, {
    "src/cli/computed.ts": 'const name = "x";\nawait import(name);\nconst load = require(name);\nexport { load };\n',
    "src/cli/outside.ts": 'import "../../../elsewhere/x.js";\nimport "/abs/x.js";\nimport "https://example.com/x.js";\nimport "#internal";\n',
    "src/cli/known.ts": 'import { readFileSync } from "node:fs";\nimport type { X } from "./computed.js";\nexport { readFileSync };\nexport type { X };\n',
  });
  const report = check(["--root", root, "--rules", await rulesWithoutExceptions(t)]);
  assert.equal(report.status, 1, report.stdout);
  assert.deepEqual(keys(report), ["src/cli/computed.ts:2 B0", "src/cli/computed.ts:3 B0", "src/cli/outside.ts:1 B0", "src/cli/outside.ts:2 B0", "src/cli/outside.ts:3 B0", "src/cli/outside.ts:4 B0"], report.stdout);
});

test("G063-C03 the scan follows git when the root is a work tree, and skips vendored and built directories otherwise", async t => {
  const rules = await rulesWithoutExceptions(t);
  // Without git: node_modules and dist directories are not sources.
  const walked = check(["--root", await tree(t, { "src/node_modules/pkg/index.ts": 'import YAML from "yaml";\n', "src/dist/built.ts": 'import YAML from "yaml";\n', "src/cli/real.ts": 'import YAML from "yaml";\n' }), "--rules", rules]);
  assert.deepEqual(keys(walked), ["src/cli/real.ts:1 B10"], walked.stdout); assert.match(walked.stdout, /via walk/u);
  // With git: what is tracked or not ignored is scanned; a file git still lists but the work tree lost is skipped.
  const root = await tree(t, { ".gitignore": "src/ignored/\n", "src/cli/tracked.ts": 'import YAML from "yaml";\n', "src/cli/gone.ts": 'import YAML from "yaml";\n', "src/ignored/hidden.ts": 'import YAML from "yaml";\n' });
  const environment = { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C", GIT_CONFIG_NOSYSTEM: "1" };
  for (const args of [["init", "-q"], ["add", "-A"]]) assert.equal(spawnSync("git", ["-C", root, ...args], { encoding: "utf8", env: environment }).status, 0);
  await rm(join(root, "src", "cli", "gone.ts"));
  await writeFile(join(root, "src", "cli", "untracked.ts"), 'import YAML from "yaml";\n');
  const listed = check(["--root", root, "--rules", rules]);
  assert.deepEqual(keys(listed), ["src/cli/tracked.ts:1 B10", "src/cli/untracked.ts:1 B10"], listed.stdout); assert.match(listed.stdout, /via git/u);
});

test("G063-C03 the check is part of pnpm check and its rules are written down", async () => {
  const scripts = recordOf(recordOf(JSON.parse(await readFile(join(repository, "package.json"), "utf8"))).scripts);
  assert.equal(scripts["check:boundaries"], "node tools/check-boundaries.mjs");
  const steps = String(scripts.check).split("&&").map(step => step.trim());
  assert.ok(steps.includes("pnpm check:boundaries"), "pnpm check does not run check:boundaries: " + String(scripts.check));
  // The engineering rules name every rule the check enforces, so a rule cannot exist without its explanation.
  const development = await readFile(join(repository, "docs", "engineering", "development.md"), "utf8");
  for (const id of await ruleIds()) assert.match(development, new RegExp(`\\b${id}\\b`, "u"), `docs/engineering/development.md does not explain ${id}`);
  const help = check(["--help"]);
  assert.equal(help.status, 0); assert.match(help.stdout, /usage: node tools\/check-boundaries\.mjs/u);
});
