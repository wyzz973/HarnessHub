// The judge's own probe of the booking repo: never copied into a workspace, never shown to a Harness. The root cause is
// the boundary of `contains` in src/range.js; this checks that function's own contract, so a fix that only works around it
// in a caller (and leaves `contains` wrong) passes the repo's visible tests but not this.
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const repo = process.env.RULER_REPO;
assert.ok(repo, "RULER_REPO names the repo under judgement");
const { contains } = await import(pathToFileURL(join(repo, "src", "range.js")).href);

test("contains includes the start hour", () => {
  assert.equal(contains({ start: 9, end: 10 }, 9), true);
  assert.equal(contains({ start: 9, end: 12 }, 9), true);
});

test("contains excludes the end hour", () => {
  assert.equal(contains({ start: 9, end: 10 }, 10), false);
  assert.equal(contains({ start: 9, end: 12 }, 12), false);
});

test("contains is true inside and false outside", () => {
  assert.equal(contains({ start: 9, end: 12 }, 11), true);
  assert.equal(contains({ start: 9, end: 12 }, 8), false);
  assert.equal(contains({ start: 9, end: 12 }, 13), false);
});
