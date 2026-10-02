// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import test from "node:test";
import { jobHelperPath } from "../src/process/windows-job.js";

void test("the Job helper path is the runtime package's dist/native/harnesshub-job.exe", () => {
  const path = jobHelperPath();
  assert.ok(isAbsolute(path), path);
  assert.ok(
    path.endsWith(
      join("packages", "runtime", "dist", "native", "harnesshub-job.exe"),
    ),
    path,
  );
});

void test(
  "the Job helper exists after the build",
  {
    skip:
      process.platform !== "win32" &&
      "the Job helper is built only on Windows, with the .NET Framework compiler",
  },
  () => {
    assert.ok(
      existsSync(jobHelperPath()),
      `${jobHelperPath()} is missing; run pnpm build`,
    );
  },
);
