import test from "node:test";
import assert from "node:assert/strict";
import { toCents, formatCents } from "../src/money.js";

test("toCents parses whole and fractional amounts", () => {
  assert.equal(toCents("12.34"), 1234);
  assert.equal(toCents("5"), 500);
  assert.equal(toCents("0.5"), 50);
});

test("formatCents pads the fraction to two digits", () => {
  assert.equal(formatCents(1234), "12.34");
  assert.equal(formatCents(5), "0.05");
  assert.equal(formatCents(100), "1.00");
});
