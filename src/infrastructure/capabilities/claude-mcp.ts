import { accessSync, constants, existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import type { ReadEnvironment } from "../../adapters/capability-reads.js";
import { CapabilityError } from "../../contracts/capabilities.js";
import { ManagementError } from "../../contracts/management.js";
import { runManagementProcess } from "../management/process.js";

/**
 * Claude Code's own MCP commands (ADR-045 §5, approval of step 3b): `claude mcp add-json <name> <json> -s user` and
 * `claude mcp remove <name> -s user`, run under macOS's sandbox with the network denied. Claude writes `.claude.json`
 * through a file beside it and keeps its own backups and telemetry records, so a run may write: the directories in
 * `writable`, and the files whose path starts with one of `files` (the configuration and its siblings).
 */
export type ClaudeRunner = (args: readonly string[], options: { readonly env: Readonly<Record<string, string>>; readonly writable: readonly string[]; readonly files: readonly string[] }, signal: AbortSignal) => Promise<void>;

/** A sandbox profile that may write these directories and the files starting with these paths, and use no network. */
export function claudeSandboxProfile(writable: readonly string[], files: readonly string[]): string {
  for (const path of [...writable, ...files]) if (!isAbsolute(path) || /["\n\r\\]/u.test(path)) throw new CapabilityError("CAPABILITY_PROTECTION_UNAVAILABLE", "沙箱里不能使用这个路径");
  const pattern = (path: string) => "(regex #\"^" + path.replace(/[.*+?^${}()|[\]]/gu, "\\$&") + "\")";
  return "(version 1)(allow default)(deny file-write*)(allow file-write* " + writable.map(path => "(subpath " + JSON.stringify(path) + ")").join(" ") + " " + files.map(pattern).join(" ")
    + " (literal \"/dev/null\") (literal \"/dev/tty\"))(deny network*)";
}
function onPath(command: string, path: string | undefined): string | null {
  for (const directory of (path ?? "").split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    const candidate = join(directory, command);
    try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* not here */ }
  }
  return null;
}
/**
 * The user's own `claude` (the first on their PATH, the one HarnessHub runs), under macOS's sandbox, from a private
 * working folder (Claude reads the folder it starts in). Its output is never kept: it may echo a server's definition.
 */
export function systemClaude(environment: ReadEnvironment): ClaudeRunner {
  return async (args, options, signal) => {
    const executable = onPath("claude", environment.values.PATH);
    if (executable === null) throw new CapabilityError("CAPABILITY_COMMAND_FAILED", "找不到 claude 命令");
    if (process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec")) throw new CapabilityError("CAPABILITY_PROTECTION_UNAVAILABLE", "运行 claude 需要 macOS 的沙箱保护，这里不可用");
    // The sandbox matches real paths: the temporary directory (under /var or /tmp, both links) and the allowed paths are resolved first.
    const stage = await realpath(await mkdtemp(join(tmpdir(), "harnesshub-claude-")));
    try {
      const writable = [...await Promise.all(options.writable.map(path => realpath(path).catch(() => path))), stage];
      const files = await Promise.all(options.files.map(async path => { const directory = path.slice(0, path.lastIndexOf("/")); return (await realpath(directory).catch(() => directory)) + path.slice(path.lastIndexOf("/")); }));
      const env = { ...Object.fromEntries(Object.entries(environment.values).filter((entry): entry is [string, string] => typeof entry[1] === "string")), HOME: environment.home, TMPDIR: stage, NO_COLOR: "1",
        DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", ...options.env };
      await runManagementProcess("/usr/bin/sandbox-exec", ["-p", claudeSandboxProfile(writable, files), executable, ...args], stage, env, { stage, signal, assertOwned: () => {}, log: () => {} }, 1024 * 1024);
    } catch (error) {
      if (error instanceof ManagementError) throw new CapabilityError("CAPABILITY_COMMAND_FAILED", "claude " + args.slice(0, 2).join(" ") + " 没有成功（" + (error.code === "CANCELLED" ? "超过 60 秒" : error.code === "PROCESS_FAILED" ? "命令报告失败" : error.code) + "）");
      throw error;
    } finally { await rm(stage, { recursive: true, force: true }); }
  };
}
/** Prediction and run directories a stopped Gateway left behind: older than ten minutes and this user's own. */
export function sweepClaudeCopies(): void {
  let names: string[] = [];
  try { names = readdirSync(tmpdir()); } catch { return; }
  for (const name of names) {
    if (!/^harnesshub-claude-(?:copy-)?[A-Za-z0-9]{6}$/u.test(name)) continue;
    const path = join(tmpdir(), name);
    try { const info = lstatSync(path); if (info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid?.() && Date.now() - info.mtimeMs > 10 * 60_000) rmSync(path, { recursive: true, force: true }); } catch { /* gone or not ours */ }
  }
}
