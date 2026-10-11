import type { ProviderTarget } from "./provider.js";
import type { BackendResult, CleanupEvidence, ControlEvent, HarnessControl, NativeOptions } from "./control.js";

declare const sessionBrand: unique symbol;
declare const runBrand: unique symbol;
declare const messageBrand: unique symbol;
declare const switchBrand: unique symbol;
declare const commandBrand: unique symbol;
export type SessionId = string & { readonly [sessionBrand]: true };
export type RunId = string & { readonly [runBrand]: true };
export type MessageId = string & { readonly [messageBrand]: true };
export type SwitchId = string & { readonly [switchBrand]: true };
export type CommandId = string & { readonly [commandBrand]: true };
function identity(value: unknown, prefix: string): string {
  if (typeof value !== "string" || !new RegExp("^" + prefix + "-[a-zA-Z0-9-]{1,96}$", "u").test(value)) throw new SessionError("INVALID_INPUT", "invalid " + prefix + " identity");
  return value;
}
export function sessionId(value: unknown): SessionId { return identity(value, "session") as SessionId; }
export function runId(value: unknown): RunId { return identity(value, "run") as RunId; }
export function messageId(value: unknown): MessageId { return identity(value, "message") as MessageId; }
export function switchId(value: unknown): SwitchId { return identity(value, "switch") as SwitchId; }
export function commandId(value: unknown): CommandId {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) throw new SessionError("INVALID_INPUT", "invalid command identity");
  return value as CommandId;
}
export class SessionError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "SessionError"; }
}
/** Native enum overrides only; unknown keys/values are rejected by the selected Driver before dispatch. */
export function parseNativeOptions(value: unknown): NativeOptions {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new SessionError("INVALID_INPUT", "native options must be an object");
  const entries = Object.entries(value);
  if (entries.length > 64 || entries.some(([key, item]) => !/^[a-zA-Z0-9_-]{1,128}$/u.test(key) || ["__proto__", "constructor", "prototype"].includes(key) || typeof item !== "string" || !item || item.length > 1024 || /[\0\r\n]/u.test(item))) throw new SessionError("INVALID_INPUT", "invalid native option identity or value");
  return Object.fromEntries(entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}
export interface HarnessSelection { readonly harnessId: string; readonly controlId: string; readonly provider?: ProviderTarget; readonly nativeModel?: string; readonly nativeOptions?: NativeOptions }
export interface SelectionRequest { readonly harnessId: string; readonly controlId?: string; readonly provider?: ProviderTarget | null; readonly nativeModel?: string; readonly nativeOptions?: NativeOptions }
export interface SessionConfiguration {
  readonly workspace: string;
  readonly manifestPath: string | null;
  readonly manifestSha256: string | null;
  readonly configHome: string | null;
  readonly packageRoots: readonly string[];
  readonly searchDirs: readonly string[];
  readonly pathOnly: boolean;
}
export type RunStatus = "queued" | "preparing" | "running" | "settling" | "completed" | "cancelled" | "failed" | "unknown";
export interface PublicMessage {
  readonly id: MessageId;
  readonly runId: RunId;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly seq: number;
  readonly status: RunStatus;
}
export interface PublicRun {
  readonly id: RunId;
  readonly commandId: CommandId;
  readonly input: string;
  readonly userMessageId: MessageId;
  readonly assistantMessageId: MessageId;
  readonly selection: HarnessSelection;
  readonly epoch: number;
  readonly status: RunStatus;
  readonly cancelRequested: boolean;
  readonly contextThroughSeq: number;
  readonly sourceRunIds: readonly RunId[];
  readonly backend: BackendResult | null;
  readonly cleanup: CleanupEvidence | null;
  readonly error: { readonly code: string; readonly message: string } | null;
  readonly thinking?: string;
  readonly tools?: readonly { readonly id: string; readonly title: string; readonly status: string }[];
  readonly stopRequested: boolean;
  readonly awaitingSwitchId: SwitchId | null;
}
export interface PublicSwitch {
  readonly id: SwitchId;
  readonly commandId: CommandId;
  readonly requested: SelectionRequest;
  readonly requestedSeq: number;
  readonly target: HarnessSelection | null;
  readonly status: "requested" | "validated" | "effective" | "failed";
  readonly throughSeq: number;
  readonly sourceRunIds: readonly RunId[];
  readonly error: { readonly code: string; readonly message: string } | null;
}
export interface CommandRecord {
  readonly id: CommandId;
  readonly kind: "create" | "send" | "switch" | "cancel" | "close" | "permission";
  readonly fingerprint: string;
  readonly resultId: string;
}
export interface SessionSnapshot {
  readonly schemaVersion: 1 | 2 | 3 | 4 | 5;
  readonly id: SessionId;
  readonly version: number;
  readonly lastSeq: number;
  readonly epoch: number;
  readonly status: "open" | "closed" | "blocked";
  readonly configuration: SessionConfiguration;
  readonly selection: HarnessSelection;
  readonly activeRunId: RunId | null;
  readonly pendingSwitchId: SwitchId | null;
  readonly runs: readonly PublicRun[];
  readonly messages: readonly PublicMessage[];
  readonly switches: readonly PublicSwitch[];
  readonly commands: readonly CommandRecord[];
}
export interface EventDraft { readonly type: string; readonly data: Readonly<Record<string, unknown>> }
export interface SessionEvent extends EventDraft {
  readonly sessionId: SessionId;
  readonly seq: number;
  readonly ownerGeneration: number;
  readonly timestamp: string;
}
export interface SessionMutation { readonly next: SessionSnapshot; readonly events: readonly EventDraft[] }
export interface SessionCommit { readonly session: SessionSnapshot; readonly events: readonly SessionEvent[] }
/** Aggregate-scoped synchronous transaction boundary. Callbacks cannot return promises. */
export interface SessionStore {
  readonly ownerGeneration: number;
  assertOwner(): void;
  create(snapshot: SessionSnapshot, events: readonly EventDraft[]): SessionCommit;
  get(id: SessionId): SessionSnapshot;
  findByCreateKey(key: CommandId): SessionSnapshot | null;
  list(limit?: number): readonly SessionSnapshot[];
  transact(id: SessionId, expectedVersion: number, mutate: (current: SessionSnapshot) => SessionMutation): SessionCommit;
  events(id: SessionId, afterSeq: number, limit?: number): readonly SessionEvent[];
  close(): void;
}
export interface WorkspaceLease { assertOwned(): void; release(quiescent: boolean): void }
export interface WorkspaceLeaseProvider { acquire(workspace: string, session: SessionId, run: string): WorkspaceLease }
/** Per-Turn owner; close also releases the workspace lease and only its own private directories. */
export interface PreparedSessionBinding {
  readonly installation?: { readonly source: "system" } | { readonly source: "managed"; readonly id: string; readonly revision: number; readonly version: string };
  readonly control: HarnessControl;
  readonly workspace: string;
  assertOwned(): void;
  close(): Promise<CleanupEvidence>;
}
export interface SessionBindingFactory {
  validate(selection: SelectionRequest, configuration: SessionConfiguration): Promise<HarnessSelection>;
  prepare(selection: HarnessSelection, configuration: SessionConfiguration, session: SessionId, run: string): Promise<PreparedSessionBinding>;
}
export interface SessionRuntimeOptions {
  readonly id: () => string;
  readonly now: () => Date;
  readonly publish: (event: SessionEvent) => void;
  readonly fingerprint: (value: string) => string;
}
export interface SendReceipt { readonly sessionId: SessionId; readonly runId: RunId; readonly replayed: boolean }
export interface SwitchReceipt { readonly sessionId: SessionId; readonly switchId: SwitchId; readonly replayed: boolean }
export interface CancelReceipt { readonly sessionId: SessionId; readonly target: RunId | null; readonly replayed: boolean }
export interface PermissionRequest {
  readonly id: string;
  readonly runId: string;
  readonly title: string;
  readonly options: readonly { readonly id: string; readonly name: string }[];
  readonly detail?: string;
  readonly input?: {readonly kind:"text"|"editor";readonly value:string};
  readonly decided: boolean;
}
export type PersistedControlEvent = ControlEvent;
