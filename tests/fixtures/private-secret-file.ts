import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

/** Creates a synthetic credential exclusively with a private, current-user ACL. */
export async function writePrivateSecretFile(
  file: string,
  value: string,
): Promise<void> {
  if (process.platform !== "win32") {
    await writeFile(file, value, { flag: "wx", mode: 0o600 });
    return;
  }
  // A runner's elevated token can default newly created files to Administrators.
  // Specify the fixture owner and DACL atomically, without changing production checks.
  const script = `$ErrorActionPreference = 'Stop';
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false);
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json;
$user = [Security.Principal.WindowsIdentity]::GetCurrent().User;
$security = [Security.AccessControl.FileSecurity]::new();
$security.SetOwner($user);
$security.SetAccessRuleProtection($true, $false);
$security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($user, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow));
$stream = [IO.FileStream]::new($request.file, [IO.FileMode]::CreateNew, [Security.AccessControl.FileSystemRights]::Write, [IO.FileShare]::None, 4096, [IO.FileOptions]::None, $security);
try {
  $bytes = [Text.Encoding]::UTF8.GetBytes($request.value);
  $stream.Write($bytes, 0, $bytes.Length);
  $stream.Flush($true);
} finally { $stream.Dispose(); }
[Console]::Write('created');`;
  const operation = execute(
    path.join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32/WindowsPowerShell/v1.0/powershell.exe",
    ),
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { windowsHide: true, timeout: 10000, maxBuffer: 16 * 1024 },
  );
  operation.child.stdin?.on("error", () => operation.child.kill());
  operation.child.stdin?.end(JSON.stringify({ file, value }));
  if ((await operation).stdout !== "created")
    throw new Error("Private credential fixture creation was not confirmed");
}
