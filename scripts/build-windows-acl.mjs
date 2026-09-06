import { mkdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

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
  mkdirSync("dist/native", { recursive: true });
  const result = spawnSync(
    compiler,
    [
      "/nologo",
      "/target:exe",
      "/platform:anycpu",
      "/optimize+",
      "/reference:System.Web.Extensions.dll",
      `/out:${resolve("dist/native/harnesshub-acl.exe")}`,
      resolve("scripts/native/windows-acl.cs"),
    ],
    { stdio: "inherit", windowsHide: true },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
