import { randomBytes } from "node:crypto";
import { constants, existsSync, lstatSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { applyEdits, modify } from "jsonc-parser";
import type { HarnessReadTable, ReadEnvironment } from "../../adapters/capability-reads.js";
import { CapabilityError } from "../../contracts/capabilities.js";
import { frontmatter, parseConfig, record, text } from "./formats.js";
import { readArchiveFolder, type ArchiveListing } from "./github.js";
import { folderTree, MAX_SKILL_BYTES, MAX_SKILL_FILES, npxExcluded, npxExcludedPath, treeId, type FolderTree, type TreeItem } from "./skill-tree.js";

/**
 * Skills as folders in the shared `~/.agents/skills` (ADR-045 §4): finding them in a repository archive, writing one,
 * keeping snapshots to undo with, the `npx skills` lock, and the links that point at a folder.
 */

/**
 * The folder name `npx skills` gives a skill (vercel-labs/skills v1.7.2 `13e4063`, src/installer.ts `sanitizeName`):
 * lower case, every run of other characters than `a-z 0-9 . _` as one `-`, without leading or trailing dots and dashes,
 * at most 255 characters. Null where `npx skills` would fall back to `unnamed-skill`.
 */
export function skillFolderName(name: string): string | null {
  const sanitized = name.toLowerCase().replace(/[^a-z0-9._]+/gu, "-").replace(/^[.-]+|[.-]+$/gu, "").slice(0, 255);
  return sanitized === "" || sanitized === "." || sanitized === ".." ? null : sanitized;
}

/** A skill found in a repository archive. */
export interface FoundSkill {
  /** Its folder inside the repository; "" for the repository's root. */
  readonly folder: string;
  readonly name: string;
  /** The folder it gets in `~/.agents/skills`; null when its name gives none. */
  readonly installName: string | null;
  readonly description: string | null;
  /** What a copy holds: files, bytes and executable files, after `npx skills`'s exclusions. */
  readonly files: number;
  readonly bytes: number;
  readonly executables: number;
  /** The folder's tree id in the repository, everything included: what GitHub's trees interface reports and the lock records. */
  readonly upstreamTree: string | null;
  /** The tree id of the copy. */
  readonly copyTree: string | null;
  /** Whether the folder carries a plugin manifest (`.claude-plugin/plugin.json`). */
  readonly plugin: boolean;
  /** Why it cannot be installed; null when it can. */
  readonly refused: string | null;
}
const MAX_DESCRIPTION = 4096;
/**
 * Every skill in a listed archive: each folder holding a SKILL.md whose frontmatter names it and describes it. A SKILL.md
 * inside another skill's folder belongs to that skill; one inside a folder a copy leaves out (`.git`) is not a skill.
 * `under`, when given, keeps the skills in that folder of the repository and below it.
 */
export function findSkills(listing: ArchiveListing, under: string | null): readonly FoundSkill[] {
  const folders = listing.entries.filter(entry => entry.type === "file" && (entry.path === "SKILL.md" || entry.path.endsWith("/SKILL.md"))).map(entry => entry.path === "SKILL.md" ? "" : entry.path.slice(0, -"/SKILL.md".length))
    .filter(folder => !folder.split("/").some(segment => segment !== "" && npxExcluded(segment, true)))
    .filter(folder => under === null || folder === under || folder.startsWith(under + "/"));
  const set = new Set(folders), found: FoundSkill[] = [];
  for (const folder of [...set].sort()) {
    // Nested: an outer folder of this one is a skill too.
    const segments = folder === "" ? [] : folder.split("/");
    if (segments.some((_, index) => set.has(segments.slice(0, index).join("/")))) continue;
    const prefix = folder === "" ? "" : folder + "/", inside = listing.entries.filter(entry => entry.path.startsWith(prefix) && entry.path !== folder);
    const skillText = listing.skillFiles.get(prefix + "SKILL.md");
    const meta = skillText === undefined ? null : frontmatter(skillText).value;
    const name = text(meta?.name)?.trim() ?? null, description = text(meta?.description)?.trim() ?? null;
    const all: TreeItem[] = [], copy: TreeItem[] = [];
    let refused: string | null = null, bytes = 0, executables = 0;
    const lowered = new Map<string, string>();
    for (const entry of inside) {
      const relative = entry.path.slice(prefix.length), folded = relative.toLowerCase();
      if (lowered.has(folded) && lowered.get(folded) !== relative) refused ??= "有只差大小写的同名文件（" + relative + "），macOS 上会互相覆盖";
      lowered.set(folded, relative);
      if (entry.type === "directory") continue;
      if (entry.type !== "file") { refused ??= (entry.type === "symlink" ? "包含链接 " : entry.type === "hardlink" ? "包含硬链接 " : "包含特殊文件 ") + relative + "，HarnessHub 只装普通文件"; continue; }
      const item: TreeItem = { path: relative, mode: entry.executable ? "100755" : "100644", id: entry.id! };
      all.push(item);
      if (npxExcludedPath(relative)) continue;
      copy.push(item); bytes += entry.size;
      if (entry.executable) executables++;
    }
    if (skillText === undefined) refused ??= "SKILL.md 超过 256 KiB";
    else if (meta === null) refused ??= "SKILL.md 没有可读的 frontmatter";
    else if (name === null || name.length > 128 || /[\0-\x1f\x7f]/u.test(name)) refused ??= "SKILL.md 没有写明有效的 name";
    else if (description === null) refused ??= "SKILL.md 没有写 description";
    else if (description.length > MAX_DESCRIPTION) refused ??= "description 过长";
    const installName = name === null ? null : skillFolderName(name);
    if (name !== null && installName === null) refused ??= "技能名 " + name + " 不能作为文件夹名";
    if (copy.length > MAX_SKILL_FILES) refused ??= "文件超过 " + MAX_SKILL_FILES + " 个";
    if (bytes > MAX_SKILL_BYTES) refused ??= "超过 64 MB";
    found.push({ folder, name: name ?? (segments.at(-1) ?? ""), installName, description, files: copy.length, bytes, executables, upstreamTree: treeId(all), copyTree: treeId(copy),
      plugin: inside.some(entry => entry.path === prefix + ".claude-plugin/plugin.json"), refused });
  }
  return found;
}

/**
 * Writes one found skill's copy from the archive into `destination` (which must not exist): folders 0755, files 0644 or,
 * when executable, 0755, whatever the Gateway's umask. Returns the written tree, which must match the listed one.
 */
/** Writes a skill the user wrote as text: a new folder (0755) holding its SKILL.md (0644), synced; returns the folder's tree. */
export async function writeSkillText(text: string, destination: string): Promise<FolderTree> {
  await mkdir(destination, { mode: 0o755 }); await chmod(destination, 0o755);
  const handle = await open(join(destination, "SKILL.md"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
  try { await handle.writeFile(text, "utf8"); await handle.chmod(0o644); await handle.sync(); } finally { await handle.close(); }
  return folderTree(destination);
}
export async function writeSkill(archive: Buffer, skill: FoundSkill, destination: string): Promise<FolderTree> {
  const prefix = skill.folder === "" ? "" : skill.folder + "/";
  await mkdir(destination, { mode: 0o755 }); await chmod(destination, 0o755);
  for (const { entry, data } of await readArchiveFolder(archive, skill.folder)) {
    const relative = entry.path.slice(prefix.length);
    if (entry.type !== "file" || relative === "" || npxExcludedPath(relative)) continue;
    if (data === null) throw new CapabilityError("CAPABILITY_TARGET_REFUSED", "压缩包里的文件没有读到：" + relative);
    const target = join(destination, relative);
    await ensureFolders(destination, dirname(relative));
    const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, entry.executable ? 0o755 : 0o644);
    try { await handle.writeFile(data); await handle.chmod(entry.executable ? 0o755 : 0o644); await handle.sync(); } finally { await handle.close(); }
  }
  const tree = await folderTree(destination);
  if (tree.id !== skill.copyTree) throw new CapabilityError("CAPABILITY_TARGET_REFUSED", "写出的技能与检查时的内容不一致");
  return tree;
}
async function ensureFolders(root: string, relative: string): Promise<void> {
  if (relative === "." || relative === "") return;
  let current = root;
  for (const segment of relative.split("/")) {
    current = join(current, segment);
    const info = await lstat(current).catch(() => null);
    if (info === null) { await mkdir(current, { mode: 0o755 }); await chmod(current, 0o755); }
    else if (!info.isDirectory() || info.isSymbolicLink()) throw new CapabilityError("CAPABILITY_TARGET_REFUSED", "技能里的路径冲突：" + relative);
  }
}

/**
 * The staging folder beside the shared directory: on its file system, so a skill moves into place by one rename, and
 * outside it, since Hermes reads hidden folders there too. Throws when the two are on different file systems.
 */
export async function stagingFolder(shared: string): Promise<string> {
  const real = realpathSync(shared), parent = dirname(real), path = join(parent, ".harnesshub-staging-" + randomBytes(6).toString("hex"));
  await mkdir(path, { mode: 0o700 });
  if (lstatSync(path).dev !== lstatSync(real).dev) { await rm(path, { recursive: true, force: true }); throw new CapabilityError("CAPABILITY_TARGET_REFUSED", "共享目录与它的上级不在同一个文件系统上，无法原子地放入技能"); }
  return path;
}
/** Staging folders a stopped Gateway left beside the shared directory: older than ten minutes and this user's own. */
export function sweepStaging(shared: string): void {
  let parent: string;
  try { parent = dirname(realpathSync(shared)); } catch { return; }
  let names: string[] = [];
  try { names = readdirSync(parent); } catch { return; }
  for (const name of names) {
    if (!/^\.harnesshub-staging-[a-f0-9]{12}$/u.test(name)) continue;
    const path = join(parent, name);
    try { const info = lstatSync(path); if (info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid?.() && Date.now() - info.mtimeMs > 10 * 60_000) void rm(path, { recursive: true, force: true }); } catch { /* gone or not ours */ }
  }
}

/** A snapshot of a skill folder kept to undo a change: its tree id, files and bytes. */
export interface SkillSnapshot { readonly id: string; readonly files: number; readonly bytes: number }
const SNAPSHOT = /^[a-f0-9]{40}$/u;
/**
 * Snapshots of skill folders, by tree id, under the data root (`capabilities/skills/<id>/`, folders 0700, files 0600, with a
 * manifest of each file's path, mode and blob id). Only the snapshots that kept changes still name are kept.
 */
export class SkillSnapshots {
  constructor(private readonly directory: string) {}
  private path(id: string): string { if (!SNAPSHOT.test(id)) throw new CapabilityError("INVALID_INPUT", "invalid snapshot"); return join(this.directory, id); }
  /** Keeps `folder` as it is now; a snapshot of the same tree is kept once. */
  async save(folder: string): Promise<SkillSnapshot> {
    const tree = await folderTree(folder);
    if (tree.id === null) throw new CapabilityError("CAPABILITY_TARGET_REFUSED", "技能文件夹是空的");
    const target = this.path(tree.id);
    if (existsSync(target)) { await this.verify(tree.id); return { id: tree.id, files: tree.files, bytes: tree.bytes }; }
    await mkdir(this.directory, { mode: 0o700, recursive: true });
    const temporary = join(this.directory, ".tmp-" + randomBytes(6).toString("hex"));
    await mkdir(join(temporary, "files"), { mode: 0o700, recursive: true });
    try {
      for (const item of tree.items) {
        const source = join(folder, item.path), destination = join(temporary, "files", item.path);
        await mkdir(dirname(destination), { mode: 0o700, recursive: true });
        if (item.mode === "120000") await writeFile(destination, await readlink(source), { mode: 0o600, flag: "wx" });
        else await writeFile(destination, await readFile(source), { mode: 0o600, flag: "wx" });
      }
      await writeFile(join(temporary, "manifest.json"), JSON.stringify({ version: 1, id: tree.id, items: tree.items }), { mode: 0o600, flag: "wx" });
      await rename(temporary, target);
    } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error; }
    await this.verify(tree.id);
    return { id: tree.id, files: tree.files, bytes: tree.bytes };
  }
  /** Whether a snapshot is kept. */
  async has(id: string): Promise<boolean> { return SNAPSHOT.test(id) && (await lstat(join(this.directory, id, "manifest.json")).catch(() => null))?.isFile() === true; }
  /** The manifest of a snapshot, checked: its files hash to its ids and its items to the snapshot's id. */
  private async verify(id: string): Promise<readonly TreeItem[]> {
    const root = this.path(id);
    let value: unknown;
    try { value = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")); } catch { throw new CapabilityError("INVALID_STORAGE", "技能快照缺少清单"); }
    const items = Array.isArray(record(value).items) ? (record(value).items as unknown[]).flatMap((item): TreeItem[] => {
      const { path, mode, id: blob } = record(item);
      return typeof path === "string" && (mode === "100644" || mode === "100755" || mode === "120000") && typeof blob === "string" ? [{ path, mode, id: blob }] : [];
    }) : [];
    if (treeId(items) !== id) throw new CapabilityError("INVALID_STORAGE", "技能快照与它的记录不一致");
    return items;
  }
  /** Writes a snapshot's folder at `destination`, which must not exist: folders 0755, files 0644 or 0755, links as they were. */
  async restore(id: string, destination: string): Promise<void> {
    const items = await this.verify(id), root = this.path(id);
    await mkdir(destination, { mode: 0o755 }); await chmod(destination, 0o755);
    for (const item of items) {
      await ensureFolders(destination, dirname(item.path));
      const bytes = await readFile(join(root, "files", item.path)), target = join(destination, item.path);
      if (item.mode === "120000") { await symlink(bytes.toString("utf8"), target); continue; }
      const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, item.mode === "100755" ? 0o755 : 0o644);
      try { await handle.writeFile(bytes); await handle.chmod(item.mode === "100755" ? 0o755 : 0o644); await handle.sync(); } finally { await handle.close(); }
    }
    if ((await folderTree(destination)).id !== id) throw new CapabilityError("CAPABILITY_TARGET_REFUSED", "放回的技能与快照不一致");
  }
  /** Removes every snapshot that `keep` does not name. */
  async prune(keep: ReadonlySet<string>): Promise<void> {
    let names: string[] = [];
    try { names = await readdir(this.directory); } catch { return; }
    for (const name of names) if ((SNAPSHOT.test(name) && !keep.has(name)) || /^\.tmp-[a-f0-9]{12}$/u.test(name)) await rm(join(this.directory, name), { recursive: true, force: true });
  }
  /** How many snapshots are kept and their size. */
  async stats(): Promise<{ readonly count: number; readonly bytes: number }> {
    let names: string[] = [];
    try { names = (await readdir(this.directory)).filter(name => SNAPSHOT.test(name)); } catch { return { count: 0, bytes: 0 }; }
    let bytes = 0;
    for (const name of names) {
      try { const items = await this.verify(name); for (const item of items) bytes += (await lstat(join(this.directory, name, "files", item.path))).size; } catch { /* counted without its bytes */ }
    }
    return { count: names.length, bytes };
  }
}

/** One entry of a `npx skills` lock, with the file it is in. */
export interface LockEntry { readonly file: string; readonly name: string; readonly value: Readonly<Record<string, unknown>> }
/** The locks `npx skills` may keep (vercel-labs/skills `getSkillLockPath`): `$XDG_STATE_HOME/skills/.skill-lock.json` first, then `~/.agents/.skill-lock.json`. */
export function lockFiles(environment: ReadEnvironment): readonly string[] {
  const state = environment.values.XDG_STATE_HOME;
  return [...(state ? [join(state.replace(/^~(?=$|\/)/u, environment.home), "skills", ".skill-lock.json")] : []), join(environment.home, ".agents", ".skill-lock.json")];
}
/** A lock's text as `npx skills` v3 reads it; null with a reason when HarnessHub must not write it. */
export function lockSkills(source: string): { readonly skills: Readonly<Record<string, unknown>>; readonly writable: string | null } {
  const parsed = parseConfig(source, "json");
  if (!parsed.ok) return { skills: {}, writable: "lock 文件无法解析" };
  const value = record(parsed.value), version = value.version, skills = record(value.skills);
  if (typeof version !== "number" || value.skills === undefined) return { skills: {}, writable: "lock 文件不是 npx skills 的格式" };
  if (version < 3) return { skills, writable: "lock 文件是旧版本（v" + version + "），npx skills 会清空它" };
  if (version > 3) return { skills, writable: "lock 文件是 HarnessHub 不认识的新版本（v" + version + "）" };
  return { skills, writable: null };
}
/** Every lock entry, the first lock's entry winning for a name in both. */
export async function readLockEntries(environment: ReadEnvironment): Promise<ReadonlyMap<string, LockEntry>> {
  const entries = new Map<string, LockEntry>();
  for (const file of lockFiles(environment)) {
    let source: string;
    try { source = await readFile(file, "utf8"); } catch { continue; }
    for (const [name, value] of Object.entries(lockSkills(source).skills)) if (!entries.has(name) && value !== null && typeof value === "object" && !Array.isArray(value)) entries.set(name, { file, name, value: value as Record<string, unknown> });
  }
  return entries;
}
/**
 * One lock entry changed in the lock's text: its folder hash and update time set (`update`), or the entry removed, or put
 * back as it was. Every other byte of the file stays; the result is checked to differ only at that entry.
 */
export function editLock(source: string, name: string, change: { readonly kind: "update"; readonly skillFolderHash: string; readonly updatedAt: string } | { readonly kind: "remove" }
  | { readonly kind: "put" | "replace"; readonly value: Readonly<Record<string, unknown>> }): string {
  const { skills, writable } = lockSkills(source);
  if (writable !== null) throw new CapabilityError("CAPABILITY_TARGET_REFUSED", writable);
  const options = { formattingOptions: { insertSpaces: true, tabSize: 2, eol: source.includes("\r\n") ? "\r\n" : "\n" } };
  let result = source;
  if (change.kind === "update") {
    if (!Object.hasOwn(skills, name)) throw new CapabilityError("CAPABILITY_TARGET_CHANGED", "lock 里已经没有 " + name);
    result = applyEdits(result, modify(result, ["skills", name, "skillFolderHash"], change.skillFolderHash, options));
    result = applyEdits(result, modify(result, ["skills", name, "updatedAt"], change.updatedAt, options));
  } else if (change.kind === "remove") {
    if (!Object.hasOwn(skills, name)) throw new CapabilityError("CAPABILITY_TARGET_CHANGED", "lock 里已经没有 " + name);
    result = applyEdits(result, modify(result, ["skills", name], undefined, options));
  } else {
    if (Object.hasOwn(skills, name) !== (change.kind === "replace")) throw new CapabilityError("CAPABILITY_TARGET_CHANGED", change.kind === "put" ? "lock 里已经有 " + name : "lock 里已经没有 " + name);
    if (change.kind === "put") result = applyEdits(result, modify(result, ["skills", name], change.value, options));
    else {
      // Field by field, so the fields that stay keep their bytes.
      const current = record(skills[name]);
      for (const [key, value] of Object.entries(change.value)) if (!isDeepStrictEqual(current[key], value)) result = applyEdits(result, modify(result, ["skills", name, key], value, options));
      for (const key of Object.keys(current)) if (!Object.hasOwn(change.value, key)) result = applyEdits(result, modify(result, ["skills", name, key], undefined, options));
    }
  }
  // The guard every lock edit passes: the file parses to the same value except at this entry.
  const parsedBefore = parseConfig(source, "json"), before = record(parsedBefore.ok ? parsedBefore.value : null), after = parseConfig(result, "json");
  if (!after.ok) throw new CapabilityError("CAPABILITY_TARGET_REFUSED", "改动后的 lock 无法解析");
  const rest = (value: unknown): unknown => { const copy = structuredClone(record(value)) as Record<string, unknown>; const list = { ...record(copy.skills) }; delete list[name]; return { ...copy, skills: list }; };
  if (!isDeepStrictEqual(rest(after.value), rest(before))) throw new CapabilityError("CAPABILITY_TARGET_REFUSED", "lock 的改动超出了这一项");
  const entry = record(record(record(after.value).skills)[name]);
  const expected = change.kind === "update" ? { ...record(record(before.skills)[name]), skillFolderHash: change.skillFolderHash, updatedAt: change.updatedAt } : change.kind === "remove" ? null : change.value;
  if (expected === null ? Object.hasOwn(record(record(after.value).skills), name) : !isDeepStrictEqual(entry, expected)) throw new CapabilityError("CAPABILITY_TARGET_REFUSED", "lock 的这一项没有改成预期的样子");
  return result;
}

/** A link in a Harness's own skill folders that leads into a skill folder: where, and what it says. */
export interface SkillLinkFound { readonly path: string; readonly target: string }
/**
 * The links in the Harnesses' own skill folders (their read tables' roots other than the shared directory, bundled and
 * synced ones) whose real path is the folder `real` or inside it. Claude Code's `synced` and `.trash` are never read;
 * links are not followed.
 */
export function linksInto(real: string, tables: readonly HarnessReadTable[], shared: string): readonly SkillLinkFound[] {
  const roots = new Map<string, number>();
  for (const table of tables) for (const root of table.skills.roots) {
    if (root.role === "shared" || root.role === "bundled" || root.role === "synced" || root.path === shared) continue;
    roots.set(root.path, Math.max(roots.get(root.path) ?? 0, Math.min(root.depth, 4)));
  }
  const found = new Map<string, SkillLinkFound>();
  const walk = (directory: string, depth: number): void => {
    let names: string[] = [];
    try { names = readdirSync(directory); } catch { return; }
    for (const name of names) {
      if (name === "synced" || name === ".trash" || name === ".git") continue;
      const path = join(directory, name);
      let info: ReturnType<typeof lstatSync>;
      try { info = lstatSync(path); } catch { continue; }
      if (info.isSymbolicLink()) {
        let target: string, resolved: string | null;
        try { target = readlinkSync(path); } catch { continue; }
        try { resolved = realpathSync(path); } catch { resolved = null; }
        if (resolved !== null && (resolved === real || resolved.startsWith(real + "/"))) found.set(path, { path, target });
      } else if (info.isDirectory() && depth > 1) walk(path, depth - 1);
    }
  };
  for (const [root, depth] of roots) walk(root, depth);
  return [...found.values()].sort((left, right) => left.path.localeCompare(right.path));
}
