import { spawn } from "node:child_process";
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import type { FileChange } from "../../contracts/protocol.js";
import type { WorkspaceChanges, WorkspaceRecord, WorkspaceWatch } from "../../contracts/workspace.js";

/**
 * The Hub's own record of what a Turn changed in its workspace (docs/decisions/LOG.md, 2026-11-12), whatever the Harness reported (DeepSeek
 * Harness and Hermes report no diff of their edits). Nothing of the user's repository is changed: git is only read (`--no-optional-locks`, so
 * not even the index's stat cache is refreshed), and what is kept between the start and the end is a private copy in a temporary directory,
 * removed when the Turn's record is made.
 *
 * In a git work tree the start is cheap: HEAD, and a copy of the files that differ from it then (`git status`, untracked files included and
 * ignored ones not). At the end the files that differ from HEAD now, the ones that differed at the start and the ones a commit in between
 * touched are each compared with what they were at the start (the copy, or HEAD's blob), and the text ones are diffed with diff(1).
 * Elsewhere every file's modification time and size are compared, and only their names are told. A file larger than COPY_BYTES is compared
 * by its blob hash or its size and time, and its diff is not made.
 */
const COPY_BYTES = 32 * 1024 * 1024;
/** A guard against a workspace that is a whole disk: past this many entries a workspace that is not a repository is not compared. */
const WALK_ENTRIES = 500_000;
/** A git or diff that runs this long is given up on: the Turn's end does not wait for ever on its record. */
const COMMAND_MS = 120_000;
/** Directories a workspace that is not a repository is not walked into: what installs and caches put there is not the Turn's work. */
const SKIPPED = new Set([".git", "node_modules"]);

interface Ran { readonly code: number | null; readonly stdout: Buffer }
function run(command: string, args: readonly string[], cwd: string, input?: string): Promise<Ran> {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "ignore"],
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" } });
    } catch { resolve({ code: null, stdout: Buffer.alloc(0) }); return; }
    const chunks: Buffer[] = [], timer = setTimeout(() => child.kill("SIGKILL"), COMMAND_MS);
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", () => { clearTimeout(timer); resolve({ code: null, stdout: Buffer.alloc(0) }); });
    child.on("close", code => { clearTimeout(timer); resolve({ code, stdout: Buffer.concat(chunks) }); });
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
  });
}
const git = (cwd: string, args: readonly string[], input?: string) => run("git", ["--no-optional-locks", ...args], cwd, input);

type Kept = { readonly kind: "absent" } | { readonly kind: "copied"; readonly path: string } | { readonly kind: "large"; readonly size: number; readonly mtimeMs: number };
interface GitStart { readonly mode: "git"; readonly root: string; readonly prefix: string; readonly head: string | null; readonly dirty: ReadonlyMap<string, Kept>; readonly stage: string }
interface FilesStart { readonly mode: "files"; readonly root: string; readonly files: ReadonlyMap<string, string> }
type Start = GitStart | FilesStart;

/** The paths `git status` names, relative to the repository's top, renames' old names included. */
function statusPaths(output: Buffer): string[] {
  const fields = output.toString("utf8").split("\0"), paths: string[] = [];
  for (let at = 0; at < fields.length; at++) {
    const entry = fields[at]!;
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    if (entry[0] === "R" || entry[0] === "C") { const old = fields[++at]; if (old) paths.push(old); }
  }
  return paths;
}
async function keep(path: string, into: string): Promise<Kept> {
  let info;
  try { info = await lstat(path); } catch { return { kind: "absent" }; }
  if (!info.isFile() && !info.isSymbolicLink()) return { kind: "absent" };
  if (info.size > COPY_BYTES) return { kind: "large", size: info.size, mtimeMs: info.mtimeMs };
  await mkdir(dirname(into), { recursive: true });
  if (info.isSymbolicLink()) await writeFile(into, await readlink(path)); else await copyFile(path, into);
  return { kind: "copied", path: into };
}
async function currentBytes(path: string): Promise<Buffer | null | "large"> {
  let info;
  try { info = await lstat(path); } catch { return null; }
  if (info.isSymbolicLink()) return Buffer.from(await readlink(path));
  if (!info.isFile()) return null;
  if (info.size > COPY_BYTES) return "large";
  try { return await readFile(path); } catch { return null; }
}
/** HEAD's blobs of `paths` at `head`: their bytes, or "large" for one too big to read, or null for none. */
async function headBlobs(root: string, head: string | null, paths: readonly string[]): Promise<Map<string, Buffer | "large" | null>> {
  const out = new Map<string, Buffer | "large" | null>();
  if (head === null || paths.length === 0) { for (const path of paths) out.set(path, null); return out; }
  const checked = (await git(root, ["cat-file", "--batch-check"], paths.map(path => head + ":" + path).join("\n") + "\n")).stdout.toString("utf8").split("\n");
  const small: string[] = [];
  paths.forEach((path, index) => {
    const line = checked[index] ?? "", match = /^[0-9a-f]+ blob (\d+)$/u.exec(line);
    if (match === null) out.set(path, null); else if (Number(match[1]) > COPY_BYTES) out.set(path, "large"); else small.push(path);
  });
  if (small.length === 0) return out;
  const batch = (await git(root, ["cat-file", "--batch"], small.map(path => head + ":" + path).join("\n") + "\n")).stdout;
  let at = 0;
  for (const path of small) {
    const end = batch.indexOf(10, at); if (end < 0) break;
    const header = batch.subarray(at, end).toString("utf8"), match = /^[0-9a-f]+ blob (\d+)$/u.exec(header);
    if (match === null) { out.set(path, null); at = end + 1; continue; }
    const size = Number(match[1]);
    out.set(path, batch.subarray(end + 1, end + 1 + size)); at = end + 1 + size + 1;
  }
  return out;
}
/** A unified diff of one file by diff(1), labelled as git labels them, with its counts; null counts for a binary file. */
async function fileDiff(stage: string, path: string, before: Buffer | null, after: Buffer | null): Promise<{ readonly text: string; readonly added: number | null; readonly removed: number | null }> {
  const name = (side: string) => join(stage, "diff", side, path);
  const write = async (side: string, bytes: Buffer | null) => { if (bytes === null) return "/dev/null"; await mkdir(dirname(name(side)), { recursive: true }); await writeFile(name(side), bytes); return name(side); };
  const left = await write("a", before), right = await write("b", after);
  const ran = await run("/usr/bin/diff", ["-u", "--label", before === null ? "/dev/null" : "a/" + path, "--label", after === null ? "/dev/null" : "b/" + path, left, right], stage);
  const text = ran.stdout.toString("utf8");
  if (/^Binary files /mu.test(text) || (before?.includes(0) ?? false) || (after?.includes(0) ?? false)) return { text: "Binary file " + path + " changed\n", added: null, removed: null };
  let added = 0, removed = 0;
  for (const line of text.split("\n")) { if (line.startsWith("+") && !line.startsWith("+++")) added++; else if (line.startsWith("-") && !line.startsWith("---")) removed++; }
  return { text, added, removed };
}

async function walk(root: string): Promise<Map<string, string> | null> {
  const files = new Map<string, string>();
  let entries = 0;
  const visit = async (dir: string): Promise<boolean> => {
    let items;
    try { items = await readdir(dir, { withFileTypes: true }); } catch { return true; }
    for (const item of items) {
      if (++entries > WALK_ENTRIES) return false;
      const path = join(dir, item.name);
      if (item.isDirectory()) { if (!SKIPPED.has(item.name) && !await visit(path)) return false; continue; }
      if (!item.isFile() && !item.isSymbolicLink()) continue;
      try { const info = await lstat(path); files.set(relative(root, path).split(sep).join("/"), info.size + ":" + info.mtimeMs); } catch { /* gone meanwhile */ }
    }
    return true;
  };
  return await visit(root) ? files : null;
}

async function begin(workspace: string): Promise<Start | null> {
  const real = await realpath(workspace).catch(() => null);
  if (real === null) return null;
  const top = await git(real, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0) { const files = await walk(real); return files === null ? null : { mode: "files", root: real, files }; }
  const root = await realpath(top.stdout.toString("utf8").trim()).catch(() => null);
  if (root === null) return null;
  const prefix = relative(root, real).split(sep).join("/"), spec = prefix === "" ? "." : prefix;
  const head = await git(root, ["rev-parse", "--verify", "-q", "HEAD"]), status = await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", spec]);
  if (status.code !== 0) return null;
  const stage = await mkdtemp(join(tmpdir(), "harnesshub-workspace-")), dirty = new Map<string, Kept>();
  try { for (const path of new Set(statusPaths(status.stdout))) dirty.set(path, await keep(join(root, path), join(stage, "start", path))); }
  catch { await rm(stage, { recursive: true, force: true }); return null; }
  return { mode: "git", root, prefix, head: head.code === 0 ? head.stdout.toString("utf8").trim() : null, dirty, stage };
}

/** Paths relative to the repository's top become relative to the workspace (the Turn's folder may be inside the repository). */
function shown(start: GitStart, path: string): string { return start.prefix === "" ? path : path.startsWith(start.prefix + "/") ? path.slice(start.prefix.length + 1) : path; }

async function finishGit(start: GitStart): Promise<{ changes: FileChange[]; diff: string | null }> {
  const spec = start.prefix === "" ? "." : start.prefix;
  const headNow = await git(start.root, ["rev-parse", "--verify", "-q", "HEAD"]), head = headNow.code === 0 ? headNow.stdout.toString("utf8").trim() : null;
  const status = await git(start.root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", spec]);
  const candidates = new Set<string>([...start.dirty.keys(), ...statusPaths(status.stdout)]);
  // A commit made during the Turn: the files it touched are compared too (with the copy or HEAD's blob of the start, not with the commit).
  if (head !== start.head && head !== null) {
    const touched = start.head === null ? await git(start.root, ["ls-tree", "-r", "-z", "--name-only", head, "--", spec]) : await git(start.root, ["diff", "--name-only", "-z", "--no-renames", start.head, head, "--", spec]);
    for (const path of touched.stdout.toString("utf8").split("\0")) if (path) candidates.add(path);
  }
  const fromHead = await headBlobs(start.root, start.head, [...candidates].filter(path => !start.dirty.has(path)));
  const changes: FileChange[] = [], patches: string[] = [];
  for (const path of [...candidates].sort()) {
    const kept = start.dirty.get(path);
    const before: Buffer | "large" | null = kept === undefined ? fromHead.get(path) ?? null : kept.kind === "absent" ? null : kept.kind === "large" ? "large" : await readFile(kept.path).catch(() => null);
    const after = await currentBytes(join(start.root, path));
    if (before === null && after === null) continue;
    const op: FileChange["op"] = before === null ? "create" : after === null ? "delete" : "modify";
    if (before === "large" || after === "large") {
      // Too large to read: compared by its size and time (a copy of the start) or its blob hash (HEAD's), and told without a diff.
      if (op === "modify" && kept?.kind === "large") { const info = await lstat(join(start.root, path)).catch(() => null); if (info !== null && info.size === kept.size && info.mtimeMs === kept.mtimeMs) continue; }
      if (op === "modify" && kept === undefined) {
        const was = (await git(start.root, ["rev-parse", "--verify", "-q", start.head + ":" + path])).stdout.toString("utf8").trim(), now = (await git(start.root, ["hash-object", "--no-filters", "--", path])).stdout.toString("utf8").trim();
        if (was !== "" && was === now) continue;
      }
      changes.push({ path: shown(start, path), op });
      continue;
    }
    if (before !== null && after !== null && before.equals(after)) continue;
    const patch = await fileDiff(start.stage, path, before, after);
    patches.push(patch.text);
    changes.push({ path: shown(start, path), op, ...(patch.added === null ? {} : { added: patch.added }), ...(patch.removed === null ? {} : { removed: patch.removed }) });
  }
  return { changes, diff: patches.length ? patches.join("") : null };
}
async function finishFiles(start: FilesStart): Promise<{ changes: FileChange[]; diff: null } | null> {
  const now = await walk(start.root);
  if (now === null) return null;
  const changes: FileChange[] = [];
  for (const [path, was] of start.files) { const is = now.get(path); if (is === undefined) changes.push({ path, op: "delete" }); else if (is !== was) changes.push({ path, op: "modify" }); }
  for (const path of now.keys()) if (!start.files.has(path)) changes.push({ path, op: "create" });
  changes.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return { changes, diff: null };
}

/** The Runtime's WorkspaceChanges: one watch per Turn; Turns that overlap in one workspace are told they shared it. */
export class WorkspaceRecorder implements WorkspaceChanges {
  private readonly open = new Map<string, Set<{ shared: boolean }>>();
  begin(workspace: string): WorkspaceWatch {
    const mark = { shared: false }, peers = this.open.get(workspace) ?? new Set();
    if (peers.size > 0) { mark.shared = true; for (const peer of peers) peer.shared = true; }
    peers.add(mark); this.open.set(workspace, peers);
    const started = begin(workspace).catch(() => null);
    let finishing: Promise<WorkspaceRecord | null> | null = null;
    return { finish: () => finishing ??= (async () => {
      try {
        const start = await started;
        if (start === null) return null;
        try {
          const found = start.mode === "git" ? await finishGit(start) : await finishFiles(start);
          return found === null ? null : { mode: start.mode, changes: found.changes, diff: found.diff, shared: mark.shared };
        } finally { if (start.mode === "git") await rm(start.stage, { recursive: true, force: true }); }
      } catch { return null; }
      finally { peers.delete(mark); if (peers.size === 0) this.open.delete(workspace); }
    })() };
  }
}
