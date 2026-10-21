import { createHash, randomBytes, randomUUID } from "node:crypto";
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { capabilityReadTables, harnessDirectories, type HarnessReadTable, type PluginSource, type ReadEnvironment } from "../../adapters/capability-reads.js";
import { CAPABILITY_CHECK_MS, CapabilityError, LOCAL_SKILL_SOURCE, SKILL_SNAPSHOT_CHANGES, type CapabilityChangeCheck, type CapabilityChangeKind, type CapabilityChangeView, type CapabilityDrift, type CapabilityDriftState, type CapabilityHistory,
  type CapabilityLinkChange, type CapabilityOrphan, type CapabilityRestoreCheck, type InstructionCheckOption, type InstructionsView, type McpDefinitionView, type McpInventoryView, type SkillSourceListing,
  type SkillTextView, type SkillUpdateView, type SubagentDefinitionView, type SubagentInventoryView } from "../../contracts/capabilities.js";
import { ManagementError } from "../../contracts/management.js";
import { unifiedDiff } from "../control/unified-diff.js";
import { isolatedSandboxProfile } from "../management/native.js";
import { runManagementProcess } from "../management/process.js";
import { parseProcessTable, programName } from "../management/program-usage.js";
import { parsed, UnsafeEdit } from "./edits.js";
import { at, record, text } from "./formats.js";
import { maskSecrets } from "./masking.js";
import { readTarget, removeTarget, replaceTarget, type TargetRead } from "./files.js";
import { CapabilityScan, type InstalledHarness } from "./scan.js";
import { resolveHermesHome, resolveOpenClawWorkspace } from "./service.js";
import { CapabilityStore, sha256, WRITTEN_DELETED, type LedgerEntry, type StoredBackup } from "./store.js";
import type { GithubFetch } from "./github.js";
import { SkillChanges, type PreparedPackage } from "./skill-changes.js";
import { McpInventory } from "./mcp-changes.js";
import { InstructionInventory } from "./instruction-changes.js";
import { SubagentInventory } from "./subagent-changes.js";
import { sweepClaudeCopies, systemClaude, type ClaudeRunner } from "./claude-mcp.js";
import { SkillSnapshots, sweepStaging } from "./skill-packages.js";
import { claudePluginSwitch, claudeSwitch, codexPluginSwitch, codexSwitch, externalDirsOf, heldValue, listSwitch, opencodeSwitch, openclawSwitch, sharedDirPlan, type PluginSwitchRequest, type SwitchContext, type SwitchPlan,
  type SwitchRequest } from "./switches.js";
import { CLAUDE_UNINSTALLED_SOURCES, managedPluginSetting, PLUGIN_ID, pluginParts, readClaudePlugins, systemPluginFiles, type PluginFiles } from "./claude-plugins.js";

export interface ChangeOptions {
  /** The Gateway's data root; the changes keep their record and backups in `capabilities/` under it. */
  readonly root: string;
  readonly generation: number;
  /** Throws when this Gateway no longer owns its data root; checked before every write. */
  readonly assertOwner: () => void;
  /** The user's own home and environment: the files written are the user's real ones, never a substitute home. */
  readonly environment: ReadEnvironment;
  /** Every spelling of the home directory, for ~ in what is shown. */
  readonly homes: readonly string[];
  readonly now?: () => Date;
  /** `ps -axw -o pid=,ppid=,command=` for counting running sessions before a write (ADR-045 §3.4); the system's by default. */
  readonly processes?: (signal: AbortSignal) => Promise<string>;
  /** Runs the user's `openclaw` with `args` and `env` added, allowed to write only `writable` and never to use the network; the sandboxed system one by default. */
  readonly openclaw?: OpenclawRunner;
  /** Fetches from GitHub without following redirects (adding and updating skills); the platform's `fetch` by default. */
  readonly github?: GithubFetch;
  /** Runs the user's `claude` for its own MCP commands, allowed to write only what it is given and never to use the network; the sandboxed system one by default. */
  readonly claude?: ClaudeRunner;
  /** Reads plugin manifests and managed settings for plugin switches; this computer's files by default. */
  readonly pluginFiles?: PluginFiles;
}
export type OpenclawRunner = (args: readonly string[], options: { readonly env: Readonly<Record<string, string>>; readonly writable: readonly string[] }, signal: AbortSignal) => Promise<void>;
type Planned = Exclude<SwitchPlan, { kind: "none" }>;
type EditChange = "skill-switch" | "shared-dir" | "mcp-sync" | "mcp-remove" | "instructions-sync" | "instructions-remove" | "subagent-sync" | "subagent-remove" | "plugin-switch";
/** An edit of one file, or the Harness's own command; `predicted` is what that command wrote when run on a copy. */
interface PreparedEdit { readonly kind: "edit"; readonly change: EditChange; readonly harnessId: string; readonly subject: string; readonly expires: number; readonly plan: Planned | null;
  readonly before: Buffer | null; readonly predicted: Buffer | null; readonly mode: number; readonly check: CapabilityChangeCheck }
/** Links to create or remove (absolute paths, targets as written), and what the ledger records of them. */
interface PlannedLink { readonly path: string; readonly target: string; readonly action: "create" | "remove"; readonly ledger: "set" | "drop" | null }
interface PreparedLinks { readonly kind: "links"; readonly change: "skill-link" | "link-cleanup" | "link-undo"; readonly harnessId: string; readonly subject: string; readonly expires: number;
  readonly directory: string; readonly links: readonly PlannedLink[]; readonly createDirectory: boolean; readonly check: CapabilityChangeCheck }
interface PreparedRestore { readonly kind: "restore"; readonly expires: number; readonly backup: StoredBackup; readonly current: string | null; readonly mode: number; readonly check: CapabilityRestoreCheck }

const NAME = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u, COMMAND = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u, FINGERPRINT = /^[a-f0-9]{64}$/u, CHANGE = /^[a-f0-9-]{36}$/u, DRIFT = /^[a-f0-9]{32}$/u;
const RUNNING: Readonly<Record<string, RegExp>> = { claude: /^claude(?:\.exe)?$/u, gemini: /^gemini$/u, cursor: /^(?:Cursor|cursor-agent)$/u, codex: /^codex$/u };
const SHARED_ENTRY = "~/.agents/skills";
/** What a Claude Code plugin switch tells before confirming: when it takes effect, and what overrides the user's settings. */
const CLAUDE_PLUGIN_NOTES = ["新开的 Claude Code 会话才读到这次改动，包括 HarnessHub 新开的会话；运行中的会话要 /reload-plugins，HarnessHub 的会话里没有这个命令。",
  "Claude Code 的桌面应用与 VS Code 扩展读同一个 settings.json。",
  "项目的 .claude/settings.json、.claude/settings.local.json、--settings 与组织的管理设置都能覆盖这里：在用户级写 false 关不掉项目启用的插件。claude.ai 下发的管理设置无法从文件核对。"];
/** What a Codex plugin switch tells before confirming, from its config.toml as it is. */
function codexPluginNotes(content: string, id: string): readonly string[] {
  const value = parsed(content, "toml");
  return ["新开的 Codex 线程才读到这次改动，包括 ChatGPT 应用和编辑器扩展内置的 Codex。", "受信任项目的 .codex/config.toml 可以覆盖这里；Codex 的管理层（cloud-managed、/etc/codex）HarnessHub 无法核对。",
    ...(at(value, ["features", "plugins"]) === false ? ["config.toml 的 [features] plugins = false 关掉了整个插件功能，在重新打开它之前，这项改动不起作用。"] : []),
    ...(pluginParts(id).marketplace === "openai-bundled" ? ["这个插件随 Codex 安装。"] : [])];
}
/** Ledger keys that record a fact about a file or directory (HarnessHub created it), not something written into one. */
const FACT = /^(?:file|dir)\/created$/u;
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
/** OpenClaw's file as compared with its prediction: parsed, without the time it stamps on every write. */
function openclawContent(bytes: Buffer): unknown { const value = record(parsed(bytes.toString("utf8"), "json5")), meta = { ...record(value.meta) }; delete meta.lastTouchedAt; return JSON.parse(JSON.stringify({ ...value, meta })) as unknown; }
/** A diff as shown: the home directory as ~ and secret values masked. */
function displayed(text: string, homes: readonly string[]): string { let out = text; for (const home of [...homes].sort((a, b) => b.length - a.length)) out = out.split(home + "/").join("~/"); return maskSecrets(out); }
function code(error: unknown): string { return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : ""; }
/**
 * Writes the home directory as ~ for every spelling in `homes`, in text HarnessHub did not build itself, such as stored
 * records and errors' messages (ADR-044): `<home>/…` anywhere, and the home standing alone, which no ASCII letter, digit,
 * `.`, `_` or `-` of a longer name touches (so `（<home>）` and `<home>。` too). That covers every absolute home path the
 * privacy guard (`homePathsIn`) reads. Longer spellings go first, since the resolved home may end with the given one, and
 * the pass repeats until none is left, since a replacement can join what follows into another such path.
 */
export function homeText(homes: readonly string[]): (text: string) => string {
  const forms = [...homes].filter(home => home.length > 1).sort((a, b) => b.length - a.length)
    .map(home => ({ prefix: home + "/", alone: new RegExp("(?<![A-Za-z0-9._/~-])" + home.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&") + "(?![A-Za-z0-9_-]|\\.[A-Za-z0-9_-])", "gu") }));
  return text => {
    let out = text;
    for (let before = ""; out !== before;) { before = out; for (const form of forms) out = out.split(form.prefix).join("~/").replace(form.alone, "~"); }
    return out;
  };
}
/** Every string of a stored value through `show`; the keys stay as they are. */
function textsThrough(value: unknown, show: (text: string) => string): unknown {
  if (typeof value === "string") return show(value);
  if (Array.isArray(value)) return value.map(item => textsThrough(item, show));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, textsThrough(item, show)]));
  return value;
}
/**
 * What a failed write records and answers (ADR-044): the action, the file with ~ and the error's code (`EACCES`, or
 * HarnessHub's own), never the error's own text. A file system error names private paths, such as the temporary file
 * beside the target, and a parser's may quote the file.
 */
function failedMessage(action: string, shown: string, failure: unknown): string {
  const reason = code(failure);
  return action + " " + shown + " 失败" + (/^[A-Z][A-Z0-9_]{0,63}$/u.test(reason) ? "（" + reason + "）" : "");
}
function inside(path: string, root: string): boolean { return path === root || path.startsWith(root + "/"); }
function own(value: Readonly<Record<string, unknown>>, key: string): unknown { return Object.hasOwn(value, key) ? value[key] : undefined; }

/**
 * Changes HarnessHub makes to a Harness's own user-level configuration (ADR-045 §3–4): each is checked and shown first,
 * applied once on the user's confirmation, and made only while what it changes is still as it was shown. An edit keeps
 * a backup of the file's bytes (the newest ten per file), is atomic, read back and checked against the plan; a change of
 * links checks every link before touching any and records them so it can be undone. A result that is not as planned is
 * reported as failed; a failure is recorded with its code and the file with ~, never the error's own text (ADR-044).
 * Changes of one file or directory run one at a time; `close` waits for the running ones.
 */
export class CapabilityChanges {
  private readonly store: CapabilityStore;
  private readonly prepared = new Map<string, PreparedEdit | PreparedLinks | PreparedRestore | PreparedPackage>();
  private readonly skills: SkillChanges;
  private readonly mcp: McpInventory;
  private readonly instructions: InstructionInventory;
  private readonly subagents: SubagentInventory;
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly running = new Set<Promise<unknown>>();
  private closed = false;
  constructor(private readonly options: ChangeOptions) {
    this.store = CapabilityStore.open(options.root, options.generation); sweepCopies(); sweepClaudeCopies();
    const shared = harnessDirectories(options.environment).shared;
    sweepStaging(shared);
    this.skills = new SkillChanges({ environment: options.environment, store: this.store, snapshots: new SkillSnapshots(join(realpathSync(options.root), "capabilities", "skills")),
      github: options.github ?? ((url, init) => fetch(url, init)), now: () => this.now(), shown: path => this.shown(path), display: text => displayed(text, this.options.homes), owned: () => this.owned(),
      serial: (key, work) => this.serial(key, work), tables: () => this.tables(), hermesReadsShared: () => this.hermesReadsShared(),
      offer: (check, prepared) => { const fingerprint = randomBytes(32).toString("hex"), expires = this.now().getTime() + CAPABILITY_CHECK_MS, full: CapabilityChangeCheck = { ...check, fingerprint, expiresAt: new Date(expires).toISOString() };
        this.prepared.set(fingerprint, prepared(expires, full)); return full; } });
    this.mcp = new McpInventory({ environment: options.environment, store: this.store, now: () => this.now(), shown: path => this.shown(path), owned: () => this.owned(), tables: () => this.tables(),
      runningNotes: harnessId => this.runningNotes(harnessId, "mcp"),
      offerEdit: (change, harnessId, subject, enabled, file, read, plan, blocked, notes) => this.offerEdit(change, harnessId, subject, enabled, file, read, plan, blocked, notes, null) });
    this.instructions = new InstructionInventory({ environment: options.environment, store: this.store, homes: options.homes, now: () => this.now(), shown: path => this.shown(path), owned: () => this.owned(),
      tables: () => this.tables(), runningNotes: harnessId => this.runningNotes(harnessId, "instructions"), ccSwitchRunning: () => this.ccSwitchRunning(),
      offerEdit: (change, harnessId, subject, enabled, file, read, plan, blocked, notes) => this.offerEdit(change, harnessId, subject, enabled, file, read, plan, blocked, notes, null) });
    this.subagents = new SubagentInventory({ environment: options.environment, store: this.store, homes: options.homes, now: () => this.now(), shown: path => this.shown(path), owned: () => this.owned(),
      tables: () => this.tables(), runningNotes: harnessId => this.runningNotes(harnessId, "subagents"),
      offerEdit: (change, harnessId, subject, enabled, file, read, plan, blocked, notes) => this.offerEdit(change, harnessId, subject, enabled, file, read, plan, blocked, notes, null) });
  }

  private now(): Date { return this.options.now?.() ?? new Date(); }
  private shown(path: string): string { for (const home of [...this.options.homes].sort((a, b) => b.length - a.length)) { if (path === home) return "~"; if (path.startsWith(home + "/")) return "~/" + path.slice(home.length + 1); } return path; }
  /** A path shown with ~, as an absolute path again. */
  private absolute(shown: string): string { return shown === "~" ? this.options.environment.home : shown.startsWith("~/") ? join(this.options.environment.home, shown.slice(2)) : shown; }
  private owned(): void { if (this.closed) throw new CapabilityError("OWNERSHIP_LOST", "capability changes are closed"); this.options.assertOwner(); this.store.assertIdentity(); }
  private track<T>(work: Promise<T>): Promise<T> { this.running.add(work); void work.finally(() => this.running.delete(work)).catch(() => {}); return work; }
  /** Runs `work` after every earlier change of the same file or directory. */
  private serial<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve(), next = previous.catch(() => {}).then(work);
    this.queues.set(key, next); void next.finally(() => { if (this.queues.get(key) === next) this.queues.delete(key); }).catch(() => {});
    return this.track(next);
  }
  private context(harnessId: string): SwitchContext { return { ledger: (file, key) => this.store.ledger(harnessId, file, key), hash: value => hash(JSON.stringify(value ?? null)) }; }
  /** Starts a check, which may run a Harness's command, as work `close` waits for. */
  private checking<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new CapabilityError("OWNERSHIP_LOST", "capability changes are closed"));
    this.prune();
    return this.track(work());
  }
  /** Forgets confirmations past their time, and the oldest beyond 256 unused ones. */
  private prune(): void {
    const now = this.now().getTime();
    for (const [fingerprint, prepared] of this.prepared) if (prepared.expires < now) this.prepared.delete(fingerprint);
    for (const fingerprint of [...this.prepared.keys()].slice(0, Math.max(0, this.prepared.size - 255))) this.prepared.delete(fingerprint);
  }
  private async tables(): Promise<{ hermesHome: string; tables: readonly HarnessReadTable[] }> {
    const environment = this.options.environment, hermesHome = await resolveHermesHome(environment);
    return { hermesHome, tables: capabilityReadTables(environment, { hermesHome, openclawWorkspace: await resolveOpenClawWorkspace(environment) }) };
  }
  private installed(installed: readonly InstalledHarness[], harnessId: string): InstalledHarness {
    const harness = installed.find(item => item.harnessId === harnessId);
    if (!harness) throw new CapabilityError("CAPABILITY_NOT_FOUND", "this Harness has no official installation here");
    return harness;
  }
  private offer(check: Omit<CapabilityChangeCheck, "fingerprint" | "expiresAt">, prepared: (fingerprint: string, expires: number, check: CapabilityChangeCheck) => PreparedEdit | PreparedLinks): CapabilityChangeCheck {
    const fingerprint = randomBytes(32).toString("hex"), expires = this.now().getTime() + CAPABILITY_CHECK_MS, full: CapabilityChangeCheck = { ...check, fingerprint, expiresAt: new Date(expires).toISOString() };
    this.prepared.set(fingerprint, prepared(fingerprint, expires, full));
    return full;
  }
  /** The links HarnessHub placed for shared skills, by its ledger (absolute paths). */
  placedLinks(): ReadonlySet<string> { return new Set(this.store.ledgerKeys("link/").map(key => key.slice("link/".length))); }
  /** The skills HarnessHub installed in the shared directory, by folder name, with their repository. */
  installedSkills(): ReadonlyMap<string, string> { return new Map(this.store.skillSources().map(source => [source.name, source.kind === "local" ? LOCAL_SKILL_SOURCE : source.repository])); }

  /** Downloads a GitHub repository version and lists its skills for adding (ADR-045 §4); nothing is written. */
  listSkillSource(input: string): Promise<SkillSourceListing> { return this.checking(() => this.skills.listSource(input)); }
  /** Prepares adding skills of a listing to the shared directory, by their folder names. */
  checkSkillAdd(listingId: string, names: readonly string[], installed: readonly InstalledHarness[]): Promise<CapabilityChangeCheck> { return this.checking(() => this.skills.checkAdd(listingId, names, installed)); }
  /** Whether the skills with a known source have newer versions upstream (one GitHub listing per repository; kept ten minutes unless `refresh`). */
  checkSkillUpdates(refresh: boolean): Promise<SkillUpdateView> { return this.checking(() => this.skills.checkUpdates(refresh)); }
  /** Prepares updating one skill from its source; a folder changed locally needs `overwrite`. */
  checkSkillUpdate(name: string, overwrite: boolean): Promise<CapabilityChangeCheck> {
    if (!NAME.test(name)) return Promise.reject(new CapabilityError("INVALID_INPUT", "invalid skill name"));
    return this.checking(() => this.skills.checkUpdate(name, overwrite));
  }
  /** Prepares deleting one skill folder of the shared directory, with the links into it and its lock entry. */
  /** Prepares writing a new skill from the user's texts into the shared directory (ADR-045 step 5); nothing is written here. */
  checkSkillCreate(name: string, input: SkillTextView, installed: readonly InstalledHarness[]): Promise<CapabilityChangeCheck> {
    return this.checking(() => this.skills.checkCreate(name, { description: input.description, body: input.body }, this.options.homes, installed));
  }
  /** Prepares changing a skill HarnessHub wrote from text; `overwrite` replaces a folder someone changed since. */
  checkSkillEdit(name: string, input: SkillTextView, overwrite: boolean): Promise<CapabilityChangeCheck> {
    return this.checking(() => this.skills.checkEdit(name, { description: input.description, body: input.body }, this.options.homes, overwrite));
  }
  /** The texts of a skill HarnessHub wrote, as its SKILL.md holds them now, the home directory shown as ~; null when it does not read as one. */
  skillText(name: string): Promise<SkillTextView | null> {
    return this.checking(async () => {
      const read = this.skills.localText(name), home = (value: string) => [...this.options.homes].sort((a, b) => b.length - a.length).reduce((out, item) => out.split(item + "/").join("~/"), value);
      return read === null ? null : { description: home(read.description), body: home(read.body) };
    });
  }
  checkSkillDelete(name: string): Promise<CapabilityChangeCheck> {
    if (!NAME.test(name)) return Promise.reject(new CapabilityError("INVALID_INPUT", "invalid skill name"));
    return this.checking(() => this.skills.checkDelete(name));
  }
  /** HarnessHub's MCP list with each server's state per installed Harness, and the servers the Harnesses already have (ADR-045 §5). Read only. */
  mcpInventory(installed: readonly InstalledHarness[]): Promise<McpInventoryView> { return this.checking(() => this.mcp.inventory(installed)); }
  /** Keeps a server in the list (a definition typed by the user, checked by the approval's rules); `replace` changes a listed one. */
  saveMcpServer(name: string, definition: McpDefinitionView, replace: boolean): Promise<{ readonly name: string }> { return this.checking(async () => ({ name: this.mcp.save(name, definition, replace) })); }
  /** Removes a server from the list, refused while a Harness still has the entry HarnessHub wrote for it. */
  removeMcpServer(name: string, installed: readonly InstalledHarness[]): Promise<{ readonly removed: true }> { return this.checking(async () => { await this.mcp.remove(name, installed); return { removed: true } as const; }); }
  /** Lists a server the Harnesses already have and records the identical entries in `claim` as HarnessHub's (no file changes). */
  importMcpServer(id: string, claim: readonly string[], installed: readonly InstalledHarness[]): Promise<readonly CapabilityChangeView[]> { return this.checking(() => this.mcp.importCandidate(id, claim, installed)); }
  /** Records a listed server's identical entries in these Harnesses as HarnessHub's (no file changes). */
  claimMcpServer(name: string, harnessIds: readonly string[], installed: readonly InstalledHarness[]): Promise<readonly CapabilityChangeView[]> { return this.checking(() => this.mcp.claim(name, harnessIds, installed)); }
  /** Prepares writing a listed server into one Harness; `overwrite` for one HarnessHub wrote that someone changed or removed since. */
  checkMcpSync(name: string, harnessId: string, overwrite: boolean, installed: readonly InstalledHarness[]): Promise<CapabilityChangeCheck> { return this.checking(() => this.mcp.checkSync(name, harnessId, overwrite, installed)); }
  /** Prepares removing the entry HarnessHub wrote for a listed server from one Harness. */
  /** HarnessHub's instructions and where they stand in every installed Harness (ADR-045 §6, step 4). Read only. */
  instructionsView(installed: readonly InstalledHarness[]): Promise<InstructionsView> { return this.checking(() => this.instructions.view(installed)); }
  /** Saves the shared text and the additions in HarnessHub's own store; no Harness file changes. */
  saveInstructions(shared: string, additions: Readonly<Record<string, string>>, installed: readonly InstalledHarness[]): Promise<InstructionsView> {
    return this.checking(async () => { this.instructions.save(shared, additions, installed); return this.instructions.view(installed); });
  }
  claimInstructions(harnessId: string, installed: readonly InstalledHarness[]): Promise<CapabilityChangeView> { return this.checking(() => this.instructions.claim(harnessId, installed)); }
  checkInstructionsSync(harnessId: string, options: ReadonlySet<InstructionCheckOption>, installed: readonly InstalledHarness[]): Promise<CapabilityChangeCheck> {
    return this.checking(() => this.instructions.checkSync(harnessId, options, installed));
  }
  checkInstructionsRemove(harnessId: string, options: ReadonlySet<InstructionCheckOption>, installed: readonly InstalledHarness[]): Promise<CapabilityChangeCheck> {
    return this.checking(() => this.instructions.checkRemove(harnessId, options, installed));
  }
  /** HarnessHub's subagent list and where each one stands in every installed Harness (ADR-045 §7, step 5). Read only. */
  subagentInventory(installed: readonly InstalledHarness[]): Promise<SubagentInventoryView> { return this.checking(() => this.subagents.inventory(installed)); }
  /** Keeps a subagent in the list; `replace` changes a listed one. No Harness file changes. */
  saveSubagent(name: string, definition: SubagentDefinitionView, replace: boolean): Promise<{ readonly name: string }> { return this.checking(() => this.subagents.save(name, definition, replace)); }
  removeSubagent(name: string, installed: readonly InstalledHarness[]): Promise<{ readonly removed: true }> { return this.checking(async () => { await this.subagents.remove(name, installed); return { removed: true as const }; }); }
  claimSubagent(name: string, harnessIds: readonly string[], installed: readonly InstalledHarness[]): Promise<readonly CapabilityChangeView[]> { return this.checking(() => this.subagents.claim(name, harnessIds, installed)); }
  checkSubagentSync(name: string, harnessId: string, overwrite: boolean, installed: readonly InstalledHarness[]): Promise<CapabilityChangeCheck> { return this.checking(() => this.subagents.checkSync(name, harnessId, overwrite, installed)); }
  checkSubagentRemove(name: string, harnessId: string, installed: readonly InstalledHarness[]): Promise<CapabilityChangeCheck> { return this.checking(() => this.subagents.checkRemove(name, harnessId, installed)); }
  checkMcpRemove(name: string, harnessId: string, installed: readonly InstalledHarness[]): Promise<CapabilityChangeCheck> { return this.checking(() => this.mcp.checkRemove(name, harnessId, installed)); }
  /** Whether Hermes reads the shared directory through its `skills.external_dirs` now. */
  private async hermesReadsShared(): Promise<boolean> {
    const { hermesHome, tables } = await this.tables(), file = tables.find(table => table.harnessId === "hermes")?.skills.externalDirs?.file;
    if (file === undefined) return false;
    const read = readTarget(file);
    if (read.state !== "ok") return false;
    try { return externalDirsOf(parsed(read.bytes.toString("utf8"), "yaml")).some(this.sharedEntries(hermesHome)); } catch { return false; }
  }

  /**
   * Prepares turning one skill off (`enabled` false) or on for one installed Harness: which file changes and the exact
   * diff, or the Harness's own command; who wrote the setting it changes; and what to know before confirming.
   * `via` is the copy (as the view shows it) for Codex, which switches copies by path; ignored by the others.
   */
  checkSkillSwitch(input: { readonly harnessId: string; readonly name: string; readonly enabled: boolean; readonly via: string | null }, installed: readonly InstalledHarness[]): Promise<CapabilityChangeCheck> {
    return this.checking(() => this.prepareSwitch(input, installed));
  }
  private async prepareSwitch(input: { readonly harnessId: string; readonly name: string; readonly enabled: boolean; readonly via: string | null; readonly orphan?: LedgerEntry }, installed: readonly InstalledHarness[]): Promise<CapabilityChangeCheck> {
    if (!NAME.test(input.name)) throw new CapabilityError("INVALID_INPUT", "invalid skill name");
    const harness = this.installed(installed, input.harnessId), environment = this.options.environment, { hermesHome, tables } = await this.tables();
    const table = tables.find(item => item.harnessId === input.harnessId);
    if (!table || table.skills.switch === null) throw new CapabilityError("CAPABILITY_UNSUPPORTED", harness.name + " 没有按技能停用的开关，它的技能始终可见");
    // The skill must be one this Harness sees, and Codex's copy one of the places it reads it from; clearing an orphaned
    // setting is the opposite: the Harness must no longer have the skill.
    const view = await new CapabilityScan(environment, this.options.homes, hermesHome).view([table], [harness], this.now().toISOString());
    const edges = view.entries.find(entry => entry.kind === "skill" && entry.name === input.name)?.edges.filter(edge => edge.harnessId === input.harnessId) ?? [];
    let folder: string | null = null;
    if (input.orphan !== undefined) {
      if (edges.some(edge => edge.status !== "broken-link" && (input.via === null || edge.via === input.via))) throw new CapabilityError("CAPABILITY_TARGET_REFUSED", harness.name + " 仍能看到 " + input.name + "，这项设置不是孤立的；请在技能详情里启用");
      if (table.skills.switch.kind === "codex-skills-config") folder = dirname(input.orphan.key.slice("skills.config/".length));
    } else {
      if (!edges.length) throw new CapabilityError("CAPABILITY_NOT_FOUND", harness.name + " 看不到名为 " + input.name + " 的技能");
      if (table.skills.switch.kind === "codex-skills-config") {
        const edge = edges.find(item => item.via === input.via && item.status !== "broken-link");
        if (!edge) throw new CapabilityError("CAPABILITY_NOT_FOUND", "Codex 不在这个位置读取这个技能");
        folder = this.absolute(edge.via);
      }
    }
    const request: SwitchRequest = { harnessId: input.harnessId, name: input.name, enabled: input.enabled, folder };
    const { file, read, plan, blocked } = await this.plan(table, request);
    return this.offerEdit("skill-switch", input.harnessId, input.name, input.enabled, file, read, plan, blocked, await this.runningNotes(input.harnessId, "skills"), ["skills", "entries", input.name, "enabled"]);
  }
  /**
   * Prepares turning one plugin off (`enabled` false) or on in one Harness's own file (ADR-045 step 6a): Claude Code's
   * `enabledPlugins`, Codex's `[plugins."<id>"]` table. Every other Harness's plugins are read only. A Claude Code plugin is
   * refused while its dependencies (turning it on) or the enabled plugins that depend on it (turning it off) say
   * otherwise, while those cannot be read, and while an organization's managed settings decide it or might.
   */
  checkPluginSwitch(input: { readonly harnessId: string; readonly id: string; readonly enabled: boolean }, installed: readonly InstalledHarness[]): Promise<CapabilityChangeCheck> {
    return this.checking(() => this.preparePluginSwitch(input, installed));
  }
  private async preparePluginSwitch(input: { readonly harnessId: string; readonly id: string; readonly enabled: boolean; readonly orphan?: LedgerEntry }, installed: readonly InstalledHarness[]): Promise<CapabilityChangeCheck> {
    if (!PLUGIN_ID.test(input.id) || input.id.length > 256) throw new CapabilityError("INVALID_INPUT", "invalid plugin id");
    const harness = this.installed(installed, input.harnessId), { tables } = await this.tables(), table = tables.find(item => item.harnessId === input.harnessId), switching = table?.pluginSwitch ?? null;
    if (table === undefined || switching === null || switching.kind === "read-only") throw new CapabilityError("CAPABILITY_UNSUPPORTED", harness.name + " 的插件 HarnessHub 只读" + (switching?.kind === "read-only" ? "：" + switching.reason : "。"));
    const file = switching.file, read = readTarget(file), request: PluginSwitchRequest = { harnessId: input.harnessId, id: input.id, enabled: input.enabled }, context = this.context(input.harnessId);
    const notes = [...await this.runningNotes(input.harnessId, "plugins")];
    let plan: SwitchPlan | null = null, blocked: string | null = null;
    if (read.state === "refused") blocked = "无法修改 " + this.shown(file) + "：" + read.reason + "。";
    else if (read.state === "missing" && (!read.directory || switching.kind === "codex-plugins")) blocked = switching.kind === "codex-plugins" ? "Codex 还没有 config.toml。" : "无法修改：" + this.shown(dirname(file)) + " 不存在。";
    else {
      const content = read.state === "ok" ? read.bytes.toString("utf8") : "";
      try {
        if (switching.kind === "claude-enabled-plugins" && table.plugins?.kind === "claude") ({ plan, blocked } = await this.claudePluginPlan(table.plugins, file, content, request, context, notes, input.orphan !== undefined));
        else if (switching.kind === "codex-plugins") plan = codexPluginSwitch(file, content, request, context, codexPluginNotes(content, input.id));
        else blocked = harness.name + " 的插件来源与开关不一致，没有准备写入。";
      } catch (error) { if (!(error instanceof UnsafeEdit)) throw error; blocked = "无法安全修改 " + this.shown(file) + "：" + error.message + "。"; }
    }
    return this.offerEdit("plugin-switch", input.harnessId, input.id, input.enabled, file, read, plan, blocked, notes, null);
  }
  /**
   * Claude Code's side of a plugin switch: the plugin must be installed for the user (an orphaned setting excepted), not
   * decided by managed settings, and its dependencies — or, turning it off, the enabled plugins depending on it, synced
   * ones included — must allow it. HarnessHub never turns a dependency on or off along with it.
   */
  private async claudePluginPlan(source: Extract<PluginSource, { kind: "claude" }>, file: string, content: string, request: PluginSwitchRequest, context: SwitchContext, notes: string[], orphan: boolean)
    : Promise<{ plan: SwitchPlan | null; blocked: string | null }> {
    const files = this.options.pluginFiles ?? systemPluginFiles(), { marketplace } = pluginParts(request.id);
    if (CLAUDE_UNINSTALLED_SOURCES.includes(marketplace)) return { plan: null, blocked: marketplace === "synced" ? "账户同步的插件 HarnessHub 暂不提供开关；Claude Code 里用 /plugin 可以停用它（组织要求的除外）。"
      : "Claude Code 从 " + marketplace + " 加载它，没有安装记录；HarnessHub 不提供开关。" };
    const state = await readClaudePlugins(source, files), plugin = state.plugins.find(item => item.id === request.id && !item.synced);
    if (plugin === undefined && !orphan) return { plan: null, blocked: "Claude Code 的用户级没有安装 " + request.id + "。" };
    const managed = await managedPluginSetting(source.managed, request.id, files);
    if (managed.state === "set") return { plan: null, blocked: managed.value ? "组织的管理设置强制启用了它（" + this.shown(managed.file) + "），在用户级停用不起作用。" : "组织的管理设置阻止了它（" + this.shown(managed.file) + "），不能启用。" };
    if (managed.state === "unknown") return { plan: null, blocked: this.shownIn(managed.reason) + "。" };
    notes.push(...CLAUDE_PLUGIN_NOTES);
    if (plugin !== undefined && !orphan && request.enabled) {
      if (plugin.dependencies === null) return { plan: null, blocked: "无法核对它的依赖：" + plugin.problem + "。" };
      const missing = plugin.dependencies.filter(id => !state.plugins.some(item => item.id === id && !item.synced)), off = plugin.dependencies.filter(id => !missing.includes(id) && state.enabled.get(id) === false);
      if (missing.length || off.length) return { plan: null, blocked: [missing.length ? "它依赖的 " + missing.join("、") + " 没有安装" : null, off.length ? "它依赖的 " + off.join("、") + " 已停用" : null].filter(Boolean).join("；")
        + "。HarnessHub 不连带改动依赖；在 Claude Code 里用 /plugin 或 claude plugin enable 会连带启用已装的依赖。" };
    }
    if (plugin !== undefined && !orphan && !request.enabled) {
      const others = state.plugins.filter(item => item.id !== request.id && state.enabled.get(item.id) === true);
      const unknown = others.filter(item => !item.synced && item.dependencies === null);
      if (unknown.length) return { plan: null, blocked: "无法核对启用中的 " + unknown.map(item => item.id).join("、") + " 是否依赖它（" + unknown[0]!.problem + "）。" };
      const dependents = others.filter(item => (item.dependencies ?? []).includes(request.id));
      if (dependents.length) return { plan: null, blocked: "启用中的 " + dependents.map(item => item.id).join("、") + " 依赖它，停用会让它们缺少依赖。" };
      const unread = others.filter(item => item.synced && item.dependencies === null).length;
      if (unread) notes.push("有 " + unread + " 个账户同步的插件读不到清单，HarnessHub 没有核对它们是否依赖这个插件。");
      if (state.projectOnly) notes.push("另有 " + state.projectOnly + " 个插件只装在项目里，HarnessHub 没有核对它们是否依赖这个插件。");
    }
    // Without an entry the plugin is on by its default, or because an enabled plugin depends on it.
    const fallback = plugin === undefined || plugin.defaultEnabled || state.plugins.some(item => item.id !== plugin.id && state.enabled.get(item.id) === true && (item.dependencies ?? []).includes(plugin.id));
    return { plan: claudePluginSwitch(file, content, request, fallback, context), blocked: null };
  }
  /** Free text naming a path (a managed settings file, say), with ~ for the home directory. */
  private shownIn(text: string): string { let out = text; for (const home of [...this.options.homes].sort((a, b) => b.length - a.length)) out = out.split(home + "/").join("~/"); return out; }
  /**
   * Prepares making Hermes read the shared `~/.agents/skills` through its `skills.external_dirs` (`present`), or stop
   * (approval ruling 2). Only Hermes needs this: the others read the shared directory themselves, or (Claude Code) take
   * single skills by links.
   */
  checkSharedDir(input: { readonly harnessId: string; readonly present: boolean }, installed: readonly InstalledHarness[]): Promise<CapabilityChangeCheck> {
    return this.checking(async () => {
      const harness = this.installed(installed, input.harnessId), { hermesHome, tables } = await this.tables(), table = tables.find(item => item.harnessId === input.harnessId);
      if (!table?.skills.externalDirs || table.harnessId !== "hermes") throw new CapabilityError("CAPABILITY_UNSUPPORTED", harness.name + (table?.skills.roots.some(root => root.role === "shared")
        ? " 自己读取共享目录，不需要放置" : " 不能整个读取共享目录；Claude Code 请逐个放置技能"));
      const file = table.skills.externalDirs.file, read = readTarget(file);
      if (realOf(harnessDirectories(this.options.environment).shared) === null) throw new CapabilityError("CAPABILITY_NOT_FOUND", "共享目录 ~/.agents/skills 不存在");
      const resolves = this.sharedEntries(hermesHome);
      const visible = await this.sharedGain(table, harness, hermesHome);
      const notes = [...(input.present ? ["Hermes 会多看到 " + visible.length + " 个共享技能" + (visible.length ? "：" + visible.slice(0, 8).join("、") + (visible.length > 8 ? " 等" : "") : "") + "。"] : []),
        "正在运行的 Hermes 网关（QQ 等消息渠道）不会被 HarnessHub 重启，它重启后才看到改动；长驻的 Hermes 进程要 /reload-skills 或重启后生效。",
        ...(input.present ? ["现有的链接不动；它们指向同一份技能，Hermes 以本地链接为准。清理多余链接是单独的一步。"] : ["停止后，只经共享目录看到的技能会从 Hermes 里消失；本地链接里的技能不受影响。"])];
      let plan: SwitchPlan | null = null, blocked: string | null = null;
      if (read.state === "refused") blocked = "无法修改 " + this.shown(file) + "：" + read.reason + "。";
      else if (read.state === "missing" && !read.directory) blocked = "无法修改：" + this.shown(dirname(file)) + " 不存在。";
      else {
        try { plan = sharedDirPlan(file, read.state === "ok" ? read.bytes.toString("utf8") : "", input.present, SHARED_ENTRY, resolves, this.context(input.harnessId), notes); }
        catch (error) { if (!(error instanceof UnsafeEdit)) throw error; blocked = "无法安全修改 " + this.shown(file) + "：" + error.message + "。"; }
      }
      return this.offerEdit("shared-dir", input.harnessId, SHARED_ENTRY, input.present, file, read, plan, blocked, plan === null ? notes : [], null);
    });
  }
  /**
   * Which raw entries of Hermes's `skills.external_dirs` are the shared directory: expanded (~ and variables) and resolved
   * against Hermes's home as Hermes does, or HarnessHub's own spelling of it while the directory is missing.
   */
  private sharedEntries(hermesHome: string): (raw: string) => boolean {
    const shared = realOf(harnessDirectories(this.options.environment).shared), values = this.options.environment.values;
    return raw => {
      if (raw.trim() === SHARED_ENTRY) return true;
      const expanded = raw.trim().replace(/^~(?=$|\/)/u, this.options.environment.home).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/gu, (_, braced: string | undefined, bare: string | undefined) => values[braced ?? bare ?? ""] ?? "");
      return shared !== null && realOf(isAbsolute(expanded) ? expanded : resolve(hermesHome, expanded)) === shared;
    };
  }
  /** The shared skills a Harness does not see now, by name: what reading the shared directory adds. */
  private async sharedGain(table: HarnessReadTable, harness: InstalledHarness, hermesHome: string): Promise<readonly string[]> {
    const scan = new CapabilityScan(this.options.environment, this.options.homes, hermesHome), view = await scan.view([table], [harness], this.now().toISOString());
    const seen = new Set(view.entries.filter(entry => entry.kind === "skill" && entry.edges.some(edge => edge.harnessId === harness.harnessId && edge.status !== "broken-link")).map(entry => entry.name));
    const shared = new CapabilityScan(this.options.environment, this.options.homes, hermesHome), find = table.skills.roots[0]?.find;
    const all = await shared.view([sharedOnly(table, harnessDirectories(this.options.environment).shared, 8, find)], [harness], this.now().toISOString());
    return all.entries.filter(entry => entry.kind === "skill" && entry.edges.some(edge => edge.status === "active") && !seen.has(entry.name)).map(entry => entry.name).sort();
  }
  /** An edit or command plan offered for confirmation, with the guard every edit passes and OpenClaw's prediction. */
  private async offerEdit(change: EditChange, harnessId: string, subject: string, enabled: boolean, file: string, read: TargetRead, plan: SwitchPlan | null, blocked: string | null,
    extraNotes: readonly string[], target: readonly string[] | null): Promise<CapabilityChangeCheck> {
    const before = read.state === "ok" ? read.bytes : null, beforeText = before?.toString("utf8") ?? "";
    const notes = [...(plan !== null && plan.kind !== "none" ? plan.notes : []), ...extraNotes];
    if (plan?.kind === "edit" && read.state === "missing") notes.push("会新建这个文件。");
    if (plan?.kind === "edit" && plan.remove === true) notes.push("会删除这个文件。");
    let reason = blocked ?? (plan?.kind === "none" ? "无需修改：" + plan.reason : null), diff: string | null = null;
    if (reason === null && plan?.kind === "edit") {
      // The guard every edit passes: the planned file differs from the current one only at the setting it changes.
      try { if (!plan.check(parsed(beforeText, plan.format), parsed(plan.after, plan.format))) reason = "无法安全修改：改动会超出这个设置，没有准备写入。"; }
      catch (error) { reason = "无法安全修改：" + (error instanceof Error ? error.message : "未知原因"); }
      diff = displayed(unifiedDiff(this.shown(file), read.state === "ok" ? beforeText : null, plan.after, 2), this.options.homes);
    }
    let predicted: Buffer | null = null, rewrite: CapabilityChangeCheck["rewrite"] = null;
    if (reason === null && plan?.kind === "command" && plan.runner === "claude") {
      // Claude's own commands on a private copy of its file show what they will write, the keys Claude adds itself included.
      try {
        predicted = await this.predictClaude(plan.steps ?? [plan.args], before);
        const after = predicted.toString("utf8");
        diff = displayed(unifiedDiff(this.shown(file), before === null ? null : beforeText, after, 2), this.options.homes);
        if (!plan.check(parsed(after, "jsonc"))) reason = "Claude 的命令在副本上没有写出预期的服务器，没有准备写入。";
        const summary = rewriteSummary(before === null ? "{}" : beforeText, after, plan.subtree ?? []);
        rewrite = { ...summary, before: summary.before === null ? null : maskSecrets(summary.before), after: summary.after === null ? null : maskSecrets(summary.after) };
      } catch (error) { reason = "Claude 的预演没有通过，没有准备写入（" + (error instanceof Error ? error.message : "未知原因") + "）。"; }
    }
    else if (reason === null && plan?.kind === "command" && before !== null && target !== null) {
      // The same command on a private copy shows exactly what it will write, defaults it adds included.
      try { predicted = await this.predict(plan.args, before); diff = displayed(unifiedDiff(this.shown(file), beforeText, predicted.toString("utf8"), 2), this.options.homes); }
      catch (error) { reason = "OpenClaw 的预演没有通过，没有准备写入（" + (error instanceof Error ? error.message : "未知原因") + "）。"; }
      if (predicted !== null) {
        rewrite = rewriteSummary(beforeText, predicted.toString("utf8"), target);
        const restart = rewriteRestarts(beforeText, predicted.toString("utf8"), target);
        if (restart.length) reason = "OpenClaw 的命令还会改动需要重启 Gateway 的设置（" + restart.join("、") + "），HarnessHub 不做这项修改。";
      }
    }
    const command = plan?.kind !== "command" ? null : plan.runner === "claude" ? maskSecrets((plan.steps ?? [plan.args]).map(step => "claude " + step.map(part => /^[\w@%+=:,./-]+$/u.test(part) ? part : "'" + part + "'").join(" ")).join("；"))
      : "openclaw " + plan.args.join(" ");
    return this.offer({ kind: change, harnessId, name: subject, enabled, file: this.shown(file), command, diff, rewrite, links: [],
      current: plan !== null && plan.kind !== "none" ? plan.current : "none", notes, blocked: reason },
      (_, expires, check) => ({ kind: "edit", change, harnessId, subject, expires, plan: plan === null || plan.kind === "none" ? null : plan, before, predicted, mode: read.state === "ok" ? read.mode : 0o600, check }));
  }

  /**
   * Prepares placing one shared skill in Claude Code (`present`): an absolute link `~/.claude/skills/<folder>` to its folder
   * in `~/.agents/skills` (ADR-045 §4), or removing such a link HarnessHub placed. Links others made are left to the
   * switch; a place already taken is not overwritten.
   */
  checkSkillLink(input: { readonly harnessId: string; readonly name: string; readonly present: boolean }, installed: readonly InstalledHarness[]): Promise<CapabilityChangeCheck> {
    return this.checking(async () => {
      if (!NAME.test(input.name)) throw new CapabilityError("INVALID_INPUT", "invalid skill name");
      const harness = this.installed(installed, input.harnessId), { hermesHome, tables } = await this.tables(), table = tables.find(item => item.harnessId === input.harnessId);
      if (input.harnessId !== "claude" || !table) throw new CapabilityError("CAPABILITY_UNSUPPORTED", harness.name + " 不需要逐个放置：它自己读取共享目录" + (input.harnessId === "hermes" ? "，或经 skills.external_dirs 读取" : ""));
      const dirs = harnessDirectories(this.options.environment), folders = await new CapabilityScan(this.options.environment, this.options.homes, hermesHome).view([sharedOnly(table, dirs.shared, 1, undefined)], [harness], this.now().toISOString());
      const folder = folders.entries.find(entry => entry.kind === "skill" && entry.name === input.name)?.edges.find(edge => edge.status !== "broken-link")?.via;
      if (folder === undefined) throw new CapabilityError("CAPABILITY_NOT_FOUND", "共享目录里没有名为 " + input.name + " 的技能");
      const target = this.absolute(folder), directory = join(dirs.claude, "skills"), path = join(directory, basename(target)), key = "link/" + path;
      const occupant = (() => { try { return lstatSync(path); } catch { return null; } })();
      let blocked: string | null = null, links: PlannedLink[] = [], current: CapabilityChangeCheck["current"] = "none", createDirectory = false;
      const notes = ["Claude Code 会立即读到这个改动（它监视技能目录）。"];
      if (input.present) {
        const view = await new CapabilityScan(this.options.environment, this.options.homes, hermesHome).view([table], [harness], this.now().toISOString());
        const seen = view.entries.find(entry => entry.kind === "skill" && entry.name === input.name)?.edges.filter(edge => edge.harnessId === "claude" && edge.status !== "broken-link" && edge.status !== "invalid") ?? [];
        if (seen.length) blocked = "无需修改：Claude Code 已经能看到它（" + seen.map(edge => edge.via).join("、") + "）。";
        else if (occupant !== null) blocked = this.shown(path) + " 已被占用，没有放置。";
        else if (!existsSync(dirs.claude)) blocked = "无法放置：" + this.shown(dirs.claude) + " 不存在。";
        else {
          createDirectory = !existsSync(directory);
          links = [{ path, target, action: "create", ledger: "set" }];
          notes.push("链接用绝对路径，指向共享目录里的这一份；共享目录里的更新会直接生效。", ...(createDirectory ? ["会新建 " + this.shown(directory) + "。"] : []));
        }
      } else {
        const ours = this.store.ledger("claude", path, key);
        const raw = occupant?.isSymbolicLink() ? (() => { try { return readlinkSync(path); } catch { return null; } })() : null;
        if (raw === null || realOf(resolve(directory, raw)) !== realOf(target)) blocked = "无需修改：Claude Code 里没有指向共享目录这一份的链接 " + this.shown(path) + "。";
        else if (ours === null) blocked = "这个链接不是 HarnessHub 建的（多见于 npx skills），HarnessHub 不删它；要让 Claude Code 不用这个技能，请用“在 Claude Code 中停用”。";
        else { links = [{ path, target: raw, action: "remove", ledger: "drop" }]; current = "harnesshub"; }
      }
      return this.offerLinks("skill-link", "claude", input.name, input.present, directory, links, current, notes, blocked, createDirectory);
    });
  }
  /**
   * Prepares removing the links in a Harness's own skills directory that point into the shared directory, which it reads
   * anyway (approval rulings 2 and 3): OpenClaw reads it itself and skips those links; Hermes only once it reads the shared
   * directory through `skills.external_dirs`. Only links into `~/.agents/skills` are removed; they can be put back.
   */
  checkLinkCleanup(input: { readonly harnessId: string }, installed: readonly InstalledHarness[]): Promise<CapabilityChangeCheck> {
    return this.checking(async () => {
      const harness = this.installed(installed, input.harnessId), { hermesHome, tables } = await this.tables(), table = tables.find(item => item.harnessId === input.harnessId);
      if (!table || (input.harnessId !== "hermes" && input.harnessId !== "openclaw")) throw new CapabilityError("CAPABILITY_UNSUPPORTED", harness.name + " 没有可以清理的多余链接");
      const dirs = harnessDirectories(this.options.environment), shared = realOf(dirs.shared);
      if (shared === null) throw new CapabilityError("CAPABILITY_NOT_FOUND", "共享目录 ~/.agents/skills 不存在");
      const directory = input.harnessId === "hermes" ? join(hermesHome, "skills") : join(dirs.openclaw, "skills");
      const view = await new CapabilityScan(this.options.environment, this.options.homes, hermesHome).view([table], [harness], this.now().toISOString());
      const reads = view.harnesses[0]?.shared.reads;
      let blocked: string | null = null;
      if (reads !== "native" && reads !== "external-dir") blocked = harness.name + " 还没有读取共享目录；先让它读取共享目录，否则删掉这些链接会让这些技能从 " + harness.name + " 里消失。";
      const links: PlannedLink[] = [];
      let names: string[] = [];
      try { names = readdirSync(directory).sort(); } catch { names = []; }
      for (const name of names) {
        const path = join(directory, name);
        let raw: string | null = null;
        try { if (lstatSync(path).isSymbolicLink()) raw = readlinkSync(path); } catch { raw = null; }
        const real = raw === null ? null : realOf(path);
        if (raw !== null && real !== null && inside(real, shared)) links.push({ path, target: raw, action: "remove", ledger: null });
      }
      if (blocked === null && !links.length) blocked = "无需修改：" + this.shown(directory) + " 里没有指向共享目录的链接。";
      const notes = ["只删 " + this.shown(directory) + " 里这 " + links.length + " 个指向 ~/.agents/skills 的链接，技能本身不动；可以在“修改与备份”里撤销。", "`npx skills` 以后可能会重新建这些链接。",
        input.harnessId === "openclaw" ? "OpenClaw 本来就跳过这些链接，直接从共享目录读取同一份。"
          : "之后 Hermes 从共享目录读取这些技能。正在运行的 Hermes 网关（QQ 等消息渠道）不会被 HarnessHub 重启；长驻进程要 /reload-skills 或重启后生效。"];
      return this.offerLinks("link-cleanup", input.harnessId, "多余链接", false, directory, links, "other", notes, blocked, false);
    });
  }
  /**
   * Prepares undoing a change of links (removing what it created and putting back what it removed) or of skill folders
   * (putting back the folders, links and lock entry it changed), each step only while still as that change left it.
   */
  checkUndo(changeId: string): Promise<CapabilityChangeCheck> {
    return this.checking(async () => {
      const change = CHANGE.test(changeId) ? this.store.changeById(changeId) : null;
      if (change !== null && (change.kind === "skill-add" || change.kind === "skill-update" || change.kind === "skill-delete" || change.kind === "skill-create" || change.kind === "skill-edit")) return this.skills.checkUndo(change);
      if (change === null || !change.links?.length || change.status !== "applied" || change.kind === "skill-undo") throw new CapabilityError("CAPABILITY_NOT_FOUND", "没有可以撤销的链接改动");
      const links: PlannedLink[] = [];
      let blocked: string | null = null;
      for (const link of change.links) {
        const path = this.absolute(link.path), occupant = (() => { try { return lstatSync(path); } catch { return null; } })(), target = link.target.startsWith("~/") ? this.absolute(link.target) : link.target;
        const ledger = change.kind === "skill-link" ? (link.action === "create" ? "drop" as const : "set" as const) : null;
        if (link.action === "create") {
          const raw = occupant?.isSymbolicLink() ? (() => { try { return readlinkSync(path); } catch { return null; } })() : null;
          if (raw !== target) { blocked = link.path + " 已不是当初建的链接，没有撤销。"; break; }
          links.push({ path, target, action: "remove", ledger });
        } else {
          if (occupant !== null) { blocked = link.path + " 已被占用，没有撤销。"; break; }
          if (realOf(resolve(dirname(path), target)) === null) { blocked = link.path + " 原来指向的 " + link.target + " 已不存在，没有撤销。"; break; }
          links.push({ path, target, action: "create", ledger });
        }
      }
      const directory = dirname(links[0]?.path ?? this.absolute(change.links[0]!.path));
      return this.offerLinks("link-undo", change.harnessId ?? "", change.subject, false, directory, blocked === null ? links : [], "harnesshub",
        ["撤销 " + change.links.length + " 个链接改动：删掉当初建的，放回当初删的。"], blocked, false);
    });
  }
  private offerLinks(change: "skill-link" | "link-cleanup" | "link-undo", harnessId: string, subject: string, enabled: boolean, directory: string, links: readonly PlannedLink[],
    current: CapabilityChangeCheck["current"], notes: readonly string[], blocked: string | null, createDirectory: boolean): CapabilityChangeCheck {
    const shown = links.map((link): CapabilityLinkChange => ({ path: this.shown(link.path), target: isAbsolute(link.target) ? this.shown(link.target) : link.target, action: link.action }));
    return this.offer({ kind: change, harnessId, name: subject, enabled, file: this.shown(directory), command: null, diff: null, rewrite: null, links: shown, current, notes, blocked },
      (_, expires, check) => ({ kind: "links", change, harnessId, subject, expires, directory, links, createDirectory, check }));
  }

  /**
   * Runs Claude's commands on a copy of its file (`CLAUDE_CONFIG_DIR` and HOME pointing into a private 0700 directory
   * that is removed afterwards) and returns what they wrote.
   */
  private async predictClaude(steps: readonly (readonly string[])[], before: Buffer | null): Promise<Buffer> {
    const stage = await realpath(await mkdtemp(join(tmpdir(), "harnesshub-claude-copy-"))), config = join(stage, "config"), home = join(stage, "home"), copy = join(config, ".claude.json");
    try {
      await mkdir(config, { mode: 0o700 }); await mkdir(home, { mode: 0o700 });
      if (before !== null) await writeFile(copy, before, { mode: 0o600 });
      for (const step of steps) await (this.options.claude ?? systemClaude(this.options.environment))(step, { env: { CLAUDE_CONFIG_DIR: config, HOME: home }, writable: [stage], files: [] }, AbortSignal.timeout(60_000));
      return await readFile(copy);
    } finally { await rm(stage, { recursive: true, force: true }); }
  }
  /** Runs OpenClaw's command on a copy of its file in a private state directory and returns what it wrote. */
  private async predict(args: readonly string[], before: Buffer): Promise<Buffer> {
    const stage = await realpath(await mkdtemp(join(tmpdir(), "harnesshub-openclaw-copy-"))), state = join(stage, "state"), copy = join(state, "openclaw.json");
    try {
      await mkdir(state, { mode: 0o700 }); await writeFile(copy, before, { mode: 0o600 });
      await (this.options.openclaw ?? systemOpenclaw(this.options.environment))(args, { env: { OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: copy }, writable: [state] }, AbortSignal.timeout(60_000));
      return await readFile(copy);
    } finally { await rm(stage, { recursive: true, force: true }); }
  }
  /** The switch plan for one Harness, from its current file; a file that cannot be changed safely blocks with the reason. */
  private async plan(table: HarnessReadTable, request: SwitchRequest): Promise<{ file: string; read: TargetRead; plan: SwitchPlan | null; blocked: string | null }> {
    const source = table.skills.switch!, context = this.context(request.harnessId);
    let file: string, earlier: unknown[] = [];
    switch (source.kind) {
      case "opencode-permission": {
        const reads = source.files.map(path => ({ path, read: readTarget(path) })), existing = reads.filter(item => item.read.state !== "missing");
        const chosen = existing.at(-1) ?? reads[1] ?? reads[0]!;
        file = chosen.path;
        try { earlier = reads.slice(0, reads.indexOf(chosen)).flatMap(item => item.read.state === "ok" ? [parsed(item.read.bytes.toString("utf8"), "jsonc")] : []); }
        catch (error) { return { file, read: chosen.read, plan: null, blocked: "无法安全修改：" + (error instanceof Error ? error.message : "另一个配置文件无法解析") }; }
        break;
      }
      case "openclaw-entries": file = harnessDirectories(this.options.environment).openclawConfig; break;
      default: file = source.file;
    }
    const read = readTarget(file);
    if (read.state === "refused") return { file, read, plan: null, blocked: "无法修改 " + this.shown(file) + "：" + read.reason + "。" };
    if (read.state === "missing" && !read.directory) return { file, read, plan: null, blocked: "无法修改：" + this.shown(dirname(file)) + " 不存在。" };
    if (read.state === "missing" && source.kind === "openclaw-entries") return { file, read, plan: null, blocked: "OpenClaw 还没有配置文件。" };
    const content = read.state === "ok" ? read.bytes.toString("utf8") : "";
    try {
      switch (source.kind) {
        case "claude-skill-overrides": return { file, read, plan: claudeSwitch(file, content, request, context), blocked: null };
        case "codex-skills-config": return { file, read, plan: codexSwitch(file, content, request, context), blocked: null };
        case "gemini-skills-disabled": return { file, read, plan: listSwitch(file, content, "jsonc", request, context, ["改完后在 Gemini 里用 /skills reload 或重开才生效。"]), blocked: null };
        case "hermes-skills-disabled": return { file, read, plan: listSwitch(file, content, "yaml", request, context, ["正在运行的 Hermes 网关（QQ 等消息渠道）不会被 HarnessHub 重启；长驻的 Hermes 进程要 /reload-skills 或重启后才生效。"]), blocked: null };
        case "opencode-permission": return { file, read, plan: opencodeSwitch(file, content, earlier, request, context), blocked: null };
        case "openclaw-entries": return { file, read, plan: openclawSwitch(file, content, request, context), blocked: null };
      }
    } catch (error) {
      if (error instanceof UnsafeEdit) return { file, read, plan: null, blocked: "无法安全修改 " + this.shown(file) + "：" + error.message + "。" };
      throw error;
    }
  }
  /**
   * Running sessions that read or overwrite the file (Claude Code, Gemini CLI), counted without their arguments. Claude
   * Code watches its skill switches; whether a running session picks up a new MCP server is not promised.
   */
  private async runningNotes(harnessId: string, setting: "skills" | "mcp" | "instructions" | "subagents" | "plugins"): Promise<readonly string[]> {
    const pattern = RUNNING[harnessId];
    if (!pattern) return [];
    let table: ReturnType<typeof parseProcessTable> = null;
    try { table = parseProcessTable(await (this.options.processes ?? systemProcesses)(AbortSignal.timeout(5000))); } catch { table = null; }
    if (table === null) return ["没能读取正在运行的程序。"];
    // Cursor's helper processes share its name; only the editor's main process and cursor-agent are counted.
    const count = table.filter(row => harnessId === "cursor" ? /\/Cursor\.app\/Contents\/MacOS\/Cursor(?:\s|$)/u.test(row.command) || programName(row.command) === "cursor-agent" : pattern.test(programName(row.command))).length;
    if (!count) return [];
    return harnessId === "claude" ? ["有 " + count + " 个 Claude Code 进程在运行" + (setting === "skills" ? "，它们会立即读到这次改动。" : setting === "plugins" ? "；运行中的会话可能把旧的设置写回，那时漂移列表会显示。" : "。")]
      : harnessId === "cursor" ? ["有 " + count + " 个 Cursor 进程在运行（编辑器或 cursor-agent），它可能自行改写 mcp.json；写入后会立即核对。"]
      // ChatGPT's app and editor extensions bring their own Codex, which uses ~/.codex too.
      : harnessId === "codex" ? ["有 " + count + " 个 Codex 进程在运行（可能是 ChatGPT 应用或编辑器扩展内置的 Codex，它们也用 ~/.codex）；运行中的会话不受影响，新开的会话才读到改动。"
        + (setting === "plugins" ? "它们也可能改写 config.toml：确认前文件变了会要求重新检查，事后被改回会出现在漂移列表里。" : "")]
      // A running Gemini CLI writes its settings back, not its instructions file.
      : setting === "instructions" ? ["有 " + count + " 个 Gemini CLI 进程在运行；它们可以用 /memory refresh 重新读取指令。"]
      : setting === "subagents" ? ["有 " + count + " 个 Gemini CLI 进程在运行；运行中的会话不读新的子 Agent，新会话才读到。"]
      : ["有 " + count + " 个 Gemini CLI 进程在运行。运行中的会话保存设置时会按启动时的快照覆盖 settings.json，可能冲掉这次改动；建议先退出它们。"];
  }

  /** Whether cc-switch runs now (its app's program `cc-switch`); null when the running programs cannot be read. */
  private async ccSwitchRunning(): Promise<boolean | null> {
    let table: ReturnType<typeof parseProcessTable> = null;
    try { table = parseProcessTable(await (this.options.processes ?? systemProcesses)(AbortSignal.timeout(5000))); } catch { table = null; }
    return table === null ? null : table.some(row => /(?:^|\/)cc-switch(?:\s|$)/u.test(row.command));
  }

  /**
   * Applies a confirmed check once; a replay of the same command returns its first result, as `history` shows it. A write
   * that fails once started is answered and recorded as `failed` rather than thrown.
   */
  apply(fingerprint: string, commandId: string): Promise<CapabilityChangeView> {
    if (!FINGERPRINT.test(fingerprint) || !COMMAND.test(commandId)) return Promise.reject(new CapabilityError("INVALID_INPUT", "invalid change confirmation"));
    const replay = this.replay(commandId, fingerprint);
    if (replay) return Promise.resolve(replay);
    const prepared = this.prepared.get(fingerprint);
    if (!prepared || prepared.kind === "restore" || prepared.expires < this.now().getTime()) return Promise.reject(new CapabilityError("CAPABILITY_CHECK_EXPIRED", "这次确认已过期或已用过，请重新检查"));
    if (prepared.check.blocked !== null || (prepared.kind === "edit" && prepared.plan === null) || (prepared.kind === "links" && !prepared.links.length))
      return Promise.reject(new CapabilityError("CAPABILITY_TARGET_REFUSED", prepared.check.blocked ?? "这项检查不能执行"));
    this.prepared.delete(fingerprint);
    if (prepared.kind === "package") return this.skills.apply(prepared, view => { this.owned(); this.store.saveChange(commandId, hash(fingerprint), view); });
    if (prepared.kind === "edit" && prepared.plan?.kind === "command" && prepared.plan.runner === "claude") return this.applyClaude(prepared, fingerprint, commandId);
    return prepared.kind === "edit" ? this.applyEdit(prepared, fingerprint, commandId) : this.applyLinks(prepared, fingerprint, commandId);
  }
  private applyEdit(prepared: PreparedEdit, fingerprint: string, commandId: string): Promise<CapabilityChangeView> {
    const plan = prepared.plan!;
    return this.serial(plan.file, async () => {
      this.owned();
      const current = readTarget(plan.file), expected = prepared.before === null ? null : sha256(prepared.before);
      if (!(expected === null ? current.state === "missing" : current.state === "ok" && sha256(current.bytes) === expected)) throw new CapabilityError("CAPABILITY_TARGET_CHANGED", "文件在确认之后被改动过，没有写入；请重新检查");
      const id = randomUUID(), at = this.now().toISOString(), backupId = prepared.before === null ? null : randomUUID();
      if (backupId !== null) this.store.saveBackup({ id: backupId, file: plan.file, createdAt: at, changeId: id, subject: prepared.subject }, prepared.before!);
      const beforeText = prepared.before?.toString("utf8") ?? "";
      let error: { code: string; message: string } | null = null, written: Buffer | null = null, made = false, leftDirectory = false;
      try {
        // A directory the plan creates: made here, private, its parent already there; taken away again if nothing is written into it.
        if (plan.kind === "edit" && plan.directory === "create" && !existsSync(dirname(plan.file))) { mkdirSync(dirname(plan.file), { mode: 0o700 }); made = true; }
        if (plan.kind === "edit" && plan.remove === true) removeTarget(plan.file, expected!);
        else if (plan.kind === "edit") replaceTarget(plan.file, expected, Buffer.from(plan.after, "utf8"), prepared.mode);
        else await (this.options.openclaw ?? systemOpenclaw(this.options.environment))(plan.args, { env: {}, writable: [dirname(plan.file)] }, AbortSignal.timeout(60_000));
        const after = readTarget(plan.file);
        if (plan.kind === "edit" && plan.remove === true) {
          if (after.state !== "missing") error = { code: "CAPABILITY_READBACK_MISMATCH", message: "删除后这个文件仍在" };
          // The directory HarnessHub created goes only when nothing at all is left in it; one that is not empty stays, and so does its record.
          else if (plan.directory === "remove") { if (readdirSync(dirname(plan.file)).length === 0) rmdirSync(dirname(plan.file)); else leftDirectory = true; }
        }
        else if (after.state !== "ok") error = { code: "CAPABILITY_READBACK_FAILED", message: "写入后读不到这个文件" };
        else {
          written = after.bytes;
          const afterText = after.bytes.toString("utf8");
          if (plan.kind === "edit" && afterText !== plan.after) error = { code: "CAPABILITY_READBACK_MISMATCH", message: "写入后的内容与计划不一致" };
          else if (plan.kind === "edit" ? !plan.check(parsed(beforeText, plan.format), parsed(afterText, plan.format)) : !plan.check(parsed(afterText, "json5"))) error = { code: "CAPABILITY_READBACK_MISMATCH", message: "写入后的设置与计划不一致" };
          else if (plan.kind === "command" && prepared.predicted !== null && !isDeepStrictEqual(openclawContent(after.bytes), openclawContent(prepared.predicted))) error = { code: "CAPABILITY_READBACK_MISMATCH", message: "OpenClaw 写入的内容与预演不一致" };
        }
      } catch (failure) {
        if (made) { try { if (readdirSync(dirname(plan.file)).length === 0) rmdirSync(dirname(plan.file)); } catch { /* left as it is */ } }
        if (failure instanceof CapabilityError && failure.code === "CAPABILITY_TARGET_CHANGED") { if (backupId !== null) this.store.dropBackup(backupId); throw failure; }
        error = { code: failure instanceof CapabilityError ? failure.code : "CAPABILITY_WRITE_FAILED", message: failedMessage(plan.kind === "edit" && plan.remove === true ? "删除" : "写入", this.shown(plan.file), failure) };
        const after = readTarget(plan.file); written = after.state === "ok" ? after.bytes : null;
      }
      if (backupId !== null && written !== null) this.store.setWritten(backupId, written);
      // A file the change deleted: its backup records that the change left no file, so a later restore knows nobody changed it since.
      else if (backupId !== null && plan.kind === "edit" && plan.remove === true && error === null) this.store.setWrittenDeleted(backupId);
      if (error === null) {
        if (plan.ledger === "set") this.store.setLedger({ harnessId: prepared.harnessId, file: plan.file, key: plan.key, valueHash: hash(JSON.stringify(plan.written ?? null)), previous: plan.previous, changeId: id, at }, plan.current === "harnesshub");
        else this.store.dropLedger(prepared.harnessId, plan.file, plan.key);
        for (const other of plan.alsoLedger ?? []) {
          if (leftDirectory && other.key === "dir/created") continue;
          if (other.action === "drop") this.store.dropLedger(prepared.harnessId, other.file, other.key);
          else this.store.setLedger({ harnessId: prepared.harnessId, file: other.file, key: other.key, valueHash: hash(JSON.stringify(true)), previous: null, changeId: id, at }, false);
        }
      }
      // A deleted file counts as changed: what it held is the diff, all removed.
      const deleted = plan.kind === "edit" && plan.remove === true && error === null, changed = deleted || (written !== null && (prepared.before === null || !written.equals(prepared.before)));
      const view: CapabilityChangeView = { id, kind: prepared.change, harnessId: prepared.harnessId, subject: prepared.subject, file: this.shown(plan.file), status: error === null ? "applied" : "failed",
        diff: changed ? displayed(unifiedDiff(this.shown(plan.file), prepared.before === null ? null : beforeText, deleted ? "" : written!.toString("utf8"), 2), this.options.homes) : null,
        backupId: changed ? backupId : null, error, notes: error === null ? [...prepared.check.notes, ...(leftDirectory ? ["目录里还有别的东西，保留了 HarnessHub 新建的目录。"] : [])]
          : [...(changed && backupId !== null ? ["可以在“修改与备份”里恢复修改前的文件。"] : [])], at };
      this.store.saveChange(commandId, hash(fingerprint), view);
      return view;
    });
  }
  /**
   * Makes a confirmed change through Claude's own commands. Running sessions rewrite `.claude.json` all the time, so only
   * the server's entry must be as the check saw it; the file as it is now is backed up, the commands run in the sandbox
   * (Claude's file and its siblings, its backups and telemetry folders, nothing else, no network), and the entry read back
   * must be the one predicted. A session may still write its own copy back later: the drift list shows that.
   */
  private applyClaude(prepared: PreparedEdit, fingerprint: string, commandId: string): Promise<CapabilityChangeView> {
    const plan = prepared.plan as Extract<SwitchPlan, { kind: "command" }>, subtree = plan.subtree ?? [];
    return this.serial(plan.file, async () => {
      this.owned();
      const entry = (bytes: Buffer | null): string => { try { return JSON.stringify(at(bytes === null ? {} : parsed(bytes.toString("utf8"), "jsonc"), subtree) ?? null); } catch { return "unparsed"; } };
      const current = readTarget(plan.file);
      if (current.state === "refused") throw new CapabilityError("CAPABILITY_TARGET_REFUSED", "无法读取 " + this.shown(plan.file) + "：" + current.reason);
      const now = current.state === "ok" ? current.bytes : null;
      if (entry(now) !== entry(prepared.before)) throw new CapabilityError("CAPABILITY_TARGET_CHANGED", "这个服务器在确认之后被改动过，没有写入；请重新检查");
      const id = randomUUID(), at_ = this.now().toISOString(), backupId = now === null ? null : randomUUID();
      if (backupId !== null) this.store.saveBackup({ id: backupId, file: plan.file, createdAt: at_, changeId: id, subject: prepared.subject }, now!);
      const configured = this.options.environment.values.CLAUDE_CONFIG_DIR, folder = configured ? configured.replace(/^~(?=$|\/)/u, this.options.environment.home) : join(this.options.environment.home, ".claude");
      let error: { code: string; message: string } | null = null, written: Buffer | null = null;
      try {
        for (const step of plan.steps ?? [plan.args])
          await (this.options.claude ?? systemClaude(this.options.environment))(step, { env: {}, writable: [join(folder, "backups"), join(folder, "telemetry")], files: [plan.file] }, AbortSignal.timeout(60_000));
        const after = readTarget(plan.file);
        if (after.state !== "ok") error = { code: "CAPABILITY_READBACK_FAILED", message: "写入后读不到这个文件" };
        else {
          written = after.bytes;
          if (!plan.check(parsed(after.bytes.toString("utf8"), "jsonc")) || (prepared.predicted !== null && entry(after.bytes) !== entry(prepared.predicted))) error = { code: "CAPABILITY_READBACK_MISMATCH", message: "写入后的服务器与预演不一致" };
        }
      } catch (failure) {
        error = { code: failure instanceof CapabilityError ? failure.code : "CAPABILITY_WRITE_FAILED", message: failedMessage("写入", this.shown(plan.file), failure) };
        const after = readTarget(plan.file); written = after.state === "ok" ? after.bytes : null;
      }
      if (backupId !== null && written !== null) this.store.setWritten(backupId, written);
      if (error === null) {
        if (plan.ledger === "set") this.store.setLedger({ harnessId: prepared.harnessId, file: plan.file, key: plan.key, valueHash: hash(JSON.stringify(plan.written ?? null)), previous: plan.previous, changeId: id, at: at_ }, plan.current === "harnesshub");
        else this.store.dropLedger(prepared.harnessId, plan.file, plan.key);
      }
      const changed = written !== null && (now === null || !written.equals(now));
      const view: CapabilityChangeView = { id, kind: prepared.change, harnessId: prepared.harnessId, subject: prepared.subject, file: this.shown(plan.file), status: error === null ? "applied" : "failed",
        diff: changed ? displayed(unifiedDiff(this.shown(plan.file), now === null ? null : now.toString("utf8"), written!.toString("utf8"), 2), this.options.homes) : null,
        backupId: changed ? backupId : null, error, notes: error === null ? prepared.check.notes : [...(changed && backupId !== null ? ["可以在“修改与备份”里恢复修改前的文件。"] : [])], at: at_ };
      this.store.saveChange(commandId, hash(fingerprint), view);
      return view;
    });
  }
  /**
   * Makes a confirmed change of links: every link is checked to be as the check left it before any is touched (a
   * difference refuses all of them), then each is created or removed and read back; what was done is recorded, so a
   * partial failure can still be undone.
   */
  private applyLinks(prepared: PreparedLinks, fingerprint: string, commandId: string): Promise<CapabilityChangeView> {
    return this.serial("links:" + prepared.directory, async () => {
      this.owned();
      const lstat = (path: string) => { try { return lstatSync(path); } catch { return null; } };
      for (const link of prepared.links) {
        const occupant = lstat(link.path);
        const same = link.action === "create" ? occupant === null && realOf(resolve(dirname(link.path), link.target)) !== null
          : occupant?.isSymbolicLink() === true && (() => { try { return readlinkSync(link.path) === link.target; } catch { return false; } })();
        if (!same) throw new CapabilityError("CAPABILITY_TARGET_CHANGED", this.shown(link.path) + " 在确认之后变了，没有改动任何链接；请重新检查");
      }
      const id = randomUUID(), at = this.now().toISOString(), done: PlannedLink[] = [];
      let error: { code: string; message: string } | null = null;
      try {
        if (prepared.createDirectory && !existsSync(prepared.directory)) mkdirSync(prepared.directory, { mode: 0o755 });
        for (const link of prepared.links) {
          if (link.action === "create") symlinkSync(link.target, link.path); else unlinkSync(link.path);
          done.push(link);
          const after = lstat(link.path);
          const ok = link.action === "create" ? after?.isSymbolicLink() === true && readlinkSync(link.path) === link.target : after === null;
          if (!ok) { error = { code: "CAPABILITY_READBACK_MISMATCH", message: this.shown(link.path) + " 改动后与计划不一致" }; break; }
        }
      } catch (failure) { error = { code: "CAPABILITY_WRITE_FAILED", message: (code(failure) ? code(failure) + " " : "") + this.shown(done.length < prepared.links.length ? prepared.links[done.length]!.path : prepared.directory) }; }
      for (const link of done) {
        const key = "link/" + link.path;
        if (link.ledger === "set") this.store.setLedger({ harnessId: prepared.harnessId, file: link.path, key, valueHash: hash(JSON.stringify(link.target)), previous: null, changeId: id, at }, false);
        if (link.ledger === "drop") this.store.dropLedger(prepared.harnessId, link.path, key);
      }
      const links = done.map((link): CapabilityLinkChange => ({ path: this.shown(link.path), target: isAbsolute(link.target) ? this.shown(link.target) : link.target, action: link.action }));
      const view: CapabilityChangeView = { id, kind: prepared.change, harnessId: prepared.harnessId || null, subject: prepared.subject, file: this.shown(prepared.directory), status: error === null ? "applied" : "failed",
        diff: null, backupId: null, error, notes: error === null ? prepared.check.notes : done.length ? ["已改动的 " + done.length + " 个链接可以撤销。"] : [], links, at };
      this.store.saveChange(commandId, hash(fingerprint), view);
      return view;
    });
  }
  private replay(commandId: string, fingerprint: string): CapabilityChangeView | null {
    const stored = this.store.change(commandId);
    if (stored === null) return null;
    if (stored.payloadHash !== hash(fingerprint)) throw new CapabilityError("INVALID_INPUT", "这个命令编号已用于另一项修改");
    return this.recorded(stored.view);
  }
  /**
   * A stored change as answered: every string in it through `homeText`. A record an older build wrote may name a path by
   * its absolute home form (a failed write kept the system's message then); it is shown with ~, one record at a time,
   * where the privacy guard would otherwise refuse the whole answer.
   */
  private recorded(view: CapabilityChangeView, show = homeText(this.options.homes)): CapabilityChangeView { return textsThrough(view, show) as CapabilityChangeView; }

  /**
   * HarnessHub's recent changes and the backups it keeps, newest first, and what it wrote that is no longer in place. The
   * stored text is shown with ~ for the home directory (`recorded`), so an older record cannot keep the history from answering.
   */
  async history(): Promise<CapabilityHistory> {
    const snapshots = await this.skills.snapshotStats(), show = homeText(this.options.homes);
    return { changes: this.store.changes(50).map(view => this.recorded(view, show)),
      backups: this.store.backups().map(item => ({ id: item.id, file: this.shown(item.file), createdAt: item.createdAt, bytes: item.bytes, changeId: item.changeId, subject: show(item.subject) })),
      drift: await this.drift(), orphans: await this.orphans(), snapshots: { ...snapshots, keep: SKILL_SNAPSHOT_CHANGES } };
  }
  /**
   * The switch settings HarnessHub wrote for a skill that its Harness no longer has, by a quick look for the skill's folder
   * in the Harness's skill folders (the clearing check makes sure with a full read). Read only.
   */
  private async orphans(): Promise<readonly CapabilityOrphan[]> {
    const { tables } = await this.tables(), found: CapabilityOrphan[] = [];
    for (const entry of this.store.ledgerEntries()) {
      if (entry.key.startsWith("link/") || entry.key.startsWith("skills.external_dirs/") || entry.key.startsWith("mcp/") || entry.key.startsWith("instructions/") || entry.key.startsWith("subagent/") || entry.key.startsWith("plugin/") || FACT.test(entry.key)) continue;
      const table = tables.find(item => item.harnessId === entry.harnessId), rest = entry.key.slice(entry.key.indexOf("/") + 1);
      if (table === undefined) continue;
      const kept = entry.key.startsWith("skills.config/") ? existsSync(rest) : skillFolderSomewhere(rest, table);
      if (!kept) found.push({ id: driftId(entry), kind: "skill", harnessId: entry.harnessId, subject: entry.key.startsWith("skills.config/") ? basename(dirname(rest)) : rest, file: this.shown(entry.file) });
    }
    // HarnessHub's `false` for a Claude Code plugin no longer installed for the user, still in place (a changed one is drift).
    const claude = tables.find(item => item.harnessId === "claude")?.plugins, offs = this.store.ledgerEntries().filter(entry => entry.harnessId === "claude" && entry.key.startsWith("plugin/") && entry.valueHash === hash(JSON.stringify(false)));
    if (claude?.kind === "claude" && offs.length) {
      const installRecord = readTarget(claude.installed);
      let installs: Readonly<Record<string, unknown>> | null = null;
      try { installs = installRecord.state === "ok" ? record(at(parsed(installRecord.bytes.toString("utf8"), "json"), ["plugins"])) : installRecord.state === "missing" ? {} : null; } catch { installs = null; }
      const shared = this.sharedEntries(await resolveHermesHome(this.options.environment));
      for (const entry of installs === null ? [] : offs) {
        const id = entry.key.slice("plugin/".length), value = own(installs!, id), user = (Array.isArray(value) ? value : value === undefined ? [] : [value]).map(record).some(item => item.scope === undefined || item.scope === "user");
        if (!user && this.driftState(entry, shared, new Map()) === null) found.push({ id: driftId(entry), kind: "plugin", harnessId: entry.harnessId, subject: id, file: this.shown(entry.file) });
      }
    }
    return found;
  }
  /**
   * Prepares clearing an orphaned switch setting: turning the skill back on in that Harness through the usual switch check,
   * which is allowed for a skill it no longer has only while the setting is the one HarnessHub wrote.
   */
  checkOrphanClear(id: string, installed: readonly InstalledHarness[]): Promise<CapabilityChangeCheck> {
    let entry: LedgerEntry;
    try { entry = this.driftEntry(id); } catch (error) { return Promise.reject(error); }
    if (entry.key.startsWith("plugin/")) {
      const plugin = entry;
      if (plugin.valueHash !== hash(JSON.stringify(false))) return Promise.reject(new CapabilityError("CAPABILITY_NOT_FOUND", "这不是停用设置"));
      return this.checking(() => this.preparePluginSwitch({ harnessId: plugin.harnessId, id: plugin.key.slice("plugin/".length), enabled: true, orphan: plugin }, installed));
    }
    if (entry.key.startsWith("link/") || entry.key.startsWith("skills.external_dirs/") || entry.key.startsWith("mcp/") || entry.key.startsWith("instructions/") || entry.key.startsWith("subagent/") || FACT.test(entry.key))
      return Promise.reject(new CapabilityError("CAPABILITY_NOT_FOUND", "这不是停用设置"));
    const rest = entry.key.slice(entry.key.indexOf("/") + 1), codex = entry.key.startsWith("skills.config/");
    return this.checking(() => this.prepareSwitch({ harnessId: entry.harnessId, name: codex ? basename(dirname(rest)) : rest, enabled: true, via: codex ? this.shown(dirname(rest)) : null, orphan: entry }, installed));
  }
  /**
   * The settings and links HarnessHub's ledger says it wrote that are no longer as it wrote them (ADR-045 §10): each
   * setting read from its file the way its switch reads it, each link read back. Read only; nothing is put back.
   */
  async drift(): Promise<readonly CapabilityDrift[]> {
    const shared = this.sharedEntries(await resolveHermesHome(this.options.environment)), reads = new Map<string, TargetRead>();
    // A fact about a file (that HarnessHub created it) is not something written into it.
    return this.store.ledgerEntries().filter(entry => !FACT.test(entry.key)).flatMap(entry => { const state = this.driftState(entry, shared, reads); return state === null ? [] : [this.driftView(entry, state)]; });
  }
  /** Whether a ledger entry still holds what HarnessHub wrote (null), or how it differs; `reads` keeps each file read once. */
  private driftState(entry: LedgerEntry, shared: (raw: string) => boolean, reads: Map<string, TargetRead>): CapabilityDriftState | null {
    if (entry.key.startsWith("link/")) {
      const occupant = (() => { try { return lstatSync(entry.file); } catch { return null; } })();
      if (occupant === null) return "removed";
      const raw = occupant.isSymbolicLink() ? (() => { try { return readlinkSync(entry.file); } catch { return null; } })() : null;
      return raw !== null && hash(JSON.stringify(raw)) === entry.valueHash ? null : "changed";
    }
    const read = reads.get(entry.file) ?? readTarget(entry.file);
    reads.set(entry.file, read);
    if (read.state === "missing") return "removed";
    if (read.state === "refused") return "unreadable";
    let value: unknown;
    try { value = heldValue(entry.harnessId, entry.key, read.bytes.toString("utf8"), shared); } catch { return "unreadable"; }
    return value === undefined ? "removed" : hash(JSON.stringify(value)) === entry.valueHash ? null : "changed";
  }
  private driftView(entry: LedgerEntry, state: CapabilityDriftState): CapabilityDrift {
    const rest = entry.key.slice(entry.key.indexOf("/") + 1), change = this.store.changeById(entry.changeId);
    const kind = entry.key.startsWith("link/") ? "skill-link" as const : entry.key.startsWith("skills.external_dirs/") ? "shared-dir" as const : entry.key.startsWith("mcp/") ? "mcp" as const
      : entry.key.startsWith("instructions/") ? "instructions" as const : entry.key.startsWith("subagent/") ? "subagent" as const : entry.key.startsWith("plugin/") ? "plugin" as const : "skill-switch" as const;
    const subject = kind === "shared-dir" ? SHARED_ENTRY : kind === "instructions" ? "指令" : entry.key.startsWith("skills.config/") ? change?.subject ?? basename(dirname(rest))
      : kind === "skill-link" ? change?.subject ?? basename(rest) : rest;
    return { id: driftId(entry), kind, harnessId: entry.harnessId, subject, file: this.shown(entry.file), state, changeId: entry.changeId, at: entry.at };
  }
  private driftEntry(id: string): LedgerEntry {
    const entry = DRIFT.test(id) ? this.store.ledgerEntries().find(item => !FACT.test(item.key) && driftId(item) === id) : undefined;
    if (entry === undefined) throw new CapabilityError("CAPABILITY_NOT_FOUND", "HarnessHub 没有在跟踪这项设置");
    return entry;
  }
  /**
   * Prepares putting back what HarnessHub wrote for a ledger entry, through that change's usual check: the switch, the
   * shared directory entry, or the link. Nothing is put back without the user's confirmation.
   */
  checkReapply(id: string, installed: readonly InstalledHarness[]): Promise<CapabilityChangeCheck> {
    let entry: LedgerEntry;
    try { entry = this.driftEntry(id); } catch (error) { return Promise.reject(error); }
    const view = this.driftView(entry, "removed");
    if (view.kind === "skill-link") return this.checkSkillLink({ harnessId: entry.harnessId, name: view.subject, present: true }, installed);
    if (view.kind === "shared-dir") return this.checkSharedDir({ harnessId: entry.harnessId, present: true }, installed);
    if (view.kind === "mcp") return this.checkMcpSync(view.subject, entry.harnessId, true, installed);
    if (view.kind === "instructions") return this.checkInstructionsSync(entry.harnessId, new Set(["overwrite"]), installed);
    if (view.kind === "subagent") return this.checkSubagentSync(view.subject, entry.harnessId, true, installed);
    if (view.kind === "plugin") return this.checkPluginSwitch({ harnessId: entry.harnessId, id: view.subject, enabled: entry.valueHash === hash(JSON.stringify(true)) }, installed);
    // OpenCode's ledger holds either the "deny" of turning a skill off or the "allow" that turned it on over another rule.
    const enabled = entry.key.startsWith("permission.skill/") && entry.valueHash === hash(JSON.stringify("allow"));
    const via = entry.key.startsWith("skills.config/") ? this.shown(dirname(entry.key.slice("skills.config/".length))) : null;
    return this.checkSkillSwitch({ harnessId: entry.harnessId, name: view.subject, enabled, via }, installed);
  }
  /**
   * Stops tracking a ledger entry that is no longer as HarnessHub wrote it: HarnessHub then treats the setting or link
   * as someone else's. No file changes. Refused while it still holds what HarnessHub wrote; an entry already forgotten
   * returns `forgotten: false`.
   */
  forget(id: string): Promise<{ readonly forgotten: boolean }> {
    if (!DRIFT.test(id)) return Promise.reject(new CapabilityError("INVALID_INPUT", "invalid ledger entry"));
    const found = this.store.ledgerEntries().find(item => !FACT.test(item.key) && driftId(item) === id);
    if (found === undefined) return Promise.resolve({ forgotten: false });
    return this.serial(found.key.startsWith("link/") ? "links:" + dirname(found.file) : found.file, async () => {
      this.owned();
      const entry = this.store.ledgerEntries().find(item => driftId(item) === id);
      if (entry === undefined) return { forgotten: false };
      if (this.driftState(entry, this.sharedEntries(await resolveHermesHome(this.options.environment)), new Map()) === null)
        throw new CapabilityError("CAPABILITY_TARGET_REFUSED", "它仍是 HarnessHub 写的样子，不需要停止跟踪");
      this.store.dropLedger(entry.harnessId, entry.file, entry.key);
      return { forgotten: true };
    });
  }
  /** Prepares restoring a backup: what it changes now, and whether the file was changed by someone else after HarnessHub. */
  async checkRestore(backupId: string): Promise<CapabilityRestoreCheck> {
    if (this.closed) throw new CapabilityError("OWNERSHIP_LOST", "capability changes are closed");
    this.prune();
    const backup = CHANGE.test(backupId) ? this.store.backup(backupId) : null;
    if (backup === null) throw new CapabilityError("CAPABILITY_NOT_FOUND", "没有这份备份");
    const bytes = this.store.backupBytes(backupId), current = readTarget(backup.file);
    if (current.state === "refused") throw new CapabilityError("CAPABILITY_TARGET_REFUSED", "无法恢复：" + current.reason);
    const currentSha = current.state === "ok" ? sha256(current.bytes) : null;
    const changedSince = backup.writtenSha256 === null || (backup.writtenSha256 === WRITTEN_DELETED ? current.state !== "missing" : currentSha !== backup.writtenSha256);
    const fingerprint = randomBytes(32).toString("hex"), expires = this.now().getTime() + CAPABILITY_CHECK_MS;
    const check: CapabilityRestoreCheck = { backupId, file: this.shown(backup.file), diff: displayed(unifiedDiff(this.shown(backup.file), current.state === "ok" ? current.bytes.toString("utf8") : null, bytes.toString("utf8"), 2), this.options.homes),
      changedSince, notes: [...(changedSince ? ["这个文件在 HarnessHub 改动之后又被改过，恢复会连这些改动一起撤销。"] : []), current.state === "ok" ? "恢复前会先备份现在的文件。" : "现在没有这个文件，恢复会重新建立它（权限 0600）。"],
      fingerprint, expiresAt: new Date(expires).toISOString() };
    this.prepared.set(fingerprint, { kind: "restore", expires, backup, current: currentSha, mode: current.state === "ok" ? current.mode : 0o600, check });
    return check;
  }
  /** Restores a confirmed backup once, after backing up the file as it is now; a write that fails is recorded as `failed`, like `apply`. */
  restore(fingerprint: string, commandId: string): Promise<CapabilityChangeView> {
    if (!FINGERPRINT.test(fingerprint) || !COMMAND.test(commandId)) return Promise.reject(new CapabilityError("INVALID_INPUT", "invalid restore confirmation"));
    const replay = this.replay(commandId, fingerprint);
    if (replay) return Promise.resolve(replay);
    const prepared = this.prepared.get(fingerprint);
    if (!prepared || prepared.kind !== "restore" || prepared.expires < this.now().getTime()) return Promise.reject(new CapabilityError("CAPABILITY_CHECK_EXPIRED", "这次确认已过期或已用过，请重新检查"));
    this.prepared.delete(fingerprint);
    const file = prepared.backup.file;
    return this.serial(file, async () => {
      this.owned();
      const bytes = this.store.backupBytes(prepared.backup.id), current = readTarget(file);
      const same = prepared.current === null ? current.state === "missing" : current.state === "ok" && sha256(current.bytes) === prepared.current;
      if (!same) throw new CapabilityError("CAPABILITY_TARGET_CHANGED", "文件在确认之后被改动过，没有恢复；请重新检查");
      const id = randomUUID(), at = this.now().toISOString(), backupId = current.state === "ok" ? randomUUID() : null;
      if (backupId !== null && current.state === "ok") this.store.saveBackup({ id: backupId, file, createdAt: at, changeId: id, subject: "恢复“" + prepared.backup.subject + "”之前" }, current.bytes);
      let error: { code: string; message: string } | null = null;
      try { replaceTarget(file, prepared.current, bytes, prepared.mode); const after = readTarget(file); if (after.state !== "ok" || !after.bytes.equals(bytes)) error = { code: "CAPABILITY_READBACK_MISMATCH", message: "恢复后的内容与备份不一致" }; }
      catch (failure) {
        if (failure instanceof CapabilityError && failure.code === "CAPABILITY_TARGET_CHANGED") { if (backupId !== null) this.store.dropBackup(backupId); throw failure; }
        error = { code: "CAPABILITY_WRITE_FAILED", message: failedMessage("恢复", this.shown(file), failure) };
      }
      if (error === null) { this.store.dropLedgerForFile(file); if (backupId !== null) this.store.setWritten(backupId, bytes); }
      const view: CapabilityChangeView = { id, kind: "restore", harnessId: null, subject: prepared.backup.subject, file: this.shown(file), status: error === null ? "applied" : "failed",
        diff: error === null ? prepared.check.diff : null, backupId, error, notes: error === null ? ["已恢复到“" + prepared.backup.subject + "”之前的样子。"] : [], at };
      this.store.saveChange(commandId, hash(fingerprint), view);
      return view;
    });
  }
  /** Stops taking changes, waits for the running ones and closes the record. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.allSettled([...this.running]);
    this.store.close();
  }
}

/** A table reading only the shared directory, the way this Harness finds skills, without its switch or other roots. */
function sharedOnly(table: HarnessReadTable, shared: string, depth: number, find: HarnessReadTable["skills"]["roots"][number]["find"]): HarnessReadTable {
  const { duplicates, requiresDescription, nameMustMatchDirectory } = table.skills;
  return { ...table, skills: { roots: [{ role: "shared", path: shared, precedence: 1, containment: false, depth, ...(find ? { find } : {}) }], duplicates, requiresDescription, nameMustMatchDirectory, switch: null } };
}
/** Whether a folder `name` holding a SKILL.md is in one of a Harness's skill roots, at the depths it reads. */
function skillFolderSomewhere(name: string, table: HarnessReadTable): boolean {
  const look = (directory: string, depth: number): boolean => {
    if (existsSync(join(directory, name, "SKILL.md"))) return true;
    if (depth <= 1) return false;
    let names: string[] = [];
    try { names = readdirSync(directory); } catch { return false; }
    return names.some(child => !child.startsWith(".") && (() => { try { return lstatSync(join(directory, child)).isDirectory(); } catch { return false; } })() && look(join(directory, child), depth - 1));
  };
  return table.skills.roots.some(root => look(root.path, Math.min(root.depth, 3)));
}
/** The opaque name of a ledger entry. */
function driftId(entry: LedgerEntry): string { return hash(entry.harnessId + "\0" + entry.file + "\0" + entry.key).slice(0, 32); }
/** A path's real path, or null when it does not resolve. */
function realOf(path: string): string | null { try { return realpathSync(path); } catch { return null; } }
type Difference = { readonly path: readonly string[]; readonly kind: "added" | "removed" | "changed" };
function differences(left: unknown, right: unknown, path: readonly string[] = []): Difference[] {
  const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
  if (object(left) && object(right)) return [...new Set([...Object.keys(left), ...Object.keys(right)])].flatMap(key => !Object.hasOwn(left, key) ? [{ path: [...path, key], kind: "added" as const }]
    : !Object.hasOwn(right, key) ? [{ path: [...path, key], kind: "removed" as const }] : differences(left[key], right[key], [...path, key]));
  return isDeepStrictEqual(JSON.parse(JSON.stringify(left ?? null)), JSON.parse(JSON.stringify(right ?? null))) ? [] : [{ path, kind: "changed" }];
}
/** The differences of a rewrite outside the target setting and the parents that hold it. */
function besideTarget(beforeText: string, afterText: string, target: readonly string[]): Difference[] {
  const related = (path: readonly string[]) => path.every((key, index) => index >= target.length || target[index] === key);
  return differences(parsed(beforeText, "json5"), parsed(afterText, "json5")).filter(item => !related(item.path));
}
const RESTART_KEYS = new Set(["gateway", "discovery", "canvasHost", "plugins"]);
/** Keys of OpenClaw's hot-reload table that need a Gateway restart, among what a rewrite changes besides its target. */
function rewriteRestarts(beforeText: string, afterText: string, target: readonly string[]): readonly string[] {
  return [...new Set(besideTarget(beforeText, afterText, target).filter(item => RESTART_KEYS.has(item.path[0] ?? "")).map(item => item.path.slice(0, 2).join(".")))];
}
function commentLines(source: string): number { return source.split("\n").filter(line => /(^|[^:"'\\])\/\/|\/\*/u.test(line)).length; }
/** A whole-file rewrite summarized for its confirmation: the target before and after, the other keys it touches, the comments it drops. */
function rewriteSummary(beforeText: string, afterText: string, target: readonly string[]): NonNullable<CapabilityChangeCheck["rewrite"]> {
  const value = (source: string): string | null => { const current = at(parsed(source, "json5"), target); return current === undefined ? null : JSON.stringify(current); };
  const keys = (kind: Difference["kind"]) => [...new Set(besideTarget(beforeText, afterText, target).filter(item => item.kind === kind).map(item => item.path.slice(0, 2).join(".")))].slice(0, 32);
  return { target: target.join("."), before: value(beforeText), after: value(afterText), added: keys("added"), removed: keys("removed"), changed: keys("changed"),
    commentLines: Math.max(0, commentLines(beforeText) - commentLines(afterText)) };
}
/** Prediction and run directories a stopped Gateway left behind: older than ten minutes and this user's own. */
function sweepCopies(): void {
  let names: string[] = [];
  try { names = readdirSync(tmpdir()); } catch { return; }
  for (const name of names) {
    if (!/^harnesshub-openclaw-(?:copy-)?[A-Za-z0-9]{6}$/u.test(name)) continue;
    const path = join(tmpdir(), name);
    try { const info = lstatSync(path); if (info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid?.() && Date.now() - info.mtimeMs > 10 * 60_000) rmSync(path, { recursive: true, force: true }); } catch { /* gone or not ours */ }
  }
}
function systemProcesses(signal: AbortSignal): Promise<string> {
  return runManagementProcess("/bin/ps", ["-axw", "-o", "pid=,ppid=,command="], tmpdir(), { PATH: "/usr/bin:/bin", LANG: "C" }, { stage: tmpdir(), signal, assertOwned: () => {}, log: () => {} }, 4 * 1024 * 1024);
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
 * The user's own `openclaw` (the first on their PATH, the one HarnessHub uses) under macOS's sandbox: it may write only
 * `writable` and a private temporary directory, and every network operation is denied. Its output is never kept, since
 * it may print configuration values.
 */
export function systemOpenclaw(environment: ReadEnvironment): OpenclawRunner {
  return async (args, options, signal) => {
    const executable = onPath("openclaw", environment.values.PATH);
    if (executable === null) throw new CapabilityError("CAPABILITY_COMMAND_FAILED", "找不到 openclaw 命令");
    if (process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec")) throw new CapabilityError("CAPABILITY_PROTECTION_UNAVAILABLE", "运行 openclaw 需要 macOS 的沙箱保护，这里不可用");
    // The sandbox matches real paths: the temporary directory (under /var or /tmp, both links) and the state directory are resolved first.
    const stage = await realpath(await mkdtemp(join(tmpdir(), "harnesshub-openclaw-")));
    try {
      const allowed = [...await Promise.all(options.writable.map(path => realpath(path).catch(() => path))), stage];
      const env = { ...Object.fromEntries(Object.entries(environment.values).filter((entry): entry is [string, string] => typeof entry[1] === "string")), HOME: environment.home, TMPDIR: stage, NO_COLOR: "1", ...options.env };
      await runManagementProcess("/usr/bin/sandbox-exec", ["-p", isolatedSandboxProfile(allowed), executable, ...args], stage, env, { stage, signal, assertOwned: () => {}, log: () => {} }, 1024 * 1024);
    } catch (error) {
      if (error instanceof ManagementError) throw new CapabilityError("CAPABILITY_COMMAND_FAILED", "openclaw " + args.slice(0, 2).join(" ") + " 没有成功（" + (error.code === "CANCELLED" ? "超过 60 秒" : error.code === "PROCESS_FAILED" ? "命令报告失败" : error.code) + "）");
      throw error;
    } finally { await rm(stage, { recursive: true, force: true }); }
  };
}
