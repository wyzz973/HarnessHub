// SPDX-License-Identifier: MIT
/**
 * The rollback of a failed wiring puts back what the file held before, but
 * never over a change someone made after HarnessHub wrote it (a sync's
 * write racing the user's own edit).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readState, sha256 } from "../src/wiring/files.js";
import { rollBack, type WrittenFile } from "../src/wiring/operations.js";

async function directory(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "hh-rollback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** A written file as rollBack sees it: where it is, what it held before and the hash written. */
async function written(
  file: string,
  before: string | undefined,
  wrote: string,
) {
  if (before !== undefined) await writeFile(file, before);
  const state = await readState(file);
  await writeFile(file, wrote);
  return {
    plan: { path: file, realPath: file, state },
    created: [],
    hash: sha256(wrote),
  } as unknown as WrittenFile;
}

void test("a file that still holds what was written gets its bytes back, or goes when it was new", async (t) => {
  const root = await directory(t);
  const existing = path.join(root, "existing.json");
  const created = path.join(root, "created.json");
  const results = await rollBack([
    await written(existing, '{"user": 1}\n', '{"user": 1, "wired": 2}\n'),
    await written(created, undefined, '{"wired": 2}\n'),
  ]);
  assert.deepEqual(
    results.map((result) => result.restored),
    [true, true],
  );
  assert.equal(await readFile(existing, "utf8"), '{"user": 1}\n');
  await assert.rejects(stat(created), { code: "ENOENT" });
});

void test("a file changed after it was written is left as it is and reported", async (t) => {
  const root = await directory(t);
  const existing = path.join(root, "existing.json");
  const created = path.join(root, "created.json");
  const entries = [
    await written(existing, '{"user": 1}\n', '{"user": 1, "wired": 2}\n'),
    await written(created, undefined, '{"wired": 2}\n'),
  ];
  // The user's own edits land between the write and its verification.
  await writeFile(existing, '{"user": 1, "wired": 2, "mine": 3}\n');
  await writeFile(created, '{"wired": 2, "mine": 3}\n');
  const results = await rollBack(entries);
  assert.deepEqual(
    results.map((result) => [result.restored, result.error]),
    [
      [
        false,
        "The file changed after HarnessHub wrote it, so it was left as it is",
      ],
      [
        false,
        "The file changed after HarnessHub wrote it, so it was left as it is",
      ],
    ],
  );
  assert.equal(
    await readFile(existing, "utf8"),
    '{"user": 1, "wired": 2, "mine": 3}\n',
  );
  assert.equal(await readFile(created, "utf8"), '{"wired": 2, "mine": 3}\n');
});

void test("an in-place write that failed midway is restored whatever the file holds", async (t) => {
  const root = await directory(t);
  const file = path.join(root, "linked.json");
  const entry = await written(file, '{"user": 1}\n', '{"user": 1, "wir');
  // No hash: the write never completed.
  delete (entry as { hash?: string }).hash;
  const results = await rollBack([entry]);
  assert.equal(results[0]!.restored, true);
  assert.equal(await readFile(file, "utf8"), '{"user": 1}\n');
});
