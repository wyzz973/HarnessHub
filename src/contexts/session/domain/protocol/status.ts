import type { ErrorClass, ItemStatus, StopReason, TurnStatus } from "../../../../contracts/protocol.js";
import type { PublicRun, RunStatus } from "../../../../contracts/session.js";

/**
 * The words of state, in one place (docs/proposals/protocol/hub-protocol.html §4, §5): every Harness's word for where a tool call
 * or a Turn stands maps to the eight item states and the Turn's status, and what a Turn ended on maps to a stop reason. A word
 * nobody recognises is `unknown`, never `completed`. Pure.
 */

/** Words by their letters only (`in_progress`, `inProgress` and `in-progress` are one word). */
const WORDS: ReadonlyMap<string, ItemStatus> = new Map<string, ItemStatus>([
  ...["pending", "queued", "proposed", "created", "requested"].map(word => [word, "pending"] as const),
  ...["running", "inprogress", "started", "executing", "active", "streaming"].map(word => [word, "running"] as const),
  ...["waiting", "awaitingapproval", "awaitinginput", "requiresaction", "needsapproval"].map(word => [word, "waiting"] as const),
  ...["completed", "complete", "success", "succeeded", "successful", "done", "ok", "finished"].map(word => [word, "completed"] as const),
  ...["failed", "failure", "error", "errored"].map(word => [word, "failed"] as const),
  ...["declined", "rejected", "denied", "refused", "blocked"].map(word => [word, "declined"] as const),
  ...["cancelled", "canceled", "interrupted", "aborted", "stopped"].map(word => [word, "cancelled"] as const),
]);
/** The item state a Harness's word means; `unknown` for a word that is none of these. */
export function itemStatus(word: string): ItemStatus {
  return WORDS.get(word.toLowerCase().replace(/[\s_-]+/gu, "")) ?? "unknown";
}
/** How a tool call ended, from its own word: done, failed (it failed, was declined or was stopped), or not finished (still going, or no word the Hub knows). */
export function toolOutcome(tool: { readonly status: string }): "done" | "failed" | "open" {
  switch (itemStatus(tool.status)) {
    case "completed": return "done";
    case "failed": case "declined": case "cancelled": return "failed";
    default: return "open";
  }
}

/** A Run's status as a Turn's: the Runtime's `settling` is still running, and a Turn that waits for the user's decision is `waiting`. */
export function turnStatus(status: RunStatus, waiting: boolean): TurnStatus {
  switch (status) {
    case "queued": case "preparing": case "completed": case "cancelled": case "failed": case "unknown": return status;
    case "running": case "settling": return waiting ? "waiting" : "running";
  }
}
/** A Run's status as the state of one of the Turn's own items (its reply, its plan, a switch): the same words, `settling` being `running`. */
export function runItemStatus(status: RunStatus): ItemStatus {
  switch (status) {
    case "queued": return "pending";
    case "preparing": case "running": case "settling": return "running";
    case "completed": case "cancelled": case "failed": case "unknown": return status;
  }
}
/** Whether a Run is over: it will not change again. */
export function runEnded(status: RunStatus): boolean { return status === "completed" || status === "cancelled" || status === "failed" || status === "unknown"; }

/**
 * What a Turn ended on. The reason the Harness gave (`run.backend.reason`: `end_turn`, `completed`, `interrupted`, `cleared`,
 * `max_tokens`, `max_turn_requests`, `refusal`) and the Runtime's own causes (`run.error.code`: the execution budget, the wait
 * for the user) decide; a Turn still going has none. A cancellation the user did not ask for and the Runtime did not cause is
 * `unknown`: the Hub does not say who stopped it.
 */
export function stopReason(run: Pick<PublicRun, "status" | "backend" | "error" | "cancelRequested">): StopReason | undefined {
  switch (run.status) {
    case "queued": case "preparing": case "running": case "settling": return undefined;
    case "unknown": return "unknown";
    case "completed": return run.backend?.reason === "cleared" ? "cleared" : "end_turn";
    case "cancelled":
      switch (run.error?.code) {
        case "RUN_TIMEOUT": case "WAIT_EXPIRED": return "budget";
        case "OWNER_ENDED": return "unknown";
        default: return run.cancelRequested ? "user_stopped" : "unknown";
      }
    case "failed":
      switch (run.backend?.reason) {
        case "max_tokens": return "max_tokens";
        case "max_turn_requests": return "max_steps";
        case "refusal": return "refusal";
        default: return run.error !== null ? "error" : "unknown";
      }
  }
}

/**
 * The class of a Turn's failure from its code (the codes the Drivers and the Runtime give: `classifyRemoteFailure`, Codex's
 * `turnFailure`, the process layer); a code of no class is `unknown`, and the message stays the Turn's own.
 */
export function errorClass(code: string): ErrorClass {
  switch (code) {
    case "NATIVE_AUTH_REQUIRED": case "HARNESS_AUTH_REQUIRED": case "GATEWAY_AUTH_REQUIRED": return "auth";
    case "NATIVE_QUOTA_EXCEEDED": return "quota";
    case "NATIVE_RATE_LIMITED": case "MODEL_RATE_LIMIT": return "rate_limit";
    case "NATIVE_CONTEXT_EXCEEDED": case "CONTEXT_WINDOW_EXCEEDED": return "context_overflow";
    case "NATIVE_CONNECTION_FAILED": return "network";
    case "PROCESS_EXITED": case "PROCESS_ERROR": case "READ_FAILED": case "WRITE_FAILED": case "INVALID_PROTOCOL": case "INVALID_FRAME": case "INCOMPLETE_FRAME": case "UNKNOWN_RESPONSE": return "harness_crash";
    case "PERMISSION_UNAVAILABLE": case "UNSUPPORTED_PERMISSION": case "PERMISSION_CONFLICT": return "permission";
    case "NATIVE_CLIENT_UNSUPPORTED": case "NATIVE_MODEL_UNAVAILABLE": case "MODEL_UNAVAILABLE": case "MODEL_POLICY_REFUSED": case "NATIVE_OPTION_UNAVAILABLE": case "NATIVE_CONFIGURATION_INVALID":
    case "ATTACHMENT_UNSUPPORTED": case "RELAY_INPUT_LIMIT": case "INVALID_INPUT": return "invalid_request";
    default: return "unknown";
  }
}
