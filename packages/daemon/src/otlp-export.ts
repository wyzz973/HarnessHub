// SPDX-License-Identifier: MIT
/**
 * OTLP export of committed model calls (03-model-plane section 8,
 * 08-reliability-observability section 5). Each ledger entry becomes one
 * span after `appendModelCall` resolved, so the ledger stays the only source
 * of truth and a span is its exported view. Attributes follow the
 * OpenTelemetry GenAI semantic conventions; HarnessHub's own fields use
 * `hh.*`. Spans never carry prompts, outputs, tool arguments, error texts,
 * credentials, key text or key names: only ids, model names, counts, codes
 * and times from the ledger entry.
 *
 * Transport: OTLP/HTTP with the JSON encoding to `<endpoint>/v1/traces`
 * (https://opentelemetry.io/docs/specs/otlp/#otlphttp). The protobuf encoding
 * would need a protobuf dependency or a hand-written encoder; it is rejected
 * as unsupported until then. Export never blocks or fails a model call: a
 * bounded queue drops (and counts) spans when full, and failures are counted
 * and logged, never thrown.
 */
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { SecretReference } from "@harnesshub/core/engine-configuration";
import { deadline } from "@harnesshub/gateway/http";
import { HubError } from "@harnesshub/core/errors";
import { NO_LOG, type LogSink } from "@harnesshub/core/logging";
import type {
  ModelCallEntry,
  ModelPlaneStore,
  ProviderId,
} from "@harnesshub/core/model-plane";

/** Only the JSON encoding is implemented. */
export type OtlpProtocol = "http/json";

/** The resolved `otlp` block; header values may still be secret references. */
export interface OtlpConfig {
  /** Collector base URL without a trailing slash; spans go to `<endpoint>/v1/traces`. */
  endpoint: string;
  protocol: OtlpProtocol;
  headers: Readonly<Record<string, string | SecretReference>>;
  /** Resource attributes added to (and overriding) `service.name` and `service.version`. */
  resource: Readonly<Record<string, string | number | boolean>>;
}

const SETTINGS = new Set(["endpoint", "protocol", "headers", "resource"]);
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** Headers the exporter sets itself or that HTTP owns. */
const RESERVED_HEADERS = new Set([
  "content-type",
  "content-length",
  "content-encoding",
  "transfer-encoding",
  "connection",
  "host",
]);
const SECRET_KINDS = new Set(["env", "file", "keychain", "store"]);

function invalid(message: string): HubError {
  return new HubError("INVALID_CONFIG", `otlp: ${message}`);
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Resolve the `otlp` block. Absent means export is off: no exporter, no
 * timer and no network. Header values are strings or secret references
 * (`{"kind": "env" | "file" | "keychain" | "store", "value": ...}`),
 * resolved once when the exporter starts.
 *
 * @throws HubError `INVALID_CONFIG` naming the first invalid setting,
 *   including `protocol: "http/protobuf"`, which is not supported yet.
 */
export function resolveOtlpConfig(input: unknown): OtlpConfig | undefined {
  if (input === undefined) return undefined;
  if (!plainObject(input)) throw invalid("the block must be an object");
  for (const key of Object.keys(input))
    if (!SETTINGS.has(key))
      throw invalid(`unknown setting ${key.slice(0, 64)}`);
  if (typeof input.endpoint !== "string")
    throw invalid("endpoint must be a URL");
  let url: URL;
  try {
    url = new URL(input.endpoint);
  } catch {
    throw invalid("endpoint must be a URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw invalid("endpoint must use http or https");
  if (url.username || url.password)
    throw invalid("endpoint must not contain credentials; use headers");
  if (url.search || url.hash)
    throw invalid("endpoint must not have a query or fragment");
  const protocol = input.protocol ?? "http/json";
  if (protocol === "http/protobuf")
    throw invalid(
      "protocol http/protobuf is not supported; use http/json, which every OTLP/HTTP collector accepts",
    );
  if (protocol !== "http/json") throw invalid("protocol must be http/json");
  const headers: Record<string, string | SecretReference> = {};
  if (input.headers !== undefined) {
    if (!plainObject(input.headers))
      throw invalid("headers must map names to values");
    for (const [name, value] of Object.entries(input.headers)) {
      if (!HEADER_NAME.test(name) || RESERVED_HEADERS.has(name.toLowerCase()))
        throw invalid(`header ${name.slice(0, 64)} is not allowed`);
      if (typeof value === "string") {
        if (/[\r\n\0]/.test(value))
          throw invalid(`header ${name} contains a line break`);
        headers[name] = value;
      } else if (
        plainObject(value) &&
        Object.keys(value).length === 2 &&
        typeof value.kind === "string" &&
        SECRET_KINDS.has(value.kind) &&
        typeof value.value === "string" &&
        value.value.length > 0
      )
        headers[name] = {
          kind: value.kind as SecretReference["kind"],
          value: value.value,
        };
      else
        throw invalid(
          `header ${name} must be a string or a secret reference {kind, value}`,
        );
    }
  }
  const resource: Record<string, string | number | boolean> = {};
  if (input.resource !== undefined) {
    if (!plainObject(input.resource))
      throw invalid("resource must map attribute names to values");
    for (const [name, value] of Object.entries(input.resource)) {
      if (!name || name.length > 255)
        throw invalid("resource attribute names must have 1 to 255 characters");
      if (
        typeof value !== "string" &&
        typeof value !== "boolean" &&
        !(typeof value === "number" && Number.isFinite(value))
      )
        throw invalid(
          `resource ${name.slice(0, 64)} must be a string, number or boolean`,
        );
      resource[name] = value;
    }
  }
  return Object.freeze({
    endpoint: url.href.replace(/\/+$/, ""),
    protocol,
    headers: Object.freeze(headers),
    resource: Object.freeze(resource),
  });
}

/** Queue, batch, retry and shutdown bounds (08 section 5). */
export interface OtlpLimits {
  /** Spans waiting for export; further spans are dropped and counted. */
  maxQueue: number;
  maxBatch: number;
  flushIntervalMs: number;
  /** One HTTP request, including reading the response. */
  exportTimeoutMs: number;
  /** Retries of a batch after 429, 502, 503, 504, a timeout or a network error. */
  maxRetries: number;
  maxBackoffMs: number;
  /** Longest wait of `shutdown` for the queue to drain. */
  shutdownMs: number;
}

export const DEFAULT_OTLP_LIMITS: Readonly<OtlpLimits> = Object.freeze({
  maxQueue: 2048,
  maxBatch: 512,
  flushIntervalMs: 5000,
  exportTimeoutMs: 10_000,
  maxRetries: 2,
  maxBackoffMs: 60_000,
  shutdownMs: 3000,
});

/** Counters since the exporter started; `queued` is the current queue length. */
export interface OtlpExportStats {
  queued: number;
  exported: number;
  /** Spans dropped because the queue was full, the exporter was stopped, or the shutdown deadline passed. */
  dropped: number;
  /** Spans in batches the collector rejected or that failed after every retry. */
  failed: number;
  retries: number;
}

/** Export of committed model calls. */
export interface ModelCallExporter {
  /**
   * Queue the span of one committed ledger entry. Never throws and never
   * waits; a full queue or a stopped exporter drops the span and counts it.
   */
  record(entry: ModelCallEntry): void;
  /** Export everything queued now; resolves when done. Failures are counted, never thrown. */
  flush(): Promise<void>;
  /**
   * Stop accepting spans and the periodic flush, export the queue within
   * `shutdownMs`, then abort the request in flight and drop what is left.
   * Idempotent; resolves with the final counters.
   */
  shutdown(): Promise<OtlpExportStats>;
  stats(): OtlpExportStats;
}

export interface ModelCallExportDeps {
  /** Resolve a header's secret reference; called once per header at start. */
  resolveSecret(ref: SecretReference): Promise<string>;
  /** `service.version` of the resource. */
  serviceVersion: string;
  /**
   * The preset a provider was created from, for `gen_ai.provider.name`.
   * Looked up per batch; a failure or no preset uses the provider id.
   */
  providerPreset?(id: ProviderId): Promise<string | undefined>;
  log?: LogSink;
  fetch?: typeof fetch;
  limits?: Partial<OtlpLimits>;
}

/** Well-known `gen_ai.provider.name` values per HarnessHub preset id. */
const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  openai: "openai",
  anthropic: "anthropic",
  gemini: "gcp.gemini",
  deepseek: "deepseek",
  groq: "groq",
  mistral: "mistral_ai",
  xai: "x_ai",
};

/** `gen_ai.provider.name` for a provider: the well-known value of its preset, the preset id, or the provider id. */
export function genAiProviderName(
  providerId: string,
  preset: string | undefined,
): string {
  return preset ? (PROVIDER_NAMES[preset] ?? preset) : providerId;
}

export type AttributeValue = string | number | boolean | string[];

const SPAN_KIND_SERVER = 2;
const STATUS_UNSET = 0;
const STATUS_ERROR = 2;

const clip = (value: string) => value.slice(0, 256);

/**
 * The span attributes of a ledger entry, in a fixed order, without
 * `gen_ai.provider.name` (added at export, see {@link genAiProviderName}).
 * Integers are counts and milliseconds; `hh.cost.amount` is a double.
 */
export function modelCallAttributes(
  entry: ModelCallEntry,
): [string, AttributeValue][] {
  const attributes: [string, AttributeValue][] = [];
  const set = (key: string, value: AttributeValue | undefined) => {
    if (value !== undefined) attributes.push([key, value]);
  };
  set("gen_ai.operation.name", operation(entry));
  const requested = entry.requestedModel ?? entry.modelRef;
  set("gen_ai.request.model", requested ? clip(requested) : undefined);
  set(
    "gen_ai.response.model",
    entry.servedModel ? clip(entry.servedModel) : undefined,
  );
  set("gen_ai.conversation.id", entry.sessionId);
  set(
    "gen_ai.response.finish_reasons",
    entry.finishReason ? [clip(entry.finishReason)] : undefined,
  );
  const usage = entry.usage?.source === "missing" ? undefined : entry.usage;
  // CallUsage.input excludes cached tokens and output excludes reasoning;
  // the conventions count every input and every output token.
  set(
    "gen_ai.usage.input_tokens",
    usage && usage.input + usage.cacheRead + usage.cacheWrite,
  );
  set("gen_ai.usage.output_tokens", usage && usage.output + usage.reasoning);
  set("http.response.status_code", entry.status > 0 ? entry.status : undefined);
  set(
    "error.type",
    entry.errorClass ??
      (entry.status >= 400 ? String(entry.status) : undefined),
  );
  set("hh.model_call.id", entry.callId);
  set("hh.model_ref", entry.modelRef);
  set("hh.provider.id", entry.provider);
  set("hh.route.group", entry.group);
  set("hh.ingress.protocol", entry.inbound.protocol);
  set("hh.stream", entry.inbound.stream);
  set("hh.upstream.protocol", entry.upstreamProtocol);
  set("hh.mode", entry.mode);
  set("hh.key.id", entry.keyId);
  set("hh.key.scope", entry.scope?.kind);
  set(
    "hh.key.agent",
    entry.scope?.kind === "agent" ? entry.scope.adapterId : undefined,
  );
  set("hh.session.id", entry.sessionId);
  set("hh.run.id", entry.runId);
  set("hh.run.generation", entry.generation);
  set("hh.usage.cache_read_tokens", usage?.cacheRead);
  set("hh.usage.cache_write_tokens", usage?.cacheWrite);
  set("hh.usage.reasoning_tokens", usage?.reasoning);
  set("hh.usage.source", entry.usage?.source);
  if (entry.cost) {
    set("hh.cost.amount", entry.cost.amountUsd);
    set("hh.cost.currency", "USD");
    set("hh.cost.source", entry.cost.priceSource);
  } else set("hh.cost.source", "unknown");
  set("hh.time_to_first_byte_ms", entry.timing.firstByteMs);
  set("hh.time_to_first_content_ms", entry.timing.firstContentMs);
  set("hh.attempts", entry.attempts.length);
  set("hh.error.source", entry.errorSource);
  set("hh.completion", entry.completion);
  if (entry.rejected) {
    set("hh.rejected", true);
    set("hh.reject_reason", entry.rejectReason);
  }
  return attributes;
}

function operation(entry: ModelCallEntry): string {
  return entry.inbound.protocol === "gemini" ? "generate_content" : "chat";
}

function otlpValue(value: AttributeValue): Record<string, unknown> {
  if (Array.isArray(value))
    return {
      arrayValue: { values: value.map((item) => ({ stringValue: item })) },
    };
  switch (typeof value) {
    case "string":
      return { stringValue: value };
    case "boolean":
      return { boolValue: value };
    default:
      // OTLP/JSON encodes 64-bit integers as decimal strings.
      return Number.isInteger(value)
        ? { intValue: String(value) }
        : { doubleValue: value };
  }
}

function keyValues(
  attributes: Iterable<[string, AttributeValue]>,
): Record<string, unknown>[] {
  return [...attributes].map(([key, value]) => ({
    key,
    value: otlpValue(value),
  }));
}

interface QueuedSpan {
  span: Record<string, unknown>;
  attributes: [string, AttributeValue][];
  provider?: ProviderId;
}

function queuedSpan(entry: ModelCallEntry): QueuedSpan {
  const attributes = modelCallAttributes(entry);
  const started = Date.parse(entry.occurredAt);
  const startMs = Number.isFinite(started) ? started : Date.now();
  const failed = entry.status >= 400 || entry.errorClass !== undefined;
  const requested = entry.requestedModel ?? entry.modelRef;
  return {
    span: {
      traceId: randomBytes(16).toString("hex"),
      spanId: randomBytes(8).toString("hex"),
      name: requested
        ? `${operation(entry)} ${clip(requested)}`
        : operation(entry),
      kind: SPAN_KIND_SERVER,
      startTimeUnixNano: String(BigInt(startMs) * 1_000_000n),
      endTimeUnixNano: String(
        BigInt(startMs + Math.max(0, Math.round(entry.timing.durationMs))) *
          1_000_000n,
      ),
      status: failed
        ? {
            code: STATUS_ERROR,
            message:
              entry.errorClass ??
              `HTTP ${entry.status > 0 ? entry.status : ""}`,
          }
        : { code: STATUS_UNSET },
    },
    attributes,
    ...(entry.provider ? { provider: entry.provider } : {}),
  };
}

const RETRYABLE = new Set([429, 502, 503, 504]);

function checkLimits(limits: OtlpLimits): void {
  for (const [name, value] of Object.entries(limits))
    if (!Number.isSafeInteger(value) || value < (name === "maxRetries" ? 0 : 1))
      throw new RangeError(`OTLP limit ${name} must be a positive integer`);
}

/**
 * Start exporting committed model calls: resolve the header secrets and
 * start the periodic flush. The caller owns the exporter and must await
 * `shutdown()` before the process exits.
 *
 * @throws The secret resolution error of a header (the caller fails the start).
 */
export async function startModelCallExport(
  config: OtlpConfig,
  deps: ModelCallExportDeps,
): Promise<ModelCallExporter> {
  const limits: OtlpLimits = { ...DEFAULT_OTLP_LIMITS, ...deps.limits };
  checkLimits(limits);
  const log = deps.log ?? NO_LOG;
  const send = deps.fetch ?? fetch;
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(config.headers))
    headers[name] =
      typeof value === "string" ? value : await deps.resolveSecret(value);
  headers["content-type"] = "application/json";
  const target = `${config.endpoint}/v1/traces`;
  const resource = keyValues(
    Object.entries({
      "service.name": "harnesshub",
      "service.version": deps.serviceVersion,
      ...config.resource,
    }),
  );
  const scope = {
    name: "harnesshub.model-gateway",
    version: deps.serviceVersion,
  };

  const queue: QueuedSpan[] = [];
  const counters = { exported: 0, dropped: 0, failed: 0, retries: 0 };
  const stop = new AbortController();
  let accepting = true;
  let chain: Promise<void> = Promise.resolve();
  let drainScheduled = false;
  let lastDropLog = 0;
  let shutdown: Promise<OtlpExportStats> | undefined;

  const stats = (): OtlpExportStats => ({ queued: queue.length, ...counters });
  const drop = (count: number) => {
    counters.dropped += count;
    const now = Date.now();
    if (now - lastDropLog >= limits.flushIntervalMs) {
      lastDropLog = now;
      log.info("otlp.dropped", { dropped: counters.dropped });
    }
  };

  const providerNames = async (
    batch: QueuedSpan[],
  ): Promise<Map<ProviderId, string>> => {
    const names = new Map<ProviderId, string>();
    for (const { provider } of batch) {
      if (!provider || names.has(provider)) continue;
      let preset: string | undefined;
      try {
        preset = await deps.providerPreset?.(provider);
      } catch {
        // A store read failure only loses the preset; the provider id is still correct.
        preset = undefined;
      }
      names.set(provider, genAiProviderName(provider, preset));
    }
    return names;
  };

  /** Export one batch; never throws. */
  const exportBatch = async (batch: QueuedSpan[]): Promise<void> => {
    const names = await providerNames(batch);
    const body = JSON.stringify({
      resourceSpans: [
        {
          resource: { attributes: resource },
          scopeSpans: [
            {
              scope,
              spans: batch.map(({ span, attributes, provider }) => {
                const all = [...attributes];
                const name = provider && names.get(provider);
                // Right after gen_ai.operation.name.
                if (name) all.splice(1, 0, ["gen_ai.provider.name", name]);
                return { ...span, attributes: keyValues(all) };
              }),
            },
          ],
        },
      ],
    });
    for (let attempt = 0; ; attempt++) {
      if (stop.signal.aborted) {
        drop(batch.length);
        return;
      }
      let status: number | undefined;
      let retryAfterMs: number | undefined;
      const timeout = deadline(stop.signal, limits.exportTimeoutMs);
      try {
        const response = await send(target, {
          method: "POST",
          headers,
          body,
          signal: timeout.signal,
        });
        status = response.status;
        const seconds = Number(response.headers.get("retry-after"));
        if (Number.isFinite(seconds) && seconds >= 0)
          retryAfterMs = seconds * 1000;
        // Read (and drop) the answer so the connection can be reused.
        await response.arrayBuffer();
      } catch (error) {
        if (stop.signal.aborted) {
          drop(batch.length);
          return;
        }
        // A timeout or a network error is retried like a 503.
        log.debug("otlp.export_error", {
          error: error instanceof Error ? error.name : "unknown",
        });
      } finally {
        timeout.dispose();
      }
      if (status !== undefined && status >= 200 && status < 300) {
        counters.exported += batch.length;
        return;
      }
      if (
        attempt >= limits.maxRetries ||
        (status !== undefined && !RETRYABLE.has(status))
      ) {
        counters.failed += batch.length;
        log.info("otlp.export_failed", {
          spans: batch.length,
          status: status ?? null,
          attempts: attempt + 1,
        });
        return;
      }
      counters.retries++;
      const backoff = Math.min(
        retryAfterMs ?? 1000 * 2 ** attempt,
        limits.maxBackoffMs,
      );
      try {
        await delay(backoff, undefined, { signal: stop.signal });
      } catch {
        drop(batch.length);
        return;
      }
    }
  };

  /** Export queued batches one at a time: all of them, or only full ones. */
  const schedule = (all: boolean): Promise<void> => {
    const run = chain.then(async () => {
      while (
        queue.length > 0 &&
        (all || queue.length >= limits.maxBatch) &&
        !stop.signal.aborted
      )
        await exportBatch(queue.splice(0, limits.maxBatch));
    });
    chain = run;
    return run;
  };

  let timerBusy = false;
  const timer = setInterval(() => {
    if (timerBusy) return;
    timerBusy = true;
    void schedule(true).finally(() => {
      timerBusy = false;
    });
  }, limits.flushIntervalMs);
  // The daemon's listener keeps the process alive; the exporter never does.
  timer.unref();

  log.info("otlp.start", {
    endpoint: config.endpoint,
    protocol: config.protocol,
    headers: Object.keys(config.headers),
  });

  return {
    record(entry) {
      if (!accepting) return drop(1);
      if (queue.length >= limits.maxQueue) return drop(1);
      try {
        queue.push(queuedSpan(entry));
      } catch (error) {
        // A malformed entry must not reach the model call; count it as dropped.
        log.info("otlp.span_failed", {
          error: error instanceof Error ? error.name : "unknown",
        });
        return drop(1);
      }
      if (queue.length >= limits.maxBatch && !drainScheduled) {
        drainScheduled = true;
        void schedule(false).finally(() => {
          drainScheduled = false;
        });
      }
      return undefined;
    },
    flush: () => schedule(true),
    shutdown() {
      shutdown ??= (async () => {
        accepting = false;
        clearInterval(timer);
        const deadline = setTimeout(() => stop.abort(), limits.shutdownMs);
        try {
          await schedule(true);
        } finally {
          clearTimeout(deadline);
        }
        if (queue.length) drop(queue.splice(0).length);
        const final = stats();
        log.info("otlp.stop", { ...final });
        return final;
      })();
      return shutdown;
    },
    stats,
  };
}

/**
 * A store whose `appendModelCall` also hands each committed entry to
 * `committed` after the commit resolved. Every other member is the
 * store's own. `committed` must not throw; a failed commit is not exported.
 */
export function exportCommittedCalls(
  store: ModelPlaneStore,
  committed: (entry: ModelCallEntry) => void,
): ModelPlaneStore {
  const appendModelCall = async (entry: ModelCallEntry): Promise<void> => {
    await store.appendModelCall(entry);
    committed(entry);
  };
  return new Proxy(store, {
    get(target, property) {
      if (property === "appendModelCall") return appendModelCall;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}
