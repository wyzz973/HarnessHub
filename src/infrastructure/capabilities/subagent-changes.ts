import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { harnessDirectories, type HarnessReadTable, type ReadEnvironment } from "../../adapters/capability-reads.js";
import { CapabilityError, type CapabilityChangeCheck, type CapabilityChangeView, type SubagentDefinitionView, type SubagentInventoryView, type SubagentTargetView, type SubagentView } from "../../contracts/capabilities.js";
import { at, parseConfig, record, text } from "./formats.js";
import { readTarget, type TargetRead } from "./files.js";
import type { InstalledHarness } from "./scan.js";
import type { CapabilityStore } from "./store.js";
import { canonicalSubagent, readSubagent, renderSubagent, sameNamedSubagents, subagentFile, subagentProblem, subagentStyleProblem, type SubagentDefinition, type SubagentStyle } from "./subagent-definitions.js";
import type { SwitchPlan } from "./switches.js";

/** What the subagent list needs of the change service it belongs to. */
export interface SubagentHost {
  readonly environment: ReadEnvironment;
  readonly store: CapabilityStore;
  /** Every spelling of the home directory, refused in the texts as they are shown with ~. */
  readonly homes: readonly string[];
  now(): Date;
  shown(path: string): string;
  owned(): void;
  tables(): Promise<{ readonly tables: readonly HarnessReadTable[] }>;
  /** Running sessions of the Harness, as notes. */
  runningNotes(harnessId: string): Promise<readonly string[]>;
  /** Offers an edit through the usual check and confirmation (backup, atomic write or removal, read back, ledger). */
  offerEdit(change: "subagent-sync" | "subagent-remove", harnessId: string, subject: string, enabled: boolean, file: string, read: TargetRead, plan: SwitchPlan | null, blocked: string | null,
    notes: readonly string[]): Promise<CapabilityChangeCheck>;
}
const STYLES: Readonly<Record<string, SubagentStyle>> = { claude: "claude", codex: "codex", gemini: "gemini", opencode: "opencode" };
/** Why HarnessHub writes no subagent for a Harness. */
const NOT_WRITTEN: Readonly<Record<string, string>> = {
  cursor: "本机 cursor-agent 只读工作区里的子 Agent，不读家目录；文档所列的家目录位置在 CLI 程序里没有",
  pi: "Pi 没有子 Agent 文件",
  hermes: "Hermes 没有子 Agent 文件",
  openclaw: "OpenClaw 没有子 Agent 文件（它的多 Agent 由 openclaw agents 管理，是另一回事）",
  dsh: "DeepSeek Harness 没有子 Agent 文件（它的 agent preset 在 Web 界面里）",
};
/** What a subagent inherits in each Harness, said before it is written (approver's ruling on step 5, 1.1). */
const INHERITS: Readonly<Record<SubagentStyle, string>> = {
  claude: "这个子 Agent 继承父会话的全部工具和权限模式，也会加载 CLAUDE.md。",
  codex: "这个子 Agent 用父会话的模型与设置，不能放宽父会话的沙箱和审批。",
  gemini: "这个子 Agent 继承父会话的全部工具；用户级的子 Agent 不需要单独确认就会加载。",
  opencode: "这个子 Agent 继承 OpenCode 的全局权限配置。",
};
/** When each Harness reads a new or changed subagent, as its installed version was checked to. */
const EFFECT: Readonly<Record<SubagentStyle, string>> = {
  claude: "新开的 Claude Code 会话读到，包括 HarnessHub 里新开的会话；运行中的会话只有在目录早已存在时才会读到改动。",
  codex: "新开的 Codex 线程读到，包括 ChatGPT 应用与编辑器扩展内置的 Codex；用 HarnessHub 管理的 Provider 的会话读不到（它用私有目录）。",
  gemini: "新开的 Gemini CLI 会话读到（HarnessHub 的每个会话都会重新读）；用 HarnessHub 管理的 Provider 的会话读不到（它用私有目录）。",
  opencode: "新开的 OpenCode 会话读到（每个会话是新进程）。",
};
function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex"); }
/** Where a Harness keeps its user-level subagents (its own directory, the first of the read table) and the other directories it reads them from. */
type Located = { readonly style: SubagentStyle; readonly directory: string; readonly others: readonly { readonly dir: string; readonly recursive: boolean }[] } | { readonly reason: string };

/**
 * HarnessHub's subagent list (ADR-045 §7, step 5): subagents kept as a description and a prompt, written into each
 * Harness that has user-level subagent files as a whole file of HarnessHub's own in that Harness's format, one confirmed
 * check at a time. Another definition of the same name, by that Harness's naming, is never overwritten; one HarnessHub
 * wrote that someone changed or removed is put back only when the user asks. A directory HarnessHub created for its
 * files goes again once its last file does and nothing else is in it.
 */
export class SubagentInventory {
  constructor(private readonly host: SubagentHost) {}

  /** The built-in subagents of the four Harnesses, by name, with the Harness each belongs to (from the read tables). */
  private async reserved(): Promise<ReadonlyMap<string, string>> {
    const { tables } = await this.host.tables();
    return new Map(tables.flatMap(table => (table.reservedSubagents ?? []).map(name => [name, table.harnessId] as const)));
  }
  /** The list, each definition as stored; a row this build cannot read is skipped. */
  private list(): readonly { readonly name: string; readonly definition: SubagentDefinition; readonly updatedAt: string }[] {
    return this.host.store.subagents().flatMap(row => {
      const value = record(row.definition), description = text(value.description), prompt = text(value.prompt);
      return description !== null && prompt !== null ? [{ name: row.name, definition: { description, prompt }, updatedAt: row.updatedAt }] : [];
    });
  }
  /** Where a Harness keeps its subagents, or why HarnessHub writes none there: not installed, not one of the four, or its configuration directory missing. */
  private locate(table: HarnessReadTable | undefined, harnessId: string): Located {
    if (table === undefined) return { reason: "这个 Harness 没有官网安装" };
    const style = STYLES[harnessId], specs = table.subagents;
    if (style === undefined || specs === null || specs.length === 0) return { reason: NOT_WRITTEN[harnessId] ?? "HarnessHub 不写这个 Harness 的子 Agent" };
    const directory = specs[0]!.dir;
    if (!existsSync(dirname(directory))) return { reason: "没有 " + this.host.shown(dirname(directory)) + "，这个 Harness 可能还没有初始化；HarnessHub 不替它新建" };
    return { style, directory, others: specs.map(spec => ({ dir: spec.dir, recursive: spec.recursive })) };
  }
  /**
   * Other definitions of this name the Harness would see besides HarnessHub's file, by its own naming: files in each of
   * its directories, and for Codex a role declared in config.toml. Throws when Codex's config.toml cannot be read.
   */
  private conflicts(name: string, located: Exclude<Located, { reason: string }>): readonly string[] {
    const own = subagentFile(located.directory, name, located.style), found = new Set<string>();
    for (const other of located.others) for (const path of sameNamedSubagents(other.dir, name, located.style, own)) if (other.recursive || dirname(path) === other.dir) found.add(this.host.shown(path));
    if (located.style === "codex") {
      const config = join(dirname(located.directory), "config.toml");
      if (existsSync(config)) {
        const read = readTarget(config), parsed = read.state === "ok" ? parseConfig(read.bytes.toString("utf8"), "toml") : null;
        if (parsed === null || !parsed.ok) throw new CapabilityError("CAPABILITY_TARGET_REFUSED", "读不了 " + this.host.shown(config) + "，不知道那里有没有同名的角色");
        if (at(parsed.value, ["agents", name]) !== undefined) found.add(this.host.shown(config) + " 的 [agents." + name + "]");
      }
    }
    return [...found];
  }
  /** Where one listed subagent stands in one Harness: the list, the ledger and the files compared. */
  private target(name: string, definition: SubagentDefinition, harnessId: string, located: Located): SubagentTargetView {
    if ("reason" in located) return { harnessId, state: "unsupported", reason: located.reason, file: null };
    const file = subagentFile(located.directory, name, located.style), shown = this.host.shown(file), styleProblem = subagentStyleProblem(definition, located.style);
    if (styleProblem !== null) return { harnessId, state: "unsupported", reason: styleProblem, file: shown };
    let conflicts: readonly string[];
    try { conflicts = this.conflicts(name, located); } catch (error) { return { harnessId, state: "unsupported", reason: error instanceof Error ? error.message : "无法核对同名定义", file: shown }; }
    const read = readTarget(file), ledger = this.host.store.ledger(harnessId, file, "subagent/" + name), rendered = renderSubagent(name, definition, located.style);
    if (read.state === "refused") return { harnessId, state: "unsupported", reason: read.reason, file: shown };
    const elsewhere = conflicts.length ? "已有同名的定义：" + conflicts.join("、") + "；" : "";
    if (read.state === "missing") return conflicts.length ? { harnessId, state: "different", reason: elsewhere + "HarnessHub 不覆盖", file: shown }
      : { harnessId, state: ledger ? "removed" : "absent", reason: ledger ? "HarnessHub 写的文件已被外部移除" : null, file: shown };
    const current = read.bytes.toString("utf8"), ours = ledger !== null && ledger.valueHash === hash(current);
    // HarnessHub's own file keeps its state when another definition of the name appears beside it (it can still be removed); writing waits.
    if (current === rendered) return ours ? { harnessId, state: "synced", reason: conflicts.length ? elsewhere + "这个 Harness 只会用其中一个" : null, file: shown }
      : { harnessId, state: conflicts.length ? "different" : "claimable", reason: conflicts.length ? elsewhere + "HarnessHub 不覆盖" : "文件与清单一致，还不是 HarnessHub 管理的", file: shown };
    return ours ? { harnessId, state: "outdated", reason: elsewhere + "清单改过，这里还是上次写入的内容", file: shown }
      : ledger ? { harnessId, state: "changed", reason: elsewhere + "HarnessHub 写的文件被外部改过，现在归你", file: shown }
      : { harnessId, state: "different", reason: elsewhere + "已有同名的文件，内容不同；HarnessHub 不覆盖", file: shown };
  }

  /** The list with every subagent's state per installed Harness. */
  async inventory(installed: readonly InstalledHarness[]): Promise<SubagentInventoryView> {
    const { tables } = await this.host.tables(), located = new Map(installed.map(harness => [harness.harnessId, this.locate(tables.find(table => table.harnessId === harness.harnessId), harness.harnessId)]));
    const subagents: SubagentView[] = this.list().map(item => ({ name: item.name, definition: item.definition, updatedAt: item.updatedAt,
      targets: installed.map(harness => this.target(item.name, item.definition, harness.harnessId, located.get(harness.harnessId)!)) }));
    return { subagents, harnesses: installed.map(harness => { const where = located.get(harness.harnessId)!; return { harnessId: harness.harnessId, name: harness.name, writable: !("reason" in where), reason: "reason" in where ? where.reason : null }; }) };
  }
  /** Keeps a subagent in the list (`replace` changes a listed one). No Harness file changes. */
  async save(name: string, input: SubagentDefinitionView, replace: boolean): Promise<{ readonly name: string }> {
    const definition = canonicalSubagent(input), problem = subagentProblem(name, definition, this.host.homes, await this.reserved());
    if (problem !== null) throw new CapabilityError("INVALID_INPUT", problem);
    const exists = this.list().some(item => item.name === name);
    if (exists && !replace) throw new CapabilityError("CAPABILITY_TARGET_REFUSED", "清单里已有 " + name);
    if (!exists && replace) throw new CapabilityError("CAPABILITY_NOT_FOUND", "清单里没有 " + name);
    this.host.owned();
    this.host.store.setSubagent(name, definition, this.host.now().toISOString());
    return { name };
  }
  /** Takes a subagent off the list; refused while a file HarnessHub wrote for it is still in a Harness. No Harness file changes. */
  async remove(name: string, installed: readonly InstalledHarness[]): Promise<void> {
    const item = this.list().find(entry => entry.name === name);
    if (item === undefined) throw new CapabilityError("CAPABILITY_NOT_FOUND", "清单里没有 " + name);
    const { tables } = await this.host.tables();
    for (const harness of installed) {
      const state = this.target(name, item.definition, harness.harnessId, this.locate(tables.find(table => table.harnessId === harness.harnessId), harness.harnessId)).state;
      if (state === "synced" || state === "outdated") throw new CapabilityError("CAPABILITY_TARGET_REFUSED", harness.name + " 里还有 HarnessHub 写的 " + name + "，请先从那里移除");
    }
    this.host.owned();
    this.host.store.dropSubagent(name);
  }
  /** Records the identical files of a listed subagent in these Harnesses as HarnessHub's (no file changes). */
  async claim(name: string, harnessIds: readonly string[], installed: readonly InstalledHarness[]): Promise<readonly CapabilityChangeView[]> {
    const item = this.list().find(entry => entry.name === name);
    if (item === undefined) throw new CapabilityError("CAPABILITY_NOT_FOUND", "清单里没有 " + name);
    const { tables } = await this.host.tables(), made: CapabilityChangeView[] = [];
    for (const harnessId of harnessIds) {
      const located = this.locate(tables.find(table => table.harnessId === harnessId), harnessId);
      if (!installed.some(harness => harness.harnessId === harnessId) || "reason" in located) throw new CapabilityError("CAPABILITY_UNSUPPORTED", harnessId + "：" + ("reason" in located ? located.reason : "没有安装"));
      const state = this.target(name, item.definition, harnessId, located);
      if (state.state === "synced") continue;
      if (state.state !== "claimable") throw new CapabilityError("CAPABILITY_TARGET_REFUSED", harnessId + " 里的 " + name + " 与清单不一致，不能认领");
      const file = subagentFile(located.directory, name, located.style), id = randomUUID(), at = this.host.now().toISOString();
      this.host.owned();
      this.host.store.setLedger({ harnessId, file, key: "subagent/" + name, valueHash: hash(renderSubagent(name, item.definition, located.style)), previous: null, changeId: id, at }, false);
      const view: CapabilityChangeView = { id, kind: "subagent-claim", harnessId, subject: name, file: this.host.shown(file), status: "applied", diff: null, backupId: null, error: null,
        notes: ["文件与清单一致，记为 HarnessHub 管理的；文件没有改动。"], at };
      this.host.store.saveChange("claim-" + id, hash(id), view);
      made.push(view);
    }
    return made;
  }

  private async prepare(name: string, harnessId: string, installed: readonly InstalledHarness[]) {
    const item = this.list().find(entry => entry.name === name);
    if (item === undefined) throw new CapabilityError("CAPABILITY_NOT_FOUND", "清单里没有 " + name);
    const harness = installed.find(entry => entry.harnessId === harnessId);
    if (harness === undefined) throw new CapabilityError("CAPABILITY_NOT_FOUND", "这个 Harness 没有官网安装");
    const { tables } = await this.host.tables(), located = this.locate(tables.find(table => table.harnessId === harnessId), harnessId);
    if ("reason" in located) throw new CapabilityError("CAPABILITY_UNSUPPORTED", located.reason);
    const file = subagentFile(located.directory, name, located.style);
    return { item, harness, located, file, read: readTarget(file), state: this.target(name, item.definition, harnessId, located) };
  }
  /** Whether Codex has its subagents turned off in config.toml (`[agents] enabled` or `features.multi_agent` false); both default to on. */
  private codexSubagentsOff(directory: string): boolean {
    const read = readTarget(join(dirname(directory), "config.toml")), parsed = read.state === "ok" ? parseConfig(read.bytes.toString("utf8"), "toml") : null;
    return parsed !== null && parsed.ok && (at(parsed.value, ["agents", "enabled"]) === false || at(parsed.value, ["features", "multi_agent"]) === false);
  }
  /**
   * Prepares writing a listed subagent into one Harness: a new file of HarnessHub's (and its directory, when there is
   * none), or bringing HarnessHub's file up to the list. One HarnessHub wrote and someone then changed or removed is
   * written again only with `overwrite`; another definition of the name never is.
   */
  async checkSync(name: string, harnessId: string, overwrite: boolean, installed: readonly InstalledHarness[]): Promise<CapabilityChangeCheck> {
    const { item, harness, located, file, read, state } = await this.prepare(name, harnessId, installed), rendered = renderSubagent(name, item.definition, located.style);
    const newDirectory = !existsSync(located.directory), shown = this.host.shown(file);
    const notes = ["只" + (read.state === "missing" ? "新建" : "改写") + " HarnessHub 自己的文件 " + shown + "，不写工具、权限、hooks、MCP，不改模型与登录配置。", INHERITS[located.style], EFFECT[located.style],
      ...await this.host.runningNotes(harnessId)];
    if (newDirectory) notes.push("会新建目录 " + this.host.shown(located.directory) + "（0700），记为 HarnessHub 新建；移除最后一个文件后，目录空了就删除。");
    if (newDirectory && located.style === "claude") notes.push("目录是新建的，运行中的 Claude Code 会话不会检测到，要开新会话才读到。");
    if (located.style === "codex" && this.codexSubagentsOff(located.directory)) notes.push("Codex 的配置里关闭了子 Agent（[agents] enabled 或 features.multi_agent 为 false），文件会写入但不会被用。");
    let blocked: string | null = null, conflicts: readonly string[] = [];
    try { conflicts = this.conflicts(name, located); } catch (error) { blocked = error instanceof Error ? error.message : "无法核对同名定义"; }
    if (blocked !== null) { /* already blocked */ }
    else if (state.state === "unsupported" || state.state === "different") blocked = state.reason;
    else if (conflicts.length) blocked = "已有同名的定义：" + conflicts.join("、") + "；" + harness.name + " 只会用其中一个，HarnessHub 不再写入。";
    else if (state.state === "synced") blocked = "无需修改：" + harness.name + " 里已是清单的内容。";
    else if (state.state === "claimable") blocked = "文件已与清单一致，不需要写入；可以把它认领为 HarnessHub 管理的。";
    else if ((state.state === "changed" || state.state === "removed") && !overwrite) blocked = state.reason + "；要按清单重新写入，请选择“重新写入”。";
    // What the Harness will read back: the three fields, nothing else.
    const back = readSubagent(rendered, located.style, name);
    if (blocked === null && (back === null || back.name !== name || back.description !== canonicalSubagent(item.definition).description || back.prompt !== canonicalSubagent(item.definition).prompt))
      blocked = "按 " + harness.name + " 的格式读回的内容与清单不同，没有准备写入。";
    let plan: SwitchPlan | null = null;
    if (blocked === null) {
      const ledger = this.host.store.ledger(harnessId, file, "subagent/" + name), current = read.state === "ok" ? read.bytes.toString("utf8") : null;
      plan = { kind: "edit", format: "markdown", file, after: rendered, ...(newDirectory ? { directory: "create" as const, alsoLedger: [{ file: located.directory, key: "dir/created", action: "set" as const }] } : {}),
        key: "subagent/" + name, written: rendered, previous: current === null ? null : JSON.stringify(current), current: current === null ? "none" : ledger !== null && ledger.valueHash === hash(current) ? "harnesshub" : "other",
        notes: [], ledger: "set", check: (_before, after) => String(after) === rendered };
    }
    return this.host.offerEdit("subagent-sync", harnessId, name, true, file, read, plan, blocked, notes);
  }
  /** Prepares removing HarnessHub's file of a listed subagent from one Harness (only one unchanged since HarnessHub wrote it), and its directory when HarnessHub created it and nothing else is left in it. */
  async checkRemove(name: string, harnessId: string, installed: readonly InstalledHarness[]): Promise<CapabilityChangeCheck> {
    const { harness, located, file, read, state } = await this.prepare(name, harnessId, installed), shown = this.host.shown(file);
    const notes = ["只删 HarnessHub 自己的文件 " + shown + "，不动其他子 Agent，不改模型与登录配置。", EFFECT[located.style]];
    const blocked = state.state === "synced" || state.state === "outdated" ? null : state.state === "absent" || state.state === "removed" ? "无需修改：" + harness.name + " 里没有这个文件。"
      : state.state === "unsupported" ? state.reason : "这个文件不是 HarnessHub 写的（或已被外部改过），HarnessHub 不删。";
    let plan: SwitchPlan | null = null;
    if (blocked === null && read.state === "ok") {
      // The directory goes too when HarnessHub created it and this file is the last thing in it.
      const created = this.host.store.ledger(harnessId, located.directory, "dir/created") !== null, alone = readdirSync(located.directory).every(entry => join(located.directory, entry) === file);
      if (created && alone) notes.push("目录 " + this.host.shown(located.directory) + " 是 HarnessHub 新建的，移除后为空，会一并删除。");
      plan = { kind: "edit", format: "markdown", file, after: "", remove: true, ...(created ? { directory: "remove" as const, alsoLedger: [{ file: located.directory, key: "dir/created", action: "drop" as const }] } : {}),
        key: "subagent/" + name, written: undefined, previous: null, current: "harnesshub", notes: [], ledger: "drop", check: () => true };
    }
    return this.host.offerEdit("subagent-remove", harnessId, name, false, file, read, plan, blocked, notes);
  }
}
