import type { WorkerPayload } from "../domain/ipc.js";
import type { DriverResult, JsonObject } from "../domain/types.js";
import type { ModelCallRecord } from "../drivers/chat-completions/gateway.js";
import { truncatePublic, type Redactor } from "./diagnostics.js";

/**
 * Evidence collected by the Worker for one Run: visible engine output and the
 * model gateway calls attributed to that Run. It never decides success on its
 * own; {@link settleGatewayResult} combines it with the backend result.
 */
export class RunObservation {
  private textCharacters = 0;
  private toolActivity = 0;
  private calls = 0;
  private successfulCalls = 0;

  /**
   * Inspect one outgoing Driver payload. Non-thought `message.delta` text,
   * `tool.update` events and permission requests count as output; all other
   * payloads are ignored.
   */
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

  /** Count one gateway call record of this Run. */
  recordCall(call: ModelCallRecord): void {
    this.calls++;
    if (call.ok) this.successfulCalls++;
  }

  /** Non-thought text or tool activity was observed. */
  get producedOutput(): boolean {
    return this.textCharacters > 0 || this.toolActivity > 0;
  }
  get modelCalls(): number {
    return this.calls;
  }
  get successfulModelCalls(): number {
    return this.successfulCalls;
  }
}

/**
 * Convert a gateway call record into `model.call` event data. Fields are
 * copied as defined by ADR 0013; the already-redacted upstream error message is
 * redacted again with this Session's secrets and bounded to 500 characters.
 */
export function modelCallEventData(
  call: ModelCallRecord,
  redact: Redactor,
): JsonObject {
  const usage: JsonObject = {};
  for (const key of ["input", "output", "total", "reasoning"] as const) {
    const value = call.usage?.[key];
    if (typeof value === "number" && Number.isFinite(value)) usage[key] = value;
  }
  return {
    id: call.id,
    inbound: call.inbound,
    stream: call.stream,
    ...(call.requestedModel !== undefined
      ? { requestedModel: call.requestedModel }
      : {}),
    upstreamModel: call.upstreamModel,
    status: call.status,
    ok: call.ok,
    durationMs: call.durationMs,
    ...(call.finishReason !== undefined
      ? { finishReason: call.finishReason }
      : {}),
    ...(call.usage ? { usage } : {}),
    toolCalls: call.toolCalls,
    ...(call.error
      ? {
          error: {
            code: call.error.code,
            message: truncatePublic(redact(call.error.message)),
          },
        }
      : {}),
  };
}

/** Public message for the last upstream failure of a Run. */
export function upstreamErrorMessage(
  call: ModelCallRecord,
  redact: Redactor,
): string {
  const detail = call.error?.message.trim() || "no error detail";
  return truncatePublic(
    redact(
      call.status >= 100
        ? `上游模型返回 HTTP ${call.status}：${detail}`
        : `上游模型请求失败：${detail}`,
    ),
  );
}

/**
 * Final Run result for an engine routed through the model gateway (ADR 0013).
 *
 * - Cancelled results are returned unchanged.
 * - `MODEL_UPSTREAM_ERROR`: the Run had upstream failures and either produced
 *   no visible output (non-thought text, tool events or permission requests),
 *   or completed no model call successfully — engines such as codex-acp print
 *   the upstream error as ordinary text, which is not a model answer.
 * - `ENGINE_NO_OUTPUT`: a `completed` result without any model call and
 *   without visible output.
 * Other results are returned unchanged. The caller must pass evidence captured
 * after the gateway Run scope ended and after all call events were delivered.
 */
export function settleGatewayResult(
  result: DriverResult,
  evidence: {
    observation: RunObservation;
    upstreamErrors: readonly ModelCallRecord[];
    cancelled: boolean;
    redact: Redactor;
  },
): DriverResult {
  if (evidence.cancelled || result.status === "cancelled") return result;
  const { observation } = evidence;
  const last = evidence.upstreamErrors.at(-1);
  if (
    last &&
    (!observation.producedOutput || observation.successfulModelCalls === 0)
  )
    return {
      ...result,
      status: "failed",
      stopReason: "model_upstream_error",
      error: {
        code: "MODEL_UPSTREAM_ERROR",
        message: upstreamErrorMessage(last, evidence.redact),
      },
    };
  if (
    result.status === "completed" &&
    observation.modelCalls === 0 &&
    !observation.producedOutput
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
