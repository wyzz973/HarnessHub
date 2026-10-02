// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { temporaryDirectory } from "../support/temporary.js";

/** A TestContext stand-in whose after hooks the test runs explicitly. */
function context(): { t: TestContext; runAfter(): Promise<void> } {
  const hooks: (() => unknown)[] = [];
  return {
    t: { after: (hook: () => unknown) => void hooks.push(hook) } as never,
    runAfter: async () => {
      for (const hook of hooks) await hook();
    },
  };
}

void test("removal is registered at creation, so a setup that throws before deferring anything cannot leak", async () => {
  const { t, runAfter } = context();
  const { directory } = await temporaryDirectory(t, "hh-temporary-");
  // A failing startHub would throw here, before the test defers its cleanup.
  await runAfter();
  await assert.rejects(access(directory), { code: "ENOENT" });
});

void test("deferred cleanups run last first, all run, and the first error is rethrown after removal", async () => {
  const { t, runAfter } = context();
  const { directory, defer } = await temporaryDirectory(t, "hh-temporary-");
  const order: string[] = [];
  defer(async () => {
    await access(directory);
    order.push("first registered");
  });
  defer(() => {
    order.push("second registered");
    throw new Error("close failed");
  });
  await assert.rejects(runAfter(), /close failed/);
  assert.deepEqual(order, ["second registered", "first registered"]);
  await assert.rejects(access(directory), { code: "ENOENT" });
});
