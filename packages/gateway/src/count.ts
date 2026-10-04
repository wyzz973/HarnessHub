// SPDX-License-Identifier: MIT
/**
 * Forwarding of Anthropic `POST /v1/messages/count_tokens` (03-model-plane
 * section 1): a native Anthropic endpoint counts the request itself; the
 * caller keeps the local estimate whenever forwarding is not possible.
 */
import type { IncomingHttpHeaders } from "node:http";
import { NO_LOG, type LogSink } from "@harnesshub/core/logging";
import type { CallServices } from "./call.js";
import { deadline, readLimited } from "./http.js";
import {
  countTokensUrl,
  passthroughBody,
  unsupportedPatches,
  upstreamHeaders,
} from "./passthrough.js";
import { maskBody } from "./redaction.js";
import { KEYLESS_CREDENTIAL, type Candidate } from "./routing.js";

/** Bytes of a count answer that are read; a larger answer is not a count. */
const MAX_ANSWER_BYTES = 64 * 1024;

/**
 * Send the count request to `candidate` (a passthrough candidate on an
 * anthropic endpoint) with the model rewritten to its wire name and the
 * provider's credential. Takes one of the credential's concurrency slots.
 * Bounded by `limits.upstreamHeaderTimeoutMs` for the whole exchange.
 *
 * @returns The upstream's JSON answer and whether it was itself an estimate
 *   (a cascaded HarnessHub answers `x-hh-token-count: estimated`), or
 *   undefined when the upstream could not count: busy credential,
 *   unresolvable secret, unsupported patch, network failure, non-2xx status,
 *   or an answer without a non-negative integer `input_tokens`. The reason
 *   is logged as `gateway.count.fallback` without secrets or bodies.
 */
export async function forwardCountTokens(options: {
  candidate: Candidate;
  bytes: Buffer;
  raw: Record<string, unknown>;
  headers: IncomingHttpHeaders;
  services: Pick<
    CallServices,
    "resolveSecret" | "limits" | "slots" | "redactor" | "features"
  > & {
    log?: LogSink;
  };
  signal: AbortSignal;
}): Promise<{ body: Record<string, unknown>; estimated: boolean } | undefined> {
  const { candidate, services } = options;
  const log = services.log ?? NO_LOG;
  const fallback = (reason: string, status?: number) => {
    log.info("gateway.count.fallback", {
      provider: candidate.provider.id,
      credential: candidate.credential.id,
      reason,
      ...(status === undefined ? {} : { status }),
    });
    return undefined;
  };
  const set = candidate.provider.patches?.anthropic;
  if (unsupportedPatches("anthropic", set).length)
    return fallback("patch_unsupported");
  const slots = services.slots(candidate);
  try {
    await slots.acquire(options.signal);
  } catch {
    return fallback(options.signal.aborted ? "cancelled" : "busy");
  }
  let timeout: ReturnType<typeof deadline> | undefined;
  try {
    let secret = "";
    if (candidate.credential !== KEYLESS_CREDENTIAL)
      try {
        secret = await services.resolveSecret(candidate.credential.ref);
        services.redactor.remember(secret, "PROVIDER_KEY");
      } catch {
        return fallback("credential_unavailable");
      }
    // Counting sends the prompt upstream too; known secrets stay here.
    const { body } = maskBody(
      services.redactor,
      services.features().redaction,
      passthroughBody(
        "anthropic",
        options.bytes,
        options.raw,
        candidate.wireModel,
        set,
      ).body,
    );
    const url = countTokensUrl(candidate.endpoint);
    const { headers } = upstreamHeaders(
      "anthropic",
      options.headers,
      candidate.provider,
      secret,
      url,
      set,
    );
    timeout = deadline(options.signal, services.limits.upstreamHeaderTimeoutMs);
    const signal = timeout.signal;
    let response: Response;
    let text: string;
    try {
      response = await fetch(url, {
        method: "POST",
        redirect: "error",
        signal,
        headers,
        body,
      });
      text = await readLimited(response, MAX_ANSWER_BYTES + 1);
    } catch {
      return fallback(signal.aborted ? "timeout_or_cancelled" : "unreachable");
    }
    if (!response.ok) return fallback("upstream_status", response.status);
    let answer: unknown;
    try {
      answer = text.length > MAX_ANSWER_BYTES ? undefined : JSON.parse(text);
    } catch {
      answer = undefined;
    }
    if (
      !answer ||
      typeof answer !== "object" ||
      Array.isArray(answer) ||
      !Number.isSafeInteger(
        (answer as { input_tokens?: unknown }).input_tokens,
      ) ||
      (answer as { input_tokens: number }).input_tokens < 0
    )
      return fallback("invalid_answer", response.status);
    return {
      body: answer as Record<string, unknown>,
      estimated: response.headers.get("x-hh-token-count") === "estimated",
    };
  } finally {
    timeout?.dispose();
    slots.release();
  }
}
