import { CONTEXT_DIR, ContextFiles } from "../web/context-files.js";
import type { NativeEnvironment } from "../infrastructure/session/native-environment.js";
import { LocalHarnessManagement, type ManagementOptions } from "../infrastructure/management/service.js";
import { LocalProviderService } from "../infrastructure/provider/service.js";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync } from "node:fs";
import { totalmem } from "node:os";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { resolveHostBudgets } from "../contracts/native-host.js";
import type { ConversationCommit } from "../contracts/conversation.js";
import { SessionError, type SelectionRequest, type TurnLimits } from "../contracts/session.js";
import { HostTmpdirs, defaultHostTmpdirRoot } from "../infrastructure/session/host-tmpdir.js";
import { RelayKeys, insideByIdentity } from "../infrastructure/session/relay-keys.js";
import { SessionRuntime } from "../contexts/session/application/runtime.js";
import { FileConversationStore } from "../infrastructure/session/file-store.js";
import { recoverConversation } from "../contexts/session/domain/conversation-state.js";
import { recoverConversationRelay } from "../contexts/session/domain/relay/recover.js";
import { SqliteWorkspaceLeaseProvider } from "../infrastructure/session/workspace-lease.js";
import { PosixProcessGroups } from "../infrastructure/control/process-group.js";
import { DirectorySessionBindingFactory } from "../infrastructure/session/binding-factory.js";
import type { InstallationPolicy } from "../contexts/catalog/domain/catalog.js";
import { NativeInstallationLocks } from "../infrastructure/management/native-lock.js";
import { LocalContentStore } from "../infrastructure/session/content-store.js";
import type { TableMount } from "../infrastructure/table/mount.js";
import { loadBuiltinCatalog } from "../adapters/catalog.js";
import { catalogTarget } from "../infrastructure/catalog/platform.js";
import { MemoryTableGrants } from "../infrastructure/session/table-grants.js";
import type { TableGrants } from "../contracts/table.js";
import { reasonOf, storageCause } from "./startup-failure.js";
import { WorkspaceRecorder } from "../infrastructure/workspace/recorder.js";
import { flavorOf } from "../adapters/flavors/index.js";

/**
 * A Harness's display name by its id: its name in the built-in catalog ("Claude Code", "DeepSeek Harness", "Hermes Agent"), read once at the
 * first ask. The Runtime's relay packets and the web view's protocol Turns both name Harnesses by it. A catalog that cannot be read leaves
 * every Harness named by its id (null here): a name is never worth failing a Turn.
 */
export function builtinHarnessName(): (harnessId: string) => string | null {
  let names: ReadonlyMap<string, string> | undefined;
  return harnessId => {
    if (names === undefined) { try { names = new Map(loadBuiltinCatalog(catalogTarget()).map(definition => [definition.id, definition.name])); } catch { names = new Map(); } }
    return names.get(harnessId) ?? null;
  };
}
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
/**
 * The operator's level for opening a new native session in the place of a nearly full one (HARNESSHUB_RESEAT_AT in the Gateway's own environment): a share of the
 * window between 0 and 1, or `off`. Unset, or anything else: none, which is never.
 */
export function reseatSetting(value: string | undefined): { readonly reseatAt?: number | null } {
  if (value === undefined || value.trim() === "") return {};
  if (value.trim().toLowerCase() === "off") return { reseatAt: null };
  const share = Number(value);
  return Number.isFinite(share) && share > 0 && share <= 1 ? { reseatAt: share } : {};
}
export function newCommand(prefix = "command"): string { return prefix + "-" + randomUUID(); }
export function errorRecord(error: unknown): { readonly code: string; readonly message: string } {
  // A failure of the storage is told with what it was made of (a table, a column, a rule: startup-failure.ts), not with its code alone.
  if (error instanceof SessionError) { const cause = storageCause(error); return { code: error.code, message: cause === null ? error.message : error.message + " (" + cause + ")" }; }
  return { code: "GATEWAY_FAILED", message: error instanceof Error ? (reasonOf(error) ?? "gateway operation failed").slice(0, 512) : "gateway operation failed" };
}
/** What is said of the workspace lock root before anything is looked at or made: the platform, and an explicit root's shape. */
function lockRootShape(explicit?: string): void {
  if (process.platform === "win32" || process.getuid === undefined) throw new SessionError("UNSUPPORTED_PLATFORM", "this session slice requires the current POSIX owner host");
  if (explicit !== undefined && (!isAbsolute(explicit) || normalize(explicit) !== explicit || explicit.length > 4096 || /[\0\r\n]/u.test(explicit)))
    throw new SessionError("INVALID_INPUT", "the workspace lock root must be a normalized absolute path");
}
/** Whether an explicit lock root lies in the data directory: the one root that cannot be made before the data directory is (the Turn refuses it, HOST_TMPDIR_FAILED). */
function insideData(explicit: string | undefined, root: string): boolean {
  if (explicit === undefined) return false;
  const path = relative(resolve(root), resolve(explicit));
  return path !== "" && path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path);
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
  lockRootShape(explicit);
  const uid = process.getuid!(), path = explicit ?? join("/tmp", "harnessgateway-workspaces-" + uid);
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
export function application(root: string, publish: (commit: ConversationCommit) => void, options: { readonly management?: Pick<ManagementOptions, "metadata" | "installer" | "recipes" | "installationMode" | "native" | "nativeLocks" | "removal" | "officialInstaller" | "npmRegistry">; readonly nativeEnvironment?: NativeEnvironment;
  /** The optional limits this Gateway was configured with (execution and wait budgets, conversations at once); none otherwise. */
  readonly budgets?: TurnLimits;
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
  readonly tableGrants?: TableGrants;
  /** The context table's mount (docs/decisions/LOG.md, 2026-11-11): the native processes the Sessions start carry its address and a token each. None: they carry neither. */
  readonly table?: TableMount } = {}): { readonly management: LocalHarnessManagement; readonly providers: LocalProviderService; readonly store: FileConversationStore; readonly content: LocalContentStore; readonly factory: DirectorySessionBindingFactory; readonly runtime: SessionRuntime; readonly grants: TableGrants } {
  // What needs no ownership of the data directory is settled first: the workspace lock root (its shape, its owner and its mode) and the lease provider on it.
  lockRootShape(options.workspaceLockRoot);
  let lockRoot = insideData(options.workspaceLockRoot, root) ? undefined : resolveWorkspaceLockRoot(options.workspaceLockRoot);
  let workspaces = lockRoot === undefined ? undefined : new SqliteWorkspaceLeaseProvider(lockRoot);
  // Opening the root takes its ownership and recovers what a previous owner left unfinished with the domain's recovery (a WIP log laid over its file, the Turns whose result is
  // unknown told so, nothing run again); the relay deliveries it left in flight are decided per conversation (ADR-055 §9 S15). Each conversation is one file (file-store.ts).
  const store = new FileConversationStore(root, { recover: recoverConversation, recoverRelay: recoverConversationRelay });
  let providers: LocalProviderService | undefined;
  let management: LocalHarnessManagement | undefined;
  try {
    // A lock root inside the data directory is made when the data directory is (the Turns refuse it, as they always did).
    lockRoot ??= resolveWorkspaceLockRoot(options.workspaceLockRoot);
    workspaces ??= new SqliteWorkspaceLeaseProvider(lockRoot);
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
    const factory = new DirectorySessionBindingFactory(workspaces, () => store.assertOwner(), options.installations ?? "official", providers, management, options.nativeEnvironment, nativeLocks,
      { budgets: hostBudgets, tmpdirs, ...(options.table === undefined ? {} : { table: options.table }) });
    // Content is not collected by itself any more (a cleaning command is for later): what the conversations do not mention stays.
    const content = new LocalContentStore(root, () => store.assertOwner());
    // Kept process groups are recognized across restarts on POSIX only; elsewhere a previous owner's kept process stays
    // unconfirmed and its workspace quarantined (ADR-030).
    // The relay names a Harness by its catalog name (ADR-055 §5.4); the built-in catalog is read once, at the first packet.
    const harnessName = builtinHarnessName();
    // The relay's installation key (ADR-055 §10.2, INV-36).
    const relayKeys = options.relayKeyFile === undefined ? null : openRelayKeys(options.relayKeyFile, root);
    // The record as a directory (2026-11-13): what a Harness that reads the record as files is pointed at, kept under the data root and brought up to the record before each Turn.
    const context = new ContextFiles({ root: join(root, CONTEXT_DIR), reader: store, content, name: harnessName, board: id => runtime.taskBoard(id), changes: id => runtime.recordSignals(id),
      secrets: (configuration, harnessIds) => factory.relaySecrets === undefined ? Promise.resolve([]) : factory.relaySecrets(configuration, harnessIds) });
    const runtime: SessionRuntime = new SessionRuntime(store, factory, { id: randomUUID, now: () => new Date(), fingerprint: hash, publish, content, harnessName, workspace: new WorkspaceRecorder(), flavor: flavorOf, ...(options.budgets ?? {}),
      context: { place: id => context.place(id), ensure: id => context.ensure(id), refresh: id => context.refresh(id), forget: (id, purging) => context.forget(id, purging),
        state: (id, upTo, record, scope, words) => context.state(id, upTo ?? undefined, record, scope, words === null ? "none" : words) },
      ...reseatSetting(process.env.HARNESSHUB_RESEAT_AT),
      ...(relayKeys === null ? {} : { relayKeys }),
      ...(process.platform === "win32" ? {} : { processes: new PosixProcessGroups() }) });
    // Upgrades see and close this runtime's conversations' processes (ADR-043).
    management.attachProgramUsers({ list: harnessId => runtime.programUsers(harnessId), closeIdle: harnessId => runtime.releaseForUpgrade(harnessId) });
    return { store, content, factory, runtime, providers, management, grants: options.tableGrants ?? options.table?.grants ?? new MemoryTableGrants() };
  } catch (error) { try { management?.close(); } finally { try { providers?.close(); } finally { store.close(); } } throw error; }
}
