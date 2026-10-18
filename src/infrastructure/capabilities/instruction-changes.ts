import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { harnessDirectories, type HarnessReadTable, type ReadEnvironment } from "../../adapters/capability-reads.js";
import { CapabilityError, type CapabilityChangeCheck, type CapabilityChangeView, type InstructionCheckOption, type InstructionsView, type InstructionTargetState,
  type InstructionTargetView } from "../../contracts/capabilities.js";
import { at, parseConfig, record } from "./formats.js";
import { readTarget, type TargetRead } from "./files.js";
import { findBlock, INSTRUCTION_TEXT_BYTES, instructionBody, instructionTextProblem, withBlock, withoutBlock, type InstructionBlock } from "./instruction-blocks.js";
import type { InstalledHarness } from "./scan.js";
import type { CapabilityStore, LedgerEntry } from "./store.js";
import type { SwitchPlan } from "./switches.js";

/** The ledger key of HarnessHub's instructions block in a Harness's file. */
export const INSTRUCTION_KEY = "instructions/block";
/** What the instructions need of the change service they belong to. */
export interface InstructionHost {
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
  /** Whether cc-switch is running now; null when the running programs could not be read. */
  ccSwitchRunning(): Promise<boolean | null>;
  /** Offers an edit through the usual check and confirmation (backup, atomic write or removal, read back, ledger). */
  offerEdit(change: "instructions-sync" | "instructions-remove", harnessId: string, subject: string, enabled: boolean, file: string, read: TargetRead, plan: SwitchPlan | null, blocked: string | null,
    notes: readonly string[]): Promise<CapabilityChangeCheck>;
}
/** When each Harness reads a change of its user-level instructions, as its installed version was checked to (ADR-045 step 4). */
const EFFECT: Readonly<Record<string, string>> = {
  claude: "新开的 Claude Code 会话读到，包括 HarnessHub 里新开的会话；运行中的会话不受影响。",
  codex: "新开的 Codex 会话读到；运行中的会话不受影响。",
  gemini: "新开的 Gemini CLI 会话读到；运行中的会话可以用 /memory refresh 重新读取。",
  opencode: "OpenCode 每一步都重新读，运行中的会话下一步就会用到。",
  openclaw: "OpenClaw 网关按会话缓存指令：新会话或重置会话后才用到，飞书、微信等频道的会话也是如此；HarnessHub 不重启网关。",
  dsh: "DeepSeek Harness 每一步之前都比对，运行中的会话下一步就会收到更新。",
  pi: "新开的 Pi 会话读到。",
};
/** OpenClaw keeps a bootstrap file's head and tail and cuts its middle past this many characters (`agents.defaults.bootstrapMaxChars`). */
const OPENCLAW_MAX_CHARS = 20000;
/** DeepSeek Harness's budget for all instruction files of a session, the project's included. */
const DSH_BUDGET = 64 * 1024;
function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex"); }
function exists(path: string): boolean { try { lstatSync(path); return true; } catch { return false; } }
/** A file read the way the Harness reads it, links followed; only for deciding which file it reads, never for writing. */
function plainText(path: string): { readonly state: "missing" } | { readonly state: "unreadable"; readonly reason: string } | { readonly state: "ok"; readonly text: string } {
  try {
    const info = statSync(path);
    if (!info.isFile()) return { state: "unreadable", reason: "这不是普通文件" };
    if (info.size > 1024 * 1024) return { state: "unreadable", reason: "文件超过 1 MB" };
    return { state: "ok", text: readFileSync(path, "utf8") };
  } catch (error) {
    const code = error !== null && typeof error === "object" && "code" in error ? String(error.code) : "";
    return code === "ENOENT" ? { state: "missing" } : { state: "unreadable", reason: "无法读取（" + (code || "未知错误") + "）" };
  }
}
/** What the ledger keeps of a block's placement: whether HarnessHub created the file, and what it added before the block. */
interface Placement { readonly created: boolean; readonly separator: string }
function placement(entry: LedgerEntry | null): Placement {
  try { const value = JSON.parse(entry?.previous ?? "null") as Partial<Placement> | null; return { created: value?.created === true, separator: typeof value?.separator === "string" ? value.separator : "" }; }
  catch { return { created: false, separator: "" }; }
}
/** The file HarnessHub writes for a Harness, the file it falls back to without it (OpenCode), and the reason when there is none. */
type Located = { readonly file: string; readonly fallback: string | null; readonly others: readonly string[] } | { readonly reason: string };
interface Reading { readonly read: TargetRead; readonly text: string; readonly block: InstructionBlock }

/**
 * HarnessHub's instructions (ADR-045 §6, step 4): one shared text and each Harness's addition, kept in HarnessHub's own
 * store and written as a marked block into the user-level instructions file each Harness reads, one confirmed check at a
 * time; nothing outside the block changes. A block someone edited is the user's and is overwritten or removed only when
 * the user says so; a first write into a file another tool (cc-switch) may rewrite, and a new file that ends OpenCode's
 * fallback to the user's text, wait for the user to say so too.
 */
export class InstructionInventory {
  constructor(private readonly host: InstructionHost) {}

  private texts(): { readonly shared: { readonly text: string; readonly updatedAt: string | null }; readonly additions: ReadonlyMap<string, { readonly text: string; readonly updatedAt: string }> } {
    const rows = this.host.store.instructionTexts(), shared = rows.find(row => row.scope === "shared");
    return { shared: { text: shared?.text ?? "", updatedAt: shared?.updatedAt ?? null }, additions: new Map(rows.filter(row => row.scope !== "shared").map(row => [row.scope, { text: row.text, updatedAt: row.updatedAt }])) };
  }
  private body(harnessId: string): string { const texts = this.texts(); return instructionBody(texts.shared.text, texts.additions.get(harnessId)?.text ?? ""); }
  /**
   * The files cc-switch writes whole when one of its prompts is turned on, once it has been set up here (`~/.cc-switch`
   * exists; nothing in it is read). The list follows cc-switch 4.0.15's `prompt_files.rs`; the 3.15.0 installed here
   * shows CLAUDE.md, AGENTS.md, GEMINI.md and SOUL.md in its program, the rest is kept to be safe.
   */
  private ccSwitchFiles(): ReadonlySet<string> {
    const home = this.host.environment.home;
    if (!exists(join(home, ".cc-switch"))) return new Set();
    const dirs = harnessDirectories(this.host.environment);
    return new Set([join(home, ".claude", "CLAUDE.md"), join(dirs.claude, "CLAUDE.md"), join(home, ".codex", "AGENTS.md"), join(dirs.codex, "AGENTS.md"), join(home, ".gemini", "GEMINI.md"), join(dirs.gemini, "GEMINI.md"),
      join(home, ".config", "opencode", "AGENTS.md"), join(dirs.opencode, "AGENTS.md"), join(home, ".openclaw", "AGENTS.md"), join(home, ".pi", "agent", "AGENTS.md"), join(dirs.pi, "AGENTS.md")]);
  }
  /** Gemini reads the names `context.fileName` gives instead of GEMINI.md, each one that exists; HarnessHub writes the first that exists, else the first. */
  private geminiNames(): { readonly names: readonly string[] } | { readonly reason: string } {
    const read = plainText(join(harnessDirectories(this.host.environment).gemini, "settings.json"));
    if (read.state === "missing") return { names: [] };
    if (read.state === "unreadable") return { reason: "读不了 Gemini 的 settings.json（" + read.reason + "），不知道它读哪个指令文件" };
    const parsed = parseConfig(read.text, "json");
    if (!parsed.ok) return { reason: "Gemini 的 settings.json 无法解析，不知道它读哪个指令文件" };
    const names = at(parsed.value, ["context", "fileName"]), list = typeof names === "string" ? [names] : Array.isArray(names) ? names.filter((name): name is string => typeof name === "string") : [];
    return { names: list.filter(name => name !== "" && !name.includes("/")) };
  }
  /** OpenClaw's configuration as read for the instructions (JSON5, links followed): its channels' names, its per-file limit and whether it has several agents. */
  private openclaw(): { readonly channels: readonly string[]; readonly maxChars: number; readonly agents: number } {
    const read = plainText(harnessDirectories(this.host.environment).openclawConfig), parsed = read.state === "ok" ? parseConfig(read.text, "json5") : null;
    const value = parsed?.ok ? parsed.value : null, raw = at(value, ["agents", "defaults", "bootstrapMaxChars"]), list = at(value, ["agents", "list"]);
    return { channels: Object.keys(record(at(value, ["channels"]))).filter(name => name !== "defaults"), maxChars: typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : OPENCLAW_MAX_CHARS,
      agents: Array.isArray(list) ? list.length : 0 };
  }
  /** The file HarnessHub writes for a Harness: the one its read table says it reads now (Codex: a non-empty override first; OpenCode: always its own). */
  private locate(table: HarnessReadTable | undefined): Located {
    if (table === undefined) return { reason: "这个 Harness 没有官网安装" };
    const spec = table.instructions;
    if (spec.kind !== "files") return { reason: spec.reason };
    let candidates = spec.candidates.map(candidate => candidate.path);
    if (table.harnessId === "gemini") {
      const listed = this.geminiNames();
      if ("reason" in listed) return listed;
      if (listed.names.length) candidates = listed.names.map(name => join(harnessDirectories(this.host.environment).gemini, name));
    }
    if (table.harnessId === "opencode") {
      const own = spec.candidates.find(candidate => candidate.role === "own")!.path, fallback = spec.candidates.find(candidate => candidate.role === "compat")?.path ?? null;
      return { file: own, fallback, others: fallback === null ? [] : [fallback] };
    }
    const nonEmpty = (path: string) => { const read = plainText(path); return read.state === "ok" && read.text.trim() !== ""; };
    const file = (spec.rule === "first-nonempty" ? candidates.find(nonEmpty) ?? candidates.find(path => !path.endsWith(".override.md")) : candidates.find(exists)) ?? candidates[0]!;
    return { file, fallback: null, others: candidates.filter(path => path !== file) };
  }
  private reading(file: string): Reading {
    const read = readTarget(file), text = read.state === "ok" ? read.bytes.toString("utf8") : "";
    return { read, text, block: read.state === "refused" ? { kind: "broken", reason: read.reason } : findBlock(text) };
  }
  /**
   * HarnessHub's ledger entries for this Harness's block: the one for the file it reads now (`own`), one for a file it
   * no longer reads that still holds the block (`shadow`), and those whose file no longer holds it (`stale`).
   */
  private entries(harnessId: string, file: string): { readonly own: LedgerEntry | null; readonly shadow: LedgerEntry | null; readonly stale: readonly LedgerEntry[] } {
    const all = this.host.store.ledgerEntries().filter(item => item.harnessId === harnessId && item.key === INSTRUCTION_KEY), others = all.filter(item => item.file !== file);
    const holding = others.filter(item => this.reading(item.file).block.kind === "block");
    return { own: all.find(item => item.file === file) ?? null, shadow: holding[0] ?? null, stale: others.filter(item => !holding.includes(item)) };
  }

  /** Where the instructions stand in one Harness: the texts, the ledger and the block in the file compared. */
  private target(harness: InstalledHarness, located: Located): InstructionTargetView {
    const base = { harnessId: harness.harnessId, name: harness.name, effect: EFFECT[harness.harnessId] ?? null };
    if ("reason" in located) return { ...base, file: null, state: "unsupported", reason: located.reason, cautions: [] };
    const { own, shadow } = this.entries(harness.harnessId, located.file), body = this.body(harness.harnessId);
    // HarnessHub's block in a file the Harness no longer reads (Codex after an override appeared): removed from there first.
    if (shadow !== null) return { ...base, file: this.host.shown(shadow.file), state: "shadowed", reason: harness.name + " 现在读 " + this.host.shown(located.file) + "，HarnessHub 的区块在 " + this.host.shown(shadow.file) + "，对它不起作用", cautions: [] };
    const { read, block } = this.reading(located.file), shown = this.host.shown(located.file), cautions = this.cautions(harness, located, read);
    const view = (state: InstructionTargetState, reason: string | null): InstructionTargetView => ({ ...base, file: shown, state, reason, cautions });
    if (block.kind === "broken") return view("unreadable", block.reason);
    if (block.kind === "none") {
      if (own !== null) return view("removed", "HarnessHub 写的区块已被外部移除");
      if (read.state === "missing" && located.fallback !== null) {
        const fallback = this.reading(located.fallback);
        if (fallback.block.kind === "block" && fallback.block.intact) return view("elsewhere", harness.name + " 没有自己的指令文件，现在回退读 " + this.host.shown(located.fallback) + "，用的是那里的 HarnessHub 区块");
      }
      if (read.state === "missing" && !read.directory) return view("absent", "目录不存在，" + harness.name + " 可能还没有初始化");
      if (read.state === "missing" && harness.harnessId === "openclaw") return view("absent", "OpenClaw 还没有生成工作区里的 AGENTS.md");
      return view("absent", null);
    }
    if (!block.intact) return view("changed", "区块里的内容被改过，现在归你");
    if (own === null) return body !== "" && block.body === body ? view("claimable", "内容与现在的指令一致，还不在 HarnessHub 的记录里") : view("changed", "HarnessHub 更早写的区块，没有记录，内容与现在的指令不同");
    if (own.valueHash !== hash(block.body)) return view("changed", "HarnessHub 更早写的版本（可能被别的工具写回），与上次的记录不同");
    return block.body === body ? view("synced", null) : view("outdated", body === "" ? "指令已清空，这里还是上次写入的内容" : "指令改过，这里还是上次写入的内容");
  }
  /** What a write into this Harness's file asks about or warns of first. */
  private cautions(harness: InstalledHarness, located: { readonly file: string; readonly fallback: string | null }, read: TargetRead): string[] {
    const out: string[] = [];
    if (this.ccSwitchFiles().has(located.file)) out.push("cc-switch 启用或切换提示词时会整份改写 " + this.host.shown(located.file) + "（区块随之消失，或被收进它的提示词），停用最后一个提示词时会清空它。"
      + (read.state === "ok" && read.bytes.length === 0 ? "这个文件现在是 0 字节，与 cc-switch 停用提示词后的状态一致。" : ""));
    if (located.fallback !== null && read.state === "missing") out.push("新建 " + this.host.shown(located.file) + " 后，" + harness.name + " 不再回退读 " + this.host.shown(located.fallback) + "。");
    return out;
  }
  /** OpenCode reading Claude Code's file in its fallback (installed, no file of its own, the fallback not turned off): what that means for a change of Claude's file. */
  private async opencodeFallsBackTo(file: string, installed: readonly InstalledHarness[]): Promise<boolean> {
    if (!installed.some(harness => harness.harnessId === "opencode")) return false;
    const located = this.locate((await this.host.tables()).tables.find(table => table.harnessId === "opencode"));
    return !("reason" in located) && located.fallback === file && !exists(located.file);
  }

  /** The texts and every installed Harness's state. */
  async view(installed: readonly InstalledHarness[]): Promise<InstructionsView> {
    const { tables } = await this.host.tables(), texts = this.texts();
    return { shared: texts.shared, additions: [...texts.additions].map(([harnessId, item]) => ({ harnessId, ...item })),
      targets: installed.map(harness => this.target(harness, this.locate(tables.find(table => table.harnessId === harness.harnessId)))), limitBytes: INSTRUCTION_TEXT_BYTES };
  }
  /** Replaces the shared text and the additions (for installed Harnesses only). No Harness file changes. */
  save(shared: string, additions: Readonly<Record<string, string>>, installed: readonly InstalledHarness[]): void {
    const texts = new Map<string, string>([["shared", shared.replace(/\r\n/gu, "\n")]]);
    for (const [harnessId, text] of Object.entries(additions)) {
      if (!installed.some(harness => harness.harnessId === harnessId)) throw new CapabilityError("INVALID_INPUT", harnessId + " 没有官网安装，不能为它保存追加文本");
      texts.set(harnessId, text.replace(/\r\n/gu, "\n"));
    }
    for (const [scope, text] of texts) {
      const problem = instructionTextProblem(text, this.host.homes);
      if (problem !== null) throw new CapabilityError("INVALID_INPUT", (scope === "shared" ? "共享指令" : (installed.find(harness => harness.harnessId === scope)?.name ?? scope) + " 的追加文本") + "：" + problem);
    }
    this.host.owned();
    this.host.store.setInstructionTexts(new Map([...texts].map(([scope, text]) => [scope, text.trim() === "" ? "" : text])), this.host.now().toISOString());
  }
  /** Records the identical block in one Harness's file as HarnessHub's (no file changes). */
  async claim(harnessId: string, installed: readonly InstalledHarness[]): Promise<CapabilityChangeView> {
    const { harness, located } = await this.prepare(harnessId, installed), state = this.target(harness, located);
    if ("reason" in located || state.state !== "claimable") throw new CapabilityError("CAPABILITY_TARGET_REFUSED", harness.name + " 的指令文件里没有与现在的指令一致、可以认领的区块");
    const id = randomUUID(), at = this.host.now().toISOString();
    this.host.owned();
    this.host.store.setLedger({ harnessId, file: located.file, key: INSTRUCTION_KEY, valueHash: hash(this.body(harnessId)), previous: JSON.stringify({ created: false, separator: "" }), changeId: id, at }, false);
    for (const stale of this.entries(harnessId, located.file).stale) this.host.store.dropLedger(harnessId, stale.file, INSTRUCTION_KEY);
    const view: CapabilityChangeView = { id, kind: "instructions-claim", harnessId, subject: "指令", file: this.host.shown(located.file), status: "applied", diff: null, backupId: null, error: null,
      notes: ["这个区块与现在的指令一致，记为 HarnessHub 管理的；文件没有改动。"], at };
    this.host.store.saveChange("claim-" + id, hash(id), view);
    return view;
  }
  private async prepare(harnessId: string, installed: readonly InstalledHarness[]): Promise<{ readonly harness: InstalledHarness; readonly located: Located }> {
    const harness = installed.find(item => item.harnessId === harnessId);
    if (harness === undefined) throw new CapabilityError("CAPABILITY_NOT_FOUND", "这个 Harness 没有官网安装");
    const { tables } = await this.host.tables();
    return { harness, located: this.locate(tables.find(table => table.harnessId === harnessId)) };
  }

  /**
   * Prepares writing the instructions into one Harness: adding the block, or bringing HarnessHub's up to date. A block
   * someone edited, or HarnessHub's that no longer matches its record, is overwritten only with `overwrite`; a first write
   * (or one after the block was removed, or over a block HarnessHub has no record of) into a file cc-switch writes only
   * with `acknowledge-cc-switch`; OpenCode's own file, which ends its fallback to a CLAUDE.md that holds the user's own
   * text, only with `create-own`. OpenClaw's file is not created, and not written past its per-file limit.
   */
  async checkSync(harnessId: string, options: ReadonlySet<InstructionCheckOption>, installed: readonly InstalledHarness[]): Promise<CapabilityChangeCheck> {
    const { harness, located } = await this.prepare(harnessId, installed);
    if ("reason" in located) throw new CapabilityError("CAPABILITY_UNSUPPORTED", located.reason);
    const state = this.target(harness, located), body = this.body(harnessId), { read, text, block } = this.reading(located.file), { own, stale } = this.entries(harnessId, located.file);
    const shown = this.host.shown(located.file), ccSwitch = this.ccSwitchFiles().has(located.file);
    const notes = ["只改 " + shown + " 里带 HarnessHub 标记的区块（或新建这个文件），不改任何模型、Provider 或登录配置；区块外的内容不动。", EFFECT[harnessId] ?? "", ...await this.host.runningNotes(harnessId)].filter(Boolean);
    let blocked: string | null = null, proceed: CapabilityChangeCheck["proceed"] = null;
    const ask = (reason: string, option: InstructionCheckOption, label: string) => { if (blocked === null && !options.has(option)) { blocked = reason; proceed = { option, label }; } };
    if (body === "") blocked = "共享指令和 " + harness.name + " 的追加文本都是空的，没有可写的内容。";
    else if (state.state === "shadowed") blocked = state.reason + "；请先移除那里的区块。";
    else if (state.state === "unreadable") blocked = "无法修改 " + shown + "：" + state.reason + "。";
    else if (state.state === "synced") blocked = "无需修改：" + harness.name + " 的区块已是现在的指令。";
    else if (state.state === "claimable") blocked = "区块已与现在的指令一致，不需要写入；可以把它认领为 HarnessHub 管理的。";
    else if (read.state === "missing" && !read.directory) blocked = "无法修改：" + shown + " 所在的目录不存在，" + harness.name + " 可能还没有初始化。";
    else if (read.state === "missing" && harnessId === "openclaw") blocked = "OpenClaw 还没有生成工作区里的 AGENTS.md，请先让 OpenClaw 初始化工作区；HarnessHub 不替它新建，否则 OpenClaw 以后不再写入它的默认模板。";
    if (state.state === "changed") ask(state.reason + "。覆盖会丢掉区块里现在的内容。", "overwrite", "覆盖区块");
    // cc-switch only matters where its whole-file write would take the block away: a first write, a write after the block
    // was removed (as cc-switch does), and over a block HarnessHub has no matching record of.
    if (ccSwitch && (state.state === "absent" || state.state === "elsewhere" || state.state === "removed" || (state.state === "changed" && block.kind === "block" && block.intact)))
      ask(state.cautions.find(caution => caution.startsWith("cc-switch")) ?? "cc-switch 可能整份改写这个文件。", "acknowledge-cc-switch", "我知道，仍然写入");
    else if (ccSwitch) notes.push("cc-switch 启用或切换提示词时会整份改写这个文件，区块会随之消失。");
    if (ccSwitch && await this.host.ccSwitchRunning()) notes.push("cc-switch 正在运行。");
    if (located.fallback !== null && read.state === "missing") {
      const fallback = this.reading(located.fallback), outside = fallback.block.kind === "block" ? withoutBlock(fallback.text, "") : fallback.text;
      if (outside.trim() !== "") ask(harness.name + " 现在回退读 " + this.host.shown(located.fallback) + "，那里有你自己的内容；新建它自己的 " + shown + " 后，" + harness.name + " 就读不到那些内容了。"
        + "也可以改为写入 Claude Code 的 " + this.host.shown(located.fallback) + "，" + harness.name + " 会经回退读到。", "create-own", "新建 " + harness.name + " 自己的文件");
      notes.push("会新建 " + shown + "；之后 " + harness.name + " 不再回退读 " + this.host.shown(located.fallback) + "。");
    }
    if (harnessId === "claude" && await this.opencodeFallsBackTo(located.file, installed)) notes.push("OpenCode 没有自己的指令文件，也会经回退读到这个文件。");
    if (state.state === "removed") notes.push("HarnessHub 写的区块曾被外部移除，会重新加上。");
    if (located.others.length && harnessId === "codex" && located.file.endsWith(".override.md")) notes.push("Codex 读非空的 AGENTS.override.md，所以写在这里；AGENTS.md 对它不起作用。");
    let openclaw: ReturnType<InstructionInventory["openclaw"]> | null = null;
    if (harnessId === "openclaw") {
      openclaw = this.openclaw();
      notes.push((openclaw.channels.length ? "OpenClaw 配置的频道：" + openclaw.channels.join("、") + "。这些频道里的新会话或重置后的会话会按新指令回答" : "这台电脑的 OpenClaw 没有配置频道。新会话或重置后的会话会按新指令回答")
        + "；运行中的会话不变；HarnessHub 不重启网关。");
      if (openclaw.agents > 0) notes.push("OpenClaw 配置了 " + openclaw.agents + " 个 agent，这里只写默认 agent 的工作区；其他 agent 的工作区不支持。");
      if (exists(join(dirname(located.file), ".git"))) notes.push("OpenClaw 的工作区是 git 仓库，这次改动会出现在它的 git status 里。");
    }
    if (harnessId === "dsh") notes.push("DeepSeek Harness 的指令总预算是 64 KiB，包括项目里的 AGENTS.md 与 CLAUDE.md；超出部分会被省略。");
    let plan: SwitchPlan | null = null;
    if (blocked === null) {
      try {
        const written = withBlock(text, body), chars = written.after.trimEnd().length, bytes = Buffer.byteLength(written.after, "utf8");
        // OpenClaw cuts a file's middle past its limit, so a block there would be partly missing: not written.
        if (openclaw !== null && chars > openclaw.maxChars) blocked = "写入后文件有 " + chars + " 个字符，超过 OpenClaw 的单个文件上限 " + openclaw.maxChars + " 个字符（agents.defaults.bootstrapMaxChars）；OpenClaw 会挖掉中间的部分，区块或模板会残缺，所以不写入。请先精简指令或这个文件。";
        if (harnessId === "dsh" && bytes > DSH_BUDGET) notes.push("写入后文件有 " + (bytes / 1024).toFixed(1) + " KiB，单这个文件就超过了 DeepSeek Harness 的指令总预算。");
        // Only a block of HarnessHub's still in the file keeps how the first write placed it; a block written again after it was removed is placed anew.
        const ours = own !== null && block.kind === "block", separator = block.kind === "block" ? (ours ? placement(own).separator : "") : written.separator;
        if (blocked === null) plan = { kind: "edit", format: "markdown", file: located.file, after: written.after, key: INSTRUCTION_KEY, written: body,
          previous: JSON.stringify(ours ? placement(own) : { created: read.state === "missing", separator: written.separator }), current: ours ? "harnesshub" : block.kind === "block" ? "other" : "none", notes: [], ledger: "set",
          // Records of the block in a file the Harness read before and that no longer holds it go with this write.
          ...(stale.length ? { alsoLedger: stale.map(item => ({ file: item.file, key: INSTRUCTION_KEY, action: "drop" as const })) } : {}),
          check: (before, after) => syncGuard(String(before), String(after), body, separator) };
      } catch (error) { blocked = "无法安全修改 " + shown + "：" + (error instanceof Error ? error.message : "未知原因") + "。"; }
    }
    return { ...await this.host.offerEdit("instructions-sync", harnessId, "指令", true, located.file, read, plan, blocked, notes), proceed: blocked === null ? null : proceed };
  }
  /**
   * Prepares removing HarnessHub's block from one Harness's file (from where it was written, when the Harness reads
   * another file now): the file reads as before HarnessHub's first write, and a file HarnessHub created is deleted once
   * nothing else is in it. A block someone edited, or one not in the ledger, is removed only with `overwrite`.
   */
  async checkRemove(harnessId: string, options: ReadonlySet<InstructionCheckOption>, installed: readonly InstalledHarness[]): Promise<CapabilityChangeCheck> {
    const { harness, located } = await this.prepare(harnessId, installed);
    if ("reason" in located) throw new CapabilityError("CAPABILITY_UNSUPPORTED", located.reason);
    const { own, shadow } = this.entries(harnessId, located.file), entry = shadow ?? own, file = entry?.file ?? located.file, { read, text, block } = this.reading(file), shown = this.host.shown(file);
    const notes = ["只删 " + shown + " 里带 HarnessHub 标记的区块（HarnessHub 新建的文件变空时删除它），不改任何模型、Provider 或登录配置；区块外的内容不动。", EFFECT[harnessId] ?? ""].filter(Boolean);
    let blocked: string | null = null, proceed: CapabilityChangeCheck["proceed"] = null, plan: SwitchPlan | null = null;
    if (read.state === "refused") blocked = "无法修改 " + shown + "：" + read.reason + "。";
    else if (block.kind === "broken") blocked = "无法修改 " + shown + "：" + block.reason + "。";
    else if (block.kind === "none") blocked = "无需修改：" + shown + " 里没有 HarnessHub 区块。";
    else if ((!block.intact || entry === null || entry.valueHash !== hash(block.body)) && !options.has("overwrite")) {
      blocked = (entry === null ? "这个区块不在 HarnessHub 的记录里" : block.intact ? "区块与 HarnessHub 上次写的不同" : "区块里的内容被改过") + "；移除会丢掉区块里现在的内容。"; proceed = { option: "overwrite", label: "仍然移除" };
    }
    if (blocked === null && block.kind === "block") {
      const { created, separator } = placement(entry), after = withoutBlock(text, separator), remove = created && after === "";
      if (remove) notes.push("这个文件是 HarnessHub 新建的，移除区块后为空，会删除它" + (located.fallback !== null && file === located.file ? "，" + harness.name + " 随后重新回退读 " + this.host.shown(located.fallback) : "") + "。");
      if (harnessId === "claude" && await this.opencodeFallsBackTo(file, installed)) notes.push(remove ? "OpenCode 正经回退读这个文件：删除后它也读不到这些指令。" : "OpenCode 正经回退读这个文件：移除后它也读不到这个区块。");
      plan = { kind: "edit", format: "markdown", file, after, remove, key: INSTRUCTION_KEY, written: undefined, previous: null, current: entry !== null ? "harnesshub" : "other", notes: [], ledger: "drop",
        check: (before, afterValue) => findBlock(String(afterValue)).kind === "none" && String(afterValue) === withoutBlock(String(before), separator) };
    }
    return { ...await this.host.offerEdit("instructions-remove", harnessId, "指令", false, file, read, plan, blocked, notes), proceed };
  }
}

/** A write of the block is as planned: the block holds `body` and is intact, and the file outside it is as it was (the separator added with a new block aside). */
export function syncGuard(before: string, after: string, body: string, separator: string): boolean {
  const written = findBlock(after), old = findBlock(before);
  if (written.kind !== "block" || !written.intact || written.body !== body) return false;
  return old.kind === "block" ? withoutBlock(after, "") === withoutBlock(before, "") : old.kind === "none" && withoutBlock(after, separator) === before;
}
