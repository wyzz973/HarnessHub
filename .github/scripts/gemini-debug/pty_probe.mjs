// Debug-only: run a shell command the ways Gemini CLI 0.58.0 does on Windows and time each case.
//   pty-*      @lydell/node-pty ConPTY, as ShellExecutionService.executeWithPty (ACP default)
//   cp-*       child_process fallback with stdio ["ignore","pipe","pipe"]
//   parse-*    spawnSync of the PowerShell AST parser (-EncodedCommand), default stdio
// Usage: node pty_probe.mjs BUNDLE OUT LABEL [inner]
//   Without "inner" the cases run in this process. With a LABEL ending in "-pending" the outer
//   process re-runs itself as "inner" with stdin/stdout/stderr pipes and never writes stdin,
//   while the inner starts reading stdin first, like an ACP engine.
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [bundle, out, label, role] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const logFile = path.join(out, `pty-probe-${label}.jsonl`);
const started = Date.now();
const log = (record) => {
  const line = JSON.stringify({ ms: Date.now() - started, label, role: role ?? "outer", ...record });
  console.log(line);
  appendFileSync(logFile, `${line}\n`);
};

if (label.endsWith("-pending") && role !== "inner") {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), bundle, out, label, "inner"], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  const timer = setTimeout(() => {
    log({ outer: "inner still running after 240 s; killing tree" });
    try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"]); } catch {}
  }, 240_000);
  child.on("exit", (code) => {
    clearTimeout(timer);
    log({ outer: `inner exited ${code}` });
    child.stdin.end();
  });
} else {
  await runCases();
  process.exit(0);
}

function descendants(pid) {
  try {
    const text = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 60_000 });
    const rows = JSON.parse(text);
    const found = [];
    let frontier = new Set([pid]);
    while (frontier.size) {
      const next = new Set();
      for (const row of rows)
        if (frontier.has(row.ParentProcessId) && !found.some((item) => item.ProcessId === row.ProcessId)) {
          found.push(row);
          next.add(row.ProcessId);
        }
      frontier = next;
    }
    return found.map((row) => `${row.ProcessId}<-${row.ParentProcessId} ${row.Name} ${String(row.CommandLine ?? "").slice(0, 160)}`);
  } catch (error) {
    return [`process table unavailable: ${error.message}`];
  }
}

async function runCases() {
  if (role === "inner") {
    // Start a pending read on the stdin pipe first, exactly like an ACP transport.
    process.stdin.on("data", () => {});
    await new Promise((resolve) => setTimeout(resolve, 500));
    log({ stdinPendingRead: true });
  }
  const require = createRequire(path.join(bundle, "engines/npm/node_modules/@google/gemini-cli/bundle/gemini.js"));
  let pty;
  try {
    pty = require("@lydell/node-pty");
    log({ ptyLoaded: require.resolve("@lydell/node-pty") });
  } catch (error) {
    log({ ptyLoaded: false, error: String(error).slice(0, 300) });
  }
  const pwsh = (process.env.PATH ?? "").split(path.delimiter).map((dir) => path.join(dir, "pwsh.exe")).find((file) => existsSync(file));
  const shells = [
    ...(pwsh ? [{ name: "pwsh", exe: pwsh, prefix: ["-NoProfile", "-Command"] }] : []),
    { name: "powershell", exe: "powershell.exe", prefix: ["-NoProfile", "-NonInteractive", "-Command"] },
  ];
  log({ comSpec: process.env.ComSpec, pwsh: pwsh ?? null });
  const work = path.join(out, `work-${label}${role === "inner" ? "-inner" : ""}`);
  mkdirSync(work, { recursive: true });
  const env = { ...process.env, TERM: "xterm-256color", PAGER: "cat", GEMINI_CLI: "1" };
  for (const shell of shells) {
    const marker = path.join(work, `mock-ok-${shell.name}.txt`);
    // 1. ConPTY exactly as executeWithPty: chcp prefix, useConpty, no flow control.
    if (pty) {
      rmSync(marker, { force: true });
      const begin = Date.now();
      const command = `chcp 65001 >$null;echo mock-ok > ${path.basename(marker)}`;
      let data = "";
      let term;
      try {
        term = pty.spawn(shell.exe, [...shell.prefix, command], {
          cwd: work, name: "xterm-256color", cols: 80, rows: 30, env, handleFlowControl: false, useConpty: true,
        });
      } catch (error) {
        log({ case: `pty-${shell.name}`, spawnError: String(error).slice(0, 300) });
      }
      if (term) {
        term.onData((chunk) => { data += chunk; });
        const exit = await new Promise((resolve) => {
          const timer = setTimeout(() => resolve({ timedOut: true }), 45_000);
          term.onExit((event) => { clearTimeout(timer); resolve(event); });
        });
        log({
          case: `pty-${shell.name}`, pid: term.pid, exit, ms: Date.now() - begin, marker: existsSync(marker),
          data: data.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").slice(-300),
          tree: exit.timedOut ? descendants(process.pid) : undefined,
        });
        if (exit.timedOut) try { term.kill(); } catch {}
      }
    }
    // 2. child_process fallback: stdin ignored.
    {
      rmSync(marker, { force: true });
      const begin = Date.now();
      const child = spawn(shell.exe, [...shell.prefix, `echo mock-ok > ${path.basename(marker)}`], {
        cwd: work, stdio: ["ignore", "pipe", "pipe"], windowsVerbatimArguments: false, shell: false, env,
      });
      let data = "";
      child.stdout.on("data", (chunk) => { data += chunk; });
      child.stderr.on("data", (chunk) => { data += chunk; });
      const exit = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ timedOut: true }), 45_000);
        child.on("close", (code) => { clearTimeout(timer); resolve({ code }); });
      });
      log({ case: `cp-${shell.name}`, exit, ms: Date.now() - begin, marker: existsSync(marker), data: data.slice(-300) });
      if (exit.timedOut) try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"]); } catch {}
    }
    // 3. PowerShell AST parser as parsePowerShellCommandDetails (spawnSync, default stdio).
    {
      const begin = Date.now();
      const script = Buffer.from("Write-Output '{\"success\":true}'", "utf16le").toString("base64");
      const result = spawnSync(shell.exe, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", script], {
        env: { ...process.env, GEMINI_PROBE_COMMAND: "echo mock-ok > mock-ok.txt" }, encoding: "utf-8", timeout: 45_000,
      });
      log({ case: `parse-${shell.name}`, status: result.status, signal: result.signal, error: result.error ? String(result.error) : undefined, ms: Date.now() - begin, stdout: String(result.stdout ?? "").trim().slice(0, 100) });
    }
  }
}
