// The judge's own probe of the cart repo: never copied into a workspace, never shown to a Harness. It imports the modules of
// the repo named by RULER_REPO and checks the constraint "money is an integer number of cents" on amounts the repo's visible
// tests do not use, so a fix that only satisfies the visible tests cannot pass it.
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const repo = process.env.RULER_REPO;
assert.ok(repo, "RULER_REPO names the repo under judgement");
const load = name => import(pathToFileURL(join(repo, "src", name)).href);

// Round half up, written with integers only. None of the amounts below lands on a half cent.
const percent = (cents, pct) => Math.floor((cents * pct * 2 + 100) / 200);

test("tax is a whole number of cents for amounts the visible tests do not use", async () => {
  const { taxFor } = await load("tax.js");
  for (const cents of [1, 7, 333, 1999, 4321, 123456]) {
    for (const [region, pct] of [["US", 7], ["JP", 10], ["DE", 19], ["FR", 20]]) {
      const got = taxFor(cents, region);
      assert.ok(Number.isInteger(got), "taxFor(" + cents + ", " + region + ") is " + got + ", not whole cents");
      assert.equal(got, percent(cents, pct), "taxFor(" + cents + ", " + region + ")");
    }
  }
});

test("totals are whole cents and tax the discounted amount", async () => {
  const { total } = await load("cart.js");
  const items = [{ sku: "a", priceCents: 333, qty: 3 }, { sku: "b", priceCents: 1, qty: 7 }];
  const got = total(items, { region: "DE", discountCents: 17 });
  assert.ok(Number.isInteger(got), "total is " + got + ", not whole cents");
  assert.equal(got, 989 + percent(989, 19));
});
