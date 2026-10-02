// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import test from "node:test";
import { secretHelperPath } from "../src/native-helper.js";

const helpers = [
  {
    platform: "darwin",
    file: "harnesshub-keychain",
    builder: "/usr/bin/swiftc",
  },
  {
    platform: "win32",
    file: "harnesshub-secrets.exe",
    builder: "the .NET Framework compiler",
  },
] as const;

for (const { platform, file, builder } of helpers) {
  void test(`the ${platform} secret helper path is the secrets package's dist/native/${file}`, () => {
    const path = secretHelperPath(platform);
    assert.ok(isAbsolute(path), path);
    assert.ok(
      path.endsWith(join("packages", "secrets", "dist", "native", file)),
      path,
    );
  });

  void test(
    `the ${platform} secret helper exists after the build`,
    {
      skip:
        process.platform !== platform &&
        `the ${platform} helper is built only on ${platform}, with ${builder}`,
    },
    () => {
      const path = secretHelperPath(platform);
      assert.ok(existsSync(path), `${path} is missing; run pnpm build`);
    },
  );
}
