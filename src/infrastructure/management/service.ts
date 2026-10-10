import { createHash, randomUUID } from "node:crypto";
import { constants, lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { gt, valid } from "semver";
import { ManagementError, type HarnessManagementView, type InstallCapability, type InstallationJobView, type InstallationLog,
  type ManagementInstallerPort, type ManagementMetadataPort, type ManagementRecipe, type ResolvedManagedControl } from "../../contracts/management.js";
import type { SystemInstallationObservation, SystemVersionProbeOptions } from "../../contracts/management.js";
import { boundedManagementLimit, installationJobId, managementCommand, managementSlug, parseManagementInput } from "../../contexts/management/domain/input.js";
import { builtinManagementRecipes } from "../../adapters/management/recipes.js";
import { DefaultManagementInstaller, installedNpmEntry } from "./installer.js";
import { insideManagement } from "./archive.js";
import { OfficialManagementMetadata } from "./metadata.js";
import { boundedManagementFile, managementIdentity, managementStorage, sameManagementIdentity } from "./storage.js";
import { managementInteger, managementObject, parseInstallationRecord, parseManagementJob, parseManagementLog, parseManagementUpdate, type InstallationRecord } from "../../contexts/management/domain/state.js";
import { probeSystemVersion } from "./system-version.js";

export interface ManagementOptions {
  readonly assertOwner: () => void;
  readonly ownerGeneration: number;
  readonly metadata?: ManagementMetadataPort;
  readonly installer?: ManagementInstallerPort;
  readonly recipes?: readonly ManagementRecipe[];
  readonly npmExecutable?: string;
  readonly nodeExecutable?: string;
  readonly uvExecutable?: string;
  readonly now?: () => Date;
  readonly runTimeoutMs?: number;
  readonly redactor?: (text: string) => string;
  readonly systemVersionProbe?: (observation: SystemInstallationObservation, options: SystemVersionProbeOptions) => Promise<{ version: string | null; reason: string | null }>;
}
const openRoots = new Set<string>();
function importedFile(path: string): string { return new TextDecoder("utf8", { fatal: true }).decode(boundedManagementFile(path, 4096)); }
function relativeSlot(root: string, path: string): string { return relative(root, path).replaceAll("\\", "/"); }
const terminal = (status: InstallationJobView["status"]): boolean => ["completed", "cancelled", "failed", "unknown"].includes(status);
function json(value: unknown): unknown {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 65536) throw new ManagementError("INVALID_DATA", "management record exceeded its byte budget");
  try { return JSON.parse(value); } catch { throw new ManagementError("INVALID_DATA", "management record is invalid"); }
}
function executable(name: string): string | null {
  for (const directory of (process.env.PATH ?? "").split(":")) {
    if (!isAbsolute(directory)) continue;
    try { const path = realpathSync(join(directory, name)); if (lstatSync(path).isFile()) return path; } catch { /* unavailable candidate */ }
  } return null;
}
export class LocalHarnessManagement {
  private readonly storage: ReturnType<typeof managementStorage>;
  private readonly recipes: readonly ManagementRecipe[];
  private readonly metadata: ManagementMetadataPort;
  private readonly installer: ManagementInstallerPort;
  private readonly node: string;
  private readonly npm: string | null;
  private readonly uv: string | null;
  private readonly timeout: number;
  private readonly redactor: (text: string) => string;
  private runner: Promise<void> | null = null;
  private readonly checks = new Set<Promise<readonly HarnessManagementView[]>>();
  private readonly checkControllers = new Set<AbortController>();
  private readonly system = new Map<string, SystemInstallationObservation>();
  private readonly systemVersions = new Map<string, { fingerprint: string; version: string | null }>();
  private active: { id: string; controller: AbortController; timedOut: boolean } | null = null;
  private accepting = true;
  private closed = false;
  private stopping: Promise<void> | null = null;
  constructor(root: string, private readonly options: ManagementOptions) {
    options.assertOwner(); this.timeout = options.runTimeoutMs ?? 10 * 60 * 1000;
    if (!Number.isSafeInteger(this.timeout) || this.timeout < 20 || this.timeout > 10 * 60 * 1000) throw new ManagementError("INVALID_INPUT", "invalid installation timeout");
    this.node = realpathSync(options.nodeExecutable ?? process.execPath); this.npm = options.npmExecutable ?? executable("npm"); this.uv = options.uvExecutable ?? executable("uv");
    this.redactor = options.redactor ?? (text => text); this.recipes = options.recipes ?? builtinManagementRecipes();
    this.metadata = options.metadata ?? new OfficialManagementMetadata();
    this.installer = options.installer ?? new DefaultManagementInstaller({ nodeExecutable: this.node, npmExecutable: this.npm, uvExecutable: this.uv });
    if (openRoots.has(join(realpathSync(root), "management"))) throw new ManagementError("MANAGEMENT_BUSY", "management root already has an owner in this process");
    this.storage = managementStorage(root, options.ownerGeneration);
    if (openRoots.has(this.storage.root)) { this.storage.db.close(); throw new ManagementError("MANAGEMENT_BUSY", "management root already has an owner in this process"); }
    openRoots.add(this.storage.root);
    try {
      this.auditStorage();
      for (const row of this.storage.db.prepare("SELECT id FROM management_jobs WHERE status NOT IN('completed','cancelled','failed','unknown')").all()) {
        if (typeof row.id !== "string") throw new ManagementError("INVALID_DATA", "invalid interrupted job identity");
        const job = this.readJob(row.id); this.saveJob({ ...job,
        status: job.status === "queued" ? "cancelled" : "unknown", phase: "interrupted", updatedAt: this.now(),
        error: { code: "INTERRUPTED", message: "previous management owner ended before installation settlement; work is not replayed" } });
      }
    } catch (error) { openRoots.delete(this.storage.root); this.storage.db.close(); throw error; }
  }
  private now(): string { return (this.options.now?.() ?? new Date()).toISOString(); }
  private own(): void {
    if (this.closed) throw new ManagementError("MANAGEMENT_CLOSED", "management service is closed");
    try { this.options.assertOwner(); this.storage.assertIdentity(); }
    catch (error) { this.accepting = false; this.active?.controller.abort(); for (const check of this.checkControllers) check.abort(); throw error; }
  }
  private admission(): void { this.own(); if (!this.accepting) throw new ManagementError("MANAGEMENT_CLOSED", "management service is shutting down"); }
  private recipe(harness: string, control?: string): ManagementRecipe | null {
    const candidates = this.recipes.filter(item => item.harnessId === harness);
    if (control !== undefined) return candidates.find(item => item.controlId === control) ?? null;
    return candidates.find(item => item.controlId === "codex-native" || item.controlId === "openclaw-native") ?? candidates.find(item => item.kind === "npm") ?? candidates[0] ?? null;
  }
  capability(harnessId: string): InstallCapability | null {
    this.own(); const recipe = this.recipe(managementSlug(harnessId)); if (!recipe) return null;
    let reason: string | null = null;
    if (harnessId === "kimi") reason = "legacy Kimi CLI description is archived; the new Kimi Code recipe must be reviewed";
    else if (recipe.kind === "npm" && this.npm === null && this.options.installer === undefined) reason = "npm runtime was not found";
    else if (recipe.kind === "python" && this.uv === null && this.options.installer === undefined) reason = "uv runtime was not found";
    return { controlId: recipe.controlId, kind: recipe.kind, sourceLabel: recipe.kind === "binary" ? "ACP reviewed release archive" : recipe.kind === "npm" ? "npm registry" : "PyPI / private uv tool",
      packageName: recipe.packageName, referenceVersion: recipe.referenceVersion, canInstall: reason === null, reason };
  }
  private systemFingerprint(observation: SystemInstallationObservation): string { return createHash("sha256").update(JSON.stringify(observation)).digest("hex"); }
  /** Read-only inventory observations do not launch programs and do not erase an unchanged version observation. */
  setSystemObservations(entries: readonly SystemInstallationObservation[]): void {
    this.own(); const external: unknown = entries;
    if (!Array.isArray(external) || entries.length > 256) throw new ManagementError("INVALID_INPUT", "too many system installations observed");
    const chosen = new Map<string, SystemInstallationObservation>();
    for (const entry of entries) {
      managementSlug(entry.harnessId); managementSlug(entry.controlId);
      if (!isAbsolute(entry.command.executable) || entry.command.args.length > 64 || entry.command.args.some(arg => typeof arg !== "string" || arg.length > 4096))
        throw new ManagementError("INVALID_INPUT", "invalid system installation command observation");
      const preferred = this.recipe(entry.harnessId)?.controlId, existing = chosen.get(entry.harnessId);
      if (existing === undefined || entry.controlId === preferred) chosen.set(entry.harnessId, {
        harnessId: entry.harnessId, controlId: entry.controlId, command: { executable: entry.command.executable, args: [...entry.command.args], env: { ...entry.command.env } },
        ...(entry.packageVersion === undefined ? {} : { packageVersion: entry.packageVersion }) });
    }
    this.system.clear(); for (const [id, entry] of chosen) this.system.set(id, entry);
  }
  private systemVersion(harnessId: string): string | null {
    const observation = this.system.get(harnessId); if (!observation) return null;
    const cached = this.systemVersions.get(harnessId); if (cached?.fingerprint === this.systemFingerprint(observation)) return cached.version;
    return observation.packageVersion !== undefined && valid(observation.packageVersion) ? observation.packageVersion : null;
  }
  listJobs(limit?: number): readonly InstallationJobView[] {
    this.own(); const count = boundedManagementLimit(limit, 1000);
    const total = this.storage.db.prepare("SELECT count(*) AS n FROM management_jobs").get()?.n;
    if (typeof total !== "number" || total > 2048) throw new ManagementError("STORAGE_LIMIT", "installation job budget exceeded");
    this.payloadBudgets();
    return this.storage.db.prepare("SELECT id,harness_id,status,view_json FROM management_jobs ORDER BY rowid DESC LIMIT ?").all(count).map(row => this.parseJobRow(row));
  }
  readJob(id: string): InstallationJobView {
    this.own(); installationJobId(id);
    const budget = this.storage.db.prepare("SELECT length(CAST(view_json AS BLOB)) AS bytes FROM management_jobs WHERE id=?").get(id);
    if (!budget) throw new ManagementError("JOB_NOT_FOUND", "installation job was not found");
    if (typeof budget.bytes !== "number" || budget.bytes > 65536) throw new ManagementError("INVALID_DATA", "installation job exceeded its byte budget");
    const row = this.storage.db.prepare("SELECT id,harness_id,status,view_json FROM management_jobs WHERE id=? AND length(CAST(view_json AS BLOB))<=65536").get(id);
    if (!row) throw new ManagementError("INVALID_DATA", "installation job changed during reading");
    return this.parseJobRow(row);
  }
  logs(id: string, afterSeq: number, limit?: number): readonly InstallationLog[] {
    this.readJob(id); if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new ManagementError("INVALID_INPUT", "invalid installation log cursor");
    this.payloadBudgets();
    return this.storage.db.prepare("SELECT seq,entry_json FROM management_logs WHERE job_id=? AND seq>? ORDER BY seq LIMIT ?").all(id, afterSeq, boundedManagementLimit(limit, 1000)).map(row => {
      const entry = parseManagementLog(json(row.entry_json)); if (entry.seq !== row.seq) throw new ManagementError("INVALID_DATA", "installation log sequence changed"); return entry;
    });
  }
  private saveJob(job: InstallationJobView): void {
    this.own(); parseManagementJob(job); this.storage.db.prepare("UPDATE management_jobs SET status=?,view_json=? WHERE id=?").run(job.status, JSON.stringify(job), job.id);
  }
  private payloadBudgets(): void {
    for (const [table, column, size, maximum] of [["management_jobs", "view_json", 65536, 2048], ["management_installations", "record_json", 65536, 2048],
      ["management_updates", "view_json", 65536, 256], ["management_logs", "entry_json", 32768, 65536]] as const) {
      const total = this.storage.db.prepare("SELECT count(*) AS count,coalesce(sum(length(CAST(" + column + " AS BLOB))),0) AS bytes FROM " + table).get();
      if (!total || typeof total.count !== "number" || total.count > maximum || typeof total.bytes !== "number" || total.bytes > 32 * 1024 * 1024)
        throw new ManagementError("STORAGE_LIMIT", "management storage exceeded its row or byte budget");
      if (this.storage.db.prepare("SELECT 1 FROM " + table + " WHERE length(CAST(" + column + " AS BLOB))>? LIMIT 1").get(size))
        throw new ManagementError("INVALID_DATA", "management payload exceeded its byte budget");
    }
    if (this.storage.db.prepare("SELECT 1 FROM management_jobs WHERE length(CAST(id AS BLOB))>64 OR length(CAST(harness_id AS BLOB))>96 OR length(CAST(status AS BLOB))>16 OR length(CAST(command_id AS BLOB))>128 OR length(CAST(fingerprint AS BLOB))>64 OR expected_revision NOT BETWEEN 0 AND 2048 LIMIT 1").get() ||
        this.storage.db.prepare("SELECT 1 FROM management_commands WHERE length(CAST(id AS BLOB))>128 OR length(CAST(fingerprint AS BLOB))>64 OR length(CAST(job_id AS BLOB))>64 LIMIT 1").get() ||
        this.storage.db.prepare("SELECT 1 FROM management_installations WHERE length(CAST(id AS BLOB))>64 OR length(CAST(harness_id AS BLOB))>96 OR length(CAST(control_id AS BLOB))>96 LIMIT 1").get() ||
        this.storage.db.prepare("SELECT 1 FROM management_defaults WHERE length(CAST(harness_id AS BLOB))>96 OR length(CAST(installation_id AS BLOB))>64 OR revision NOT BETWEEN 1 AND 2048 LIMIT 1").get())
      throw new ManagementError("INVALID_DATA", "management index metadata exceeded its byte or revision budget");
  }
  private parseJobRow(row: Record<string, unknown>): InstallationJobView {
    const job = parseManagementJob(json(row.view_json));
    if (row.id !== job.id || row.harness_id !== job.harnessId || row.status !== job.status) throw new ManagementError("INVALID_DATA", "installation job row disagrees with its public facts");
    const water = this.storage.db.prepare("SELECT count(*) AS count,coalesce(max(seq),0) AS seq FROM management_logs WHERE job_id=?").get(job.id);
    if (!water || water.count !== job.logCursor || water.seq !== job.logCursor) throw new ManagementError("INVALID_DATA", "installation log watermark is inconsistent");
    return job;
  }
  private auditStorage(): void {
    this.own(); this.payloadBudgets();
    const ids = new Set<string>();
    for (const row of this.storage.db.prepare("SELECT id,harness_id,status,view_json FROM management_jobs").all()) ids.add(this.parseJobRow(row).id);
    for (const row of this.storage.db.prepare("SELECT job_id,seq,entry_json FROM management_logs").all()) {
      const log = parseManagementLog(json(row.entry_json)); if (row.seq !== log.seq || typeof row.job_id !== "string" || !ids.has(row.job_id)) throw new ManagementError("INVALID_DATA", "orphan or inconsistent installation log");
    }
    for (const row of this.storage.db.prepare("SELECT id,harness_id,control_id,record_json FROM management_installations").all()) {
      const record = parseInstallationRecord(json(row.record_json));
      if (record.id !== row.id || record.harnessId !== row.harness_id || record.controlId !== row.control_id) throw new ManagementError("INVALID_DATA", "installation record row identity disagrees");
      this.verifyStoredRecord(record);
    }
    for (const row of this.storage.db.prepare("SELECT harness_id,installation_id,revision FROM management_defaults").all()) {
      if (typeof row.harness_id !== "string" || typeof row.installation_id !== "string") throw new ManagementError("INVALID_DATA", "managed default pointer is invalid");
      managementSlug(row.harness_id); managementInteger(row.revision, 1);
      const matched = this.storage.db.prepare("SELECT harness_id FROM management_installations WHERE id=?").get(row.installation_id);
      if (!matched || matched.harness_id !== row.harness_id) throw new ManagementError("INVALID_DATA", "managed default pointer is dangling");
    }
    for (const row of this.storage.db.prepare("SELECT harness_id,view_json FROM management_updates").all()) { managementSlug(row.harness_id); parseManagementUpdate(json(row.view_json)); }
  }
  private verifyStoredRecord(record: InstallationRecord): void {
    if (record.slot !== join(this.storage.root, "slots", record.id)) throw new ManagementError("INVALID_DATA", "managed installation slot namespace changed");
    managementIdentity(record.slot, true); const markerPath = join(record.slot, ".slot.json"); managementIdentity(markerPath);
    const marker = managementObject(json(importedFile(markerPath)), ["installationId", "jobId", "ownerGeneration"]);
    if (marker.installationId !== record.id || typeof marker.jobId !== "string") throw new ManagementError("INVALID_DATA", "managed slot marker identity changed");
    managementInteger(marker.ownerGeneration, 1); const job = this.readJob(marker.jobId);
    if (job.status !== "completed" || job.installationId !== record.id || job.harnessId !== record.harnessId || job.controlId !== record.controlId || job.resolvedVersion !== record.version)
      throw new ManagementError("INVALID_DATA", "managed slot has no completed publication evidence");
    const recipe = this.recipe(record.harnessId, record.controlId); if (!recipe) throw new ManagementError("INVALID_DATA", "managed installation recipe disappeared");
    const launchPath = join(record.slot, ".launch.json"); managementIdentity(launchPath);
    const launchBytes = boundedManagementFile(launchPath, 65536);
    if (createHash("sha256").update(launchBytes).digest("hex") !== record.launchSha256 ||
        new TextDecoder("utf8", { fatal: true }).decode(launchBytes) !== JSON.stringify(record.command)) throw new ManagementError("INVALID_DATA", "managed launch receipt disagrees with committed command");
    const executable = realpathSync(record.command.executable);
    if (recipe.kind === "npm") {
      if (!recipe.packageName) throw new ManagementError("INVALID_DATA", "managed package identity disappeared");
      const entry = realpathSync(installedNpmEntry(record.slot, recipe.packageName, record.version, recipe.binName));
      if (!insideManagement(record.slot, entry) || record.command.args[0] !== entry || !lstatSync(entry).isFile() ||
          (executable !== this.node && !/^runtime\/node-v24\.[0-9]+\.[0-9]+-[a-z0-9-]+\/bin\/node$/u.test(relativeSlot(record.slot, executable))))
        throw new ManagementError("INVALID_DATA", "managed package entry or runtime identity changed");
      if (JSON.stringify(record.command.args.slice(1)) !== JSON.stringify(recipe.args) || Object.keys(record.command.env).some(key => key !== "PATH"))
        throw new ManagementError("INVALID_DATA", "managed npm arguments or environment no longer match its recipe");
    } else if (!insideManagement(record.slot, executable) || !lstatSync(executable).isFile()) throw new ManagementError("INVALID_DATA", "managed binary entry escaped its slot");
  }
  private defaultRevision(harnessId: string): number {
    const row = this.storage.db.prepare("SELECT revision FROM management_defaults WHERE harness_id=?").get(harnessId);
    if (!row) return 0; if (typeof row.revision !== "number" || !Number.isSafeInteger(row.revision) || row.revision < 1) throw new ManagementError("INVALID_DATA", "managed default revision is invalid"); return row.revision;
  }
  submit(input: unknown): InstallationJobView {
    this.admission(); this.payloadBudgets(); const request = parseManagementInput(input), recipe = this.recipe(request.harnessId, request.controlId);
    if (!recipe) throw new ManagementError("UNSUPPORTED_MANAGEMENT", "this Harness has no reviewed installation recipe");
    const capability = this.capability(request.harnessId);
    if (capability?.canInstall === false && capability.controlId === recipe.controlId) throw new ManagementError("UNSUPPORTED_MANAGEMENT", capability.reason ?? "installation is unavailable");
    const fingerprint = createHash("sha256").update(JSON.stringify({ harnessId: request.harnessId, controlId: recipe.controlId, action: request.action,
      expectedDefaultRevision: request.expectedDefaultRevision ?? null })).digest("hex"), prior = this.storage.db.prepare("SELECT id,fingerprint FROM management_jobs WHERE command_id=?").get(request.commandId);
    if (prior) { if (prior.fingerprint !== fingerprint || typeof prior.id !== "string") throw new ManagementError("COMMAND_CONFLICT", "management command already used different input"); return this.readJob(prior.id); }
    if (this.storage.db.prepare("SELECT id FROM management_commands WHERE id=?").get(request.commandId)) throw new ManagementError("COMMAND_CONFLICT", "management command identity already used by cancellation");
    const active = this.storage.db.prepare("SELECT id FROM management_jobs WHERE harness_id=? AND status NOT IN('completed','cancelled','failed','unknown')").get(request.harnessId);
    if (active) throw new ManagementError("MANAGEMENT_BUSY", "this Harness already has an active installation job");
    const queued = this.storage.db.prepare("SELECT count(*) AS n FROM management_jobs WHERE status='queued'").get()?.n;
    if (typeof queued !== "number" || queued >= 8 || this.storage.db.prepare("SELECT count(*) AS n FROM management_jobs").get()?.n === 2048)
      throw new ManagementError("QUEUE_LIMIT", "installation job queue or storage budget exhausted");
    const revision = this.defaultRevision(request.harnessId);
    if (request.expectedDefaultRevision !== undefined && request.expectedDefaultRevision !== revision) throw new ManagementError("DEFAULT_CONFLICT", "managed default changed since it was read");
    const time = this.now(), job: InstallationJobView = { id: "management-" + randomUUID(), harnessId: recipe.harnessId, controlId: recipe.controlId,
      action: request.action, status: "queued", phase: "queued", cancelRequested: false, createdAt: time, updatedAt: time,
      resolvedVersion: null, installationId: null, error: null, logCursor: 0 };
    this.storage.db.prepare("INSERT INTO management_jobs(id,harness_id,status,command_id,fingerprint,expected_revision,view_json) VALUES(?,?,?,?,?,?,?)").run(job.id, job.harnessId, job.status, request.commandId, fingerprint, revision, JSON.stringify(job));
    this.schedule(); return job;
  }
  cancel(id: string, commandId: string): InstallationJobView {
    this.admission(); this.payloadBudgets(); managementCommand(commandId); const job = this.readJob(id), fingerprint = createHash("sha256").update("cancel:" + id).digest("hex");
    const existing = this.storage.db.prepare("SELECT fingerprint FROM management_commands WHERE id=?").get(commandId);
    if (existing) { if (existing.fingerprint !== fingerprint) throw new ManagementError("COMMAND_CONFLICT", "management cancel command used different input"); return this.readJob(id); }
    if (this.storage.db.prepare("SELECT id FROM management_jobs WHERE command_id=?").get(commandId)) throw new ManagementError("COMMAND_CONFLICT", "management command identity already used");
    this.storage.db.exec("BEGIN IMMEDIATE");
    try { this.storage.db.prepare("INSERT INTO management_commands(id,fingerprint,job_id) VALUES(?,?,?)").run(commandId, fingerprint, id);
      if (!terminal(job.status)) this.saveJob({ ...job, cancelRequested: true, ...(job.status === "queued" ? { status: "cancelled" as const, phase: "cancelled" } : {}), updatedAt: this.now() });
      this.storage.db.exec("COMMIT"); } catch (error) { this.storage.db.exec("ROLLBACK"); throw error; }
    if (this.active?.id === id) this.active.controller.abort(); return this.readJob(id);
  }
  private log(id: string, stream: InstallationLog["stream"], text: string): void {
    let job = this.readJob(id); const cleaned = this.redactor(text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/gu, "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/gu, ""));
    const chunks: string[] = []; let part = "", bytes = 0;
    for (const char of cleaned) { const size = Buffer.byteLength(char, "utf8"); if (bytes + size > 4096) { chunks.push(part); part = ""; bytes = 0; } part += char; bytes += size; }
    if (part || chunks.length === 0) chunks.push(part);
    if (job.logCursor + chunks.length > 2048) throw new ManagementError("LOG_LIMIT", "installation log budget exhausted");
    this.storage.db.exec("BEGIN IMMEDIATE"); try {
      for (const text of chunks) { const entry: InstallationLog = { seq: job.logCursor + 1, time: this.now(), stream, text };
        this.storage.db.prepare("INSERT INTO management_logs(job_id,seq,entry_json) VALUES(?,?,?)").run(id, entry.seq, JSON.stringify(entry)); job = { ...job, logCursor: entry.seq, updatedAt: entry.time }; }
      this.saveJob(job); this.storage.db.exec("COMMIT");
    } catch (error) { this.storage.db.exec("ROLLBACK"); throw error; }
  }
  private phase(id: string, status: InstallationJobView["status"], patch: Partial<InstallationJobView> = {}): void {
    this.saveJob({ ...this.readJob(id), ...patch, status, phase: status, updatedAt: this.now() });
  }
  private schedule(): void {
    if (this.runner !== null || !this.accepting) return;
    this.runner = Promise.resolve().then(() => this.runQueue()).finally(() => { this.runner = null; });
    void this.runner.catch(() => { this.accepting = false; });
  }
  private async runQueue(): Promise<void> {
    while (this.accepting) {
      this.own(); const next = this.storage.db.prepare("SELECT id FROM management_jobs WHERE status='queued' ORDER BY rowid LIMIT 1").get()?.id;
      if (typeof next !== "string") return; await this.runJob(next);
    }
  }
  private async runJob(id: string): Promise<void> {
    const job = this.readJob(id), recipe = this.recipe(job.harnessId, job.controlId);
    if (!recipe) { this.phase(id, "failed", { error: { code: "RECIPE_CHANGED", message: "installation recipe is unavailable" } }); return; }
    const controller = new AbortController(), active = { id, controller, timedOut: false }; this.active = active;
    const timer = setTimeout(() => { active.timedOut = true; controller.abort(); }, this.timeout);
    let stage: string | null = null;
    try {
      this.phase(id, "resolving"); const spec = await this.metadata.resolve(recipe, controller.signal); this.own();
      if (controller.signal.aborted) throw new ManagementError("CANCELLED", "installation was cancelled");
      if (spec.recipe.harnessId !== recipe.harnessId || spec.recipe.controlId !== recipe.controlId || !spec.version || spec.version.length > 128 || /[\0\r\n]/u.test(spec.version))
        throw new ManagementError("INVALID_METADATA", "resolved installation identity is inconsistent");
      const installId = "installation-" + randomUUID(); stage = join(this.storage.root, "slots", installId); mkdirSync(stage, { mode: 0o700 });
      writeFileSync(join(stage, ".slot.json"), JSON.stringify({ installationId: installId, jobId: id, ownerGeneration: this.options.ownerGeneration }), { flag: "wx", mode: 0o600 });
      const slotIdentity = managementIdentity(stage, true), markerIdentity = managementIdentity(join(stage, ".slot.json"));
      const markerHash = createHash("sha256").update(boundedManagementFile(join(stage, ".slot.json"), 4096)).digest("hex");
      const owned = (): void => { this.own(); if (controller.signal.aborted) throw new ManagementError("CANCELLED", "installation was cancelled");
        if (!sameManagementIdentity(slotIdentity, managementIdentity(stage!, true)) || !sameManagementIdentity(markerIdentity, managementIdentity(join(stage!, ".slot.json"))) ||
            createHash("sha256").update(boundedManagementFile(join(stage!, ".slot.json"), 4096)).digest("hex") !== markerHash)
          throw new ManagementError("OWNERSHIP_LOST", "installation slot ownership changed"); };
      this.phase(id, "installing", { resolvedVersion: spec.version, installationId: installId });
      const artifact = await this.installer.install(spec, { stage, signal: controller.signal, assertOwned: owned, log: (stream, text) => this.log(id, stream, text) }); owned();
      this.phase(id, "verifying");
      if (artifact.observedVersion !== spec.version || !isAbsolute(artifact.command.executable) || artifact.command.args.length > 64)
        throw new ManagementError("INVALID_ARTIFACT", "installed version or command differs from its resolved target");
      const entry = await realpath(artifact.command.executable); owned(); await access(entry, constants.X_OK); owned();
      if (spec.recipe.kind === "npm") {
        if (!spec.recipe.packageName || artifact.command.args[0] === undefined) throw new ManagementError("INVALID_ARTIFACT", "npm entry is missing");
        const packageEntry = await realpath(installedNpmEntry(stage, spec.recipe.packageName, spec.version, recipe.binName)); owned();
        if (!insideManagement(stage, packageEntry) || artifact.command.args[0] !== packageEntry || !(await lstat(packageEntry)).isFile())
          throw new ManagementError("INVALID_ARTIFACT", "npm executable does not belong to its immutable slot");
        owned(); if (entry !== this.node && !insideManagement(stage, entry)) throw new ManagementError("INVALID_ARTIFACT", "npm runtime is not the admitted runtime");
      } else if (!insideManagement(stage, entry) || !(await lstat(entry)).isFile()) throw new ManagementError("INVALID_ARTIFACT", "installation executable escapes its immutable slot");
      owned();
      if (spec.recipe.kind === "npm" && (JSON.stringify(artifact.command.args.slice(1)) !== JSON.stringify(spec.recipe.args) || Object.keys(artifact.command.env).some(key => key !== "PATH")))
        throw new ManagementError("INVALID_ARTIFACT", "installed npm arguments/environment differ from their reviewed recipe");
      if (spec.recipe.kind === "python" && Object.keys(artifact.command.env).some(key => key !== "PATH")) throw new ManagementError("INVALID_ARTIFACT", "Python managed environment contains unsupported injection");
      if (spec.recipe.kind === "binary" && (JSON.stringify(artifact.command.args) !== JSON.stringify(spec.recipe.args) || JSON.stringify(artifact.command.env) !== JSON.stringify(spec.recipe.env ?? {})))
        throw new ManagementError("INVALID_ARTIFACT", "binary managed arguments/environment differ from resolved official metadata");
      const launch = JSON.stringify(artifact.command); if (Buffer.byteLength(launch, "utf8") > 65536) throw new ManagementError("ARTIFACT_LIMIT", "managed launch receipt exceeded its byte budget");
      const launchSha256 = createHash("sha256").update(launch).digest("hex");
      owned(); writeFileSync(join(stage, ".launch.json"), launch, { flag: "wx", mode: 0o600 }); owned();
      const record: InstallationRecord = { id: installId, harnessId: recipe.harnessId, controlId: recipe.controlId, version: spec.version, slot: stage,
        command: artifact.command, artifactSha256: artifact.artifactSha256, launchSha256 };
      parseInstallationRecord(record);
      if (Buffer.byteLength(JSON.stringify(record), "utf8") > 65536) throw new ManagementError("ARTIFACT_LIMIT", "installation receipt exceeded its byte budget");
      this.phase(id, "activating"); this.storage.db.exec("BEGIN IMMEDIATE");
      try {
        owned(); const expected = this.storage.db.prepare("SELECT expected_revision FROM management_jobs WHERE id=?").get(id)?.expected_revision;
        const current = this.defaultRevision(recipe.harnessId); if (expected !== current) throw new ManagementError("DEFAULT_CONFLICT", "managed default changed before installation activation");
        this.storage.db.prepare("INSERT INTO management_installations(id,harness_id,control_id,record_json) VALUES(?,?,?,?)").run(installId, recipe.harnessId, recipe.controlId, JSON.stringify(record));
        this.storage.db.prepare("INSERT INTO management_defaults(harness_id,installation_id,revision) VALUES(?,?,?) ON CONFLICT(harness_id) DO UPDATE SET installation_id=excluded.installation_id,revision=excluded.revision").run(recipe.harnessId, installId, current + 1);
        this.phase(id, "completed"); owned(); this.storage.db.exec("COMMIT");
      } catch (error) { this.storage.db.exec("ROLLBACK"); throw error; }
    } catch (error) {
      this.own(); const current = this.readJob(id);
      const failure = error instanceof ManagementError ? error : new ManagementError("INSTALL_FAILED", "installation could not be completed");
      const cancelled = current.cancelRequested || !this.accepting;
      this.phase(id, failure.code === "CLEANUP_FAILED" || failure.code === "OWNERSHIP_LOST" ? "unknown" : cancelled ? "cancelled" : "failed",
        { error: { code: active.timedOut ? "INSTALL_TIMEOUT" : this.redactor(failure.code), message: this.redactor(active.timedOut ? "installation exceeded its deadline" : failure.message) } });
    } finally { clearTimeout(timer); this.active = null; }
  }
  resolveControl(harnessId: string, controlId: string): ResolvedManagedControl | null {
    this.own(); this.payloadBudgets(); managementSlug(harnessId); managementSlug(controlId);
    const pointer = this.storage.db.prepare("SELECT installation_id,revision FROM management_defaults WHERE harness_id=?").get(harnessId);
    if (!pointer) return null;
    if (typeof pointer.installation_id !== "string" || typeof pointer.revision !== "number") throw new ManagementError("INVALID_DATA", "managed installation pointer is invalid");
    const row = this.storage.db.prepare("SELECT record_json FROM management_installations WHERE id=? AND length(CAST(record_json AS BLOB))<=65536").get(pointer.installation_id);
    if (!row) throw new ManagementError("INVALID_DATA", "managed installation default is dangling");
    const record = parseInstallationRecord(json(row.record_json));
    if (record.id !== pointer.installation_id || record.harnessId !== harnessId) throw new ManagementError("INVALID_DATA", "managed installation identity changed");
    if (record.controlId !== controlId) return null;
    this.verifyStoredRecord(record);
    return { installationId: record.id, revision: pointer.revision, version: record.version,
      command: { executable: record.command.executable, args: [...record.command.args], env: { ...record.command.env } } };
  }
  views(harnessIds: readonly string[]): readonly HarnessManagementView[] {
    this.own(); this.payloadBudgets(); if (harnessIds.length > 256) throw new ManagementError("INVALID_INPUT", "too many management views requested");
    return harnessIds.map(harness => {
      managementSlug(harness); const recipe = this.capability(harness), pointer = this.storage.db.prepare("SELECT installation_id,revision FROM management_defaults WHERE harness_id=?").get(harness);
      let installedVersion: string | null = null, installationId: string | null = null;
      if (pointer) {
        if (typeof pointer.installation_id !== "string") throw new ManagementError("INVALID_DATA", "managed installation pointer is invalid");
        const row = this.storage.db.prepare("SELECT record_json FROM management_installations WHERE id=? AND length(CAST(record_json AS BLOB))<=65536").get(pointer.installation_id);
        if (!row) throw new ManagementError("INVALID_DATA", "managed installation default is dangling");
        const record = parseInstallationRecord(json(row.record_json)); this.verifyStoredRecord(record); installedVersion = record.version; installationId = record.id;
      }
      const update = this.storage.db.prepare("SELECT view_json FROM management_updates WHERE harness_id=? AND length(CAST(view_json AS BLOB))<=65536").get(harness);
      const checked = update ? parseManagementUpdate(json(update.view_json)) : null;
      const active = this.storage.db.prepare("SELECT id FROM management_jobs WHERE harness_id=? AND status NOT IN('completed','cancelled','failed','unknown')").get(harness)?.id;
      const currentVersion = installationId === null ? this.systemVersion(harness) : installedVersion;
      let updateStatus = checked?.updateStatus ?? (recipe?.canInstall ? "unchecked" : "unsupported");
      if (checked?.latestVersion != null && checked.error === null && ["unchecked", "available", "current"].includes(updateStatus)) {
        const newer = currentVersion !== null && (valid(checked.latestVersion) && valid(currentVersion)
          ? gt(checked.latestVersion, currentVersion) : checked.latestVersion !== currentVersion);
        updateStatus = currentVersion === null ? "unchecked" : newer ? "available" : "current";
      }
      return { harnessId: harness, recipe, source: installationId === null ? this.system.has(harness) ? "system" : "missing" : "managed",
        installedVersion: currentVersion, installationId,
        latestVersion: checked?.latestVersion ?? null, updateStatus,
        checkedAt: checked?.checkedAt ?? null, activeJobId: typeof active === "string" ? active : null, defaultRevision: this.defaultRevision(harness), error: checked?.error ?? null };
    });
  }
  checkUpdates(harnessIds: readonly string[] = [...new Set(this.recipes.map(item => item.harnessId))]): Promise<readonly HarnessManagementView[]> {
    this.admission(); if (this.checks.size >= 4) return Promise.reject(new ManagementError("CHECK_LIMIT", "too many update checks are already active"));
    const operation = this.checkOwned(harnessIds); this.checks.add(operation); void operation.then(() => this.checks.delete(operation), () => this.checks.delete(operation)); return operation;
  }
  private async checkOwned(ids: readonly string[]): Promise<readonly HarnessManagementView[]> {
    if (ids.length > 256) throw new ManagementError("INVALID_INPUT", "too many update targets");
    for (const id of ids) managementSlug(id);
    let index = 0;
    await Promise.all(Array.from({ length: Math.min(4, ids.length) }, async () => {
      for (;;) {
        if (!this.accepting) return;
        const id = ids[index++]; if (id === undefined) return; this.own(); const recipe = this.recipe(id), capability = this.capability(id);
        if (!recipe || !capability?.canInstall) continue;
        const controller = new AbortController(); this.checkControllers.add(controller); const timer = setTimeout(() => controller.abort(), 15000);
        this.storeUpdate(id, { latestVersion: null, updateStatus: "checking", checkedAt: null, error: null });
        try {
          if (this.defaultRevision(id) === 0) {
            const observation = this.system.get(id);
            if (observation) {
              const observed = await (this.options.systemVersionProbe ?? probeSystemVersion)(observation, { signal: controller.signal, assertOwned: () => this.own(), redact: this.redactor }); this.own();
              this.systemVersions.set(id, { fingerprint: this.systemFingerprint(observation), version: observed.version });
            }
          }
          const spec = await this.metadata.resolve(recipe, controller.signal); this.own();
          const installed = this.views([id])[0]!.installedVersion;
          const available = installed !== null && (valid(spec.version) && valid(installed) ? gt(spec.version, installed) : spec.version !== installed);
          this.storeUpdate(id, { latestVersion: spec.version, updateStatus: available ? "available" : installed === null ? "unchecked" : "current", checkedAt: this.now(), error: null });
        } catch (error) { this.own(); this.storeUpdate(id, { latestVersion: null, updateStatus: "failed", checkedAt: this.now(), error: { code: error instanceof ManagementError ? error.code : "CHECK_FAILED", message: "latest version could not be checked" } }); }
        finally { clearTimeout(timer); this.checkControllers.delete(controller); }
      }
    })); return this.views(ids);
  }
  private storeUpdate(id: string, value: Pick<HarnessManagementView, "latestVersion" | "updateStatus" | "checkedAt" | "error">): void {
    this.own(); this.storage.db.prepare("INSERT INTO management_updates(harness_id,view_json) VALUES(?,?) ON CONFLICT(harness_id) DO UPDATE SET view_json=excluded.view_json").run(id, JSON.stringify(value));
  }
  shutdown(): Promise<void> {
    this.stopping ??= this.shutdownOwned(); return this.stopping;
  }
  close(): void {
    if (this.closed) return;
    if (this.runner !== null || this.active !== null || this.checks.size !== 0) throw new ManagementError("MANAGEMENT_ACTIVE", "active management work requires awaitable shutdown");
    this.accepting = false; this.closed = true; this.storage.db.close(); openRoots.delete(this.storage.root);
  }
  private async shutdownOwned(): Promise<void> {
    if (this.closed) return; this.accepting = false;
    const pending = [ ...(this.runner === null ? [] : [this.runner]), ...this.checks ];
    this.active?.controller.abort();
    for (const check of this.checkControllers) check.abort();
    let failure: unknown = null;
    try {
      this.own();
      for (const row of this.storage.db.prepare("SELECT id FROM management_jobs WHERE status='queued'").all()) {
        if (typeof row.id !== "string") throw new ManagementError("INVALID_DATA", "queued installation identity is invalid");
        this.phase(row.id, "cancelled", { cancelRequested: true });
      }
      if (this.active !== null) { const job = this.readJob(this.active.id); this.saveJob({ ...job, cancelRequested: true }); }
    } catch (error) { failure = error; }
    const settled = await Promise.allSettled(pending);
    for (const result of settled) if (result.status === "rejected") failure ??= result.reason;
    this.closed = true;
    try { this.storage.db.close(); } catch { failure ??= new ManagementError("CLEANUP_FAILED", "management database close could not be confirmed"); }
    finally { openRoots.delete(this.storage.root); }
    if (failure !== null) throw failure;
  }
}
