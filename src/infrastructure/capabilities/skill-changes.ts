import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, unlinkSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { HarnessReadTable, ReadEnvironment } from "../../adapters/capability-reads.js";
import { CAPABILITY_CHECK_MS, CapabilityError, SKILL_SNAPSHOT_CHANGES, type CapabilityChangeCheck, type CapabilityChangeView, type CapabilityLinkChange, type CapabilitySkillPlan,
  type SkillSourceListing, type SkillUpdateView } from "../../contracts/capabilities.js";
import { unifiedDiff } from "../control/unified-diff.js";
import { readTarget, replaceTarget } from "./files.js";
import { downloadRepository, listArchive, parseGithubSource, repositoryTree, settledCommit, sourceUrl, type GithubFetch, type GithubSource } from "./github.js";
import type { InstalledHarness } from "./scan.js";
import { editLock, findSkills, linksInto, lockSkills, readLockEntries, SkillSnapshots, skillFolderName, stagingFolder, writeSkill, writeSkillText, type FoundSkill, type LockEntry } from "./skill-packages.js";
import { canonicalSkillText, readSkillText, renderSkillText, skillTextProblem, type SkillText } from "./skill-text.js";
import { folderTree, npxExcludedPath, remoteFolderTree, treeId, type RemoteTreeEntry, type TreeItem } from "./skill-tree.js";
import { sha256, type CapabilityStore, type LedgerEntry, type SkillSource } from "./store.js";

/** What the skill changes need of the change service they belong to. */
export interface SkillHost {
  readonly environment: ReadEnvironment;
  readonly store: CapabilityStore;
  readonly snapshots: SkillSnapshots;
  readonly github: GithubFetch;
  now(): Date;
  shown(path: string): string;
  /** A diff as shown: ~ for the home directory and secrets masked. */
  display(text: string): string;
  owned(): void;
  serial<T>(key: string, work: () => Promise<T>): Promise<T>;
  tables(): Promise<{ readonly hermesHome: string; readonly tables: readonly HarnessReadTable[] }>;
  /** Whether Hermes reads the shared directory through its `skills.external_dirs`. */
  hermesReadsShared(): Promise<boolean>;
  /** Registers a prepared change under a new fingerprint and returns the check shown for it. */
  offer(check: Omit<CapabilityChangeCheck, "fingerprint" | "expiresAt">, prepared: (expires: number, check: CapabilityChangeCheck) => PreparedPackage): CapabilityChangeCheck;
}
export type PackageChange = "skill-add" | "skill-update" | "skill-delete" | "skill-undo" | "skill-create" | "skill-edit";
/** What a replaced folder becomes: a repository version, a snapshot put back, or a SKILL.md the user wrote in HarnessHub. */
type Replacement = { readonly kind: "archive"; readonly skill: FoundSkill; readonly archive: Buffer } | { readonly kind: "snapshot"; readonly id: string } | { readonly kind: "text"; readonly text: string };
interface PlannedLink { readonly path: string; readonly target: string; readonly action: "create" | "remove"; readonly owner: "harnesshub" | "other"; readonly harnessId: string | null }
interface PlannedLock { readonly file: string; readonly before: Buffer; readonly after: string; readonly mode: number; readonly name: string;
  readonly entryBefore: Readonly<Record<string, unknown>> | null; readonly entryAfter: Readonly<Record<string, unknown>> | null }
/** Every step of one confirmed change of skill folders, checked again before the first is taken. */
export interface PackageSteps {
  readonly shared: string;
  readonly subject: string;
  /** New folders: from a repository version, or holding only a SKILL.md the user wrote (`text`). */
  readonly adds: readonly ({ readonly name: string; readonly folder: string; readonly skill: FoundSkill; readonly archive: Buffer } | { readonly name: string; readonly folder: string; readonly text: string })[];
  readonly replaces: readonly { readonly name: string; readonly folder: string; readonly expected: string; readonly by: Replacement }[];
  readonly removes: readonly { readonly name: string; readonly folder: string; readonly expected: string }[];
  readonly restores: readonly { readonly name: string; readonly folder: string; readonly snapshot: string }[];
  readonly links: readonly PlannedLink[];
  readonly lock: PlannedLock | null;
  /** The source records before and after; `after.changeId` is filled in when applied. */
  readonly sources: readonly { readonly name: string; readonly before: SkillSource | null; readonly after: SkillSource | null }[];
}
export interface PreparedPackage { readonly kind: "package"; readonly change: PackageChange; readonly expires: number; readonly steps: PackageSteps; readonly check: CapabilityChangeCheck }
/** What undoing a change of skill folders needs, kept beside its record. */
interface UndoRecord {
  readonly skills: readonly { readonly name: string; readonly folder: string; readonly before: string | null; readonly after: string | null; readonly snapshot: string | null }[];
  readonly links: readonly PlannedLink[];
  readonly lock: { readonly file: string; readonly name: string; readonly before: Readonly<Record<string, unknown>> | null; readonly after: Readonly<Record<string, unknown>> | null } | null;
  readonly sources: readonly { readonly name: string; readonly before: SkillSource | null; readonly after: SkillSource | null }[];
}
/** A skill whose source HarnessHub knows: installed by HarnessHub, or by `npx skills` from GitHub. */
interface Tracked {
  readonly name: string; readonly folder: string; readonly manager: "harnesshub" | "skills-cli"; readonly owner: string; readonly repo: string; readonly ref: string | null;
  /** Its folder inside the repository. */ readonly path: string;
  /** The repository's tree id of the folder when it was installed or last updated. */ readonly recorded: string;
  readonly source: SkillSource | null; readonly lock: LockEntry | null;
}
interface Listing { readonly id: string; readonly source: GithubSource; readonly commit: string; readonly archive: Buffer; readonly skills: readonly FoundSkill[]; readonly expires: number }

const SCOPE = "只改共享目录 ~/.agents/skills 和下面列出的链接与 lock 条目，不改任何 Harness 的模型或登录配置。";
const EXCLUSIONS = "metadata.json、.git、__pycache__、__pypackages__ 不会复制，与 npx skills 一致。";
const LISTING = /^[a-f0-9]{32}$/u, MAX_LISTINGS = 4, MAX_SHOWN_CHANGES = 200, UPDATES_MS = 10 * 60 * 1000;
function hash(value: string): string { return sha256(value); }
function folderOf(skillPath: string): string { return skillPath.replace(/\\/gu, "/").replace(/(^|\/)SKILL\.md$/iu, "").replace(/\/+$/u, ""); }
function realDirectory(path: string): boolean { try { const info = lstatSync(path); return info.isDirectory() && !info.isSymbolicLink(); } catch { return false; } }
function present(path: string): boolean { try { lstatSync(path); return true; } catch { return false; } }
function code(error: unknown): string { return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : ""; }
/** The files a new copy adds, changes and removes against the folder as it is. */
function fileChanges(current: readonly TreeItem[], next: readonly TreeItem[]): CapabilitySkillPlan["changes"] {
  const before = new Map(current.map(item => [item.path, item.mode + item.id])), after = new Map(next.map(item => [item.path, item.mode + item.id]));
  const changes: { path: string; action: "add" | "change" | "remove" }[] = [];
  for (const [path, value] of after) if (!before.has(path)) changes.push({ path, action: "add" }); else if (before.get(path) !== value) changes.push({ path, action: "change" });
  for (const path of before.keys()) if (!after.has(path)) changes.push({ path, action: "remove" });
  return changes.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}
/** The copy's items of a folder in a repository tree, as `npx skills` would copy them. */
function remoteItems(entries: readonly RemoteTreeEntry[], folder: string): readonly TreeItem[] {
  const prefix = folder === "" ? "" : folder + "/";
  return entries.flatMap((entry): TreeItem[] => {
    if (entry.type !== "blob" || !entry.path.startsWith(prefix)) return [];
    const path = entry.path.slice(prefix.length), mode = entry.mode === "100755" ? "100755" : entry.mode === "120000" ? "120000" : entry.mode === "100644" ? "100644" : null;
    return mode === null || npxExcludedPath(path) ? [] : [{ path, mode, id: entry.sha }];
  });
}
/** A folder's tree id in a repository listing: its own entry, or the root computed from every file. */
function upstreamOf(entries: readonly RemoteTreeEntry[], folder: string): string | null {
  if (folder === "") return remoteFolderTree(entries, "", () => false);
  return entries.find(entry => entry.type === "tree" && entry.path === folder)?.sha ?? null;
}

/**
 * Adding skills to the shared `~/.agents/skills` from GitHub, updating one from its source, deleting one, and undoing those
 * (ADR-045 §4, approval of 2026-10-18). Each is checked and shown first; applied once on confirmation while everything it
 * touches is as shown; folders that go away are kept as snapshots first; a step that fails rolls back the earlier ones.
 * The `npx skills` lock is changed only for entries already in it.
 */
export class SkillChanges {
  private readonly listings = new Map<string, Listing>();
  private updates: { readonly at: number; readonly view: SkillUpdateView } | null = null;
  constructor(private readonly host: SkillHost) {}

  private shared(): string { return join(this.host.environment.home, ".agents", "skills"); }
  private sharedReal(): string {
    const shared = this.shared();
    if (!realDirectory(shared) && !existsSync(shared)) throw new CapabilityError("CAPABILITY_NOT_FOUND", "共享目录 ~/.agents/skills 不存在");
    try { return realpathSync(shared); } catch { throw new CapabilityError("CAPABILITY_NOT_FOUND", "共享目录 ~/.agents/skills 无法读取"); }
  }
  /** Every skill whose source is known, and those whose source HarnessHub does not update. */
  private async tracked(): Promise<{ readonly list: readonly Tracked[]; readonly unsupported: readonly { readonly name: string; readonly reason: string }[] }> {
    const shared = this.shared(), list: Tracked[] = [], unsupported: { name: string; reason: string }[] = [], seen = new Set<string>();
    for (const source of this.host.store.skillSources()) {
      if (source.kind === "local") { if (realDirectory(source.folder)) { seen.add(source.name); unsupported.push({ name: source.name, reason: "HarnessHub 新建的技能，没有上游；要改它请用“编辑”" }); } continue; }
      const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)$/u.exec(source.repository);
      if (!match || !realDirectory(source.folder)) continue;
      seen.add(source.name);
      list.push({ name: source.name, folder: source.folder, manager: "harnesshub", owner: match[1]!, repo: match[2]!, ref: source.ref, path: source.path, recorded: source.upstreamTree, source, lock: null });
    }
    for (const entry of (await readLockEntries(this.host.environment)).values()) {
      const name = skillFolderName(entry.name) ?? entry.name, folder = join(shared, name);
      if (seen.has(name) || !realDirectory(folder)) continue;
      seen.add(name);
      const type = typeof entry.value.sourceType === "string" ? entry.value.sourceType : "未知", ownerRepo = typeof entry.value.source === "string" ? entry.value.source : "";
      const hashValue = entry.value.skillFolderHash, skillPath = typeof entry.value.skillPath === "string" ? entry.value.skillPath : "SKILL.md", ref = typeof entry.value.ref === "string" && entry.value.ref ? entry.value.ref : null;
      const parsed = type === "github" ? (() => { try { return parseGithubSource(ownerRepo + (ref ? "#" + ref : "")); } catch { return null; } })() : null;
      if (type !== "github") { unsupported.push({ name, reason: "来源类型是 " + type + "，HarnessHub 只更新 GitHub 来源" }); continue; }
      if (parsed === null || typeof hashValue !== "string" || !/^[a-f0-9]{40}$/u.test(hashValue)) { unsupported.push({ name, reason: "lock 里的来源记录不完整" }); continue; }
      list.push({ name, folder, manager: "skills-cli", owner: parsed.owner, repo: parsed.repo, ref, path: folderOf(skillPath), recorded: hashValue, source: null, lock: entry });
    }
    return { list: list.sort((left, right) => left.name.localeCompare(right.name)), unsupported };
  }
  /** The switch settings HarnessHub wrote for a skill name, in every Harness. */
  private switchEntries(name: string, folder: string): readonly LedgerEntry[] {
    return this.host.store.ledgerEntries().filter(entry => ["skillOverrides/", "skills.disabled/", "permission.skill/", "skills.entries/"].some(prefix => entry.key === prefix + name)
      || (entry.key.startsWith("skills.config/") && (entry.key.slice("skills.config/".length) === join(folder, "SKILL.md"))));
  }

  /**
   * Downloads one GitHub repository version and lists its skills for adding: each new, already installed from this source,
   * in conflict with another folder of the same name, or refused with the reason. Nothing is written.
   */
  async listSource(input: string): Promise<SkillSourceListing> {
    const source = parseGithubSource(input), download = await downloadRepository(source, this.host.github), archive = download.archive, listed = await listArchive(archive);
    const commit = settledCommit(download.commit, listed.commit), skills = findSkills(listed, source.path);
    const shared = this.shared(), tracked = (await this.tracked()).list, now = this.host.now().getTime();
    for (const [key, listing] of this.listings) if (listing.expires < now) this.listings.delete(key);
    while (this.listings.size >= MAX_LISTINGS) this.listings.delete(this.listings.keys().next().value!);
    const id = randomBytes(16).toString("hex"), expires = now + CAPABILITY_CHECK_MS;
    this.listings.set(id, { id, source, commit, archive, skills, expires });
    return { id, repository: sourceUrl(source), ref: source.ref, commit, expiresAt: new Date(expires).toISOString(), skills: skills.map(skill => {
      const state = this.state(skill, source, shared, tracked);
      return { name: skill.name, installName: skill.installName, description: skill.description, folder: skill.folder, files: skill.files, bytes: skill.bytes, executables: skill.executables, plugin: skill.plugin, ...state };
    }) };
  }
  private state(skill: FoundSkill, source: GithubSource, shared: string, tracked: readonly Tracked[]): { state: SkillSourceListing["skills"][number]["state"]; reason: string | null } {
    if (skill.refused !== null || skill.installName === null) return { state: "refused", reason: skill.refused ?? "没有可用的文件夹名" };
    if (!present(join(shared, skill.installName))) return { state: "new", reason: null };
    const same = tracked.find(item => item.name === skill.installName && item.owner.toLowerCase() === source.owner.toLowerCase() && item.repo.toLowerCase() === source.repo.toLowerCase() && item.path === skill.folder);
    return same ? { state: "installed", reason: "已从这个仓库安装" + (same.manager === "skills-cli" ? "（npx skills）" : "") + "，请用“更新”" }
      : { state: "conflict", reason: "共享目录里已有同名的 " + skill.installName + "，来源不同；HarnessHub 不覆盖也不改名" };
  }
  /** Prepares adding the named skills (by their folder names) of a listing to the shared directory. */
  async checkAdd(listingId: string, names: readonly string[], installed: readonly InstalledHarness[]): Promise<CapabilityChangeCheck> {
    const listing = LISTING.test(listingId) ? this.listings.get(listingId) : undefined;
    if (listing === undefined || listing.expires < this.host.now().getTime()) throw new CapabilityError("CAPABILITY_CHECK_EXPIRED", "仓库的读取已过期，请重新读取");
    if (!names.length || names.length > 64 || new Set(names).size !== names.length) throw new CapabilityError("INVALID_INPUT", "请选择要添加的技能");
    const shared = this.shared(), tracked = (await this.tracked()).list, adds: { readonly name: string; readonly folder: string; readonly skill: FoundSkill; readonly archive: Buffer }[] = [], plans: CapabilitySkillPlan[] = [];
    let blocked: string | null = null;
    const notes = [SCOPE, EXCLUSIONS];
    for (const name of names) {
      const skill = listing.skills.find(item => item.installName === name);
      if (skill === undefined) throw new CapabilityError("CAPABILITY_NOT_FOUND", "这个仓库里没有 " + name);
      const state = this.state(skill, listing.source, shared, tracked);
      if (state.state !== "new") { blocked ??= name + "：" + state.reason; continue; }
      const folder = join(shared, name);
      adds.push({ name, folder, skill, archive: listing.archive });
      plans.push({ name, folder: this.host.shown(folder), action: "add", files: skill.files, bytes: skill.bytes, executables: skill.executables, plugin: skill.plugin, changes: [], overwrites: 0 });
      if (skill.executables) notes.push(name + " 含 " + skill.executables + " 个可执行文件；Harness 可能运行它们。");
      if (skill.plugin) notes.push(name + " 的文件夹里带有插件清单 .claude-plugin/plugin.json。");
      if (skill.name !== name) notes.push(name + "：技能名是 " + skill.name + "，文件夹名按 npx skills 的规则写作 " + name + "；要求两者一致的 Harness 会拒绝它。");
      const disabled = this.switchEntries(name, folder);
      if (disabled.length) notes.push("HarnessHub 之前在 " + [...new Set(disabled.map(entry => entry.harnessId))].join("、") + " 里停用过同名技能，添加后在那里仍是停用。");
    }
    notes.push(...await this.readers(installed));
    const steps: PackageSteps = { shared, subject: names.join("、"), adds, replaces: [], removes: [], restores: [], links: [], lock: null,
      sources: adds.map(item => ({ name: item.name, before: null, after: { name: item.name, folder: item.folder, repository: sourceUrl(listing.source), ref: listing.source.ref, path: item.skill.folder, commit: listing.commit,
        upstreamTree: item.skill.upstreamTree!, localTree: item.skill.copyTree!, installedAt: "", updatedAt: "", changeId: "", kind: "github" } })) };
    return this.offer("skill-add", steps, plans, { repository: sourceUrl(listing.source), ref: listing.source.ref, commit: listing.commit }, null, [], "none", notes, blocked);
  }
  /** Who sees a skill once it is in the shared directory, among the installed Harnesses, by their read tables. */
  private async readers(installed: readonly InstalledHarness[]): Promise<readonly string[]> {
    const ids = new Set(installed.map(item => item.harnessId)), name = (id: string) => installed.find(item => item.harnessId === id)?.name ?? id, { tables } = await this.host.tables();
    const native = tables.filter(table => ids.has(table.harnessId) && table.skills.roots.some(root => root.role === "shared")).map(table => name(table.harnessId)), notes: string[] = [];
    if (native.length) notes.push(native.join("、") + " 直接读取共享目录，添加后就能看到。");
    if (ids.has("claude")) notes.push("Claude Code 不读共享目录：添加后可以在技能详情里“放到 Claude Code”。");
    if (ids.has("hermes")) notes.push(await this.host.hermesReadsShared() ? "Hermes 经 skills.external_dirs 读取共享目录；正在运行的 Hermes 网关重启后才看到。" : "Hermes 还没有读取共享目录（见“共享技能目录”卡片）。");
    return notes;
  }

  /**
   * Whether each skill with a known source has a newer version: one GitHub tree listing per repository and ref, kept for
   * ten minutes unless `refresh`. Nothing is written.
   */
  async checkUpdates(refresh: boolean): Promise<SkillUpdateView> {
    const now = this.host.now();
    if (!refresh && this.updates !== null && now.getTime() - this.updates.at < UPDATES_MS) return this.updates.view;
    const { list, unsupported } = await this.tracked(), groups = new Map<string, Tracked[]>();
    for (const item of list) { const key = item.owner + "/" + item.repo + "#" + (item.ref ?? "HEAD"); groups.set(key, [...(groups.get(key) ?? []), item]); }
    const skills: SkillUpdateView["skills"][number][] = [];
    for (const items of groups.values()) {
      const first = items[0]!;
      let entries: readonly RemoteTreeEntry[] | null = null, reason: string | null = null;
      try { const tree = await repositoryTree(first, first.ref ?? "HEAD", this.host.github); if (tree.truncated) reason = "仓库太大，GitHub 的列表不完整"; else entries = tree.entries; }
      catch (error) { reason = error instanceof Error ? error.message : "无法读取"; }
      for (const item of items) {
        const repository = sourceUrl(item);
        if (entries === null) { skills.push({ name: item.name, manager: item.manager, repository, state: "unknown", modified: null, reason }); continue; }
        const upstream = upstreamOf(entries, item.path), local = await folderTree(item.folder).catch(() => null);
        if (upstream === null) { skills.push({ name: item.name, manager: item.manager, repository, state: "gone", modified: null, reason: "仓库里已没有 " + (item.path || "根目录") + " 这个文件夹" }); continue; }
        const current = upstream === item.recorded;
        // HarnessHub knows what it wrote; for npx skills the copy is compared with the recorded version, known here only while it is current.
        const modified = local === null ? null : item.manager === "harnesshub" ? local.id !== item.source!.localTree : current ? local.id !== treeId(remoteItems(entries, item.path)) : null;
        skills.push({ name: item.name, manager: item.manager, repository, state: current ? "current" : "available", modified, reason: null });
      }
    }
    for (const item of unsupported) skills.push({ name: item.name, manager: "skills-cli", repository: null, state: "unsupported", modified: null, reason: item.reason });
    const view: SkillUpdateView = { checkedAt: now.toISOString(), skills: skills.sort((left, right) => left.name.localeCompare(right.name)) };
    this.updates = { at: now.getTime(), view };
    return view;
  }
  /**
   * Prepares updating one skill to its source's newest version: the files it adds, changes and removes, and the lock entry
   * it changes for `npx skills`. A folder changed locally is refused unless `overwrite`, which lists how many files of the
   * user's it replaces; the old folder is kept as a snapshot.
   */
  async checkUpdate(name: string, overwrite: boolean): Promise<CapabilityChangeCheck> {
    const item = (await this.tracked()).list.find(entry => entry.name === name);
    if (item === undefined) throw new CapabilityError("CAPABILITY_NOT_FOUND", "HarnessHub 不知道 " + name + " 的来源，无法更新");
    const local = await folderTree(item.folder), tree = await repositoryTree(item, item.ref ?? "HEAD", this.host.github);
    if (tree.truncated) throw new CapabilityError("CAPABILITY_COMMAND_FAILED", "仓库太大，GitHub 的列表不完整，无法检查");
    const upstream = upstreamOf(tree.entries, item.path);
    const notes = [SCOPE, EXCLUSIONS];
    const none = (reason: string): CapabilityChangeCheck => this.offer("skill-update", { shared: this.shared(), subject: name, adds: [], replaces: [], removes: [], restores: [], links: [], lock: null, sources: [] },
      [], null, null, [], item.manager === "harnesshub" ? "harnesshub" : "other", notes, reason);
    if (upstream === null) return none("仓库里已没有 " + (item.path || "根目录") + " 这个文件夹，无法更新。");
    if (upstream === item.recorded) return none("无需更新：已是仓库里的最新版本。");
    // What the user changed: the folder against the recorded version, as a copy holds it.
    const recorded = await repositoryTree(item, item.recorded, this.host.github).then(old => remoteItems(old.entries, ""), () => null);
    const overwritten = recorded === null ? null : fileChanges(recorded, local.items).length;
    const modified = item.manager === "harnesshub" ? local.id !== item.source!.localTree : recorded === null ? null : treeId(recorded) !== local.id;
    const download = await downloadRepository({ owner: item.owner, repo: item.repo, ref: item.ref, path: null }, this.host.github), archive = download.archive, listing = await listArchive(archive);
    const commit = settledCommit(download.commit, listing.commit);
    const skill = findSkills(listing, item.path).find(found => found.folder === item.path);
    let blocked: string | null = null;
    if (skill === undefined) blocked = "下载的版本里没有这个技能（仓库在两次读取之间变了），请重新检查。";
    else if (skill.upstreamTree !== upstream) blocked = "仓库在两次读取之间变了，请重新检查。";
    else if (skill.refused !== null) blocked = "新版本不能安装：" + skill.refused + "。";
    else if (modified !== false && !overwrite) blocked = modified === null ? "无法确认这个技能在本地有没有改过；要更新，请选择“覆盖本地改动并更新”。"
      : "这个技能在本地改过（" + (overwritten ?? "若干") + " 个文件与安装时不同）；要更新，请选择“覆盖本地改动并更新”，旧版本会留快照，可以撤销。";
    const next = skill === undefined ? [] : listing.entries.filter(entry => entry.type === "file" && entry.path.startsWith(item.path === "" ? "" : item.path + "/"))
      .map(entry => ({ path: item.path === "" ? entry.path : entry.path.slice(item.path.length + 1), mode: entry.executable ? "100755" as const : "100644" as const, id: entry.id! })).filter(entry => !npxExcludedPath(entry.path));
    const changes = fileChanges(local.items, next);
    if (modified) notes.push("会覆盖你在本地的改动（" + (overwritten ?? "若干") + " 个文件）；旧版本留有快照，可以撤销。");
    if (skill?.executables) notes.push("新版本含 " + skill.executables + " 个可执行文件；Harness 可能运行它们。");
    if (skill?.plugin) notes.push("新版本的文件夹里带有插件清单 .claude-plugin/plugin.json。");
    notes.push("替换的一瞬间这个技能的文件夹会短暂缺失，正在监视技能目录的 Harness 可能看到它消失又出现。");
    let lock: PlannedLock | null = null, lockDiff: { file: string; diff: string } | null = null;
    if (blocked === null && item.lock !== null) {
      const read = readTarget(item.lock.file), updatedAt = this.host.now().toISOString();
      if (read.state !== "ok") blocked = "无法读取 lock 文件 " + this.host.shown(item.lock.file) + "。";
      else {
        try {
          const before = read.bytes.toString("utf8"), after = editLock(before, item.lock.name, { kind: "update", skillFolderHash: upstream, updatedAt });
          lock = { file: item.lock.file, before: read.bytes, after, mode: read.mode, name: item.lock.name, entryBefore: item.lock.value, entryAfter: { ...item.lock.value, skillFolderHash: upstream, updatedAt } };
          lockDiff = { file: this.host.shown(item.lock.file), diff: this.host.display(unifiedDiff(this.host.shown(item.lock.file), before, after, 2)) };
        } catch (error) { blocked = "无法修改 lock：" + (error instanceof Error ? error.message : "未知原因") + "。"; }
      }
    }
    const steps: PackageSteps = { shared: this.shared(), subject: name, adds: [], removes: [], restores: [], links: [], lock,
      replaces: skill === undefined ? [] : [{ name, folder: item.folder, expected: local.id!, by: { kind: "archive", skill, archive } }],
      sources: item.source === null || skill === undefined ? [] : [{ name, before: item.source, after: { ...item.source, commit, upstreamTree: upstream, localTree: skill.copyTree!, updatedAt: "" } }] };
    const plans: CapabilitySkillPlan[] = skill === undefined ? [] : [{ name, folder: this.host.shown(item.folder), action: "update", files: skill.files, bytes: skill.bytes, executables: skill.executables, plugin: skill.plugin,
      changes: changes.slice(0, MAX_SHOWN_CHANGES), overwrites: modified ? overwritten ?? 0 : 0 }];
    return this.offer("skill-update", steps, plans, { repository: sourceUrl(item), ref: item.ref, commit }, lockDiff, [], item.manager === "harnesshub" ? "harnesshub" : "other", notes, blocked);
  }
  /**
   * Prepares writing a new skill from the user's texts (commands become shared skills, ADR-045 step 5): a folder
   * `~/.agents/skills/<name>` holding only its SKILL.md, recorded as HarnessHub's own (no `.skill-lock.json` entry). A
   * name taken by any folder there, compared without case as the file system does, is refused; one a Harness's built-in
   * command or bundled skill has is warned about.
   */
  async checkCreate(name: string, input: SkillText, homes: readonly string[], installed: readonly InstalledHarness[]): Promise<CapabilityChangeCheck> {
    const problem = skillTextProblem(name, input, homes);
    if (problem !== null) throw new CapabilityError("INVALID_INPUT", problem);
    const shared = this.shared(), real = this.sharedReal(), folder = join(shared, name), text = renderSkillText(name, input), { tables } = await this.host.tables();
    const taken = readdirSync(real).find(entry => entry.toLowerCase() === name);
    const notes = [SCOPE, "会新建 " + this.host.shown(join(folder, "SKILL.md")) + "（文件夹 0755、文件 0644），来源记为 HarnessHub 新建，不写 npx skills 的 lock。",
      "参数占位符各家不同：Claude Code 的 $0 是第一个参数，OpenCode、Cursor 的 $1 才是；Codex 的技能没有参数。没有占位符时，各家都把调用时跟的文字交给模型。"];
    for (const table of tables) if (installed.some(item => item.harnessId === table.harnessId) && table.builtinCommands?.includes(name))
      notes.push((installed.find(item => item.harnessId === table.harnessId)?.name ?? table.harnessId) + " 有同名的内置命令或捆绑技能 /" + name + "，这个技能会与它争用。");
    notes.push(...await this.readers(installed));
    notes.push("Claude Code 只读 ~/.claude/skills：建好后可以在技能详情里“放到 Claude Code”。");
    const steps: PackageSteps = { shared, subject: name, adds: taken === undefined ? [{ name, folder, text }] : [], replaces: [], removes: [], restores: [], links: [], lock: null,
      sources: [{ name, before: null, after: { name, folder, repository: "", ref: null, path: "", commit: "", upstreamTree: "", localTree: "", installedAt: "", updatedAt: "", changeId: "", kind: "local" } }] };
    const plans: CapabilitySkillPlan[] = [{ name, folder: this.host.shown(folder), action: "add", files: 1, bytes: Buffer.byteLength(text, "utf8"), executables: 0, plugin: false, changes: [{ path: "SKILL.md", action: "add" }], overwrites: 0 }];
    return this.offer("skill-create", steps, plans, null, null, [], "none", notes, taken === undefined ? null : "共享目录里已有 " + taken + "（不分大小写），换一个名字。",
      this.host.display(unifiedDiff(this.host.shown(join(folder, "SKILL.md")), null, text, 2)));
  }
  /**
   * Prepares changing a skill HarnessHub wrote from text: its folder replaced by one holding the new SKILL.md (a snapshot
   * kept to undo with). A folder someone changed since HarnessHub wrote it is replaced only with `overwrite`.
   */
  async checkEdit(name: string, input: SkillText, homes: readonly string[], overwrite: boolean): Promise<CapabilityChangeCheck> {
    const problem = skillTextProblem(name, input, homes);
    if (problem !== null) throw new CapabilityError("INVALID_INPUT", problem);
    const source = this.host.store.skillSource(name);
    if (source === null || source.kind !== "local" || !realDirectory(source.folder)) throw new CapabilityError("CAPABILITY_NOT_FOUND", name + " 不是 HarnessHub 新建的技能");
    const local = await folderTree(source.folder), skillFile = join(source.folder, "SKILL.md"), before = (() => { try { return readFileSync(skillFile, "utf8"); } catch { return ""; } })(), text = renderSkillText(name, input);
    const modified = local.id !== source.localTree, changes = fileChanges(local.items, [{ path: "SKILL.md", mode: "100644", id: "" }]).filter(change => change.path !== "SKILL.md" || before !== text);
    const notes = [SCOPE, "替换的一瞬间这个技能的文件夹会短暂缺失，正在监视技能目录的 Harness 可能看到它消失又出现。"];
    let blocked: string | null = null;
    if (before === text && !modified) blocked = "无需修改：SKILL.md 已是这些内容。";
    else if (modified && !overwrite) blocked = "这个技能在 HarnessHub 写入之后被改过；要改写，请选择“覆盖本地改动并改写”，旧版本会留快照，可以撤销。";
    if (modified) notes.push("会覆盖本地的改动，文件夹里只留下新的 SKILL.md；旧版本留有快照，可以撤销。");
    const steps: PackageSteps = { shared: this.shared(), subject: name, adds: [], removes: [], restores: [], links: [], lock: null,
      replaces: [{ name, folder: source.folder, expected: local.id!, by: { kind: "text", text } }], sources: [{ name, before: source, after: { ...source, upstreamTree: "", localTree: "", updatedAt: "" } }] };
    const plans: CapabilitySkillPlan[] = [{ name, folder: this.host.shown(source.folder), action: "update", files: 1, bytes: Buffer.byteLength(text, "utf8"), executables: 0, plugin: false, changes, overwrites: modified ? changes.length : 0 }];
    const check = this.offer("skill-edit", steps, plans, null, null, [], "harnesshub", notes, blocked, this.host.display(unifiedDiff(this.host.shown(skillFile), before, text, 2)));
    // Only the user's say-so is missing when the folder was changed since: the page asks again with overwrite.
    return modified && !overwrite ? { ...check, proceed: { option: "overwrite", label: "覆盖本地改动并改写" } } : check;
  }
  /** The texts of a skill HarnessHub wrote, read from its SKILL.md as it is now, for editing; null when that does not read as one. */
  localText(name: string): (SkillText & { readonly modified: boolean }) | null {
    const source = this.host.store.skillSource(name);
    if (source === null || source.kind !== "local") throw new CapabilityError("CAPABILITY_NOT_FOUND", name + " 不是 HarnessHub 新建的技能");
    let content: string; try { content = readFileSync(join(source.folder, "SKILL.md"), "utf8"); } catch { return null; }
    const read = readSkillText(content);
    return read === null ? null : { ...canonicalSkillText(read), modified: false };
  }
  /**
   * Prepares deleting one skill folder of the shared directory: kept as a snapshot first, then the links that lead into it
   * (HarnessHub's and other tools') removed, the folder removed, its lock entry and HarnessHub's record of it dropped. The
   * switch settings HarnessHub wrote for it stay and are listed.
   */
  async checkDelete(name: string): Promise<CapabilityChangeCheck> {
    if (skillFolderName(name) !== name) throw new CapabilityError("INVALID_INPUT", "invalid skill folder name");
    const shared = this.shared(), folder = join(shared, name);
    if (!realDirectory(folder)) throw new CapabilityError("CAPABILITY_NOT_FOUND", "共享目录里没有 " + name + " 这个文件夹" + (present(folder) ? "（它是链接，不是文件夹）" : ""));
    const local = await folderTree(folder), { tables } = await this.host.tables(), real = realpathSync(folder);
    const ledgerLinks = new Map(this.host.store.ledgerEntries().filter(entry => entry.key.startsWith("link/")).map(entry => [entry.file, entry.harnessId]));
    const links: PlannedLink[] = linksInto(real, tables, this.sharedReal()).map(link => ({ path: link.path, target: link.target, action: "remove", owner: ledgerLinks.has(link.path) ? "harnesshub" : "other", harnessId: ledgerLinks.get(link.path) ?? null }));
    const locks = await readLockEntries(this.host.environment), lockEntry = locks.get(name) ?? [...locks.values()].find(entry => skillFolderName(entry.name) === name) ?? null;
    let lock: PlannedLock | null = null, lockDiff: { file: string; diff: string } | null = null, blocked: string | null = null;
    const notes = [SCOPE, "会先把这个文件夹存为快照，可以在“修改与备份”里撤销（只保留最近 " + SKILL_SNAPSHOT_CHANGES + " 次修改的快照）。"];
    if (lockEntry !== null) {
      const read = readTarget(lockEntry.file);
      if (read.state !== "ok") blocked = "无法读取 lock 文件 " + this.host.shown(lockEntry.file) + "。";
      else {
        const writable = lockSkills(read.bytes.toString("utf8")).writable;
        if (writable !== null) notes.push("lock 里的条目不改：" + writable + "。");
        else {
          try {
            const after = editLock(read.bytes.toString("utf8"), lockEntry.name, { kind: "remove" });
            lock = { file: lockEntry.file, before: read.bytes, after, mode: read.mode, name: lockEntry.name, entryBefore: lockEntry.value, entryAfter: null };
            lockDiff = { file: this.host.shown(lockEntry.file), diff: this.host.display(unifiedDiff(this.host.shown(lockEntry.file), read.bytes.toString("utf8"), after, 2)) };
          } catch (error) { blocked = "无法修改 lock：" + (error instanceof Error ? error.message : "未知原因") + "。"; }
        }
      }
    }
    if (links.some(link => link.owner === "other")) notes.push("其他工具（多为 npx skills）建的 " + links.filter(link => link.owner === "other").length + " 个链接也会删除：文件夹删除后它们就成了断链。");
    const orphans = this.switchEntries(name, folder).map(entry => ({ harnessId: entry.harnessId, file: this.host.shown(entry.file) }));
    if (orphans.length) notes.push("HarnessHub 在 " + [...new Set(orphans.map(item => item.harnessId))].join("、") + " 里为它写的停用设置留在原处：技能删除后不再起作用，以后添加同名技能时仍会生效；可以在“修改与备份”里单独清除。");
    const source = this.host.store.skillSource(name);
    const steps: PackageSteps = { shared, subject: name, adds: [], replaces: [], restores: [], removes: [{ name, folder, expected: local.id! }], links, lock, sources: source === null ? [] : [{ name, before: source, after: null }] };
    const plans: CapabilitySkillPlan[] = [{ name, folder: this.host.shown(folder), action: "delete", files: local.files, bytes: local.bytes, executables: local.executables, plugin: present(join(folder, ".claude-plugin", "plugin.json")), changes: [], overwrites: 0 }];
    return this.offer("skill-delete", steps, plans, null, lockDiff, orphans, source !== null ? "harnesshub" : lockEntry !== null ? "other" : "none", notes, blocked);
  }
  /** Prepares undoing a change of skill folders, each step only while what it changed is still as it left it. */
  async checkUndo(change: CapabilityChangeView): Promise<CapabilityChangeCheck> {
    const record = this.host.store.skillUndo(change.id) as UndoRecord | null;
    if (record === null || change.status !== "applied") throw new CapabilityError("CAPABILITY_NOT_FOUND", "没有可以撤销的技能改动（只保留最近 " + SKILL_SNAPSHOT_CHANGES + " 次修改的撤销记录）");
    const shared = this.shared(), replaces: PackageSteps["replaces"][number][] = [], removes: PackageSteps["removes"][number][] = [], restores: PackageSteps["restores"][number][] = [], plans: CapabilitySkillPlan[] = [];
    let blocked: string | null = null;
    for (const item of record.skills) {
      const now = realDirectory(item.folder) ? await folderTree(item.folder).catch(() => null) : null;
      if (item.after !== null && now?.id !== item.after) { blocked ??= item.name + " 在那次修改之后又被改过，没有撤销。"; continue; }
      if (item.after === null && present(item.folder)) { blocked ??= this.host.shown(item.folder) + " 已被占用，没有撤销。"; continue; }
      if (item.before !== null && (item.snapshot === null || !(await this.host.snapshots.has(item.snapshot)))) { blocked ??= item.name + " 的快照已清理，无法撤销。"; continue; }
      if (item.before === null) removes.push({ name: item.name, folder: item.folder, expected: item.after! });
      else if (item.after === null) restores.push({ name: item.name, folder: item.folder, snapshot: item.snapshot! });
      else replaces.push({ name: item.name, folder: item.folder, expected: item.after, by: { kind: "snapshot", id: item.snapshot! } });
      plans.push({ name: item.name, folder: this.host.shown(item.folder), action: item.before === null ? "delete" : "restore", files: now?.files ?? 0, bytes: now?.bytes ?? 0, executables: now?.executables ?? 0, plugin: false, changes: [], overwrites: 0 });
    }
    const links: PlannedLink[] = [];
    for (const link of record.links) {
      const occupant = (() => { try { return lstatSync(link.path); } catch { return null; } })();
      if (link.action === "remove") {
        if (occupant !== null) { blocked ??= this.host.shown(link.path) + " 已被占用，没有撤销。"; continue; }
        links.push({ ...link, action: "create" });
      } else {
        const raw = occupant?.isSymbolicLink() ? (() => { try { return readlinkSync(link.path); } catch { return null; } })() : null;
        if (raw !== link.target) { blocked ??= this.host.shown(link.path) + " 已不是当初建的链接，没有撤销。"; continue; }
        links.push({ ...link, action: "remove" });
      }
    }
    let lock: PlannedLock | null = null, lockDiff: { file: string; diff: string } | null = null;
    if (record.lock !== null) {
      const read = readTarget(record.lock.file), current = read.state === "ok" ? lockSkills(read.bytes.toString("utf8")).skills[record.lock.name] : undefined;
      if (read.state !== "ok") blocked ??= "无法读取 lock 文件 " + this.host.shown(record.lock.file) + "。";
      else if (!isDeepStrictEqual(current ?? null, record.lock.after)) blocked ??= "lock 里的 " + record.lock.name + " 在那次修改之后又被改过，没有撤销。";
      else {
        try {
          const before = read.bytes.toString("utf8"), name = record.lock.name, target = record.lock.before;
          const after = target === null ? editLock(before, name, { kind: "remove" }) : editLock(before, name, { kind: record.lock.after === null ? "put" : "replace", value: target });
          lock = { file: record.lock.file, before: read.bytes, after, mode: read.mode, name, entryBefore: record.lock.after, entryAfter: target };
          lockDiff = { file: this.host.shown(record.lock.file), diff: this.host.display(unifiedDiff(this.host.shown(record.lock.file), before, after, 2)) };
        } catch (error) { blocked ??= "无法修改 lock：" + (error instanceof Error ? error.message : "未知原因") + "。"; }
      }
    }
    const steps: PackageSteps = { shared, subject: change.subject, adds: [], replaces, removes, restores, links, lock, sources: record.sources.map(item => ({ name: item.name, before: item.after, after: item.before })) };
    return this.offer("skill-undo", steps, plans, null, lockDiff, [], "harnesshub", [SCOPE, "撤销“" + change.subject + "”：放回当初的文件夹、链接和 lock 条目。"], blocked);
  }
  private offer(change: PackageChange, steps: PackageSteps, skills: readonly CapabilitySkillPlan[], source: NonNullable<CapabilityChangeCheck["source"]> | null, lock: NonNullable<CapabilityChangeCheck["lock"]> | null, orphans: NonNullable<CapabilityChangeCheck["orphans"]>,
    current: CapabilityChangeCheck["current"], notes: readonly string[], blocked: string | null, diff: string | null = null): CapabilityChangeCheck {
    const links: CapabilityLinkChange[] = steps.links.map(link => ({ path: this.host.shown(link.path), target: link.target.startsWith("/") ? this.host.shown(link.target) : link.target, action: link.action, owner: link.owner }));
    const empty = !steps.adds.length && !steps.replaces.length && !steps.removes.length && !steps.restores.length && !steps.links.length && steps.lock === null;
    return this.host.offer({ kind: change, harnessId: "", name: steps.subject, enabled: change !== "skill-delete", file: this.host.shown(steps.shared), command: null, diff, rewrite: null, links, current,
      notes, blocked: blocked ?? (empty ? "无需修改。" : null), skills, source, lock, orphans }, (expires, check) => ({ kind: "package", change, expires, steps, check }));
  }

  /** Makes a confirmed change of skill folders: everything is checked to be as shown before the first step. */
  apply(prepared: PreparedPackage, record: (view: CapabilityChangeView) => void): Promise<CapabilityChangeView> {
    const steps = prepared.steps;
    return this.host.serial("skills:" + steps.shared, async () => {
      this.host.owned();
      await this.verify(steps);
      const id = randomUUID(), at = this.host.now().toISOString(), snapshots = new Map<string, string>();
      for (const item of [...steps.replaces, ...steps.removes]) {
        const snapshot = await this.host.snapshots.save(item.folder);
        if (snapshot.id !== item.expected) throw new CapabilityError("CAPABILITY_TARGET_CHANGED", item.name + " 在确认之后被改动过，没有修改；请重新检查");
        snapshots.set(item.folder, snapshot.id);
      }
      const staging = await stagingFolder(steps.shared), rollback: (() => Promise<void>)[] = [], after = new Map<string, string | null>();
      let error: { code: string; message: string } | null = null, stuck = false, backupId: string | null = null;
      try {
        for (const link of steps.links.filter(item => item.action === "remove")) { unlinkSync(link.path); rollback.push(async () => { symlinkSync(link.target, link.path); }); }
        for (const item of steps.removes) {
          const aside = join(staging, "old-" + item.name);
          await rename(item.folder, aside); rollback.push(() => rename(aside, item.folder)); after.set(item.folder, null);
        }
        for (const item of steps.replaces) {
          const fresh = join(staging, "new-" + item.name), aside = join(staging, "old-" + item.name);
          const written = item.by.kind === "archive" ? (await writeSkill(item.by.archive, item.by.skill, fresh)).id : item.by.kind === "text" ? (await writeSkillText(item.by.text, fresh)).id
            : (await this.host.snapshots.restore(item.by.id, fresh), item.by.id);
          await rename(item.folder, aside);
          try { await rename(fresh, item.folder); } catch (failure) { await rename(aside, item.folder); throw failure; }
          rollback.push(async () => { await rename(item.folder, fresh); await rename(aside, item.folder); }); after.set(item.folder, written);
        }
        for (const item of [...steps.adds.map(add => ({ ...add, kind: "add" as const })), ...steps.restores.map(restore => ({ ...restore, kind: "restore" as const }))]) {
          const fresh = join(staging, "new-" + item.name);
          const written = item.kind === "restore" ? (await this.host.snapshots.restore(item.snapshot, fresh), item.snapshot) : "text" in item ? (await writeSkillText(item.text, fresh)).id
            : (await writeSkill(item.archive, item.skill, fresh)).id;
          if (present(item.folder)) throw new CapabilityError("CAPABILITY_TARGET_CHANGED", this.host.shown(item.folder) + " 在确认之后被占用");
          await rename(fresh, item.folder); rollback.push(() => rename(item.folder, join(staging, "undone-" + item.name))); after.set(item.folder, written);
        }
        for (const link of steps.links.filter(item => item.action === "create")) { symlinkSync(link.target, link.path); rollback.push(async () => { unlinkSync(link.path); }); }
        if (steps.lock !== null) {
          const lock = steps.lock;
          backupId = randomUUID();
          this.host.store.saveBackup({ id: backupId, file: lock.file, createdAt: at, changeId: id, subject: "lock：" + steps.subject }, lock.before);
          replaceTarget(lock.file, sha256(lock.before), Buffer.from(lock.after, "utf8"), lock.mode);
          rollback.push(async () => { replaceTarget(lock.file, sha256(Buffer.from(lock.after, "utf8")), lock.before, lock.mode); });
          const read = readTarget(lock.file);
          if (read.state !== "ok" || read.bytes.toString("utf8") !== lock.after) throw new CapabilityError("CAPABILITY_TARGET_REFUSED", "lock 写入后读回的内容与计划不一致");
          this.host.store.setWritten(backupId, read.bytes);
        }
      } catch (failure) {
        error = { code: failure instanceof CapabilityError ? failure.code : "CAPABILITY_WRITE_FAILED", message: (failure instanceof Error ? failure.message : "修改失败") + (code(failure) ? "（" + code(failure) + "）" : "") };
        for (const undo of rollback.reverse()) { try { await undo(); } catch { stuck = true; } }
        if (backupId !== null && !stuck) { this.host.store.dropBackup(backupId); backupId = null; }
        if (failure instanceof CapabilityError && failure.code === "CAPABILITY_TARGET_CHANGED" && !stuck) { await rm(staging, { recursive: true, force: true }); throw failure; }
      }
      // A rollback that did not complete leaves the staging folder for the user, with whatever it still holds.
      if (!stuck) await rm(staging, { recursive: true, force: true });
      // A skill written from text gets its trees once it is written: the folder as written is both its source and its copy.
      const sources = steps.sources.map(item => item.after !== null && item.after.kind === "local" ? { ...item, after: { ...item.after, upstreamTree: after.get(item.after.folder) ?? item.after.upstreamTree,
        localTree: after.get(item.after.folder) ?? item.after.localTree } } : item);
      if (error === null) {
        for (const item of sources) {
          if (item.after === null) this.host.store.dropSkillSource(item.name);
          else this.host.store.setSkillSource({ ...item.after, installedAt: item.after.installedAt || at, updatedAt: at, changeId: id });
        }
        for (const link of steps.links) {
          if (link.harnessId === null) continue;
          if (link.action === "remove") this.host.store.dropLedger(link.harnessId, link.path, "link/" + link.path);
          else this.host.store.setLedger({ harnessId: link.harnessId, file: link.path, key: "link/" + link.path, valueHash: hash(JSON.stringify(link.target)), previous: null, changeId: id, at }, false);
        }
      }
      const skills = [...steps.adds.map(item => ({ name: item.name, folder: item.folder, before: null })), ...steps.replaces.map(item => ({ name: item.name, folder: item.folder, before: item.expected })),
        ...steps.removes.map(item => ({ name: item.name, folder: item.folder, before: item.expected })), ...steps.restores.map(item => ({ name: item.name, folder: item.folder, before: null }))]
        .map(item => ({ ...item, after: error === null ? after.get(item.folder) ?? null : item.before }));
      const view: CapabilityChangeView = { id, kind: prepared.change, harnessId: null, subject: steps.subject, file: this.host.shown(steps.shared), status: error === null ? "applied" : "failed", diff: steps.lock === null || error !== null ? null : prepared.check.lock?.diff ?? null,
        backupId: error === null ? backupId : null, error, links: error === null ? prepared.check.links : [], skills: skills.map(item => ({ name: item.name, folder: this.host.shown(item.folder), before: item.before, after: item.after })),
        notes: error === null ? prepared.check.notes.filter(note => note !== SCOPE) : stuck ? ["回滚没有完成，暂存目录 " + this.host.shown(staging) + " 留着，里面可能还有被移走的文件夹；快照也在。"] : ["已全部回滚，没有留下改动。"], at };
      record(view);
      if (error === null && prepared.change !== "skill-undo") this.host.store.setSkillUndo(id, {
        skills: skills.map(item => ({ ...item, snapshot: item.before === null ? null : snapshots.get(item.folder) ?? (steps.restores.find(restore => restore.folder === item.folder)?.snapshot ?? null) })),
        links: steps.links, lock: steps.lock === null ? null : { file: steps.lock.file, name: steps.lock.name, before: steps.lock.entryBefore, after: steps.lock.entryAfter }, sources: sources.map(item => ({ name: item.name, before: item.before, after: item.after === null ? null : { ...item.after, changeId: id } })) } satisfies UndoRecord);
      await this.prune();
      if (error === null) this.updates = null;
      return view;
    });
  }
  /** Checks that every folder, link and lock a change touches is still as its check saw it; throws TARGET_CHANGED otherwise. */
  private async verify(steps: PackageSteps): Promise<void> {
    const changed = (what: string): never => { throw new CapabilityError("CAPABILITY_TARGET_CHANGED", what + " 在确认之后变了，没有修改；请重新检查"); };
    for (const item of [...steps.replaces, ...steps.removes]) if (!realDirectory(item.folder) || (await folderTree(item.folder)).id !== item.expected) changed(this.host.shown(item.folder));
    for (const item of [...steps.adds, ...steps.restores]) if (present(item.folder)) changed(this.host.shown(item.folder));
    // A link put back may lead into a folder this same change puts back first.
    const arriving = [...steps.adds, ...steps.restores].map(item => item.folder);
    for (const link of steps.links) {
      const occupant = (() => { try { return lstatSync(link.path); } catch { return null; } })(), target = resolve(dirname(link.path), link.target);
      const same = link.action === "create" ? occupant === null && (existsSync(target) || arriving.some(folder => target === folder || target.startsWith(folder + "/")))
        : occupant?.isSymbolicLink() === true && (() => { try { return readlinkSync(link.path) === link.target; } catch { return false; } })();
      if (!same) changed(this.host.shown(link.path));
    }
    if (steps.lock !== null) { const read = readTarget(steps.lock.file); if (read.state !== "ok" || !read.bytes.equals(steps.lock.before)) changed(this.host.shown(steps.lock.file)); }
    for (const item of steps.restores) if (!(await this.host.snapshots.has(item.snapshot))) throw new CapabilityError("CAPABILITY_NOT_FOUND", item.name + " 的快照已清理，无法撤销");
  }
  /** Keeps the snapshots and undo records that the newest changes name. */
  private async prune(): Promise<void> {
    const recent = this.host.store.changes(SKILL_SNAPSHOT_CHANGES).map(change => change.id), keep = new Set<string>();
    this.host.store.pruneSkillUndo(recent);
    for (const id of recent) { const record = this.host.store.skillUndo(id) as UndoRecord | null; for (const item of record?.skills ?? []) if (item.snapshot !== null) keep.add(item.snapshot); }
    await this.host.snapshots.prune(keep);
  }
  /** The snapshots kept, for the page. */
  snapshotStats(): Promise<{ readonly count: number; readonly bytes: number }> { return this.host.snapshots.stats(); }
}
