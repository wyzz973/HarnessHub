import type { NativeEnvironment } from "../infrastructure/session/native-environment.js";
import { LocalHarnessManagement, type ManagementOptions } from "../infrastructure/management/service.js";
import { LocalProviderService } from "../infrastructure/provider/service.js";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync } from "node:fs";
import { isAbsolute, join, normalize, resolve } from "node:path";
import { SessionError, type SelectionRequest, type SessionEvent } from "../contracts/session.js";
import { SessionRuntime } from "../contexts/session/application/runtime.js";
import { SqliteSessionStore } from "../infrastructure/session/sqlite-store.js";
import { SqliteWorkspaceLeaseProvider } from "../infrastructure/session/workspace-lease.js";
import { PosixProcessGroups } from "../infrastructure/control/process-group.js";
import { DirectorySessionBindingFactory } from "../infrastructure/session/binding-factory.js";
import type { InstallationPolicy } from "../contexts/catalog/domain/catalog.js";
import { NativeInstallationLocks } from "../infrastructure/management/native-lock.js";
import { LocalContentStore } from "../infrastructure/session/content-store.js";

export function dataRoot(value: string | undefined): string {
  const path = value === undefined ? resolve("data") : resolve(value);
  if ((value !== undefined && !value.trim()) || path.length > 4096 || /[\0\r\n]/u.test(path)) throw new SessionError("INVALID_INPUT", "invalid data directory");
  return path;
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
export function application(root: string, publish: (event: SessionEvent) => void, options: { readonly management?: Pick<ManagementOptions, "metadata" | "installer" | "recipes" | "installationMode" | "native" | "nativeLocks">; readonly nativeEnvironment?: NativeEnvironment;
  /** The Turn budgets this Gateway was configured with (ADR-036); the defaults otherwise. */
  readonly budgets?: { readonly executionBudgetMs: number; readonly waitBudgetMs: number };
  /** The workspace lock namespace, resolved by `resolveWorkspaceLockRoot`; the per-user default shared by every Gateway otherwise. */
  readonly workspaceLockRoot?: string;
  /** What counts as an installation (ADR-044): only official channels unless development explicitly allows any entry. */
  readonly installations?: InstallationPolicy } = {}): { readonly management: LocalHarnessManagement; readonly providers: LocalProviderService; readonly store: SqliteSessionStore; readonly content: LocalContentStore; readonly factory: DirectorySessionBindingFactory; readonly runtime: SessionRuntime } {
  const store = new SqliteSessionStore(root);
  let providers: LocalProviderService | undefined;
  let management: LocalHarnessManagement | undefined;
  try {
    const workspaces = new SqliteWorkspaceLeaseProvider(resolveWorkspaceLockRoot(options.workspaceLockRoot));
    providers = new LocalProviderService(root, () => store.assertOwner());
    const nativeLocks = options.management?.installationMode === "private-fixture" ? undefined : options.management?.nativeLocks ?? new NativeInstallationLocks();
    management = new LocalHarnessManagement(root, { ...options.management, ...(nativeLocks === undefined ? {} : { nativeLocks }), ...(options.nativeEnvironment === undefined ? {} : { nativeEnvironment: options.nativeEnvironment }), assertOwner: () => store.assertOwner(), ownerGeneration: store.ownerGeneration, redactor: text => providers!.redact(text) });
    const factory = new DirectorySessionBindingFactory(workspaces, () => store.assertOwner(), options.installations ?? "official", providers, management, options.nativeEnvironment, nativeLocks);
    // The owner is exclusive and quiescent here, so unreferenced content from earlier owners can be collected safely.
    const content = new LocalContentStore(root, () => store.assertOwner());
    content.collect(store.contentReferences());
    // Kept process groups are recognized across restarts on POSIX only; elsewhere a previous owner's kept process stays
    // unconfirmed and its workspace quarantined (ADR-030).
    const runtime = new SessionRuntime(store, factory, { id: randomUUID, now: () => new Date(), fingerprint: hash, publish, content, ...(options.budgets ?? {}),
      ...(process.platform === "win32" ? {} : { processes: new PosixProcessGroups() }) });
    // Upgrades see and close this runtime's conversations' processes (ADR-043).
    management.attachProgramUsers({ list: harnessId => runtime.programUsers(harnessId), closeIdle: harnessId => runtime.releaseForUpgrade(harnessId) });
    return { store, content, factory, runtime, providers, management };
  } catch (error) { try { management?.close(); } finally { try { providers?.close(); } finally { store.close(); } } throw error; }
}
