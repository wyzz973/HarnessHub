import { HubError } from "../domain/errors.js";
import type { CleanupStatus } from "../domain/types.js";

interface CleanupTarget {
  failed: boolean;
  ready: { reject(error: unknown): void };
  active?: { result: { reject(error: unknown): void } };
}

/** Incomplete cleanup rejects all callers without recursively attempting cleanup or releasing ownership. */
export function settleWorkerCleanup(
  target: CleanupTarget,
  cleanup: CleanupStatus,
  releaseLease: () => void,
  cause?: unknown,
): CleanupStatus {
  let outcome = cleanup;
  let failure = cause;
  if (outcome === "confirmed") {
    try {
      releaseLease();
    } catch (error) {
      outcome = "failed";
      failure = error;
    }
  }
  if (outcome !== "confirmed") {
    target.failed = true;
    const error = new HubError(
      "WORKER_CLEANUP_UNCONFIRMED",
      "Worker cleanup could not be confirmed; its resources remain quarantined",
      503,
    );
    if (failure !== undefined) error.cause = failure;
    target.ready.reject(error);
    target.active?.result.reject(error);
  }
  return outcome;
}
