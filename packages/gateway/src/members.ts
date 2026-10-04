// SPDX-License-Identifier: MIT
/**
 * A route group member's fixed effort and fast mode on one attempt (Magpie
 * `withFixedEffort` and `withFast`). A member fixed at an effort is asked for
 * it whatever the request asked, even a request that asked for no
 * reasoning; a member sent fast asks for its vendor's fast mode
 * (core `fastMode`). The effort is set in Chat or Responses terms,
 * so an Anthropic or Gemini request to such a member is translated rather
 * than passed through; the effort is sent as written, not fitted to levels
 * the model may lack.
 */
import type { WireProtocol } from "@harnesshub/core/model-plane";
import { fastMode } from "@harnesshub/core/route-groups";
import { record, type ChatTranslation } from "./protocol.js";
import type { Candidate } from "./routing.js";

/** The beta under which Anthropic takes `speed: "fast"`. */
export const CLAUDE_FAST_BETA = "fast-mode-2026-02-01";

/** Whether a passthrough attempt must be translated to carry the member's fixed effort. */
export function memberNeedsTranslation(
  candidate: Candidate,
  inbound: WireProtocol,
): boolean {
  return (
    candidate.mode === "passthrough" &&
    candidate.effort !== undefined &&
    inbound !== "chat" &&
    inbound !== "responses"
  );
}

function fastOf(candidate: Candidate) {
  return candidate.fast
    ? fastMode(candidate.provider, candidate.wireModel, candidate.upstream)
    : undefined;
}

/**
 * The inbound body of a passthrough attempt with the member's effort
 * (`reasoning_effort`, or Responses' `reasoning.effort`) and fast mode
 * (`service_tier: "priority"`, or Anthropic's `speed: "fast"`), and the
 * patches applied; undefined when the member changes nothing.
 */
export function memberPassthrough(
  protocol: WireProtocol,
  raw: Record<string, unknown>,
  candidate: Candidate,
): { raw: Record<string, unknown>; patches: string[] } | undefined {
  const patches: string[] = [];
  const body = { ...raw };
  if (candidate.effort !== undefined) {
    if (protocol === "chat") body.reasoning_effort = candidate.effort;
    else if (protocol === "responses")
      body.reasoning = { ...record(raw.reasoning), effort: candidate.effort };
    else return undefined;
    patches.push(`member-effort:${candidate.effort}`);
  }
  const fast = fastOf(candidate);
  if (
    fast === "priority" &&
    (protocol === "chat" || protocol === "responses")
  ) {
    body.service_tier = "priority";
    patches.push("fast:service-tier");
  } else if (fast === "speed" && protocol === "anthropic") {
    body.speed = "fast";
    patches.push("fast:speed");
  }
  return patches.length ? { raw: body, patches } : undefined;
}

/**
 * Set the member's effort on a translated request: the reasoning request the
 * upstream encoders read, and `reasoning_effort` for a Chat upstream.
 * Returns the patches applied.
 */
export function memberTranslation(
  translation: ChatTranslation,
  candidate: Candidate,
): string[] {
  const effort = candidate.effort;
  if (effort === undefined) return [];
  translation.reasoning = effort === "none" ? { off: true } : { effort };
  if (candidate.upstream === "chat") translation.body.reasoning_effort = effort;
  return [`member-effort:${effort}`];
}

/** Set the fast mode on an encoded upstream body; returns the patches applied. */
export function memberFast(
  upstream: Record<string, unknown>,
  candidate: Candidate,
): string[] {
  const fast = fastOf(candidate);
  if (fast === "priority") {
    upstream.service_tier = "priority";
    return ["fast:service-tier"];
  }
  if (fast === "speed") {
    upstream.speed = "fast";
    return ["fast:speed"];
  }
  return [];
}

/** Add the fast-mode beta to an Anthropic attempt's headers when the member is sent fast. */
export function withFastBeta(headers: Headers, candidate: Candidate): void {
  if (fastOf(candidate) !== "speed") return;
  const betas = (headers.get("anthropic-beta") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!betas.includes(CLAUDE_FAST_BETA)) betas.push(CLAUDE_FAST_BETA);
  headers.set("anthropic-beta", betas.join(","));
}
