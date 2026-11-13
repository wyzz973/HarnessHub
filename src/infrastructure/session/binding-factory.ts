import type { ResolvedManagedControl } from "../../contracts/management.js";
import type { LocalProviderService } from "../provider/service.js";
import { RedactedHarnessControl } from "./redacted-control.js";
import { createHash } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, open, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir, totalmem } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createNativeControl, relayCapabilities as driverRelayCapabilities } from "../../adapters/control/factory.js";
import { loadBuiltinCatalog } from "../../adapters/catalog.js";
import { catalogTarget } from "../catalog/platform.js";
import type { RelayCapabilities } from "../../contracts/relay.js";
import { NATIVE_FRAME_BYTES } from "../control/json-rpc-process.js";
import { chooseControl } from "../../contexts/catalog/application/select-control.js";
import { inventory } from "../catalog/inventory-composition.js";
import type { CleanupEvidence, ControlLaunch, HarnessControl } from "../../contracts/control.js";
import { resolveHostBudgets, type HostBudgets } from "../../contracts/native-host.js";
import { SessionError, type HarnessSelection, type PreparedSessionBinding, type SelectionRequest,
  type SessionBindingFactory, type SessionConfiguration, type SessionId, type WorkspaceLease,
  type WorkspaceLeaseProvider } from "../../contracts/session.js";
import { MAX_CATALOG_BYTES, type ControlObservation, type InstallationPolicy, type ResolvedCommand } from "../../contexts/catalog/domain/catalog.js";
import { captureNativeEnvironment, nativeBaseValues, nativeValues, referencedNativeValues, nativeDescriptorValues, NativeConfigError, type NativeEnvironment } from "./native-environment.js";
import { credentialValues } from "../../contexts/session/domain/relay/redaction.js";
import { HostTmpdirs, type HostTmpdir, type HostTmpdirIdentity } from "./host-tmpdir.js";
import type { TableAttachment, TableMount } from "../table/mount.js";
import type { NativeExtensions, NativeModelCatalog, NativeSessionImport, NativeSessionPage } from "../../contracts/control.js";
/** Reading a long native history (an ACP agent replays it in full) is bounded separately from Turn budgets, and long: a history of a long conversation takes minutes to replay. */
const NATIVE_IMPORT_MS = 10 * 60_000;
/**
 * How long a Harness's start is waited for before the Turn fails and says which step it was waiting for (the handshake, or opening its
 * session). Starting its plugins and MCP servers can take a minute or two, the first time more; this is for a start that is stuck, not slow.
 */
const NATIVE_STARTUP_MS = 5 * 60_000;
import type { NativeInstallationLocks, NativeUsageLease } from "../management/native-lock.js";
import { TABLE_RECORD_ENV } from "../../contracts/table.js";
import { nativeOnly, selectedLevels, sessionEntryOf } from "../../contracts/flavor.js";
import { flavorOf } from "../../adapters/flavors/index.js";

export interface ConfigurationInput {
  readonly workspace: string;
  readonly manifestPath?: string;
  readonly configHome?: string;
  readonly packageRoots?: readonly string[];
  readonly searchDirs?: readonly string[];
  readonly pathOnly?: boolean;
}
function absolute(value: string, label: string): string {
  if (typeof value !== "string" || !isAbsolute(value) || value.length > 4096 || /[\0\r\n]/u.test(value))
    throw new SessionError("INVALID_INPUT", label + " must be a bounded absolute path");
  return resolve(value);
}
async function directory(value: string, label: string): Promise<string> {
  const path = absolute(value, label);
  try {
    const canonical = await realpath(path);
    if (!(await stat(canonical)).isDirectory()) throw new Error("not a directory");
    return canonical;
  } catch { throw new SessionError("INVALID_INPUT", label + " must name an existing directory"); }
}
async function pinnedDirectory(path: string, label: string): Promise<void> {
  if (await directory(path, label) !== path || (await lstat(path)).isSymbolicLink())
    throw new SessionError("CONFIGURATION_CHANGED", label + " canonical path changed");
}
/** An explicit file is bounded before/during reading and never follows a link. */
async function manifestBytes(path: string): Promise<Buffer> {
  const handle = await open(absolute(path, "manifest"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_CATALOG_BYTES) throw new SessionError("INVALID_INPUT", "manifest must be a regular file of at most 256 KiB");
    const buffer = Buffer.alloc(MAX_CATALOG_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const chunk = await handle.read(buffer, length, buffer.length - length, length);
      if (chunk.bytesRead === 0) break;
      length += chunk.bytesRead;
    }
    if (length > MAX_CATALOG_BYTES) throw new SessionError("INVALID_INPUT", "manifest grew beyond 256 KiB");
    return buffer.subarray(0, length);
  } finally { await handle.close(); }
}
function sha256(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
/** Each file's identity (canonical path, device, inode, size, modification time) or that it is missing; contents are never read. */
async function fileIdentities(paths: readonly string[]): Promise<readonly unknown[]> {
  return Promise.all(paths.map(async path => {
    try { const canonical = await realpath(path), info = await stat(canonical); return [canonical, info.dev, info.ino, info.size, info.mtimeMs]; }
    catch (error) { if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return [path, "missing"]; throw error; }
  }));
}
/**
 * What a host class's TMPDIR is keyed by (ADR-056 §4.3, §4.12), as canonical text: `launch` holds the Harness, its entry,
 * the workspace and every value it is started with but TMPDIR (with this binding's own private root spelled as one
 * placeholder, so a generated configuration home does not make every Turn a class of its own); `installation` holds the
 * identities of the entry's executable and absolute arguments and the managed revision. No driver declares launch-bound
 * selections yet (ADR-056 §4.2), so the model and options are in neither. The text can hold credentials: it stays in
 * memory, and the TMPDIRs keep only HMACs of it under their namespace's key.
 */
async function hostTmpdirIdentity(selection: HarnessSelection, command: ResolvedCommand, managed: ResolvedManagedControl | null, workspace: string, environment: Readonly<Record<string, string>>, root: string): Promise<HostTmpdirIdentity> {
  const values = Object.entries(environment).filter(([name]) => name !== "TMPDIR").map(([name, value]) => [name, value.split(root).join("<binding>")] as const)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return { launch: JSON.stringify({ version: 1, harnessId: selection.harnessId, controlId: selection.controlId, workspace, environment: values }),
    installation: JSON.stringify({ version: 1, identities: await fileIdentities([command.executable, ...command.args.filter(arg => arg.startsWith("/"))]), managed: managed?.revision ?? null }) };
}
async function directories(values: readonly string[], label: string, maximum: number): Promise<readonly string[]> {
  if (!Array.isArray(values) || values.length > maximum) throw new SessionError("INVALID_INPUT", "too many " + label + " directories");
  return Promise.all(values.map(value => directory(value, label)));
}
/** Persists references and a manifest fingerprint only; configuration contents and secrets remain private. */
export async function prepareConfiguration(input: ConfigurationInput): Promise<SessionConfiguration> {
  const workspace = await directory(input.workspace, "workspace");
  const configHome = input.configHome === undefined ? null : await directory(input.configHome, "configuration home");
  const manifestPath = input.manifestPath === undefined ? null : absolute(input.manifestPath, "manifest");
  const manifestSha256 = manifestPath === null ? null : sha256(await manifestBytes(manifestPath));
  const packageRoots = await directories(input.packageRoots ?? [], "package root", 64);
  const searchDirs = await directories(input.searchDirs ?? [], "search", 128);
  if (input.pathOnly !== undefined && typeof input.pathOnly !== "boolean") throw new SessionError("INVALID_INPUT", "pathOnly must be boolean");
  return { workspace, configHome, manifestPath, manifestSha256, packageRoots, searchDirs, pathOnly: input.pathOnly ?? false };
}
/**
 * The relay's refusal when a configuration it reads for the known secrets cannot be read (review N3): which Harness, which
 * file and why, and what the user can do instead; nothing the file holds.
 */
function unreadableConfiguration(harness: string, error: NativeConfigError): SessionError {
  const why = error.reason === "not_a_file" ? "不是普通文件" : error.reason === "too_large" ? "超过 2 MiB"
    : error.code === "EACCES" || error.code === "EPERM" ? "没有读取权限" : "读取出错（" + (error.code ?? "原因不明").slice(0, 32) + "）";
  const plain = (text: string) => text.replace(/[\p{Cc}\p{Cf}]/gu, "?");
  const name = plain(harness).slice(0, 64), file = plain(error.file.length > 240 ? error.file.slice(0, 80) + "…" + error.file.slice(-159) : error.file);
  return new SessionError("RELAY_PREPARE_FAILED", "没能准备交接单：读不到 " + name + " 的配置文件 " + file + "（" + why + "）。HarnessHub 要从这个文件里找出交接单必须隐去的凭据，所以这条消息没有发出。修好或缩小这个文件后再发；也可以只发这条消息，不带交接单。");
}
interface ManagedResolver { resolveControl(harnessId: string, controlId: string): ResolvedManagedControl | null }
interface Observation { readonly harnessId: string; readonly selected: ControlObservation; readonly searchPath: string; readonly managed: ResolvedManagedControl | null }
async function observe(request: SelectionRequest, configuration: SessionConfiguration, root: string, installations: InstallationPolicy, managedResolver?: ManagedResolver, source?: NativeEnvironment): Promise<Observation> {
  const observed = await observeCatalog(configuration, root, installations, managedResolver, source);
  const harness = observed.report.harnesses.find(item => item.id === request.harnessId || item.aliases.includes(request.harnessId));
  if (!harness) throw new SessionError("HARNESS_UNAVAILABLE", "unknown Harness: " + request.harnessId);
  // A published managed default is an explicit installation choice for this Harness.
  // An admitted/requested control still remains exclusive across future observations.
  const managedChoices = harness.controls.filter(control => observed.managedBindings.has(control.id));
  const preferred = request.controlId ?? (managedChoices.length === 1 ? managedChoices[0]!.id : undefined);
  const selected = chooseControl(harness.controls, preferred);
  if (selected.protocol !== "acp-v1" && selected.protocol !== "codex-app-server" && selected.protocol !== "pi-rpc")
    throw new SessionError("UNSUPPORTED_CONTROL", "this control Driver is not implemented: " + selected.protocol);
  return { harnessId: harness.id, selected, searchPath: observed.searchPath, managed: observed.managedBindings.get(selected.id) ?? null };
}
/**
 * The catalog a configuration resolves controls from, observed once: the built-ins and the Session's manifest (checked
 * against its admitted fingerprint, copied into `root`), with what this Gateway counts as installed.
 */
async function observeCatalog(configuration: SessionConfiguration, root: string, installations: InstallationPolicy, managedResolver?: ManagedResolver, source?: NativeEnvironment): Promise<Awaited<ReturnType<typeof inventory>>> {
  await pinnedDirectory(configuration.workspace, "workspace");
  if (configuration.configHome !== null) await pinnedDirectory(configuration.configHome, "configuration home");
  for (const path of configuration.packageRoots) await pinnedDirectory(path, "package root");
  for (const path of configuration.searchDirs) await pinnedDirectory(path, "search");
  let snapshot: string | undefined;
  if (configuration.manifestPath !== null) {
    const bytes = await manifestBytes(configuration.manifestPath);
    if (sha256(bytes) !== configuration.manifestSha256) throw new SessionError("CONFIGURATION_CHANGED", "catalog manifest differs from the admitted Session fingerprint");
    snapshot = join(root, "catalog-snapshot.json");
    await writeFile(snapshot, bytes, { flag: "wx", mode: 0o600 });
  } else if (configuration.manifestSha256 !== null) throw new SessionError("INVALID_INPUT", "manifest fingerprint requires a manifest reference");
  return inventory({ ...(snapshot === undefined ? {} : { manifest: snapshot }),
    ...(source === undefined ? {} : { environment: source.values, home: source.home }),
    packageRoots: configuration.packageRoots, searchDirs: configuration.searchDirs, pathOnly: configuration.pathOnly, installations, ...(managedResolver === undefined ? {} : { managedResolver }) });
}
async function privateHome(root: string, configuration: SessionConfiguration): Promise<string> {
  if (configuration.configHome !== null) return configuration.configHome;
  const home = join(root, "home");
  await mkdir(home, { mode: 0o700 });
  for (const child of ["config", "data", "state", "cache", "codex", "claude", "opencode"])
    await mkdir(join(home, child), { mode: 0o700 });
  return home;
}
/** The built-in catalog's control protocols by Harness (and alias) and control, read once (it is static, ADR-033). */
let builtinProtocols: ReadonlyMap<string, ControlLaunch["protocol"]> | null = null;
function builtinProtocol(harnessId: string, controlId: string): ControlLaunch["protocol"] | undefined {
  if (builtinProtocols === null) {
    const table = new Map<string, ControlLaunch["protocol"]>();
    try {
      for (const definition of loadBuiltinCatalog(catalogTarget()))
        for (const control of definition.controls)
          if (control.protocol === "acp-v1" || control.protocol === "codex-app-server" || control.protocol === "pi-rpc")
            for (const id of [definition.id, ...definition.aliases]) table.set(id + "\0" + control.id, control.protocol);
    } catch { /* A catalog that cannot be read places no control; admission then reads no declaration (the most conservative). */ }
    builtinProtocols = table;
  }
  return builtinProtocols.get(harnessId + "\0" + controlId);
}
/** Fresh per-Turn control with a real workspace lease; this is public-context rehydration, not native resume. */
export class DirectorySessionBindingFactory implements SessionBindingFactory {
  /**
   * The protocol of each control this factory resolved (validate, prepare, a probe), by Harness and control: what places a
   * control a Session's manifest declares, which the built-in catalog does not know (G072). In memory only; a new owner learns
   * them again at the first resolution.
   */
  private readonly protocols = new Map<string, ControlLaunch["protocol"]>();
  private remember(observed: Observation): void {
    const protocol = observed.selected.protocol;
    if (protocol === "acp-v1" || protocol === "codex-app-server" || protocol === "pi-rpc") {
      if (this.protocols.size >= 1024 && !this.protocols.has(observed.harnessId + "\0" + observed.selected.id)) this.protocols.delete(this.protocols.keys().next().value!);
      this.protocols.set(observed.harnessId + "\0" + observed.selected.id, protocol);
    }
  }
  /**
   * The static relay declaration of the Driver that serves `selection` (ADR-055 §3.2, F10; G072 step one, the approval agent's
   * A8): the Driver createNativeControl picks for its Harness and the control's protocol — the protocol this factory resolved
   * for the control, else the built-in catalog's — read without starting anything, building a control or reading a file. Null
   * when that Driver declares none, and when the control's protocol cannot be told (a manifest's control not resolved by this
   * owner yet): the relay then reads the most conservative declaration (a Driver that declares nothing), never one that would
   * let more through. A managed Provider's selection carries no native relay.
   */
  relayCapabilities(selection: HarnessSelection): RelayCapabilities | null {
    if (selection.provider !== undefined) return null;
    const protocol = this.protocols.get(selection.harnessId + "\0" + selection.controlId) ?? builtinProtocol(selection.harnessId, selection.controlId);
    return protocol === undefined ? null : driverRelayCapabilities(selection.harnessId, protocol);
  }
  private readonly budgets: HostBudgets;
  private readonly tmpdirs: HostTmpdirs | null;
  private readonly table: TableMount | null;
  /**
   * `installations` is what this Gateway counts as an installation (ADR-044); its Harness list observes with the same policy.
   * `hosts` gives the host budgets (the close grace and the TMPDIR limits; resolveHostBudgets' defaults when absent) and the
   * host classes' TMPDIRs. Without the latter they go to `hosts` in the workspace leases'
   * directory, which keeps them shared exactly where the leases are, reporting on stderr and with no data directory to
   * keep apart from; a lease provider without a directory leaves none, and prepare() then refuses with HOST_TMPDIR_FAILED.
   * `table` is the context table's mount: every process a Session starts carries the Hub's address and its own token in its
   * environment (TableMount); without it, or while the Hub has no address, none does.
   */
  constructor(private readonly workspaces: WorkspaceLeaseProvider, private readonly assertOwner: () => void, readonly installations: InstallationPolicy, private readonly providers?: LocalProviderService, private readonly management?: ManagedResolver,
    private readonly nativeEnvironment: NativeEnvironment = captureNativeEnvironment(), private readonly nativeLocks?: NativeInstallationLocks,
    hosts?: { readonly budgets?: HostBudgets; readonly tmpdirs?: HostTmpdirs; readonly table?: TableMount }) {
    if (installations !== "official" && installations !== "any") throw new SessionError("INVALID_INPUT", "installation policy must be official or any");
    this.table = hosts?.table ?? null;
    const budgets = this.budgets = hosts?.budgets ?? resolveHostBudgets({ physicalMemoryBytes: totalmem() });
    this.tmpdirs = hosts?.tmpdirs ?? (workspaces.namespace === undefined ? null : new HostTmpdirs(join(workspaces.namespace, "hosts"), { maxBytes: budgets.hostTmpdirMaxBytes,
      maxEntries: budgets.hostTmpdirMaxEntries, unusedMs: budgets.hostTmpdirUnusedMs, closeWaitMs: budgets.hostTmpdirCloseWaitMs, report: problem => { process.stderr.write("HarnessGateway: HOST_TMPDIR (" + problem + ")\n"); } }));
  }
  /** Private host observation source; never serialize this into public Session or Web DTOs. */
  get discoveryEnvironment(): NativeEnvironment { return this.nativeEnvironment; }
  async validate(request: SelectionRequest, configuration: SessionConfiguration): Promise<HarnessSelection> {
    this.assertOwner();
    const root = await realpath(await mkdtemp(join(tmpdir(), "harness-session-validation-")));
    try {
      const observedNow = await observe(request, configuration, root, this.installations, this.management, this.nativeEnvironment), { harnessId, selected } = observedNow;
      this.assertOwner(); this.remember(observedNow);
      if (request.provider !== undefined && request.provider !== null) {
        if (!this.providers) throw new SessionError("PROVIDER_UNAVAILABLE", "Provider management is unavailable");
        if (configuration.configHome !== null) throw new SessionError("INCOMPATIBLE_CONFIGURATION", "managed Provider selection requires a private generated configuration home");
        if ((harnessId === "codex" && selected.protocol !== "codex-app-server") || (harnessId === "gemini" && selected.protocol !== "acp-v1"))
          throw new SessionError("UNSUPPORTED_PROVIDER", "this control recipe cannot use the managed Provider adapter");
        this.providers.validate(request.provider, harnessId);
      }
      if (request.nativeModel !== undefined && request.provider != null) throw new SessionError("INVALID_INPUT", "native model and managed Provider are mutually exclusive");
      return { harnessId, controlId: selected.id, ...(request.provider == null ? {} : { provider: request.provider }),
        ...(request.nativeModel === undefined ? {} : { nativeModel: request.nativeModel }), ...(request.nativeOptions === undefined ? {} : { nativeOptions: request.nativeOptions }) };
    } finally { await rm(root, { recursive: true, force: true }); }
  }
  async prepare(selection: HarnessSelection, configuration: SessionConfiguration, session: SessionId, run: string): Promise<PreparedSessionBinding> {
    this.assertOwner();
    const lease = this.workspaces.acquire(configuration.workspace, session, run);
    let root: string | undefined, control: HarnessControl | undefined, usage: NativeUsageLease | undefined, temporary: HostTmpdir | undefined, attached: TableAttachment | null = null;
    try {
      usage = this.nativeLocks?.read(selection.harnessId);
      root = await realpath(await mkdtemp(join(tmpdir(), "harness-session-binding-")));
      const observed = await observe(selection, configuration, root, this.installations, this.management, this.nativeEnvironment);
      this.remember(observed);
      if (observed.harnessId !== selection.harnessId || observed.selected.id !== selection.controlId || observed.selected.command === null)
        throw new SessionError("HARNESS_UNAVAILABLE", "the admitted control is no longer available");
      const home = selection.provider === undefined ? configuration.configHome : await privateHome(root, configuration);
      const referenced = await referencedNativeValues(this.nativeEnvironment, home, selection.harnessId, configuration.workspace);
      const environment: Record<string, string> = { ...referenced, ...nativeDescriptorValues(this.nativeEnvironment, home, observed.selected.command.env), PATH: observed.managed?.command.env.PATH ? observed.managed.command.env.PATH + ":" + observed.searchPath : observed.searchPath,
        OPENCODE_DISABLE_AUTOUPDATE: "true", PWD: configuration.workspace };
      if (selection.provider !== undefined) {
        if (!this.providers) throw new SessionError("PROVIDER_UNAVAILABLE", "Provider management is unavailable");
        if (configuration.configHome !== null) throw new SessionError("INCOMPATIBLE_CONFIGURATION", "managed Provider selection requires a private generated configuration home");
        if ((selection.harnessId === "codex" && observed.selected.protocol !== "codex-app-server") || (selection.harnessId === "gemini" && observed.selected.protocol !== "acp-v1"))
          throw new SessionError("UNSUPPORTED_PROVIDER", "this control recipe cannot use the managed Provider adapter");
        Object.assign(environment, await this.providers.materialize(selection.provider, selection.harnessId, home!));
      }
      const protocol = observed.selected.protocol;
      if (protocol !== "acp-v1" && protocol !== "codex-app-server" && protocol !== "pi-rpc") throw new SessionError("UNSUPPORTED_CONTROL", "unsupported control protocol");
      // The host class's own TMPDIR, kept between Turns (ADR-056 §4.12), under the workspace lease this Turn holds; the
      // binding's private root keeps only what is the Turn's alone (the catalog snapshot, a generated configuration home).
      if (this.tmpdirs === null) throw new SessionError("HOST_TMPDIR_FAILED", "host temporary directories are unavailable");
      temporary = await this.tmpdirs.acquire(await hostTmpdirIdentity(selection, observed.selected.command, observed.managed, configuration.workspace, environment, root));
      environment.TMPDIR = temporary.path;
      // The context table (docs/decisions/LOG.md, 2026-11-11): the Hub's address and a token of this process alone, for the tool
      // process the Harness starts inside it. Added after the class identity above: a token per process must not make a class per Turn.
      // A Harness whose declaration gives the tools as a command (`cli`) has the conversation's command written with the token.
      attached = this.table?.attach({ sessionId: session, harnessId: selection.harnessId, controlId: selection.controlId }, { command: selection.provider === undefined && sessionEntryOf(flavorOf(selection.harnessId)).tools === "cli" }) ?? null;
      if (attached !== null) Object.assign(environment, attached.env);
      // How this Harness reads the record (FlavorCapabilities.record): one that reads it as files has its tool server told so, and that server leaves its reading tools out.
      // HARNESSHUB_RECORD_READ (files | tools) in the Gateway's own environment overrides the declarations, for measuring one way against the other.
      const declared = flavorOf(selection.harnessId)?.capabilities?.record ?? "tools", forced = process.env.HARNESSHUB_RECORD_READ;
      const recordFiles = attached !== null && attached.command === undefined && selection.provider === undefined && (forced === "files" || forced === "tools" ? forced : declared) === "files";
      if (recordFiles) environment[TABLE_RECORD_ENV] = "files";
      // Whether this process has the Hub's tools, as a fact of how it is started (the packet may repeat it to the model): it carries the table's
      // environment, it reads the configuration the Hub's tool entry is written in (the user's own, not a generated or an isolated home), and
      // that Harness's configuration holds the entry. A kept process keeps this answer; a probe that cannot tell says no.
      const configured = attached !== null && this.table !== null && selection.provider === undefined && configuration.configHome === null && await this.table.hasTools(selection.harnessId);
      const launch: ControlLaunch = { ...observed.selected.command, env: environment, protocol };
      // A Turn has no time wall (2026-11-12): the driver sets no deadline for it, and the Runtime stops it only for an operator's budget or
      // the user. The close grace is the host budgets' (ADR-056 §4.11); a Turn's close never waits for what left the program's group.
      const options = { cwd: configuration.workspace, env: environment, requestTimeoutMs: 10000, startupTimeoutMs: NATIVE_STARTUP_MS,
        maxFrameBytes: NATIVE_FRAME_BYTES, maxDiagnosticBytes: 64 * 1024, closeGraceMs: this.budgets.closeGraceMs,
        ...(nativeOnly(selection.nativeOptions) === undefined ? {} : { selectedOptions: nativeOnly(selection.nativeOptions)! }),
        // The levels by the Hub's keys: the Driver carries them out by the Harness's declaration (environment at start, native values at open).
        ...selectedLevels(selection.nativeOptions) };
      this.assertOwner(); lease.assertOwned();
      control = await createNativeControl(selection.harnessId, launch, options);
      if (selection.provider !== undefined && this.providers) control = new RedactedHarnessControl(control, text => this.providers!.redact(text), () => this.providers!.createTextRedactor());
      // A Driver that hands the tools to its session itself has them whatever the user's configuration holds (docs/decisions/LOG.md, 2026-11-12).
      const hubTools = configured || attached !== null && (control.sessionTools === true || attached.command !== undefined);
      // What the relay must never send on (ADR-055 §10.2 (a)–(c)): credential-named values this program was given or this
      // Gateway's environment holds, and whatever its configuration references by name.
      const base = nativeBaseValues(this.nativeEnvironment, home, selection.harnessId);
      const secrets = credentialValues({ environments: [environment, this.nativeEnvironment.values], referenced: Object.entries(referenced).filter(([name]) => !(name in base)) }, existsSync);
      return new DirectoryPreparedBinding(control, configuration.workspace, lease, root, temporary, this.assertOwner, observed.managed === null ? { source: "system" } : { source: "managed", id: observed.managed.installationId, revision: observed.managed.revision, version: observed.managed.version }, usage, secrets, attached, hubTools, attached?.command, recordFiles && hubTools);
    } catch (error) {
      attached?.detach();
      let cleanupError: unknown;
      let quiescent = control === undefined;
      if (control) try { await control.close(); quiescent = true; } catch (failure) { cleanupError = failure; }
      // A program that may still run keeps its class's TMPDIR held, so nothing empties it under that program.
      if (quiescent) await temporary?.release();
      try { lease.release(quiescent); } catch (failure) { cleanupError ??= failure; }
      try { usage?.release(quiescent); } catch (failure) { cleanupError ??= failure; }
      if (root && quiescent) try { await rm(root, { recursive: true, force: true }); } catch (failure) { cleanupError ??= failure; }
      if (cleanupError) throw new SessionError("BINDING_CLEANUP_FAILED", "binding preparation failed and cleanup could not be confirmed");
      throw error;
    }
  }
  /**
   * The relay's known secrets for a Session's Harnesses (ADR-055 §10.2 (a)–(c) at Session level, review M1): for each of
   * `harnessIds`, the values its configuration references by name beyond its base profile, and the credential-named values
   * of every control env the catalog (built-ins and the Session's manifest) declares for it; with the credential-named
   * values of this Gateway's own environment. Reads the catalog and each Harness's configuration files as a binding does;
   * starts nothing and holds no lease. In memory only. A configuration file that exists but cannot be read (not a regular
   * file, over 2 MiB, no permission) rejects with RELAY_PREPARE_FAILED naming the Harness, the file and why, never a value;
   * the catalog's own refusals (a manifest changed since admission) reject as a binding's preparation would.
   */
  async relaySecrets(configuration: SessionConfiguration, harnessIds: readonly string[]): Promise<readonly string[]> {
    this.assertOwner();
    const wanted = [...new Set(harnessIds)].sort(), referenced: (readonly [string, string])[] = [], environments: Readonly<Record<string, string>>[] = [this.nativeEnvironment.values];
    const root = await realpath(await mkdtemp(join(tmpdir(), "harness-relay-secrets-")));
    let definitions: Awaited<ReturnType<typeof observeCatalog>>["definitions"];
    try { definitions = (await observeCatalog(configuration, root, this.installations, this.management, this.nativeEnvironment)).definitions; }
    finally { await rm(root, { recursive: true, force: true }); }
    for (const harnessId of wanted) {
      const definition = definitions.find(item => item.id === harnessId || item.aliases.includes(harnessId));
      for (const control of definition?.controls ?? []) environments.push(control.env);
      let values: Readonly<Record<string, string>>;
      try { values = await referencedNativeValues(this.nativeEnvironment, configuration.configHome, harnessId, configuration.workspace); }
      catch (error) { if (error instanceof NativeConfigError) throw unreadableConfiguration(definition?.name ?? harnessId, error); throw error; }
      const base = nativeBaseValues(this.nativeEnvironment, configuration.configHome, harnessId);
      for (const entry of Object.entries(values)) if (!(entry[0] in base)) referenced.push(entry);
    }
    this.assertOwner();
    return credentialValues({ environments, referenced }, existsSync);
  }
  /** Releases the workspace lease an ended owner left for `session` once its kept processes were confirmed ended (ADR-030). */
  releaseAbandonedLease(configuration: SessionConfiguration, session: SessionId): boolean {
    this.assertOwner();
    return this.workspaces.releaseAbandoned?.(configuration.workspace, session) ?? false;
  }
  /**
   * Ends the background removal of host TMPDIRs moved aside (HostTmpdirs.close(): within its bound, the rest stays for the
   * next start's sweep). Directories already handed out stay usable. Idempotent; never rejects.
   */
  async close(): Promise<void> { await this.tmpdirs?.close(); }
  /**
   * Read-only identity for catalog caches, with the control entry the selection resolves to; execution always makes a fresh
   * observation. File identities only (never contents), and no credentials are returned.
   */
  async catalogFingerprint(selection: SelectionRequest, configuration: SessionConfiguration): Promise<{ readonly fingerprint: string; readonly controlId: string }> {
    this.assertOwner(); const root = await realpath(await mkdtemp(join(tmpdir(), "harness-catalog-identity-")));
    try {
      const observed = await observe(selection, configuration, root, this.installations, this.management, this.nativeEnvironment), command = observed.selected.command;
      this.remember(observed);
      if (!command) throw new SessionError("HARNESS_UNAVAILABLE", "native control unavailable");
      const env = nativeValues(this.nativeEnvironment, configuration.configHome), home = env.HOME ?? this.nativeEnvironment.home;
      const codex = env.CODEX_HOME ?? join(home,".codex"), claude=env.CLAUDE_CONFIG_DIR ?? join(home,".claude"), pi=env.PI_CODING_AGENT_DIR ?? join(home,".pi","agent"), gemini=join(env.GEMINI_CLI_HOME ?? home,".gemini"), opencode=env.OPENCODE_CONFIG_DIR ?? join(env.XDG_CONFIG_HOME ?? join(home,".config"),"opencode");
      const hermes = this.nativeEnvironment.values.HERMES_HOME ?? join(home,".hermes"), dsh = this.nativeEnvironment.values.DSH_HOME ?? join(home,".dsh");
      const hints: Readonly<Record<string, readonly string[]>> = { codex: [join(codex,"config.toml"),join(codex,"auth.json")], claude:[join(claude,"settings.json"),join(claude,".credentials.json")], openclaw:[env.OPENCLAW_CONFIG_PATH ?? join(env.OPENCLAW_STATE_DIR ?? join(home,".openclaw"),"openclaw.json")], cursor:[join(home,".cursor","cli-config.json")], pi:[join(pi,"settings.json"),join(pi,"models.json"),join(pi,"auth.json")], opencode:[join(opencode,"opencode.json"),join(opencode,"opencode.jsonc"),join(home,".local/share/opencode/auth.json")], gemini:[join(gemini,"settings.json"),join(gemini,"oauth_creds.json")],
        hermes:[join(hermes,"config.yaml"),join(hermes,".env"),join(hermes,"auth.json")], dsh:[join(dsh,"settings.yaml"),join(dsh,"cordis.patch.yml"),join(dsh,".credentials.yaml"),join(dsh,"profiles","acp","cordis.patch.yml"),join(dsh,"profiles","acp","package.json")] };
      const files = [command.executable, ...command.args.filter(arg => arg.startsWith("/")), ...(hints[selection.harnessId] ?? []), ...[".codex/config.toml",".claude/settings.json",".claude/settings.local.json",".gemini/settings.json",".pi/settings.json","opencode.json","opencode.jsonc"].map(path=>join(configuration.workspace,path))];
      const identities = await fileIdentities(files);
      this.assertOwner(); return { fingerprint: sha256(Buffer.from(JSON.stringify({ command, identities, managed: observed.managed?.revision }))), controlId: observed.selected.id };
    } finally { await rm(root,{recursive:true,force:true}); }
  }
  /**
   * Read-only native catalog probe; no prompt and no workspace writer lease. An ACP catalog is only available from a
   * session, so the probe opens one; `opened` receives its native identity as soon as the Harness has created it.
   */
  async discoverModels(request: SelectionRequest, configuration: SessionConfiguration, signal: AbortSignal, opened?: (nativeId: string) => void): Promise<NativeModelCatalog> {
    return this.probe(request, configuration, signal, async (control, protocol) => {
      let selectionError: NativeModelCatalog["selectionError"];
      if (protocol === "acp-v1") try { const id = await control.open(configuration.workspace, request.nativeModel); opened?.(id); }
      catch(error) { if(error!==null&&typeof error==="object"&&"code"in error&&error.code==="MODEL_UNAVAILABLE") selectionError={code:"MODEL_UNAVAILABLE",message:"所选模型当前不在本机目录中，请重新选择。"};else throw error; }
      if (!control.models) throw new SessionError("UNSUPPORTED_MODEL_SELECTION", "this Harness does not expose models");
      const discovered = await control.models();
      return { ...discovered, ...(selectionError ? { selectionError } : {}) };
    });
  }
  /** Skills, MCP servers and plugins as the installed Harness reports them; an interface without such a list returns null. */
  async discoverExtensions(request: SelectionRequest, configuration: SessionConfiguration, signal: AbortSignal): Promise<NativeExtensions | null> {
    return this.probe(request, configuration, signal, async control => control.extensions ? control.extensions() : null);
  }
  /** The installed Harness's own sessions of this workspace, newest first; null when its interface cannot list them. */
  async listNativeSessions(request: SelectionRequest, configuration: SessionConfiguration, signal: AbortSignal, cursor?: string): Promise<NativeSessionPage | null> {
    return this.probe(request, configuration, signal, async control => {
      if (!control.nativeSessions) return null;
      try { return await control.nativeSessions(configuration.workspace, cursor); }
      catch (error) { if (error !== null && typeof error === "object" && "code" in error && error.code === "NATIVE_SESSION_LIST_UNAVAILABLE") return null; throw error; }
    });
  }
  /** Reads one native session of this workspace for continuing it; bounded by its own deadline, never prompts. */
  async readNativeSession(selection: HarnessSelection, configuration: SessionConfiguration, nativeId: string): Promise<NativeSessionImport> {
    return this.probe(selection, configuration, AbortSignal.timeout(NATIVE_IMPORT_MS), async control => {
      if (!control.importSession) throw new SessionError("NATIVE_SESSION_LIST_UNAVAILABLE", "this Harness cannot continue its own sessions in the Hub");
      return control.importSession(nativeId, configuration.workspace);
    });
  }
  /** One short-lived native probe on the original installation; cleanup and the native read lease are always awaited. */
  private async probe<T>(request: SelectionRequest, configuration: SessionConfiguration, signal: AbortSignal, read: (control: HarnessControl, protocol: ControlLaunch["protocol"]) => Promise<T>): Promise<T> {
    this.assertOwner();
    const root = await realpath(await mkdtemp(join(tmpdir(), "harness-native-models-")));
    let control: HarnessControl | undefined, close: Promise<CleanupEvidence> | null = null, usage: NativeUsageLease | undefined;
    const abort = () => { if (control) { close ??= control.close(); void close.catch(() => {}); } };
    signal.addEventListener("abort", abort, { once: true });
    try {
      if (signal.aborted) throw new SessionError("CANCELLED", "model discovery was cancelled");
      usage = this.nativeLocks?.read(request.harnessId);
      const observed = await observe(request, configuration, root, this.installations, this.management, this.nativeEnvironment);
      this.remember(observed);
      if (observed.selected.command === null) throw new SessionError("HARNESS_UNAVAILABLE", "native control is unavailable");
      const env = { ...await referencedNativeValues(this.nativeEnvironment, configuration.configHome, observed.harnessId, configuration.workspace), ...nativeDescriptorValues(this.nativeEnvironment, configuration.configHome, observed.selected.command.env),
        PATH: observed.managed?.command.env.PATH ? observed.managed.command.env.PATH + ":" + observed.searchPath : observed.searchPath,
        TMPDIR: root, PWD: configuration.workspace, OPENCODE_DISABLE_AUTOUPDATE: "true" };
      const protocol = observed.selected.protocol;
      if (protocol !== "acp-v1" && protocol !== "codex-app-server" && protocol !== "pi-rpc") throw new SessionError("UNSUPPORTED_CONTROL", "native model discovery is unavailable");
      const launch: ControlLaunch = { ...observed.selected.command, protocol, env };
      // A probe keeps its own private TMPDIR: it holds no workspace lease, so it never shares a host class's directory.
      const options = { cwd: configuration.workspace, env, requestTimeoutMs: 10000, runTimeoutMs: 300000, maxFrameBytes: NATIVE_FRAME_BYTES, maxDiagnosticBytes: 64 * 1024,
        closeGraceMs: this.budgets.closeGraceMs };
      control = await createNativeControl(observed.harnessId, launch, options);
      if (signal.aborted) { abort(); throw new SessionError("CANCELLED", "model discovery was cancelled"); }
      await control.initialize();
      const value = await read(control, protocol); this.assertOwner();
      if (signal.aborted) throw new SessionError("CANCELLED", "model discovery was cancelled");
      return value;
    } finally {
      signal.removeEventListener("abort", abort);
      let quiescent = control === undefined, cleanupError: unknown;
      try { if (control) { close ??= control.close(); await close; quiescent = true; } } catch (error) { cleanupError = error; }
      try { usage?.release(quiescent); } catch (error) { cleanupError ??= error; }
      if (quiescent) try { await rm(root, { recursive: true, force: true }); } catch (error) { cleanupError ??= error; }
      if (cleanupError) throw cleanupError;
    }
  }
}
class DirectoryPreparedBinding implements PreparedSessionBinding {
  private closing: Promise<CleanupEvidence> | null = null;
  private closed = false;
  constructor(readonly control: HarnessControl, readonly workspace: string, private readonly lease: WorkspaceLease,
    private readonly root: string, private readonly temporary: HostTmpdir, private readonly owner: () => void, readonly installation: NonNullable<PreparedSessionBinding["installation"]>, private readonly usage?: NativeUsageLease,
    readonly secrets: readonly string[] = [], private readonly table: TableAttachment | null = null, readonly hubTools = false, command?: string, readonly recordFiles = false) { if (command !== undefined) this.hubCommand = command; }
  readonly hubCommand?: string;
  assertOwned(): void {
    if (this.closed || this.closing !== null) throw new SessionError("BINDING_CLOSED", "binding is closing or closed");
    this.owner(); this.lease.assertOwned(); this.usage?.assertOwned();
  }
  close(): Promise<CleanupEvidence> {
    this.closing ??= this.closeOwned();
    return this.closing;
  }
  private async closeOwned(): Promise<CleanupEvidence> {
    let evidence: CleanupEvidence;
    // The process's token goes with the close, whether or not the close could confirm the process ended: the Hub no longer answers it.
    try { evidence = await this.control.close(); }
    catch (error) {
      this.closed = true; this.table?.detach();
      this.usage?.release(false);
      try { this.lease.release(false); }
      catch { throw new SessionError("BINDING_CLEANUP_FAILED", "control and workspace lease cleanup both failed"); }
      throw error;
    }
    this.closed = true; this.table?.detach();
    // Handed back while the workspace lease still keeps the class to this Turn (an oversized directory is moved aside then);
    // a close that failed above keeps it held, since its program may still run.
    await this.temporary.release();
    let releaseError: unknown;
    try { this.lease.release(true); } catch (error) { releaseError = error; }
    try { this.usage?.release(); } catch (error) { releaseError ??= error; }
    if (releaseError) throw releaseError;
    await rm(this.root, { recursive: true, force: true });
    return evidence;
  }
}
