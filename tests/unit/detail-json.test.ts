import assert from "node:assert/strict";
import test from "node:test";
import type { NativeToolDetail } from "../../src/contracts/control.js";
import { DETAIL_PIECE, detailJson } from "../../src/contexts/session/domain/detail-json.js";

// A tool call's detail is kept whole, however large, and written in pieces (src/contexts/session/domain/detail-json.ts): the pieces joined are exactly the JSON the detail has always been
// kept as, so that a small one is the same bytes and a large one is read back by the same reader.

const joined = (toolId: string, detail: NativeToolDetail): Buffer => Buffer.concat([...detailJson(toolId, detail)]);
const expected = (toolId: string, detail: NativeToolDetail): Buffer => Buffer.from(JSON.stringify({ toolId, ...detail }), "utf8");

test("the pieces of a detail joined are the bytes JSON.stringify gives of it, for every shape a detail has", () => {
  const details: NativeToolDetail[] = [
    {}, { kind: "execute" }, { kind: "execute", name: "Bash", input: "ls -la", output: "total 0\n", exitCode: 0, locations: ["/a", "/b"], parentId: "p", truncated: true },
    { input: "quotes \" and backslash \\ and newline \n and tab \t and control \u0001 and DEL \u007f", output: "unicode é 中文 🚀   " },
    { output: "a lone high \ud83d and a lone low \ude00 are written as escapes" },
    { exitCode: -1, diff: "--- a\n+++ b\n" },
  ];
  for (const detail of details) assert.deepEqual(joined("tool-1", detail), expected("tool-1", detail), JSON.stringify(detail).slice(0, 80));
  assert.deepEqual(joined("a\"b", { input: "x" }), expected("a\"b", { input: "x" }), "the id is escaped like any string");
  const withUndefined = { input: "x", output: undefined } as unknown as NativeToolDetail;
  assert.deepEqual(joined("t", withUndefined), expected("t", withUndefined), "an absent field is not written");
});

test("a long string is written in pieces of its own, and a piece never splits the two halves of a pair", () => {
  for (const [name, text] of [
    ["ascii", "x".repeat(DETAIL_PIECE * 3 + 17)],
    ["pairs everywhere", "🚀".repeat(DETAIL_PIECE * 2 + 5)],
    ["a pair across the first boundary", "a".repeat(DETAIL_PIECE - 1) + "🚀" + "b".repeat(100)],
    ["a pair across the second boundary", "a".repeat(DETAIL_PIECE * 2 - 1) + "🚀" + "b".repeat(100)],
    ["escapes across a boundary", "\"".repeat(DETAIL_PIECE + 3) + "\n".repeat(DETAIL_PIECE)],
    ["lone halves", "\ud83d".repeat(DETAIL_PIECE + 2) + "\ude00".repeat(7)],
  ] as const) {
    const detail: NativeToolDetail = { kind: "execute", output: text, exitCode: 2 }, pieces = [...detailJson("big", detail)];
    assert.ok(pieces.length >= 6, name + ": in pieces (" + pieces.length + ")");
    assert.ok(pieces.every(piece => piece.byteLength <= DETAIL_PIECE * 6 + 8), name + ": none of them is the whole");
    assert.deepEqual(Buffer.concat(pieces), expected("big", detail), name);
    assert.equal((JSON.parse(Buffer.concat(pieces).toString("utf8")) as { output: string }).output, text, name + ": read back whole");
  }
});

test("a detail of tens of MiB is made in pieces, none larger than a few MiB", () => {
  const text = "line of output with some words in it\n".repeat(1_000_000);
  assert.ok(text.length > 32 * 1024 * 1024);
  let total = 0, largest = 0, count = 0;
  for (const piece of detailJson("huge", { kind: "execute", name: "Bash", input: "make", output: text })) { total += piece.byteLength; largest = Math.max(largest, piece.byteLength); count++; }
  assert.ok(total > 32 * 1024 * 1024 && largest < 2 * 1024 * 1024 && count > 100, `${total} bytes in ${count} pieces, the largest ${largest}`);
});
