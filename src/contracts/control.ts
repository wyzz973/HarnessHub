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
  readonly protocol: "acp-v1" | "codex-app-server";
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
  | { readonly type: "tool"; readonly id: string; readonly title: string; readonly status: string }
  | { readonly type: "permission"; readonly id: string; readonly decision: "denied" | "cancelled" }
  | { readonly type: "diagnostic"; readonly message: string };
export interface BackendResult {
  readonly status: "completed" | "cancelled" | "failed";
  readonly reason: string;
  readonly error?: { readonly code: string; readonly message: string };
}
export interface NativeModelCatalog {
  readonly models: readonly { readonly id: string; readonly name: string }[];
  readonly defaultModel: string | null;
  readonly authentication: "ready" | "missing" | "unknown";
  readonly canSelect: boolean;
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
  open(cwd: string, model?: string): Promise<NativeConversationId>;
  models?(): Promise<NativeModelCatalog>;
  startText(id: NativeConversationId, text: string, onEvent: (event: ControlEvent) => void): Promise<ControlRun>;
  close(): Promise<CleanupEvidence>;
}
