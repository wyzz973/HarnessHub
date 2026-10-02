import test from "node:test";
import assert from "node:assert/strict";
import {
  IPC_MAX_BYTES,
  matchesIdentity,
  parseHostCommand,
  parseWorkerMessage,
} from "../../src/domain/ipc.js";
import type { RunId, SessionId } from "../../src/domain/types.js";

void test("IPC rejects unsupported protocol, unknown fields, identities, and oversized UTF-8", () => {
  assert.deepEqual(parseWorkerMessage({ version: 1, type: "ready", pid: 42 }), {
    version: 1,
    type: "ready",
    pid: 42,
  });
  assert.throws(
    () => parseWorkerMessage({ version: 2, type: "ready", pid: 42 }),
    /Invalid/,
  );
  assert.throws(
    () =>
      parseHostCommand({ version: 1, type: "shutdown", executable: "evil" }),
    /Invalid/,
  );
  assert.throws(
    () =>
      parseHostCommand({
        version: 1,
        type: "cancel",
        sessionId: "s",
        runId: "r",
        generation: 0,
      }),
    /Invalid/,
  );
  assert.throws(
    () =>
      parseWorkerMessage({ text: "中".repeat(Math.ceil(IPC_MAX_BYTES / 3)) }),
    /size limit/,
  );
  const identity = {
    sessionId: "s" as SessionId,
    runId: "r" as RunId,
    generation: 1,
  };
  assert.equal(
    matchesIdentity(identity, { ...identity, generation: 2 }),
    false,
  );
});
