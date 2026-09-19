// Debug-only: time the real-model shell-task command the way Gemini CLI 0.58.0 executes it
// (powershell.exe -NoProfile -NonInteractive -Command "<command>") in an engine-like
// environment without and with PSModulePath.
// Usage: node nested_probe.mjs BUNDLE OUT
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";

const [bundle, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const windows = process.env.SystemRoot ?? "C:\\Windows";
const workerNames = ["PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "SYSTEMDRIVE", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS", "OS", "LANG", "TZ", "TERM", "USERNAME"];
const pick = (names) =>
  Object.fromEntries(Object.entries(process.env).filter(([name]) => names.includes(name.toUpperCase())));
const bundlePath = [path.join(bundle, "runtime"), path.join(windows, "System32"), windows, path.join(windows, "System32", "WindowsPowerShell", "v1.0")].join(";");
const powershell = path.join(windows, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const command = "powershell -NoProfile -Command \"Set-Content -Path shell.txt -Value ('HH-' + (6*7) + '-nested'); Get-Content shell.txt\"";
for (const [variant, extra] of [["worker-minimal", []], ["worker+PSModulePath", ["PSMODULEPATH"]]]) {
  for (const attempt of [1, 2]) {
    const home = mkdtempSync(path.join(out, `${variant}-`));
    const dirs = { HOME: home, USERPROFILE: home, APPDATA: path.join(home, "AppData", "Roaming"), LOCALAPPDATA: path.join(home, "AppData", "Local"), TEMP: path.join(home, "tmp"), TMP: path.join(home, "tmp") };
    for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
    const env = { ...pick([...workerNames, ...extra]), PATH: bundlePath, ...dirs, TERM: "xterm-256color", PAGER: "cat", GEMINI_CLI: "1" };
    const begin = Date.now();
    const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", command], { env, cwd: home, encoding: "utf-8", timeout: 180_000 });
    let file = null;
    try {
      file = readFileSync(path.join(home, "shell.txt"), "utf8").trim();
    } catch {}
    const record = { variant, attempt, ms: Date.now() - begin, status: result.status, stdout: String(result.stdout ?? "").trim().slice(0, 80), stderr: String(result.stderr ?? "").trim().slice(0, 160), file };
    console.log(JSON.stringify(record));
    appendFileSync(path.join(out, "nested-probe.jsonl"), `${JSON.stringify(record)}\n`);
  }
}
