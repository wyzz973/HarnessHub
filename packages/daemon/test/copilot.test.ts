// SPDX-License-Identifier: MIT
/** Copilot accounts on the daemon side: the CLI lookup, quota readings and the stored secret. */
import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  copilotReadings,
  decodeCopilotSecret,
  encodeCopilotSecret,
  findCopilotCli,
  isFineGrainedToken,
} from "../src/copilot.js";

void test("the Copilot CLI is the first executable copilot on PATH", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hh-copilot-path-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const plain = path.join(root, "plain");
  const runnable = path.join(root, "runnable");
  const directory = path.join(root, "directory");
  await mkdir(plain);
  await mkdir(runnable);
  await mkdir(path.join(directory, "copilot"), { recursive: true });
  await writeFile(path.join(plain, "copilot"), "");
  await writeFile(path.join(runnable, "copilot"), "#!/bin/sh\n");
  await chmod(path.join(runnable, "copilot"), 0o755);
  const PATH = ["relative", directory, plain, runnable].join(":");
  assert.equal(
    await findCopilotCli({ PATH }, "linux"),
    path.join(runnable, "copilot"),
  );
  assert.equal(await findCopilotCli({ PATH: plain }, "linux"), undefined);
  assert.equal(await findCopilotCli({}, "linux"), undefined);
  // Windows: PATHEXT names, any case of Path, no executable bit.
  await writeFile(path.join(plain, "copilot.cmd"), "");
  assert.equal(
    await findCopilotCli({ Path: plain, PATHEXT: ".EXE;.CMD" }, "win32"),
    path.join(plain, "copilot.cmd"),
  );
});

void test("quota snapshots become readings; unlimited windows are none", () => {
  const now = Date.parse("2026-10-04T12:00:00.000Z");
  assert.deepEqual(
    copilotReadings(
      [
        {
          name: "premium_interactions",
          unlimited: false,
          remainingPercentage: 62.5,
          resetDate: "2026-11-01T00:00:00Z",
        },
        { name: "chat", unlimited: true, remainingPercentage: 100 },
        { name: "over", unlimited: false, remainingPercentage: -5 },
      ],
      now,
    ),
    [
      {
        window: "premium_interactions",
        usedPercent: 37.5,
        resetsAt: "2026-11-01T00:00:00.000Z",
        // October: the month before the renewal.
        spanSeconds: 31 * 86_400,
        observedAt: "2026-10-04T12:00:00.000Z",
      },
      {
        window: "over",
        usedPercent: 100,
        observedAt: "2026-10-04T12:00:00.000Z",
      },
    ],
  );
});

void test("the stored secret holds a token account's token, and nothing else reads as one", () => {
  const token = `github_pat_${"a".repeat(40)}`;
  assert.equal(
    encodeCopilotSecret({ v: 1, token }),
    `{"v":1,"token":"${token}"}`,
  );
  assert.deepEqual(decodeCopilotSecret(encodeCopilotSecret({ v: 1, token })), {
    v: 1,
    token,
  });
  assert.deepEqual(decodeCopilotSecret('{"v":1}'), { v: 1 });
  assert.deepEqual(decodeCopilotSecret("not json"), { v: 1 });
  assert.deepEqual(decodeCopilotSecret('{"v":2,"token":"x"}'), { v: 1 });
  assert.ok(isFineGrainedToken(token));
  assert.ok(!isFineGrainedToken(`ghp_${"a".repeat(36)}`));
  assert.ok(!isFineGrainedToken("github_pat_short"));
  assert.ok(!isFineGrainedToken(`github_pat_${"a".repeat(40)} trailing`));
});
