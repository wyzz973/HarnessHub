import type { ResolvedManagedControl } from "../../contracts/management.js";
import type { LocalProviderService } from "../provider/service.js";
import { RedactedHarnessControl } from "./redacted-control.js";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createNativeControl } from "../../adapters/control/factory.js";
import { NATIVE_FRAME_BYTES } from "../control/json-rpc-process.js";
import { chooseControl } from "../../contexts/catalog/application/select-control.js";
import { inventory } from "../catalog/inventory-composition.js";
import type { CleanupEvidence, ControlLaunch, HarnessControl } from "../../contracts/control.js";
import { SessionError, type HarnessSelection, type PreparedSessionBinding, type SelectionRequest,
  type SessionBindingFactory, type SessionConfiguration, type SessionId, type WorkspaceLease,
  type WorkspaceLeaseProvider } from "../../contracts/session.js";
import { MAX_CATALOG_BYTES, type ControlObservation } from "../../contexts/catalog/domain/catalog.js";
import { captureNativeEnvironment, nativeValues, referencedNativeValues, nativeDescriptorValues, type NativeEnvironment } from "./native-environment.js";
import type { NativeModelCatalog } from "../../contracts/control.js";
import type { NativeInstallationLocks, NativeUsageLease } from "../management/native-lock.js";

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
interface ManagedResolver { resolveControl(harnessId: string, controlId: string): ResolvedManagedControl | null }
interface Observation { readonly harnessId: string; readonly selected: ControlObservation; readonly searchPath: string; readonly managed: ResolvedManagedControl | null }
async function observe(request: SelectionRequest, configuration: SessionConfiguration, root: string, managedResolver?: ManagedResolver, source?: NativeEnvironment): Promise<Observation> {
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
  const observed = await inventory({ ...(snapshot === undefined ? {} : { manifest: snapshot }),
    ...(source === undefined ? {} : { environment: source.values, home: source.home }),
    packageRoots: configuration.packageRoots, searchDirs: configuration.searchDirs, pathOnly: configuration.pathOnly, ...(managedResolver === undefined ? {} : { managedResolver }) });
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
async function privateHome(root: string, configuration: SessionConfiguration): Promise<string> {
  if (configuration.configHome !== null) return configuration.configHome;
  const home = join(root, "home");
  await mkdir(home, { mode: 0o700 });
  for (const child of ["config", "data", "state", "cache", "codex", "claude", "opencode"])
    await mkdir(join(home, child), { mode: 0o700 });
  return home;
}
/** Fresh per-Turn control with a real workspace lease; this is public-context rehydration, not native resume. */
export class DirectorySessionBindingFactory implements SessionBindingFactory {
  constructor(private readonly workspaces: WorkspaceLeaseProvider, private readonly assertOwner: () => void, private readonly providers?: LocalProviderService, private readonly management?: ManagedResolver,
    private readonly nativeEnvironment: NativeEnvironment = captureNativeEnvironment(), private readonly nativeLocks?: NativeInstallationLocks) {}
  /** Private host observation source; never serialize this into public Session or Web DTOs. */
  get discoveryEnvironment(): NativeEnvironment { return this.nativeEnvironment; }
  async validate(request: SelectionRequest, configuration: SessionConfiguration): Promise<HarnessSelection> {
    this.assertOwner();
    const root = await realpath(await mkdtemp(join(tmpdir(), "harness-session-validation-")));
    try {
      const { harnessId, selected } = await observe(request, configuration, root, this.management, this.nativeEnvironment);
      this.assertOwner();
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
    let root: string | undefined, control: HarnessControl | undefined, usage: NativeUsageLease | undefined;
    try {
      usage = this.nativeLocks?.read(selection.harnessId);
      root = await realpath(await mkdtemp(join(tmpdir(), "harness-session-binding-")));
      const observed = await observe(selection, configuration, root, this.management, this.nativeEnvironment);
      if (observed.harnessId !== selection.harnessId || observed.selected.id !== selection.controlId || observed.selected.command === null)
        throw new SessionError("HARNESS_UNAVAILABLE", "the admitted control is no longer available");
      const home = selection.provider === undefined ? configuration.configHome : await privateHome(root, configuration);
      const environment: Record<string, string> = { ...await referencedNativeValues(this.nativeEnvironment, home, selection.harnessId, configuration.workspace), ...nativeDescriptorValues(this.nativeEnvironment, home, observed.selected.command.env), PATH: observed.managed?.command.env.PATH ? observed.managed.command.env.PATH + ":" + observed.searchPath : observed.searchPath,
        OPENCODE_DISABLE_AUTOUPDATE: "true", TMPDIR: root, PWD: configuration.workspace };
      if (selection.provider !== undefined) {
        if (!this.providers) throw new SessionError("PROVIDER_UNAVAILABLE", "Provider management is unavailable");
        if (configuration.configHome !== null) throw new SessionError("INCOMPATIBLE_CONFIGURATION", "managed Provider selection requires a private generated configuration home");
        if ((selection.harnessId === "codex" && observed.selected.protocol !== "codex-app-server") || (selection.harnessId === "gemini" && observed.selected.protocol !== "acp-v1"))
          throw new SessionError("UNSUPPORTED_PROVIDER", "this control recipe cannot use the managed Provider adapter");
        Object.assign(environment, await this.providers.materialize(selection.provider, selection.harnessId, home!));
      }
      const protocol = observed.selected.protocol;
      if (protocol !== "acp-v1" && protocol !== "codex-app-server" && protocol !== "pi-rpc") throw new SessionError("UNSUPPORTED_CONTROL", "unsupported control protocol");
      const launch: ControlLaunch = { ...observed.selected.command, env: environment, protocol };
      const options = { cwd: configuration.workspace, env: environment, requestTimeoutMs: 10000, runTimeoutMs: 300000,
        maxFrameBytes: NATIVE_FRAME_BYTES, maxDiagnosticBytes: 64 * 1024, closeGraceMs: 500 };
      this.assertOwner(); lease.assertOwned();
      control = await createNativeControl(selection.harnessId, launch, options);
      if (selection.provider !== undefined && this.providers) control = new RedactedHarnessControl(control, text => this.providers!.redact(text), () => this.providers!.createTextRedactor());
      return new DirectoryPreparedBinding(control, configuration.workspace, lease, root, this.assertOwner, observed.managed === null ? { source: "system" } : { source: "managed", id: observed.managed.installationId, revision: observed.managed.revision, version: observed.managed.version }, usage);
    } catch (error) {
      let cleanupError: unknown;
      let quiescent = control === undefined;
      if (control) try { await control.close(); quiescent = true; } catch (failure) { cleanupError = failure; }
      try { lease.release(quiescent); } catch (failure) { cleanupError ??= failure; }
      try { usage?.release(quiescent); } catch (failure) { cleanupError ??= failure; }
      if (root && quiescent) try { await rm(root, { recursive: true, force: true }); } catch (failure) { cleanupError ??= failure; }
      if (cleanupError) throw new SessionError("BINDING_CLEANUP_FAILED", "binding preparation failed and cleanup could not be confirmed");
      throw error;
    }
  }
  /** Read-only identity for catalog caches; execution always makes a fresh observation. No credentials are returned. */
  async catalogFingerprint(selection: SelectionRequest, configuration: SessionConfiguration): Promise<string> {
    this.assertOwner(); const root = await realpath(await mkdtemp(join(tmpdir(), "harness-catalog-identity-")));
    try {
      const observed = await observe(selection, configuration, root, this.management, this.nativeEnvironment), command = observed.selected.command;
      if (!command) throw new SessionError("HARNESS_UNAVAILABLE", "native control unavailable");
      const env = nativeValues(this.nativeEnvironment, configuration.configHome), home = env.HOME ?? this.nativeEnvironment.home;
      const codex = env.CODEX_HOME ?? join(home,".codex"), claude=env.CLAUDE_CONFIG_DIR ?? join(home,".claude"), pi=env.PI_CODING_AGENT_DIR ?? join(home,".pi","agent"), gemini=join(env.GEMINI_CLI_HOME ?? home,".gemini"), opencode=env.OPENCODE_CONFIG_DIR ?? join(env.XDG_CONFIG_HOME ?? join(home,".config"),"opencode");
      const hints: Readonly<Record<string, readonly string[]>> = { codex: [join(codex,"config.toml"),join(codex,"auth.json")], claude:[join(claude,"settings.json"),join(claude,".credentials.json")], openclaw:[env.OPENCLAW_CONFIG_PATH ?? join(env.OPENCLAW_STATE_DIR ?? join(home,".openclaw"),"openclaw.json")], cursor:[join(home,".cursor","cli-config.json")], pi:[join(pi,"settings.json"),join(pi,"models.json"),join(pi,"auth.json")], opencode:[join(opencode,"opencode.json"),join(opencode,"opencode.jsonc"),join(home,".local/share/opencode/auth.json")], gemini:[join(gemini,"settings.json"),join(gemini,"oauth_creds.json")] };
      const files = [command.executable, ...command.args.filter(arg => arg.startsWith("/")), ...(hints[selection.harnessId] ?? []), ...[".codex/config.toml",".claude/settings.json",".claude/settings.local.json",".gemini/settings.json",".pi/settings.json","opencode.json","opencode.jsonc"].map(path=>join(configuration.workspace,path))];
      const identities = await Promise.all(files.map(async path => { try { const canonical = await realpath(path), info = await stat(canonical); return [canonical,info.dev,info.ino,info.size,info.mtimeMs]; } catch (error) { if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return [path,"missing"]; throw error; } }));
      this.assertOwner(); return sha256(Buffer.from(JSON.stringify({ command, identities, managed: observed.managed?.revision })));
    } finally { await rm(root,{recursive:true,force:true}); }
  }
  /** Read-only native catalog probe; no prompt and no workspace writer lease. */
  async discoverModels(request: SelectionRequest, configuration: SessionConfiguration, signal: AbortSignal): Promise<NativeModelCatalog> {
    this.assertOwner();
    const root = await realpath(await mkdtemp(join(tmpdir(), "harness-native-models-")));
    let control: HarnessControl | undefined, close: Promise<CleanupEvidence> | null = null, usage: NativeUsageLease | undefined;
    const abort = () => { if (control) { close ??= control.close(); void close.catch(() => {}); } };
    signal.addEventListener("abort", abort, { once: true });
    try {
      if (signal.aborted) throw new SessionError("CANCELLED", "model discovery was cancelled");
      usage = this.nativeLocks?.read(request.harnessId);
      const observed = await observe(request, configuration, root, this.management, this.nativeEnvironment);
      if (observed.selected.command === null) throw new SessionError("HARNESS_UNAVAILABLE", "native control is unavailable");
      const env = { ...await referencedNativeValues(this.nativeEnvironment, configuration.configHome, observed.harnessId, configuration.workspace), ...nativeDescriptorValues(this.nativeEnvironment, configuration.configHome, observed.selected.command.env),
        PATH: observed.managed?.command.env.PATH ? observed.managed.command.env.PATH + ":" + observed.searchPath : observed.searchPath,
        TMPDIR: root, PWD: configuration.workspace, OPENCODE_DISABLE_AUTOUPDATE: "true" };
      const protocol = observed.selected.protocol;
      if (protocol !== "acp-v1" && protocol !== "codex-app-server" && protocol !== "pi-rpc") throw new SessionError("UNSUPPORTED_CONTROL", "native model discovery is unavailable");
      const launch: ControlLaunch = { ...observed.selected.command, protocol, env };
      const options = { cwd: configuration.workspace, env, requestTimeoutMs: 10000, runTimeoutMs: 300000, maxFrameBytes: NATIVE_FRAME_BYTES, maxDiagnosticBytes: 64 * 1024, closeGraceMs: 500 };
      control = await createNativeControl(observed.harnessId, launch, options);
      if (signal.aborted) { abort(); throw new SessionError("CANCELLED", "model discovery was cancelled"); }
      await control.initialize();
      let selectionError: NativeModelCatalog["selectionError"];
      if (protocol === "acp-v1") try { await control.open(configuration.workspace, request.nativeModel); }
      catch(error) { if(error!==null&&typeof error==="object"&&"code"in error&&error.code==="MODEL_UNAVAILABLE") selectionError={code:"MODEL_UNAVAILABLE",message:"所选模型当前不在本机目录中，请重新选择。"};else throw error; }
      if (!control.models) throw new SessionError("UNSUPPORTED_MODEL_SELECTION", "this Harness does not expose models");
      const discovered = await control.models(), catalog={...discovered,...(selectionError ? {selectionError} : {})}; this.assertOwner();
      if (signal.aborted) throw new SessionError("CANCELLED", "model discovery was cancelled");
      return catalog;
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
    private readonly root: string, private readonly owner: () => void, readonly installation: NonNullable<PreparedSessionBinding["installation"]>, private readonly usage?: NativeUsageLease) {}
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
    try { evidence = await this.control.close(); }
    catch (error) {
      this.closed = true;
      this.usage?.release(false);
      try { this.lease.release(false); }
      catch { throw new SessionError("BINDING_CLEANUP_FAILED", "control and workspace lease cleanup both failed"); }
      throw error;
    }
    this.closed = true;
    let releaseError: unknown;
    try { this.lease.release(true); } catch (error) { releaseError = error; }
    try { this.usage?.release(); } catch (error) { releaseError ??= error; }
    if (releaseError) throw releaseError;
    await rm(this.root, { recursive: true, force: true });
    return evidence;
  }
}
