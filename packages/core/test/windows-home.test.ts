// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { HubError } from "../src/errors.js";
import { windowsHomeEnvironment } from "../src/environment.js";

void test("Windows home variables concatenate to the private home", () => {
  const cases: [string, string, string][] = [
    ["C:\\data\\sessions\\s1\\home", "C:", "\\data\\sessions\\s1\\home"],
    ["d:/data/中文 home", "d:", "\\data\\中文 home"],
    ["\\\\server\\share\\data\\home", "\\\\server\\share", "\\data\\home"],
    ["//server/share/home", "\\\\server\\share", "\\home"],
    ["C:\\", "C:", "\\"],
    ["\\\\?\\C:\\data\\home", "\\\\?\\C:", "\\data\\home"],
    ["\\\\.\\C:\\home", "\\\\.\\C:", "\\home"],
    ["\\\\?\\UNC\\server\\share\\home", "\\\\?\\UNC", "\\server\\share\\home"],
  ];
  for (const [home, drive, rest] of cases) {
    const actual = windowsHomeEnvironment(home);
    assert.deepEqual(actual, { HOMEDRIVE: drive, HOMEPATH: rest }, home);
    assert.equal(
      actual.HOMEDRIVE + actual.HOMEPATH,
      home.replaceAll("/", "\\"),
      home,
    );
  }
});

void test("Windows home variables reject a home without a drive, share or device root", () => {
  for (const home of [
    "\\data\\home",
    "/data/home",
    "C:",
    "C:data",
    "data\\home",
    "\\\\server",
    "\\\\server\\",
    "\\\\\\share\\home",
    "",
  ])
    assert.throws(
      () => windowsHomeEnvironment(home),
      (error: unknown) =>
        error instanceof HubError &&
        error.code === "WORKER_PRIVATE_PATH_INVALID",
      home,
    );
});
