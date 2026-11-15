import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import type { ControlOptions } from "../../src/contracts/control.js";
import { AcpControl, NEVER_SENT } from "../../src/adapters/control/acp.js";
import { ControlError } from "../../src/infrastructure/control/json-rpc-process.js";

const options: ControlOptions = { cwd: process.cwd(), env: {}, requestTimeoutMs: 1000, runTimeoutMs: 1500, maxFrameBytes: 65536, maxDiagnosticBytes: 1024, closeGraceMs: 150 };
type Wire = { request(method: string, params: unknown): Promise<unknown>; notify(method: string, params: unknown): Promise<void> };
const forbidden = (error: unknown): boolean => error instanceof ControlError && error.code === "METHOD_FORBIDDEN";

// WorkBuddy's CodeBuddy Code signs the user out when it is asked to authenticate (2026-11-15): no ACP Driver may send it, whoever asks.
test("an ACP connection refuses to send authenticate before anything is written, and stays usable", async () => {
  assert.ok(NEVER_SENT.has("authenticate"));
  const directory = await mkdtemp(join(tmpdir(), "acp-never-authenticate-")), trace = join(directory, "trace");
  const driver = new AcpControl({ protocol: "acp-v1", executable: process.execPath, args: [resolve("tests/fixtures/control-peer.mjs"), "acp-v1", "split"], env: { FIXTURE_TRACE: trace } }, options);
  try {
    // The fixture advertises a sign-in method; it is never used.
    assert.deepEqual((await driver.initialize()).authenticationMethods, ["fixture-login"]);
    const wire = (driver as unknown as { rpc: Wire }).rpc;
    await assert.rejects(wire.request("authenticate", { methodId: "fixture-login" }), forbidden);
    await assert.rejects(wire.notify("authenticate", { methodId: "fixture-login" }), forbidden);
    const id = await driver.open(process.cwd());
    const run = await driver.startText(id, "hello", () => {});
    assert.equal((await run.result).status, "completed");
    const methods = (await readFile(trace, "utf8")).trim().split("\n").map(line => (JSON.parse(line) as { method?: string }).method);
    assert.ok(methods.includes("initialize") && methods.includes("session/new") && methods.includes("session/prompt"));
    assert.equal(methods.includes("authenticate"), false);
  } finally { await driver.close(); await rm(directory, { recursive: true, force: true }); }
});
