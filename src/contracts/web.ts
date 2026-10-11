import type { ProviderView } from "./provider.js";
import type { HarnessManagementView, InstallationJobView, InstallationLog } from "./management.js";
import type { HarnessSelection, PublicMessage, PublicRun, PublicSwitch, SelectionRequest, SessionEvent, SessionSnapshot } from "./session.js";

/** Browser-safe observations. Available means resolved control, not task acceptance. */
export interface HarnessView {
  readonly id: string;
  readonly name: string;
  readonly installed: boolean;
  readonly defaultControlId: string | null;
  readonly controls: readonly { readonly id: string; readonly protocol: string; readonly available: boolean; readonly reason: string | null }[];
  readonly providerProtocols: readonly string[];
  readonly management: HarnessManagementView;
}
export interface SessionSummary {
  readonly id: string;
  readonly title: string;
  readonly status: SessionSnapshot["status"];
  readonly workspace: string;
  readonly selection: HarnessSelection;
  readonly updatedSeq: number;
  readonly activeRunId: string | null;
}
/** Public history excludes admission fingerprints and private configuration references. */
/** The installed Harness's own sessions of a workspace; `conversationId` names the conversation already continuing one. */
export interface NativeSessionListView {
  /** null when this Harness's interface cannot list or continue its sessions. */
  readonly sessions: readonly (import("./control.js").NativeSessionSummary & { readonly conversationId?: string })[] | null;
  readonly nextCursor: string | null;
}
/** A native session reference as the chat shows it; never the private checkpoint. */
export interface NativeStateView {
  readonly harnessId: string;
  readonly controlId: string;
  readonly status: "ready" | "unconfirmed" | "forking";
  /** The model and option values the native session reported after its last Turn. */
  readonly observed?: import("./session.js").NativeConfiguration;
  /** Selected values the next Turn applies as the native session changed them itself, instead of the selection (ADR-028). */
  readonly carried?: { readonly model?: string; readonly options?: import("./control.js").NativeOptions };
}
export interface SessionView {
  readonly id: string;
  readonly version: number;
  readonly lastSeq: number;
  readonly epoch: number;
  readonly status: SessionSnapshot["status"];
  readonly workspace: string;
  readonly selection: HarnessSelection;
  readonly activeRunId: string | null;
  readonly pendingSwitchId: string | null;
  readonly permissions?: readonly import("./session.js").PermissionRequest[];
  readonly nativeStates?: readonly NativeStateView[];
  /** The public history a branched conversation started from. */
  readonly origin?: import("./session.js").SessionOrigin;
  readonly messages: readonly PublicMessage[];
  readonly runs: readonly PublicRun[];
  readonly switches: readonly PublicSwitch[];
}
export interface WebState {
  readonly providerManagement?: boolean;
  readonly workspace: string;
  readonly providers: readonly ProviderView[];
  readonly harnesses: readonly HarnessView[];
  readonly sessions: readonly SessionSummary[];
  readonly jobs: readonly InstallationJobView[];
}
export interface EventPage {
  readonly events: readonly SessionEvent[];
  readonly nextSeq: number;
  readonly hasMore: boolean;
}
/** Canonical committed UI facts. Message frames replace the full message; they are not append-only deltas. */
export type SessionStreamFrame =
  | { readonly type: "snapshot"; readonly session: SessionView }
  | { readonly type: "message"; readonly sessionId: string; readonly version: number; readonly lastSeq: number; readonly message: PublicMessage }
  /** One active Run's canonical facts (tools, plan, usage, notices, activities, outputs) after a single committed event. */
  | { readonly type: "run"; readonly sessionId: string; readonly version: number; readonly lastSeq: number; readonly run: PublicRun };
export interface InstallationLogPage {
  readonly entries: readonly InstallationLog[];
  readonly nextSeq: number;
  readonly hasMore: boolean;
}
export interface CreateWebSession {
  readonly workspace?: string;
  readonly selection: SelectionRequest;
  readonly commandId: string;
}
export interface SwitchWebSession { readonly selection: SelectionRequest; readonly commandId: string }
export interface WebError { readonly code: string; readonly message: string }
export interface AuthSession { readonly csrfToken: string }
