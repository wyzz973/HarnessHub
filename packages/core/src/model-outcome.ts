// SPDX-License-Identifier: MIT
/**
 * Run outcome rules for engines that reach their model through a HarnessHub
 * model gateway (ADR 0013, 05 section 4). The Worker applies them to its own
 * Session gateway's calls; the Runtime applies them to the shared gateway's
 * committed ledger entries of the Run. Pure: the evidence decides nothing on
 * its own and a backend result is only ever made stricter.
 */
import type { WorkerPayload } from "./ipc.js";
import type { DriverResult } from "./types.js";

/**
 * Visible engine output of one Run: non-thought `message.delta` text,
 * `tool.update` events and permission requests count; everything else is
 * ignored.
 */
export class RunObservation {
  private textCharacters = 0;
  private toolActivity = 0;

  /** Inspect one Driver payload. */
  observe(payload: WorkerPayload): void {
    if (payload.type === "permission") {
      this.toolActivity++;
      return;
    }
    if (payload.type !== "event") return;
    const { type, data } = payload.event;
    if (
      type === "message.delta" &&
      data.stream !== "thought" &&
      typeof data.text === "string" &&
      data.text.trim()
    )
      this.textCharacters += data.text.length;
    else if (type === "tool.update") this.toolActivity++;
  }

  /** Non-thought text or tool activity was observed. */
  get producedOutput(): boolean {
    return this.textCharacters > 0 || this.toolActivity > 0;
  }
}

/** What one Run's model calls showed, after all of them ended. */
export interface ModelRunEvidence {
  producedOutput: boolean;
  modelCalls: number;
  successfulModelCalls: number;
  /** Public message of the last failed call (cancelled calls excluded), if any. */
  lastUpstreamError?: string;
}

/** Public message for an upstream failure; `status` below 100 means no HTTP answer. */
export function upstreamFailureMessage(status: number, detail: string): string {
  const text = detail.trim() || "no error detail";
  return status >= 100
    ? `上游模型返回 HTTP ${status}：${text}`
    : `上游模型请求失败：${text}`;
}

/**
 * Final Run result for an engine routed through a model gateway.
 *
 * - Cancelled results are returned unchanged.
 * - `MODEL_UPSTREAM_ERROR`: the Run had upstream failures and either produced
 *   no visible output, or completed no model call successfully — engines such
 *   as codex-acp print the upstream error as ordinary text, which is not a
 *   model answer.
 * - `ENGINE_NO_OUTPUT`: a `completed` result without any model call and
 *   without visible output.
 * Other results are returned unchanged. The evidence must be complete: taken
 * after every call of the Run ended.
 */
export function settleModelRun(
  result: DriverResult,
  evidence: ModelRunEvidence,
  cancelled: boolean,
): DriverResult {
  if (cancelled || result.status === "cancelled") return result;
  if (
    evidence.lastUpstreamError !== undefined &&
    (!evidence.producedOutput || evidence.successfulModelCalls === 0)
  )
    return {
      ...result,
      status: "failed",
      stopReason: "model_upstream_error",
      error: {
        code: "MODEL_UPSTREAM_ERROR",
        message: evidence.lastUpstreamError,
      },
    };
  if (
    result.status === "completed" &&
    evidence.modelCalls === 0 &&
    !evidence.producedOutput
  )
    return {
      ...result,
      status: "failed",
      stopReason: "engine_no_output",
      error: {
        code: "ENGINE_NO_OUTPUT",
        message: "引擎未调用模型也未产生输出",
      },
    };
  return result;
}
