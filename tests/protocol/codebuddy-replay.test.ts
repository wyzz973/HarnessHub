import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import type { ControlOptions } from "../../src/contracts/control.js";
import { createNativeControl, relayCapabilities } from "../../src/adapters/control/factory.js";
import { CodeBuddyControl } from "../../src/adapters/control/codebuddy/control.js";
import { codebuddyRelayCapabilities } from "../../src/adapters/control/codebuddy/reading.js";
import { harnessTier, loadBuiltinCatalog } from "../../src/adapters/catalog.js";

/**
 * CodeBuddy Code 2.184.0 (`codebuddy --acp`) replayed from a real recording (tests/fixtures/codebuddy, 2026-11-15): the driver's messages must be the
 * ones recorded. Signed out, only initialize and session/new could be recorded; re-record with a Turn once it is signed in.
 */
const WORKSPACE = "/Users/test/.cache/harnesshub-acceptance/codebuddy-trial/workspace";
async function replay(name: string, index: number): Promise<CodeBuddyControl> {
  const options: ControlOptions = { cwd: process.cwd(), env: {}, requestTimeoutMs: 5000, runTimeoutMs: 20_000, maxFrameBytes: 8 * 1024 * 1024, maxDiagnosticBytes: 64 * 1024, closeGraceMs: 500 };
  return await createNativeControl("codebuddy-code", { protocol: "acp-v1", executable: process.execPath,
    args: [resolve("tests/fixtures/codebuddy/replay-peer.mjs"), resolve("tests/fixtures/codebuddy", name + ".json"), String(index)], env: {} }, options) as CodeBuddyControl;
}

test("CodeBuddy Code is a focus Harness of its own: the user's npm `codebuddy`, on ACP stdio without its plugin management and self-update", () => {
  assert.equal(harnessTier("codebuddy-code"), "focus");
  const control = loadBuiltinCatalog("darwin-aarch64").find(definition => definition.id === "codebuddy-code")!.controls;
  assert.deepEqual(control.map(row => [row.id, row.protocol, row.executableNames, row.args, row.env, row.package?.name, row.distribution]),
    [["codebuddy-code-npm", "acp-v1", ["codebuddy"], ["--acp", "--no-plugin-management"], { DISABLE_AUTOUPDATER: "1" }, "@tencent-ai/codebuddy-code", null]]);
  assert.equal(relayCapabilities("codebuddy-code", "acp-v1"), codebuddyRelayCapabilities);
});

test("CodeBuddy Code replay, signed out: initialize lists its sign-in ways, the driver never authenticates, and session/new's refusal says to sign in at its own CLI", async () => {
  const control = await replay("signed-out", 0);
  try {
    const observed = await control.initialize();
    assert.equal(observed.protocol, "acp-v1");
    assert.deepEqual(observed.authenticationMethods, ["iOA", "external", "internal", "selfhosted"]);
    assert.equal(control.steering, false, "steer stays off until a real Turn shows it");
    await assert.rejects(control.open(WORKSPACE), (error: unknown) => (error as { code?: string }).code === "NATIVE_AUTH_REQUIRED" && /codebuddy/u.test((error as Error).message));
  } finally { await control.close(); }
});
