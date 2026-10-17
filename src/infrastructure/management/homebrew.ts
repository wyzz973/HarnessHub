import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { ManagementError, type ManagementInstallContext } from "../../contracts/management.js";
import { nativeBaseValues, type NativeEnvironment } from "../session/native-environment.js";
import { runManagementProcess } from "./process.js";

const runner = String.raw`require 'sandbox'
require 'json'
cfg = JSON.parse(File.read(File.join(__dir__, 'homebrew-command.json')))
raise 'Homebrew inherited sandbox API unavailable' unless Sandbox.respond_to?(:inherited_sandbox?) && Sandbox.instance_methods.include?(:capture)
sandbox = Sandbox.new
sandbox.allow_write_path(HOMEBREW_PREFIX)
sandbox.allow_write_path(__dir__)
sandbox.allow_write_temp_and_cache
sandbox.deny_write_homebrew_repository
cfg.fetch('directories').each { |path| sandbox.deny_write_path(path) }
cfg.fetch('files').each { |path| sandbox.deny_write(path: path) }
result = sandbox.capture(HOMEBREW_BREW_FILE, args: cfg.fetch('args'), print_stdout: true, print_stderr: true, temporary_directory: Pathname(__dir__))
exit(result.status.exitstatus || 1)
`;
/** Recognizes the installed SDK contract. Its fingerprint makes an SDK change invalidate a frozen plan. */
export async function homebrewSandboxIdentity(manager: string): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  const root = join(dirname(dirname(await realpath(manager))), "Library", "Homebrew"), files = [join(root, "sandbox.rb"), join(root, "system_command.rb"), join(root, "extend", "os", "mac", "sandbox.rb")];
  const chunks: Buffer[] = [];
  try {
    for (const file of files) { const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) return null; const bytes = await readFile(file); if (bytes.length > 1024 * 1024) return null; chunks.push(bytes); }
  } catch (error) { if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return null; throw error; }
  if (!chunks[0]!.includes("def inherited_sandbox?") && !chunks[0]!.includes("def self.inherited_sandbox?")) return null;
  if (!chunks[0]!.includes("command.sandbox_inheritance = inheritance") || !chunks[1]!.includes("Sandbox::INHERITANCE_FD")) return null;
  return createHash("sha256").update(Buffer.concat(chunks)).digest("hex");
}
/** The user's Homebrew cache: where Homebrew keeps its local records (the API data) and downloads. */
export function homebrewCache(source: NativeEnvironment): string { return source.values.HOMEBREW_CACHE ?? join(source.home, "Library", "Caches", "Homebrew"); }
/**
 * The environment Homebrew runs with for maintenance (ADR-043, ADR-044): the user's real home, Homebrew settings and cache,
 * so a check, a dry run and an upgrade read the same local records; never an automatic `brew update`, cleanup or autoremove.
 */
export function homebrewEnvironment(source: NativeEnvironment, stage: string): Record<string, string> {
  const settings = Object.fromEntries(Object.entries(source.values).filter(([name]) => name.startsWith("HOMEBREW_")));
  return { ...nativeBaseValues(source, null), ...settings, HOME: source.home, PATH: source.values.PATH ?? "/usr/bin:/bin:/opt/homebrew/bin", LANG: "C.UTF-8", TMPDIR: stage, NO_COLOR: "1",
    HOMEBREW_CACHE: homebrewCache(source), HOMEBREW_NO_AUTO_UPDATE: "1", HOMEBREW_NO_INSTALL_CLEANUP: "1", HOMEBREW_NO_AUTOREMOVE: "1", HOMEBREW_NO_ANALYTICS: "1", HOMEBREW_NO_ENV_HINTS: "1" };
}
/**
 * Homebrew creates and authenticates its own single sandbox; original CLI/native process group cleanup remains awaited.
 * It may write the Homebrew prefix, its temporary directory and cache; `directories` and `files` stay unwritable. With
 * `cache: "user"` it keeps the cache `env` names (the user's, with its local records); otherwise the stage holds one.
 * Resolves with the command's standard output; a non-zero exit rejects with PROCESS_FAILED.
 */
export async function runHomebrewProtected(manager: string, args: readonly string[], directories: readonly string[], files: readonly string[], env: Readonly<Record<string, string>>, context: ManagementInstallContext,
  options: { readonly cache?: "stage" | "user" } = {}): Promise<string> {
  context.assertOwned(); if (!(await homebrewSandboxIdentity(manager))) throw new ManagementError("CONFIGURATION_PROTECTION_UNAVAILABLE", "本机 Homebrew 没有受支持的沙箱继承接口。");
  const root = join(context.stage, "homebrew-protected"); await mkdir(root, { mode: 0o700 });
  const script = join(root, "run.rb"); await writeFile(script, runner, { flag: "wx", mode: 0o600 });
  await writeFile(join(root, "homebrew-command.json"), JSON.stringify({ args, directories, files }), { flag: "wx", mode: 0o600 });
  for (const path of ["cache", "logs"]) await mkdir(join(root, path), { mode: 0o700 });
  context.assertOwned();
  if ("beginMutation" in context && typeof context.beginMutation === "function") context.beginMutation();
  return runManagementProcess(manager, ["ruby", script], context.stage, { ...env, HOMEBREW_DEVELOPER: "1", ...(options.cache === "user" ? {} : { HOMEBREW_CACHE: join(root, "cache") }), HOMEBREW_LOGS: join(root, "logs"), HOMEBREW_TEMP: root,
    HOMEBREW_NO_AUTO_UPDATE: "1", HOMEBREW_NO_INSTALL_CLEANUP: "1", HOMEBREW_NO_AUTOREMOVE: "1", HOMEBREW_NO_ANALYTICS: "1", TERM: "dumb" }, context, 8 * 1024 * 1024);
}
