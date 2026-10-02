// SPDX-License-Identifier: MIT
/**
 * Build this platform's system secret helper into this package's dist/native.
 * Usage: node packages/secrets/native/build-keychain.mjs (run by `pnpm build`)
 *
 * macOS: compiles keychain.swift with /usr/bin/swiftc into
 * dist/native/harnesshub-keychain. Windows: compiles windows-secrets.cs with the
 * .NET Framework C# compiler into dist/native/harnesshub-secrets.exe. These are
 * the paths src/native-helper.ts computes. Paths are resolved from this file,
 * not from the working directory. Fails when the compiler is missing or fails;
 * other platforms only print that environment and file references remain.
 */
import { existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const output = fileURLToPath(new URL("../dist/native/", import.meta.url));
const source = (name) => fileURLToPath(new URL(`./${name}`, import.meta.url));

if (process.platform === "darwin") {
  mkdirSync(output, { recursive: true });
  const result = spawnSync(
    "/usr/bin/swiftc",
    [source("keychain.swift"), "-o", path.join(output, "harnesshub-keychain")],
    { stdio: "inherit" },
  );
  if (result.error || result.status !== 0) process.exit(1);
} else if (process.platform === "win32") {
  mkdirSync(output, { recursive: true });
  const compiler = path.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "Microsoft.NET",
    "Framework64",
    "v4.0.30319",
    "csc.exe",
  );
  if (!existsSync(compiler))
    throw new Error(
      "Windows .NET Framework C# compiler is required to build the DPAPI helper.",
    );
  const result = spawnSync(
    compiler,
    [
      "/nologo",
      "/target:exe",
      "/reference:System.Web.Extensions.dll",
      "/reference:System.Security.dll",
      `/out:${path.join(output, "harnesshub-secrets.exe")}`,
      source("windows-secrets.cs"),
    ],
    { stdio: "inherit", windowsHide: true },
  );
  if (result.error || result.status !== 0) process.exit(1);
} else {
  console.log(
    "System secret storage unavailable on this platform; environment/file references remain supported.",
  );
}
