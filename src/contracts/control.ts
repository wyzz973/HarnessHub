import type { ControlProtocol } from "../contexts/catalog/domain/discovery.js";
import type { ResolvedCommand } from "../contexts/catalog/domain/catalog.js";

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
}
export interface ProtocolObservation {
  readonly protocol: ControlProtocol;
  readonly protocolVersion: number | null;
  readonly agentName: string | null;
  readonly agentVersion: string | null;
  readonly authenticationMethods: readonly string[];
  readonly capabilities: Readonly<Record<string, unknown>>;
}
export type ControlEvent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "thinking"; readonly text: string }
  | { readonly type: "tool"; readonly id: string; readonly title: string; readonly status: string }
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
export interface NativeModelCatalog {
  readonly models: readonly { readonly id: string; readonly name: string; readonly options?: readonly NativeOption[] }[];
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
  startText(id: NativeConversationId, text: string, onEvent: (event: ControlEvent) => void): Promise<ControlRun>;
  /** Enables interactive requests for a public Run. Standalone probes keep their explicit deny default. */
  enablePermissions?(): void;
  /** Selects an actual pending option; receipt does not assert backend acknowledgement. */
  decidePermission?(id: string, option: string, input?: string): Promise<void>;
  close(): Promise<CleanupEvidence>;
}
