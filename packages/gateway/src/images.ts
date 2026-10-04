// SPDX-License-Identifier: MIT
/**
 * Image generation (Magpie `gw/draw.go`, narrowed): `POST
 * /v1/images/generations` passes the OpenAI Images request through to a
 * provider that declares an images endpoint (`ProviderConfig.imageEndpoint`),
 * with the model's wire name, the provider's credential and the prompt's
 * known secrets redacted. The model is a Model Ref, or a `group/<id>` whose
 * members are tried in order; credentials fail over as for model calls, and
 * the answer (JSON, or the `stream: true` events) goes back as the provider
 * sent it. The call is a ledger entry with the usage the provider reports
 * (`gpt-image-*` reports tokens) and its cost when the model is priced.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  modelAllowed,
  parseModelRef,
  type CallAttempt,
  type GatewayKeyRecord,
  type ModelCallEntry,
  type ModelRef,
  type ProviderConfig,
} from "@harnesshub/core/model-plane";
import { errorResponse, type CallServices } from "./call.js";
import { failure, readBody, readLimited } from "./http.js";
import { callCost, callUsage, type UsageParts } from "./ledger.js";
import { upstreamHeaders } from "./passthrough.js";
import { GatewayError, object, record } from "./protocol.js";
import {
  classify,
  failureKind,
  KEYLESS_CREDENTIAL,
  wireName,
  type Candidate,
} from "./routing.js";
import { sanitize } from "./upstream.js";

/** How long a provider may take to answer an image request (Magpie: 5 minutes). */
const IMAGE_MS = 5 * 60_000;

/** Usage of an Images answer or of its `image_generation.completed` event. */
export function imageUsage(value: unknown): UsageParts | undefined {
  const fields = record(record(value)?.usage);
  if (!fields) return undefined;
  const count = (field: unknown) =>
    typeof field === "number" && Number.isFinite(field) && field >= 0
      ? Math.round(field)
      : undefined;
  const input = count(fields.input_tokens);
  const output = count(fields.output_tokens);
  if (input === undefined && output === undefined) return undefined;
  return {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
  };
}

/** The candidates of an images request: providers with an images endpoint, in order. */
async function candidates(
  services: CallServices,
  requested: string,
): Promise<Candidate[]> {
  const parsed = parseModelRef(requested);
  if (!parsed) return [];
  const refs: string[] =
    parsed.kind === "model"
      ? [requested]
      : ((await services.store.getRouteGroup(parsed.group))?.members ?? []);
  const found: Candidate[] = [];
  for (const ref of refs) {
    const member = parseModelRef(ref);
    if (member?.kind !== "model") continue;
    const provider: ProviderConfig | undefined =
      await services.store.getProvider(member.provider);
    // Subscription accounts serve model calls only.
    if (!provider?.imageEndpoint || provider.subscription) continue;
    const credentials = provider.credentials.length
      ? provider.credentials.filter((credential) => credential.enabled)
      : [KEYLESS_CREDENTIAL];
    for (const credential of credentials)
      found.push({
        provider,
        credential,
        model: provider.models.list.find((model) => model.id === member.model),
        ref: ref as ModelRef,
        wireModel: wireName(provider, member.model),
        mode: "passthrough",
        upstream: "chat",
        endpoint: provider.imageEndpoint,
      });
  }
  return found;
}

/**
 * Serve one `/v1/images/generations` call; `entry` is committed exactly
 * once, before the answer's last bytes.
 */
export async function imagesCall(options: {
  services: CallServices;
  request: IncomingMessage;
  response: ServerResponse;
  key: GatewayKeyRecord;
  entry: ModelCallEntry;
  started: number;
  signal: AbortSignal;
}): Promise<void> {
  const { services, request, response, key, entry, signal } = options;
  const { limits } = services;
  entry.inbound = {
    protocol: "chat",
    path: "/v1/images/generations",
    stream: false,
  };
  const fail = async (status: number, code: string, message: string) => {
    entry.status = status;
    entry.errorClass = code;
    entry.errorSource = "gateway";
    entry.error = message.slice(0, 500);
    entry.timing.durationMs = Math.round(performance.now() - options.started);
    await services.commit(entry);
    if (response.headersSent) {
      response.destroy();
      return;
    }
    const answer = errorResponse("chat", failure(status, code, message));
    response.writeHead(answer.status, { "content-type": "application/json" });
    response.end(JSON.stringify(answer.body));
  };
  let reserved = 0;
  try {
    const bytes = await readBody(request, {
      maxBytes: limits.maxRequestBytes,
      timeoutMs: limits.requestBodyTimeoutMs,
      signal,
      memory: services.memory,
    });
    reserved = bytes.length;
    let raw: Record<string, unknown>;
    try {
      raw = object(JSON.parse(bytes.toString("utf8")));
    } catch {
      return fail(
        400,
        "invalid_request",
        "The request body is not a JSON object",
      );
    }
    entry.inbound.stream = raw.stream === true;
    const requested = typeof raw.model === "string" ? raw.model : "";
    if (requested) entry.requestedModel = requested.slice(0, 256);
    if (!parseModelRef(requested))
      return fail(
        400,
        "model_invalid",
        "The model must be a Model Ref (provider/model) or group/<id>",
      );
    if (!modelAllowed(key.modelAllow, requested, key.modelDeny))
      return fail(
        403,
        "model_not_allowed",
        `This Gateway Key may not use ${requested.slice(0, 200)}`,
      );
    const refusal = await services.quotas.admit(key);
    if (refusal) return fail(429, "quota_exceeded", refusal.message);
    const queue = await candidates(services, requested);
    if (!queue.length)
      return fail(
        404,
        "images_unavailable",
        `No provider of ${requested.slice(0, 200)} declares an images endpoint`,
      );
    const settings = services.features().redaction;
    let last: { status: number; text: string } | undefined;
    for (const candidate of queue) {
      if (signal.aborted)
        return fail(499, "client_cancelled", "The call was cancelled");
      const admitted = services.breakers.admit(candidate);
      if (!admitted.ok) continue;
      const attempt: CallAttempt = {
        provider: candidate.provider.id,
        credentialId: candidate.credential.id,
        modelRef: candidate.ref,
        wireModel: candidate.wireModel,
        upstreamProtocol: "chat",
        startedAt: new Date(services.clock()).toISOString(),
        decision: "stop",
      };
      entry.attempts.push(attempt);
      entry.provider = candidate.provider.id;
      entry.credentialId = candidate.credential.id;
      entry.modelRef = candidate.ref;
      entry.wireModel = candidate.wireModel;
      entry.upstreamProtocol = "chat";
      entry.mode = "passthrough";
      const slots = services.slots(candidate);
      try {
        await slots.acquire(signal);
      } catch {
        services.breakers.release(candidate);
        attempt.decision = "failover";
        attempt.errorClass = "busy";
        continue;
      }
      try {
        let secret = "";
        if (candidate.credential !== KEYLESS_CREDENTIAL) {
          try {
            secret = await services.resolveSecret(candidate.credential.ref);
          } catch {
            services.breakers.release(candidate);
            attempt.decision = "failover";
            attempt.errorClass = "credential_unavailable";
            continue;
          }
          services.redactor.remember(secret, "PROVIDER_KEY");
        }
        let upstreamBody: unknown = { ...raw, model: candidate.wireModel };
        entry.patches = [];
        if (settings.enabled) {
          const masked = services.redactor.maskJson(
            upstreamBody,
            settings.rules,
          );
          upstreamBody = masked.value;
          if (masked.count) entry.patches.push(`redact:${masked.count}`);
        }
        const url = new URL(
          `${candidate.endpoint.replace(/\/+$/, "")}/images/generations`,
        );
        const { headers } = upstreamHeaders(
          "chat",
          undefined,
          candidate.provider,
          secret,
          url,
          undefined,
        );
        const attemptStarted = performance.now();
        let answer: Response;
        try {
          answer = await fetch(url, {
            method: "POST",
            redirect: "error",
            headers,
            body: JSON.stringify(upstreamBody),
            signal: AbortSignal.any([signal, AbortSignal.timeout(IMAGE_MS)]),
          });
        } catch {
          if (signal.aborted)
            return fail(499, "client_cancelled", "The call was cancelled");
          services.breakers.failure(
            candidate,
            { kind: "none" },
            failure(502, "upstream_unreachable", "unreachable"),
            "upstream_unreachable",
          );
          attempt.decision = "failover";
          attempt.errorClass = "upstream_unreachable";
          continue;
        }
        attempt.firstByteMs = Math.round(performance.now() - attemptStarted);
        attempt.status = answer.status;
        if (!answer.ok) {
          const text = sanitize(await readLimited(answer, 64 * 1024), [secret]);
          const kind = failureKind(answer.status, text);
          const error = {
            failure: failure(
              answer.status,
              "upstream_http_error",
              text.slice(0, 500),
            ),
            errorClass: "upstream_http_error",
            source: "upstream" as const,
            phase: "response" as const,
            status: answer.status,
            kind,
          };
          const verdict = classify(error);
          services.breakers.failure(
            candidate,
            verdict.breaker,
            error.failure,
            error.errorClass,
          );
          attempt.errorClass = error.errorClass;
          last = { status: answer.status, text };
          if (verdict.failover) {
            attempt.decision = "failover";
            continue;
          }
          break;
        }
        services.breakers.success(candidate);
        attempt.decision = "success";
        const contentType =
          answer.headers.get("content-type") ?? "application/json";
        const finish = (usage: UsageParts | undefined) => {
          entry.status = 200;
          const parts = usage ?? {};
          entry.usage = callUsage(parts);
          entry.cost = callCost(entry.usage, candidate.model);
          entry.completion = "explicit";
          entry.timing.durationMs = Math.round(
            performance.now() - options.started,
          );
        };
        if (!/event-stream/i.test(contentType)) {
          const text = await readLimited(answer, limits.maxResponseBytes);
          let value: unknown;
          try {
            value = JSON.parse(text);
          } catch {
            value = undefined;
          }
          finish(imageUsage(value));
          await services.commit(entry);
          response.writeHead(200, {
            "content-type": contentType,
            "cache-control": "no-cache",
          });
          response.end(text);
          return;
        }
        // Streamed partial images: forwarded as they come; the completed
        // event's usage is kept for the ledger.
        response.writeHead(200, {
          "content-type": contentType,
          "cache-control": "no-cache",
        });
        let usage: UsageParts | undefined;
        let carry = "";
        const decoder = new TextDecoder();
        let bytesRead = 0;
        if (answer.body)
          for await (const chunk of answer.body) {
            bytesRead += chunk.byteLength;
            if (bytesRead > limits.maxResponseBytes)
              throw new GatewayError(
                "Upstream image response exceeds the gateway size limit",
                502,
                "response_too_large",
              );
            carry += decoder.decode(chunk, { stream: true });
            const events = carry.split(/\n\n/);
            carry = events.pop() ?? "";
            for (const event of events)
              for (const line of event.split("\n"))
                if (line.startsWith("data:")) {
                  try {
                    usage = imageUsage(JSON.parse(line.slice(5))) ?? usage;
                  } catch {
                    // Not JSON: forwarded all the same.
                  }
                }
            await new Promise<void>((resolve, reject) =>
              response.write(chunk, (error) =>
                error ? reject(error) : resolve(),
              ),
            );
          }
        finish(usage);
        await services.commit(entry);
        response.end();
        return;
      } finally {
        slots.release();
      }
    }
    if (last) {
      entry.status = last.status;
      entry.errorClass = "upstream_http_error";
      entry.errorSource = "upstream";
      entry.error = last.text.slice(0, 500);
      entry.timing.durationMs = Math.round(performance.now() - options.started);
      await services.commit(entry);
      response.writeHead(last.status, { "content-type": "application/json" });
      response.end(last.text);
      return;
    }
    return fail(
      503,
      "no_candidate",
      "No credential of the images provider can serve now",
    );
  } catch (error) {
    if (error instanceof GatewayError)
      return fail(error.status, error.code, error.message);
    throw error;
  } finally {
    services.memory.give(reserved);
  }
}
