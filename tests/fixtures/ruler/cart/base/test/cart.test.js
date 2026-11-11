import test from "node:test";
import assert from "node:assert/strict";
import { subtotal, total } from "../src/cart.js";

const items = [
  { sku: "mug", priceCents: 1250, qty: 2 },
  { sku: "pen", priceCents: 199, qty: 5 },
];

test("subtotal adds up price times quantity", () => {
  assert.equal(subtotal(items), 3495);
  assert.equal(subtotal([]), 0);
});

test("total without a discount adds the tax to the subtotal", () => {
  assert.equal(total(items, { region: "US" }), 3740);
});

test("total taxes the amount after the discount", () => {
  assert.equal(total(items, { region: "US", discountCents: 495 }), 3210);
});
