import assert from "node:assert/strict";
import test from "node:test";
import type { ContentRef } from "../../src/contracts/content.js";
import { contentId } from "../../src/contracts/content.js";
import { DetailHeads, type DetailSource } from "../../src/web/detail-heads.js";

// The heads of the stored tool details the display layer reads from the content store (src/web/detail-heads.ts): read once and kept, and a detail that cannot be read is no error.

const ref = (name: string): ContentRef => ({ id: contentId("content-" + name), name: name + ".json", mediaType: "application/json", kind: "file", bytes: 10, sha256: "4".repeat(64) });
/** A content store that holds some details and counts how often each is read. */
function source(held: Record<string, unknown>): DetailSource & { readonly reads: Map<string, number> } {
  const reads = new Map<string, number>();
  return { reads, readTextSync: item => { reads.set(item.id, (reads.get(item.id) ?? 0) + 1); const value = held[item.id]; return value === undefined ? null : typeof value === "string" ? value : JSON.stringify(value); } };
}

test("a detail's head is read once and kept, for as many reads as ask", () => {
  const store = source({ "content-a": { input: "pwd", output: "x".repeat(10_000), locations: ["/w"] }, "content-b": { diff: "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-1\n+2\n" } });
  const heads = new DetailHeads(store);
  assert.deepEqual(heads.read(ref("a")), { input: "pwd", locations: ["/w"] }, "the output is not kept: it is fetched when a call is opened");
  assert.deepEqual(heads.read(ref("b")), { files: [{ path: "x", op: "edit", added: 1, removed: 1 }] });
  heads.read(ref("a")); heads.read(ref("b"));
  assert.deepEqual([...store.reads], [["content-a", 1], ["content-b", 1]]); assert.equal(heads.size, 2);
});

test("a detail that cannot be read is no error: it is missed, not asked for again for a while, and read once it can be", () => {
  let now = 1000;
  const held: Record<string, unknown> = { "content-text": "not json" }, store = source(held), heads = new DetailHeads(store, { retryMs: 500, now: () => now });
  assert.equal(heads.read(ref("gone")), null); assert.equal(heads.read(ref("text")), null);
  held["content-gone"] = { input: "ls" };
  assert.equal(heads.read(ref("gone")), null, "within the wait it is not asked for again"); assert.equal(store.reads.get("content-gone"), 1);
  now += 600; assert.deepEqual(heads.read(ref("gone")), { input: "ls" }); assert.equal(store.reads.get("content-gone"), 2);
  assert.equal(new DetailHeads(undefined).read(ref("any")), null, "a Gateway with no store to read from tells every call by its title");
  assert.equal(new DetailHeads({ readTextSync: () => { throw new Error("disk"); } }).read(ref("any")), null, "a read that throws is a detail not read");
});

test("what is kept is bounded in entries, and no read of Turns is refused for the number of details it needs: the longest unused head leaves first", () => {
  const store = source(Object.fromEntries(["a", "b", "c", "d", "e"].map(name => ["content-" + name, { input: name }]))), heads = new DetailHeads(store, { maxEntries: 3 });
  assert.deepEqual(["a", "b", "c", "d", "e"].map(name => heads.read(ref(name))?.input), ["a", "b", "c", "d", "e"], "every detail asked for is read, however many");
  // Three heads are kept, the longest unused leaving first: a, and then b, went; c, d and e stayed.
  assert.equal(heads.size, 3);
  heads.read(ref("c")); heads.read(ref("a")); assert.equal(store.reads.get("content-c"), 1, "c was kept"); assert.equal(store.reads.get("content-a"), 2, "a had left, so it was read again");
});
