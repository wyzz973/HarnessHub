/**
 * Process, port and log helpers for driving a competition Gateway from test tooling
 * (competition-selftest.mjs, competition-matrix.mjs, competition-offline.mjs).
 * Every started process has one owner that must call `stop()`; stopping terminates the
 * whole tree (taskkill /T on Windows, the process group elsewhere) and waits for exit.
 */
import { execFile, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { once } from "node:events";
import { connect, createServer } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { raceTimeout } from "./competition-client.mjs";

/** Reserve and release a loopback port chosen by the OS. */
export async function freePort(host = "127.0.0.1") {
  const server = createServer();
  server.listen(0, host);
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

/** True when something accepts TCP connections on host:port. */
export function portOpen(port, host = "127.0.0.1", timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = connect({ port, host });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** Wait until nothing listens on the given ports; returns the ports still open at the deadline. */
export async function waitForPortsClosed(
  ports,
  { host = "127.0.0.1", timeoutMs = 20_000 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let open = [...ports];
  while (open.length && Date.now() < deadline) {
    const states = await Promise.all(open.map((port) => portOpen(port, host)));
    open = open.filter((_, index) => states[index]);
    if (open.length) await delay(250);
  }
  return open;
}

/**
 * Vendor credential and endpoint variables that must not reach engines: every engine
 * has to use the HarnessHub unified model gateway (ADR 0013), never its own account.
 */
const vendorVariable =
  /^(?!HARNESSHUB_)(?:[A-Z0-9_]*_API_KEY|[A-Z0-9_]*_AUTH_TOKEN|[A-Z0-9_]*_ACCESS_TOKEN|[A-Z0-9_]*_OAUTH_TOKEN|OPENAI_[A-Z0-9_]*|ANTHROPIC_[A-Z0-9_]*|CLAUDE_CODE_[A-Z0-9_]*TOKEN|GEMINI_[A-Z0-9_]*KEY|GOOGLE_API_KEY|GOOGLE_GENAI_[A-Z0-9_]*|GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_CLOUD_PROJECT|VERTEXAI_[A-Z0-9_]*|AZURE_OPENAI_[A-Z0-9_]*|DEEPSEEK_[A-Z0-9_]*|MOONSHOT_[A-Z0-9_]*|KIMI_[A-Z0-9_]*KEY|DASHSCOPE_[A-Z0-9_]*|QWEN_[A-Z0-9_]*KEY|OPENROUTER_[A-Z0-9_]*|MIMO_[A-Z0-9_]*KEY|XIAOMI_[A-Z0-9_]*KEY|ZHIPUAI_[A-Z0-9_]*|GLM_[A-Z0-9_]*KEY|GITHUB_TOKEN|GH_TOKEN|COPILOT_[A-Z0-9_]*TOKEN|HF_TOKEN)$/i;

/** Names in `env` that {@link withoutVendorCredentials} removes. */
export function vendorCredentialNames(env) {
  return Object.keys(env)
    .filter((name) => vendorVariable.test(name))
    .sort();
}

/** Copy of `env` without vendor credential/endpoint variables; HARNESSHUB_* is kept. */
export function withoutVendorCredentials(env) {
  const result = { ...env };
  for (const name of vendorCredentialNames(env)) delete result[name];
  return result;
}

/**
 * Build a redaction function. Known secret values are replaced first; bearer tokens and
 * common key shapes are masked as a second line of defence.
 */
export function redactor(secrets = []) {
  const values = [
    ...new Set(
      secrets.filter((value) => typeof value === "string" && value.length >= 6),
    ),
  ].sort((a, b) => b.length - a.length);
  return (text) => {
    let result = String(text);
    for (const value of values) result = result.split(value).join("[REDACTED]");
    return result
      .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[REDACTED]")
      .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, "sk-[REDACTED]");
  };
}

function quoteForCmd(value) {
  if (/["%^&|<>!\r\n]/.test(value))
    throw new Error(
      `Argument contains characters that cmd.exe cannot pass safely: ${value}`,
    );
  return value === "" || /[\s()]/.test(value) ? `"${value}"` : value;
}

/**
 * Command line for a launcher: `.cmd`/`.bat` via cmd.exe (Windows only), `.js`/`.mjs`
 * with the current Node, anything else as an executable.
 */
export function launcherCommand(entry, args, platform = process.platform) {
  if (/\.(cmd|bat)$/i.test(entry)) {
    if (platform !== "win32")
      throw new Error(`Batch launcher requires Windows: ${entry}`);
    const shell =
      process.env.ComSpec ??
      path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
    const line = [entry, ...args].map(quoteForCmd).join(" ");
    return {
      command: shell,
      args: ["/d", "/s", "/c", `"${line}"`],
      windowsVerbatimArguments: true,
    };
  }
  if (/\.(c|m)?js$/i.test(entry))
    return { command: process.execPath, args: [entry, ...args] };
  return { command: entry, args };
}

/**
 * Start a process whose stdout/stderr are redacted into `logFile` and a bounded tail.
 *
 * Stopping: on Windows `taskkill /T /F` ends the whole tree (the Gateway's Job helper then
 * empties its Job). Elsewhere the child gets SIGTERM, which lets a Gateway close its Workers
 * itself, then SIGKILL after the timeout. The child deliberately stays in the caller's
 * process group: a Gateway started as its own session leader (setsid) was observed to be
 * stopped mid-run on macOS, closing its listener after the first prompt.
 *
 * @param {{entry: string, args?: string[], cwd?: string, env?: NodeJS.ProcessEnv,
 *   logFile?: string, redact?: (text: string) => string, onLine?: (line: string) => void}} options
 * @returns {{child: import("node:child_process").ChildProcess, exited: Promise<{code: number|null, signal: string|null}>,
 *   tail: () => string, stop: (timeoutMs?: number) => Promise<void>}}
 */
export function startLoggedProcess(options) {
  const launch = launcherCommand(options.entry, options.args ?? []);
  const redact = options.redact ?? ((text) => text);
  const child = spawn(launch.command, launch.args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    windowsVerbatimArguments: launch.windowsVerbatimArguments === true,
  });
  const log = options.logFile
    ? createWriteStream(options.logFile, { flags: "a" })
    : undefined;
  let tail = "";
  let pending = "";
  const exited = new Promise((resolve) => {
    child.once("error", (error) => {
      tail += `\n[spawn error] ${error.message}`;
      resolve({ code: null, signal: null, error: error.message });
    });
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const consume = (stream, label) => {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      const text = redact(chunk);
      tail = (tail + text).slice(-64 * 1024);
      log?.write(
        label === "stderr" ? text.replace(/^(?=.)/gm, "[stderr] ") : text,
      );
      if (label === "stdout" && options.onLine) {
        pending += text;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? "";
        for (const line of lines) options.onLine(line);
      }
    });
  };
  consume(child.stdout, "stdout");
  consume(child.stderr, "stderr");
  let stopping;
  const stop = (timeoutMs = 20_000) =>
    (stopping ??= (async () => {
      const running = () =>
        child.exitCode === null &&
        child.signalCode === null &&
        child.pid !== undefined;
      if (running()) {
        if (process.platform === "win32") {
          const taskkill = path.join(
            process.env.SystemRoot ?? "C:\\Windows",
            "System32",
            "taskkill.exe",
          );
          await new Promise((resolve) =>
            execFile(
              taskkill,
              ["/PID", String(child.pid), "/T", "/F"],
              { windowsHide: true },
              () => resolve(),
            ),
          );
        } else child.kill("SIGTERM");
      }
      const outcome = await raceTimeout(exited, timeoutMs);
      if (outcome.timedOut && running()) {
        child.kill("SIGKILL");
        await raceTimeout(exited, 5000);
      }
      if (log) await new Promise((resolve) => log.end(resolve));
    })());
  return { child, exited, tail: () => tail, stop };
}

/**
 * Decode a small text file the way Windows tools write it: UTF-8 (optional BOM) or
 * UTF-16 with BOM (Windows PowerShell 5.1 redirection).
 */
export function decodeText(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe)
    return bytes.subarray(2).toString("utf16le");
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.from(
      bytes.subarray(2, 2 + ((bytes.length - 2) & ~1)),
    );
    swapped.swap16();
    return swapped.toString("utf16le");
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  )
    return bytes.subarray(3).toString("utf8");
  return bytes.toString("utf8");
}
