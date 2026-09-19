// Debug-only: time Windows PowerShell 5.1 the way Gemini CLI 0.58.0 starts it (AST parser via
// -EncodedCommand, then the command itself) under environment variants that differ from the
// runner's own environment the way a HarnessHub engine environment does.
// Usage: node env_probe.mjs BUNDLE OUT
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import path from "node:path";

const [bundle, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const logFile = path.join(out, "env-probe.jsonl");
const log = (record) => {
  const line = JSON.stringify(record);
  console.log(line);
  appendFileSync(logFile, `${line}\n`);
};

// Gemini 0.58.0 POWERSHELL_PARSER_SCRIPT (chunk-MFLFXOVQ.js), verbatim.
const parser = `
$ErrorActionPreference = 'Stop'
$commandText = $env:__GCLI_POWERSHELL_COMMAND__
if ([string]::IsNullOrEmpty($commandText)) {
  Write-Output '{"success":false}'
  exit 0
}
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($commandText, [ref]$tokens, [ref]$errors)
if ($errors -and $errors.Count -gt 0) {
  Write-Output '{"success":false}'
  exit 0
}
$commandAsts = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.CommandAst] }, $true)
$commandObjects = @()
$hasRedirection = $false
foreach ($commandAst in $commandAsts) {
  if ($commandAst.Redirections.Count -gt 0) {
    $hasRedirection = $true
  }
  $name = $commandAst.GetCommandName()
  if ([string]::IsNullOrWhiteSpace($name)) {
    continue
  }
  $args = @()
  if ($commandAst.CommandElements.Count -gt 1) {
    for ($i = 1; $i -lt $commandAst.CommandElements.Count; $i++) {
      $args += $commandAst.CommandElements[$i].Extent.Text.Trim()
    }
  }
  $commandObjects += [PSCustomObject]@{
    name = $name
    text = $commandAst.Extent.Text.Trim()
    args = $args
  }
}
[PSCustomObject]@{
  success = $true
  commands = $commandObjects
  hasRedirection = $hasRedirection
} | ConvertTo-Json -Compress
`;
const encoded = Buffer.from(parser, "utf16le").toString("base64");
const windows = process.env.SystemRoot ?? "C:\\Windows";
const pick = (names) =>
  Object.fromEntries(
    Object.entries(process.env).filter(([name]) => names.includes(name.toUpperCase())),
  );
// HarnessHub Worker allowlist (src/process/worker-host.ts) plus the bundle PATH.
const workerNames = ["PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "SYSTEMDRIVE", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS", "OS", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TERM", "USERNAME"];
const systemNames = ["PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432", "COMMONPROGRAMFILES", "COMMONPROGRAMFILES(X86)", "COMMONPROGRAMW6432", "PROGRAMDATA", "ALLUSERSPROFILE", "PUBLIC", "COMPUTERNAME", "USERDOMAIN", "HOMEDRIVE", "HOMEPATH", "PROCESSOR_IDENTIFIER", "PROCESSOR_LEVEL", "PROCESSOR_REVISION"];
const bundlePath = [path.join(bundle, "runtime"), path.join(windows, "System32"), windows, path.join(windows, "System32", "WindowsPowerShell", "v1.0")].join(";");
const privateHome = (name) => {
  const home = mkdtempSync(path.join(out, `${name}-`));
  const dirs = { HOME: home, USERPROFILE: home, APPDATA: path.join(home, "AppData", "Roaming"), LOCALAPPDATA: path.join(home, "AppData", "Local"), TEMP: path.join(home, "tmp"), TMP: path.join(home, "tmp") };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
  return dirs;
};
const shared = path.join(out, "shared-analysis-cache");
mkdirSync(shared, { recursive: true });
const variants = [
  ["runner", () => ({ ...process.env })],
  ["worker-minimal", () => ({ ...pick(workerNames), PATH: bundlePath, ...privateHome("minimal") })],
  ["worker+system", () => ({ ...pick([...workerNames, ...systemNames]), PATH: bundlePath, ...privateHome("system") })],
  ["worker+PSModulePath", () => ({ ...pick([...workerNames, "PSMODULEPATH"]), PATH: bundlePath, ...privateHome("psmodulepath") })],
  ["worker+system+PSModulePath", () => ({ ...pick([...workerNames, ...systemNames, "PSMODULEPATH"]), PATH: bundlePath, ...privateHome("systempsm") })],
  ["worker+realLocalAppData", () => ({ ...pick(workerNames), PATH: bundlePath, ...privateHome("reallocal"), LOCALAPPDATA: process.env.LOCALAPPDATA })],
  ["worker+sharedCache-1", () => ({ ...pick(workerNames), PATH: bundlePath, ...privateHome("shared1"), PSModuleAnalysisCachePath: path.join(shared, "ModuleAnalysisCache") })],
  ["worker+sharedCache-2", () => ({ ...pick(workerNames), PATH: bundlePath, ...privateHome("shared2"), PSModuleAnalysisCachePath: path.join(shared, "ModuleAnalysisCache") })],
];
const powershell = path.join(windows, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
for (const [name, make] of variants) {
  const env = make();
  const work = mkdtempSync(path.join(out, `work-${name}-`));
  const calls = [
    ["parse-1", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { ...env, __GCLI_POWERSHELL_COMMAND__: "echo mock-ok > mock-ok.txt" }],
    ["run", ["-NoProfile", "-NonInteractive", "-Command", "echo mock-ok > mock-ok.txt"], env],
    ["parse-2", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { ...env, __GCLI_POWERSHELL_COMMAND__: "echo mock-ok > mock-ok.txt" }],
    ["bare", ["-NoProfile", "-NonInteractive", "-Command", "[Environment]::Exit(0)"], env],
  ];
  for (const [label, args, callEnv] of calls) {
    const begin = Date.now();
    const result = spawnSync(powershell, args, { env: callEnv, cwd: work, encoding: "utf-8", timeout: 120_000 });
    log({ variant: name, call: label, ms: Date.now() - begin, status: result.status, timedOut: result.error?.code === "ETIMEDOUT", stdout: String(result.stdout ?? "").trim().slice(0, 120), stderr: String(result.stderr ?? "").trim().slice(0, 200) });
  }
  log({ variant: name, marker: existsSync(path.join(work, "mock-ok.txt")), keys: Object.keys(env).sort().join(",").slice(0, 600) });
}
const diag = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", "$env:PSModulePath; (Get-Module -ListAvailable).Count"], { encoding: "utf-8", timeout: 300_000 });
log({ diagnostic: String(diag.stdout).trim().slice(0, 1000) });
