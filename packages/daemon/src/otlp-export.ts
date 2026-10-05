// SPDX-License-Identifier: MIT
/**
 * OTLP export of committed model calls (03-model-plane section 8,
 * 08-reliability-observability section 5). Each ledger entry becomes one
 * span after `appendModelCall` resolved, so the ledger stays the only source
 * of truth and a span is its exported view. Attributes follow the
 * OpenTelemetry GenAI semantic conventions; HarnessHub's own fields use
 * `hh.*`. Spans never carry error texts, credentials, key text or key names:
 * only ids, model names, counts, codes and times from the ledger entry, and
 * the call's request and reply only with the opt-in `bodies` (Magpie's
 * Langfuse observation input and output), masked by the gateway first.
 *
 * With `metrics`, each exported batch is also sent as the GenAI client
 * metrics Magpie exports (`gen_ai.client.operation.duration` and
 * `gen_ai.client.token.usage`, delta histograms with Magpie's bounds),
 * through the same queue, batches, flushes and retries as the spans.
 *
 * Transport: OTLP/HTTP with the JSON encoding to `<endpoint>/v1/traces` and
 * `<endpoint>/v1/metrics` (https://opentelemetry.io/docs/specs/otlp/#otlphttp).
 * The protobuf encoding would need a protobuf dependency or a hand-written
 * encoder; it is rejected as unsupported until then. Export never blocks or
 * fails a model call: a bounded queue drops (and counts) spans when full, and
 * failures are counted and logged, never thrown.
 */
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { SecretReference } from "@harnesshub/core/engine-configuration";
import { deadline } from "@harnesshub/gateway/http";
import { HubError } from "@harnesshub/core/errors";
import { NO_LOG, type LogSink } from "@harnesshub/core/logging";
import type { ModelCallEntry, ProviderId } from "@harnesshub/core/model-plane";

/** Only the JSON encoding is implemented. */
export type OtlpProtocol = "http/json";

/** The resolved `otlp` block; header values may still be secret references. */
export interface OtlpConfig {
  /**
   * Collector base URL without a trailing slash or a trailing `/v1/traces`
   * or `/v1/metrics`; spans go to `<endpoint>/v1/traces`.
   */
  endpoint: string;
  protocol: OtlpProtocol;
  headers: Readonly<Record<string, string | SecretReference>>;
  /** Resource attributes added to (and overriding) `service.name` and `service.version`. */
  resource: Readonly<Record<string, string | number | boolean>>;
  /** Also send the GenAI client metrics to `<endpoint>/v1/metrics`; off by default. */
  metrics: boolean;
  /**
   * Put each call's request and reply on its span as Langfuse's
   * `langfuse.observation.input` and `.output`; off by default. Prompts and
   * replies then leave the machine (masked, cut at 256 KiB each).
   */
  bodies: boolean;
}

const SETTINGS = new Set([
  "endpoint",
  "protocol",
  "headers",
  "resource",
  "metrics",
  "bodies",
]);
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
 * resolved once when the exporter starts. `metrics` and `bodies` are
 * booleans, false when absent.
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
  for (const name of ["metrics", "bodies"] as const)
    if (input[name] !== undefined && typeof input[name] !== "boolean")
      throw invalid(`${name} must be true or false`);
  return Object.freeze({
    // A signal's own URL names the base, as Magpie takes it.
    endpoint: url.href
      .replace(/\/+$/, "")
      .replace(/\/v1\/(?:traces|metrics)$/, ""),
    protocol,
    headers: Object.freeze(headers),
    resource: Object.freeze(resource),
    metrics: input.metrics === true,
    bodies: input.bodies === true,
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
  /** Bytes of request and reply bodies the queue holds at most (Magpie's 128 MiB); past it a span goes without them. */
  maxQueuedBodyBytes: number;
  /** Bytes of bodies in one traces request at most (Magpie's 16 MiB), so a collector's size limit holds. */
  maxBodyBytesPerRequest: number;
}

export const DEFAULT_OTLP_LIMITS: Readonly<OtlpLimits> = Object.freeze({
  maxQueue: 2048,
  maxBatch: 512,
  flushIntervalMs: 5000,
  exportTimeoutMs: 10_000,
  maxRetries: 2,
  maxBackoffMs: 60_000,
  shutdownMs: 3000,
  maxQueuedBodyBytes: 128 * 1024 * 1024,
  maxBodyBytesPerRequest: 16 * 1024 * 1024,
});

/** Counters since the exporter started; `queued` is the current queue length. */
export interface OtlpExportStats {
  queued: number;
  exported: number;
  /** Spans dropped because the queue was full, the exporter was stopped, or the shutdown deadline passed. */
  dropped: number;
  /** Spans in batches the collector rejected or that failed after every retry. */
  failed: number;
  /** Retried requests, of spans and of metrics. */
  retries: number;
  /** Calls whose metrics the collector accepted; 0 without `metrics`. */
  metricsExported: number;
  /** Calls whose metrics the collector rejected or that failed after every retry. */
  metricsFailed: number;
  /** Spans queued without their bodies because the queue held `maxQueuedBodyBytes` of them. */
  bodiesDropped: number;
}

/** A call's request and reply, already masked and cut by the gateway (`CallBodies`). */
export interface ExportedBodies {
  request: string;
  reply: string;
}

/** Export of committed model calls. */
export interface ModelCallExporter {
  /** The config's `bodies`: whether the gateway should keep calls' bodies for {@link record}. */
  readonly bodies: boolean;
  /**
   * Queue the span of one committed ledger entry, with its bodies when the
   * config has `bodies` (ignored otherwise). Never throws and never waits; a
   * full queue or a stopped exporter drops the span and counts it.
   */
  record(entry: ModelCallEntry, bodies?: ExportedBodies): void;
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

/**
 * The metric attributes of a ledger entry (Magpie's allowlist), without
 * `gen_ai.provider.name` (added at export): bounded values only, so the
 * series stay few.
 */
export function modelCallMetricAttributes(
  entry: ModelCallEntry,
): [string, AttributeValue][] {
  const attributes: [string, AttributeValue][] = [
    ["gen_ai.operation.name", operation(entry)],
  ];
  const requested = entry.requestedModel ?? entry.modelRef;
  if (requested) attributes.push(["gen_ai.request.model", clip(requested)]);
  if (entry.servedModel)
    attributes.push(["gen_ai.response.model", clip(entry.servedModel)]);
  if (entry.agent) attributes.push(["hh.agent", clip(entry.agent.id)]);
  const error =
    entry.errorClass ??
    (entry.status >= 400 ? String(entry.status) : undefined);
  if (error) attributes.push(["error.type", error]);
  return attributes;
}

/** `gen_ai.client.operation.duration` bucket bounds in seconds, as Magpie sends them. */
export const DURATION_BOUNDS: readonly number[] = [
  0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48,
  40.96, 81.92,
];
/** `gen_ai.client.token.usage` bucket bounds, as Magpie sends them. */
export const TOKEN_BOUNDS: readonly number[] = [
  1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576,
];

interface MetricSample {
  attributes: [string, AttributeValue][];
  seconds: number;
  /** Absent when the upstream reported no usage: no token points, not zeros. */
  tokens?: { input: number; output: number };
}

interface QueuedSpan {
  span: Record<string, unknown>;
  attributes: [string, AttributeValue][];
  provider?: ProviderId;
  metric: MetricSample;
  bodies?: ExportedBodies;
  /** UTF-8 bytes of `bodies`, held against `maxQueuedBodyBytes`. */
  bodyBytes: number;
}

function queuedSpan(entry: ModelCallEntry): QueuedSpan {
  const attributes = modelCallAttributes(entry);
  const started = Date.parse(entry.occurredAt);
  const startMs = Number.isFinite(started) ? started : Date.now();
  const failed = entry.status >= 400 || entry.errorClass !== undefined;
  const requested = entry.requestedModel ?? entry.modelRef;
  const usage = entry.usage?.source === "missing" ? undefined : entry.usage;
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
    metric: {
      attributes: modelCallMetricAttributes(entry),
      seconds: Math.max(0, entry.timing.durationMs) / 1000,
      // As the span counts them: every input and every output token.
      ...(usage
        ? {
            tokens: {
              input: usage.input + usage.cacheRead + usage.cacheWrite,
              output: usage.output + usage.reasoning,
            },
          }
        : {}),
    },
    bodyBytes: 0,
  };
}

/** `attributes` with `gen_ai.provider.name` right after `gen_ai.operation.name`. */
function withProvider(
  attributes: [string, AttributeValue][],
  name: string | undefined,
): [string, AttributeValue][] {
  if (!name) return attributes;
  const all = [...attributes];
  all.splice(1, 0, ["gen_ai.provider.name", name]);
  return all;
}

interface HistogramPoint {
  attributes: [string, AttributeValue][];
  count: number;
  sum: number;
  buckets: number[];
}

/**
 * The OTLP metrics of one batch: delta histograms (aggregation temporality
 * 1) over `[start, end)`, one data point per attribute set in Magpie's
 * order, counts and times as decimal strings. A value on a bound falls in
 * the bucket that bound closes.
 */
export function metricsPayload(
  samples: readonly MetricSample[],
  startNs: bigint,
  endNs: bigint,
): Record<string, unknown>[] {
  const histogram = (bounds: readonly number[]) => {
    const points = new Map<string, HistogramPoint>();
    return {
      add(attributes: [string, AttributeValue][], value: number) {
        const key = JSON.stringify(attributes);
        let point = points.get(key);
        if (!point) {
          point = {
            attributes,
            count: 0,
            sum: 0,
            buckets: new Array<number>(bounds.length + 1).fill(0),
          };
          points.set(key, point);
        }
        point.count++;
        point.sum += value;
        const index = bounds.findIndex((bound) => value <= bound);
        point.buckets[index < 0 ? bounds.length : index]!++;
      },
      dataPoints: () =>
        [...points.entries()]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([, point]) => ({
            attributes: keyValues(point.attributes),
            startTimeUnixNano: String(startNs),
            timeUnixNano: String(endNs),
            count: String(point.count),
            sum: point.sum,
            explicitBounds: bounds,
            bucketCounts: point.buckets.map(String),
          })),
    };
  };
  const duration = histogram(DURATION_BOUNDS);
  const tokens = histogram(TOKEN_BOUNDS);
  for (const sample of samples) {
    duration.add(sample.attributes, sample.seconds);
    if (!sample.tokens) continue;
    for (const [type, count] of [
      ["input", sample.tokens.input],
      ["output", sample.tokens.output],
    ] as const)
      tokens.add([...sample.attributes, ["gen_ai.token.type", type]], count);
  }
  const metrics: Record<string, unknown>[] = [];
  for (const [name, unit, description, points] of [
    [
      "gen_ai.client.operation.duration",
      "s",
      "GenAI operation duration",
      duration.dataPoints(),
    ],
    [
      "gen_ai.client.token.usage",
      "{token}",
      "Number of input and output tokens used",
      tokens.dataPoints(),
    ],
  ] as const)
    if (points.length)
      metrics.push({
        name,
        unit,
        description,
        histogram: { aggregationTemporality: 1, dataPoints: points },
      });
  return metrics;
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
  const targets = {
    traces: `${config.endpoint}/v1/traces`,
    metrics: `${config.endpoint}/v1/metrics`,
  };
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
  const counters = {
    exported: 0,
    dropped: 0,
    failed: 0,
    retries: 0,
    metricsExported: 0,
    metricsFailed: 0,
    bodiesDropped: 0,
  };
  const stop = new AbortController();
  let accepting = true;
  let chain: Promise<void> = Promise.resolve();
  let drainScheduled = false;
  let lastDropLog = 0;
  let queuedBodyBytes = 0;
  // Delta metrics cover the time since the previous metrics request.
  let metricsFrom = BigInt(Date.now()) * 1_000_000n;
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

  /**
   * POST one OTLP request with the retries. `aborted` when the exporter
   * stopped first; never throws.
   */
  const post = async (
    signal: keyof typeof targets,
    body: string,
    items: number,
  ): Promise<"accepted" | "failed" | "aborted"> => {
    for (let attempt = 0; ; attempt++) {
      if (stop.signal.aborted) return "aborted";
      let status: number | undefined;
      let retryAfterMs: number | undefined;
      const timeout = deadline(stop.signal, limits.exportTimeoutMs);
      try {
        const response = await send(targets[signal], {
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
        if (stop.signal.aborted) return "aborted";
        // A timeout or a network error is retried like a 503.
        log.debug("otlp.export_error", {
          signal,
          error: error instanceof Error ? error.name : "unknown",
        });
      } finally {
        timeout.dispose();
      }
      if (status !== undefined && status >= 200 && status < 300)
        return "accepted";
      if (
        attempt >= limits.maxRetries ||
        (status !== undefined && !RETRYABLE.has(status))
      ) {
        log.info("otlp.export_failed", {
          signal,
          items,
          status: status ?? null,
          attempts: attempt + 1,
        });
        return "failed";
      }
      counters.retries++;
      const backoff = Math.min(
        retryAfterMs ?? 1000 * 2 ** attempt,
        limits.maxBackoffMs,
      );
      try {
        await delay(backoff, undefined, { signal: stop.signal });
      } catch {
        return "aborted";
      }
    }
  };

  /** Spans in requests of at most `maxBodyBytesPerRequest` of bodies, at least one span each. */
  const traceRequests = (batch: QueuedSpan[]): QueuedSpan[][] => {
    const requests: QueuedSpan[][] = [];
    let current: QueuedSpan[] = [];
    let bytes = 0;
    for (const item of batch) {
      if (
        current.length &&
        bytes + item.bodyBytes > limits.maxBodyBytesPerRequest
      ) {
        requests.push(current);
        current = [];
        bytes = 0;
      }
      current.push(item);
      bytes += item.bodyBytes;
    }
    if (current.length) requests.push(current);
    return requests;
  };

  /** Export one batch: its spans, then its metrics; never throws. */
  const exportBatch = async (batch: QueuedSpan[]): Promise<void> => {
    const names = await providerNames(batch);
    const nameOf = (item: QueuedSpan) =>
      item.provider && names.get(item.provider);
    const requests = traceRequests(batch);
    for (const [index, spans] of requests.entries()) {
      const body = JSON.stringify({
        resourceSpans: [
          {
            resource: { attributes: resource },
            scopeSpans: [
              {
                scope,
                spans: spans.map((item) => {
                  const all = withProvider(item.attributes, nameOf(item));
                  if (item.bodies)
                    all.push(
                      ["langfuse.observation.input", item.bodies.request],
                      ["langfuse.observation.output", item.bodies.reply],
                    );
                  return { ...item.span, attributes: keyValues(all) };
                }),
              },
            ],
          },
        ],
      });
      const outcome = await post("traces", body, spans.length);
      if (outcome === "aborted") {
        drop(requests.slice(index).reduce((sum, rest) => sum + rest.length, 0));
        return;
      }
      if (outcome === "accepted") counters.exported += spans.length;
      else counters.failed += spans.length;
    }
    if (!config.metrics) return;
    const end = BigInt(Date.now()) * 1_000_000n;
    const start = metricsFrom < end ? metricsFrom : end;
    metricsFrom = end;
    const body = JSON.stringify({
      resourceMetrics: [
        {
          resource: { attributes: resource },
          scopeMetrics: [
            {
              scope,
              metrics: metricsPayload(
                batch.map((item) => ({
                  ...item.metric,
                  attributes: withProvider(
                    item.metric.attributes,
                    nameOf(item),
                  ),
                })),
                start,
                end,
              ),
            },
          ],
        },
      ],
    });
    const outcome = await post("metrics", body, batch.length);
    if (outcome === "accepted") counters.metricsExported += batch.length;
    else counters.metricsFailed += batch.length;
  };

  /** Export queued batches one at a time: all of them, or only full ones. */
  const schedule = (all: boolean): Promise<void> => {
    const run = chain.then(async () => {
      while (
        queue.length > 0 &&
        (all || queue.length >= limits.maxBatch) &&
        !stop.signal.aborted
      ) {
        const batch = queue.splice(0, limits.maxBatch);
        try {
          await exportBatch(batch);
        } finally {
          for (const item of batch) queuedBodyBytes -= item.bodyBytes;
        }
      }
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
    metrics: config.metrics,
    bodies: config.bodies,
  });

  return {
    bodies: config.bodies,
    record(entry, bodies) {
      if (!accepting) return drop(1);
      if (queue.length >= limits.maxQueue) return drop(1);
      let item: QueuedSpan;
      try {
        item = queuedSpan(entry);
      } catch (error) {
        // A malformed entry must not reach the model call; count it as dropped.
        log.info("otlp.span_failed", {
          error: error instanceof Error ? error.name : "unknown",
        });
        return drop(1);
      }
      if (config.bodies && bodies) {
        const bytes =
          Buffer.byteLength(bodies.request) + Buffer.byteLength(bodies.reply);
        // Telemetry never holds more than its share of memory: the span goes without them.
        if (queuedBodyBytes + bytes > limits.maxQueuedBodyBytes)
          counters.bodiesDropped++;
        else {
          item.bodies = bodies;
          item.bodyBytes = bytes;
          queuedBodyBytes += bytes;
        }
      }
      queue.push(item);
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
        if (queue.length) {
          const left = queue.splice(0);
          for (const item of left) queuedBodyBytes -= item.bodyBytes;
          drop(left.length);
        }
        const final = stats();
        log.info("otlp.stop", { ...final });
        return final;
      })();
      return shutdown;
    },
    stats,
  };
}
