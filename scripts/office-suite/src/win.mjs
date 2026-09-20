// Windows PowerShell 5.1 runner used by the app and Outlook tools.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ToolError } from "./common.mjs";

export function requireWindows(tool) {
  if (process.platform !== "win32")
    throw new ToolError(
      "WINDOWS_ONLY",
      `${tool} controls Windows desktop applications and only works on Windows`,
    );
}

const PRELUDE = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$in = $env:HH_OFFICE_INPUT | ConvertFrom-Json
# The answer is pure ASCII JSON (\\uXXXX escapes), so no console code page can damage it.
function Write-Result($value) {
  $json = $value | ConvertTo-Json -Depth 6 -Compress
  $json = [regex]::Replace($json, '[^\\x00-\\x7F]', { param($m) '\\u{0:x4}' -f [int][char]$m.Value })
  [Console]::Out.WriteLine($json)
}
function Fail($code, $message, $hint) {
  Write-Result @{ ok = $false; error = @{ code = $code; message = $message; hint = $hint } }
  exit 3
}
`;

/**
 * Run a Windows PowerShell 5.1 script. `input` reaches the script as `$in` (JSON in an
 * environment variable, so no quoting rules apply); the script answers with one JSON line
 * through Write-Result. The script file is written with a UTF-8 BOM because PowerShell 5.1
 * reads BOM-less files as ANSI.
 */
export async function powershell(script, input, timeoutMs = 26000) {
  const file = path.join(os.tmpdir(), `hh-office-${randomBytes(8).toString("hex")}.ps1`);
  await writeFile(file, `\uFEFF${PRELUDE}${script}\n`, "utf8");
  const root = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
  const env = { ...process.env, HH_OFFICE_INPUT: JSON.stringify(input ?? {}) };
  // Without PSModulePath every cmdlet autoload costs PowerShell 5.1 about 20 seconds.
  if (!Object.keys(env).some((name) => name.toLowerCase() === "psmodulepath"))
    env.PSModulePath = [
      path.join(process.env.ProgramFiles ?? "C:\\Program Files", "WindowsPowerShell", "Modules"),
      path.join(root, "system32", "WindowsPowerShell", "v1.0", "Modules"),
    ].join(";");
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(
        path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file],
        { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
      const timer = setTimeout(() => {
        child.kill();
        reject(
          new ToolError(
            "TIMEOUT",
            `The Windows operation did not finish within ${Math.round(timeoutMs / 1000)} s`,
            "The application may be showing a dialog or starting for the first time; check it and retry.",
          ),
        );
      }, timeoutMs);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(new ToolError("POWERSHELL_UNAVAILABLE", error.message));
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
    const line = result.stdout
      .split(/\r?\n/)
      .reverse()
      .find((item) => item.trim().startsWith("{"));
    if (!line)
      throw new ToolError(
        "POWERSHELL_FAILED",
        (result.stderr || result.stdout || `exit code ${result.code}`).trim().slice(0, 1500),
      );
    const parsed = JSON.parse(line);
    if (parsed.ok === false)
      throw new ToolError(parsed.error?.code ?? "FAILED", parsed.error?.message ?? "failed", parsed.error?.hint ?? undefined);
    return parsed;
  } finally {
    await rm(file, { force: true });
  }
}
