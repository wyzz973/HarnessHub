// SPDX-License-Identifier: MIT
/**
 * Build the Windows ACL helper into this package's dist/native.
 * Usage: node packages/store/native/build-windows-acl.mjs (run by `pnpm build`)
 *
 * On Windows, compiles windows-acl.cs with the .NET Framework C# compiler into
 * packages/store/dist/native/harnesshub-acl.exe, the path that
 * src/platform/native-helper.ts computes. Paths are resolved from this file, not
 * from the working directory. Fails when SystemRoot or the compiler is missing;
 * does nothing on other platforms.
 */
import { existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform === "win32") {
  const root = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!root)
    throw new Error("Windows SystemRoot is required to build the ACL helper");
  const compiler = ["Framework64", "Framework"]
    .map((framework) =>
      join(root, "Microsoft.NET", framework, "v4.0.30319", "csc.exe"),
    )
    .find(existsSync);
  if (!compiler)
    throw new Error(
      "Windows .NET Framework C# compiler is required for the ACL helper",
    );
  const output = fileURLToPath(new URL("../dist/native/", import.meta.url));
  mkdirSync(output, { recursive: true });
  const result = spawnSync(
    compiler,
    [
      "/nologo",
      "/target:exe",
      "/platform:anycpu",
      "/optimize+",
      "/reference:System.Web.Extensions.dll",
      `/out:${join(output, "harnesshub-acl.exe")}`,
      fileURLToPath(new URL("./windows-acl.cs", import.meta.url)),
    ],
    { stdio: "inherit", windowsHide: true },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
