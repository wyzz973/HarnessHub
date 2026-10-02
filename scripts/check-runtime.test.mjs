import assert from "node:assert/strict";
import test from "node:test";
import { checkRuntime } from "./check-runtime.mjs";

test("accepts the pinned Node patch", () => {
  assert.doesNotThrow(() => checkRuntime("24.20.0", "24.20.0"));
});

test("rejects an unverified major or patch", () => {
  assert.throws(() => checkRuntime("25.9.0", "24.20.0"), /Expected Node/);
  assert.throws(() => checkRuntime("24.19.0", "24.20.0"), /Expected Node/);
});
