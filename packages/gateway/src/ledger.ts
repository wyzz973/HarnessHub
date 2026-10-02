// SPDX-License-Identifier: MIT
/**
 * `model.call` ledger helpers of the shared gateway: usage normalized to the
 * five fields of 03 section 8, cost from a known price, and the per key and
 * reason throttle of rejection records (03 section 2).
 */
import type {
  CallUsage,
  GatewayKeyId,
  ModelCallEntry,
  ProviderModel,
  WireProtocol,
} from "@harnesshub/core/model-plane";
import { record } from "./protocol.js";

/** Reported usage fields; absent ones were not reported. `input` excludes cached tokens, `output` excludes reasoning. */
export interface UsageParts {
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
  output?: number;
  reasoning?: number;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}
function minus(total: number | undefined, part: number | undefined) {
  return total === undefined ? undefined : Math.max(0, total - (part ?? 0));
}
function defined(parts: {
  [K in keyof UsageParts]-?: number | undefined;
}): UsageParts {
  return Object.fromEntries(
    Object.entries(parts).filter(([, value]) => value !== undefined),
  );
}

/**
 * Usage object of one protocol, normalized. Chat and Responses count cached
 * tokens (and Chat cache writes) inside the prompt and reasoning inside the output; Anthropic reports
 * cache reads and writes beside the input and no reasoning count; Gemini
 * counts cached tokens inside the prompt and thoughts beside the candidates.
 */
export function usageParts(protocol: WireProtocol, raw: unknown): UsageParts {
  const usage = record(raw);
  if (!usage) return {};
  switch (protocol) {
    case "chat": {
      const cached =
        count(record(usage.prompt_tokens_details)?.cached_tokens) ??
        count(usage.prompt_cache_hit_tokens);
      const reasoning =
        count(record(usage.completion_tokens_details)?.reasoning_tokens) ??
        count(usage.reasoning_tokens);
      const written = count(usage.cache_creation_input_tokens);
      return defined({
        input: minus(minus(count(usage.prompt_tokens), cached), written),
        cacheRead: cached,
        cacheWrite: written,
        output: minus(count(usage.completion_tokens), reasoning),
        reasoning,
      });
    }
    case "responses": {
      const cached = count(record(usage.input_tokens_details)?.cached_tokens);
      const reasoning = count(
        record(usage.output_tokens_details)?.reasoning_tokens,
      );
      return defined({
        input: minus(count(usage.input_tokens), cached),
        cacheRead: cached,
        cacheWrite: undefined,
        output: minus(count(usage.output_tokens), reasoning),
        reasoning,
      });
    }
    case "anthropic":
      return defined({
        input: count(usage.input_tokens),
        cacheRead: count(usage.cache_read_input_tokens),
        cacheWrite: count(usage.cache_creation_input_tokens),
        output: count(usage.output_tokens),
        reasoning: undefined,
      });
    case "gemini": {
      const cached = count(usage.cachedContentTokenCount);
      return defined({
        input: minus(count(usage.promptTokenCount), cached),
        cacheRead: cached,
        cacheWrite: undefined,
        output: count(usage.candidatesTokenCount),
        reasoning: count(usage.thoughtsTokenCount),
      });
    }
  }
}

/**
 * The ledger usage of a finished call. Without any reported field the source
 * is `missing` and the counts are zero; a reported usage keeps absent fields at zero.
 */
export function callUsage(parts: UsageParts): CallUsage {
  const reported = Object.values(parts).some((value) => value !== undefined);
  return {
    input: parts.input ?? 0,
    cacheRead: parts.cacheRead ?? 0,
    cacheWrite: parts.cacheWrite ?? 0,
    output: parts.output ?? 0,
    reasoning: parts.reasoning ?? 0,
    source: reported ? "reported" : "missing",
  };
}

/**
 * Cost from the provider model's price (USD per million tokens). Null when
 * usage is missing, the model has no price, or a used token class has no
 * price; reasoning is billed at the output price. An explicit zero price is a
 * known cost of 0.
 */
export function callCost(
  usage: CallUsage | undefined,
  model: ProviderModel | undefined,
): ModelCallEntry["cost"] {
  const price = model?.price;
  if (!usage || usage.source === "missing" || !price) return null;
  const items: [number, number | undefined][] = [
    [usage.input, price.input],
    [usage.cacheRead, price.cacheRead],
    [usage.cacheWrite, price.cacheWrite],
    [usage.output + usage.reasoning, price.output],
  ];
  let amount = 0;
  for (const [tokens, perMillion] of items) {
    if (tokens === 0) continue;
    if (perMillion === undefined) return null;
    amount += (tokens * perMillion) / 1_000_000;
  }
  return { amountUsd: amount, priceSource: "provider" };
}

/** Detail records allowed per key, reason and minute (03 section 2). */
export const REJECTIONS_PER_MINUTE = 20;

interface Window {
  start: number;
  recorded: number;
  suppressed: number;
  sample: ModelCallEntry;
}

/**
 * Throttles rejection records per Gateway Key (or no key) and reason: the
 * first 20 per minute are recorded in detail, later ones only counted. The
 * count of a finished window becomes one aggregate record, emitted with the
 * next rejection of the same key and reason or by {@link drain}.
 */
export class RejectionThrottle {
  #windows = new Map<string, Window>();
  constructor(private readonly clock: () => number) {}

  /**
   * Records to append for this rejection: possibly the previous window's
   * aggregate, then the entry itself unless it is suppressed.
   */
  admit(
    keyId: GatewayKeyId | undefined,
    reason: string,
    entry: ModelCallEntry,
  ): ModelCallEntry[] {
    const now = this.clock();
    const name = `${keyId ?? "-"}\u0000${reason}`;
    const result: ModelCallEntry[] = [];
    let window = this.#windows.get(name);
    if (window && now - window.start >= 60_000) {
      const aggregate = this.#aggregate(window);
      if (aggregate) result.push(aggregate);
      window = undefined;
    }
    if (!window) {
      if (this.#windows.size >= 4096) this.#prune(now, result);
      window = { start: now, recorded: 0, suppressed: 0, sample: entry };
      this.#windows.set(name, window);
    }
    if (window.recorded < REJECTIONS_PER_MINUTE) {
      window.recorded++;
      result.push(entry);
    } else window.suppressed++;
    return result;
  }

  /** Aggregates of every window with suppressed records; the throttle is empty afterwards. */
  drain(): ModelCallEntry[] {
    const result: ModelCallEntry[] = [];
    for (const window of this.#windows.values()) {
      const aggregate = this.#aggregate(window);
      if (aggregate) result.push(aggregate);
    }
    this.#windows.clear();
    return result;
  }

  #prune(now: number, result: ModelCallEntry[]) {
    for (const [name, window] of this.#windows)
      if (now - window.start >= 60_000) {
        const aggregate = this.#aggregate(window);
        if (aggregate) result.push(aggregate);
        this.#windows.delete(name);
      }
  }

  #aggregate(window: Window): ModelCallEntry | undefined {
    if (!window.suppressed) return undefined;
    return {
      ...window.sample,
      callId:
        `${window.sample.callId}_x${window.suppressed}` as ModelCallEntry["callId"],
      occurredAt: new Date(window.start).toISOString(),
      error: `${window.suppressed} further rejections for the same key and reason within one minute were not recorded individually`,
    };
  }
}
