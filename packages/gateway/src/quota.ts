// SPDX-License-Identifier: MIT
/**
 * Gateway Key quotas (03 section 2): requests per minute as a token bucket
 * (hard), tokens per UTC day and cost per UTC calendar month against the
 * committed ledger, checked before a call is forwarded. The call that
 * crosses a usage threshold finishes; later calls are refused until the
 * window resets. Calls of one key running concurrently are all admitted
 * against the same totals, so a threshold can be passed by up to that many calls.
 */
import type {
  GatewayKeyId,
  GatewayKeyRecord,
  ModelCallEntry,
  ModelPlaneStore,
} from "@harnesshub/core/model-plane";

/** A refused call: which limit, and when its window frees capacity again. */
export interface QuotaRefusal {
  limit: "requestsPerMinute" | "tokensPerDay" | "costPerMonthUsd";
  retryAfterMs: number;
  message: string;
}

/** Ledger totals are read again after this long; committed calls are added in between. */
export const QUOTA_REFRESH_MS = 10_000;

interface Totals {
  /** Start of the UTC day and month the totals belong to. */
  day: number;
  month: number;
  tokens: number;
  cost: number;
  fetchedAt: number;
}
interface Bucket {
  tokens: number;
  at: number;
}

function dayStart(now: number): number {
  return Math.floor(now / 86_400_000) * 86_400_000;
}
function monthStart(now: number): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}
function nextMonth(now: number): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
}
function entryTokens(entry: ModelCallEntry): number {
  const usage = entry.usage;
  return usage
    ? usage.input +
        usage.cacheRead +
        usage.cacheWrite +
        usage.output +
        usage.reasoning
    : 0;
}

/** Quota state of one gateway handler; usage totals are cached per key. */
export class Quotas {
  #totals = new Map<GatewayKeyId, Totals>();
  #buckets = new Map<GatewayKeyId, Bucket>();
  constructor(
    private readonly store: ModelPlaneStore,
    private readonly clock: () => number,
  ) {}

  /**
   * Check a key's quotas for one more call and, when it is admitted, take
   * one request from its per-minute bucket. Usage windows are checked first,
   * so a refused call takes no request. Rejects when the ledger cannot be read.
   */
  async admit(key: GatewayKeyRecord): Promise<QuotaRefusal | undefined> {
    const quota = key.quota;
    if (!quota) return undefined;
    const now = this.clock();
    if (
      quota.tokensPerDay !== undefined ||
      quota.costPerMonthUsd !== undefined
    ) {
      const totals = await this.#load(key.keyId, now);
      if (
        quota.tokensPerDay !== undefined &&
        totals.tokens >= quota.tokensPerDay
      )
        return {
          limit: "tokensPerDay",
          retryAfterMs: dayStart(now) + 86_400_000 - now,
          message: `This Gateway Key used its ${quota.tokensPerDay} tokens for today (UTC)`,
        };
      if (
        quota.costPerMonthUsd !== undefined &&
        totals.cost >= quota.costPerMonthUsd
      )
        return {
          limit: "costPerMonthUsd",
          retryAfterMs: nextMonth(now) - now,
          message: `This Gateway Key reached its cost limit of ${quota.costPerMonthUsd} USD for this month (UTC)`,
        };
    }
    const perMinute = quota.requestsPerMinute;
    if (perMinute === undefined) return undefined;
    const rate = perMinute / 60_000;
    const previous = this.#buckets.get(key.keyId);
    const tokens = Math.min(
      perMinute,
      previous ? previous.tokens + (now - previous.at) * rate : perMinute,
    );
    if (tokens < 1)
      return {
        limit: "requestsPerMinute",
        retryAfterMs: rate > 0 ? Math.ceil((1 - tokens) / rate) : 60_000,
        message: `This Gateway Key is limited to ${perMinute} requests per minute`,
      };
    this.#buckets.set(key.keyId, { tokens: tokens - 1, at: now });
    if (this.#buckets.size > 10_000) this.#buckets.clear();
    return undefined;
  }

  /** Add a committed entry to its key's cached totals. */
  record(entry: ModelCallEntry): void {
    if (!entry.keyId) return;
    const totals = this.#totals.get(entry.keyId);
    if (!totals) return;
    const at = Date.parse(entry.occurredAt);
    if (at >= totals.day) totals.tokens += entryTokens(entry);
    if (at >= totals.month) totals.cost += entry.cost?.amountUsd ?? 0;
  }

  async #load(keyId: GatewayKeyId, now: number): Promise<Totals> {
    const day = dayStart(now);
    const month = monthStart(now);
    const cached = this.#totals.get(keyId);
    if (
      cached &&
      cached.day === day &&
      cached.month === month &&
      now - cached.fetchedAt < QUOTA_REFRESH_MS
    )
      return cached;
    const [today, thisMonth] = await Promise.all([
      this.store.aggregateUsage(
        { keyId, from: new Date(day).toISOString() },
        "key",
      ),
      this.store.aggregateUsage(
        { keyId, from: new Date(month).toISOString() },
        "key",
      ),
    ]);
    const totals: Totals = {
      day,
      month,
      tokens: today.reduce(
        (sum, bucket) =>
          sum +
          bucket.usage.input +
          bucket.usage.cacheRead +
          bucket.usage.cacheWrite +
          bucket.usage.output +
          bucket.usage.reasoning,
        0,
      ),
      cost: thisMonth.reduce((sum, bucket) => sum + bucket.costUsd, 0),
      fetchedAt: now,
    };
    this.#totals.set(keyId, totals);
    if (this.#totals.size > 10_000) this.#totals.clear();
    return totals;
  }
}
