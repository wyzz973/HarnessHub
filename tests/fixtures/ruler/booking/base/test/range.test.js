import test from "node:test";
import assert from "node:assert/strict";
import { length, makeRange, overlaps } from "../src/range.js";

test("makeRange rejects an empty or backwards range", () => {
  assert.throws(() => makeRange(10, 10), /empty range/);
  assert.throws(() => makeRange(11, 9), /empty range/);
});

test("makeRange rejects fractional hours", () => {
  assert.throws(() => makeRange(9.5, 11), /whole numbers/);
});

test("overlaps is true for ranges that cross", () => {
  assert.equal(overlaps(makeRange(9, 11), makeRange(10, 12)), true);
  assert.equal(overlaps(makeRange(9, 12), makeRange(10, 11)), true);
});

test("overlaps is false for ranges that only touch", () => {
  assert.equal(overlaps(makeRange(9, 10), makeRange(10, 11)), false);
  assert.equal(overlaps(makeRange(10, 11), makeRange(9, 10)), false);
});

test("length is the number of hours", () => {
  assert.equal(length(makeRange(9, 12)), 3);
});
