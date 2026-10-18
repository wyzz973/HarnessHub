import { createHash } from "node:crypto";
import { Parser, type ReadEntry } from "tar";
import { CapabilityError } from "../../contracts/capabilities.js";
import type { RemoteTreeEntry } from "./skill-tree.js";

/**
 * Reading skills from GitHub (ADR-045 §4): a repository's archive from codeload and, for update checks, its tree from the
 * REST interface without a token. Only HTTPS to GitHub's own hosts is followed; a redirect anywhere else fails. No proxy
 * is configured and no credential is read or sent.
 */

/** A repository, an optional branch, tag or commit, and an optional folder inside it. */
export interface GithubSource { readonly owner: string; readonly repo: string; readonly ref: string | null; readonly path: string | null }
/** Fetches `url` without following redirects; the platform's by default, replaced in tests. */
export type GithubFetch = (url: string, init: { readonly signal: AbortSignal; readonly redirect: "manual"; readonly headers: Readonly<Record<string, string>> }) => Promise<Response>;

export const GITHUB_HOSTS: ReadonlySet<string> = new Set(["github.com", "codeload.github.com", "api.github.com", "objects.githubusercontent.com"]);
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u, REPO = /^[A-Za-z0-9._-]{1,100}$/u, REF = /^[A-Za-z0-9._/-]{1,200}$/u, SEGMENT = /^[A-Za-z0-9._ @+-]{1,255}$/u;
/** Bounds of one archive: what it may weigh compressed and unpacked, and how many entries it may hold. */
export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024, MAX_UNPACKED_BYTES = 256 * 1024 * 1024, MAX_ARCHIVE_ENTRIES = 20000, MAX_ARCHIVE_DEPTH = 40;
const TIMEOUT_MS = 60_000;

function validRef(ref: string): boolean { return REF.test(ref) && !ref.split("/").some(part => part === "" || part === "." || part === "..") && !ref.endsWith(".lock"); }
function validPath(path: string): boolean { return path.split("/").every(part => SEGMENT.test(part) && part !== "." && part !== ".."); }
/**
 * Reads what the user typed: `owner/repo`, `owner/repo#ref`, or `https://github.com/owner/repo` optionally followed by
 * `/tree/<ref>/<folder>`. Throws INVALID_INPUT for anything else, such as another host.
 */
export function parseGithubSource(input: string): GithubSource {
  const value = input.trim();
  const fail = (): never => { throw new CapabilityError("INVALID_INPUT", "请输入 GitHub 仓库，例如 owner/repo 或 https://github.com/owner/repo"); };
  if (value.length === 0 || value.length > 512 || /[\0-\x1f\x7f\\]/u.test(value)) fail();
  // A URL parser resolves `.` and `..` away; a source that spells them is refused before it gets the chance.
  if (/(^|\/)\.\.?(\/|#|$)/u.test(value.replace(/^https?:\/\/[^/]*/iu, ""))) fail();
  let owner: string, repo: string, ref: string | null = null, path: string | null = null;
  if (/^https?:\/\//iu.test(value)) {
    let url: URL;
    try { url = new URL(value); } catch { return fail(); }
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password || url.port || url.search || url.hash) fail();
    const parts = url.pathname.split("/").filter(Boolean).map(part => decodeURIComponent(part));
    if (parts.length < 2) fail();
    owner = parts[0]!; repo = parts[1]!.replace(/\.git$/u, "");
    if (parts.length > 2) {
      if (parts[2] !== "tree" || parts.length < 4) fail();
      ref = parts[3]!; path = parts.length > 4 ? parts.slice(4).join("/") : null;
    }
  } else {
    const [main, fragment, ...extra] = value.split("#");
    if (extra.length) fail();
    const parts = main!.split("/");
    if (parts.length !== 2) fail();
    owner = parts[0]!; repo = parts[1]!.replace(/\.git$/u, "");
    if (fragment !== undefined) ref = fragment;
  }
  if (!OWNER.test(owner) || !REPO.test(repo) || repo === "." || repo === ".." || (ref !== null && !validRef(ref)) || (path !== null && !validPath(path))) fail();
  return { owner, repo, ref, path };
}
/** The source as shown and recorded: `https://github.com/owner/repo`, never with credentials. */
export function sourceUrl(source: Pick<GithubSource, "owner" | "repo">): string { return "https://github.com/" + source.owner + "/" + source.repo; }

/** Follows up to five redirects, each only over HTTPS to one of GitHub's hosts. */
async function request(start: string, fetcher: GithubFetch, signal: AbortSignal, headers: Readonly<Record<string, string>> = {}): Promise<{ readonly response: Response; readonly url: URL }> {
  let current = new URL(start);
  for (let redirects = 0; ; redirects++) {
    if (current.protocol !== "https:" || !GITHUB_HOSTS.has(current.hostname) || current.username || current.password || current.port)
      throw new CapabilityError("CAPABILITY_COMMAND_FAILED", "GitHub 把请求转到了 " + current.hostname + "，HarnessHub 不跟随");
    let response: Response;
    try { response = await fetcher(current.toString(), { signal, redirect: "manual", headers: { "User-Agent": "HarnessHub", ...headers } }); }
    catch (error) { if (signal.aborted) throw new CapabilityError("CAPABILITY_COMMAND_FAILED", "连接 GitHub 超过 60 秒"); throw new CapabilityError("CAPABILITY_COMMAND_FAILED", "连不上 GitHub（" + (error instanceof Error ? error.message : "网络错误") + "）"); }
    if (response.status < 300 || response.status >= 400) return { response, url: current };
    const next = response.headers.get("location"); await response.body?.cancel();
    if (next === null || redirects >= 4) throw new CapabilityError("CAPABILITY_COMMAND_FAILED", "GitHub 的重定向不完整或过多");
    current = new URL(next, current);
  }
}
/** Why GitHub answered with an error, in the user's terms; a rate limit says when it resets. */
async function failure(response: Response, what: string): Promise<CapabilityError> {
  await response.body?.cancel();
  const remaining = response.headers.get("x-ratelimit-remaining"), reset = Number(response.headers.get("x-ratelimit-reset"));
  if ((response.status === 403 || response.status === 429) && remaining === "0")
    return new CapabilityError("CAPABILITY_COMMAND_FAILED", "GitHub 的匿名访问额度（每小时 60 次）已用完" + (Number.isFinite(reset) && reset > 0 ? "，" + new Date(reset * 1000).toLocaleTimeString("zh-CN", { hour12: false }) + " 后恢复" : "") + "。");
  if (response.status === 404) return new CapabilityError("CAPABILITY_NOT_FOUND", "GitHub 上找不到" + what + "（仓库不存在、是私有仓库，或分支不存在）");
  return new CapabilityError("CAPABILITY_COMMAND_FAILED", "GitHub 读取" + what + "失败（HTTP " + response.status + "）");
}
async function body(response: Response, maximum: number, what: string): Promise<Buffer> {
  const announced = Number(response.headers.get("content-length"));
  if (Number.isFinite(announced) && announced > maximum) { await response.body?.cancel(); throw new CapabilityError("CAPABILITY_TARGET_REFUSED", what + "超过 " + Math.round(maximum / 1024 / 1024) + " MB"); }
  if (response.body === null) return Buffer.alloc(0);
  const reader = response.body.getReader(), chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.length;
      if (size > maximum) throw new CapabilityError("CAPABILITY_TARGET_REFUSED", what + "超过 " + Math.round(maximum / 1024 / 1024) + " MB");
      chunks.push(Buffer.from(chunk.value));
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  return Buffer.concat(chunks);
}

/**
 * The commit a branch, tag or commit names now, read from where GitHub's archive link redirects (no rate-limited call),
 * and that commit's archive, at most 64 MB.
 */
export async function downloadRepository(source: GithubSource, fetcher: GithubFetch, signal = AbortSignal.timeout(TIMEOUT_MS)): Promise<{ readonly commit: string; readonly archive: Buffer }> {
  const ref = source.ref ?? "HEAD";
  let commit: string;
  if (/^[a-f0-9]{40}$/u.test(ref)) commit = ref;
  else {
    let current = new URL("https://github.com/" + source.owner + "/" + source.repo + "/archive/" + ref.split("/").map(encodeURIComponent).join("/") + ".tar.gz"), found: string | null = null;
    // Each hop is checked like any other request; the codeload address it reaches carries the commit.
    for (let hop = 0; hop < 5 && found === null; hop++) {
      if (current.protocol !== "https:" || !GITHUB_HOSTS.has(current.hostname) || current.username || current.password || current.port) throw new CapabilityError("CAPABILITY_COMMAND_FAILED", "GitHub 把请求转到了 " + current.hostname + "，HarnessHub 不跟随");
      const match = current.hostname === "codeload.github.com" ? /^\/[^/]+\/[^/]+\/tar\.gz\/([a-f0-9]{40})$/u.exec(current.pathname) : null;
      if (match) { found = match[1]!; break; }
      let response: Response;
      try { response = await fetcher(current.toString(), { signal, redirect: "manual", headers: { "User-Agent": "HarnessHub" } }); }
      catch (error) { if (signal.aborted) throw new CapabilityError("CAPABILITY_COMMAND_FAILED", "连接 GitHub 超过 60 秒"); throw new CapabilityError("CAPABILITY_COMMAND_FAILED", "连不上 GitHub（" + (error instanceof Error ? error.message : "网络错误") + "）"); }
      const next = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
      if (next === null) throw await failure(response, " " + source.owner + "/" + source.repo + (source.ref ? "#" + source.ref : ""));
      await response.body?.cancel();
      current = new URL(next, current);
    }
    if (found === null) throw new CapabilityError("CAPABILITY_COMMAND_FAILED", "GitHub 没有给出这个版本对应的提交");
    commit = found;
  }
  const { response } = await request("https://codeload.github.com/" + source.owner + "/" + source.repo + "/tar.gz/" + commit, fetcher, signal);
  if (!response.ok) throw await failure(response, "仓库的压缩包");
  return { commit, archive: await body(response, MAX_ARCHIVE_BYTES, "仓库的压缩包") };
}

/** A repository's whole tree at `ref` (GitHub's recursive listing); `truncated` when GitHub cut it short. */
export async function repositoryTree(source: Pick<GithubSource, "owner" | "repo">, ref: string, fetcher: GithubFetch, signal = AbortSignal.timeout(TIMEOUT_MS)): Promise<{ readonly entries: readonly RemoteTreeEntry[]; readonly truncated: boolean }> {
  if (!validRef(ref)) throw new CapabilityError("INVALID_INPUT", "invalid ref");
  const { response } = await request("https://api.github.com/repos/" + source.owner + "/" + source.repo + "/git/trees/" + ref.split("/").map(encodeURIComponent).join("/") + "?recursive=1", fetcher, signal,
    { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" });
  if (!response.ok) throw await failure(response, " " + source.owner + "/" + source.repo + " 的文件列表");
  let value: unknown;
  try { value = JSON.parse((await body(response, 32 * 1024 * 1024, "文件列表")).toString("utf8")); } catch (error) { if (error instanceof CapabilityError) throw error; throw new CapabilityError("CAPABILITY_COMMAND_FAILED", "GitHub 返回的文件列表无法解析"); }
  const tree = value !== null && typeof value === "object" && Array.isArray((value as { tree?: unknown }).tree) ? (value as { tree: unknown[]; truncated?: unknown }) : null;
  if (tree === null) throw new CapabilityError("CAPABILITY_COMMAND_FAILED", "GitHub 返回的文件列表格式不对");
  const entries = tree.tree.flatMap((item): RemoteTreeEntry[] => {
    if (item === null || typeof item !== "object") return [];
    const { path, mode, type, sha } = item as Record<string, unknown>;
    return typeof path === "string" && typeof mode === "string" && typeof type === "string" && typeof sha === "string" ? [{ path, mode, type, sha }] : [];
  });
  return { entries, truncated: tree.truncated === true };
}

/** One entry of a repository archive, by its path inside the repository. */
export interface ArchiveEntry { readonly path: string; readonly type: "file" | "directory" | "symlink" | "hardlink" | "other"; readonly executable: boolean; readonly size: number;
  /** Git's blob id of a file's bytes. */ readonly id: string | null }
/** A repository archive as listed: every entry, and the text of each SKILL.md (at most 256 KiB each). */
export interface ArchiveListing { readonly entries: readonly ArchiveEntry[]; readonly skillFiles: ReadonlyMap<string, string> }

/** Checks an entry's path and returns it relative to the archive's single top folder; null for that folder itself. */
function entryPath(raw: string, root: { value: string | null }): string | null {
  const path = raw.replace(/\/+$/u, "");
  if (path.length === 0 || path.length > 4096 || path.startsWith("/") || /[\0-\x1f\x7f\\]/u.test(path)) throw new CapabilityError("CAPABILITY_TARGET_REFUSED", "压缩包里有不安全的路径");
  const segments = path.split("/");
  if (segments.some(segment => segment === "" || segment === "." || segment === ".." || Buffer.byteLength(segment) > 255) || segments.length > MAX_ARCHIVE_DEPTH)
    throw new CapabilityError("CAPABILITY_TARGET_REFUSED", "压缩包里有不安全的路径");
  root.value ??= segments[0]!;
  if (segments[0] !== root.value) throw new CapabilityError("CAPABILITY_TARGET_REFUSED", "压缩包不是一个仓库的布局");
  return segments.length === 1 ? null : segments.slice(1).join("/");
}
function kind(type: ReadEntry["type"]): ArchiveEntry["type"] {
  return type === "File" || type === "OldFile" || type === "ContiguousFile" ? "file" : type === "Directory" ? "directory" : type === "SymbolicLink" ? "symlink" : type === "Link" ? "hardlink" : "other";
}
/**
 * Reads an archive entry by entry: every regular file's blob id is computed as it streams, `select` decides which files
 * are written (`write` receives their bytes), and nothing else is kept. Throws for an unsafe path, more than 20000 entries
 * or 256 MB unpacked.
 */
async function walkArchive(archive: Buffer, visit: (entry: ArchiveEntry, data: Buffer | null) => void | Promise<void>, keep: (path: string, size: number) => boolean): Promise<void> {
  const root = { value: null as string | null }, pending: Promise<void>[] = [];
  let entries = 0, unpacked = 0, problem: unknown = null;
  await new Promise<void>((resolve, reject) => {
    const parser = new Parser({ strict: true });
    parser.on("entry", (entry: ReadEntry) => {
      if (problem !== null) { entry.resume(); return; }
      try {
        if (entry.type === "ExtendedHeader" || entry.type === "GlobalExtendedHeader" || entry.type === "NextFileHasLongPath" || entry.type === "NextFileHasLongLinkpath") { entry.resume(); return; }
        if (++entries > MAX_ARCHIVE_ENTRIES) throw new CapabilityError("CAPABILITY_TARGET_REFUSED", "压缩包的条目超过 " + MAX_ARCHIVE_ENTRIES + " 个");
        const path = entryPath(entry.path, root), type = kind(entry.type), size = entry.size ?? 0;
        if (path === null) { entry.resume(); return; }
        unpacked += type === "file" ? size : 0;
        if (unpacked > MAX_UNPACKED_BYTES) throw new CapabilityError("CAPABILITY_TARGET_REFUSED", "压缩包解开后超过 256 MB");
        if (type !== "file") { entry.resume(); pending.push(Promise.resolve(visit({ path, type, executable: false, size: 0, id: null }, null))); return; }
        const hash = createHash("sha1").update("blob " + size + "\0"), chunks: Buffer[] | null = keep(path, size) ? [] : null;
        entry.on("data", (chunk: Buffer) => { hash.update(chunk); chunks?.push(chunk); });
        entry.on("end", () => { pending.push(Promise.resolve(visit({ path, type, executable: ((entry.mode ?? 0) & 0o111) !== 0, size, id: hash.digest("hex") }, chunks === null ? null : Buffer.concat(chunks)))); });
      } catch (error) { problem ??= error; entry.resume(); }
    });
    // Strict: every warning arrives as an error, and the parser may stop there.
    parser.on("error", (error: unknown) => { problem ??= new CapabilityError("CAPABILITY_TARGET_REFUSED", "压缩包无法读取（" + (error instanceof Error ? error.message : "格式错误") + "）"); resolve(); });
    parser.on("end", () => resolve());
    parser.on("close", () => resolve());
    try { parser.end(archive); } catch (error) { reject(error); }
  });
  await Promise.all(pending);
  if (problem !== null) throw problem instanceof CapabilityError ? problem : new CapabilityError("CAPABILITY_TARGET_REFUSED", "压缩包无法读取");
  if (root.value === null) throw new CapabilityError("CAPABILITY_TARGET_REFUSED", "压缩包是空的");
}
/** Lists an archive without writing anything: entries with their blob ids, and the text of every SKILL.md. */
export async function listArchive(archive: Buffer): Promise<ArchiveListing> {
  const entries: ArchiveEntry[] = [], skillFiles = new Map<string, string>();
  await walkArchive(archive, (entry, data) => { entries.push(entry); if (data !== null) skillFiles.set(entry.path, data.toString("utf8")); },
    (path, size) => (path === "SKILL.md" || path.endsWith("/SKILL.md")) && size <= 256 * 1024);
  return { entries, skillFiles };
}
/** Reads the files of an archive inside `folder` (a path inside the repository; "" for its root) with their bytes. */
export async function readArchiveFolder(archive: Buffer, folder: string): Promise<readonly { readonly entry: ArchiveEntry; readonly data: Buffer | null }[]> {
  const prefix = folder === "" ? "" : folder + "/", found: { entry: ArchiveEntry; data: Buffer | null }[] = [];
  await walkArchive(archive, (entry, data) => { if (entry.path.startsWith(prefix)) found.push({ entry, data }); }, path => path.startsWith(prefix));
  return found;
}
