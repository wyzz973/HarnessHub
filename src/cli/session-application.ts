import { LocalHarnessManagement, type ManagementOptions } from "../infrastructure/management/service.js";
import { LocalProviderService } from "../infrastructure/provider/service.js";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { SessionError, type SelectionRequest, type SessionEvent } from "../contracts/session.js";
import { SessionRuntime } from "../contexts/session/application/runtime.js";
import { SqliteSessionStore } from "../infrastructure/session/sqlite-store.js";
import { SqliteWorkspaceLeaseProvider } from "../infrastructure/session/workspace-lease.js";
import { DirectorySessionBindingFactory } from "../infrastructure/session/binding-factory.js";

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
function workspaceLockRoot(): string {
  if (process.platform === "win32" || process.getuid === undefined) throw new SessionError("UNSUPPORTED_PLATFORM", "this session slice requires the current POSIX owner host");
  const uid = process.getuid(), path = join("/tmp", "harnessgateway-workspaces-" + uid);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o077) !== 0) throw new SessionError("INVALID_STORAGE", "workspace lock namespace is not privately owned");
  return path;
}
export function application(root: string, publish: (event: SessionEvent) => void, options: { readonly management?: Pick<ManagementOptions, "metadata" | "installer" | "recipes"> } = {}): { readonly management: LocalHarnessManagement; readonly providers: LocalProviderService; readonly store: SqliteSessionStore; readonly factory: DirectorySessionBindingFactory; readonly runtime: SessionRuntime } {
  const store = new SqliteSessionStore(root);
  let providers: LocalProviderService | undefined;
  let management: LocalHarnessManagement | undefined;
  try {
    const workspaces = new SqliteWorkspaceLeaseProvider(workspaceLockRoot());
    providers = new LocalProviderService(root, () => store.assertOwner());
    management = new LocalHarnessManagement(root, { ...options.management, assertOwner: () => store.assertOwner(), ownerGeneration: store.ownerGeneration, redactor: text => providers!.redact(text) });
    const factory = new DirectorySessionBindingFactory(workspaces, () => store.assertOwner(), providers, management);
    const runtime = new SessionRuntime(store, factory, { id: randomUUID, now: () => new Date(), fingerprint: hash, publish });
    return { store, factory, runtime, providers, management };
  } catch (error) { try { management?.close(); } finally { try { providers?.close(); } finally { store.close(); } } throw error; }
}
