// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { inspect } from "node:util";
import test from "node:test";
import type {
  ProcessLauncher,
  ProcessRun,
  ProcessRunResult,
} from "@harnesshub/core/process-launcher";
import { resolveSecret } from "../src/secrets.js";

const helper = ["darwin", "win32"].includes(process.platform)
  ? false
  : "the platform secret helper exists on macOS and Windows only";
const CANARY = "HH-CANARY-helper-output-7c1f";

/** A launcher whose helper "runs" with the given outcome, recording each request. */
function stub(result: Partial<ProcessRunResult>) {
  const requests: ProcessRun[] = [];
  const launcher: ProcessLauncher = {
    launch: () => {
      throw new Error("The secret helper is only run to completion");
    },
    run: (spec) => {
      requests.push(spec);
      return Promise.resolve({
        code: 0,
        signal: null,
        timedOut: false,
        aborted: false,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        ...result,
      });
    },
  };
  return { launcher, requests };
}

function exposed(error: unknown): string {
  return `${String(error)} ${JSON.stringify(error)} ${inspect(error, { depth: 5 })}`;
}

void test(
  "a Keychain reference without an injected launcher is a composition defect",
  { skip: helper },
  async () => {
    await assert.rejects(
      resolveSecret({ kind: "keychain", value: "fixture" }, {}),
      { code: "PROCESS_LAUNCHER_NOT_INJECTED", statusCode: 500 },
    );
  },
);

void test(
  "helper output never reaches the thrown error, even when the helper fails",
  { skip: helper },
  async () => {
    // stderr is never read; stdout only yields an allow-listed stage.
    const failed = stub({
      code: 1,
      stdout: Buffer.from(`{"stage":"read","detail":"${CANARY}"}`),
      stderr: Buffer.from(`${CANARY} secret value in stderr`),
    });
    let error: unknown;
    await resolveSecret(
      { kind: "keychain", value: "fixture" },
      {},
      failed.launcher,
    ).catch((caught: unknown) => {
      error = caught;
    });
    assert.ok(error);
    assert.equal((error as { code?: string }).code, "SECRET_UNAVAILABLE");
    assert.deepEqual((error as { cause?: unknown }).cause, {
      operation: "read",
      stage: "read",
    });
    assert.equal(exposed(error).includes(CANARY), false);
    // The request travels on stdin; argv carries nothing.
    assert.deepEqual(failed.requests[0]?.args, []);
    assert.match(String(failed.requests[0]?.input), /"operation":"read"/);

    const unreadable = stub({
      code: 1,
      stdout: Buffer.from(`not JSON ${CANARY}`),
      stderr: Buffer.from(CANARY),
    });
    let second: unknown;
    await resolveSecret(
      { kind: "keychain", value: "fixture" },
      {},
      unreadable.launcher,
    ).catch((caught: unknown) => {
      second = caught;
    });
    assert.deepEqual((second as { cause?: unknown }).cause, {
      operation: "read",
      stage: "unavailable",
    });
    assert.equal(exposed(second).includes(CANARY), false);

    const timedOut = stub({ code: null, signal: "SIGKILL", timedOut: true });
    await assert.rejects(
      resolveSecret(
        { kind: "keychain", value: "fixture" },
        {},
        timedOut.launcher,
      ),
      (caught: unknown) => {
        assert.deepEqual((caught as { cause?: unknown }).cause, {
          operation: "read",
          stage: "timeout",
        });
        return true;
      },
    );
    assert.equal(timedOut.requests[0]?.killSignal, "SIGKILL");
  },
);
