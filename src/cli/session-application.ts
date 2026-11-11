import type { NativeEnvironment } from "../infrastructure/session/native-environment.js";
import { LocalHarnessManagement, type ManagementOptions } from "../infrastructure/management/service.js";
import { LocalProviderService } from "../infrastructure/provider/service.js";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync } from "node:fs";
import { totalmem } from "node:os";
import { isAbsolute, join, normalize, resolve } from "node:path";
import { resolveHostBudgets } from "../contracts/native-host.js";
import { SessionError, type SelectionRequest, type SessionEvent } from "../contracts/session.js";
import { HostTmpdirs, defaultHostTmpdirRoot } from "../infrastructure/session/host-tmpdir.js";
import { RelayKeys, insideByIdentity } from "../infrastructure/session/relay-keys.js";
import { SessionRuntime } from "../contexts/session/application/runtime.js";
import { SqliteSessionStore } from "../infrastructure/session/sqlite-store.js";
import { recoverRelay } from "../contexts/session/domain/relay/recover.js";
import { SqliteWorkspaceLeaseProvider } from "../infrastructure/session/workspace-lease.js";
import { PosixProcessGroups } from "../infrastructure/control/process-group.js";
import { DirectorySessionBindingFactory } from "../infrastructure/session/binding-factory.js";
import type { InstallationPolicy } from "../contexts/catalog/domain/catalog.js";
import { NativeInstallationLocks } from "../infrastructure/management/native-lock.js";
import { LocalContentStore } from "../infrastructure/session/content-store.js";
import { loadBuiltinCatalog } from "../adapters/catalog.js";
import { catalogTarget } from "../infrastructure/catalog/platform.js";
import { MemoryTableGrants } from "../infrastructure/session/table-grants.js";
import type { TableGrants } from "../contracts/table.js";

export function dataRoot(value: string | undefined): string {
  const path = value === undefined ? resolve("data") : resolve(value);
  if ((value !== undefined && !value.trim()) || path.length > 4096 || /[\0\r\n]/u.test(path)) throw new SessionError("INVALID_INPUT", "invalid data directory");
  return path;
}
/**
 * The installation's relay key for this composition (ADR-055 D5): opened at `path`, which must lie outside the data directory;
 * null (the Runtime then keys under a key it keeps in memory only) when it is inside it or cannot be opened, said on stderr.
 */
export function openRelayKeys(path: string, root: string): RelayKeys | null {
  try {
    if (insideByIdentity(path, root)) { process.stderr.write("HarnessGateway: RELAY_KEY_UNAVAILABLE (the relay key would lie in the data directory)\n"); return null; }
    const opened = RelayKeys.open(path);
    for (const note of opened.notes) if (note !== "created") process.stderr.write("HarnessGateway: RELAY_KEY (" + note + ")\n");
    return opened.keys;
  } catch (error) {
    process.stderr.write("HarnessGateway: RELAY_KEY_UNAVAILABLE (" + (error !== null && typeof error === "object" && "code" in error ? String(error.code).slice(0, 32) : "unreadable") + ")\n");
    return null;
  }
}
export function selection(value: string, explicitControl?: string): SelectionRequest {
  const [harnessId, embeddedControl, ...extra] = value.split(":");
  const controlId = explicitControl ?? embeddedControl;
  if (!harnessId || extra.length || (explicitControl !== undefined && embeddedControl !== undefined) ||
      !/^[a-z][a-z0-9-]{0,95}$/u.test(harnessId) ||
      (controlId !== undefined && !/^[a-z][a-z0-9-]{0,95}$/u.test(controlId))) throw new SessionError("INVALID_INPUT", "selection must be harness[:control]");
  return { harnessId, ...(controlId === undefined ? {} : { controlId }) };
}
export function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
export function newCommand(prefix = "command"): string { return prefix + "-" + randomUUID(); }
export function errorRecord(error: unknown): { readonly code: string; readonly message: string } {
  return error instanceof SessionError ? { code: error.code, message: error.message } : { code: "GATEWAY_FAILED", message: error instanceof Error ? error.message.slice(0, 512) : "gateway operation failed" };
}
/**
 * Where Gateways record which workspace each one is writing (the workspace leases), decided once here. By default it is one
 * private directory per user under /tmp that every Gateway of the user shares, so two of them never write one workspace at
 * once. An explicit directory must be a normalized absolute path: a Gateway given its own directory no longer excludes the
 * Gateways that use another one, so it is only for isolated tests or deliberately separate instances. Either way a missing
 * directory is created private, and one that is not a real directory owned by this user and closed to others is refused
 * with INVALID_STORAGE; an explicit path that is not absolute is refused with INVALID_INPUT before anything is created.
 * The host classes' TMPDIRs follow the leases (hostTmpdirRoot): Gateways share them exactly where they share leases.
 */
export function resolveWorkspaceLockRoot(explicit?: string): string {
  if (process.platform === "win32" || process.getuid === undefined) throw new SessionError("UNSUPPORTED_PLATFORM", "this session slice requires the current POSIX owner host");
  if (explicit !== undefined && (!isAbsolute(explicit) || normalize(explicit) !== explicit || explicit.length > 4096 || /[\0\r\n]/u.test(explicit)))
    throw new SessionError("INVALID_INPUT", "the workspace lock root must be a normalized absolute path");
  const uid = process.getuid(), path = explicit ?? join("/tmp", "harnessgateway-workspaces-" + uid);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o077) !== 0) throw new SessionError("INVALID_STORAGE", "workspace lock namespace is not privately owned");
  return path;
}
/**
 * Where the host classes' TMPDIRs live (ADR-056 §4.12): `harnesshub-hosts-<uid>` in the system's temporary directory beside
 * the default workspace lock namespace, and `hosts` inside an explicit one. A class's directory is emptied or deleted only
 * while no host of the class can run, which the workspace lease every host holds guarantees among the Gateways sharing
 * that lease namespace, and only among them; so the two are shared together, and a test given its own lock root keeps its
 * TMPDIRs there too. `lockRoot` is what resolveWorkspaceLockRoot returned for `explicit`.
 */
function hostTmpdirRoot(explicit: string | undefined, lockRoot: string): string {
  return explicit === undefined ? defaultHostTmpdirRoot() : join(lockRoot, "hosts");
}
export function application(root: string, publish: (event: SessionEvent) => void, options: { readonly management?: Pick<ManagementOptions, "metadata" | "installer" | "recipes" | "installationMode" | "native" | "nativeLocks" | "removal" | "officialInstaller" | "npmRegistry">; readonly nativeEnvironment?: NativeEnvironment;
  /** The Turn budgets this Gateway was configured with (ADR-036); the defaults otherwise. */
  readonly budgets?: { readonly executionBudgetMs: number; readonly waitBudgetMs: number };
  /** The workspace lock namespace, resolved by `resolveWorkspaceLockRoot`; the per-user default shared by every Gateway otherwise. */
  readonly workspaceLockRoot?: string;
  /** What counts as an installation (ADR-044): only official channels unless development explicitly allows any entry. */
  readonly installations?: InstallationPolicy;
  /**
   * The installation's relay key file (ADR-055 D5; defaultRelayKeyPath for the Gateway's own entries), opened here; without it
   * (or when it cannot be opened) the Runtime keys relay rows under a key it keeps in memory only.
   */
  readonly relayKeyFile?: string;
  /** The context table's tokens (src/contracts/table.ts): the instance whoever starts native processes mints from and the web server resolves with; a private in-memory one when not given. */
  readonly tableGrants?: TableGrants } = {}): { readonly management: LocalHarnessManagement; readonly providers: LocalProviderService; readonly store: SqliteSessionStore; readonly content: LocalContentStore; readonly factory: DirectorySessionBindingFactory; readonly runtime: SessionRuntime; readonly grants: TableGrants } {
  // Recovery decides the relay deliveries a previous owner left in flight, per Session in its own SAVEPOINT (ADR-055 §9 S15).
  const store = new SqliteSessionStore(root, { recoverRelay });
  let providers: LocalProviderService | undefined;
  let management: LocalHarnessManagement | undefined;
  try {
    const lockRoot = resolveWorkspaceLockRoot(options.workspaceLockRoot);
    const workspaces = new SqliteWorkspaceLeaseProvider(lockRoot);
    providers = new LocalProviderService(root, () => store.assertOwner());
    const nativeLocks = options.management?.installationMode === "private-fixture" ? undefined : options.management?.nativeLocks ?? new NativeInstallationLocks();
    management = new LocalHarnessManagement(root, { ...options.management, ...(nativeLocks === undefined ? {} : { nativeLocks }), ...(options.nativeEnvironment === undefined ? {} : { nativeEnvironment: options.nativeEnvironment }), assertOwner: () => store.assertOwner(), ownerGeneration: store.ownerGeneration, redactor: text => providers!.redact(text) });
    // The host budgets (ADR-056) are resolved once here; what the classes' TMPDIRs cannot remove goes to the service log.
    // The runtime's close ends the factory's last, which bounds the removal of what was moved aside (closeWaitMs).
    const hostBudgets = resolveHostBudgets({ physicalMemoryBytes: totalmem() });
    const tmpdirs = new HostTmpdirs(hostTmpdirRoot(options.workspaceLockRoot, lockRoot), { maxBytes: hostBudgets.hostTmpdirMaxBytes, maxEntries: hostBudgets.hostTmpdirMaxEntries,
      unusedMs: hostBudgets.hostTmpdirUnusedMs, closeWaitMs: hostBudgets.hostTmpdirCloseWaitMs, dataRoot: root,
      report: problem => { process.stderr.write("HarnessGateway: HOST_TMPDIR (" + problem + ")\n"); } });
    // Starting, before any Turn: class directories unused for a week go (ADR-056 §4.12), unless a host of another Gateway
    // sharing the namespace is live; what is moved aside is removed in the background.
    tmpdirs.sweep();
    const factory = new DirectorySessionBindingFactory(workspaces, () => store.assertOwner(), options.installations ?? "official", providers, management, options.nativeEnvironment, nativeLocks, { budgets: hostBudgets, tmpdirs });
    // The owner is exclusive and quiescent here, so unreferenced content from earlier owners can be collected safely.
    const content = new LocalContentStore(root, () => store.assertOwner());
    content.collect(store.contentReferences());
    // Kept process groups are recognized across restarts on POSIX only; elsewhere a previous owner's kept process stays
    // unconfirmed and its workspace quarantined (ADR-030).
    // The relay names a Harness by its catalog name (ADR-055 §5.4); the built-in catalog is read once, at the first packet.
    // A catalog that cannot be read leaves every Harness named by its id; a name is never worth failing a Turn.
    let names: ReadonlyMap<string, string> | undefined;
    const harnessName = (harnessId: string): string | null => {
      if (names === undefined) { try { names = new Map(loadBuiltinCatalog(catalogTarget()).map(definition => [definition.id, definition.name])); } catch { names = new Map(); } }
      return names.get(harnessId) ?? null;
    };
    // The relay's installation key (ADR-055 §10.2, INV-36).
    const relayKeys = options.relayKeyFile === undefined ? null : openRelayKeys(options.relayKeyFile, root);
    const runtime = new SessionRuntime(store, factory, { id: randomUUID, now: () => new Date(), fingerprint: hash, publish, content, harnessName, ...(options.budgets ?? {}),
      ...(relayKeys === null ? {} : { relayKeys }),
      ...(process.platform === "win32" ? {} : { processes: new PosixProcessGroups() }) });
    // Upgrades see and close this runtime's conversations' processes (ADR-043).
    management.attachProgramUsers({ list: harnessId => runtime.programUsers(harnessId), closeIdle: harnessId => runtime.releaseForUpgrade(harnessId) });
    return { store, content, factory, runtime, providers, management, grants: options.tableGrants ?? new MemoryTableGrants() };
  } catch (error) { try { management?.close(); } finally { try { providers?.close(); } finally { store.close(); } } throw error; }
}
