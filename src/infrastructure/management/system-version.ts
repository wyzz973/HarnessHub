import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { valid } from "semver";
import { ManagementError, type SystemInstallationObservation, type SystemVersionProbeOptions } from "../../contracts/management.js";
import { runManagementProcess } from "./process.js";

const TIMEOUT_MS = 5000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const runtimes = new Set(["node", "nodejs", "python", "python3", "bash", "sh", "zsh", "npm", "npx", "uv", "uvx", "bun", "deno", "java", "ruby"]);
export interface SystemVersionResult { readonly version: string | null; readonly reason: string | null }
function version(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 128 || !/^[vV]?[0-9]+(?:\.[0-9]+){1,3}(?:[-+][A-Za-z0-9.-]+)?$/u.test(value)) return null;
  return valid(value) ?? value.replace(/^[vV]/u, "");
}
/** The resolver's observed package identity is evidence; an installation directory name is only a hint. */
export function observedPackageVersion(diagnostics: readonly { readonly code: string; readonly detail?: string }[]): string | undefined {
  for (const diagnostic of diagnostics) {
    if (diagnostic.code !== "package_version_observed" || diagnostic.detail === undefined) continue;
    const match = /^installed=([^;]+); catalog-reference=/u.exec(diagnostic.detail);
    const observed = version(match?.[1]); if (observed !== null) return observed;
  }
  return undefined;
}
function fromOutput(output: string): string | null {
  const candidates = new Set<string>();
  for (const line of output.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/gu, "").split(/[\r\n]/u)) {
    const text = line.trim();
    if (!text || /^(?:npm\s+warn|warn(?:ing)?\b|node(?:\.js)?\s|python\s|runtime\s)/iu.test(text)) continue;
    const matches = text.matchAll(/(?:^|[^A-Za-z0-9.+-])([vV]?[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?)(?=$|[^A-Za-z0-9.+-])/gu);
    for (const match of matches) { const parsed = version(match[1]); if (parsed !== null) candidates.add(parsed); }
  }
  return candidates.size === 1 ? [...candidates][0]! : null;
}
function code(error: unknown): string | null {
  return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : null;
}

/** Explicitly invoked only by a user version/update check. Owns and closes the temporary process group. */
export async function probeSystemVersion(entry: SystemInstallationObservation, options: SystemVersionProbeOptions): Promise<SystemVersionResult> {
  options.assertOwned();
  if (options.signal.aborted) return { version: null, reason: "Version check was cancelled" };
  const hinted = version(entry.packageVersion);
  if (hinted !== null) return { version: hinted, reason: null };
  const command = entry.command;
  if (!isAbsolute(command.executable) || command.executable.length > 4096 || /[\0\r\n]/u.test(command.executable)) return { version: null, reason: "Version command has no valid observed executable" };
  let executable: string, knownNode: string;
  try { executable = await realpath(command.executable); knownNode = await realpath(process.execPath); options.assertOwned(); }
  catch (error) { if (["OWNER_LOST", "OWNERSHIP_LOST", "STORE_CLOSED"].includes(code(error) ?? "")) throw error; return { version: null, reason: "Observed executable is no longer available" }; }
  const node = executable === knownNode;
  let args: readonly string[] = ["--version"];
  if (node) {
    const script = command.args[0];
    if (script === undefined || !isAbsolute(script) || script.length > 4096 || /[\0\r\n]/u.test(script)) return { version: null, reason: "Node runtime has no observed Harness entry; its own version is not a Harness version" };
    args = [script, "--version"];
  } else if (runtimes.has(basename(executable).toLowerCase())) return { version: null, reason: "Unapproved runtime entry cannot establish a Harness version" };
  const root = await realpath(await mkdtemp(join(tmpdir(), "harness-version-probe-"))), identity = await lstat(root);
  const timeout = new AbortController(), timer = setTimeout(() => timeout.abort(), TIMEOUT_MS);
  const signal = AbortSignal.any([options.signal, timeout.signal]);
  let diagnostics = "";
  let cleanupConfirmed = true;
  try {
    options.assertOwned();
    const home = join(root, "home"); await mkdir(home, { mode: 0o700 });
    for (const child of ["config", "data", "state", "cache", "codex", "claude", "opencode", "gemini"]) await mkdir(join(home, child), { mode: 0o700 });
    const settings = join(home, "gemini", "settings.json"), defaults = join(home, "gemini", "defaults.json");
    await writeFile(settings, "{}\n", { mode: 0o600, flag: "wx" }); await writeFile(defaults, "{}\n", { mode: 0o600, flag: "wx" });
    options.assertOwned();
    const path = command.env.PATH ?? process.env.PATH ?? "/usr/bin:/bin";
    if (Buffer.byteLength(path, "utf8") > 32768 || /[\0\r\n]/u.test(path)) throw new ManagementError("INVALID_INPUT", "observed executable search path is invalid");
    const env: Record<string, string> = { PATH: path, LANG: "C.UTF-8", HOME: home, TMPDIR: root,
      XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_STATE_HOME: join(home, "state"), XDG_CACHE_HOME: join(home, "cache"),
      CODEX_HOME: join(home, "codex"), CLAUDE_CONFIG_DIR: join(home, "claude"), OPENCODE_CONFIG_DIR: join(home, "opencode"), OPENCODE_DISABLE_AUTOUPDATE: "true",
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: settings, GEMINI_CLI_SYSTEM_DEFAULTS_PATH: defaults };
    cleanupConfirmed = false;
    const output = await runManagementProcess(executable, args, root, env, { stage: root, signal, assertOwned: options.assertOwned,
      log: (_stream, text) => { diagnostics += text + "\n"; if (Buffer.byteLength(diagnostics, "utf8") > MAX_OUTPUT_BYTES) throw new ManagementError("OUTPUT_LIMIT", "version diagnostics exceeded their byte budget"); } }, MAX_OUTPUT_BYTES).then(value => { cleanupConfirmed = true; return value; }, (error: unknown) => { cleanupConfirmed = code(error) !== "CLEANUP_FAILED"; throw error; });
    options.assertOwned();
    const combined = output + "\n" + diagnostics;
    if (combined.includes("\uFFFD")) return { version: null, reason: "Version output could not be decoded reliably" };
    const detected = fromOutput(combined);
    return detected === null ? { version: null, reason: "Version output did not identify one unambiguous Harness version" } : { version: detected, reason: null };
  } catch (error) {
    const failure = code(error);
    if (["OWNER_LOST", "OWNERSHIP_LOST", "STORE_CLOSED", "CLEANUP_FAILED"].includes(failure ?? "")) throw error;
    const reason = options.signal.aborted ? "Version check was cancelled" : timeout.signal.aborted ? "Version command exceeded its five-second deadline"
      : failure === "OUTPUT_LIMIT" ? "Version output exceeded 64 KiB" : failure === "PROCESS_FAILED" ? "Executable does not support a successful --version check" : "Version command could not be inspected";
    return { version: null, reason: options.redact?.(reason) ?? reason };
  } finally {
    clearTimeout(timer);
    const current = await lstat(root);
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino) throw new ManagementError("CLEANUP_FAILED", "version probe directory ownership changed");
    if (cleanupConfirmed) await rm(root, { recursive: true, force: true });
  }
}
