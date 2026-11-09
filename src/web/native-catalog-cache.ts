import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readSync, rmSync } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import type { ContextEffect, NativeCommand, NativeInputs, NativeModelCatalog, NativeOption } from "../contracts/control.js";
import { CONTEXT_EFFECTS } from "../contracts/relay.js";

const FILE = "native-catalogs.json";
const APPLICATION = "harness-native-catalogs";
/** v2 records the Hub build its catalogs were read by; v1 files keep their readiness and probe sessions, not their catalogs. */
const VERSION = 2;
const TEMPORARY = /^\.native-catalogs\.json\.[0-9]+\.[0-9a-f]{12}\.tmp$/u;
/** How long one catalog read is reused while its installation and configuration fingerprint holds. */
export const NATIVE_CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_CATALOGS = 32;
const MAX_READINESS = 128;
const MAX_PROBE_SESSIONS = 512;

/** What the last catalog read of one Harness entry showed: it answered, it needs its own sign-in or setup, or the read failed. */
export type NativeReadinessState = "ready" | "signed_out" | "failed";
export interface NativeReadiness {
  readonly harnessId: string;
  readonly controlId: string;
  readonly state: NativeReadinessState;
  /** Milliseconds since the epoch. */
  readonly checkedAt: number;
  /** Whether the native side said it is signed in; null when its interface does not say. Only for `ready`. */
  readonly signedIn?: boolean | null;
  /** The stable failure class of a failed read; never the native side's own words. */
  readonly failureCode?: string;
}
/**
 * The identity of the Hub build that reads catalogs: a digest of every compiled file under `directory`. Drivers decide what
 * a catalog contains, so a catalog read by another build is read again instead of being reused.
 */
export function buildRevision(directory: string): string {
  const hash = createHash("sha256"), files: string[] = [];
  const walk = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) walk(child); else if (entry.isFile()) files.push(child);
      if (files.length > 4096) throw new Error("the Hub build has more files than its revision covers");
    }
  };
  walk(directory);
  for (const file of files) hash.update(relative(directory, file)).update("\0").update(readFileSync(file)).update("\0");
  return hash.digest("hex");
}
interface CatalogEntry { readonly key: string; readonly fingerprint: string; readonly harnessId: string; readonly controlId: string; readonly observedAt: number; readonly catalog: NativeModelCatalog }
interface ProbeSession { readonly harnessId: string; readonly controlId: string; readonly id: string; readonly createdAt: number }

/**
 * Native catalog observations that outlive one Gateway process, kept in one private file of the data root: each catalog
 * read (reused for up to 24 hours while its fingerprint holds), the readiness each Harness entry last showed, and the native
 * sessions that catalog reads had to open. None of it is a credential, and all of it is derived: a file that cannot be
 * adopted (not a private regular file, damaged, or another version) is left untouched, reported through `report` once, and
 * this process keeps its observations in memory only. A failed write is reported the same way and never fails a read.
 * Writes are serialized and replace the file atomically; close() awaits the last one. Only the data root's owner writes.
 */
export class NativeCatalogCache {
  private catalogs: CatalogEntry[] = [];
  private readonly readiness = new Map<string, NativeReadiness>();
  private probes: ProbeSession[] = [];
  private persistent = true;
  private queued = false;
  private closed = false;
  private chain: Promise<void> = Promise.resolve();
  private readonly path: string;

  private readonly assertOwner: () => void;
  private readonly report: (problem: string) => void;
  private readonly revision: string;
  private readonly now: () => number;

  /** `revision` is the reading Hub build (buildRevision); catalogs another build read are not reused. */
  constructor(private readonly root: string, options: { readonly assertOwner: () => void; readonly report: (problem: string) => void; readonly revision: string; readonly now?: () => number }) {
    if (!/^[0-9a-f]{64}$/u.test(options.revision)) throw new Error("catalog revision must be a SHA-256 digest");
    this.assertOwner = options.assertOwner; this.report = options.report; this.revision = options.revision; this.now = options.now ?? Date.now;
    this.path = join(root, FILE);
    try { this.load(); }
    catch (error) { this.reject("the data root could not be read (" + (error !== null && typeof error === "object" && "code" in error ? String(error.code) : "unknown") + ")"); }
  }
  /** The catalog last read under `key`, when it is younger than a day and was read under the same fingerprint. */
  catalog(key: string, fingerprint: string): NativeModelCatalog | null {
    const entry = this.catalogs.find(item => item.key === key);
    if (entry === undefined) return null;
    const age = this.now() - entry.observedAt;
    return entry.fingerprint === fingerprint && age >= 0 && age < NATIVE_CATALOG_TTL_MS ? entry.catalog : null;
  }
  /** Records a successful catalog read; the oldest entries leave first. A catalog outside the stored bounds is not kept. */
  putCatalog(entry: Omit<CatalogEntry, "observedAt">): void {
    if (this.closed) return;
    let catalog: NativeModelCatalog;
    // Only the contract's fields are kept, and the kept value is the one the next process will read back.
    try { catalog = parseCatalog(project(entry.catalog)); } catch { return; }
    this.catalogs = [...this.catalogs.filter(item => item.key !== entry.key), { ...entry, catalog, observedAt: this.now() }].slice(-MAX_CATALOGS);
    this.persist();
  }
  /** Forgets a catalog that its owner found to be stale. */
  dropCatalog(key: string): void {
    if (this.closed || !this.catalogs.some(item => item.key === key)) return;
    this.catalogs = this.catalogs.filter(item => item.key !== key); this.persist();
  }
  /** Records what one entry's latest catalog read showed. */
  observe(value: Omit<NativeReadiness, "checkedAt">): void {
    if (this.closed) return;
    const id = value.harnessId + "\0" + value.controlId;
    this.readiness.delete(id); this.readiness.set(id, { ...value, checkedAt: this.now() });
    while (this.readiness.size > MAX_READINESS) this.readiness.delete(this.readiness.keys().next().value!);
    this.persist();
  }
  /** Every entry's latest readiness, most recent first. */
  readinessList(): readonly NativeReadiness[] { return [...this.readiness.values()].sort((a, b) => b.checkedAt - a.checkedAt); }
  /** A native session that a catalog read opened; such sessions are not offered for continuing by default. */
  recordProbeSession(harnessId: string, controlId: string, id: string): void {
    if (this.closed || !id || id.length > 1024 || /[\0\r\n]/u.test(id)) return;
    this.probes = [...this.probes.filter(item => !(item.harnessId === harnessId && item.controlId === controlId && item.id === id)), { harnessId, controlId, id, createdAt: this.now() }].slice(-MAX_PROBE_SESSIONS);
    this.persist();
  }
  probeSessions(harnessId: string, controlId: string): ReadonlySet<string> {
    return new Set(this.probes.filter(item => item.harnessId === harnessId && item.controlId === controlId).map(item => item.id));
  }
  /** Awaits the last write; later observations are not kept. */
  async close(): Promise<void> { this.closed = true; await this.chain; }

  private persist(): void {
    if (!this.persistent || this.queued) return;
    this.queued = true;
    this.chain = this.chain.then(async () => { this.queued = false; if (this.persistent) await this.write(); }).catch((error: unknown) => {
      this.persistent = false;
      this.report("write failed (" + (error !== null && typeof error === "object" && "code" in error ? String(error.code) : "unknown") + "); catalog observations stay in memory");
    });
  }
  private async write(): Promise<void> {
    let catalogs = this.catalogs, body = this.document(catalogs);
    while (Buffer.byteLength(body) > MAX_FILE_BYTES && catalogs.length) { catalogs = catalogs.slice(1); body = this.document(catalogs); }
    const temporary = join(this.root, "." + FILE + "." + process.pid + "." + randomBytes(6).toString("hex") + ".tmp");
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(body); await handle.sync(); } finally { await handle.close(); }
    try { this.assertOwner(); await rename(temporary, this.path); }
    catch (error) { await rm(temporary, { force: true }); throw error; }
  }
  private document(catalogs: readonly CatalogEntry[]): string {
    return JSON.stringify({ application: APPLICATION, version: VERSION, revision: this.revision, catalogs, readiness: [...this.readiness.values()], probeSessions: this.probes }) + "\n";
  }
  private load(): void {
    // A write interrupted before its rename leaves only its own temporary file behind.
    for (const name of readdirSync(this.root)) if (TEMPORARY.test(name)) {
      const info = lstatSync(join(this.root, name));
      if (info.isFile() && info.nlink === 1) rmSync(join(this.root, name), { force: true });
    }
    let descriptor: number;
    try { descriptor = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) {
      if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
      return this.reject("it cannot be opened as a regular file");
    }
    let text: string;
    try {
      const info = fstatSync(descriptor);
      if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0) return this.reject("it is not a private regular file");
      if (info.size > MAX_FILE_BYTES) return this.reject("it exceeds its size budget");
      const buffer = Buffer.alloc(info.size + 1); let length = 0;
      while (length < buffer.length) { const received = readSync(descriptor, buffer, length, buffer.length - length, length); if (received === 0) break; length += received; }
      if (length > info.size) return this.reject("it grew while it was read");
      text = buffer.subarray(0, length).toString("utf8");
    } finally { closeSync(descriptor); }
    try {
      const document = record(JSON.parse(text), ["application", "version", "revision", "catalogs", "readiness", "probeSessions"]);
      if (document.application !== APPLICATION) throw new Error("application");
      if (document.version !== 1 && document.version !== VERSION) return this.reject("its version " + JSON.stringify(document.version).slice(0, 16) + " is not 1 or " + VERSION);
      if (document.version === 1 ? document.revision !== undefined : typeof document.revision !== "string") throw new Error("revision");
      // Catalogs read by another build (or by v1, which did not record it) are validated but not reused.
      const current = document.version === VERSION && digest(document.revision) === this.revision;
      const now = this.now();
      this.catalogs = bounded(document.catalogs, MAX_CATALOGS).map(value => {
        const row = record(value, ["key", "fingerprint", "harnessId", "controlId", "observedAt", "catalog"]);
        return { key: digest(row.key), fingerprint: digest(row.fingerprint), harnessId: identity(row.harnessId), controlId: identity(row.controlId), observedAt: time(row.observedAt), catalog: parseCatalog(row.catalog) };
      }).filter(entry => current && now - entry.observedAt >= 0 && now - entry.observedAt < NATIVE_CATALOG_TTL_MS);
      if (new Set(this.catalogs.map(entry => entry.key)).size !== this.catalogs.length) throw new Error("duplicate catalogs");
      for (const value of bounded(document.readiness, MAX_READINESS)) {
        const row = record(value, ["harnessId", "controlId", "state", "checkedAt", "signedIn", "failureCode"]);
        const state = row.state === "ready" || row.state === "signed_out" || row.state === "failed" ? row.state : fail("readiness state");
        const entry: NativeReadiness = { harnessId: identity(row.harnessId), controlId: identity(row.controlId), state, checkedAt: time(row.checkedAt),
          ...(row.signedIn === undefined ? {} : { signedIn: row.signedIn === null || typeof row.signedIn === "boolean" ? row.signedIn : fail("signed-in flag") }),
          ...(row.failureCode === undefined ? {} : { failureCode: code(row.failureCode) }) };
        this.readiness.set(entry.harnessId + "\0" + entry.controlId, entry);
      }
      this.probes = bounded(document.probeSessions, MAX_PROBE_SESSIONS).map(value => {
        const row = record(value, ["harnessId", "controlId", "id", "createdAt"]);
        return { harnessId: identity(row.harnessId), controlId: identity(row.controlId), id: line(row.id, 1024), createdAt: time(row.createdAt) };
      });
    } catch {
      this.catalogs = []; this.readiness.clear(); this.probes = [];
      this.reject("its contents are not a catalog cache this version can read");
    }
  }
  private reject(reason: string): void {
    this.persistent = false;
    this.report(FILE + " was left untouched because " + reason + "; catalog observations stay in memory");
  }
}

function fail(label: string): never { throw new Error("invalid " + label); }
function record(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) return fail("record");
  return value as Record<string, unknown>;
}
function bounded(value: unknown, maximum: number): readonly unknown[] { return Array.isArray(value) && value.length <= maximum ? value : fail("list"); }
function line(value: unknown, maximum: number): string { return typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\0\r\n]/u.test(value) ? value : fail("text"); }
function prose(value: unknown, maximum: number): string { return typeof value === "string" && value.length <= maximum && !value.includes("\0") ? value : fail("description"); }
function identity(value: unknown): string { return typeof value === "string" && /^[a-z][a-z0-9-]{0,95}$/u.test(value) ? value : fail("identity"); }
function digest(value: unknown): string { return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value) ? value : fail("digest"); }
function code(value: unknown): string { return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(value) ? value : fail("code"); }
function time(value: unknown): number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fail("time"); }
function flag(value: unknown): boolean { return typeof value === "boolean" ? value : fail("flag"); }
function inputs(value: unknown): NativeInputs { const row = record(value, ["image", "audio", "file"]); return { image: flag(row.image), audio: flag(row.audio), file: flag(row.file) }; }
/** A command's declared effect, one of the contract's (ADR-055 R0d); a cached command keeps what its Driver declared. */
function effect(value: unknown): ContextEffect { return typeof value === "string" && (CONTEXT_EFFECTS as readonly string[]).includes(value) ? value as ContextEffect : fail("context effect"); }
function command(value: unknown): NativeCommand {
  const row = record(value, ["name", "description", "contextEffect"]);
  return { name: line(row.name, 1024), description: prose(row.description, 8192), ...(row.contextEffect === undefined ? {} : { contextEffect: effect(row.contextEffect) }) };
}
function option(value: unknown): NativeOption {
  const row = record(value, ["id", "name", "category", "currentValue", "values"]);
  const values = bounded(row.values, 4096).map(value => { const item = record(value, ["value", "name"]); return { value: line(item.value, 1024), name: line(item.name, 1024) }; });
  if (!values.length || new Set(values.map(item => item.value)).size !== values.length) return fail("option values");
  return { id: line(row.id, 128), name: line(row.name, 1024), category: line(row.category, 128), currentValue: line(row.currentValue, 1024), values };
}
/**
 * The contract's fields of a catalog as plain data; optional fields that are absent stay absent. A command keeps its
 * declared contextEffect, so that a reading of the cached catalog (the relay's, at admission) and of the catalog models()
 * returns (the Runtime's) are the same reading (ADR-055 G069). An older build that does not know the field leaves a file
 * with it untouched and keeps its observations in memory, as for any file it cannot read.
 */
function project(catalog: NativeModelCatalog): unknown {
  const options = (values: readonly NativeOption[] | undefined) => values?.map(item => ({ id: item.id, name: item.name, category: item.category, currentValue: item.currentValue, values: item.values.map(value => ({ value: value.value, name: value.name })) }));
  const accepted = (value: NativeInputs | undefined) => value === undefined ? undefined : { image: value.image, audio: value.audio, file: value.file };
  return JSON.parse(JSON.stringify({ models: catalog.models.map(model => ({ id: model.id, name: model.name, options: options(model.options), inputs: accepted(model.inputs) })),
    inputs: accepted(catalog.inputs), defaultModel: catalog.defaultModel, selectionError: catalog.selectionError === undefined ? undefined : { code: catalog.selectionError.code, message: catalog.selectionError.message },
    authentication: catalog.authentication, canSelect: catalog.canSelect, options: options(catalog.options), commands: catalog.commands?.map(command => ({ name: command.name, description: command.description, contextEffect: command.contextEffect })) })) as unknown;
}
/** A cached catalog, validated like any other input before it is served again. */
function parseCatalog(value: unknown): NativeModelCatalog {
  const row = record(value, ["models", "inputs", "defaultModel", "selectionError", "authentication", "canSelect", "options", "commands"]);
  const models = bounded(row.models, 4096).map(value => {
    const model = record(value, ["id", "name", "options", "inputs"]);
    return { id: line(model.id, 1024), name: line(model.name, 1024), ...(model.options === undefined ? {} : { options: bounded(model.options, 128).map(option) }), ...(model.inputs === undefined ? {} : { inputs: inputs(model.inputs) }) };
  });
  if (new Set(models.map(model => model.id)).size !== models.length) return fail("models");
  const authentication = row.authentication === "ready" || row.authentication === "missing" || row.authentication === "unknown" ? row.authentication : fail("authentication");
  return { models, defaultModel: row.defaultModel === null ? null : line(row.defaultModel, 1024), authentication, canSelect: flag(row.canSelect),
    ...(row.inputs === undefined ? {} : { inputs: inputs(row.inputs) }),
    ...(row.selectionError === undefined ? {} : { selectionError: (error => ({ code: code(error.code), message: prose(error.message, 1024) }))(record(row.selectionError, ["code", "message"])) }),
    ...(row.options === undefined ? {} : { options: bounded(row.options, 128).map(option) }),
    ...(row.commands === undefined ? {} : { commands: bounded(row.commands, 2048).map(command) }) };
}
