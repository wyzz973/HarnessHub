import type { ControlProtocol } from "../contexts/catalog/domain/discovery.js";
import type { ResolvedCommand } from "../contexts/catalog/domain/catalog.js";
import type { ContentRef, ControlAttachment } from "./content.js";

declare const nativeConversationBrand: unique symbol;
export type NativeConversationId = string & { readonly [nativeConversationBrand]: true };
export function nativeConversationId(value: unknown): NativeConversationId {
  if (typeof value !== "string" || !value || value.length > 512 || /[\0\r\n]/u.test(value))
    throw new Error("invalid native conversation identity");
  return value as NativeConversationId;
}
export interface ControlLaunch extends ResolvedCommand {
  readonly protocol: "acp-v1" | "codex-app-server" | "pi-rpc";
}
export interface ControlOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly requestTimeoutMs: number;
  readonly runTimeoutMs: number;
  readonly maxFrameBytes: number;
  readonly maxDiagnosticBytes: number;
  readonly closeGraceMs: number;
  /** Cumulative inbound+outbound bytes for one connection; defaults to the native-turn budget. */
  readonly maxWireBytes?: number;
}
export interface ProtocolObservation {
  readonly protocol: ControlProtocol;
  readonly protocolVersion: number | null;
  readonly agentName: string | null;
  readonly agentVersion: string | null;
  readonly authenticationMethods: readonly string[];
  readonly capabilities: Readonly<Record<string, unknown>>;
}
/** Bounded native tool facts. Drivers trim previews; complete payloads never leave the Driver unbounded. */
export interface NativeToolDetail {
  /** Native tool family (execute/edit/read/search/fetch/think/mcp/subagent/image/...). */
  readonly kind?: string;
  /** Native tool name, e.g. Bash or server/tool. */
  readonly name?: string;
  readonly input?: string;
  readonly output?: string;
  /** Unified diff text for file changes. */
  readonly diff?: string;
  readonly locations?: readonly string[];
  readonly exitCode?: number;
  /** Owning parent tool or sub-agent identity inside the same Turn. */
  readonly parentId?: string;
  /** A preview was cut to its byte budget. */
  readonly truncated?: boolean;
}
export const TOOL_INPUT_BYTES = 16 * 1024;
export const TOOL_OUTPUT_BYTES = 64 * 1024;
export const TOOL_DIFF_BYTES = 64 * 1024;
export interface NativePlanEntry { readonly content: string; readonly status: "pending" | "in_progress" | "completed"; readonly priority?: "high" | "medium" | "low" }
/** Latest native accounting. Turn tokens belong to this Run; context and cost carry their own scope. */
export interface NativeUsage {
  readonly turn?: { readonly input?: number; readonly output?: number; readonly cachedInput?: number; readonly cacheWrite?: number; readonly reasoning?: number; readonly total?: number };
  readonly context?: { readonly used: number; readonly size?: number };
  readonly cost?: { readonly amount: number; readonly currency: string; readonly scope: "turn" | "session" };
}
/** Non-text native output. Bytes are handed to the content owner; links are never fetched. */
export type NativeOutput =
  | { readonly kind: "content"; readonly name: string; readonly mediaType: string; readonly data: Uint8Array }
  | { readonly kind: "link"; readonly uri: string; readonly name: string; readonly title?: string; readonly mediaType?: string };
export type ControlEvent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "thinking"; readonly text: string }
  | { readonly type: "tool"; readonly id: string; readonly title: string; readonly status: string; readonly detail?: NativeToolDetail }
  | { readonly type: "plan"; readonly entries: readonly NativePlanEntry[]; readonly explanation?: string }
  | { readonly type: "usage"; readonly usage: NativeUsage }
  | { readonly type: "notice"; readonly severity: "info" | "warning" | "error"; readonly title: string; readonly detail?: string }
  | { readonly type: "activity"; readonly id: string; readonly kind: "subagent" | "task" | "compaction" | "retry" | "review"; readonly title: string; readonly status: "running" | "completed" | "failed" | "cancelled"; readonly detail?: string }
  | { readonly type: "output"; readonly output: NativeOutput }
  | { readonly type: "permission_requested"; readonly id: string; readonly title: string; readonly detail?: string; readonly input?: {readonly kind:"text"|"editor"|"secret";readonly value:string}; readonly options: readonly { readonly id: string; readonly name: string }[] }
  | { readonly type: "permission"; readonly id: string; readonly decision: "denied" | "cancelled" }
  | { readonly type: "diagnostic"; readonly message: string };
export interface BackendResult {
  readonly status: "completed" | "cancelled" | "failed";
  readonly reason: string;
  readonly error?: { readonly code: string; readonly message: string };
}
export interface NativeOption {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly currentValue: string;
  readonly values: readonly { readonly value: string; readonly name: string }[];
}
export type NativeOptions = Readonly<Record<string, string>>;
/**
 * Prompt content a native interface accepts besides text, as it declares it: ACP promptCapabilities, Codex
 * Model.inputModalities, Pi Model.input. `file` means a file can be handed over as a readable path, link or embedded text.
 */
export interface NativeInputs { readonly image: boolean; readonly audio: boolean; readonly file: boolean }
/**
 * What the installed Harness has loaded besides its model, as it reports it: skills (invocable ones are also commands),
 * MCP servers with their connection state and tool count, and plugins or extensions. Read-only; Hub never changes them.
 */
export interface NativeExtensions {
  readonly skills: readonly { readonly name: string; readonly description: string; readonly scope?: string; readonly enabled: boolean; readonly command?: string }[];
  readonly mcpServers: readonly { readonly name: string; readonly status: string; readonly auth?: string; readonly tools: number; readonly failed: boolean }[];
  readonly plugins: readonly { readonly name: string; readonly enabled: boolean; readonly version?: string; readonly source?: string }[];
  /** Lists cut at their bounds; the Harness has more than shown. */
  readonly truncated?: boolean;
}
export const MAX_NATIVE_EXTENSIONS = 512;
export interface NativeModelCatalog {
  readonly models: readonly { readonly id: string; readonly name: string; readonly options?: readonly NativeOption[]; readonly inputs?: NativeInputs }[];
  /** Agent-level inputs; a model's own `inputs` take precedence when the native interface declares them per model. */
  readonly inputs?: NativeInputs;
  /** The native configured default before any session-local model override. */
  readonly defaultModel: string | null;
  readonly selectionError?: { readonly code: string; readonly message: string };
  readonly authentication: "ready" | "missing" | "unknown";
  readonly canSelect: boolean;
  readonly options?: readonly NativeOption[];
  readonly commands?: readonly { readonly name: string; readonly description: string }[];
}
export interface StopRequestReceipt { readonly requested: true }
export interface CleanupEvidence {
  readonly closed: true;
  readonly exitCode: number | null;
  readonly signal: string | null;
  /** Process cleanup can succeed while the connection has suffered a protocol failure. */
  readonly protocolFailure: { readonly code: string; readonly message: string } | null;
}
export interface ControlRun {
  readonly result: Promise<BackendResult>;
  /** Receipt is not backend settlement or process cleanup. */
  requestStop(): Promise<StopRequestReceipt>;
}
/** One native conversation and active run per connection; all resources are owned by close(). */
export interface HarnessControl {
  initialize(): Promise<ProtocolObservation>;
  open(cwd: string, model?: string, options?: NativeOptions, checkpoint?: string): Promise<NativeConversationId>;
  /** Private Driver-owned recovery reference, never credentials. Null means the current native interface cannot resume. */
  checkpoint?(): Promise<string | null>;
  models?(): Promise<NativeModelCatalog>;
  /**
   * Rejects with ATTACHMENT_UNSUPPORTED (or a size code) before anything is sent when the open conversation's agent or
   * model cannot take one of the attachments. Called by the Runtime before dispatch; a control without it takes none.
   */
  checkAttachments?(attachments: readonly ContentRef[]): Promise<void>;
  /**
   * Creates a native copy of the session behind `checkpoint` and returns the copy's own recovery reference; the source
   * session is left as it was. Rejects with NATIVE_FORK_UNAVAILABLE when the installed interface cannot branch. Used on a
   * connection that opens no other conversation.
   */
  fork?(checkpoint: string, cwd: string): Promise<string>;
  /** Native skills, MCP servers and plugins; absent when the interface cannot list them. */
  extensions?(): Promise<NativeExtensions>;
  /** Sends one prompt. Attachments were accepted by checkAttachments; their private copies stay readable for the Turn. */
  startText(id: NativeConversationId, text: string, onEvent: (event: ControlEvent) => void, attachments?: readonly ControlAttachment[]): Promise<ControlRun>;
  /** Enables interactive requests for a public Run. Standalone probes keep their explicit deny default. */
  enablePermissions?(): void;
  /** Selects an actual pending option; receipt does not assert backend acknowledgement. */
  decidePermission?(id: string, option: string, input?: string): Promise<void>;
  close(): Promise<CleanupEvidence>;
}
