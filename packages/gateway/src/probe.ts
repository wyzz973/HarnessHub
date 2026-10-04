// SPDX-License-Identifier: MIT
/**
 * One request to one provider endpoint outside routing: the provider
 * doctor's and `provider test`'s probes (03 section 9). A probe uses the
 * gateway's own upstream URL, headers, stream segmentation, observation,
 * usage, cost and failure classification, so it sees the upstream as a
 * routed call would, and it returns the `model.call` entry that records it
 * under the `client:doctor` scope; the caller commits the entry. Retries,
 * breakers, quotas and patches do not apply: the probe sends the body it is
 * given.
 */
import { randomUUID } from "node:crypto";
import {
  parseModelRef,
  type ApiKeyHeader,
  type CallAttempt,
  type ModelCallEntry,
  type ModelCallId,
  type ProviderConfig,
  type ProviderCredential,
  type ProviderModel,
  type WireProtocol,
} from "@harnesshub/core/model-plane";
import {
  providerProxy,
  proxyFailure,
  type OutboundFetch,
} from "@harnesshub/core/outbound";
import { deadline, networkFailure, readLimited } from "./http.js";
import { callCost, callUsage, type UsageParts } from "./ledger.js";
import {
  observeEvent,
  observeJson,
  SseSegmenter,
  upstreamHeaders,
  upstreamUrl,
  type Observation,
} from "./passthrough.js";
import { GatewayError } from "./protocol.js";
import { KEYLESS_CREDENTIAL, failureClass, failureKind } from "./routing.js";
import { isContextOverflow, sanitize, upstreamError } from "./upstream.js";

/** The scope probes are recorded under. */
export const DOCTOR_SCOPE = { kind: "client", name: "doctor" } as const;

/** Bytes of a probe's answer that are read; the rest is not. */
const MAX_PROBE_BYTES = 4 * 1024 * 1024;

export interface ProbeTarget {
  provider: ProviderConfig;
  protocol: WireProtocol;
  /** The endpoint base; default the provider's endpoint for `protocol`. */
  base?: string;
  /** Recorded in the ledger; undefined for a provider without credentials. */
  credential: ProviderCredential | undefined;
  /** The key value, or "" to send none. Never returned or recorded. */
  secret: string;
  /** Another key scheme than the provider's, only to diagnose a 401 or 403. */
  apiKeyHeader?: ApiKeyHeader;
  /** The provider's model ID, and its metadata (for the price) when listed. */
  model: string;
  modelInfo?: ProviderModel | undefined;
  wireModel: string;
}

export interface ProbeRequest {
  /** The upstream body, sent as is (Gemini names the model in the path). */
  body: Record<string, unknown>;
  stream: boolean;
  /** Names the probe in the ledger: `inbound.path` is `/doctor/<label>`. */
  label: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Sends the probe through the daemon's proxy policy; global `fetch` without it. */
  send?: OutboundFetch;
}

/** What one probe observed. Texts are redacted and at most 500 characters. */
export interface ProbeResult {
  /** The request URL without its query (a `query-key` key is never shown). */
  url: string;
  /** HTTP status; 0 when no response arrived. */
  status: number;
  ok: boolean;
  /** No complete response: the connection failed, the probe timed out or was cancelled. */
  networkError?: string;
  /** The daemon's proxy, not the upstream, failed (`networkError` says how). */
  proxyFailed?: boolean;
  /** Aborted through the request's `signal`. */
  cancelled?: boolean;
  timing: { firstByteMs?: number; firstContentMs?: number; durationMs: number };
  servedModel?: string;
  usage?: UsageParts;
  finish?: string;
  /** A successful answer parsed and, when streamed, ended with its terminal event. */
  complete: boolean;
  /** Valid protocol events of a stream. */
  events: number;
  /** The parsed body of a non-streamed answer (successful or not). */
  json?: unknown;
  /** The upstream's error: a non-2xx body, an in-stream error or an unparseable answer. */
  error?: { message: string; code?: string; contextOverflow: boolean };
  contentType?: string;
}

function merge(target: Observation, into: ProbeResult): void {
  if (target.model) into.servedModel = target.model.slice(0, 256);
  if (target.usage) into.usage = { ...into.usage, ...target.usage };
  if (target.finish) into.finish = target.finish.slice(0, 64);
}

function failureOf(error: GatewayError): NonNullable<ProbeResult["error"]> {
  return {
    message: error.message,
    code: error.code,
    contextOverflow: error.contextOverflow,
  };
}

/**
 * Send one probe and observe the answer.
 *
 * @returns The observation and the ledger entry to commit. A failed or
 *   cancelled request (no response, timeout, abort through `signal`, non-2xx,
 *   unparseable answer) is a result, not an error; the key never appears in
 *   either. A cancelled probe is recorded with status 499 `client_cancelled`.
 * @throws Error when the provider has no endpoint for the protocol.
 */
export async function probeUpstream(
  target: ProbeTarget,
  request: ProbeRequest,
): Promise<{ result: ProbeResult; entry: ModelCallEntry }> {
  const { provider, protocol } = target;
  const base = target.base ?? provider.endpoints[protocol];
  if (base === undefined)
    throw new Error(`Provider ${provider.id} has no ${protocol} endpoint`);
  const url = upstreamUrl(
    protocol,
    base,
    target.wireModel,
    protocol === "gemini"
      ? {
          version: "v1beta",
          method: request.stream ? "streamGenerateContent" : "generateContent",
          sse: request.stream,
        }
      : undefined,
  );
  const scheme = target.apiKeyHeader ?? provider.auth.apiKeyHeader;
  const { headers } = upstreamHeaders(
    protocol,
    undefined,
    { ...provider, auth: { apiKeyHeader: scheme } },
    target.secret,
    url,
    undefined,
  );
  const shown = new URL(url);
  shown.search = "";
  const secrets = target.secret ? [target.secret] : [];
  const result: ProbeResult = {
    url: shown.toString(),
    status: 0,
    ok: false,
    timing: { durationMs: 0 },
    complete: false,
    events: 0,
  };
  const startedAt = new Date();
  const started = performance.now();
  const since = () => Math.round(performance.now() - started);
  const timeout = deadline(
    request.signal ?? new AbortController().signal,
    request.timeoutMs,
  );
  const signal = timeout.signal;
  try {
    const send = request.send ?? ((input, init) => fetch(input, init));
    const response = await send(
      url,
      {
        method: "POST",
        redirect: "error",
        signal,
        headers,
        body: JSON.stringify(request.body),
      },
      providerProxy(provider),
    );
    result.status = response.status;
    result.timing.firstByteMs = since();
    const contentType = response.headers.get("content-type");
    if (contentType) result.contentType = contentType.slice(0, 200);
    if (!response.ok) {
      const text = await readLimited(response, 64 * 1024);
      try {
        result.json = JSON.parse(text);
      } catch {
        // Not JSON: the text is the error below.
      }
      const parsed = upstreamError(text, response.status);
      result.error = {
        message: sanitize(parsed.message, secrets),
        ...(parsed.code ? { code: parsed.code.slice(0, 100) } : {}),
        contextOverflow: isContextOverflow(parsed.code, parsed.message),
      };
    } else if (request.stream) {
      const segmenter = new SseSegmenter(MAX_PROBE_BYTES);
      let read = 0;
      let terminal = false;
      const observe = (text: string) => {
        const observation = observeEvent(protocol, text);
        if (!observation.valid) return;
        result.events++;
        merge(observation, result);
        if (observation.content && result.timing.firstContentMs === undefined)
          result.timing.firstContentMs = since();
        if (observation.error && !result.error)
          result.error = failureOf(observation.error);
        if (observation.terminal) terminal = true;
      };
      if (response.body)
        for await (const chunk of response.body) {
          read += chunk.byteLength;
          if (read > MAX_PROBE_BYTES)
            throw new GatewayError(
              "The probe's answer is larger than 4 MiB",
              502,
              "upstream_invalid_response",
            );
          for (const segment of segmenter.push(chunk)) observe(segment.text);
        }
      for (const segment of segmenter.end()) observe(segment.text);
      result.complete = terminal && !result.error && result.events > 0;
      if (!result.complete && !result.error)
        result.error = {
          message:
            result.events === 0
              ? "The stream had no valid protocol events"
              : "The stream ended without its terminal event",
          code: "upstream_invalid_response",
          contextOverflow: false,
        };
    } else {
      const text = await readLimited(response, MAX_PROBE_BYTES);
      try {
        result.json = JSON.parse(text);
      } catch {
        result.error = {
          message: `The answer is not JSON (${result.contentType ?? "no content type"})`,
          code: "upstream_invalid_response",
          contextOverflow: false,
        };
      }
      if (result.json !== undefined) {
        const observation = observeJson(protocol, result.json);
        merge(observation, result);
        if (observation.error) result.error = failureOf(observation.error);
        else if (!observation.valid)
          result.error = {
            message: "The answer is not a protocol response object",
            code: "upstream_invalid_response",
            contextOverflow: false,
          };
        if (observation.content) result.timing.firstContentMs = since();
        result.complete = !result.error;
      }
    }
    result.ok = response.ok && result.complete;
  } catch (error) {
    if (request.signal?.aborted) {
      // Still recorded: the upstream may have billed the request.
      result.cancelled = true;
      result.networkError = "Cancelled before the answer was complete";
    } else if (error instanceof GatewayError) result.error = failureOf(error);
    else if (timeout.expired())
      result.networkError = `No complete answer within ${request.timeoutMs} ms`;
    else if (proxyFailure(error)) {
      result.networkError = proxyFailure(error)!.message;
      result.proxyFailed = true;
    } else
      result.networkError = sanitize(
        networkFailure(error)?.message ??
          (error instanceof Error ? error.message : String(error)),
        secrets,
      );
  } finally {
    timeout.dispose();
  }
  result.timing.durationMs = since();
  return { result, entry: probeEntry(target, request, result, startedAt) };
}

/** The ledger entry of a probe: scope `client:doctor`, cost from the model's price. */
function probeEntry(
  target: ProbeTarget,
  request: ProbeRequest,
  result: ProbeResult,
  startedAt: Date,
): ModelCallEntry {
  const { provider, protocol } = target;
  const credentialId = target.credential?.id ?? KEYLESS_CREDENTIAL.id;
  const ref = parseModelRef(`${provider.id}/${target.model}`);
  const status = result.cancelled ? 499 : result.status || 502;
  const usage = result.ok ? callUsage(result.usage ?? {}) : undefined;
  const message = result.networkError ?? result.error?.message;
  const errorClass = result.cancelled
    ? "client_cancelled"
    : result.networkError
      ? result.proxyFailed
        ? "proxy_failed"
        : "upstream_unreachable"
      : result.status && !result.status.toString().startsWith("2")
        ? failureClass(
            failureKind(result.status, result.error?.message ?? ""),
            result.status,
            result.error?.contextOverflow ?? false,
          )
        : result.error
          ? "upstream_invalid_response"
          : undefined;
  const attempt: CallAttempt | undefined =
    ref?.kind === "model"
      ? {
          provider: provider.id,
          credentialId,
          modelRef: ref.ref,
          wireModel: target.wireModel,
          upstreamProtocol: protocol,
          startedAt: startedAt.toISOString(),
          ...(result.timing.firstByteMs !== undefined
            ? { firstByteMs: result.timing.firstByteMs }
            : {}),
          ...(result.status ? { status: result.status } : {}),
          ...(errorClass ? { errorClass } : {}),
          decision: result.ok ? "success" : "stop",
        }
      : undefined;
  return {
    callId: `mc_${randomUUID().replaceAll("-", "")}` as ModelCallId,
    occurredAt: startedAt.toISOString(),
    scope: DOCTOR_SCOPE,
    inbound: {
      protocol,
      path: `/doctor/${request.label}`.slice(0, 2048),
      stream: request.stream,
    },
    requestedModel: `${provider.id}/${target.model}`.slice(0, 1024),
    ...(ref?.kind === "model" ? { modelRef: ref.ref } : {}),
    provider: provider.id,
    credentialId,
    wireModel: target.wireModel.slice(0, 512),
    upstreamProtocol: protocol,
    mode: "passthrough",
    ...(result.servedModel ? { servedModel: result.servedModel } : {}),
    patches: [],
    unmapped: [],
    status: result.ok
      ? result.status
      : status >= 200 && status < 300
        ? 502
        : status,
    ...(errorClass ? { errorClass, errorSource: "upstream" as const } : {}),
    ...(message ? { error: message.slice(0, 500) } : {}),
    ...(result.finish ? { finishReason: result.finish } : {}),
    ...(usage ? { usage } : {}),
    timing: {
      ...(result.timing.firstByteMs !== undefined
        ? { firstByteMs: result.timing.firstByteMs }
        : {}),
      ...(result.timing.firstContentMs !== undefined
        ? { firstContentMs: result.timing.firstContentMs }
        : {}),
      durationMs: result.timing.durationMs,
    },
    attempts: attempt ? [attempt] : [],
    cost: callCost(usage, target.modelInfo),
    ...(result.ok
      ? {
          completion: request.stream || result.finish ? "explicit" : "inferred",
        }
      : {}),
  };
}
