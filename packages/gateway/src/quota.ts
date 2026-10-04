// SPDX-License-Identifier: MIT
/**
 * Gateway Key quotas (03 section 2, Magpie `internal/budget` and
 * `gw/key_limit.go`): requests per minute as a token bucket, and budgets per
 * calendar day, week or month in the daemon's local time zone, counted from
 * the committed ledger so they survive a restart.
 *
 * - A call counts in the window it started in. Tokens are uncached input,
 *   output, reasoning and cache writes, and cache reads when the budget says
 *   so; cost is the ledger's estimate, to which a call without a price adds
 *   nothing.
 * - A request admitted holds a reservation until it ends: its body's size in
 *   tokens (four bytes a token) plus the key's mean output per answered call
 *   in the window, and for a cost cap that many tokens at the window's mean
 *   price per token (before any priced call: the model's input price). A
 *   request is let in while used plus reserved is under every cap, so calls
 *   in flight together overshoot by about one call.
 * - A refused request takes nothing, not even a request of its per-minute
 *   bucket; it is told when the window resets.
 * - A cap of 0 refuses every call in its window: the key is kept but
 *   blocked, as a cap of 0 was before budgets.
 */
import type {
  BudgetPeriod,
  BudgetStatus,
  GatewayKeyBudget,
  GatewayKeyId,
  GatewayKeyRecord,
  KeyLimitStatus,
  ModelCallEntry,
  ModelPlaneStore,
} from "@harnesshub/core/model-plane";

/** A refused call: which limit, and when its window frees capacity again. */
export interface QuotaRefusal {
  limit: "requestsPerMinute" | BudgetPeriod;
  retryAfterMs: number;
  /** When the refused budget's window resets (ISO 8601); absent for the per-minute bucket. */
  resetsAt?: string;
  message: string;
}

/** The outcome of {@link Quotas.admit}. */
export type Admission =
  | {
      ok: true;
      /** Gives the reservation back; call it once the call's entry is committed. Idempotent. */
      release(): void;
    }
  | { ok: false; refusal: QuotaRefusal };

/** What a request is reserved by. */
export interface QuotaRequest {
  /** The request body's size in bytes. */
  bytes: number;
  /** USD per million input tokens of the model asked for; read only for a cost cap without a priced call yet. */
  inputPrice?: () => Promise<number | undefined>;
}

/** Ledger sums are read again after this long; committed calls are added in between. */
export const QUOTA_REFRESH_MS = 10_000;

/** The time zone of this process (`TZ`, else the system's). */
export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let found = formatters.get(timeZone);
  if (!found) {
    found = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      weekday: "short",
    });
    formatters.set(timeZone, found);
  }
  return found;
}

/** The wall-clock date and time at `at` in `timeZone`. */
function local(at: number, timeZone: string) {
  const parts = Object.fromEntries(
    formatter(timeZone)
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month) - 1,
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
      parts.weekday ?? "",
    ),
  };
}

/** How far `timeZone` is ahead of UTC at `at`, in milliseconds. */
function offset(at: number, timeZone: string): number {
  const wall = local(at, timeZone);
  const asUtc = Date.UTC(
    wall.year,
    wall.month,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
  );
  return asUtc - Math.floor(at / 1000) * 1000;
}

/** The instant of local midnight on a date (day and month may overflow) in `timeZone`. */
function midnight(
  year: number,
  month: number,
  day: number,
  timeZone: string,
): number {
  const utc = Date.UTC(year, month, day);
  const first = utc - offset(utc, timeZone);
  // Again at the guess, which is right across an offset change that day.
  return utc - offset(first, timeZone);
}

/**
 * The calendar window of `period` that `now` is in, in `timeZone`: a day
 * from midnight, a week from Monday's midnight, a month from the 1st's.
 * `reset` is the next window's start.
 */
export function budgetWindow(
  period: BudgetPeriod,
  now: number,
  timeZone: string,
): { start: number; reset: number } {
  const { year, month, day, weekday } = local(now, timeZone);
  switch (period) {
    case "day":
      return {
        start: midnight(year, month, day, timeZone),
        reset: midnight(year, month, day + 1, timeZone),
      };
    case "week": {
      const back = (weekday + 6) % 7;
      return {
        start: midnight(year, month, day - back, timeZone),
        reset: midnight(year, month, day - back + 7, timeZone),
      };
    }
    case "month":
      return {
        start: midnight(year, month, 1, timeZone),
        reset: midnight(year, month + 1, 1, timeZone),
      };
  }
}

interface Sums {
  start: number;
  reset: number;
  /** Answered calls (status below 400). */
  calls: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  cost: number;
  fetchedAt: number;
}
interface Held {
  n: number;
  tokens: number;
  cost: number;
}
interface Bucket {
  tokens: number;
  at: number;
}

function counted(sums: Sums, budget: GatewayKeyBudget): number {
  return (
    sums.input +
    sums.output +
    sums.reasoning +
    sums.cacheWrite +
    (budget.cacheReads ? sums.cacheRead : 0)
  );
}

/** `$2.5`, `$0.0001`: cents above a dollar, six places below. */
function dollars(amount: number): string {
  return `$${Number(amount.toFixed(amount >= 1 ? 2 : 6))}`;
}

const PERIOD_WORD: Readonly<Record<BudgetPeriod, string>> = {
  day: "today",
  week: "this week",
  month: "this month",
};

/** Quota state of one gateway handler: ledger sums cached per key and window, and the reservations in flight. */
export class Quotas {
  #sums = new Map<string, Sums>();
  #held = new Map<string, Held>();
  #buckets = new Map<GatewayKeyId, Bucket>();
  constructor(
    private readonly store: ModelPlaneStore,
    private readonly clock: () => number,
    /** The IANA zone the budget windows are in; this process's by default. */
    readonly timeZone: string = localTimeZone(),
  ) {}

  /**
   * Check a key's budgets and per-minute bucket for one more request and,
   * when it is admitted, reserve for it and take one request from its
   * bucket. Budgets are checked first, so a refused request takes nothing.
   * Rejects when the ledger cannot be read.
   */
  async admit(
    key: GatewayKeyRecord,
    request: QuotaRequest,
  ): Promise<Admission> {
    const quota = key.quota;
    const budgets = quota?.budgets ?? [];
    if (!quota || (!budgets.length && quota.requestsPerMinute === undefined))
      return { ok: true, release: () => {} };
    const now = this.clock();
    const loaded = await Promise.all(
      budgets.map(async (budget) => ({
        budget,
        sums: await this.#load(key.keyId, budget.period, now),
      })),
    );
    const needsPrice = loaded.some(
      ({ budget, sums }) =>
        budget.costUsd !== undefined &&
        budget.costUsd > 0 &&
        !(sums.cost > 0 && counted(sums, budget) > 0),
    );
    const price = needsPrice ? await request.inputPrice?.() : undefined;
    // From here on nothing awaits: the check and the reservation of one
    // request happen before another request of the key is checked.
    for (const { budget, sums } of loaded) {
      const held = this.#held.get(this.#slot(key.keyId, budget.period));
      const used = counted(sums, budget);
      const overTokens =
        budget.tokens !== undefined &&
        used + (held?.tokens ?? 0) >= budget.tokens;
      const overCost =
        budget.costUsd !== undefined &&
        sums.cost + (held?.cost ?? 0) >= budget.costUsd;
      if (!overTokens && !overCost) continue;
      const what = overTokens
        ? `${used} of its ${budget.tokens} ${budget.cacheReads ? "input, output and cache" : "input, output and cache-write"} tokens`
        : `${dollars(sums.cost)} of its ${dollars(budget.costUsd!)} estimated cost`;
      const spent = overTokens
        ? used >= budget.tokens!
        : sums.cost >= budget.costUsd!;
      const blocked = overTokens ? budget.tokens === 0 : budget.costUsd === 0;
      return {
        ok: false,
        refusal: {
          limit: budget.period,
          retryAfterMs: Math.max(1000, sums.reset - now),
          resetsAt: new Date(sums.reset).toISOString(),
          message: blocked
            ? `Gateway Key ${key.name} has a ${budget.period} budget of ${overTokens ? "0 tokens" : "$0"}, so every call is refused`
            : `Gateway Key ${key.name} has used ${what} ${PERIOD_WORD[budget.period]}${spent ? "" : `, with ${held?.n ?? 0} requests in flight holding the rest`}; it resets at ${new Date(sums.reset).toISOString()}`,
        },
      };
    }
    const perMinute = quota.requestsPerMinute;
    if (perMinute !== undefined) {
      const rate = perMinute / 60_000;
      const previous = this.#buckets.get(key.keyId);
      const tokens = Math.min(
        perMinute,
        previous ? previous.tokens + (now - previous.at) * rate : perMinute,
      );
      if (tokens < 1)
        return {
          ok: false,
          refusal: {
            limit: "requestsPerMinute",
            retryAfterMs: rate > 0 ? Math.ceil((1 - tokens) / rate) : 60_000,
            message: `This Gateway Key is limited to ${perMinute} requests per minute`,
          },
        };
      this.#buckets.set(key.keyId, { tokens: tokens - 1, at: now });
      if (this.#buckets.size > 10_000) this.#buckets.clear();
    }
    const holds: { slot: string; tokens: number; cost: number }[] = [];
    for (const { budget, sums } of loaded) {
      const used = counted(sums, budget);
      const tokens =
        Math.floor(Math.max(0, request.bytes) / 4) +
        (sums.calls > 0
          ? Math.floor((sums.output + sums.reasoning) / sums.calls)
          : 0);
      const cost =
        budget.costUsd === undefined
          ? 0
          : used > 0 && sums.cost > 0
            ? (tokens * sums.cost) / used
            : price !== undefined
              ? (tokens * price) / 1_000_000
              : 0;
      const slot = this.#slot(key.keyId, budget.period);
      const held = this.#held.get(slot) ?? { n: 0, tokens: 0, cost: 0 };
      held.n += 1;
      held.tokens += tokens;
      held.cost += cost;
      this.#held.set(slot, held);
      holds.push({ slot, tokens, cost });
    }
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        for (const hold of holds) {
          const held = this.#held.get(hold.slot);
          if (!held) continue;
          held.n -= 1;
          held.tokens -= hold.tokens;
          held.cost -= hold.cost;
          if (held.n <= 0) this.#held.delete(hold.slot);
        }
      },
    };
  }

  /** Add a committed entry to the cached sums of its key's windows. */
  record(entry: ModelCallEntry): void {
    if (!entry.keyId) return;
    const at = Date.parse(entry.occurredAt);
    for (const period of ["day", "week", "month"] as const) {
      const sums = this.#sums.get(this.#slot(entry.keyId, period));
      if (!sums || at < sums.start || at >= sums.reset) continue;
      const usage = entry.usage;
      if (usage) {
        sums.input += usage.input;
        sums.cacheRead += usage.cacheRead;
        sums.cacheWrite += usage.cacheWrite;
        sums.output += usage.output;
        sums.reasoning += usage.reasoning;
      }
      if (entry.status < 400) sums.calls += 1;
      sums.cost += entry.cost?.amountUsd ?? 0;
    }
  }

  /**
   * The key's limits and what it used of each budget now, read from the
   * ledger afresh, with this handler's requests in flight. Rejects when the
   * ledger cannot be read.
   */
  async status(key: GatewayKeyRecord): Promise<KeyLimitStatus> {
    const now = this.clock();
    const budgets = await Promise.all(
      (key.quota?.budgets ?? []).map(async (budget) => {
        const sums = await this.#read(key.keyId, budget.period, now);
        const held = this.#held.get(this.#slot(key.keyId, budget.period));
        const tokens = counted(sums, budget);
        const status: BudgetStatus = {
          period: budget.period,
          start: new Date(sums.start).toISOString(),
          resetsAt: new Date(sums.reset).toISOString(),
          calls: sums.calls,
          tokens,
          costUsd: sums.cost,
          cacheReads: budget.cacheReads === true,
          inFlight: held?.n ?? 0,
          reservedTokens: held?.tokens ?? 0,
          reservedCostUsd: held?.cost ?? 0,
          spent: false,
        };
        if (budget.tokens !== undefined) {
          status.tokenLimit = budget.tokens;
          status.tokensLeft = Math.max(0, budget.tokens - tokens);
          status.spent ||= tokens >= budget.tokens;
        }
        if (budget.costUsd !== undefined) {
          status.costLimitUsd = budget.costUsd;
          status.costLeftUsd = Math.max(0, budget.costUsd - sums.cost);
          status.spent ||= sums.cost >= budget.costUsd;
        }
        return status;
      }),
    );
    return {
      keyId: key.keyId,
      name: key.name,
      timeZone: this.timeZone,
      ...(key.quota?.requestsPerMinute !== undefined
        ? { requestsPerMinute: key.quota.requestsPerMinute }
        : {}),
      budgets,
    };
  }

  #slot(keyId: string, period: BudgetPeriod): string {
    return `${keyId}\u0000${period}`;
  }

  async #load(
    keyId: GatewayKeyId,
    period: BudgetPeriod,
    now: number,
  ): Promise<Sums> {
    const slot = this.#slot(keyId, period);
    const cached = this.#sums.get(slot);
    if (
      cached &&
      now >= cached.start &&
      now < cached.reset &&
      now - cached.fetchedAt < QUOTA_REFRESH_MS
    )
      return cached;
    const sums = await this.#read(keyId, period, now);
    this.#sums.set(slot, sums);
    if (this.#sums.size > 30_000) this.#sums.clear();
    return sums;
  }

  async #read(
    keyId: GatewayKeyId,
    period: BudgetPeriod,
    now: number,
  ): Promise<Sums> {
    const { start, reset } = budgetWindow(period, now, this.timeZone);
    const [bucket] = await this.store.aggregateUsage(
      { keyId, from: new Date(start).toISOString() },
      "key",
    );
    return {
      start,
      reset,
      calls: bucket ? bucket.calls - bucket.failedCalls : 0,
      input: bucket?.usage.input ?? 0,
      cacheRead: bucket?.usage.cacheRead ?? 0,
      cacheWrite: bucket?.usage.cacheWrite ?? 0,
      output: bucket?.usage.output ?? 0,
      reasoning: bucket?.usage.reasoning ?? 0,
      cost: bucket?.costUsd ?? 0,
      fetchedAt: now,
    };
  }
}
