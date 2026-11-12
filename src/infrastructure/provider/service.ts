import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ProviderError, parseProviderTarget, providerId, type ProviderTarget, type ProviderTextRedactor, type ProviderView } from "../../contracts/provider.js";
import { assertProviderCompatibility, parseProviderCommand, parseProviderView, parseProviderWrite } from "../../contexts/provider/domain/provider.js";
import { materializeProvider } from "../../adapters/provider/materialize.js";
import { fileIdentity, readPrivateFile, sameIdentity, ProviderVault, type FileIdentity } from "./vault.js";

// How many Providers, revisions and commands the store holds, and how many bytes of metadata, has no bound (2026-11-12): only each record's own size is checked.
const MAX_VIEW_BYTES = 65536;
const MAX_PROBE_BYTES = 1024 * 1024;
const PROBE_TIMEOUT_MS = 5000;
const MAX_ACTIVE_PROBES = 16;
type ProbeResult = { status: "models_reachable"; models: string[] };
function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new ProviderError("INVALID_DATA", "invalid Provider storage count");
  return value;
}
function storedView(value: unknown): ProviderView {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 65536) throw new ProviderError("INVALID_DATA", "invalid Provider storage record");
  try { return parseProviderView(JSON.parse(value)); }
  catch { throw new ProviderError("INVALID_DATA", "invalid Provider storage record"); }
}
function rootStorage(root: string): { root: string; identity: FileIdentity; marker: FileIdentity; database: string; databaseIdentity: FileIdentity } {
  if (!isAbsolute(root) || root.length > 4096 || /[\0\r\n]/u.test(root)) throw new ProviderError("INVALID_INPUT", "Provider data root must be a bounded absolute path");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (lstatSync(root).isSymbolicLink()) throw new ProviderError("INVALID_STORAGE", "Provider data root must not be a link");
  const directory = join(realpathSync(root), "providers"); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const identity = fileIdentity(directory, true), markerPath = join(directory, ".harness-gateway-provider.json");
  if (!existsSync(markerPath)) {
    if (readdirSync(directory).length !== 0) throw new ProviderError("INVALID_STORAGE", "Provider storage has no ownership marker");
    const descriptor = openSync(markerPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(descriptor, '{"application":"harness-gateway-provider","schemaVersion":1}\n'); fsyncSync(descriptor); }
    finally { closeSync(descriptor); }
  }
  const marker = fileIdentity(markerPath);
  if (lstatSync(markerPath).size > 4096) throw new ProviderError("INVALID_STORAGE", "Provider ownership marker exceeds its size limit");
  const content = new TextDecoder("utf-8", { fatal: true }).decode(readPrivateFile(markerPath, 4096, marker));
  if (content.length > 4096 || content.trim() !== '{"application":"harness-gateway-provider","schemaVersion":1}')
    throw new ProviderError("INVALID_STORAGE", "invalid Provider ownership marker");
  const database = join(directory, "providers.sqlite");
  if (existsSync(database) && !existsSync(join(directory, "master.key"))) throw new ProviderError("INVALID_VAULT", "existing Provider storage has no master key");
  const descriptor = openSync(database, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0) throw new ProviderError("INVALID_STORAGE", "invalid Provider database file");
  } finally { closeSync(descriptor); }
  return { root: directory, identity, marker, database, databaseIdentity: fileIdentity(database) };
}
export class LocalProviderService {
  private readonly storage: ReturnType<typeof rootStorage>;
  private readonly db: DatabaseSync;
  private readonly vault: ProviderVault;
  private readonly knownKeys = new Set<string>();
  private readonly probes = new Set<AbortController>();
  private readonly pendingProbes = new Set<Promise<ProbeResult>>();
  private shutdownPromise: Promise<void> | null = null;
  private closing = false;
  private closed = false;
  constructor(root: string, private readonly owner: () => void) {
    owner(); let opened: DatabaseSync | null = null, openedVault: ProviderVault | null = null;
    try {
      this.storage = rootStorage(root); this.db = opened = new DatabaseSync(this.storage.database);
      this.db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000");
      const version = this.db.prepare("PRAGMA user_version").get()?.user_version;
      if (version !== 0 && version !== 1) throw new ProviderError("INVALID_STORAGE", "unsupported Provider storage schema");
      this.db.exec("CREATE TABLE IF NOT EXISTS providers (id TEXT PRIMARY KEY, current_revision INTEGER NOT NULL) STRICT; CREATE TABLE IF NOT EXISTS provider_revisions (provider_id TEXT NOT NULL, revision INTEGER NOT NULL, view_json TEXT NOT NULL, PRIMARY KEY(provider_id, revision)) STRICT; CREATE TABLE IF NOT EXISTS provider_commands (command_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, provider_id TEXT NOT NULL, revision INTEGER NOT NULL) STRICT; PRAGMA user_version=1");
      this.vault = openedVault = new ProviderVault(this.storage.root, this.db);
      this.validateStoredMetadata();
      for (const secret of this.vault.all()) this.knownKeys.add(secret);
    } catch (error) {
      openedVault?.close();
      if (opened !== null) try { opened.close(); } catch { throw new ProviderError("CLEANUP_FAILED", "failed Provider initialization could not close storage"); }
      throw error instanceof ProviderError ? error : new ProviderError("INVALID_STORAGE", "Provider storage could not be initialized");
    }
  }
  private validateStoredMetadata(): void {
    this.metadataBudgets();
    const parents = this.db.prepare("SELECT id,current_revision FROM providers").all();
    const revisions = this.db.prepare("SELECT provider_id,revision,view_json FROM provider_revisions").all();
    const credentials = this.db.prepare("SELECT provider_id,revision FROM provider_credentials").all();
    const commands = this.db.prepare("SELECT command_id,fingerprint,provider_id,revision FROM provider_commands").all();
    const parentMap = new Map<string, number>();
    for (const row of parents) {
      const id = providerId(row.id);
      if (typeof row.current_revision !== "number" || !Number.isSafeInteger(row.current_revision) || row.current_revision < 1)
        throw new ProviderError("INVALID_DATA", "invalid current Provider revision");
      parentMap.set(id, row.current_revision);
    }
    const credentialSet = new Set<string>();
    for (const row of credentials) {
      if (typeof row.provider_id !== "string" || typeof row.revision !== "number") throw new ProviderError("INVALID_VAULT", "invalid credential reference");
      credentialSet.add(row.provider_id + ":" + row.revision);
    }
    const seen = new Map<string, Set<number>>(), revisionSet = new Set<string>();
    for (const row of revisions) {
      const view = storedView(row.view_json);
      if (row.provider_id !== view.id || row.revision !== view.revision || !parentMap.has(view.id)) throw new ProviderError("INVALID_DATA", "orphan or inconsistent Provider revision");
      const reference = view.id + ":" + view.revision; revisionSet.add(reference);
      if (view.hasCredential !== credentialSet.has(reference)) throw new ProviderError("INVALID_VAULT", "Provider credential reference is inconsistent");
      const group = seen.get(view.id) ?? new Set<number>(); group.add(view.revision); seen.set(view.id, group);
    }
    for (const reference of credentialSet) if (!revisionSet.has(reference)) throw new ProviderError("INVALID_VAULT", "orphan Provider credential");
    for (const [id, current] of parentMap) {
      const group = seen.get(id);
      if (!group || group.size !== current || !group.has(current) || [...group].some(revision => revision > current))
        throw new ProviderError("INVALID_DATA", "Provider revision chain or current pointer is inconsistent");
    }
    for (const row of commands) {
      parseProviderCommand(row.command_id);
      if (typeof row.fingerprint !== "string" || !/^[0-9a-f]{64}$/u.test(row.fingerprint) ||
          typeof row.provider_id !== "string" || typeof row.revision !== "number" || !revisionSet.has(row.provider_id + ":" + row.revision))
        throw new ProviderError("INVALID_DATA", "Provider command reference is inconsistent");
    }
  }
  private metadataBudgets(): void {
    if (this.db.prepare("SELECT 1 FROM providers WHERE length(CAST(id AS BLOB))>45 OR current_revision NOT BETWEEN 1 AND 9007199254740991 LIMIT 1").get() ||
        this.db.prepare("SELECT 1 FROM provider_revisions WHERE length(CAST(provider_id AS BLOB))>45 OR revision NOT BETWEEN 1 AND 9007199254740991 OR length(CAST(view_json AS BLOB))>65536 LIMIT 1").get() ||
        this.db.prepare("SELECT 1 FROM provider_credentials WHERE length(CAST(provider_id AS BLOB))>45 OR revision NOT BETWEEN 1 AND 9007199254740991 LIMIT 1").get() ||
        this.db.prepare("SELECT 1 FROM provider_commands WHERE length(CAST(command_id AS BLOB))>128 OR length(CAST(fingerprint AS BLOB))>64 OR length(CAST(provider_id AS BLOB))>45 OR revision NOT BETWEEN 1 AND 9007199254740991 LIMIT 1").get())
      throw new ProviderError("INVALID_DATA", "Provider metadata field exceeded its byte or revision budget");
  }
  private assertOwned(): void {
    if (this.closed || this.closing) throw new ProviderError("SERVICE_CLOSED", "Provider service is closing or closed");
    this.owner();
    if (!sameIdentity(this.storage.identity, fileIdentity(this.storage.root, true)) ||
        !sameIdentity(this.storage.marker, fileIdentity(join(this.storage.root, ".harness-gateway-provider.json"))) ||
        !sameIdentity(this.storage.databaseIdentity, fileIdentity(this.storage.database)))
      throw new ProviderError("OWNERSHIP_LOST", "Provider storage ownership changed");
    this.vault.assertOwned();
  }
  private revision(id: string, revision?: number): ProviderView {
    this.metadataBudgets();
    const identity = providerId(id);
    const parent = this.db.prepare("SELECT current_revision,(SELECT max(revision) FROM provider_revisions WHERE provider_id=providers.id) AS latest FROM providers WHERE id=?").get(identity);
    if (!parent) throw new ProviderError("PROVIDER_NOT_FOUND", "Provider was not found");
    if (typeof parent.current_revision !== "number" || parent.current_revision < 1 || parent.current_revision !== parent.latest)
      throw new ProviderError("INVALID_DATA", "current Provider revision pointer is inconsistent");
    const selectedRevision = revision ?? parent.current_revision;
    const budget = this.db.prepare("SELECT length(CAST(view_json AS BLOB)) AS bytes FROM provider_revisions WHERE provider_id=? AND revision=?").get(identity, selectedRevision);
    if (budget && (typeof budget.bytes !== "number" || budget.bytes > MAX_VIEW_BYTES)) throw new ProviderError("INVALID_DATA", "Provider revision exceeded its byte budget");
    const row = this.db.prepare("SELECT view_json FROM provider_revisions WHERE provider_id=? AND revision=? AND length(CAST(view_json AS BLOB))<=65536").get(identity, selectedRevision);
    if (!row) throw new ProviderError(revision === undefined ? "INVALID_DATA" : "PROVIDER_NOT_FOUND", "Provider revision was not found");
    const view = storedView(row.view_json);
    if (view.id !== identity || (revision !== undefined && view.revision !== revision)) throw new ProviderError("INVALID_DATA", "Provider storage identity changed");
    return view;
  }
  list(): readonly ProviderView[] {
    this.assertOwned();
    const total = count(this.db.prepare("SELECT count(*) AS total FROM providers").get()?.total);
    this.metadataBudgets();
    const rows = this.db.prepare("SELECT p.id,p.current_revision,r.view_json,(SELECT max(revision) FROM provider_revisions WHERE provider_id=p.id) AS latest, EXISTS(SELECT 1 FROM provider_credentials c WHERE c.provider_id=p.id AND c.revision=p.current_revision) AS credential_present FROM providers p JOIN provider_revisions r ON r.provider_id=p.id AND r.revision=p.current_revision WHERE length(CAST(p.id AS BLOB))<=45 AND length(CAST(r.view_json AS BLOB))<=65536 ORDER BY p.id").all();
    if (rows.length !== total) throw new ProviderError("INVALID_DATA", "Provider current revision is missing");
    return rows.map(row => {
      const view = storedView(row.view_json);
      if (row.id !== view.id || row.current_revision !== view.revision || row.current_revision !== row.latest)
        throw new ProviderError("INVALID_DATA", "Provider current revision pointer is inconsistent");
      if (view.hasCredential !== (row.credential_present === 1)) throw new ProviderError("INVALID_VAULT", "Provider credential reference is inconsistent");
      return view;
    });
  }
  create(input: unknown, command: string): ProviderView { return this.write(null, input, null, command); }
  update(id: string, input: unknown, expectedRevision: number, command: string): ProviderView {
    providerId(id);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new ProviderError("INVALID_INPUT", "expected Provider revision must be positive");
    return this.write(id, input, expectedRevision, command);
  }
  private write(id: string | null, input: unknown, expected: number | null, command: string): ProviderView {
    this.assertOwned(); const parsed = parseProviderWrite(input), key = parseProviderCommand(command);
    this.metadataBudgets();
    const fingerprint = this.vault.fingerprint(JSON.stringify({ kind: id === null ? "create" : "update", id, expected, input: parsed }));
    try { this.db.exec("BEGIN IMMEDIATE"); }
    catch { throw new ProviderError("STORAGE_FAILED", "Provider transaction could not start"); }
    let secret: string | null = null;
    try {
      const prior = this.db.prepare("SELECT fingerprint,provider_id,revision FROM provider_commands WHERE command_id=?").get(key);
      if (prior) {
        if (prior.fingerprint !== fingerprint || typeof prior.provider_id !== "string" || typeof prior.revision !== "number")
          throw new ProviderError("COMMAND_CONFLICT", "Provider command identity was already used with different input");
        const replay = this.revision(prior.provider_id, prior.revision); this.db.exec("COMMIT"); return replay;
      }
      const current = id === null ? null : this.revision(id);
      if (current && current.revision !== expected) throw new ProviderError("REVISION_CONFLICT", "Provider changed since it was read");
      const identity = id ?? "provider-" + randomUUID(), revision = current === null ? 1 : current.revision + 1;
      const previousSecret = current === null ? null : this.vault.read(identity, current.revision);
      if (current && current.hasCredential !== (previousSecret !== null)) throw new ProviderError("INVALID_VAULT", "Provider credential reference is inconsistent");
      secret = parsed.apiKey ?? previousSecret;
      const view: ProviderView = { id: identity, revision, name: parsed.name, protocol: parsed.protocol, baseUrl: parsed.baseUrl,
        models: parsed.models, defaultModel: parsed.defaultModel, enabled: parsed.enabled, hasCredential: secret !== null };
      const serialized = JSON.stringify(view);
      // A record larger than a record may be would be stored and then not read back, which would keep the service from starting: it is refused here.
      if (Buffer.byteLength(serialized, "utf8") > MAX_VIEW_BYTES) throw new ProviderError("INVALID_INPUT", "the Provider's name, address and models are larger than a Provider record may be (64 KiB)");
      if (secret !== null) this.vault.store(identity, revision, secret);
      this.db.prepare("INSERT INTO provider_revisions(provider_id,revision,view_json) VALUES(?,?,?)").run(identity, revision, serialized);
      if (current === null) this.db.prepare("INSERT INTO providers(id,current_revision) VALUES(?,?)").run(identity, revision);
      else this.db.prepare("UPDATE providers SET current_revision=? WHERE id=?").run(revision, identity);
      this.db.prepare("INSERT INTO provider_commands(command_id,fingerprint,provider_id,revision) VALUES(?,?,?,?)").run(key, fingerprint, identity, revision);
      this.assertOwned(); this.db.exec("COMMIT"); if (secret !== null) this.knownKeys.add(secret); return view;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { throw new ProviderError("STORAGE_FAILED", "Provider transaction cleanup failed"); }
      throw error instanceof ProviderError ? error : new ProviderError("STORAGE_FAILED", "Provider change could not be committed");
    }
  }
  private pinned(target: ProviderTarget): { view: ProviderView; secret: string | null } {
    this.assertOwned(); const requested = parseProviderTarget(target), current = this.revision(requested.providerId);
    if (!current.enabled) throw new ProviderError("PROVIDER_DISABLED", "Provider is disabled");
    const view = this.revision(requested.providerId, requested.revision);
    if (!view.enabled) throw new ProviderError("PROVIDER_DISABLED", "selected Provider revision is disabled");
    if (!view.models.includes(requested.model)) throw new ProviderError("MODEL_UNAVAILABLE", "model does not belong to the selected Provider revision");
    const secret = this.vault.read(view.id, view.revision);
    if (view.hasCredential !== (secret !== null)) throw new ProviderError("INVALID_VAULT", "Provider credential reference is inconsistent");
    if (secret !== null) this.knownKeys.add(secret);
    return { view, secret };
  }
  validate(target: ProviderTarget, harnessId: string): void {
    const { view, secret } = this.pinned(target); const product = assertProviderCompatibility(view.protocol, harnessId);
    if (product === "gemini" && secret === null) throw new ProviderError("CREDENTIAL_REQUIRED", "Gemini managed Provider execution requires an API key");
  }
  async materialize(target: ProviderTarget, harnessId: string, home: string): Promise<Readonly<Record<string, string>>> {
    const parsed = parseProviderTarget(target), { view, secret } = this.pinned(parsed);
    try {
      const result = await materializeProvider(view, parsed, harnessId, home, secret); this.assertOwned(); this.pinned(parsed); return result;
    } catch (error) { throw error instanceof ProviderError ? error : new ProviderError("CONFIGURATION_FAILED", "managed Provider configuration could not be prepared"); }
  }
  /** Only inventories reachable models; it is not a generation, credential validity or Harness readiness proof. */
  async probe(id: string): Promise<ProbeResult> {
    this.assertOwned();
    if (this.pendingProbes.size >= MAX_ACTIVE_PROBES) throw new ProviderError("PROBE_LIMIT", "Provider probe concurrency limit reached");
    const pending = this.probeOwned(id); this.pendingProbes.add(pending);
    try { return await pending; } finally { this.pendingProbes.delete(pending); }
  }
  private async probeOwned(id: string): Promise<ProbeResult> {
    this.assertOwned(); const view = this.revision(id);
    if (!view.enabled) throw new ProviderError("PROVIDER_DISABLED", "Provider is disabled");
    const secret = this.vault.read(view.id, view.revision);
    if (secret !== null) this.knownKeys.add(secret);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (view.protocol === "anthropic-messages") { headers["anthropic-version"] = "2023-06-01"; if (secret !== null) headers["x-api-key"] = secret; }
    else if (view.protocol === "gemini") { if (secret !== null) headers["x-goog-api-key"] = secret; }
    else if (secret !== null) headers.Authorization = "Bearer " + secret;
    const suffix = view.protocol === "gemini" ? "/v1beta/models" : "/models";
    const controller = new AbortController(); this.probes.add(controller);
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      const response = await fetch(view.baseUrl + suffix, { method: "GET", headers, redirect: "error", signal: controller.signal });
      if (!response.ok) { await response.body?.cancel(); throw new ProviderError("PROBE_HTTP_ERROR", "Provider model inventory request failed (HTTP " + response.status + ")"); }
      const announced = response.headers.get("content-length");
      if (announced !== null && Number(announced) > MAX_PROBE_BYTES) { await response.body?.cancel(); throw new ProviderError("PROBE_TOO_LARGE", "Provider model inventory exceeded its size limit"); }
      const chunks: Uint8Array[] = []; let length = 0;
      if (!response.body) throw new ProviderError("INVALID_PROBE", "Provider model inventory has no response body");
      const reader = response.body.getReader();
      try {
        for (;;) {
          const chunk = await reader.read(); if (chunk.done) break;
          length += chunk.value.byteLength;
          if (length > MAX_PROBE_BYTES) { await reader.cancel(); throw new ProviderError("PROBE_TOO_LARGE", "Provider model inventory exceeded its size limit"); }
          chunks.push(chunk.value);
        }
      } finally { reader.releaseLock(); }
      const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new ProviderError("INVALID_PROBE", "Provider returned an invalid model inventory");
      const row = parsed as Record<string, unknown>, entries = view.protocol === "gemini" ? row.models : row.data;
      if (!Array.isArray(entries) || entries.length > 4096) throw new ProviderError("INVALID_PROBE", "Provider returned an invalid model inventory");
      const models = entries.map(entry => {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new ProviderError("INVALID_PROBE", "Provider returned an invalid model entry");
        const item = entry as Record<string, unknown>, model = view.protocol === "gemini" ? item.name : item.id;
        if (typeof model !== "string" || !model || Buffer.byteLength(model, "utf8") > 256 || /[\x00-\x1f\x7f]/u.test(model)) throw new ProviderError("INVALID_PROBE", "Provider returned an invalid model identity");
        const normalized = view.protocol === "gemini" ? model.replace(/^models\//u, "") : model;
        if (!normalized) throw new ProviderError("INVALID_PROBE", "Provider returned an empty model identity");
        return normalized;
      });
      this.assertOwned();
      return { status: "models_reachable", models: [...new Set(models)].map(model => this.redact(model)) };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (controller.signal.aborted) throw new ProviderError("PROBE_TIMEOUT", "Provider model inventory request timed out or was closed");
      throw new ProviderError("PROBE_FAILED", "Provider model inventory request could not be completed");
    } finally { clearTimeout(timer); this.probes.delete(controller); }
  }
  /** Keys from every immutable revision are loaded and filtered, including keys never materialized in this process. */
  redact(text: string): string {
    let clean = text;
    for (const key of [...this.knownKeys].sort((left, right) => right.length - left.length)) clean = clean.split(key).join("[redacted]");
    return clean;
  }
  createTextRedactor(): ProviderTextRedactor {
    let suffix = "";
    return {
      push: (text: string): string => {
        const input = suffix + text; suffix = "";
        const keys = [...this.knownKeys].sort((left, right) => right.length - left.length);
        const starts = new Map<string, string[]>();
        for (const key of keys) { const first = key[0]!; const list = starts.get(first) ?? []; list.push(key); starts.set(first, list); }
        const output: string[] = []; let at = 0, plain = 0;
        while (at < input.length) {
          const remaining = input.length - at;
          const candidates = starts.get(input[at]!) ?? [];
          // Hold a full shorter key as well if it may become a longer key in the next delta.
          if (candidates.some(key => key.length > remaining && key.startsWith(input.slice(at)))) {
            output.push(input.slice(plain, at)); suffix = input.slice(at); return output.join("");
          }
          const complete = candidates.find(key => input.startsWith(key, at));
          if (complete === undefined) { at++; continue; }
          output.push(input.slice(plain, at), "[redacted]"); at += complete.length; plain = at;
        }
        output.push(input.slice(plain)); return output.join("");
      },
      flush: (): string => { if (suffix.length === 0) return ""; suffix = ""; return "[redacted]"; },
    };
  }
  close(): void {
    if (this.closed) return;
    if (this.pendingProbes.size !== 0) throw new ProviderError("PROBE_ACTIVE", "active Provider probes require awaitable shutdown");
    this.closeStorage();
  }
  /** Stops admission, aborts and waits for every owned HTTP read, then closes SQLite and zeroes the master key. */
  shutdown(): Promise<void> {
    if (this.shutdownPromise !== null) return this.shutdownPromise;
    if (this.closed) return Promise.resolve();
    this.closing = true; for (const probe of this.probes) probe.abort();
    this.shutdownPromise = Promise.allSettled([...this.pendingProbes]).then(() => { this.closeStorage(); });
    return this.shutdownPromise;
  }
  private closeStorage(): void {
    this.closed = true;
    this.vault.close();
    try { this.db.close(); }
    catch { throw new ProviderError("CLEANUP_FAILED", "Provider database cleanup could not be confirmed"); }
    finally { this.knownKeys.clear(); }
  }
}
