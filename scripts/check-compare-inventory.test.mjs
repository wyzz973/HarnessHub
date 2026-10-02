// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { compareInventories, formatDifferences } from "./compare-inventory.mjs";

const SCRIPT = fileURLToPath(new URL("./compare-inventory.mjs", import.meta.url));

async function directory(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hh-inventory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** Write inventory files below root: {relative path: entries or raw text}. */
async function write(root, files) {
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, typeof content === "string" ? content : content.map((e) => `${JSON.stringify(e)}\n`).join(""));
  }
}

function compare(root, ...args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: root, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const entry = (suite, file, test, status = "pass") => ({ suite, file, test, status });

test("accepts the same tests after files moved and lines reordered, from files or directories", async (t) => {
  const root = await directory(t);
  await write(root, {
    "before/unit.jsonl": [entry("unit", "a.test.js", ["x"]), entry("unit", "a.test.js", ["p", "c"], "skip")],
    "before/smoke.jsonl": [entry("smoke", "s.test.js", ["boots"]), entry("smoke", "s.test.js", ["boots"])],
    "before/notes.txt": "not an inventory\n",
    "after/all.jsonl": [
      entry("smoke", "moved.test.js", ["boots"]),
      entry("unit", "packages-core-a.test.js", ["p", "c"], "skip"),
      entry("smoke", "other.test.js", ["boots"]),
      entry("unit", "packages-core-a.test.js", ["x"]),
    ],
  });
  const result = compare(root, "before", "after");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^4 entries before, 4 after, 0 allowed additions: no differences$/m);
  assert.equal(compare(root, "before/unit.jsonl", "before/unit.jsonl").status, 0);
});

test("reports missing and added tests, status changes, lost duplicates and other suites", async (t) => {
  const root = await directory(t);
  await write(root, {
    "before.jsonl": [
      entry("unit", "a.test.js", ["kept"]),
      entry("unit", "a.test.js", ["dropped"]),
      entry("unit", "a.test.js", ["flips"]),
      entry("unit", "a.test.js", ["twice"]),
      entry("unit", "b.test.js", ["twice"]),
      entry("unit", "a.test.js", ["moves suite"]),
    ],
    "after.jsonl": [
      entry("unit", "a.test.js", ["kept"]),
      entry("unit", "a.test.js", ["flips"], "skip"),
      entry("unit", "a.test.js", ["twice"]),
      entry("integration", "a.test.js", ["moves suite"]),
      entry("unit", "n.test.js", ["new", "child"]),
    ],
  });
  const result = compare(root, "before.jsonl", "after.jsonl");
  assert.equal(result.status, 1);
  assert.deepEqual(result.stdout.trim().split("\n"), [
    'missing unit pass ["dropped"] (a.test.js)',
    'missing unit pass ["flips"] (a.test.js)',
    'missing unit pass ["moves suite"] (a.test.js)',
    'missing unit pass ["twice"] (a.test.js)',
    'added integration pass ["moves suite"] (a.test.js)',
    'added unit pass ["new","child"] (n.test.js)',
    'added unit skip ["flips"] (a.test.js)',
    "6 entries before, 5 after, 0 allowed additions: 7 differences",
  ]);
});

test("an allowlist permits exactly the expected additions and never a missing test", async (t) => {
  const root = await directory(t);
  const base = [entry("unit", "a.test.js", ["kept"]), entry("unit", "a.test.js", ["gone"])];
  await write(root, {
    "before.jsonl": base,
    "after-ok.jsonl": [...base, entry("smoke", "hh.test.js", ["hh starts"])],
    "after-two.jsonl": [...base, entry("smoke", "hh.test.js", ["hh starts"]), entry("smoke", "hh2.test.js", ["hh starts"])],
    "after-none.jsonl": base,
    "after-gone.jsonl": [base[0], entry("smoke", "hh.test.js", ["hh starts"])],
    "allow.jsonl": [{ suite: "smoke", test: ["hh starts"], status: "pass" }],
  });
  const ok = compare(root, "before.jsonl", "after-ok.jsonl", "--allow", "allow.jsonl");
  assert.equal(ok.status, 0, ok.stdout);
  assert.match(ok.stdout, /3 after, 1 allowed additions: no differences/);

  const two = compare(root, "before.jsonl", "after-two.jsonl", "--allow", "allow.jsonl");
  assert.equal(two.status, 1);
  assert.match(two.stdout, /^added smoke pass \["hh starts"\] \(hh\.test\.js\)$/m);

  const none = compare(root, "before.jsonl", "after-none.jsonl", "--allow", "allow.jsonl");
  assert.equal(none.status, 1);
  assert.match(none.stdout, /^allowed but not added smoke pass \["hh starts"\]$/m);

  const gone = compare(root, "before.jsonl", "after-gone.jsonl", "--allow", "allow.jsonl");
  assert.equal(gone.status, 1);
  assert.match(gone.stdout, /^missing unit pass \["gone"\] \(a\.test\.js\)$/m);
  assert.doesNotMatch(gone.stdout, /added/);

  const counted = compareInventories(base, [...base, base[0], base[0]], [base[0]]);
  assert.deepEqual(formatDifferences(counted), ['added unit pass ["kept"] (a.test.js)']);
  assert.equal(counted.added[0].count, 1);
});

test("rejects malformed lines, unknown statuses, empty inventories and bad arguments with exit 2", async (t) => {
  const root = await directory(t);
  const good = [entry("unit", "a.test.js", ["x"])];
  await write(root, {
    "good.jsonl": good,
    "not-json.jsonl": "{\"suite\":\n",
    "bad-status.jsonl": [entry("unit", "a.test.js", ["x"], "passed")],
    "bad-path.jsonl": [entry("unit", "a.test.js", "x")],
    "no-suite.jsonl": [{ file: "a.test.js", test: ["x"], status: "pass" }],
    "empty.jsonl": "\n",
    "empty/notes.txt": "x\n",
  });
  const cases = [
    [["not-json.jsonl", "good.jsonl"], /not-json\.jsonl:1: not JSON/],
    [["good.jsonl", "bad-status.jsonl"], /bad-status\.jsonl:1: expected/],
    [["good.jsonl", "bad-path.jsonl"], /bad-path\.jsonl:1: expected/],
    [["no-suite.jsonl", "good.jsonl"], /no-suite\.jsonl:1: expected/],
    [["good.jsonl", "empty.jsonl"], /empty\.jsonl: no inventory entries/],
    [["empty", "good.jsonl"], /empty: no inventory entries/],
    [["good.jsonl", "missing.jsonl"], /missing\.jsonl: ENOENT/],
    [["good.jsonl", "good.jsonl", "--allow", "bad-status.jsonl"], /bad-status\.jsonl:1: expected/],
    [["good.jsonl"], /usage:/],
    [["good.jsonl", "good.jsonl", "--allow"], /argument missing/],
    [["good.jsonl", "good.jsonl", "--strict"], /Unknown option '--strict'/],
  ];
  for (const [args, message] of cases) {
    const result = compare(root, ...args);
    assert.equal(result.status, 2, `${args.join(" ")}: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, message);
  }
});
