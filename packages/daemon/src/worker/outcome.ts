// SPDX-License-Identifier: MIT
import type { DriverResult, JsonObject } from "@harnesshub/core/types";
import type { ModelCallRecord } from "@harnesshub/core/model-bridge";
import {
  RunObservation as BaseObservation,
  settleModelRun,
  upstreamFailureMessage,
} from "@harnesshub/core/model-outcome";
import { truncatePublic, type Redactor } from "./diagnostics.js";

/**
 * Evidence collected by the Worker for one Run: visible engine output (see
 * {@link BaseObservation}) and the Session gateway calls attributed to that
 * Run. It never decides success on its own; {@link settleGatewayResult}
 * combines it with the backend result.
 */
export class RunObservation extends BaseObservation {
  private calls = 0;
  private successfulCalls = 0;

  /** Count one gateway call record of this Run. */
  recordCall(call: ModelCallRecord): void {
    this.calls++;
    if (call.ok) this.successfulCalls++;
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
  return truncatePublic(
    redact(upstreamFailureMessage(call.status, call.error?.message ?? "")),
  );
}

/**
 * Final Run result for an engine routed through the Worker's Session gateway
 * (ADR 0013): {@link settleModelRun} over this Worker's evidence. The caller
 * must pass evidence captured after the gateway Run scope ended and after all
 * call events were delivered.
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
  const last = evidence.upstreamErrors.at(-1);
  return settleModelRun(
    result,
    {
      producedOutput: evidence.observation.producedOutput,
      modelCalls: evidence.observation.modelCalls,
      successfulModelCalls: evidence.observation.successfulModelCalls,
      ...(last
        ? { lastUpstreamError: upstreamErrorMessage(last, evidence.redact) }
        : {}),
    },
    evidence.cancelled,
  );
}
