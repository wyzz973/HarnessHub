// SPDX-License-Identifier: MIT
/**
 * The model calls the gateway makes for itself while it serves a client's
 * request: describing images for a model without image input (./vision.js)
 * and asking a route group's classifier (./classify.js). They are made as
 * the request's Gateway Key, so its budgets, requests per minute and
 * local-network rules hold for them as for its own calls, and each is a
 * ledger entry of that key with its `purpose`. Its allowlist holds for the
 * vision model, whose descriptions reach the client's model; a route
 * group's classifier comes with the group, as the group's members do, and
 * only the key's `modelDeny` refuses it.
 */
import type { CallPurpose } from "@harnesshub/core/model-plane";

/** A Chat answer of an internal call: its status and parsed body. */
export interface InternalAnswer {
  status: number;
  body: unknown;
  callId?: string;
}

/** The internal calls of one client request. */
export interface InternalCalls {
  /** The request's key may use `model` (a Model Ref or `group/<id>`) by its own allowlist. */
  allows(model: string): boolean;
  /**
   * One Chat call as the request's key (for `classify`, the key also allowed
   * the body's model, the group's classifier). Resolves undefined, without
   * a call, once the request made `maxInternalCalls`; rejects only when the
   * call could not be sent or `signal` aborted it.
   */
  call(
    purpose: CallPurpose,
    body: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<InternalAnswer | undefined>;
}
