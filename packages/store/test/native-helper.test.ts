// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import test from "node:test";
import { aclHelperPath } from "../src/platform/native-helper.js";

void test("the ACL helper path is the store package's dist/native/harnesshub-acl.exe", () => {
  const path = aclHelperPath();
  assert.ok(isAbsolute(path), path);
  assert.ok(
    path.endsWith(
      join("packages", "store", "dist", "native", "harnesshub-acl.exe"),
    ),
    path,
  );
});

void test(
  "the ACL helper exists after the build",
  {
    skip:
      process.platform !== "win32" &&
      "the ACL helper is built only on Windows, with the .NET Framework compiler",
  },
  () => {
    assert.ok(
      existsSync(aclHelperPath()),
      `${aclHelperPath()} is missing; run pnpm build`,
    );
  },
);
