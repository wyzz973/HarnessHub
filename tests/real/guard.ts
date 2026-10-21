import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { lstat, open, readdir, readlink, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, normalize, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { harnessDirectories } from "../../src/adapters/capability-reads.js";
import { application } from "../../src/cli/session-application.js";
import type { InstallationPolicy } from "../../src/contexts/catalog/domain/catalog.js";
import type { HarnessManagementView, HarnessVersionVerification, ResolvedManagedControl, SystemInstallationObservation } from "../../src/contracts/management.js";
import type { SessionConfiguration } from "../../src/contracts/session.js";
import type { HarnessEntrySource, InstallationView } from "../../src/contracts/web.js";
import { resolveHermesHome, resolveOpenClawWorkspace } from "../../src/infrastructure/capabilities/service.js";
import { inventory } from "../../src/infrastructure/catalog/inventory-composition.js";
import { observedPackageVersion } from "../../src/infrastructure/management/system-version.js";
import { versionVerification } from "../../src/infrastructure/management/verified-versions.js";
import { captureNativeEnvironment, type NativeEnvironment } from "../../src/infrastructure/session/native-environment.js";
import { harnessEntry, productCommand } from "../../src/web/harness-entry.js";
import { installationViews } from "../../src/web/harness-installations.js";
import { homePathsIn } from "../../src/web/shown-paths.js";

/*
 * The shared guard of the real acceptance suites (docs/engineering/real-acceptance.md): before a suite runs a Harness it
 * takes a snapshot of the user's configuration files, afterwards it compares a second one, and its evidence starts with
 * a header saying which commit, policy and installations ran. A snapshot holds digests, directory entry names and link
 * targets, written with ~; never a file's content. Credential files are refused by name and by location, so no list
 * can come to read one.
 */

/** The Harnesses that have a guard list; a suite run on any other fails at its first snapshot. */
export const GUARD_TARGETS = ["claude", "codex", "opencode", "openclaw", "hermes", "dsh", "cursor", "gemini", "pi"] as const;
export type GuardTarget = typeof GUARD_TARGETS[number];
/** A guard list: one Harness's, or `shared`, the files every snapshot includes. */
export type GuardGroup = GuardTarget | "shared";
/** The environment a snapshot resolves paths from: the user's home and environment, as the Harness runs with them. */
export interface GuardSource { readonly home: string; readonly values: Readonly<Record<string, string | undefined>> }
/**
 * A source with the two locations the capability page resolves by reading a file: Hermes's home (HERMES_HOME, the sticky
 * profile, ~/.hermes) and OpenClaw's default agent workspace (from openclaw.json). Without them the lists use
 * `$HERMES_HOME` or ~/.hermes, and ~/.openclaw/workspace (`workspace-<profile>` under OPENCLAW_PROFILE).
 */
export interface GuardEnvironment extends GuardSource { readonly hermesHome?: string; readonly openclawWorkspace?: string }
/**
 * One guarded location. `part`: for ~/.claude.json only its user-level `mcpServers` subtree is compared, because every
 * running Claude Code session rewrites the rest of the file (counters, projects, caches; ADR-045 compares only the
 * target subtree for the same reason).
 */
export interface GuardedPath { readonly path: string; readonly kind: "file" | "dir"; readonly part?: "mcpServers"; readonly groups: readonly GuardGroup[] }
/** A directory entry by name and type; a link with its target, written with ~ when it lies in the home. */
export interface DirectoryEntry { readonly name: string; readonly type: "file" | "dir" | "link" | "other"; readonly target?: string }
interface EntryCommon {
  /** The location written with ~ (as given when outside the home). */
  readonly path: string;
  readonly groups: readonly GuardGroup[];
  /** The location is itself a symbolic link to this target; what it leads to is what is described. */
  readonly link?: string;
}
export type GuardEntry = (EntryCommon & { readonly kind: "missing" })
  | (EntryCommon & { readonly kind: "file"; readonly sha256: string; readonly part?: "mcpServers" })
  | (EntryCommon & { readonly kind: "dir"; readonly entries: readonly DirectoryEntry[]; readonly links: number });
export interface GuardSnapshot {
  readonly format: typeof SNAPSHOT_FORMAT;
  readonly takenAt: string;
  /** The Harnesses whose lists it covers, sorted; the shared list is always included. */
  readonly harnesses: readonly GuardTarget[];
  readonly paths: readonly GuardEntry[];
}
/** `changed`: the ~ paths whose digest, entries, link or existence differ, sorted. */
export interface GuardComparison { readonly unchanged: boolean; readonly changed: readonly string[] }
/** A comparison made at the end of a suite; `failure` says why the second snapshot could not be taken (then nothing counts as unchanged). */
export interface GuardCheck extends GuardComparison { readonly failure?: string }
export type GuardErrorCode = "INVALID_INPUT" | "UNKNOWN_HARNESS" | "CREDENTIAL_PATH" | "UNREADABLE" | "UNSUPPORTED_ENTRY" | "TOO_LARGE" | "UNPARSABLE"
  | "INVALID_SNAPSHOT" | "SNAPSHOT_MISMATCH" | "PRIVACY" | "UNSUPPORTED_PLATFORM";
/** Every failure of the guard and the header; messages name locations with ~ and never carry file content. */
export class GuardError extends Error {
  constructor(readonly code: GuardErrorCode, message: string) { super(message); this.name = "GuardError"; }
}

const SNAPSHOT_FORMAT = "harnesshub-guard/1";
const MAX_FILE_BYTES = 256 * 1024 * 1024, MAX_JSON_BYTES = 64 * 1024 * 1024, MAX_ENTRIES = 10_000, MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
/** Finder's folder records: not configuration, and they appear whenever someone opens the folder. */
const IGNORED_ENTRIES = new Set([".DS_Store"]);
/** The product's protected configuration files (`protectedConfigurationPaths`) that belong to no Harness: shell startup files and npm's. */
const SHELL_FILES = [".zshrc", ".zprofile", ".bashrc", ".bash_profile", ".profile", ".npmrc"];
/** Names of files that hold sign-ins or keys wherever they are: API keys, OAuth tokens, `.env` files, netrc, device identities. */
const CREDENTIAL_NAME = /^(?:auth\.json|\.env(?:\..+)?|\.credentials\.(?:json|ya?ml)|credentials(?:\.json)?|oauth_creds\.json|\.netrc|\.git-credentials|device[-_]?id)$/iu;

const isTarget = (value: string): value is GuardTarget => (GUARD_TARGETS as readonly string[]).includes(value);
/** A variable as the capability read tables take it: unset or empty counts as absent; a leading ~/ is the home. */
function variable(source: GuardSource, name: string): string | undefined {
  const text = source.values[name];
  return text === undefined || text === "" ? undefined : text.startsWith("~/") ? join(source.home, text.slice(2)) : text;
}
function homeForms(home: string): readonly string[] {
  let real = home; try { real = realpathSync(home); } catch { /* a home that cannot be resolved is written as given */ }
  return [...new Set([home, real])].sort((left, right) => right.length - left.length);
}
/** A location written with ~ when it lies in the home (in either of its forms), as given otherwise. */
function shown(path: string, homes: readonly string[]): string {
  for (const home of homes) {
    if (path === home) return "~";
    if (path.startsWith(home + "/")) return "~/" + path.slice(home.length + 1);
  }
  return path;
}
/** A JSON value as text with object keys sorted and arrays in order: the same value always gives the same text. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object") return "{" + Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, item]) => JSON.stringify(key) + ":" + canonical(item)).join(",") + "}";
  return JSON.stringify(value) ?? "null";
}
function errno(error: unknown): string { return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "ERROR"; }
function unreadable(error: unknown, where: string): GuardError { return error instanceof GuardError ? error : new GuardError("UNREADABLE", where + " could not be read (" + errno(error) + ")"); }

/**
 * Where credentials live for this environment: single files (API keys, OAuth tokens, `.env`) and directories whose whole
 * content is secret (the Keychain, ~/.ssh, OpenClaw's channel credentials). Resolved with the same variables as the guard
 * lists, and at the default locations as well, so a variable pointing elsewhere cannot make the default one guardable.
 */
export function credentialLocations(env: GuardEnvironment): { readonly files: readonly string[]; readonly directories: readonly string[] } {
  const dirs = harnessDirectories(env), home = env.home, hermes = env.hermesHome ?? variable(env, "HERMES_HOME") ?? join(home, ".hermes");
  const gemini = join(variable(env, "GEMINI_CLI_HOME") ?? home, ".gemini"), data = variable(env, "XDG_DATA_HOME") ?? join(home, ".local", "share");
  const files = [join(hermes, ".env"), join(hermes, "auth.json"), join(home, ".hermes", ".env"), join(home, ".hermes", "auth.json"),
    join(dirs.dsh, ".credentials.yaml"), join(home, ".dsh", ".credentials.yaml"), join(dirs.codex, "auth.json"), join(home, ".codex", "auth.json"),
    join(dirs.claude, ".credentials.json"), join(home, ".claude", ".credentials.json"), join(data, "opencode", "auth.json"), join(home, ".local", "share", "opencode", "auth.json"),
    join(gemini, "oauth_creds.json"), join(home, ".gemini", "oauth_creds.json"), join(dirs.pi, "auth.json"), join(home, ".pi", "agent", "auth.json"), join(home, ".netrc")];
  const directories = [join(home, "Library", "Keychains"), "/Library/Keychains", join(home, ".ssh"), join(home, ".gnupg"), join(home, ".cc-switch"),
    join(dirs.openclaw, "credentials"), join(home, ".openclaw", "credentials")];
  return { files: [...new Set(files.map(path => normalize(path)))], directories: [...new Set(directories.map(path => normalize(path)))] };
}
/** Whether a location is a credential: one of `credentialLocations`, inside one of its directories, or named like a credential file. Case-insensitive, as macOS's file system is. */
export function isCredentialPath(path: string, env: GuardEnvironment): boolean {
  const target = normalize(path).toLowerCase(), { files, directories } = credentialLocations(env);
  return CREDENTIAL_NAME.test(basename(path)) || files.some(file => file.toLowerCase() === target)
    || directories.some(directory => { const root = directory.toLowerCase(); return target === root || target.startsWith(root + "/"); });
}
function refuse(path: string, env: GuardEnvironment, homes: readonly string[]): void {
  if (isCredentialPath(path, env)) throw new GuardError("CREDENTIAL_PATH", shown(path, homes) + " is a credential location; the guard never reads or names one");
}
/**
 * The one way to make a guarded location: an absolute path that is not a credential location (`isCredentialPath`).
 * Throws INVALID_INPUT for a relative path and CREDENTIAL_PATH for a credential, so no list can come to read one.
 */
export function guardedPath(path: string, kind: "file" | "dir", group: GuardGroup, env: GuardEnvironment, part?: "mcpServers"): GuardedPath {
  if (!isAbsolute(path)) throw new GuardError("INVALID_INPUT", "a guarded location must be absolute: " + path);
  refuse(path, env, [env.home]);
  return { path: normalize(path), kind, ...(part === undefined ? {} : { part }), groups: [group] };
}

/**
 * The guarded locations of one list, resolved from `env` the way the capability read tables resolve them (CODEX_HOME,
 * CLAUDE_CONFIG_DIR, OPENCODE_CONFIG_DIR or XDG_CONFIG_HOME, OPENCLAW_CONFIG_PATH or OPENCLAW_STATE_DIR, HERMES_HOME,
 * DSH_HOME, PI_CODING_AGENT_DIR, GEMINI_CLI_HOME; the home otherwise). Pure: it reads nothing. Throws CREDENTIAL_PATH if
 * a list ever names a credential location, and UNKNOWN_HARNESS for a Harness without a list.
 */
export function guardedFiles(harnessId: string, env: GuardEnvironment): readonly GuardedPath[] {
  if (harnessId !== "shared" && !isTarget(harnessId)) throw new GuardError("UNKNOWN_HARNESS", "no guard list for " + JSON.stringify(harnessId) + "; known: " + GUARD_TARGETS.join(", "));
  const group: GuardGroup = harnessId, dirs = harnessDirectories(env), home = env.home;
  const file = (path: string, part?: "mcpServers") => guardedPath(path, "file", group, env, part), dir = (path: string) => guardedPath(path, "dir", group, env);
  switch (group) {
    case "claude": {
      // Claude keeps .claude.json in CLAUDE_CONFIG_DIR when that is set; the product's protected list names ~/.claude.json in any case.
      const own = join(home, ".claude.json");
      return [file(join(dirs.claude, "settings.json")), file(join(dirs.claude, "settings.local.json")), file(dirs.claudeJson, "mcpServers"),
        ...(normalize(dirs.claudeJson) === own ? [] : [file(own, "mcpServers")]), file(join(dirs.claude, "CLAUDE.md"))];
    }
    case "codex": return [file(join(dirs.codex, "config.toml")), file(join(dirs.codex, "AGENTS.md")), file(join(dirs.codex, "AGENTS.override.md"))];
    case "opencode": return [file(join(dirs.opencode, "opencode.json")), file(join(dirs.opencode, "opencode.jsonc")), file(join(dirs.opencode, "AGENTS.md"))];
    case "openclaw": {
      const profile = env.values.OPENCLAW_PROFILE?.trim();
      const workspace = env.openclawWorkspace ?? join(home, ".openclaw", profile && profile.toLowerCase() !== "default" ? "workspace-" + profile : "workspace");
      return [file(dirs.openclawConfig), file(join(workspace, "AGENTS.md")), dir(join(dirs.openclaw, "skills"))];
    }
    case "hermes": {
      const hermes = env.hermesHome ?? variable(env, "HERMES_HOME") ?? join(home, ".hermes");
      return [file(join(hermes, "config.yaml")), file(join(hermes, "SOUL.md")), dir(join(hermes, "skills")), dir(dirs.shared)];
    }
    case "dsh": return [file(join(dirs.dsh, "settings.yaml")), file(join(dirs.dsh, "settings.yaml.imported")), file(join(dirs.dsh, "cordis.patch.yml")),
      file(join(dirs.dsh, "profiles", "acp", "cordis.patch.yml")), file(join(dirs.dsh, "profiles", "acp", "package.json")), file(join(dirs.dsh, "AGENTS.md"))];
    case "cursor": return [file(join(dirs.cursor, "cli-config.json"))];
    case "gemini": return [file(join(variable(env, "GEMINI_CLI_HOME") ?? home, ".gemini", "settings.json"))];
    case "pi": return [file(join(dirs.pi, "settings.json")), file(join(dirs.pi, "models.json"))];
    case "shared": return [dir(dirs.shared), ...SHELL_FILES.map(name => file(join(home, name)))];
  }
}
/** The Harness ids of a snapshot, checked, without repeats and sorted; UNKNOWN_HARNESS for one without a guard list. */
export function guardTargets(ids: readonly string[]): readonly GuardTarget[] {
  const targets = new Set<GuardTarget>();
  for (const id of ids) {
    if (!isTarget(id)) throw new GuardError("UNKNOWN_HARNESS", "no guard list for " + JSON.stringify(id) + "; known: " + GUARD_TARGETS.join(", "));
    targets.add(id);
  }
  return [...targets].sort();
}
/** Resolves Hermes's home and OpenClaw's workspace as the capability page does, only for the Harnesses listed (the other files are not read). */
export async function guardEnvironment(source: GuardSource, targets: readonly GuardTarget[]): Promise<GuardEnvironment> {
  return { home: source.home, values: source.values,
    ...(targets.includes("hermes") ? { hermesHome: await resolveHermesHome(source) } : {}),
    ...(targets.includes("openclaw") ? { openclawWorkspace: await resolveOpenClawWorkspace(source) } : {}) };
}

/** A file's digest, or for ~/.claude.json the digest of its `mcpServers` subtree in canonical form ("absent" when it has none). */
async function digest(path: string, where: string, part: "mcpServers" | undefined): Promise<string> {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (error) { throw unreadable(error, where); }
  try {
    const info = await handle.stat(), limit = part === undefined ? MAX_FILE_BYTES : MAX_JSON_BYTES;
    if (!info.isFile()) throw new GuardError("UNSUPPORTED_ENTRY", where + " stopped being a file while it was read");
    if (info.size > limit) throw new GuardError("TOO_LARGE", where + " is larger than " + limit + " bytes");
    if (part === undefined) {
      const hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
      for (let total = 0; ;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) return hash.digest("hex");
        total += bytesRead; if (total > limit) throw new GuardError("TOO_LARGE", where + " grew beyond " + limit + " bytes while it was read");
        hash.update(buffer.subarray(0, bytesRead));
      }
    }
    const bytes = await handle.readFile();
    if (bytes.length > limit) throw new GuardError("TOO_LARGE", where + " grew beyond " + limit + " bytes while it was read");
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw new GuardError("UNPARSABLE", where + " is not valid UTF-8 JSON, so its " + part + " cannot be compared"); }
    const subtree = value !== null && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, part) ? Object.entries(value).find(([key]) => key === part)?.[1] : undefined;
    return createHash("sha256").update(subtree === undefined ? "absent" : "present:" + canonical(subtree)).digest("hex");
  } catch (error) { throw unreadable(error, where); }
  finally { await handle.close(); }
}
/** A directory's entries by name, type and link target (never their content); credential entries and Finder records are left out. */
async function listing(path: string, where: string, env: GuardEnvironment, homes: readonly string[]): Promise<{ readonly entries: readonly DirectoryEntry[]; readonly links: number }> {
  let names;
  try { names = await readdir(path, { withFileTypes: true }); } catch (error) { throw unreadable(error, where); }
  if (names.length > MAX_ENTRIES) throw new GuardError("TOO_LARGE", where + " has more than " + MAX_ENTRIES + " entries");
  const entries: DirectoryEntry[] = [];
  for (const entry of names) {
    const child = join(path, entry.name);
    if (IGNORED_ENTRIES.has(entry.name) || isCredentialPath(child, env)) continue;
    if (entry.isSymbolicLink()) {
      let target: string;
      try { target = await readlink(child); } catch (error) { throw unreadable(error, where + "/" + entry.name); }
      entries.push({ name: entry.name, type: "link", target: isAbsolute(target) ? shown(normalize(target), homes) : target });
    } else entries.push({ name: entry.name, type: entry.isDirectory() ? "dir" : entry.isFile() ? "file" : "other" });
  }
  entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  return { entries, links: entries.filter(entry => entry.type === "link").length };
}
async function observe(item: GuardedPath, env: GuardEnvironment, homes: readonly string[]): Promise<GuardEntry> {
  const where = shown(item.path, homes), common = { path: where, groups: item.groups };
  refuse(item.path, env, homes);
  let info;
  try { info = await lstat(item.path); }
  catch (error) { if (["ENOENT", "ENOTDIR"].includes(errno(error))) return { ...common, kind: "missing" }; throw unreadable(error, where); }
  let target = item.path, link: { readonly link?: string } = {};
  if (info.isSymbolicLink()) {
    let text: string;
    try { text = await readlink(item.path); } catch (error) { throw unreadable(error, where); }
    link = { link: isAbsolute(text) ? shown(normalize(text), homes) : text };
    try { target = await realpath(item.path); }
    catch (error) { if (["ENOENT", "ENOTDIR"].includes(errno(error))) return { ...common, ...link, kind: "missing" }; throw unreadable(error, where); }
    // A link that leads to a credential is refused like the credential itself.
    refuse(target, env, homes);
    try { info = await stat(target); } catch (error) { throw unreadable(error, where); }
  }
  if (info.isFile()) return { ...common, ...link, kind: "file", sha256: await digest(target, where, item.part), ...(item.part === undefined ? {} : { part: item.part }) };
  if (info.isDirectory()) return { ...common, ...link, kind: "dir", ...await listing(target, where, env, homes) };
  throw new GuardError("UNSUPPORTED_ENTRY", where + " is neither a file nor a directory");
}
/**
 * The snapshot of exactly these locations (normally the lists of `snapshot`): each one's digest, entries or absence,
 * read once and never written. Every location is refused again before it is opened, a hand-made entry included, and so is
 * a link that leads to a credential. Rejects with GuardError (locations with ~, never content); PRIVACY if the result
 * would still name a path by its absolute home form.
 */
export async function snapshotPaths(paths: readonly GuardedPath[], env: GuardEnvironment, harnesses: readonly GuardTarget[]): Promise<GuardSnapshot> {
  const homes = homeForms(env.home), merged = new Map<string, GuardedPath>();
  for (const item of paths) {
    if (!isAbsolute(item.path)) throw new GuardError("INVALID_INPUT", "a guarded location must be absolute: " + item.path);
    const path = normalize(item.path), known = merged.get(path);
    if (known === undefined) { merged.set(path, { ...item, path }); continue; }
    if (known.kind !== item.kind || known.part !== item.part) throw new GuardError("INVALID_INPUT", shown(path, homes) + " is listed twice in different ways");
    merged.set(path, { ...known, groups: [...new Set([...known.groups, ...item.groups])].sort() });
  }
  const entries: GuardEntry[] = [];
  for (const item of merged.values()) entries.push(await observe(item, env, homes));
  entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const result: GuardSnapshot = { format: SNAPSHOT_FORMAT, takenAt: new Date().toISOString(), harnesses: [...harnesses].sort(), paths: entries };
  if (homePathsIn(result, homes, 1 << 20).length) throw new GuardError("PRIVACY", "the snapshot would name a path by its absolute home form");
  return result;
}
/**
 * The snapshot of the listed Harnesses' locations and the shared ones, resolved from `source` (the user's home and
 * environment). Reads only the files of the lists named (Hermes's sticky profile and OpenClaw's workspace setting only when
 * those Harnesses are listed); writes nothing. Rejects with UNKNOWN_HARNESS for a Harness without a list, and otherwise as
 * `snapshotPaths`.
 */
export async function snapshot(ids: readonly string[], source: GuardSource): Promise<GuardSnapshot> {
  const targets = guardTargets(ids), env = await guardEnvironment(source, targets);
  return snapshotPaths([...targets.flatMap(id => guardedFiles(id, env)), ...guardedFiles("shared", env)], env, targets);
}
function entryKey(entry: GuardEntry): string {
  switch (entry.kind) {
    case "missing": return JSON.stringify(["missing", entry.link ?? null]);
    case "file": return JSON.stringify(["file", entry.link ?? null, entry.part ?? null, entry.sha256]);
    case "dir": return JSON.stringify(["dir", entry.link ?? null, entry.entries.map(item => [item.name, item.type, item.target ?? null])]);
  }
}
/**
 * Compares two snapshots of the same Harnesses: a location counts as changed when its existence, kind, link, digest or
 * entries differ, or when only one snapshot lists it. Pure. Throws SNAPSHOT_MISMATCH for snapshots of different formats
 * or Harness lists, which say nothing about each other.
 */
export function compare(before: GuardSnapshot, after: GuardSnapshot): GuardComparison {
  if (before.format !== after.format) throw new GuardError("SNAPSHOT_MISMATCH", "the snapshots have different formats");
  if (before.harnesses.join(",") !== after.harnesses.join(",")) throw new GuardError("SNAPSHOT_MISMATCH", "the snapshots cover different Harnesses: " + before.harnesses.join(",") + " and " + after.harnesses.join(","));
  const first = new Map(before.paths.map(entry => [entry.path, entryKey(entry)])), second = new Map(after.paths.map(entry => [entry.path, entryKey(entry)]));
  const changed = [...new Set([...first.keys(), ...second.keys()])].filter(path => first.get(path) !== second.get(path)).sort();
  return { unchanged: changed.length === 0, changed };
}
/**
 * The end of a guarded run: a second snapshot of `before`'s Harnesses compared with it. A guard failure (an unreadable
 * file, a credential link) is returned as `failure` with nothing counted as unchanged, so the run fails with the reason;
 * any other error is thrown.
 */
export async function recheck(before: GuardSnapshot, source: GuardSource): Promise<GuardCheck> {
  try { return compare(before, await snapshot(before.harnesses, source)); }
  catch (error) { if (error instanceof GuardError) return { unchanged: false, changed: [], failure: error.code + ": " + error.message }; throw error; }
}
/** A check in one line for an assertion message: the changed ~ paths, or the failure. */
export function describeGuard(check: GuardCheck): string {
  return check.failure !== undefined ? "the guard could not take its second snapshot: " + check.failure
    : check.unchanged ? "configuration unchanged" : "configuration changed: " + check.changed.join(", ");
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new GuardError("INVALID_SNAPSHOT", where + " must be an object");
  return Object.fromEntries(Object.entries(value));
}
function only(value: Record<string, unknown>, keys: readonly string[], where: string): void {
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new GuardError("INVALID_SNAPSHOT", where + " has an unknown field " + JSON.stringify(key));
}
function text(value: unknown, where: string): string {
  if (typeof value !== "string" || value === "" || value.length > 4096 || value.includes("\0")) throw new GuardError("INVALID_SNAPSHOT", where + " must be a short non-empty string");
  return value;
}
function groupsOf(value: unknown, where: string): readonly GuardGroup[] {
  if (!Array.isArray(value) || value.length === 0) throw new GuardError("INVALID_SNAPSHOT", where + " must be a non-empty list");
  return value.map((item, index) => { const group = text(item, where + "[" + index + "]"); if (group !== "shared" && !isTarget(group)) throw new GuardError("INVALID_SNAPSHOT", where + " names an unknown list"); return group; });
}
/**
 * A snapshot read back from a file (the command line's `compare`), as `unknown` until every field is checked. Throws
 * INVALID_SNAPSHOT naming the field, never echoing a value.
 */
export function parseSnapshot(value: unknown): GuardSnapshot {
  const root = record(value, "the snapshot");
  only(root, ["format", "takenAt", "harnesses", "paths"], "the snapshot");
  if (root.format !== SNAPSHOT_FORMAT) throw new GuardError("INVALID_SNAPSHOT", "the snapshot is not in the " + SNAPSHOT_FORMAT + " format");
  const takenAt = text(root.takenAt, "takenAt");
  if (!Array.isArray(root.harnesses) || !Array.isArray(root.paths)) throw new GuardError("INVALID_SNAPSHOT", "harnesses and paths must be lists");
  const harnesses = root.harnesses.map((item, index) => { const id = text(item, "harnesses[" + index + "]"); if (!isTarget(id)) throw new GuardError("INVALID_SNAPSHOT", "harnesses[" + index + "] has no guard list"); return id; });
  if (new Set(harnesses).size !== harnesses.length || harnesses.join(",") !== [...harnesses].sort().join(",")) throw new GuardError("INVALID_SNAPSHOT", "harnesses must be sorted without repeats");
  const seen = new Set<string>();
  const paths = root.paths.map((raw, index): GuardEntry => {
    const where = "paths[" + index + "]", item = record(raw, where), path = text(item.path, where + ".path"), groups = groupsOf(item.groups, where + ".groups");
    if (seen.has(path)) throw new GuardError("INVALID_SNAPSHOT", where + " repeats a location"); seen.add(path);
    const link = item.link === undefined ? {} : { link: text(item.link, where + ".link") }, common = { path, groups, ...link };
    switch (item.kind) {
      case "missing": only(item, ["path", "groups", "link", "kind"], where); return { ...common, kind: "missing" };
      case "file": {
        only(item, ["path", "groups", "link", "kind", "sha256", "part"], where);
        if (typeof item.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(item.sha256)) throw new GuardError("INVALID_SNAPSHOT", where + ".sha256 must be a SHA-256 digest");
        if (item.part !== undefined && item.part !== "mcpServers") throw new GuardError("INVALID_SNAPSHOT", where + ".part is unknown");
        return { ...common, kind: "file", sha256: item.sha256, ...(item.part === undefined ? {} : { part: item.part }) };
      }
      case "dir": {
        only(item, ["path", "groups", "link", "kind", "entries", "links"], where);
        if (!Array.isArray(item.entries) || item.entries.length > MAX_ENTRIES) throw new GuardError("INVALID_SNAPSHOT", where + ".entries must be a bounded list");
        const entries = item.entries.map((rawEntry, at): DirectoryEntry => {
          const inner = where + ".entries[" + at + "]", entry = record(rawEntry, inner), name = text(entry.name, inner + ".name");
          only(entry, ["name", "type", "target"], inner);
          if (name.includes("/")) throw new GuardError("INVALID_SNAPSHOT", inner + ".name must be a single name");
          if (entry.type === "link") return { name, type: "link", target: text(entry.target, inner + ".target") };
          if (entry.target !== undefined || (entry.type !== "file" && entry.type !== "dir" && entry.type !== "other")) throw new GuardError("INVALID_SNAPSHOT", inner + ".type is unknown");
          return { name, type: entry.type };
        });
        if (entries.some((entry, at) => at > 0 && entries[at - 1]!.name >= entry.name)) throw new GuardError("INVALID_SNAPSHOT", where + ".entries must be sorted without repeats");
        if (item.links !== entries.filter(entry => entry.type === "link").length) throw new GuardError("INVALID_SNAPSHOT", where + ".links must count the link entries");
        return { ...common, kind: "dir", entries, links: item.links };
      }
      default: throw new GuardError("INVALID_SNAPSHOT", where + ".kind must be missing, file or dir");
    }
  });
  return { format: SNAPSHOT_FORMAT, takenAt, harnesses, paths };
}

/** One installation as the evidence names it: the Harness page's view without its management fields; no path, `ref` is a digest. */
export type EvidenceInstallation = Pick<InstallationView, "ref" | "channel" | "label" | "command" | "version" | "role" | "active">;
export interface EvidenceHarness {
  readonly harnessId: string;
  /** `system`: installations found on this computer; `managed`: a HarnessHub private installation; `missing`: none found. */
  readonly source: HarnessManagementView["source"];
  /** Every installation found, in search order; `active` marks the one HarnessHub runs, per role. */
  readonly installations: readonly EvidenceInstallation[];
  /**
   * The control entries that can run, by how each was found: on PATH, in a standard directory, as the discovery manifest's
   * custom entry (a development entry, which no installation above describes), in a package root, or HarnessHub-managed.
   */
  readonly controls: readonly { readonly id: string; readonly protocol: string; readonly entry: HarnessEntrySource }[];
  /** The version of the entry HarnessHub starts, as its channel records it (the adapter's, for an adapter entry). */
  readonly entryVersion: string | null;
  /** The product's version: management's, or, when that needs a version probe (an adapter entry), the active product installation's record. */
  readonly programVersion: string | null;
  readonly programVersionFrom: "management" | "installation" | null;
  /** ADR-038's judgement of these versions against VERIFIED_VERSIONS; null when no product version is known. */
  readonly verification: HarnessVersionVerification | null;
}
export interface EvidenceHeader {
  readonly recordedAt: string;
  /** `git rev-parse HEAD` of this repository; "unknown" when it could not be read, with `commitNote` saying why. */
  readonly commit: string;
  readonly commitNote?: string;
  /** Whether tracked files differed from the commit (`git status --porcelain --untracked-files=no`); null when unknown. */
  readonly uncommittedChanges: boolean | null;
  /** The installation policy the suite's discovery ran with (ADR-044): official channels only, or any entry (development). */
  readonly policy: InstallationPolicy;
  readonly platform: "macOS";
  readonly harnesses: readonly EvidenceHarness[];
}
/** What a header reads from a composed application: its discovery environment and policy, and its management view. */
export interface HeaderApplication {
  readonly factory: { readonly discoveryEnvironment: NativeEnvironment; readonly installations: InstallationPolicy };
  readonly management: {
    setSystemObservations(entries: readonly SystemInstallationObservation[]): void;
    views(harnessIds: readonly string[]): readonly HarnessManagementView[];
    resolveControl(harnessId: string, controlId: string): ResolvedManagedControl | null;
  };
}
/** How the suite discovers installations: its discovery manifest, search directories, package roots and PATH-only flag. */
export type DiscoveryConfiguration = Pick<SessionConfiguration, "manifestPath" | "searchDirs" | "packageRoots" | "pathOnly">;
export interface EvidenceHeaderOptions {
  /** As the suite's sessions discover; no manifest and the standard directories by default. */
  readonly configuration?: DiscoveryConfiguration;
  /** The git work tree whose HEAD is recorded; this repository by default. */
  readonly repository?: string;
}
/** This repository, from the compiled module in dist/tests/real. */
const REPOSITORY = fileURLToPath(new URL("../../../", import.meta.url));
function repositoryState(cwd: string): Pick<EvidenceHeader, "commit" | "commitNote" | "uncommittedChanges"> {
  // Read-only, without optional index locks: a header never changes the work tree it describes.
  const git = (args: readonly string[]) => spawnSync("git", [...args], { cwd, encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
  const head = git(["rev-parse", "HEAD"]), commit = head.stdout?.trim() ?? "";
  if (head.error !== undefined || head.status !== 0 || !/^[0-9a-f]{40}$/u.test(commit))
    return { commit: "unknown", commitNote: "git rev-parse HEAD did not give a commit (" + (head.error !== undefined ? errno(head.error) : "exit " + String(head.status ?? head.signal)) + ")", uncommittedChanges: null };
  const status = git(["status", "--porcelain", "--untracked-files=no"]);
  if (status.error !== undefined || status.status !== 0) return { commit, commitNote: "git status could not be read, so uncommitted changes are unknown", uncommittedChanges: null };
  const changed = status.stdout.trim().length > 0;
  return changed ? { commit, commitNote: "tracked files differed from this commit when the evidence was recorded", uncommittedChanges: true } : { commit, uncommittedChanges: false };
}
function base(policy: InstallationPolicy, repository: string | undefined): Omit<EvidenceHeader, "harnesses"> {
  if (process.platform !== "darwin") throw new GuardError("UNSUPPORTED_PLATFORM", "real acceptance evidence is recorded only on macOS (ADR-044)");
  return { recordedAt: new Date().toISOString(), ...repositoryState(repository ?? REPOSITORY), policy, platform: "macOS" };
}
/**
 * The evidence header for `harnessIds` (ids or aliases): the commit, the app's installation policy, and each Harness's
 * installations, versions and ADR-038 judgement, read the way the Harness page reads them (`inventory`, `installationViews`,
 * `management.views`) without starting any program: no version probe runs, so an adapter-fronted product's version comes
 * from its active installation's record and says so. Replaces the app's system observations like a page scan does.
 * Rejects with UNKNOWN_HARNESS for an id the catalog does not know, UNSUPPORTED_PLATFORM off macOS, and PRIVACY if the
 * header would name a path by its absolute home form.
 */
export async function evidenceHeader(app: HeaderApplication, harnessIds: readonly string[], options: EvidenceHeaderOptions = {}): Promise<EvidenceHeader> {
  const header = base(app.factory.installations, options.repository), configuration = options.configuration;
  if (harnessIds.length === 0) return { ...header, harnesses: [] };
  const environment = app.factory.discoveryEnvironment;
  const manifest = configuration === undefined ? null : configuration.manifestPath;
  const observed = await inventory({ ...(manifest === null ? {} : { manifest }), environment: environment.values, home: environment.home,
    searchDirs: configuration?.searchDirs ?? [], packageRoots: configuration?.packageRoots ?? [], pathOnly: configuration?.pathOnly ?? false,
    installations: app.factory.installations, managedResolver: { resolveControl: (harnessId, controlId) => app.management.resolveControl(harnessId, controlId) } });
  // As the page's scan gives them: read-only observations, so management's view knows each entry and its package version.
  app.management.setSystemObservations(observed.report.harnesses.flatMap(harness => harness.controls.flatMap(control => {
    if (control.state !== "candidate" || control.command === null || observed.managedBindings.has(control.id)) return [];
    const packageVersion = observedPackageVersion(control.diagnostics), program = productCommand(observed.definitions.find(item => item.id === harness.id)?.binaryNames[0], harness.installation, control);
    return [{ harnessId: harness.id, controlId: control.id, command: control.command, ...(packageVersion === undefined ? {} : { packageVersion }), ...(program === null ? {} : { program }) }];
  })));
  const found = harnessIds.map(id => {
    const harness = observed.report.harnesses.find(item => item.id === id || item.aliases.includes(id));
    if (harness === undefined) throw new GuardError("UNKNOWN_HARNESS", "the catalog has no Harness " + JSON.stringify(id));
    return harness;
  });
  const unique = [...new Map(found.map(harness => [harness.id, harness])).values()], views = app.management.views(unique.map(harness => harness.id));
  const harnesses = unique.map((harness, index): EvidenceHarness => {
    const view = views[index]!, installations = installationViews(harness.id, harness.installation, environment.home)
      .map(({ ref, channel, label, command, version, role, active }) => ({ ref, channel, label, command, version, role, active }));
    const recorded = installations.find(item => item.role === "product" && item.active)?.version ?? null;
    const programVersion = view.programVersion ?? recorded, programVersionFrom = view.programVersion !== null ? "management" : recorded !== null ? "installation" : null;
    const verification = view.verification ?? (programVersion === null ? null : versionVerification(harness.id, programVersion, view.installedVersion));
    const controls = harness.controls.flatMap(control => {
      const entry = control.state === "candidate" ? harnessEntry(control, observed.managedBindings.has(control.id)) : null;
      return entry === null ? [] : [{ id: control.id, protocol: control.protocol, entry: entry.source }];
    });
    return { harnessId: harness.id, source: view.source, installations, controls, entryVersion: view.installedVersion, programVersion, programVersionFrom, verification };
  });
  const result: EvidenceHeader = { ...header, harnesses };
  if (homePathsIn(result, homeForms(environment.home), 1 << 20).length) throw new GuardError("PRIVACY", "the header would name a path by its absolute home form");
  return result;
}
export interface StandaloneHeaderOptions extends EvidenceHeaderOptions {
  /** A private directory of the suite; the header's own data directory is made in it and removed afterwards. */
  readonly root: string;
  /** The suite's workspace lock root (ADR-041). */
  readonly workspaceLockRoot: string;
  readonly policy: InstallationPolicy;
  /** The environment discovery reads; the process's own (the user's) by default. */
  readonly environment?: NativeEnvironment;
}
/**
 * The header of a suite that composes no application of its own (or one whose environment is not the user's): composes
 * a short-lived one with the suite's policy, the user's environment and no installation work, reads the header, closes it
 * and removes its data directory, whatever happened. With no Harness ids nothing is composed.
 */
export async function standaloneHeader(harnessIds: readonly string[], options: StandaloneHeaderOptions): Promise<EvidenceHeader> {
  if (harnessIds.length === 0) return { ...base(options.policy, options.repository), harnesses: [] };
  const data = join(options.root, "evidence-header");
  try {
    const app = application(data, () => {}, { installations: options.policy, management: { installationMode: "private-fixture" }, workspaceLockRoot: options.workspaceLockRoot,
      ...(options.environment === undefined ? {} : { nativeEnvironment: options.environment }) });
    try { return await evidenceHeader(app, harnessIds, { ...(options.configuration === undefined ? {} : { configuration: options.configuration }), ...(options.repository === undefined ? {} : { repository: options.repository }) }); }
    finally { try { await app.runtime.close(); } finally { try { await app.management.shutdown(); } finally { try { await app.providers.shutdown(); } finally { app.store.close(); } } } }
  } finally { await rm(data, { recursive: true, force: true }); }
}

const USAGE = [
  "usage: node dist/tests/real/guard.js snapshot <ids> <out.json>   ids comma-separated, from: " + GUARD_TARGETS.join(", "),
  "       node dist/tests/real/guard.js compare <before.json> <after.json>",
  "snapshot writes a new 0600 file of digests (never content); compare exits 0 when unchanged, 1 listing the changed ~ paths.",
  "Other exits: 64 bad arguments, 65 an unreadable or invalid snapshot file, 73 the output file exists, 70 the snapshot failed.",
].join("\n") + "\n";
/** The command line; returns the exit code and writes only summaries and ~ paths (`output` for results, `errors` for failures). */
export async function main(args: readonly string[], io: { readonly source?: GuardSource; readonly output?: (text: string) => void; readonly errors?: (text: string) => void } = {}): Promise<number> {
  const output = io.output ?? (text => { process.stdout.write(text); }), errors = io.errors ?? (text => { process.stderr.write(text); });
  const usage = (reason: string) => { errors("guard: " + reason + "\n" + USAGE); return 64; };
  const [command, first, second, ...rest] = args;
  if (command === "snapshot") {
    if (first === undefined || second === undefined || rest.length) return usage("snapshot takes a list of Harness ids and an output file");
    const ids = first.split(",").map(item => item.trim()).filter(Boolean);
    if (!ids.length) return usage("name at least one Harness");
    try { guardTargets(ids); } catch (error) { return usage(error instanceof Error ? error.message : "invalid Harness ids"); }
    let taken: GuardSnapshot;
    try { taken = await snapshot(ids, io.source ?? captureNativeEnvironment()); }
    catch (error) { errors("guard: " + (error instanceof GuardError ? error.code + ": " + error.message : "the snapshot failed") + "\n"); return 70; }
    try { await writeFile(resolve(second), JSON.stringify(taken, null, 2) + "\n", { mode: 0o600, flag: "wx" }); }
    catch (error) { errors("guard: the snapshot file could not be created (" + errno(error) + "); a snapshot never replaces an existing file\n"); return 73; }
    output("guard: " + taken.paths.length + " locations of " + taken.harnesses.join(", ") + " and the shared list, digests only\n");
    return 0;
  }
  if (command === "compare") {
    if (first === undefined || second === undefined || rest.length) return usage("compare takes two snapshot files");
    const read = async (file: string): Promise<GuardSnapshot> => {
      const handle = await open(resolve(file), constants.O_RDONLY | constants.O_NONBLOCK);
      try {
        const info = await handle.stat(); if (!info.isFile() || info.size > MAX_SNAPSHOT_BYTES) throw new GuardError("INVALID_SNAPSHOT", "a snapshot file must be a regular file of at most 16 MiB");
        return parseSnapshot(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await handle.readFile())));
      } finally { await handle.close(); }
    };
    let before: GuardSnapshot, after: GuardSnapshot;
    try { [before, after] = [await read(first), await read(second)]; }
    catch (error) { errors("guard: " + (error instanceof GuardError ? error.message : error instanceof SyntaxError ? "a snapshot file is not JSON" : "a snapshot file could not be read (" + errno(error) + ")") + "\n"); return 65; }
    let result: GuardComparison;
    try { result = compare(before, after); } catch (error) { return usage(error instanceof Error ? error.message : "the snapshots do not belong together"); }
    if (result.unchanged) { output("guard: unchanged (" + after.paths.length + " locations)\n"); return 0; }
    output("guard: changed\n" + result.changed.map(path => "  " + path + "\n").join(""));
    return 1;
  }
  return usage(command === undefined ? "missing command" : "unknown command " + JSON.stringify(command));
}
/** Run as `node dist/tests/real/guard.js`, not when imported and not as a test file of `node --test` (which sets NODE_TEST_CONTEXT). */
function invokedDirectly(): boolean {
  const script = process.argv[1];
  if (script === undefined || process.env.NODE_TEST_CONTEXT !== undefined) return false;
  try { return import.meta.url === pathToFileURL(realpathSync(script)).href; } catch { return false; }
}
if (invokedDirectly()) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, (error: unknown) => {
    process.stderr.write("guard: " + (error instanceof GuardError ? error.code + ": " + error.message : "unexpected failure") + "\n"); process.exitCode = 70;
  });
}
