import test from "node:test";
import assert from "node:assert/strict";
import { taxFor } from "../src/tax.js";

test("US tax is 7%", () => {
  assert.equal(taxFor(10000, "US"), 700);
  assert.equal(taxFor(1999, "US"), 140);
});

test("JP tax is 10%", () => {
  assert.equal(taxFor(2500, "JP"), 250);
});

test("DE tax is 19%", () => {
  assert.equal(taxFor(10000, "DE"), 1900);
  assert.equal(taxFor(1999, "DE"), 380);
});

test("FR tax is 20%", () => {
  assert.equal(taxFor(1050, "FR"), 210);
});

test("unknown regions are rejected", () => {
  assert.throws(() => taxFor(100, "XX"), /unknown region/);
});
