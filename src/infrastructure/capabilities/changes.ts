import { createHash, randomBytes, randomUUID } from "node:crypto";
import { accessSync, constants, existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { capabilityReadTables, harnessDirectories, type HarnessReadTable, type ReadEnvironment } from "../../adapters/capability-reads.js";
import { CAPABILITY_CHECK_MS, CapabilityError, type CapabilityChangeCheck, type CapabilityChangeView, type CapabilityHistory, type CapabilityRestoreCheck } from "../../contracts/capabilities.js";
import { ManagementError } from "../../contracts/management.js";
import { unifiedDiff } from "../control/unified-diff.js";
import { isolatedSandboxProfile } from "../management/native.js";
import { runManagementProcess } from "../management/process.js";
import { parseProcessTable, programName } from "../management/program-usage.js";
import { parsed, UnsafeEdit } from "./edits.js";
import { record } from "./formats.js";
import { maskSecrets } from "./masking.js";
import { readTarget, replaceTarget, type TargetRead } from "./files.js";
import { CapabilityScan, type InstalledHarness } from "./scan.js";
import { resolveHermesHome, resolveOpenClawWorkspace } from "./service.js";
import { CapabilityStore, sha256, type StoredBackup } from "./store.js";
import { claudeSwitch, codexSwitch, listSwitch, opencodeSwitch, openclawSwitch, type SwitchContext, type SwitchPlan, type SwitchRequest } from "./switches.js";

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
}
export type OpenclawRunner = (args: readonly string[], options: { readonly env: Readonly<Record<string, string>>; readonly writable: readonly string[] }, signal: AbortSignal) => Promise<void>;
type Planned = Exclude<SwitchPlan, { kind: "none" }>;
/** `predicted`: for a change made by the Harness's own command, the file that command wrote when run on a copy. */
interface PreparedSwitch { readonly kind: "switch"; readonly expires: number; readonly request: SwitchRequest; readonly plan: Planned | null; readonly before: Buffer | null; readonly predicted: Buffer | null; readonly mode: number; readonly check: CapabilityChangeCheck }
interface PreparedRestore { readonly kind: "restore"; readonly expires: number; readonly backup: StoredBackup; readonly current: string | null; readonly mode: number; readonly check: CapabilityRestoreCheck }

const NAME = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u, COMMAND = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u, FINGERPRINT = /^[a-f0-9]{64}$/u;
const RUNNING: Readonly<Record<string, RegExp>> = { claude: /^claude(?:\.exe)?$/u, gemini: /^gemini$/u };
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
/** OpenClaw's file as compared with its prediction: parsed, without the time it stamps on every write. */
function openclawContent(bytes: Buffer): unknown { const value = record(parsed(bytes.toString("utf8"), "json5")), meta = { ...record(value.meta) }; delete meta.lastTouchedAt; return JSON.parse(JSON.stringify({ ...value, meta })) as unknown; }
/** A diff as shown: the home directory as ~ and secret values masked. */
function displayed(text: string, homes: readonly string[]): string { let out = text; for (const home of [...homes].sort((a, b) => b.length - a.length)) out = out.split(home + "/").join("~/"); return maskSecrets(out); }

/**
 * Changes HarnessHub makes to a Harness's own user-level configuration (ADR-045 §3): each is checked and shown first,
 * applied once on the user's confirmation, and written only while the file is still as it was shown. Before writing,
 * the file's bytes are kept as a backup (the newest ten per file); the write is atomic, read back and checked against
 * the plan, and a result that is not as planned is reported as failed with its backup. Writes to one file run one at a
 * time; `close` waits for the running ones.
 */
export class CapabilityChanges {
  private readonly store: CapabilityStore;
  private readonly prepared = new Map<string, PreparedSwitch | PreparedRestore>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly running = new Set<Promise<unknown>>();
  private closed = false;
  constructor(private readonly options: ChangeOptions) { this.store = CapabilityStore.open(options.root, options.generation); sweepCopies(); }

  private now(): Date { return this.options.now?.() ?? new Date(); }
  private shown(path: string): string { for (const home of [...this.options.homes].sort((a, b) => b.length - a.length)) { if (path === home) return "~"; if (path.startsWith(home + "/")) return "~/" + path.slice(home.length + 1); } return path; }
  private owned(): void { if (this.closed) throw new CapabilityError("OWNERSHIP_LOST", "capability changes are closed"); this.options.assertOwner(); this.store.assertIdentity(); }
  private track<T>(work: Promise<T>): Promise<T> { this.running.add(work); void work.finally(() => this.running.delete(work)).catch(() => {}); return work; }
  /** Runs `work` after every earlier write of the same file. */
  private serial<T>(file: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(file) ?? Promise.resolve(), next = previous.catch(() => {}).then(work);
    this.queues.set(file, next); void next.finally(() => { if (this.queues.get(file) === next) this.queues.delete(file); }).catch(() => {});
    return this.track(next);
  }
  private context(harnessId: string): SwitchContext { return { ledger: (file, key) => this.store.ledger(harnessId, file, key), hash: value => hash(JSON.stringify(value ?? null)) }; }

  /**
   * Prepares turning one skill off (`enabled` false) or on for one installed Harness: which file changes and the exact
   * diff, or the Harness's own command; who wrote the setting it changes; and what to know before confirming.
   * `via` is the copy (as the view shows it) for Codex, which switches copies by path; ignored by the others.
   */
  checkSkillSwitch(input: { readonly harnessId: string; readonly name: string; readonly enabled: boolean; readonly via: string | null }, installed: readonly InstalledHarness[]): Promise<CapabilityChangeCheck> {
    if (this.closed) return Promise.reject(new CapabilityError("OWNERSHIP_LOST", "capability changes are closed"));
    return this.track(this.prepareSwitch(input, installed));
  }
  /** Forgets confirmations past their time, and the oldest beyond 256 unused ones. */
  private prune(): void {
    const now = this.now().getTime();
    for (const [fingerprint, prepared] of this.prepared) if (prepared.expires < now) this.prepared.delete(fingerprint);
    for (const fingerprint of [...this.prepared.keys()].slice(0, Math.max(0, this.prepared.size - 255))) this.prepared.delete(fingerprint);
  }
  private async prepareSwitch(input: { readonly harnessId: string; readonly name: string; readonly enabled: boolean; readonly via: string | null }, installed: readonly InstalledHarness[]): Promise<CapabilityChangeCheck> {
    this.prune();
    if (!NAME.test(input.name)) throw new CapabilityError("INVALID_INPUT", "invalid skill name");
    const harness = installed.find(item => item.harnessId === input.harnessId);
    if (!harness) throw new CapabilityError("CAPABILITY_NOT_FOUND", "this Harness has no official installation here");
    const environment = this.options.environment, hermesHome = await resolveHermesHome(environment), openclawWorkspace = await resolveOpenClawWorkspace(environment);
    const table = capabilityReadTables(environment, { hermesHome, openclawWorkspace }).find(item => item.harnessId === input.harnessId);
    if (!table || table.skills.switch === null) throw new CapabilityError("CAPABILITY_UNSUPPORTED", harness.name + " 没有按技能停用的开关，它的技能始终可见");
    // The skill must be one this Harness sees, and Codex's copy one of the places it reads it from.
    const view = await new CapabilityScan(environment, this.options.homes, hermesHome).view([table], [harness], this.now().toISOString());
    const edges = view.entries.find(entry => entry.kind === "skill" && entry.name === input.name)?.edges.filter(edge => edge.harnessId === input.harnessId) ?? [];
    if (!edges.length) throw new CapabilityError("CAPABILITY_NOT_FOUND", harness.name + " 看不到名为 " + input.name + " 的技能");
    let folder: string | null = null;
    if (table.skills.switch.kind === "codex-skills-config") {
      const edge = edges.find(item => item.via === input.via && item.status !== "broken-link");
      if (!edge) throw new CapabilityError("CAPABILITY_NOT_FOUND", "Codex 不在这个位置读取这个技能");
      folder = edge.via.startsWith("~/") ? join(environment.home, edge.via.slice(2)) : edge.via;
    }
    const request: SwitchRequest = { harnessId: input.harnessId, name: input.name, enabled: input.enabled, folder };
    const { file, read, plan, blocked } = await this.plan(table, request);
    const before = read.state === "ok" ? read.bytes : null, beforeText = before?.toString("utf8") ?? "";
    const notes = plan !== null && plan.kind !== "none" ? [...plan.notes] : [];
    if (plan?.kind === "edit" && read.state === "missing") notes.push("会新建这个文件。");
    notes.push(...await this.runningNotes(input.harnessId));
    let reason = blocked ?? (plan?.kind === "none" ? "无需修改：" + plan.reason : null), diff: string | null = null;
    if (reason === null && plan?.kind === "edit") {
      // The guard every edit passes: the planned file differs from the current one only at the setting it changes.
      try { if (!plan.check(parsed(beforeText, plan.format), parsed(plan.after, plan.format))) reason = "无法安全修改：改动会超出这个设置，没有准备写入。"; }
      catch (error) { reason = "无法安全修改：" + (error instanceof Error ? error.message : "未知原因"); }
      diff = displayed(unifiedDiff(this.shown(file), read.state === "ok" ? beforeText : null, plan.after, 2), this.options.homes);
    }
    let predicted: Buffer | null = null, rewrite: CapabilityChangeCheck["rewrite"] = null;
    if (reason === null && plan?.kind === "command" && before !== null) {
      // The same command on a private copy shows exactly what it will write, defaults it adds included.
      try { predicted = await this.predict(plan.args, before); diff = displayed(unifiedDiff(this.shown(file), beforeText, predicted.toString("utf8"), 2), this.options.homes); }
      catch (error) { reason = "OpenClaw 的预演没有通过，没有准备写入（" + (error instanceof Error ? error.message : "未知原因") + "）。"; }
      if (predicted !== null) {
        rewrite = rewriteSummary(beforeText, predicted.toString("utf8"), ["skills", "entries", input.name, "enabled"]);
        const restart = rewriteRestarts(beforeText, predicted.toString("utf8"), ["skills", "entries", input.name, "enabled"]);
        if (restart.length) reason = "OpenClaw 的命令还会改动需要重启 Gateway 的设置（" + restart.join("、") + "），HarnessHub 不做这项修改。";
      }
    }
    const fingerprint = randomBytes(32).toString("hex"), expires = this.now().getTime() + CAPABILITY_CHECK_MS;
    const check: CapabilityChangeCheck = { kind: "skill-switch", harnessId: input.harnessId, name: input.name, enabled: input.enabled, file: this.shown(file),
      command: plan?.kind === "command" ? "openclaw " + plan.args.join(" ") : null, diff, rewrite, current: plan !== null && plan.kind !== "none" ? plan.current : "none", notes, blocked: reason,
      fingerprint, expiresAt: new Date(expires).toISOString() };
    this.prepared.set(fingerprint, { kind: "switch", expires, request, plan: plan === null || plan.kind === "none" ? null : plan, before, predicted, mode: read.state === "ok" ? read.mode : 0o600, check });
    return check;
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
    const text = read.state === "ok" ? read.bytes.toString("utf8") : "";
    try {
      switch (source.kind) {
        case "claude-skill-overrides": return { file, read, plan: claudeSwitch(file, text, request, context), blocked: null };
        case "codex-skills-config": return { file, read, plan: codexSwitch(file, text, request, context), blocked: null };
        case "gemini-skills-disabled": return { file, read, plan: listSwitch(file, text, "jsonc", request, context, ["改完后在 Gemini 里用 /skills reload 或重开才生效。"]), blocked: null };
        case "hermes-skills-disabled": return { file, read, plan: listSwitch(file, text, "yaml", request, context, ["正在运行的 Hermes 网关（QQ 等消息渠道）不会被 HarnessHub 重启；长驻的 Hermes 进程要 /reload-skills 或重启后才生效。"]), blocked: null };
        case "opencode-permission": return { file, read, plan: opencodeSwitch(file, text, earlier, request, context), blocked: null };
        case "openclaw-entries": return { file, read, plan: openclawSwitch(file, text, request, context), blocked: null };
      }
    } catch (error) {
      if (error instanceof UnsafeEdit) return { file, read, plan: null, blocked: "无法安全修改 " + this.shown(file) + "：" + error.message + "。" };
      throw error;
    }
  }
  /** Running sessions that read or overwrite the file (Claude Code, Gemini CLI), counted without their arguments. */
  private async runningNotes(harnessId: string): Promise<readonly string[]> {
    const pattern = RUNNING[harnessId];
    if (!pattern) return [];
    let table: ReturnType<typeof parseProcessTable> = null;
    try { table = parseProcessTable(await (this.options.processes ?? systemProcesses)(AbortSignal.timeout(5000))); } catch { table = null; }
    if (table === null) return ["没能读取正在运行的程序。"];
    const count = table.filter(row => pattern.test(programName(row.command))).length;
    if (!count) return [];
    return harnessId === "claude" ? ["有 " + count + " 个 Claude Code 进程在运行，它们会立即读到这次改动。"]
      : ["有 " + count + " 个 Gemini CLI 进程在运行。运行中的会话保存设置时会按启动时的快照覆盖 settings.json，可能冲掉这次改动；建议先退出它们。"];
  }

  /** Applies a confirmed check once; a replay of the same command returns its first result. */
  apply(fingerprint: string, commandId: string): Promise<CapabilityChangeView> {
    if (!FINGERPRINT.test(fingerprint) || !COMMAND.test(commandId)) return Promise.reject(new CapabilityError("INVALID_INPUT", "invalid change confirmation"));
    const replay = this.replay(commandId, fingerprint);
    if (replay) return Promise.resolve(replay);
    const prepared = this.prepared.get(fingerprint);
    if (!prepared || prepared.kind !== "switch" || prepared.expires < this.now().getTime()) return Promise.reject(new CapabilityError("CAPABILITY_CHECK_EXPIRED", "这次确认已过期或已用过，请重新检查"));
    if (prepared.check.blocked !== null || prepared.plan === null) return Promise.reject(new CapabilityError("CAPABILITY_TARGET_REFUSED", prepared.check.blocked ?? "这项检查不能执行"));
    this.prepared.delete(fingerprint);
    const plan = prepared.plan;
    return this.serial(plan.file, async () => {
      this.owned();
      const current = readTarget(plan.file), expected = prepared.before === null ? null : sha256(prepared.before);
      if (!(expected === null ? current.state === "missing" : current.state === "ok" && sha256(current.bytes) === expected)) throw new CapabilityError("CAPABILITY_TARGET_CHANGED", "文件在确认之后被改动过，没有写入；请重新检查");
      const id = randomUUID(), at = this.now().toISOString(), backupId = prepared.before === null ? null : randomUUID();
      if (backupId !== null) this.store.saveBackup({ id: backupId, file: plan.file, createdAt: at, changeId: id, subject: prepared.request.name }, prepared.before!);
      const beforeText = prepared.before?.toString("utf8") ?? "";
      let error: { code: string; message: string } | null = null, written: Buffer | null = null;
      try {
        if (plan.kind === "edit") replaceTarget(plan.file, expected, Buffer.from(plan.after, "utf8"), prepared.mode);
        else await (this.options.openclaw ?? systemOpenclaw(this.options.environment))(plan.args, { env: {}, writable: [dirname(plan.file)] }, AbortSignal.timeout(60_000));
        const after = readTarget(plan.file);
        if (after.state !== "ok") error = { code: "CAPABILITY_READBACK_FAILED", message: "写入后读不到这个文件" };
        else {
          written = after.bytes;
          const afterText = after.bytes.toString("utf8");
          if (plan.kind === "edit" && afterText !== plan.after) error = { code: "CAPABILITY_READBACK_MISMATCH", message: "写入后的内容与计划不一致" };
          else if (plan.kind === "edit" ? !plan.check(parsed(beforeText, plan.format), parsed(afterText, plan.format)) : !plan.check(parsed(afterText, "json5"))) error = { code: "CAPABILITY_READBACK_MISMATCH", message: "写入后的设置与计划不一致" };
          else if (plan.kind === "command" && prepared.predicted !== null && !isDeepStrictEqual(openclawContent(after.bytes), openclawContent(prepared.predicted))) error = { code: "CAPABILITY_READBACK_MISMATCH", message: "OpenClaw 写入的内容与预演不一致" };
        }
      } catch (failure) {
        if (failure instanceof CapabilityError && failure.code === "CAPABILITY_TARGET_CHANGED") { if (backupId !== null) this.store.dropBackup(backupId); throw failure; }
        error = { code: failure instanceof CapabilityError ? failure.code : "CAPABILITY_WRITE_FAILED", message: failure instanceof Error ? failure.message : "写入失败" };
        const after = readTarget(plan.file); written = after.state === "ok" ? after.bytes : null;
      }
      if (backupId !== null && written !== null) this.store.setWritten(backupId, written);
      if (error === null) {
        if (plan.ledger === "set") this.store.setLedger({ harnessId: prepared.request.harnessId, file: plan.file, key: plan.key, valueHash: hash(JSON.stringify(plan.written ?? null)), previous: plan.previous, changeId: id, at });
        else this.store.dropLedger(prepared.request.harnessId, plan.file, plan.key);
      }
      const changed = written !== null && (prepared.before === null || !written.equals(prepared.before));
      const view: CapabilityChangeView = { id, kind: "skill-switch", harnessId: prepared.request.harnessId, subject: prepared.request.name, file: this.shown(plan.file), status: error === null ? "applied" : "failed",
        diff: changed ? displayed(unifiedDiff(this.shown(plan.file), prepared.before === null ? null : beforeText, written!.toString("utf8"), 2), this.options.homes) : null,
        backupId: changed ? backupId : null, error, notes: error === null ? prepared.check.notes : [...(changed && backupId !== null ? ["可以在“修改与备份”里恢复修改前的文件。"] : [])], at };
      this.store.saveChange(commandId, hash(fingerprint), view);
      return view;
    });
  }
  private replay(commandId: string, fingerprint: string): CapabilityChangeView | null {
    const stored = this.store.change(commandId);
    if (stored === null) return null;
    if (stored.payloadHash !== hash(fingerprint)) throw new CapabilityError("INVALID_INPUT", "这个命令编号已用于另一项修改");
    return stored.view;
  }

  /** HarnessHub's recent changes and the backups it keeps, newest first. */
  history(): CapabilityHistory {
    return { changes: this.store.changes(50), backups: this.store.backups().map(item => ({ id: item.id, file: this.shown(item.file), createdAt: item.createdAt, bytes: item.bytes, changeId: item.changeId, subject: item.subject })) };
  }
  /** Prepares restoring a backup: what it changes now, and whether the file was changed by someone else after HarnessHub. */
  async checkRestore(backupId: string): Promise<CapabilityRestoreCheck> {
    if (this.closed) throw new CapabilityError("OWNERSHIP_LOST", "capability changes are closed");
    this.prune();
    const backup = /^[a-f0-9-]{36}$/u.test(backupId) ? this.store.backup(backupId) : null;
    if (backup === null) throw new CapabilityError("CAPABILITY_NOT_FOUND", "没有这份备份");
    const bytes = this.store.backupBytes(backupId), current = readTarget(backup.file);
    if (current.state === "refused") throw new CapabilityError("CAPABILITY_TARGET_REFUSED", "无法恢复：" + current.reason);
    const currentSha = current.state === "ok" ? sha256(current.bytes) : null, changedSince = backup.writtenSha256 === null || currentSha !== backup.writtenSha256;
    const fingerprint = randomBytes(32).toString("hex"), expires = this.now().getTime() + CAPABILITY_CHECK_MS;
    const check: CapabilityRestoreCheck = { backupId, file: this.shown(backup.file), diff: displayed(unifiedDiff(this.shown(backup.file), current.state === "ok" ? current.bytes.toString("utf8") : null, bytes.toString("utf8"), 2), this.options.homes),
      changedSince, notes: [...(changedSince ? ["这个文件在 HarnessHub 改动之后又被改过，恢复会连这些改动一起撤销。"] : []), "恢复前会先备份现在的文件。"], fingerprint, expiresAt: new Date(expires).toISOString() };
    this.prepared.set(fingerprint, { kind: "restore", expires, backup, current: currentSha, mode: current.state === "ok" ? current.mode : 0o600, check });
    return check;
  }
  /** Restores a confirmed backup once, after backing up the file as it is now. */
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
        error = { code: "CAPABILITY_WRITE_FAILED", message: failure instanceof Error ? failure.message : "恢复失败" };
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
function commentLines(text: string): number { return text.split("\n").filter(line => /(^|[^:"'\\])\/\/|\/\*/u.test(line)).length; }
/** A whole-file rewrite summarized for its confirmation: the target before and after, the other keys it touches, the comments it drops. */
function rewriteSummary(beforeText: string, afterText: string, target: readonly string[]): NonNullable<CapabilityChangeCheck["rewrite"]> {
  const value = (text: string): string | null => { let current: unknown = parsed(text, "json5"); for (const key of target) current = record(current)[key]; return current === undefined ? null : JSON.stringify(current); };
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
