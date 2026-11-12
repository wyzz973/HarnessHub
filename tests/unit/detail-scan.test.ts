import assert from "node:assert/strict";
import test from "node:test";
import { detailJson } from "../../src/contexts/session/domain/detail-json.js";
import { scanDetail, type FieldPolicy } from "../../src/contexts/session/domain/detail-scan.js";

// A stored tool detail read in one pass (domain/detail-scan.ts): whatever the pieces it arrives in, the fields a reader keeps are what JSON.parse gives, and a text too long
// to keep is reduced to its first and last characters with its length and lines counted.

/** A small deterministic generator, so that a failure can be repeated. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 0x100000000; };
}
const whole = (limit = Number.MAX_SAFE_INTEGER): FieldPolicy => ({ whole: limit, head: 0, tail: 0 });
const PIECES = ["plain", "é", "你好", "😀", "line\nbreak", 'quote"inside', "back\\slash", "tab\tstop", "\u0001control", "{brace}", "[bracket]", " sep", "a/b", "x".repeat(40)];
function textOf(next: () => number, parts: number): string { return Array.from({ length: parts }, () => PIECES[Math.floor(next() * PIECES.length)]!).join(next() < 0.5 ? "" : " "); }
function encode(value: unknown): Uint8Array { return new TextEncoder().encode(JSON.stringify(value)); }
/** `bytes` cut at the given offsets. */
function cutAt(bytes: Uint8Array, offsets: readonly number[]): Uint8Array[] {
  const points = [0, ...[...new Set(offsets)].filter(at => at > 0 && at < bytes.length).sort((a, b) => a - b), bytes.length];
  return points.slice(0, -1).map((from, index) => bytes.subarray(from, points[index + 1]));
}

test("the fields a reader keeps are what JSON.parse gives, in any key order and cut into pieces at every byte", async () => {
  const next = random(7);
  for (let round = 0; round < 40; round++) {
    const fields: [string, unknown][] = [["toolId", "tool-" + round], ["kind", "execute"], ["input", textOf(next, 3)], ["output", textOf(next, 6)], ["diff", textOf(next, 4)],
      ["locations", [textOf(next, 1), textOf(next, 1)]], ["exitCode", Math.floor(next() * 5) - 1], ["truncated", next() < 0.5], ["extra", { nested: [1, { deep: "}]\"" }, "x"], text: textOf(next, 2) }], ["parentId", null]];
    fields.sort(() => next() - 0.5);
    const value = Object.fromEntries(fields), bytes = encode(value), expected = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
    const check = async (pieces: Uint8Array[], how: string) => {
      const found = await scanDetail(pieces, () => whole());
      assert.equal(found.valid, true, how + ": read to the end");
      for (const key of ["toolId", "kind", "input", "output", "diff"]) assert.equal(found.texts[key]?.head, expected[key], how + ": " + key);
      assert.deepEqual(found.lists.locations, expected.locations, how + ": locations");
      assert.equal(found.numbers.exitCode, expected.exitCode, how + ": exitCode");
      assert.equal(found.flags.truncated, expected.truncated, how + ": truncated");
      assert.equal(found.texts.parentId, undefined, how + ": null is not a text");
      assert.equal(found.texts.extra, undefined, how + ": a value that is not read is passed over");
      assert.equal(found.texts.input!.cut, false);
      assert.equal(found.texts.output!.chars, (expected.output as string).length);
      assert.equal(found.texts.output!.newlines, (expected.output as string).split("\n").length - 1);
    };
    if (round < 6) for (let at = 0; at <= bytes.length; at++) await check(cutAt(bytes, [at]), "round " + round + " cut at " + at);
    else {
      for (let tries = 0; tries < 12; tries++) await check(cutAt(bytes, Array.from({ length: 1 + Math.floor(next() * 12) }, () => Math.floor(next() * bytes.length))), "round " + round + " random cuts");
      await check(Array.from(bytes, byte => Uint8Array.of(byte)), "round " + round + " one byte at a time");
    }
  }
});

test("a text too long to keep is its first and last characters, counted, and never half of a pair", async () => {
  const policy: FieldPolicy = { whole: 10, head: 4, tail: 5 };
  const body = "ab😀cd\nefghij😀klm\nno";
  const found = await scanDetail(cutAt(encode({ input: "short", output: body }), [9, 20, 25]), key => key === "output" ? policy : whole());
  const output = found.texts.output!;
  assert.deepEqual([output.cut, output.chars, output.newlines], [true, body.length, 2]);
  assert.equal(output.head, "ab😀".slice(0, 4), "the head of four characters");
  assert.equal(output.tail, body.slice(-5), "and the tail of five");
  assert.equal(found.texts.input!.head, "short");
  // A pair split by the cut leaves neither of its halves.
  const edge = await scanDetail([encode({ output: "abc😀def" })], () => ({ whole: 4, head: 4, tail: 4 }));
  assert.equal(edge.texts.output!.head, "abc", "the high half the head ends with is dropped");
  assert.equal(edge.texts.output!.tail, "def", "and the low half the tail starts with");
  const empty = await scanDetail([encode({ output: "x".repeat(50) })], () => ({ whole: 5, head: 0, tail: 0 }));
  assert.deepEqual([empty.texts.output!.head, empty.texts.output!.tail, empty.texts.output!.chars, empty.texts.output!.cut], ["", "", 50, true], "a reader that wants neither end still gets the length");
});

test("escapes and multibyte letters split between pieces are whole again", async () => {
  const value = { output: 'é你😀 é \\u00e9 \\" \\\\ \n\t "quoted" 😀 end' };
  const bytes = encode(value), expected = JSON.parse(JSON.stringify(value)) as { output: string };
  for (let first = 1; first < bytes.length; first += 1) for (const second of [first + 1, first + 2, first + 3, first + 5]) {
    const found = await scanDetail(cutAt(bytes, [first, second]), () => whole());
    assert.equal(found.texts.output!.head, expected.output, "cut at " + first + " and " + second);
  }
  // The writer's own escapes of a lone surrogate and of the control characters.
  const lone = { output: "a\ud800b\u0000c\u001fd" };
  assert.equal((await scanDetail([encode(lone)], () => whole())).texts.output!.head, lone.output);
});

test("what is not a complete object is not valid, and what is not read is passed over", async () => {
  assert.equal((await scanDetail([new TextEncoder().encode('{"output":"half')], () => whole())).valid, false);
  assert.equal((await scanDetail([new TextEncoder().encode('{"exitCode":1')], () => whole())).valid, false, "a number that ends the input has not ended");
  assert.equal((await scanDetail([new TextEncoder().encode("[1,2]")], () => whole())).valid, false);
  assert.equal((await scanDetail([], () => whole())).valid, false);
  const odd = await scanDetail([new TextEncoder().encode('{ "a" : { "b" : [ "}" , "\\"" , { "c" : "]" } ] } , "output" : "kept" , "locations" : [ "x" , 3 , { "y" : [ "z" ] } , "w" ] }')], () => whole());
  assert.deepEqual([odd.valid, odd.texts.output?.head, odd.lists.locations], [true, "kept", ["x", "w"]], "entries of a list that are not texts are passed over");
});

test("the detail the runtime writes, tens of MiB of it, is read in a pass with only its ends kept", async () => {
  const output = Array.from({ length: 300_000 }, (_, index) => "line " + index + " of a long build output").join("\n") + "\nlast line\n";
  const detail = { kind: "execute", name: "Bash", input: "make build-all --verbose", output, exitCode: 2, locations: ["/work/a.ts"] };
  assert.equal(output.length > 8 * 1024 * 1024, true);
  // The pieces the writer makes, regrouped into pieces of other sizes.
  const pieces = [...detailJson("big", detail)], joined = Buffer.concat(pieces);
  const regrouped = Array.from({ length: Math.ceil(joined.length / 70_001) }, (_, index) => joined.subarray(index * 70_001, (index + 1) * 70_001));
  const found = await scanDetail(regrouped, key => key === "output" ? { whole: 0, head: 100, tail: 64 * 1024 } : { whole: 1024 * 1024, head: 0, tail: 0 });
  assert.equal(found.valid, true);
  assert.equal(found.texts.input!.head, "make build-all --verbose", "the command is there");
  assert.deepEqual(found.lists.locations, ["/work/a.ts"]);
  assert.equal(found.numbers.exitCode, 2);
  const text = found.texts.output!;
  assert.deepEqual([text.cut, text.chars, text.newlines, text.tail], [true, output.length, output.split("\n").length - 1, output.slice(-64 * 1024)]);
  assert.equal(text.head, output.slice(0, 100));
});
