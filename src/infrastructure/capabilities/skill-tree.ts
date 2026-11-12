import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { CapabilityError } from "../../contracts/capabilities.js";

/**
 * Git object ids of skill folders (ADR-045 §4): the id GitHub gives a folder's tree, computed from files on disk or in
 * memory, so a copy can be compared with a repository, and with what `npx skills` recorded, without the network.
 */

/** A file of a tree by its path inside the folder: a regular file (executable or not) or a symbolic link. */
export interface TreeItem { readonly path: string; readonly mode: "100644" | "100755" | "120000"; readonly id: string }

/** Git's id of a blob with these bytes. */
export function blobId(bytes: Buffer): string { return createHash("sha1").update("blob " + bytes.length + "\0").update(bytes).digest("hex"); }

/**
 * What `npx skills` leaves out when it copies a skill (vercel-labs/skills v1.7.2 `13e4063`, src/installer.ts EXCLUDE_FILES
 * and EXCLUDE_DIRS): `metadata.json` files and `.git`, `__pycache__` and `__pypackages__` folders. HarnessHub copies by
 * the same rule, so a folder it installs or updates is the one `npx skills` would have made.
 */
export function npxExcluded(name: string, directory: boolean): boolean {
  return directory ? name === ".git" || name === "__pycache__" || name === "__pypackages__" : name === "metadata.json";
}
/** Whether a path inside a folder is left out by `npxExcluded`, by any of its segments. */
export function npxExcludedPath(path: string): boolean {
  const segments = path.split("/");
  return segments.slice(0, -1).some(segment => npxExcluded(segment, true)) || npxExcluded(segments.at(-1)!, false);
}

/**
 * The tree id of a folder holding `items` (paths with `/`, no empty or dot segments), as git computes it: entries sorted by
 * name, a folder sorting as its name followed by `/`; folders without files do not exist in git. Null when there are no items.
 */
export function treeId(items: readonly TreeItem[]): string | null {
  interface Node { readonly files: Map<string, TreeItem>; readonly folders: Map<string, Node> }
  const root: Node = { files: new Map(), folders: new Map() };
  for (const item of items) {
    const segments = item.path.split("/");
    if (segments.some(segment => segment === "" || segment === "." || segment === "..")) throw new CapabilityError("INVALID_INPUT", "invalid tree path");
    let node = root;
    for (const segment of segments.slice(0, -1)) { let next = node.folders.get(segment); if (!next) { next = { files: new Map(), folders: new Map() }; node.folders.set(segment, next); } node = next; }
    node.files.set(segments.at(-1)!, item);
  }
  const hash = (node: Node): string | null => {
    const entries: { readonly key: Buffer; readonly line: Buffer }[] = [];
    for (const [name, item] of node.files) entries.push({ key: Buffer.from(name), line: Buffer.concat([Buffer.from(item.mode + " " + name + "\0"), Buffer.from(item.id, "hex")]) });
    for (const [name, folder] of node.folders) {
      const id = hash(folder);
      if (id !== null) entries.push({ key: Buffer.from(name + "/"), line: Buffer.concat([Buffer.from("40000 " + name + "\0"), Buffer.from(id, "hex")]) });
    }
    if (!entries.length) return null;
    entries.sort((left, right) => Buffer.compare(left.key, right.key));
    const body = Buffer.concat(entries.map(entry => entry.line));
    return createHash("sha1").update("tree " + body.length + "\0").update(body).digest("hex");
  };
  return hash(root);
}

/** What a folder on disk holds, by the rule a copy follows, and its tree id. */
export interface FolderTree { readonly id: string | null; readonly items: readonly TreeItem[]; readonly files: number; readonly bytes: number; readonly executables: number; readonly links: number }
/**
 * Bounds of one folder read: a skill is a folder of instructions, scripts and assets, and a folder beyond them is not one HarnessHub copies
 * or compares into the user's directories. A skill with its models, fixtures or vendored packages is far larger than a page of instructions
 * (4,000 files and 64 MB were too tight for legitimate ones, 2026-11-12), so these are set where only a directory that is not a skill reaches them.
 */
export const MAX_SKILL_FILES = 50_000, MAX_SKILL_BYTES = 1024 * 1024 * 1024, MAX_SKILL_DEPTH = 32;
/** A size in the words of the refusal that names a bound. */
export function sizeWords(bytes: number): string { return bytes >= 1024 * 1024 * 1024 ? bytes / (1024 * 1024 * 1024) + " GB" : bytes / (1024 * 1024) + " MB"; }

/**
 * Reads a folder the way git would store it: regular files with their executable bit, symbolic links by what they point
 * to (never followed), and nothing else. `exclude` leaves entries out by name. Throws CAPABILITY_TARGET_REFUSED for a
 * folder past the bounds or holding another kind of entry.
 */
export async function folderTree(folder: string, exclude: (name: string, directory: boolean) => boolean = () => false): Promise<FolderTree> {
  const items: TreeItem[] = [];
  let bytes = 0, executables = 0, links = 0;
  const walk = async (directory: string, prefix: string, depth: number): Promise<void> => {
    if (depth > MAX_SKILL_DEPTH) throw new CapabilityError("CAPABILITY_TARGET_REFUSED", "技能文件夹嵌套过深");
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name), info = await lstat(path), relative = prefix + name;
      if (info.isDirectory()) { if (!exclude(name, true)) await walk(path, relative + "/", depth + 1); continue; }
      if (exclude(name, false)) continue;
      if (items.length >= MAX_SKILL_FILES) throw new CapabilityError("CAPABILITY_TARGET_REFUSED", "技能文件夹的文件超过 " + MAX_SKILL_FILES + " 个");
      if (info.isSymbolicLink()) { links++; items.push({ path: relative, mode: "120000", id: blobId(Buffer.from(await readlink(path))) }); continue; }
      if (!info.isFile()) throw new CapabilityError("CAPABILITY_TARGET_REFUSED", "技能文件夹里有既不是文件也不是文件夹的条目：" + relative);
      bytes += info.size;
      if (bytes > MAX_SKILL_BYTES) throw new CapabilityError("CAPABILITY_TARGET_REFUSED", "技能文件夹超过 " + sizeWords(MAX_SKILL_BYTES));
      const executable = (info.mode & 0o111) !== 0;
      if (executable) executables++;
      items.push({ path: relative, mode: executable ? "100755" : "100644", id: blobId(await readFile(path)) });
    }
  };
  await walk(folder, "", 0);
  return { id: treeId(items), items, files: items.length, bytes, executables, links };
}

/** An entry of a repository's tree as GitHub's trees interface gives it. */
export interface RemoteTreeEntry { readonly path: string; readonly mode: string; readonly type: string; readonly sha: string }
/**
 * The tree id of the folder `folder` of a repository tree (recursive listing) after leaving out what a copy leaves out,
 * so it can be compared with a copy on disk. Submodules are not part of a copy; null when nothing is left.
 */
export function remoteFolderTree(entries: readonly RemoteTreeEntry[], folder: string, exclude: (path: string) => boolean): string | null {
  const prefix = folder === "" ? "" : folder + "/", items: TreeItem[] = [];
  for (const entry of entries) {
    if (entry.type !== "blob" || !entry.path.startsWith(prefix) || !/^[a-f0-9]{40}$/u.test(entry.sha)) continue;
    const path = entry.path.slice(prefix.length);
    if (exclude(path)) continue;
    const mode = entry.mode === "100755" ? "100755" : entry.mode === "120000" ? "120000" : entry.mode === "100644" ? "100644" : null;
    if (mode !== null) items.push({ path, mode, id: entry.sha });
  }
  return treeId(items);
}
