// SPDX-License-Identifier: MIT
/**
 * Provider test and doctor (03 section 9): real requests to a provider's
 * upstream that tell whether each declared endpoint answers, and which
 * settings (key header, output limit field, usage, optional fields,
 * reasoning replay, model metadata) it needs. Every request goes through
 * the gateway's probe (`@harnesshub/gateway/probe`) and is committed to the
 * `model.call` ledger under `client:doctor` before the next one is sent.
 * Nothing here changes the provider: the report proposes a JSON Merge Patch
 * that a client may apply with `PATCH /providers/{id}`.
 */
import type { SecretReference } from "@harnesshub/core/engine-configuration";
import { HubError } from "@harnesshub/core/errors";
import type { LogSink } from "@harnesshub/core/logging";
import { viaProvider, type OutboundFetch } from "@harnesshub/core/outbound";
import {
  type ApiKeyHeader,
  type DroppableField,
  type ModelPlaneStore,
  type ProviderConfig,
  type ProviderCredential,
  type ProviderId,
  type ProviderModel,
  type ProviderPatch,
  type WireProtocol,
  wireName,
} from "@harnesshub/core/model-plane";
import {
  doctorChecks,
  type DoctorCheck,
  type DoctorItem,
  type DoctorPlan,
  type DoctorReport,
  type EndpointTest,
  type ProviderTestReport,
} from "@harnesshub/core/provider-doctor";
import {
  probeUpstream,
  type ProbeResult,
  type ProbeTarget,
} from "@harnesshub/gateway/probe";
import { FAILURE_WORDS } from "@harnesshub/gateway/routing";
import {
  answerOf,
  ESTIMATE,
  OPTIONAL_FIELDS,
  overflowPrompt,
  textBody,
  toolBody,
  toolResultBody,
  TOOL_NAME,
  type Answer,
} from "./doctor-requests.js";
import {
  fetchModelList,
  listingProtocol,
  ModelListError,
} from "./http/model-list.js";

/** Per request; the context probe of `--deep` gets four times as long. */
const REQUEST_TIMEOUT_MS = 60_000;
/** Default of `slowMs`. */
const SLOW_MS = 10_000;

export interface DoctorOptions {
  /** The provider's model ID; default the first exposed model it lists. */
  model?: string;
  /** Also send more than the model's context window. */
  deep?: boolean;
  /** A median first-content time above this is a warning (ms). */
  slowMs?: number;
}

export interface ProviderDoctorDeps {
  store: Pick<ModelPlaneStore, "getProvider" | "appendModelCall">;
  /** Resolves a credential's secret (the daemon's `SecretStore`). */
  resolveSecret(ref: SecretReference): Promise<string>;
  log?: LogSink;
  /** Per-request limit; tests shorten it. */
  timeoutMs?: number;
  /** Requests to the provider through the daemon's proxy policy; global `fetch` without it. */
  fetch?: OutboundFetch;
}

type Json = Record<string, unknown>;

interface Context {
  provider: ProviderConfig;
  protocols: WireProtocol[];
  primary: WireProtocol;
  model: string;
  modelInfo: ProviderModel | undefined;
  wireModel: string;
  keys: Map<WireProtocol, { credential?: ProviderCredential; secret: string }>;
}

/** One proposed setting; the report merges them into one patch. */
type Change =
  | {
      kind: "patch-add" | "patch-remove";
      protocol: WireProtocol;
      name: ProviderPatch;
    }
  | { kind: "drop-fields"; protocol: WireProtocol; fields: DroppableField[] }
  | { kind: "auth"; header: ApiKeyHeader }
  | { kind: "endpoint"; protocol: WireProtocol; url: string | null }
  | { kind: "replay"; value: boolean };

const ORDER: readonly WireProtocol[] = [
  "chat",
  "responses",
  "anthropic",
  "gemini",
];
const AUTH_ALTERNATIVES: Readonly<Record<string, ApiKeyHeader[]>> = {
  "authorization-bearer": ["x-api-key"],
  "x-api-key": ["authorization-bearer"],
  "api-key": ["authorization-bearer"],
  "x-goog-api-key": ["query-key", "authorization-bearer"],
  "query-key": ["x-goog-api-key"],
};

function union<T>(a: readonly T[], b: readonly T[]): T[] {
  return [...new Set([...a, ...b])];
}

function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** A served model name compared loosely: case, `models/` and date suffixes ignored. */
function sameModel(a: string, b: string): boolean {
  const normal = (name: string) =>
    name
      .toLowerCase()
      .replace(/^models\//, "")
      .replace(/-(\d{4}-\d{2}-\d{2}|\d{8})$/, "");
  return normal(a) === normal(b);
}

/** The JSON Merge Patch of `PATCH /providers/{id}` that applies `changes`. */
export function patchFor(
  provider: ProviderConfig,
  changes: readonly Change[],
): Json | undefined {
  const patch: Json = {};
  const sets = new Map<
    WireProtocol,
    { patches: string[]; dropFields: string[] }
  >();
  const set = (protocol: WireProtocol) => {
    let value = sets.get(protocol);
    if (!value) {
      const current = provider.patches?.[protocol];
      value = {
        patches: [...(current?.patches ?? [])],
        dropFields: [...(current?.dropFields ?? [])],
      };
      sets.set(protocol, value);
    }
    return value;
  };
  for (const change of changes)
    switch (change.kind) {
      case "patch-add":
        set(change.protocol).patches = union(set(change.protocol).patches, [
          change.name,
        ]);
        break;
      case "patch-remove":
        set(change.protocol).patches = set(change.protocol).patches.filter(
          (name) => name !== change.name,
        );
        break;
      case "drop-fields": {
        const value = set(change.protocol);
        value.patches = union(value.patches, ["drop-fields"]);
        value.dropFields = union(value.dropFields, change.fields);
        break;
      }
      case "auth":
        patch.auth = { apiKeyHeader: change.header };
        break;
      case "endpoint":
        patch.endpoints = {
          ...(patch.endpoints as Json | undefined),
          [change.protocol]: change.url,
        };
        break;
      case "replay":
        patch.capabilities = { requiresReasoningReplay: change.value };
        break;
    }
  if (sets.size)
    patch.patches = Object.fromEntries(
      [...sets].map(([protocol, value]) => [
        protocol,
        {
          patches: value.patches,
          ...(value.dropFields.length ? { dropFields: value.dropFields } : {}),
        },
      ]),
    );
  return Object.keys(patch).length ? patch : undefined;
}

/**
 * The doctor and `provider test` of the daemon. One instance serves the API;
 * runs are independent and sequential within themselves. `close` aborts the
 * runs in progress and waits for them.
 */
export class ProviderDoctor {
  readonly #deps: ProviderDoctorDeps;
  readonly #running = new Set<{
    abort: AbortController;
    done: Promise<unknown>;
  }>();
  #closed = false;

  constructor(deps: ProviderDoctorDeps) {
    this.#deps = deps;
  }

  /**
   * What `run` would send: the model, the endpoint most checks use, the
   * number of model calls and their estimated cost. Sends nothing.
   *
   * @throws HubError PROVIDER_NOT_FOUND (404), DOCTOR_MODEL_REQUIRED (400).
   */
  async plan(id: string, options: DoctorOptions = {}): Promise<DoctorPlan> {
    return planOf(
      await this.#context(id, options.model, false),
      options.deep === true,
    );
  }

  /**
   * Run every check of 03 section 9 and report. Requests are committed to the
   * ledger one by one; aborting `signal` cancels the request in flight,
   * records it and rejects with the abort reason.
   *
   * @throws HubError PROVIDER_NOT_FOUND (404), DOCTOR_MODEL_REQUIRED (400),
   *   CREDENTIAL_UNAVAILABLE (409) when a key cannot be read, and
   *   EVIDENCE_UNAVAILABLE (503) when the ledger refuses an entry (the run
   *   stops; nothing more is sent).
   */
  async run(
    id: string,
    options: DoctorOptions = {},
    signal?: AbortSignal,
  ): Promise<DoctorReport> {
    return this.#track(signal, async (abort) => {
      const context = await this.#context(id, options.model, true);
      const run = new DoctorRun(this.#deps, context, options, abort);
      const report = await run.execute();
      const counts = Object.fromEntries(
        (["pass", "warn", "fail", "skip"] as const).map((status) => [
          status,
          report.items.filter((item) => item.status === status).length,
        ]),
      );
      this.#deps.log?.info("provider.doctor", {
        provider: context.provider.id,
        model: context.model,
        protocol: context.primary,
        deep: options.deep === true,
        ...counts,
        modelCalls: report.modelCalls,
        costUsd: report.costUsd,
        durationMs: report.durationMs,
        failed: report.items
          .filter((item) => item.status === "fail")
          .map((item) => item.check),
      });
      return report;
    });
  }

  /**
   * One minimal request per declared endpoint, each committed to the ledger.
   *
   * @throws HubError as `run`, except that it sends nothing more after an
   *   EVIDENCE_UNAVAILABLE.
   */
  async test(
    id: string,
    options: { model?: string } = {},
    signal?: AbortSignal,
  ): Promise<ProviderTestReport> {
    return this.#track(signal, async (abort) => {
      const context = await this.#context(id, options.model, true);
      const run = new DoctorRun(this.#deps, context, {}, abort);
      const endpoints: EndpointTest[] = [];
      for (const protocol of context.protocols) {
        const result = await run.send(
          "test",
          protocol,
          textBody(protocol, context.wireModel, {
            stream: false,
            maxTokensField: run.configuredField,
          }),
          false,
        );
        endpoints.push({
          protocol,
          url: result.url,
          ok: result.ok,
          status: result.status,
          durationMs: result.timing.durationMs,
          ...(result.timing.firstByteMs !== undefined
            ? { firstByteMs: result.timing.firstByteMs }
            : {}),
          ...(result.servedModel ? { servedModel: result.servedModel } : {}),
          ...(result.ok ? {} : { error: problem(result) ?? "failed" }),
        });
      }
      return {
        provider: context.provider.id,
        model: context.model,
        wireModel: context.wireModel,
        endpoints,
        modelCalls: run.calls,
        costUsd: run.costUsd,
        unpricedCalls: run.unpriced,
      };
    });
  }

  /** Abort the runs in progress and wait for them to end; new runs are refused. */
  async close(): Promise<void> {
    this.#closed = true;
    const running = [...this.#running];
    for (const entry of running)
      entry.abort.abort(new Error("The daemon is closing"));
    await Promise.allSettled(running.map((entry) => entry.done));
  }

  async #track<T>(
    signal: AbortSignal | undefined,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.#closed)
      throw new HubError("SHUTTING_DOWN", "The daemon is closing", 503);
    const abort = new AbortController();
    const onAbort = () => abort.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    const done = work(abort.signal);
    const entry = { abort, done };
    this.#running.add(entry);
    try {
      return await done;
    } finally {
      this.#running.delete(entry);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async #context(
    id: string,
    requested: string | undefined,
    withKeys: boolean,
  ): Promise<Context> {
    const provider = await this.#deps.store.getProvider(id as ProviderId);
    if (!provider)
      throw new HubError(
        "PROVIDER_NOT_FOUND",
        `No provider has the ID ${JSON.stringify(id).slice(0, 80)}`,
        404,
      );
    // An account's reference holds its sign-in tokens, not an API key.
    if (provider.subscription)
      throw new HubError(
        "SUBSCRIPTION_PROVIDER",
        "A subscription provider is checked by its sign-in (hh subscription list); the doctor tests API-key providers",
        409,
      );
    const protocols = ORDER.filter((protocol) => provider.endpoints[protocol]);
    const exposed = provider.models.list.find(
      (model) =>
        provider.models.expose === "all" ||
        provider.models.expose.includes(model.id),
    );
    const model = requested ?? exposed?.id;
    if (model === undefined)
      throw new HubError(
        "DOCTOR_MODEL_REQUIRED",
        "The provider lists no model to test; name one (hh provider doctor <id> --model <model>)",
        400,
      );
    if (!/^\S{1,512}$/.test(model))
      throw new HubError(
        "DOCTOR_MODEL_REQUIRED",
        "The model ID is not valid",
        400,
      );
    const keys: Context["keys"] = new Map();
    if (withKeys)
      for (const protocol of protocols) {
        const credential = provider.credentials.find(
          (item) =>
            item.enabled &&
            (item.protocols === undefined || item.protocols.includes(protocol)),
        );
        if (!credential) {
          keys.set(protocol, { secret: "" });
          continue;
        }
        let secret: string;
        try {
          secret = await this.#deps.resolveSecret(credential.ref);
        } catch {
          throw new HubError(
            "CREDENTIAL_UNAVAILABLE",
            `The credential ${credential.id} could not be read`,
            409,
          );
        }
        keys.set(protocol, { credential, secret });
      }
    return {
      provider,
      protocols,
      primary: protocols[0]!,
      model,
      modelInfo: provider.models.list.find((item) => item.id === model),
      wireModel: wireName(provider, model),
      keys,
    };
  }
}

/** Model calls per check when each runs to its end, and the plan. */
function planOf(context: Context, deep: boolean): DoctorPlan {
  const { protocols, primary, provider, modelInfo } = context;
  const chat = protocols.includes("chat");
  const openai = primary === "chat" || primary === "responses";
  const optional = Object.keys(OPTIONAL_FIELDS[primary] ?? {}).length;
  const siblings =
    (protocols.includes("chat") && !protocols.includes("responses")) ||
    (protocols.includes("responses") && !protocols.includes("chat"))
      ? 1
      : 0;
  const window = modelInfo?.contextWindow;
  const calls: Array<[DoctorCheck, number, { input: number; output: number }]> =
    [
      ["endpoints", protocols.length, ESTIMATE.text],
      ["auth", 0, ESTIMATE.text],
      ["models", 0, ESTIMATE.text],
      ["streaming", 1, ESTIMATE.text],
      // The usage probe is also the stream_options probe of optional-fields.
      ["usage", primary === "chat" ? 1 : 0, ESTIMATE.text],
      ["max-tokens", chat ? 1 : 0, ESTIMATE.text],
      [
        "tools",
        2,
        {
          input: ESTIMATE.tool.input + ESTIMATE.toolResult.input,
          output: ESTIMATE.tool.output * 2,
        },
      ],
      ["reasoning-replay", primary === "chat" ? 1 : 0, ESTIMATE.toolResult],
      [
        "optional-fields",
        openai ? optional - (primary === "chat" ? 1 : 0) : 0,
        ESTIMATE.text,
      ],
      ["image", 1, ESTIMATE.image],
      ["native-endpoints", siblings, ESTIMATE.text],
      ["served-model", 0, ESTIMATE.text],
      ["latency", 2, ESTIMATE.text],
      [
        "context-overflow",
        deep && window !== undefined ? 1 : 0,
        { input: (window ?? 0) + 2048, output: 16 },
      ],
    ];
  const tokens = { input: 0, output: 0 };
  for (const [check, count, each] of calls) {
    // Tools' two turns are counted in one estimate.
    const times = check === "tools" ? (count ? 1 : 0) : count;
    tokens.input += each.input * times;
    tokens.output += each.output * times;
  }
  const modelCalls = calls.reduce((sum, [, count]) => sum + count, 0);
  const alternatives =
    AUTH_ALTERNATIVES[provider.auth.apiKeyHeader]?.length ?? 1;
  const price = modelInfo?.price;
  return {
    provider: provider.id,
    model: context.model,
    wireModel: context.wireModel,
    protocol: primary,
    deep,
    modelCalls,
    maxModelCalls: modelCalls + protocols.length * alternatives,
    listRequests: listingProtocol(provider) ? 1 : 0,
    estimatedTokens: tokens,
    estimatedCostUsd:
      price?.input !== undefined && price.output !== undefined
        ? (tokens.input * price.input + tokens.output * price.output) / 1e6
        : null,
    checks: calls.map(([check, count]) => ({ check, modelCalls: count })),
  };
}

/** A 404 or 400 whose message says the model does not exist, not the URL. */
function modelMissing(result: ProbeResult): boolean {
  return (
    [400, 404, 422].includes(result.status) &&
    FAILURE_WORDS.modelMissing.test(result.error?.message ?? "")
  );
}

/** The redacted error of a failed probe, for reports. */
function problem(result: ProbeResult): string | undefined {
  if (result.ok) return undefined;
  return (
    result.networkError ??
    result.error?.message ??
    (result.status ? `HTTP ${result.status}` : "no answer")
  );
}

function describe(protocol: WireProtocol, result: ProbeResult): string {
  return result.ok
    ? `${protocol}: ${result.status} in ${result.timing.durationMs} ms (${result.url})`
    : result.status
      ? `${protocol}: ${result.status} at ${result.url}: ${problem(result)}`
      : `${protocol}: no answer from ${result.url}: ${problem(result)}`;
}

/** Failure fields of an item from a failed probe. */
function failure(result: ProbeResult | undefined): Partial<DoctorItem> {
  if (!result || result.ok) return {};
  const excerpt = problem(result);
  return {
    ...(excerpt ? { excerpt } : {}),
    ...(result.status ? { httpStatus: result.status } : {}),
    url: result.url,
  };
}

const rejectedStatus = (result: ProbeResult | undefined) =>
  result?.status === 400 || result?.status === 422;

/** One doctor run: its requests, their accounting and the items. */
class DoctorRun {
  calls = 0;
  costUsd = 0;
  unpriced = 0;
  readonly configuredField: "max_tokens" | "max_completion_tokens";
  readonly #items = new Map<DoctorCheck, DoctorItem>();
  readonly #changes: Change[] = [];
  readonly #served: string[] = [];
  /** A key scheme found to work where the configured one was refused. */
  #authOverride: ApiKeyHeader | undefined;

  constructor(
    private readonly deps: ProviderDoctorDeps,
    private readonly context: Context,
    private readonly options: DoctorOptions,
    private readonly signal: AbortSignal,
  ) {
    this.configuredField = context.provider.patches?.chat?.patches.includes(
      "max-tokens-field",
    )
      ? "max_completion_tokens"
      : "max_tokens";
  }

  /** Send one probe and commit its ledger entry before anything else is sent. */
  async send(
    label: string,
    protocol: WireProtocol,
    body: Json,
    stream: boolean,
    extra: {
      base?: string;
      apiKeyHeader?: ApiKeyHeader;
      timeoutMs?: number;
    } = {},
  ): Promise<ProbeResult> {
    this.signal.throwIfAborted();
    const { context } = this;
    const key = context.keys.get(protocol) ??
      context.keys.get(context.primary) ?? { secret: "" };
    const header = extra.apiKeyHeader ?? this.#authOverride;
    const target: ProbeTarget = {
      provider: context.provider,
      protocol,
      ...(extra.base !== undefined ? { base: extra.base } : {}),
      credential: key.credential,
      secret: key.secret,
      ...(header ? { apiKeyHeader: header } : {}),
      model: context.model,
      modelInfo: context.modelInfo,
      wireModel: context.wireModel,
    };
    const { result, entry } = await probeUpstream(target, {
      body,
      stream,
      label,
      timeoutMs: extra.timeoutMs ?? this.deps.timeoutMs ?? REQUEST_TIMEOUT_MS,
      signal: this.signal,
      ...(this.deps.fetch ? { send: this.deps.fetch } : {}),
    });
    try {
      await this.deps.store.appendModelCall(entry);
    } catch {
      throw new HubError(
        "EVIDENCE_UNAVAILABLE",
        "The ledger could not record a doctor request, so the doctor stopped",
        503,
      );
    }
    this.calls++;
    if (entry.cost) this.costUsd += entry.cost.amountUsd;
    else this.unpriced++;
    // A cancelled probe is recorded above; nothing more is sent.
    this.signal.throwIfAborted();
    if (result.ok && result.servedModel) this.#served.push(result.servedModel);
    return result;
  }

  #item(
    check: DoctorCheck,
    status: DoctorItem["status"],
    summary: string,
    more: Partial<DoctorItem> = {},
    changes: Change[] = [],
  ): void {
    this.#changes.push(...changes);
    const patch = changes.length
      ? patchFor(this.context.provider, changes)
      : undefined;
    const fix = `hh provider doctor ${this.context.provider.id}${this.options.model ? ` --model ${this.context.model}` : ""} --fix`;
    this.#items.set(check, {
      check,
      status,
      summary,
      details: more.details ?? [],
      ...more,
      suggestions: [...(patch ? [fix] : []), ...(more.suggestions ?? [])],
      ...(patch ? { patch } : {}),
    });
  }

  async execute(): Promise<DoctorReport> {
    const started = performance.now();
    const startedAt = new Date().toISOString();
    const { context } = this;
    const { provider, primary, wireModel } = context;
    const plan = planOf(context, this.options.deep === true);

    // Base URL and path: one minimal request per declared endpoint. A Chat
    // endpoint that refuses the output limit field is retried with the other.
    const base = new Map<WireProtocol, ProbeResult>();
    const fields = new Map<string, ProbeResult>();
    let field = this.configuredField;
    const other =
      field === "max_tokens" ? "max_completion_tokens" : "max_tokens";
    for (const protocol of context.protocols) {
      const result = await this.send(
        "endpoints",
        protocol,
        textBody(protocol, wireModel, { stream: false, maxTokensField: field }),
        false,
      );
      base.set(protocol, result);
      if (protocol !== "chat") continue;
      fields.set(field, result);
      if (rejectedStatus(result)) {
        const retry = await this.send(
          "max-tokens",
          "chat",
          textBody("chat", wireModel, { stream: false, maxTokensField: other }),
          false,
        );
        fields.set(other, retry);
        if (retry.ok) {
          base.set("chat", retry);
          field = other;
        }
      }
    }
    this.#endpoints(base);

    // Authentication: only for a 401 or 403, other schemes are tried once.
    const auth = await this.#auth(base);
    // A Chat request repeated with a working key header stands for its field.
    const chatBase = base.get("chat");
    if (chatBase && [401, 403].includes(fields.get(field)?.status ?? 0))
      fields.set(field, chatBase);
    const primaryBase = base.get(primary)!;
    const answered = (result: ProbeResult | undefined) =>
      result !== undefined &&
      result.status !== 0 &&
      ![401, 403, 404, 405].includes(result.status);
    const ready = primaryBase.ok;
    const notReady = `the base request to the ${primary} endpoint failed (see endpoints${auth ? " and auth" : ""})`;

    await this.#models();

    // Streaming; then usage with and without include_usage.
    let stream: ProbeResult | undefined;
    if (answered(primaryBase)) {
      stream = await this.send(
        "streaming",
        primary,
        textBody(primary, wireModel, { stream: true, maxTokensField: field }),
        true,
      );
      if (stream.ok)
        this.#item(
          "streaming",
          "pass",
          `The ${primary} stream parsed and ended with its terminal event`,
          {
            details: [
              `${stream.events} events; first byte ${stream.timing.firstByteMs ?? "-"} ms, first content ${stream.timing.firstContentMs ?? "-"} ms`,
            ],
          },
        );
      else
        this.#item(
          "streaming",
          "fail",
          `The ${primary} stream failed: ${problem(stream)}`,
          {
            ...failure(stream),
            suggestions: [
              "Agents stream their requests; until the upstream streams correctly, use another provider for them",
            ],
          },
        );
    } else this.#skip("streaming", notReady);

    let withUsage: ProbeResult | undefined;
    if (stream && primary === "chat" && ready)
      withUsage = await this.send(
        "usage",
        "chat",
        textBody("chat", wireModel, {
          stream: true,
          maxTokensField: field,
          extra: { stream_options: { include_usage: true } },
        }),
        true,
      );
    this.#usage(primaryBase, stream, withUsage);

    // max_tokens or max_completion_tokens (Chat only).
    if (context.protocols.includes("chat")) {
      const chatResult = base.get("chat")!;
      if (!fields.has(other) && chatResult.ok)
        fields.set(
          other,
          await this.send(
            "max-tokens",
            "chat",
            textBody("chat", wireModel, {
              stream: false,
              maxTokensField: other,
            }),
            false,
          ),
        );
      this.#maxTokens(fields, answered(chatResult));
    } else
      this.#skip(
        "max-tokens",
        "only Chat endpoints choose between max_tokens and max_completion_tokens",
      );

    // Tool round trip, then the reasoning replay requirement (Chat).
    let first: Json | undefined;
    let turn1: ProbeResult | undefined;
    let answer: Answer | undefined;
    let turn2: ProbeResult | undefined;
    if (ready) {
      first = toolBody(primary, wireModel, { maxTokensField: field });
      turn1 = await this.send("tools", primary, first, false);
      answer = turn1.ok ? answerOf(primary, turn1.json) : undefined;
      if (!turn1.ok)
        this.#item(
          "tools",
          "fail",
          `The request with a tool was refused: ${problem(turn1)}`,
          failure(turn1),
        );
      else if (!answer?.toolCalls.length)
        this.#item(
          "tools",
          "warn",
          `The model answered without calling ${TOOL_NAME}`,
          {
            details: answer?.text
              ? [`answer: ${answer.text.slice(0, 200)}`]
              : [],
          },
        );
      else {
        turn2 = await this.send(
          "tools",
          primary,
          toolResultBody(primary, first, answer, { reasoning: true }),
          false,
        );
        const after = turn2.ok ? answerOf(primary, turn2.json) : undefined;
        const text = after?.text ?? "";
        if (turn2.ok && text)
          this.#item(
            "tools",
            "pass",
            `${TOOL_NAME} was called and its result answered`,
            {
              details: [`answer: ${text.slice(0, 200)}`],
            },
          );
        else if (turn2.ok)
          this.#item(
            "tools",
            "warn",
            after?.toolCalls.length
              ? "The model called a tool again instead of answering the tool result"
              : "The answer to the tool result has no text",
          );
        else
          this.#item(
            "tools",
            "fail",
            `The tool result was refused: ${problem(turn2)}`,
            failure(turn2),
          );
      }
    } else this.#skip("tools", notReady);
    await this.#replay(first, answer, turn2);

    // Optional fields, one at a time against their control request.
    await this.#optional(field, primaryBase, stream, withUsage, first, turn1);

    // Image input against the model's metadata.
    if (ready) {
      const image = await this.send(
        "image",
        primary,
        textBody(primary, wireModel, {
          stream: false,
          image: true,
          maxTokensField: field,
        }),
        false,
      );
      this.#image(image);
    } else this.#skip("image", notReady);

    await this.#native(base);

    // Served model, from every successful answer so far.
    const served = [...new Set(this.#served)];
    if (!served.length) this.#skip("served-model", "no request succeeded");
    else if (served.every((name) => sameModel(name, wireModel)))
      this.#item("served-model", "pass", `Answers name ${served[0]}`, {
        details: [`wire name ${wireModel}`],
      });
    else
      this.#item(
        "served-model",
        "warn",
        `Answers name ${served.filter((name) => !sameModel(name, wireModel)).join(", ")} for ${wireModel}`,
        {
          details: [
            "The upstream may serve another model than the one requested; the ledger marks such calls",
          ],
        },
      );

    // First byte and first content: the median of three streams.
    if (stream && answered(primaryBase)) {
      const runs = [stream];
      for (let index = 0; index < 2; index++)
        runs.push(
          await this.send(
            "latency",
            primary,
            textBody(primary, wireModel, {
              stream: true,
              maxTokensField: field,
            }),
            true,
          ),
        );
      this.#latency(runs);
    } else this.#skip("latency", notReady);

    await this.#overflow(field, ready, notReady);

    const items = doctorChecks.map(
      (check) =>
        this.#items.get(check) ?? {
          check,
          status: "skip" as const,
          summary: "not run",
          details: [],
          suggestions: [],
        },
    );
    const patch = patchFor(provider, this.#changes);
    return {
      plan,
      startedAt,
      durationMs: Math.round(performance.now() - started),
      modelCalls: this.calls,
      costUsd: this.costUsd,
      unpricedCalls: this.unpriced,
      items,
      ...(patch ? { patch } : {}),
    };
  }

  #skip(check: DoctorCheck, why: string): void {
    this.#item(check, "skip", why);
  }

  #endpoints(base: Map<WireProtocol, ProbeResult>): void {
    const details = [...base].map(([protocol, result]) =>
      describe(protocol, result),
    );
    // A 401, 403, 400 or 429 came from the right URL: auth and the other
    // checks explain them, as does a 404 that names the missing model.
    const absentModel = [...base].filter(([, result]) => modelMissing(result));
    const broken = [...base].filter(
      ([, result]) =>
        result.status === 0 ||
        (result.status === 404 && !modelMissing(result)) ||
        result.status === 405 ||
        result.status >= 500 ||
        (result.status >= 200 && result.status < 300 && !result.ok),
    );
    if (!broken.length) {
      this.#item(
        "endpoints",
        "pass",
        `Every declared endpoint answered (${[...base.keys()].join(", ")})${absentModel.length ? `; ${absentModel.map(([name]) => name).join(", ")} does not know the model (see models)` : ""}`,
        { details },
      );
      return;
    }
    const working = [...base].some(([, result]) => result.ok);
    const missing = broken.filter(
      ([, result]) => result.status === 404 || result.status === 405,
    );
    const [protocol, result] = broken[0]!;
    this.#item(
      "endpoints",
      "fail",
      missing.length
        ? `${missing.map(([name, item]) => `${name} ${item.status} at ${item.url}`).join("; ")}: the base URL or path is wrong`
        : `${protocol} did not answer correctly: ${problem(result)}`,
      {
        details,
        ...failure(result),
        suggestions: [
          `hh provider show ${this.context.provider.id}`,
          "Correct the base URL (PATCH /api/v1/providers/{id} with endpoints), or remove an endpoint the upstream does not serve",
        ],
      },
      working
        ? missing.map(([name]) => ({
            kind: "endpoint",
            protocol: name,
            url: null,
          }))
        : [],
    );
  }

  async #auth(base: Map<WireProtocol, ProbeResult>): Promise<boolean> {
    const { context } = this;
    const scheme = context.provider.auth.apiKeyHeader;
    const refused = [...base].filter(([, result]) =>
      [401, 403].includes(result.status),
    );
    if (!refused.length) {
      const any = [...base].some(([, result]) => result.ok);
      if (any)
        this.#item(
          "auth",
          "pass",
          [...context.keys.values()].some((key) => key.secret)
            ? `The key is accepted in ${scheme}`
            : "No key is needed",
        );
      else this.#skip("auth", "no endpoint answered");
      return false;
    }
    const keyless = refused.filter(
      ([protocol]) => !context.keys.get(protocol)?.secret,
    );
    if (keyless.length) {
      this.#item(
        "auth",
        "fail",
        `${keyless.map(([protocol]) => protocol).join(", ")} answered ${keyless[0]![1].status} and the provider has no credential for it`,
        {
          ...failure(keyless[0]![1]),
          suggestions: [`hh credential add ${context.provider.id}`],
        },
      );
      return true;
    }
    const found = new Map<WireProtocol, ApiKeyHeader>();
    for (const [protocol] of refused)
      for (const alternative of AUTH_ALTERNATIVES[scheme] ?? [
        "authorization-bearer" as const,
      ]) {
        const retry = await this.send(
          "auth",
          protocol,
          textBody(protocol, context.wireModel, {
            stream: false,
            maxTokensField: this.configuredField,
          }),
          false,
          { apiKeyHeader: alternative },
        );
        if (retry.ok) {
          found.set(protocol, alternative);
          base.set(protocol, retry);
          if (protocol === context.primary) this.#authOverride = alternative;
          break;
        }
      }
    const [protocol, result] = refused[0]!;
    if (!found.size) {
      this.#item(
        "auth",
        "fail",
        `${protocol} refused the key (${result.status}) in ${scheme} and in every other scheme`,
        {
          ...failure(result),
          suggestions: [
            `hh credential rotate ${context.provider.id} ${context.keys.get(protocol)?.credential?.id ?? "<credential>"}`,
          ],
        },
      );
      return true;
    }
    const headers = [...new Set(found.values())];
    const othersWork = [...base].some(
      ([name, item]) => item.ok && !found.has(name),
    );
    const header = headers[0]!;
    const details = [...found].map(
      ([name, value]) => `${name}: refused in ${scheme}, accepted in ${value}`,
    );
    if (headers.length === 1 && !othersWork)
      this.#item(
        "auth",
        "fail",
        `The upstream wants the key in ${header}, not ${scheme}`,
        { ...failure(result), details },
        [{ kind: "auth", header }],
      );
    else
      this.#item(
        "auth",
        "fail",
        `${[...found.keys()].join(", ")} wants the key in another header than the provider's other endpoints`,
        {
          ...failure(result),
          details,
          suggestions: [
            `Add the endpoint as its own provider: hh provider add <id> --${[...found.keys()][0]} <url> --api-key-header ${header}`,
          ],
        },
      );
    return true;
  }

  async #models(): Promise<void> {
    const { context } = this;
    const { provider, wireModel } = context;
    const protocol = listingProtocol(provider);
    if (!protocol) return this.#skip("models", "the provider has no endpoint");
    let listed: string[];
    try {
      listed = (
        await fetchModelList(
          this.#authOverride
            ? { ...provider, auth: { apiKeyHeader: this.#authOverride } }
            : provider,
          context.keys.get(protocol)?.secret || undefined,
          this.deps.fetch && viaProvider(this.deps.fetch, provider),
        )
      ).map((model) => model.id);
    } catch (error) {
      if (!(error instanceof ModelListError)) throw error;
      this.#item(
        "models",
        provider.models.source === "live" ? "warn" : "pass",
        provider.models.source === "live"
          ? `The model list could not be read: ${error.message}`
          : `The upstream has no readable model list (${error.message}); the provider's list is ${provider.models.source}`,
        {
          suggestions:
            provider.models.source === "live"
              ? [`hh provider models ${provider.id} --refresh`]
              : [],
        },
      );
      return;
    }
    const details = [`${listed.length} models listed`];
    if (listed.includes(wireModel))
      this.#item("models", "pass", `${wireModel} is listed`, { details });
    else {
      const near = listed
        .filter((id) =>
          id
            .toLowerCase()
            .includes(wireModel.toLowerCase().split("/").pop()!.slice(0, 6)),
        )
        .slice(0, 10);
      this.#item(
        "models",
        "fail",
        `${wireModel} is not among the ${listed.length} listed models${context.model !== wireModel ? ` (model ${context.model})` : ""}`,
        {
          details: [
            ...details,
            ...(near.length
              ? [`similar: ${near.join(", ")}`]
              : listed.length
                ? [`first: ${listed.slice(0, 10).join(", ")}`]
                : []),
          ],
          suggestions: [
            `hh provider models ${provider.id} --refresh`,
            ...(listed[0]
              ? [
                  `hh provider doctor ${provider.id} --model ${near[0] ?? listed[0]}`,
                ]
              : []),
          ],
        },
      );
    }
  }

  #usage(
    base: ProbeResult,
    stream: ProbeResult | undefined,
    withUsage: ProbeResult | undefined,
  ): void {
    const { primary } = this.context;
    const reported = (result: ProbeResult | undefined) =>
      result?.ok === true &&
      result.usage !== undefined &&
      Object.keys(result.usage).length > 0;
    if (!stream?.ok && !base.ok)
      return this.#skip("usage", "no request succeeded");
    if (primary !== "chat") {
      if (reported(stream) || reported(base))
        this.#item("usage", "pass", `${primary} answers report usage`);
      else
        this.#item(
          "usage",
          "warn",
          `${primary} answers report no usage, so their cost is unknown`,
        );
      return;
    }
    const plain = reported(stream);
    const asked = reported(withUsage);
    const details = [
      `stream without stream_options: ${plain ? "usage" : stream?.ok ? "no usage" : problem(stream!)}`,
      `stream with stream_options.include_usage: ${asked ? "usage" : withUsage?.ok ? "no usage" : withUsage ? `${withUsage.status || "no answer"} ${problem(withUsage) ?? ""}`.trim() : "not sent"}`,
    ];
    const patched =
      this.context.provider.patches?.chat?.patches.includes("include-usage") ===
      true;
    if (plain)
      this.#item("usage", "pass", "Streams report usage without asking", {
        details,
      });
    else if (asked)
      this.#item(
        "usage",
        patched ? "pass" : "warn",
        patched
          ? "Streams report usage when asked, which the include-usage patch does"
          : "Streams report usage only with stream_options.include_usage",
        { details },
        patched
          ? []
          : [{ kind: "patch-add", protocol: "chat", name: "include-usage" }],
      );
    else if (reported(base))
      this.#item(
        "usage",
        "warn",
        "Only non-streamed answers report usage; streamed calls have no cost",
        { details },
      );
    else
      this.#item(
        "usage",
        "warn",
        "No answer reports usage, so call costs are unknown",
        { details },
      );
  }

  #maxTokens(fields: Map<string, ProbeResult>, answered: boolean): void {
    const plain = fields.get("max_tokens");
    const completion = fields.get("max_completion_tokens");
    if (!plain || !completion || !answered)
      return this.#skip("max-tokens", "the Chat endpoint did not answer");
    const patched = this.configuredField === "max_completion_tokens";
    const details = [
      `max_tokens: ${plain.ok ? "accepted" : `${plain.status || "no answer"} ${problem(plain)}`}`,
      `max_completion_tokens: ${completion.ok ? "accepted" : `${completion.status || "no answer"} ${problem(completion)}`}`,
    ];
    if (plain.ok && completion.ok)
      this.#item(
        "max-tokens",
        "pass",
        "Both max_tokens and max_completion_tokens are accepted",
        { details },
      );
    else if (plain.ok)
      this.#item(
        "max-tokens",
        patched ? "fail" : "pass",
        patched
          ? "max_completion_tokens is refused, but the max-tokens-field patch sends it"
          : "max_tokens is accepted (max_completion_tokens is not)",
        { details, ...(patched ? failure(completion) : {}) },
        patched
          ? [
              {
                kind: "patch-remove",
                protocol: "chat",
                name: "max-tokens-field",
              },
            ]
          : [],
      );
    else if (completion.ok)
      this.#item(
        "max-tokens",
        patched ? "pass" : "fail",
        patched
          ? "max_completion_tokens is accepted, which the max-tokens-field patch sends"
          : "max_tokens is refused; the upstream wants max_completion_tokens",
        { details, ...(patched ? {} : failure(plain)) },
        patched
          ? []
          : [{ kind: "patch-add", protocol: "chat", name: "max-tokens-field" }],
      );
    else
      this.#item(
        "max-tokens",
        "fail",
        "Neither max_tokens nor max_completion_tokens is accepted",
        {
          details,
          ...failure(plain),
        },
      );
  }

  async #replay(
    first: Json | undefined,
    answer: Answer | undefined,
    withReasoning: ProbeResult | undefined,
  ): Promise<void> {
    const { context } = this;
    if (context.primary !== "chat")
      return this.#skip(
        "reasoning-replay",
        "checked on Chat endpoints (reasoning_content)",
      );
    if (!first || !answer?.toolCalls.length || !withReasoning)
      return this.#skip(
        "reasoning-replay",
        "the tool round trip did not reach its second turn",
      );
    if (!answer.reasoning)
      return this.#skip(
        "reasoning-replay",
        "the model returned no reasoning_content with its tool call",
      );
    const without = await this.send(
      "reasoning-replay",
      "chat",
      toolResultBody("chat", first, answer, { reasoning: false }),
      false,
    );
    const required =
      context.provider.capabilities?.requiresReasoningReplay === true;
    const details = [
      `with reasoning_content: ${withReasoning.ok ? "accepted" : `${withReasoning.status} ${problem(withReasoning)}`}`,
      `without: ${without.ok ? "accepted" : `${without.status} ${problem(without)}`}`,
    ];
    if (withReasoning.ok && without.ok)
      this.#item(
        "reasoning-replay",
        "pass",
        "Replaying reasoning_content is optional",
        { details },
      );
    else if (withReasoning.ok && rejectedStatus(without))
      this.#item(
        "reasoning-replay",
        required ? "pass" : "fail",
        required
          ? "reasoning_content must be replayed, and requiresReasoningReplay is set"
          : "reasoning_content must be replayed with tool results, but requiresReasoningReplay is not set",
        { details, ...(required ? {} : failure(without)) },
        required ? [] : [{ kind: "replay", value: true }],
      );
    else if (rejectedStatus(withReasoning) && without.ok)
      this.#item(
        "reasoning-replay",
        required ? "fail" : "warn",
        "The upstream refuses reasoning_content in the history",
        { details, ...failure(withReasoning) },
        required ? [{ kind: "replay", value: false }] : [],
      );
    else
      this.#item(
        "reasoning-replay",
        "fail",
        "The tool result was refused with and without reasoning_content",
        {
          details,
          ...failure(without),
        },
      );
  }

  async #optional(
    field: "max_tokens" | "max_completion_tokens",
    base: ProbeResult,
    stream: ProbeResult | undefined,
    withUsage: ProbeResult | undefined,
    first: Json | undefined,
    turn1: ProbeResult | undefined,
  ): Promise<void> {
    const { primary, wireModel, provider } = this.context;
    const values = OPTIONAL_FIELDS[primary];
    if (!values)
      return this.#skip(
        "optional-fields",
        `${primary} endpoints have no optional fields to isolate`,
      );
    if (!base.ok)
      return this.#skip("optional-fields", "the base request failed");
    const rejected: DroppableField[] = [];
    const accepted: DroppableField[] = [];
    const inconclusive: string[] = [];
    let example: ProbeResult | undefined;
    for (const [name, value] of Object.entries(values) as Array<
      [DroppableField, unknown]
    >) {
      let result: ProbeResult | undefined;
      let control: ProbeResult | undefined;
      if (name === "stream_options") {
        result = withUsage;
        control = stream;
      } else if (name === "parallel_tool_calls") {
        if (first && turn1)
          result = await this.send(
            "optional-fields/parallel_tool_calls",
            primary,
            { ...first, parallel_tool_calls: value },
            false,
          );
        control = turn1;
      } else {
        result = await this.send(
          `optional-fields/${name}`,
          primary,
          textBody(primary, wireModel, {
            stream: false,
            maxTokensField: field,
            extra: { [name]: value },
          }),
          false,
        );
        control = base;
      }
      if (!result) inconclusive.push(`${name}: not sent`);
      else if (result.ok) accepted.push(name);
      // Attributed only when the same request without the field succeeded.
      else if (rejectedStatus(result) && control?.ok) {
        rejected.push(name);
        example ??= result;
      } else
        inconclusive.push(
          `${name}: ${result.status || "no answer"} ${problem(result) ?? ""}`.trim(),
        );
    }
    const set = provider.patches?.[primary];
    const dropped = set?.patches.includes("drop-fields")
      ? (set.dropFields ?? [])
      : [];
    const uncovered = rejected.filter((name) => !dropped.includes(name));
    const details = [
      `accepted: ${accepted.join(", ") || "none"}`,
      `refused alone: ${rejected.join(", ") || "none"}`,
      ...(inconclusive.length
        ? [`inconclusive: ${inconclusive.join("; ")}`]
        : []),
    ];
    if (!rejected.length)
      this.#item(
        "optional-fields",
        inconclusive.length ? "warn" : "pass",
        inconclusive.length
          ? "No field was refused alone, but some probes were inconclusive"
          : `All ${accepted.length} optional fields are accepted`,
        { details },
      );
    else if (!uncovered.length)
      this.#item(
        "optional-fields",
        "pass",
        `${rejected.join(", ")} are refused and already dropped`,
        { details },
      );
    else
      this.#item(
        "optional-fields",
        "fail",
        `${uncovered.join(", ")} ${uncovered.length === 1 ? "is" : "are"} refused when added alone`,
        { details, ...failure(example) },
        [{ kind: "drop-fields", protocol: primary, fields: uncovered }],
      );
  }

  #image(result: ProbeResult): void {
    const { context } = this;
    const modalities = context.modelInfo?.inputModalities;
    const ref = `${context.provider.id}/${context.model}`;
    const declared = modalities?.includes("image");
    const set = (list: string) => `hh model set ${ref} modalities=${list}`;
    const withImage = union(modalities ?? ["text"], ["image"]).join(",");
    const withoutImage =
      (modalities ?? ["text"]).filter((item) => item !== "image").join(",") ||
      "text";
    if (result.ok) {
      if (declared)
        this.#item(
          "image",
          "pass",
          "An image is accepted, as the model's metadata says",
        );
      else
        this.#item(
          "image",
          "warn",
          modalities
            ? "An image is accepted, but the model's metadata says it takes no images"
            : "An image is accepted; the model's metadata does not say",
          { suggestions: [set(withImage)] },
        );
    } else if (rejectedStatus(result)) {
      if (declared)
        this.#item(
          "image",
          "fail",
          "An image is refused, but the model's metadata says it takes images",
          {
            ...failure(result),
            suggestions: [set(withoutImage)],
          },
        );
      else if (modalities)
        this.#item(
          "image",
          "pass",
          "An image is refused, as the model's metadata says",
        );
      else
        this.#item(
          "image",
          "warn",
          "An image is refused; the model's metadata does not say",
          {
            ...failure(result),
            suggestions: [set("text")],
          },
        );
    } else
      this.#item(
        "image",
        "fail",
        `The image request failed: ${problem(result)}`,
        failure(result),
      );
  }

  async #native(base: Map<WireProtocol, ProbeResult>): Promise<void> {
    const { provider, protocols, wireModel } = this.context;
    const failing = [...base].filter(
      ([, result]) => !result.ok && ![401, 403].includes(result.status),
    );
    const details = [...base].map(([protocol, result]) =>
      describe(protocol, result),
    );
    // The sibling OpenAI protocol under the same base, when only one is declared.
    const sibling: WireProtocol | undefined =
      protocols.includes("chat") && !protocols.includes("responses")
        ? "responses"
        : protocols.includes("responses") && !protocols.includes("chat")
          ? "chat"
          : undefined;
    let extra: { protocol: WireProtocol; url: string } | undefined;
    if (sibling) {
      const from = sibling === "responses" ? "chat" : "responses";
      const url = provider.endpoints[from]!;
      if (base.get(from)?.ok) {
        const result = await this.send(
          "native-endpoints",
          sibling,
          textBody(sibling, wireModel, { stream: false }),
          false,
          { base: url },
        );
        details.push(`${sibling} (not declared): ${describe(sibling, result)}`);
        if (result.ok) extra = { protocol: sibling, url };
      }
    }
    const models = [
      ...new Set(
        [...base.values()]
          .filter((item) => item.ok && item.servedModel)
          .map((item) => item.servedModel!),
      ),
    ];
    if (failing.length)
      this.#item(
        "native-endpoints",
        "fail",
        `Declared ${failing.map(([protocol]) => protocol).join(", ")} ${failing.length === 1 ? "does" : "do"} not answer like the others`,
        { details, ...failure(failing[0]![1]) },
      );
    else if (extra)
      this.#item(
        "native-endpoints",
        "warn",
        `The upstream also serves ${extra.protocol} at ${extra.url}, which the provider does not declare`,
        { details },
        [{ kind: "endpoint", protocol: extra.protocol, url: extra.url }],
      );
    else if (models.length > 1)
      this.#item(
        "native-endpoints",
        "warn",
        `The endpoints answer as different models: ${models.join(", ")}`,
        { details },
      );
    else
      this.#item(
        "native-endpoints",
        "pass",
        "Every declared endpoint answers the same request",
        { details },
      );
  }

  #latency(runs: ProbeResult[]): void {
    const ok = runs.filter((run) => run.ok);
    const firstByte = median(ok.flatMap((run) => run.timing.firstByteMs ?? []));
    const firstContent = median(
      ok.flatMap((run) => run.timing.firstContentMs ?? []),
    );
    const values = {
      ...(firstByte !== undefined ? { firstByteMs: firstByte } : {}),
      ...(firstContent !== undefined ? { firstContentMs: firstContent } : {}),
    };
    const slow = this.options.slowMs ?? SLOW_MS;
    const details = runs.map(
      (run, index) =>
        `stream ${index + 1}: ${run.ok ? `first byte ${run.timing.firstByteMs ?? "-"} ms, first content ${run.timing.firstContentMs ?? "-"} ms` : problem(run)}`,
    );
    if (ok.length < 2)
      this.#item(
        "latency",
        "warn",
        `Only ${ok.length} of ${runs.length} streams succeeded`,
        { details, values },
      );
    else if ((firstContent ?? firstByte ?? 0) > slow)
      this.#item(
        "latency",
        "warn",
        `Slow: the first content arrives after ${firstContent ?? firstByte} ms (median of ${ok.length}; above ${slow} ms)`,
        { details, values },
      );
    else
      this.#item(
        "latency",
        "pass",
        `First byte ${firstByte ?? "-"} ms, first content ${firstContent ?? "-"} ms (median of ${ok.length})`,
        { details, values },
      );
  }

  async #overflow(
    field: "max_tokens" | "max_completion_tokens",
    ready: boolean,
    notReady: string,
  ): Promise<void> {
    const { context } = this;
    if (this.options.deep !== true)
      return this.#skip(
        "context-overflow",
        "runs only with --deep: it sends more input than the model's context window",
      );
    const window = context.modelInfo?.contextWindow;
    const ref = `${context.provider.id}/${context.model}`;
    if (window === undefined)
      return this.#item(
        "context-overflow",
        "skip",
        "The model's context window is unknown",
        {
          suggestions: [`hh model set ${ref} context=<tokens>`],
        },
      );
    if (!ready) return this.#skip("context-overflow", notReady);
    const result = await this.send(
      "context-overflow",
      context.primary,
      textBody(context.primary, context.wireModel, {
        stream: false,
        maxTokensField: field,
        prompt: overflowPrompt(window),
      }),
      false,
      { timeoutMs: (this.deps.timeoutMs ?? REQUEST_TIMEOUT_MS) * 4 },
    );
    const input = result.usage?.input;
    if (result.ok)
      this.#item(
        "context-overflow",
        "fail",
        `More than the declared window of ${window} tokens was accepted${input ? ` (${input} input tokens)` : ""}`,
        {
          suggestions: [`hh model set ${ref} context=<the upstream's window>`],
        },
      );
    else if (result.error?.contextOverflow)
      this.#item(
        "context-overflow",
        "pass",
        "The upstream's error is recognized as a context overflow",
        {
          ...failure(result),
        },
      );
    else
      this.#item(
        "context-overflow",
        "warn",
        "The upstream refused the input, but its error is not recognized as a context overflow",
        {
          ...failure(result),
          suggestions: [
            "Report the wording so that the gateway's classifier learns it (packages/gateway/src/upstream.ts isContextOverflow)",
          ],
        },
      );
  }
}
