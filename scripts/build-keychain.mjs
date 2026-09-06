import { mkdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
if (process.platform === "darwin") {
  mkdirSync("dist/native", { recursive: true });
  const result = spawnSync(
    "/usr/bin/swiftc",
    ["scripts/native/keychain.swift", "-o", "dist/native/harnesshub-keychain"],
    { stdio: "inherit" },
  );
  if (result.error || result.status !== 0) process.exit(1);
} else if (process.platform === "win32") {
  mkdirSync("dist/native", { recursive: true });
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
      `/out:${path.resolve("dist/native/harnesshub-secrets.exe")}`,
      path.resolve("scripts/native/windows-secrets.cs"),
    ],
    { stdio: "inherit", windowsHide: true },
  );
  if (result.error || result.status !== 0) process.exit(1);
} else {
  console.log(
    "System secret storage unavailable on this platform; environment/file references remain supported.",
  );
}
