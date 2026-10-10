import type { ResolvedManagedControl } from "../../contracts/management.js";
import type { LocalProviderService } from "../provider/service.js";
import { RedactedHarnessControl } from "./redacted-control.js";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { AcpControl } from "../../adapters/control/acp.js";
import { CodexControl } from "../../adapters/control/codex.js";
import { chooseControl } from "../../contexts/catalog/application/select-control.js";
import { inventory } from "../catalog/inventory-composition.js";
import type { CleanupEvidence, ControlLaunch, HarnessControl } from "../../contracts/control.js";
import { SessionError, type HarnessSelection, type PreparedSessionBinding, type SelectionRequest,
  type SessionBindingFactory, type SessionConfiguration, type SessionId, type WorkspaceLease,
  type WorkspaceLeaseProvider } from "../../contracts/session.js";
import { MAX_CATALOG_BYTES, type ControlObservation } from "../../contexts/catalog/domain/catalog.js";

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
async function observe(request: SelectionRequest, configuration: SessionConfiguration, root: string, managedResolver?: ManagedResolver): Promise<Observation> {
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
    packageRoots: configuration.packageRoots, searchDirs: configuration.searchDirs, pathOnly: configuration.pathOnly, ...(managedResolver === undefined ? {} : { managedResolver }) });
  const harness = observed.report.harnesses.find(item => item.id === request.harnessId || item.aliases.includes(request.harnessId));
  if (!harness) throw new SessionError("HARNESS_UNAVAILABLE", "unknown Harness: " + request.harnessId);
  // A published managed default is an explicit installation choice for this Harness.
  // An admitted/requested control still remains exclusive across future observations.
  const managedChoices = harness.controls.filter(control => observed.managedBindings.has(control.id));
  const preferred = request.controlId ?? (managedChoices.length === 1 ? managedChoices[0]!.id : undefined);
  const selected = chooseControl(harness.controls, preferred);
  if (selected.protocol !== "acp-v1" && selected.protocol !== "codex-app-server")
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
  constructor(private readonly workspaces: WorkspaceLeaseProvider, private readonly assertOwner: () => void, private readonly providers?: LocalProviderService, private readonly management?: ManagedResolver) {}
  async validate(request: SelectionRequest, configuration: SessionConfiguration): Promise<HarnessSelection> {
    this.assertOwner();
    const root = await realpath(await mkdtemp(join(tmpdir(), "harness-session-validation-")));
    try {
      const { harnessId, selected } = await observe(request, configuration, root, this.management);
      this.assertOwner();
      if (request.provider !== undefined && request.provider !== null) {
        if (!this.providers) throw new SessionError("PROVIDER_UNAVAILABLE", "Provider management is unavailable");
        if (configuration.configHome !== null) throw new SessionError("INCOMPATIBLE_CONFIGURATION", "managed Provider selection requires a private generated configuration home");
        if ((harnessId === "codex" && selected.protocol !== "codex-app-server") || (harnessId === "gemini" && selected.protocol !== "acp-v1"))
          throw new SessionError("UNSUPPORTED_PROVIDER", "this control recipe cannot use the managed Provider adapter");
        this.providers.validate(request.provider, harnessId);
      }
      return { harnessId, controlId: selected.id, ...(request.provider == null ? {} : { provider: request.provider }) };
    } finally { await rm(root, { recursive: true, force: true }); }
  }
  async prepare(selection: HarnessSelection, configuration: SessionConfiguration, session: SessionId, run: string): Promise<PreparedSessionBinding> {
    this.assertOwner();
    const lease = this.workspaces.acquire(configuration.workspace, session, run);
    let root: string | undefined, control: HarnessControl | undefined;
    try {
      root = await realpath(await mkdtemp(join(tmpdir(), "harness-session-binding-")));
      const observed = await observe(selection, configuration, root, this.management);
      if (observed.harnessId !== selection.harnessId || observed.selected.id !== selection.controlId || observed.selected.command === null)
        throw new SessionError("HARNESS_UNAVAILABLE", "the admitted control is no longer available");
      const home = await privateHome(root, configuration);
      const environment: Record<string, string> = { ...observed.selected.command.env, PATH: observed.managed?.command.env.PATH ? observed.managed.command.env.PATH + ":" + observed.searchPath : observed.searchPath, LANG: "C.UTF-8",
        HOME: home, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"),
        XDG_STATE_HOME: join(home, "state"), XDG_CACHE_HOME: join(home, "cache"),
        CODEX_HOME: join(home, "codex"), CLAUDE_CONFIG_DIR: join(home, "claude"), OPENCODE_CONFIG_DIR: join(home, "opencode"),
        OPENCODE_DISABLE_AUTOUPDATE: "true", TMPDIR: root };
      if (selection.provider !== undefined) {
        if (!this.providers) throw new SessionError("PROVIDER_UNAVAILABLE", "Provider management is unavailable");
        if (configuration.configHome !== null) throw new SessionError("INCOMPATIBLE_CONFIGURATION", "managed Provider selection requires a private generated configuration home");
        if ((selection.harnessId === "codex" && observed.selected.protocol !== "codex-app-server") || (selection.harnessId === "gemini" && observed.selected.protocol !== "acp-v1"))
          throw new SessionError("UNSUPPORTED_PROVIDER", "this control recipe cannot use the managed Provider adapter");
        Object.assign(environment, await this.providers.materialize(selection.provider, selection.harnessId, home));
      }
      const protocol = observed.selected.protocol;
      if (protocol !== "acp-v1" && protocol !== "codex-app-server") throw new SessionError("UNSUPPORTED_CONTROL", "unsupported control protocol");
      const launch: ControlLaunch = { ...observed.selected.command, env: environment, protocol };
      const options = { cwd: configuration.workspace, env: environment, requestTimeoutMs: 10000, runTimeoutMs: 30000,
        maxFrameBytes: 2 * 1024 * 1024, maxDiagnosticBytes: 64 * 1024, closeGraceMs: 500 };
      this.assertOwner(); lease.assertOwned();
      control = protocol === "acp-v1" ? new AcpControl(launch, options) : new CodexControl(launch, options);
      if (selection.provider !== undefined && this.providers) control = new RedactedHarnessControl(control, text => this.providers!.redact(text), () => this.providers!.createTextRedactor());
      return new DirectoryPreparedBinding(control, configuration.workspace, lease, root, this.assertOwner, observed.managed === null ? { source: "system" } : { source: "managed", id: observed.managed.installationId, revision: observed.managed.revision, version: observed.managed.version });
    } catch (error) {
      let cleanupError: unknown;
      let quiescent = control === undefined;
      if (control) try { await control.close(); quiescent = true; } catch (failure) { cleanupError = failure; }
      try { lease.release(quiescent); } catch (failure) { cleanupError ??= failure; }
      if (root && quiescent) try { await rm(root, { recursive: true, force: true }); } catch (failure) { cleanupError ??= failure; }
      if (cleanupError) throw new SessionError("BINDING_CLEANUP_FAILED", "binding preparation failed and cleanup could not be confirmed");
      throw error;
    }
  }
}
class DirectoryPreparedBinding implements PreparedSessionBinding {
  private closing: Promise<CleanupEvidence> | null = null;
  private closed = false;
  constructor(readonly control: HarnessControl, readonly workspace: string, private readonly lease: WorkspaceLease,
    private readonly root: string, private readonly owner: () => void, readonly installation: NonNullable<PreparedSessionBinding["installation"]>) {}
  assertOwned(): void {
    if (this.closed || this.closing !== null) throw new SessionError("BINDING_CLOSED", "binding is closing or closed");
    this.owner(); this.lease.assertOwned();
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
      try { this.lease.release(false); }
      catch { throw new SessionError("BINDING_CLEANUP_FAILED", "control and workspace lease cleanup both failed"); }
      throw error;
    }
    this.closed = true;
    this.lease.release(true);
    await rm(this.root, { recursive: true, force: true });
    return evidence;
  }
}
