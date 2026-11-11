import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { opencodeWriteDialect, type HarnessReadTable, type ReadEnvironment } from "../../adapters/capability-reads.js";
import { CapabilityError, type CapabilityChangeCheck, type CapabilityChangeView, type McpCandidateView, type McpDefinitionView, type McpInventoryView, type McpServerView, type McpTargetView } from "../../contracts/capabilities.js";
import { TABLE_ENV } from "../../contracts/table.js";
import { parsed, UnsafeEdit } from "./edits.js";
import { readTarget, type TargetRead } from "./files.js";
import { canonical, commandLine, definitionProblem, MCP_NAME, mcpNameProblem, mcpVariables, ownedOf, readMcp, renderMcp, sameMcp, type McpDefinition, type McpRender, type McpStyle } from "./mcp-definitions.js";
import { dshRows, editMcp, mcpEntry, mcpGuard, mcpLocation, opencodeMcpStyle } from "./mcp-edits.js";
import type { InstalledHarness } from "./scan.js";
import type { CapabilityStore } from "./store.js";
import type { SwitchPlan } from "./switches.js";

/** What the MCP list needs of the change service it belongs to. */
export interface McpHost {
  readonly environment: ReadEnvironment;
  readonly store: CapabilityStore;
  now(): Date;
  shown(path: string): string;
  owned(): void;
  /** The read tables; with the installed Harnesses given, OpenCode's table knows which line is installed (the dialect its writer uses for a new entry). */
  tables(installed?: readonly InstalledHarness[]): Promise<{ readonly tables: readonly HarnessReadTable[] }>;
  /** Running sessions that may overwrite the file (Gemini CLI), as notes. */
  runningNotes(harnessId: string): Promise<readonly string[]>;
  /** Offers an edit through the usual check and confirmation (backup, atomic write, read back, ledger). */
  offerEdit(change: "mcp-sync" | "mcp-remove", harnessId: string, subject: string, enabled: boolean, file: string, read: TargetRead, plan: SwitchPlan | null, blocked: string | null, notes: readonly string[]): Promise<CapabilityChangeCheck>;
}
const WRITABLE: readonly McpStyle[] = ["claude", "codex", "cursor", "opencode", "gemini", "hermes", "dsh"];
const NOT_YET: Readonly<Record<string, string>> = {
  openclaw: "这个版本的 OpenClaw 改 MCP 会重启 Gateway、只支持 stdio，要等升级后再接入；现在只读。",
  pi: "Pi 0.99 之前没有内置 MCP。",
};
const AFTER: Readonly<Record<string, string>> = {
  claude: "运行中的 Claude Code 会话可能按内存里的副本整份写回 ~/.claude.json，冲掉这次写入：写入后会立即核对；之后被冲掉的，会在漂移列表里显示“写入丢失”，可以在没有会话运行时重新应用。新开的会话会读到它。",
  codex: "Codex 要重启后才读到改动。",
  cursor: "Cursor 编辑器也使用这个文件；新加的服务器可能要在 Cursor 里批准后才启用。",
  gemini: "改完后在 Gemini 里用 /mcp refresh 或重开会话才生效。",
  hermes: "长驻的 Hermes 进程要 /reload-mcp 或重启后生效；正在运行的 Hermes 网关不会被 HarnessHub 重启。",
  opencode: "OpenCode 要重开会话才读到改动。",
  dsh: "写在 ~/.dsh/cordis.patch.yml（每个 profile 都会读，包括 HarnessHub 用的 acp）；新开的会话才读到改动。DeepSeek Harness 启动服务器时会去掉名字像凭据的环境变量，所以变量都显式写在 env 里。",
};
function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex"); }
/** The variables a server needs from the user's environment: not the two the Hub sets itself in every native process it starts (TABLE_ENV). */
function userVariables(definition: McpDefinition): readonly string[] { return mcpVariables(definition).filter(variable => !(Object.values(TABLE_ENV) as readonly string[]).includes(variable)); }
/** The ledger key recording that HarnessHub created a Harness's file (DeepSeek Harness's patch layer), so that it can delete it again once emptied. */
export const CREATED_KEY = "file/created";
function isStyle(harnessId: string): harnessId is McpStyle { return ["claude", "codex", "cursor", "opencode", "gemini", "hermes", "dsh"].includes(harnessId); }
/** A listed server as one Harness would hold it, its name included in what that Harness must accept. */
function rendering(name: string, definition: McpDefinition, style: McpStyle): McpRender {
  const problem = mcpNameProblem(name, style);
  return problem === null ? renderMcp(definition, style) : { ok: false, reason: problem };
}

/**
 * HarnessHub's MCP list (ADR-045 §5, approval of step 3): servers kept without any value that looks like a credential,
 * imported from the Harnesses' own files or made by the user, and written into each Harness the way it writes them, one
 * confirmed check at a time. An entry already there is never overwritten unless HarnessHub wrote it or the user had it
 * claimed as identical; one someone else changed or removed is not put back without the user asking.
 */
export class McpInventory {
  constructor(private readonly host: McpHost) {}

  private home(): string { return this.host.environment.home; }
  /** A string as shown: every spelling of the home directory as ~. */
  private shownText(value: string): string { const home = this.home(); return value === home ? "~" : value.split(home + "/").join("~/"); }
  /** A string as typed: a leading ~/ is the home directory. */
  private typed(value: string): string { return value === "~" ? this.home() : value.startsWith("~/") ? this.home() + value.slice(1) : value; }
  /** A definition as shown: the home directory as ~ in every string a path can be in, literal values included. */
  private view(definition: McpDefinition): McpDefinitionView {
    return { ...definition, command: definition.command === null ? null : this.shownText(definition.command), args: definition.args.map(arg => this.shownText(arg)), cwd: definition.cwd === null ? null : this.shownText(definition.cwd),
      env: definition.env.map(item => "value" in item ? { key: item.key, value: this.shownText(item.value) } : item),
      headers: definition.headers.map(item => "value" in item ? { name: item.name, value: this.shownText(item.value) } : item) };
  }
  /** The list, each definition as stored; a row this build cannot read is skipped. */
  private list(): readonly { readonly name: string; readonly definition: McpDefinition; readonly updatedAt: string }[] {
    return this.host.store.mcpServers().flatMap(row => {
      const definition = row.definition as McpDefinition | null;
      return definition !== null && typeof definition === "object" && definitionProblem(definition) === null ? [{ name: row.name, definition, updatedAt: row.updatedAt }] : [];
    });
  }
  /**
   * Where a Harness keeps its servers (the file HarnessHub writes), or why HarnessHub does not write it. OpenCode: the last
   * of its configuration files that exists (else opencode.json), written in the dialect that file already uses, else the
   * installed line's (OpenCodeDialectSpec); `note` says which and why, for the confirmation.
   */
  private async targetFile(table: HarnessReadTable | undefined, harnessId: string): Promise<{ readonly file: string; readonly style: McpStyle; readonly note?: string } | { readonly reason: string }> {
    if (table === undefined) return { reason: "这个 Harness 没有官网安装" };
    if (!isStyle(harnessId) || !WRITABLE.includes(harnessId)) return { reason: NOT_YET[harnessId] ?? "HarnessHub 不写这个 Harness 的 MCP 配置" };
    const source = table.mcp;
    if (source.style === "opencode") {
      const existing = source.files.filter(file => existsSync(file)), file = existing.at(-1) ?? source.files[1] ?? source.files[0]!, spec = table.dialect ?? { line: null, basis: null, cli: "", tui: "" };
      const decided = opencodeWriteDialect(this.entries(file, "opencode")?.value ?? {}, "mcp", spec, { cli: spec.cli !== "" && existsSync(spec.cli), tui: spec.tui !== "" && existsSync(spec.tui) });
      if (decided.dialect === "mixed") return { reason: decided.basis };
      return { file, style: decided.dialect === "v2" ? "opencode-v2" : "opencode", note: "写法：" + decided.basis + "。" };
    }
    if (source.style === "dsh") return { file: source.file, style: "dsh" };
    if (source.style === "unsupported" || source.style === "openclaw") return { reason: NOT_YET[harnessId] ?? "HarnessHub 不写这个 Harness 的 MCP 配置" };
    return { file: source.file, style: harnessId };
  }
  /** A file's server entries, parsed; null when the file cannot be read or parsed. */
  private entries(file: string, style: McpStyle): { readonly read: TargetRead; readonly value: unknown } | null {
    const read = readTarget(file);
    if (read.state === "refused") return null;
    if (read.state === "missing") return { read, value: {} };
    try { return { read, value: parsed(read.bytes.toString("utf8"), mcpLocation(style).format) }; } catch { return null; }
  }
  /** Where one listed server stands in one Harness: the list, HarnessHub's ledger and the file compared. */
  private target(name: string, definition: McpDefinition, harnessId: string, located: { readonly file: string; readonly style: McpStyle } | { readonly reason: string }): McpTargetView {
    if ("reason" in located) return { harnessId, state: "unsupported", reason: located.reason, file: null };
    const rendered = rendering(name, definition, located.style), shown = this.host.shown(located.file);
    if (!rendered.ok) return { harnessId, state: "unsupported", reason: rendered.reason, file: shown };
    const file = this.entries(located.file, located.style);
    if (file === null) return { harnessId, state: "unsupported", reason: "配置文件无法读取或解析", file: shown };
    const current = mcpEntry(file.value, located.style, name), ledger = this.host.store.ledger(harnessId, located.file, "mcp/" + name);
    if (current === undefined) return { harnessId, state: ledger ? "removed" : "absent", reason: ledger ? "HarnessHub 写的这一项已被外部移除" : null, file: shown };
    const ours = ledger !== null && ledger.valueHash === hash(ownedOf(current, located.style)), read = readMcp(current, located.style);
    const same = read.definition !== null && sameMcp(read.definition, definition);
    if (same) return { harnessId, state: ours ? "synced" : "claimable", reason: ours ? null : "定义与清单一致，还不是 HarnessHub 管理的", file: shown };
    return ours ? { harnessId, state: "outdated", reason: "清单改过，这里还是上次写入的定义", file: shown }
      : ledger ? { harnessId, state: "changed", reason: "HarnessHub 写的这一项被外部改过，现在归你", file: shown }
      : { harnessId, state: "different", reason: "已有同名的服务器，定义不同；HarnessHub 不覆盖", file: shown };
  }

  /** The list's definition of a server as stored, or undefined when the list has none. */
  listed(name: string): McpDefinition | undefined { return this.list().find(item => item.name === name)?.definition; }
  /** Where a definition stands in each installed Harness, as `inventory` shows a listed server's; the definition need not be listed. */
  async targets(name: string, definition: McpDefinition, installed: readonly InstalledHarness[]): Promise<readonly McpTargetView[]> {
    const { tables } = await this.host.tables(installed);
    return Promise.all(installed.map(async harness => this.target(name, definition, harness.harnessId, await this.targetFile(tables.find(table => table.harnessId === harness.harnessId), harness.harnessId))));
  }

  /** The list with every server's state per installed Harness, and the servers the Harnesses have that could be listed. */
  async inventory(installed: readonly InstalledHarness[]): Promise<McpInventoryView> {
    const { tables } = await this.host.tables(installed), located = new Map<string, Awaited<ReturnType<McpInventory["targetFile"]>>>();
    for (const harness of installed) located.set(harness.harnessId, await this.targetFile(tables.find(table => table.harnessId === harness.harnessId), harness.harnessId));
    const list = this.list(), values = this.host.environment.values;
    const servers: McpServerView[] = list.map(item => ({ name: item.name, definition: this.view(item.definition), command: commandLine(item.definition) === null ? null : this.shownText(commandLine(item.definition)!),
      variables: userVariables(item.definition).map(name => ({ name, set: typeof values[name] === "string" && values[name] !== "" })),
      targets: installed.map(harness => this.target(item.name, item.definition, harness.harnessId, located.get(harness.harnessId)!)), updatedAt: item.updatedAt }));
    return { servers, candidates: await this.candidates(installed, tables, list), harnesses: installed.map(harness => { const where = located.get(harness.harnessId)!; return { harnessId: harness.harnessId, name: harness.name, writable: !("reason" in where), reason: "reason" in where ? where.reason : null }; }) };
  }
  /** The servers in the installed Harnesses' files, grouped by name and definition, compared with the list; `raw` keeps each definition as read, paths unshown. */
  private async candidates(installed: readonly InstalledHarness[], tables: readonly HarnessReadTable[], list: ReturnType<McpInventory["list"]>, raw = new Map<string, McpDefinition>()): Promise<McpCandidateView[]> {
    const groups = new Map<string, { name: string; definition: McpDefinition | null; problem: string | null; foundIn: { harnessId: string; file: string }[] }>();
    for (const harness of installed) {
      const table = tables.find(item => item.harnessId === harness.harnessId);
      if (table === undefined || !isStyle(harness.harnessId)) continue;
      const source = table.mcp;
      const files = source.style === "opencode" ? source.files : source.style === "dsh" ? [...(() => { try { return readdirSync(source.profiles, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => join(source.profiles, entry.name, "cordis.patch.yml")).sort(); } catch { return []; } })(), source.file]
        : source.style === "unsupported" || source.style === "openclaw" ? [] : [source.file];
      for (const file of files) {
        const entries = this.entries(file, harness.harnessId);
        if (entries === null) continue;
        // An OpenCode file is read in the dialect its own servers are written in, whichever line is installed.
        const style: McpStyle = harness.harnessId === "opencode" ? opencodeMcpStyle(entries.value) : harness.harnessId;
        const servers = style === "dsh" ? Object.fromEntries(dshRows(entries.value).flatMap(row => typeof row.config.serverName === "string" ? [[row.config.serverName, row.config]] : []))
          : (() => { let node: unknown = entries.value; for (const key of mcpLocation(style).path) node = node !== null && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined; return node !== null && typeof node === "object" && !Array.isArray(node) ? node as Record<string, unknown> : {}; })();
        for (const [name, raw] of Object.entries(servers)) {
          // A name HarnessHub cannot write everywhere is listed with the reason, not left out.
          const read = MCP_NAME.test(name) ? readMcp(raw, style) : { definition: null, problem: "服务器名只能用字母、数字、- 和 _（Codex 等不接受其他字符）；请在原处改名后再导入" };
          const key = name + "\0" + (read.definition !== null ? JSON.stringify(canonical(read.definition)) : "problem:" + harness.harnessId + ":" + read.problem);
          const group = groups.get(key) ?? { name, definition: read.definition, problem: read.problem, foundIn: [] };
          group.foundIn.push({ harnessId: harness.harnessId, file: this.host.shown(file) }); groups.set(key, group);
        }
      }
    }
    return [...groups.entries()].map(([key, group]) => {
      const listed = list.find(item => item.name === group.name), id = hash(key).slice(0, 32);
      if (group.definition !== null) raw.set(id, group.definition);
      return { id, name: group.name, definition: group.definition === null ? null : this.view(group.definition), problem: group.problem, foundIn: group.foundIn,
        state: listed === undefined ? "new" as const : group.definition !== null && sameMcp(listed.definition, group.definition) ? "listed" as const : "different" as const };
    }).sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  }

  /** Keeps a definition typed by the user (paths with a leading ~/ expanded), checked by the approval's rules; `replace` to change one listed. */
  save(name: string, input: McpDefinitionView, replace: boolean): McpServerView["name"] {
    if (!MCP_NAME.test(name)) throw new CapabilityError("INVALID_INPUT", "服务器名只能用字母、数字、- 和 _，最多 64 个字符");
    if (input.args.some(arg => arg.includes("~/") && !arg.startsWith("~/"))) throw new CapabilityError("INVALID_INPUT", "参数里的 ~/ 只在开头展开；请写完整路径");
    if (input.env.some(item => "value" in item && item.value.includes("~/") && !item.value.startsWith("~/"))) throw new CapabilityError("INVALID_INPUT", "环境变量的值里的 ~/ 只在开头展开；请写完整路径");
    const definition: McpDefinition = { ...input, command: input.command === null ? null : this.typed(input.command), args: input.args.map(arg => this.typed(arg)), cwd: input.cwd === null ? null : this.typed(input.cwd),
      env: input.env.map(item => "value" in item ? { key: item.key, value: this.typed(item.value) } : item) };
    return this.keep(name, definition, replace);
  }
  /** Keeps a definition as it is (absolute paths), checked by the approval's rules. */
  private keep(name: string, definition: McpDefinition, replace: boolean): string {
    const problem = definitionProblem(definition);
    if (problem !== null) throw new CapabilityError("INVALID_INPUT", problem);
    if (definition.cwd !== null && !(() => { try { return statSync(definition.cwd).isDirectory(); } catch { return false; } })()) throw new CapabilityError("INVALID_INPUT", "工作目录不存在");
    const exists = this.list().some(item => item.name === name);
    if (exists !== replace) throw new CapabilityError(exists ? "CAPABILITY_TARGET_REFUSED" : "CAPABILITY_NOT_FOUND", exists ? "清单里已有 " + name : "清单里没有 " + name);
    this.host.owned();
    this.host.store.setMcpServer(name, canonical(definition), this.host.now().toISOString());
    return name;
  }
  /** Removes a server from the list; refused while a Harness still has the entry HarnessHub wrote for it. */
  async remove(name: string, installed: readonly InstalledHarness[]): Promise<void> {
    const item = this.list().find(entry => entry.name === name);
    if (item === undefined) throw new CapabilityError("CAPABILITY_NOT_FOUND", "清单里没有 " + name);
    const view = await this.inventory(installed), held = view.servers.find(server => server.name === name)?.targets.filter(target => target.state === "synced" || target.state === "outdated") ?? [];
    if (held.length) throw new CapabilityError("CAPABILITY_TARGET_REFUSED", "先从 " + held.map(target => target.harnessId).join("、") + " 移除 HarnessHub 写的这一项，再从清单删除");
    this.host.owned();
    this.host.store.dropMcpServer(name);
  }
  /**
   * Lists a server the Harnesses already have (a candidate) and, for each Harness named in `claim` whose entry is
   * identical, records that entry as HarnessHub's; no Harness file changes. Returns the claims made as change records.
   */
  async importCandidate(id: string, claim: readonly string[], installed: readonly InstalledHarness[]): Promise<readonly CapabilityChangeView[]> {
    const { tables } = await this.host.tables(installed), raw = new Map<string, McpDefinition>();
    const candidate = (await this.candidates(installed, tables, this.list(), raw)).find(item => item.id === id);
    if (candidate === undefined) throw new CapabilityError("CAPABILITY_NOT_FOUND", "没有这个可导入的服务器（配置可能刚改过），请重新读取");
    if (candidate.definition === null) throw new CapabilityError("CAPABILITY_TARGET_REFUSED", candidate.name + " 不能收进清单：" + candidate.problem);
    if (candidate.state === "different") throw new CapabilityError("CAPABILITY_TARGET_REFUSED", "清单里已有定义不同的 " + candidate.name);
    if (claim.some(harnessId => !candidate.foundIn.some(found => found.harnessId === harnessId))) throw new CapabilityError("INVALID_INPUT", "只能认领找到它的 Harness 里的那一项");
    if (candidate.state === "new") this.keep(candidate.name, raw.get(id)!, false);
    return this.claim(candidate.name, claim, installed);
  }
  /** Records the identical entries of a listed server in these Harnesses as HarnessHub's (no file changes). */
  async claim(name: string, harnessIds: readonly string[], installed: readonly InstalledHarness[]): Promise<readonly CapabilityChangeView[]> {
    const item = this.list().find(entry => entry.name === name);
    if (item === undefined) throw new CapabilityError("CAPABILITY_NOT_FOUND", "清单里没有 " + name);
    const { tables } = await this.host.tables(installed), made: CapabilityChangeView[] = [];
    for (const harnessId of harnessIds) {
      const located = await this.targetFile(tables.find(table => table.harnessId === harnessId), harnessId);
      if (!installed.some(harness => harness.harnessId === harnessId) || "reason" in located) throw new CapabilityError("CAPABILITY_UNSUPPORTED", harnessId + "：" + ("reason" in located ? located.reason : "没有安装"));
      const state = this.target(name, item.definition, harnessId, located);
      if (state.state === "synced") continue;
      if (state.state !== "claimable") throw new CapabilityError("CAPABILITY_TARGET_REFUSED", harnessId + " 里的 " + name + " 与清单不一致，不能认领");
      const current = mcpEntry(this.entries(located.file, located.style)!.value, located.style, name), id = randomUUID(), at = this.host.now().toISOString();
      this.host.owned();
      this.host.store.setLedger({ harnessId, file: located.file, key: "mcp/" + name, valueHash: hash(ownedOf(current, located.style)), previous: null, changeId: id, at }, false);
      const view: CapabilityChangeView = { id, kind: "mcp-claim", harnessId, subject: name, file: this.host.shown(located.file), status: "applied", diff: null, backupId: null, error: null,
        notes: ["这一项与清单一致，记为 HarnessHub 管理的；文件没有改动。"], at };
      this.host.store.saveChange("claim-" + id, hash(id), view);
      made.push(view);
    }
    return made;
  }

  /**
   * Prepares writing a listed server into one Harness: adding it, or bringing HarnessHub's entry up to the list. One that
   * HarnessHub wrote and someone then changed or removed is written again only with `overwrite`; someone else's same-named
   * entry never is.
   */
  async checkSync(name: string, harnessId: string, overwrite: boolean, installed: readonly InstalledHarness[]): Promise<CapabilityChangeCheck> {
    const { item, located, read, value } = await this.prepare(name, harnessId, installed);
    const state = this.target(name, item.definition, harnessId, located), rendered = rendering(name, item.definition, located.style);
    const command = commandLine(item.definition), variables = userVariables(item.definition), tableVariables = mcpVariables(item.definition).filter(variable => !variables.includes(variable)), values = this.host.environment.values, harnessName = installed.find(harness => harness.harnessId === harnessId)?.name ?? harnessId;
    const notes = [command === null ? "服务器在 " + item.definition.url + "，" + harnessName + " 会连接它。" : "目标 Harness 会以你的身份运行这个程序：" + this.shownText(command),
      ...(variables.length ? ["需要的环境变量：" + variables.map(variable => variable + (typeof values[variable] === "string" && values[variable] !== "" ? "（已设置）" : "（HarnessHub 的环境里未设置）")).join("、") + "。值不写进配置文件。"] : []),
      ...(tableVariables.length ? [tableVariables.join("、") + " 由 HarnessHub 在它起的每个会话的原生进程里设置，配置里只写变量名；从别处启动这个 Harness 时它们不存在，这个服务器什么也不做。"] : []),
      ...await this.host.runningNotes(harnessId), AFTER[harnessId] ?? "", "note" in located && located.note !== undefined ? located.note : ""].filter(Boolean);
    let blocked: string | null = null;
    if (!rendered.ok) blocked = rendered.reason;
    else if (state.state === "synced") blocked = "无需修改：" + harnessId + " 里已是清单的定义。";
    else if (state.state === "claimable") blocked = "定义已一致，不需要写入；可以把它认领为 HarnessHub 管理的。";
    else if (state.state === "different") blocked = state.reason;
    else if ((state.state === "changed" || state.state === "removed") && !overwrite) blocked = state.reason + "；要按清单重新写入，请选择“重新写入”。";
    if (state.state === "removed") notes.push("这一项曾被外部移除，会按清单重新加上。");
    if (located.style === "gemini") {
      const settings = value !== null && typeof value === "object" ? value as Record<string, unknown> : {}, mcp = settings.mcp !== null && typeof settings.mcp === "object" ? settings.mcp as Record<string, unknown> : {};
      if ((Array.isArray(mcp.allowed) && !mcp.allowed.includes(name)) || (Array.isArray(mcp.excluded) && mcp.excluded.includes(name))) notes.push("Gemini 的 mcp.allowed / mcp.excluded 会让它不加载这个服务器；HarnessHub 不改这两项。");
    }
    if (state.state === "changed") notes.push(located.style === "claude" ? "会覆盖外部对这一项的改动（Claude 的命令先删后加）。" : "会覆盖外部对这一项的改动（只改 HarnessHub 管理的键）。");
    if (located.style === "claude" && item.definition.transport !== "stdio" && (state.state === "outdated" || state.state === "changed")) notes.push("Claude 更新服务器要先删后加，会丢掉这个远程服务器的 OAuth 登录，下次使用时要重新登录。");
    const owned = blocked === null && rendered.ok ? (located.style === "dsh" ? canonical({ serverName: name, ...rendered.value }) : rendered.value) : null;
    return this.offer("mcp-sync", harnessId, name, true, located, read, value, owned, blocked, notes, state.state === "outdated" ? "harnesshub" : "none");
  }
  /** Prepares removing a listed server's entry from one Harness: only the one HarnessHub wrote (or had claimed), unchanged since. */
  async checkRemove(name: string, harnessId: string, installed: readonly InstalledHarness[]): Promise<CapabilityChangeCheck> {
    const { item, located, read, value } = await this.prepare(name, harnessId, installed);
    const state = this.target(name, item.definition, harnessId, located);
    const blocked = state.state === "synced" || state.state === "outdated" ? null : state.state === "absent" || state.state === "removed" ? "无需修改：" + harnessId + " 里没有这一项。"
      : "这一项不是 HarnessHub 写的（或已被外部改过），HarnessHub 不删。";
    const notes = [...(located.style === "claude" && item.definition.transport !== "stdio" ? ["Claude 删除服务器时会一并删除它的 OAuth 登录。"] : []), AFTER[harnessId] ?? ""].filter(Boolean);
    return this.offer("mcp-remove", harnessId, name, false, located, read, value, undefined, blocked, notes, "harnesshub");
  }
  private async prepare(name: string, harnessId: string, installed: readonly InstalledHarness[]) {
    const item = this.list().find(entry => entry.name === name);
    if (item === undefined) throw new CapabilityError("CAPABILITY_NOT_FOUND", "清单里没有 " + name);
    if (!installed.some(harness => harness.harnessId === harnessId)) throw new CapabilityError("CAPABILITY_NOT_FOUND", "这个 Harness 没有官网安装");
    const { tables } = await this.host.tables(installed), located = await this.targetFile(tables.find(table => table.harnessId === harnessId), harnessId);
    if ("reason" in located) throw new CapabilityError("CAPABILITY_UNSUPPORTED", located.reason);
    const read = readTarget(located.file);
    let value: unknown = {};
    if (read.state === "ok") { try { value = parsed(read.bytes.toString("utf8"), mcpLocation(located.style).format); } catch { value = null; } }
    return { item, located, read, value };
  }
  /** An edit plan through the usual offer: the file with the server's owned keys set (or the entry removed), checked. */
  private offer(change: "mcp-sync" | "mcp-remove", harnessId: string, name: string, enabled: boolean, located: { readonly file: string; readonly style: McpStyle }, read: TargetRead, value: unknown,
    owned: Readonly<Record<string, unknown>> | null | undefined, blocked: string | null, given: readonly string[], current: "harnesshub" | "none"): Promise<CapabilityChangeCheck> {
    let notes = given;
    let plan: SwitchPlan | null = null, reason = blocked;
    if (read.state === "refused") reason ??= "无法修改 " + this.host.shown(located.file) + "：" + read.reason + "。";
    else if (read.state === "missing" && !read.directory) reason ??= "无法修改：" + this.host.shown(located.file) + " 所在的目录不存在。";
    else if (value === null) reason ??= "配置文件无法解析，HarnessHub 不以空配置写回。";
    if (reason === null && owned !== null && located.style === "claude") {
      // Claude's own commands: added when absent, removed and added again to change, removed to remove.
      const key = "mcp/" + name, entry = mcpEntry(value, "claude", name), ledger = this.host.store.ledger(harnessId, located.file, key), written = owned === undefined ? undefined : ownedOf(owned, "claude");
      const add = owned === undefined ? null : ["mcp", "add-json", name, JSON.stringify(owned), "-s", "user"], remove = ["mcp", "remove", name, "-s", "user"];
      const steps = add === null ? [remove] : entry === undefined ? [add] : [remove, add];
      plan = { kind: "command", runner: "claude", file: located.file, args: steps[0]!, steps, subtree: ["mcpServers", name], comments: false, key, written,
        previous: entry === undefined ? null : JSON.stringify(ownedOf(entry, "claude")), current: entry === undefined ? "none" : ledger !== null && ledger.valueHash === hash(ownedOf(entry, "claude")) ? "harnesshub" : current === "harnesshub" ? "harnesshub" : "other",
        notes: [], ledger: owned === undefined ? "drop" : "set", check: after => JSON.stringify(ownedOf(mcpEntry(after, "claude", name), "claude") ?? null) === JSON.stringify(written ?? null) };
    } else if (reason === null && owned !== null) {
      const before = read.state === "ok" ? read.bytes.toString("utf8") : "", key = "mcp/" + name, entry = mcpEntry(value, located.style, name), ledger = this.host.store.ledger(harnessId, located.file, key);
      try {
        const after = editMcp(before, located.style, name, owned === undefined ? undefined : owned);
        const written = owned === undefined ? undefined : ownedOf(owned, located.style), previous = entry === undefined ? null : JSON.stringify(ownedOf(entry, located.style));
        // DeepSeek Harness's patch file HarnessHub created goes again once only the empty list it would leave is in it (ADR-045
        // step 4 ruling 3): the record that HarnessHub created it is kept with the write that created it.
        const created = located.style === "dsh" ? this.host.store.ledger(harnessId, located.file, CREATED_KEY) !== null : false;
        const remove = located.style === "dsh" && owned === undefined && created && after.trim() === "[]";
        const alsoLedger = located.style !== "dsh" ? undefined : owned !== undefined && read.state === "missing" ? [{ file: located.file, key: CREATED_KEY, action: "set" as const }]
          : remove ? [{ file: located.file, key: CREATED_KEY, action: "drop" as const }] : undefined;
        if (remove) notes = [...notes, "这个文件是 HarnessHub 新建的，移除最后一个服务器后只剩空列表，会删除它，回到原来没有这个文件的样子。"];
        else if (located.style === "dsh" && owned === undefined && after.trim() === "[]") notes = [...notes, "移除后列表为空，文件里留下 []（这个文件原来就有）。"];
        plan = { kind: "edit", file: located.file, format: mcpLocation(located.style).format, after: remove ? "" : after, ...(remove ? { remove } : {}), ...(alsoLedger ? { alsoLedger } : {}), key, written, previous,
          current: entry === undefined ? "none" : ledger !== null && ledger.valueHash === hash(ownedOf(entry, located.style)) ? "harnesshub" : current === "harnesshub" ? "harnesshub" : "other",
          notes: [], ledger: owned === undefined ? "drop" : "set",
          // A deletion is checked on what is there: HarnessHub's one patch and nothing else.
          check: remove ? beforeValue => Array.isArray(beforeValue) && beforeValue.length === 1 && dshRows(beforeValue).length === 1 && dshRows(beforeValue)[0]!.config.serverName === name
            : (beforeValue, afterValue) => mcpGuard(beforeValue, afterValue, located.style, name, owned) === null };
      } catch (error) { if (!(error instanceof UnsafeEdit)) throw error; reason = "无法安全修改 " + this.host.shown(located.file) + "：" + error.message + "。"; }
    }
    return this.host.offerEdit(change, harnessId, name, enabled, located.file, read, plan, reason, notes);
  }
}
