import type { NativeEnvironment } from "../infrastructure/session/native-environment.js";
import { LocalHarnessManagement, type ManagementOptions } from "../infrastructure/management/service.js";
import { LocalProviderService } from "../infrastructure/provider/service.js";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, opendirSync, realpathSync, statSync, type Dir } from "node:fs";
import { totalmem } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { resolveHostBudgets } from "../contracts/native-host.js";
import { SessionError, type SelectionRequest, type SessionEvent } from "../contracts/session.js";
import { HostTmpdirs, defaultHostTmpdirRoot } from "../infrastructure/session/host-tmpdir.js";
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

export function dataRoot(value: string | undefined): string {
  const path = value === undefined ? resolve("data") : resolve(value);
  if ((value !== undefined && !value.trim()) || path.length > 4096 || /[\0\r\n]/u.test(path)) throw new SessionError("INVALID_INPUT", "invalid data directory");
  return path;
}
/** The ownership marker every data directory holds (sqlite-store.ts), searched for in a workspace within these bounds. */
const DATA_MARKER = ".harness-gateway.json", MARKER_DEPTH = 6, MARKER_ENTRIES = 2000, MARKER_MS = 100;
/**
 * Where a data directory lies relative to a workspace (ADR-055 §10.1): whether one contains the other, compared by device
 * and inode along each one's parent directories and never by spelling (case-insensitive volumes, symbolic links and
 * firmlinks spell one directory several ways), the data directory's parents both as it resolves and as it is spelled (a
 * link in the workspace that leads to it puts it in the workspace's reach); and the workspace directories holding a data
 * directory's ownership marker (a copy left behind when the data was moved), found within 6 levels, 2,000 entries and
 * 100 ms, however large one directory is, where a symbolic link is looked at (a marker it names, or one in the directory it
 * leads to) but never entered. Paths are relative to the workspace: what a workspace observation leaves out, with `.tmp`.
 * Read-only; what cannot be read proves nothing.
 */
export interface DataRootPlacement {
  readonly containment: "separate" | "data_root_in_workspace" | "workspace_in_data_root";
  readonly markers: readonly string[];
}
export function dataRootPlacement(root: string, workspace: string): DataRootPlacement {
  const identity = (path: string) => { const info = statSync(path, { bigint: true }); return info.dev + ":" + info.ino; };
  const within = (path: string, ancestor: string): boolean => {
    for (let current = path; ; current = dirname(current)) {
      if (identity(current) === ancestor) return true;
      if (dirname(current) === current) return false;
    }
  };
  const isFile = (path: string): boolean => { try { return statSync(path).isFile(); } catch { return false; } };
  let place: string, containment: DataRootPlacement["containment"];
  try {
    const data = realpathSync(root), spelled = resolve(root); place = realpathSync(workspace);
    const workspaceIdentity = identity(place);
    containment = within(data, workspaceIdentity) || spelled !== data && within(spelled, workspaceIdentity) ? "data_root_in_workspace"
      : within(place, identity(data)) ? "workspace_in_data_root" : "separate";
  } catch { return { containment: "separate", markers: [] }; }
  const markers: string[] = [], deadline = performance.now() + MARKER_MS, pending: { readonly path: string; readonly depth: number }[] = [{ path: place, depth: 0 }];
  let entries = 0;
  while (pending.length && entries < MARKER_ENTRIES && performance.now() < deadline) {
    const { path, depth } = pending.shift()!;
    let directory: Dir;
    try { directory = opendirSync(path); } catch { continue; }
    try {
      // One entry at a time, so a single large directory is held to the same bounds.
      for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) {
        if (++entries > MARKER_ENTRIES || performance.now() >= deadline) break;
        const at = join(path, entry.name);
        // A symbolic link is looked at but not followed into, so the search stays in the workspace.
        if (entry.isSymbolicLink()) { if (entry.name === DATA_MARKER ? isFile(at) : isFile(join(at, DATA_MARKER))) markers.push(relative(place, entry.name === DATA_MARKER ? path : at) || "."); }
        else if (entry.isFile() && entry.name === DATA_MARKER) markers.push(relative(place, path) || ".");
        else if (entry.isDirectory() && depth < MARKER_DEPTH) pending.push({ path: at, depth: depth + 1 });
      }
    } catch { /* A directory that cannot be read further proves nothing. */ } finally { directory.closeSync(); }
  }
  return { containment, markers };
}
/** The startup warning for a data directory a workspace's Harnesses can read (ADR-055 §10.1, D8); null when there is none. */
export function dataRootWarning(placement: DataRootPlacement): string | null {
  if (placement.containment === "data_root_in_workspace") return "数据目录在工作区里，工作区里的 Harness 能直接读到全部对话（含其他 Harness 的内容）；请用 --data-dir 把数据目录放到工作区外。";
  if (placement.containment === "workspace_in_data_root") return "工作区在数据目录里，Harness 在工作区里的读写都落在 HarnessGateway 的数据目录中；请用 --data-dir 把数据目录换成工作区之外的独立目录。";
  if (placement.markers.length) return "工作区里有 HarnessGateway 的数据目录（" + placement.markers.slice(0, 4).map(path => path === "." ? "." : "./" + path).join("、") + (placement.markers.length > 4 ? " 等" : "") + "），工作区里的 Harness 能读到它们；数据目录应放在工作区外。";
  return null;
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
  readonly installations?: InstallationPolicy } = {}): { readonly management: LocalHarnessManagement; readonly providers: LocalProviderService; readonly store: SqliteSessionStore; readonly content: LocalContentStore; readonly factory: DirectorySessionBindingFactory; readonly runtime: SessionRuntime } {
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
    const runtime = new SessionRuntime(store, factory, { id: randomUUID, now: () => new Date(), fingerprint: hash, publish, content, harnessName, ...(options.budgets ?? {}),
      ...(process.platform === "win32" ? {} : { processes: new PosixProcessGroups() }) });
    // Upgrades see and close this runtime's conversations' processes (ADR-043).
    management.attachProgramUsers({ list: harnessId => runtime.programUsers(harnessId), closeIdle: harnessId => runtime.releaseForUpgrade(harnessId) });
    return { store, content, factory, runtime, providers, management };
  } catch (error) { try { management?.close(); } finally { try { providers?.close(); } finally { store.close(); } } throw error; }
}
