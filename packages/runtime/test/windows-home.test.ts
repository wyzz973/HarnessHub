// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { HubError } from "@harnesshub/core/errors";
import { windowsHomeEnvironment } from "../src/process/worker-host.js";

void test("Windows home variables concatenate to the private home", () => {
  assert.deepEqual(windowsHomeEnvironment("C:\\data\\sessions\\s1\\home"), {
    HOMEDRIVE: "C:",
    HOMEPATH: "\\data\\sessions\\s1\\home",
  });
  assert.deepEqual(windowsHomeEnvironment("d:/data/中文 home"), {
    HOMEDRIVE: "d:",
    HOMEPATH: "\\data\\中文 home",
  });
  assert.deepEqual(windowsHomeEnvironment("\\\\server\\share\\data\\home"), {
    HOMEDRIVE: "\\\\server\\share",
    HOMEPATH: "\\data\\home",
  });
  assert.deepEqual(windowsHomeEnvironment("C:\\"), {
    HOMEDRIVE: "C:",
    HOMEPATH: "\\",
  });
});

void test("Windows home variables reject a home without a drive or share", () => {
  for (const home of ["\\data\\home", "/data/home", "C:", "data\\home", ""])
    assert.throws(
      () => windowsHomeEnvironment(home),
      (error: unknown) =>
        error instanceof HubError &&
        error.code === "WORKER_PRIVATE_PATH_INVALID",
      home,
    );
});
