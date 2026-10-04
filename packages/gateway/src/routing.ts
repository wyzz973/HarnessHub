// SPDX-License-Identifier: MIT
/**
 * Candidate selection, per-credential breakers and the retry table of the
 * shared gateway (03 section 5, with Magpie's failure kinds and rests).
 * Everything here is in memory and owned by one handler; nothing is
 * persisted, and `least-used` starts from a bounded read of the ledger.
 */
import type { LogSink } from "@harnesshub/core/logging";
import {
  DEFAULT_RETRY_POLICY,
  type AllowanceReading,
  type ModelPlaneStore,
  type ModelRef,
  type ProviderConfig,
  type ProviderCredential,
  type ProviderModel,
  type RetryPolicy,
  type RouteGroup,
  type RouteGroupId,
  type WireProtocol,
} from "@harnesshub/core/model-plane";
import { accountUsable } from "@harnesshub/core/subscriptions";
import { COPILOT_ENDPOINT } from "./copilot.js";
import type { Failure } from "./output.js";

/** One routing candidate: a Model Ref served through one credential and one upstream endpoint. */
export interface Candidate {
  provider: ProviderConfig;
  credential: ProviderCredential;
  /** Metadata when the provider lists the model; unlisted models route with unknown metadata. */
  model: ProviderModel | undefined;
  ref: ModelRef;
  wireModel: string;
  mode: "passthrough" | "translated";
  upstream: WireProtocol;
  /** Base URL of the upstream endpoint, without the operation path. */
  endpoint: string;
}

/**
 * Upstream model name: the model's own `wire`, else the provider's `wire`
 * entry for the id, else its `*` entry with `*` replaced by the id, else the id.
 */
export function wireName(provider: ProviderConfig, modelId: string): string {
  const listed = provider.models.list.find((model) => model.id === modelId);
  if (listed?.wire) return listed.wire;
  const exact = provider.wire?.[modelId];
  if (exact !== undefined) return exact;
  const pattern = provider.wire?.["*"];
  return pattern === undefined ? modelId : pattern.replaceAll("*", modelId);
}

function validFor(credential: ProviderCredential, protocol: WireProtocol) {
  return (
    credential.enabled &&
    (credential.protocols === undefined ||
      credential.protocols.includes(protocol))
  );
}

/**
 * The candidate of a provider without credentials (a local server such as
 * Ollama): requests go out without an authentication header.
 */
export const KEYLESS_CREDENTIAL: ProviderCredential = Object.freeze({
  id: "keyless" as ProviderCredential["id"],
  name: "keyless",
  ref: Object.freeze({ kind: "env", value: "" }),
  enabled: true,
}) as ProviderCredential;

/** Upstream protocols tried, in order, when neither passthrough nor Chat is possible. */
const TRANSLATION_TARGETS = ["anthropic", "responses", "gemini"] as const;

/**
 * Candidates of one Model Ref for an inbound protocol, one per enabled
 * credential in configuration order. A credential serves the inbound
 * protocol natively (passthrough) when the provider declares that endpoint,
 * is not `translateOnly` and the credential is valid for it; otherwise it is
 * translated to the provider's Chat endpoint, else to its Anthropic,
 * Responses or Gemini endpoint in that order. Credentials valid for none of
 * the provider's endpoints are reported in `skipped`. A provider without
 * credentials has one keyless candidate.
 */
export function modelCandidates(
  provider: ProviderConfig,
  modelId: string,
  inbound: WireProtocol,
): { candidates: Candidate[]; skipped: string[] } {
  const ref = `${provider.id}/${modelId}` as ModelRef;
  const model = provider.models.list.find((entry) => entry.id === modelId);
  const wireModel = wireName(provider, modelId);
  const candidates: Candidate[] = [];
  const skipped: string[] = [];
  const credentials = provider.credentials.length
    ? provider.credentials
    : [KEYLESS_CREDENTIAL];
  for (const credential of credentials) {
    if (!credential.enabled) continue;
    if (provider.subscription) {
      // An account serves only after its notice was accepted, signed in, and
      // always translated: its backend takes a constrained request shape.
      const responses = provider.endpoints.responses;
      if (!accountUsable(credential.account))
        skipped.push(
          `${ref} via ${credential.id}: the account is signed out or has not accepted the current risk notice`,
        );
      else if (provider.subscription.backend === "copilot")
        // The Copilot bridge takes the Chat request.
        candidates.push({
          provider,
          credential,
          model,
          ref,
          wireModel,
          mode: "translated",
          upstream: "chat",
          endpoint: COPILOT_ENDPOINT,
        });
      else if (!responses)
        skipped.push(
          `${ref}: the subscription provider has no Responses endpoint`,
        );
      else
        candidates.push({
          provider,
          credential,
          model,
          ref,
          wireModel,
          mode: "translated",
          upstream: "responses",
          endpoint: responses,
        });
      continue;
    }
    const native = provider.endpoints[inbound];
    const chat = provider.endpoints.chat;
    const base = { provider, credential, model, ref, wireModel };
    if (native && !provider.translateOnly && validFor(credential, inbound))
      candidates.push({
        ...base,
        mode: "passthrough",
        upstream: inbound,
        endpoint: native,
      });
    else if (chat && validFor(credential, "chat"))
      candidates.push({
        ...base,
        mode: "translated",
        upstream: "chat",
        endpoint: chat,
      });
    else {
      const target = TRANSLATION_TARGETS.find(
        (protocol) =>
          provider.endpoints[protocol] !== undefined &&
          validFor(credential, protocol),
      );
      if (target)
        candidates.push({
          ...base,
          mode: "translated",
          upstream: target,
          endpoint: provider.endpoints[target]!,
        });
      else
        skipped.push(
          `${ref} via ${credential.id}: the credential is valid for none of the provider's endpoints`,
        );
    }
  }
  return { candidates, skipped };
}

/** The group's retry policy over the defaults; `totalAttempts` never exceeds the hard cap of 8. */
export function retryPolicy(
  overrides: Partial<RetryPolicy> | undefined,
): RetryPolicy {
  const policy = { ...DEFAULT_RETRY_POLICY, ...overrides };
  return { ...policy, totalAttempts: Math.min(policy.totalAttempts, 8) };
}
/** Retry waits of one call stop once they would pass this total. */
export const RETRY_BUDGET_MS = 30_000;

/** Tokens a credential served count for half after an hour (Magpie `usageHalfLife`). */
export const USAGE_HALF_LIFE_MS = 3_600_000;
/** `least-used` starts from the ledger: calls this recent, at most this many. */
export const USAGE_SEED_MS = 8 * 3_600_000;
export const USAGE_SEED_CALLS = 5_000;

/** Identity of a credential across providers: its rest, slots and usage. */
export function credentialKey(candidate: Candidate): string {
  return `${candidate.provider.id}\u0000${candidate.credential.id}`;
}

/** One rate-limit window an upstream reported: what was left until it resets. */
interface RateWindow {
  limit: number;
  remaining: number;
  /** Epoch milliseconds. */
  reset: number;
}

/**
 * A reset or wait in a header value: an RFC 3339 or HTTP date, a duration
 * such as `6m0s` or `250ms`, Unix seconds (above 1e9), or seconds from now.
 * Epoch milliseconds, or undefined when the value is none of these.
 */
function resetAt(value: string, now: number): number | undefined {
  const text = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const number = Number(text);
    return number > 1e9 ? number * 1000 : now + number * 1000;
  }
  const units: Record<string, number> = {
    h: 3_600_000,
    m: 60_000,
    s: 1000,
    ms: 1,
    us: 0.001,
    µs: 0.001,
    ns: 0.000001,
  };
  if (/^(?:\d+(?:\.\d+)?(?:h|ms|m|s|us|µs|ns))+$/.test(text)) {
    let ms = 0;
    for (const [, amount, unit] of text.matchAll(
      /(\d+(?:\.\d+)?)(h|ms|m|s|us|µs|ns)/g,
    ))
      ms += Number(amount) * units[unit!]!;
    return now + ms;
  }
  const date = Date.parse(text);
  return Number.isNaN(date) ? undefined : date;
}

/**
 * The rate-limit windows of an answer's headers: `x-ratelimit-limit-requests`
 * with its `remaining` and `reset` (OpenAI), `anthropic-ratelimit-tokens-limit`
 * and so on. A window counts only with a limit, a remainder and a reset.
 */
function rateWindows(
  headers: Headers,
  now: number,
): (RateWindow & { name: string })[] {
  const parts = new Map<string, Partial<RateWindow>>();
  for (const [name, value] of headers) {
    const at = name.indexOf("ratelimit-");
    if (at < 0) continue;
    const segments = name.slice(at + "ratelimit-".length).split("-");
    const role = segments.find(
      (segment) =>
        segment === "limit" || segment === "remaining" || segment === "reset",
    ) as keyof RateWindow | undefined;
    if (!role) continue;
    const window = segments.filter((segment) => segment !== role).join("-");
    const entry = parts.get(window) ?? {};
    const number = role === "reset" ? resetAt(value, now) : Number(value);
    if (number !== undefined && Number.isFinite(number)) entry[role] = number;
    parts.set(window, entry);
  }
  return [...parts.entries()]
    .map(([name, window]) => ({ ...window, name: name || "requests" }))
    .filter(
      (window): window is RateWindow & { name: string } =>
        window.limit !== undefined &&
        window.limit > 0 &&
        window.remaining !== undefined &&
        window.reset !== undefined,
    );
}

/** A reading without a renewal time counts for this long after it was taken. */
const READING_TTL_MS = 24 * 3_600_000;
/** Allowance shares: below `low` an account is fine, from `spent` on it is all but used up (Magpie). */
export const SHARE_LOW = 90;
export const SHARE_SPENT = 98;
/** Windows of at least this span set the pace; an hour-long pace without one spreads over a week. */
const BUDGET_SPAN_S = 86_400;
const WEEK_HOURS = 168;

/** A reading as the router keeps it: whose it is, and its window. */
export interface StoredReading {
  provider: string;
  credential: string;
  reading: AllowanceReading;
}

/**
 * Candidate order per strategy. `order` keeps the configuration; `rotate`
 * starts one member later on every call; `latency` prefers the lowest moving
 * average of first-content time, members with fewer than 5 samples first;
 * `least-used` (Magpie `usage`) ranks the candidates themselves, see
 * {@link weigh}. Usage and latency are counted from calls through this
 * handler, `least-used` also from the ledger it was {@link seed}ed with.
 */
export class Router {
  #rotation = new Map<RouteGroupId, number>();
  /** Credential → decayed tokens at a time. */
  #served = new Map<string, { tokens: number; at: number }>();
  /** Credential → window name → its latest allowance reading. */
  #readings = new Map<string, Map<string, AllowanceReading>>();
  /** Readings changed since the last {@link takeChanges}. */
  #changed = false;
  #latency = new Map<string, { average: number; samples: number }>();
  #seeding: Promise<void> | undefined;
  constructor(private readonly clock: () => number) {}

  /** Member order; a `least-used` group keeps its configured order here. */
  order(group: RouteGroup): ModelRef[] {
    const members = [...group.members];
    switch (group.strategy) {
      case "order":
      case "least-used":
      case "smart":
      case "pace":
        return members;
      case "rotate": {
        const turn = this.#rotation.get(group.id) ?? 0;
        this.#rotation.set(group.id, turn + 1);
        const start = members.length ? turn % members.length : 0;
        return [...members.slice(start), ...members.slice(0, start)];
      }
      case "latency": {
        const score = (ref: ModelRef) => {
          const sample = this.#latency.get(ref);
          return !sample || sample.samples < 5 ? -1 : sample.average;
        };
        return members
          .map((ref, index) => ({ ref, index, score: score(ref) }))
          .sort((a, b) => a.score - b.score || a.index - b.index)
          .map(({ ref }) => ref);
      }
    }
  }

  /**
   * The candidates of a `least-used`, `smart` or `pace` group, every member's
   * credentials together; other strategies are returned unchanged.
   * - `least-used` (Magpie `usage`): the least share of an allowance used
   *   first, then the fewest tokens served, each halving per hour.
   * - `smart`: by share, fine (below {@link SHARE_LOW}), low, then spent
   *   (from {@link SHARE_SPENT}); among the fine, a subscription account with
   *   no reading yet first (it learns its allowance by answering), then the
   *   one whose windows renew soonest, the longest window first, compared to
   *   the hour, an unknown renewal after the known; low and spent by share.
   * - `pace`: by the same tiers; among the fine, learning accounts first, then
   *   the most allowance left per hour until its renewal, over windows of a
   *   day or more (an account without one: what it has left over a week; a
   *   key: 0), in bands of 90% of each band's best, then the fewest tokens.
   * Ties keep the configured order, which keeps prompt caches warm.
   */
  weigh(group: RouteGroup | undefined, candidates: Candidate[]): Candidate[] {
    const strategy = group?.strategy;
    if (
      (strategy !== "least-used" &&
        strategy !== "smart" &&
        strategy !== "pace") ||
      candidates.length < 2
    )
      return candidates;
    const now = this.clock();
    const ranked = candidates.map((candidate, index) => ({
      candidate,
      index,
      share: this.share(candidate),
      tokens: this.tokens(candidate),
      learns:
        candidate.provider.subscription !== undefined &&
        this.readings(candidate).length === 0,
    }));
    type Ranked = (typeof ranked)[number];
    const order = (list: Ranked[]) => list.map(({ candidate }) => candidate);
    if (strategy === "least-used")
      return order(
        ranked.sort(
          (a, b) =>
            a.share - b.share || a.tokens - b.tokens || a.index - b.index,
        ),
      );
    const fine = ranked.filter((entry) => entry.share < SHARE_LOW);
    const low = ranked.filter(
      (entry) => entry.share >= SHARE_LOW && entry.share < SHARE_SPENT,
    );
    const spent = ranked.filter((entry) => entry.share >= SHARE_SPENT);
    const byShare = (a: Ranked, b: Ranked) =>
      a.share - b.share || a.index - b.index;
    low.sort(byShare);
    spent.sort(byShare);
    if (strategy === "smart") {
      const renewals = new Map(
        fine.map((entry) => [entry, this.#renewals(entry.candidate, now)]),
      );
      fine.sort((a, b) => {
        if (a.learns !== b.learns) return a.learns ? -1 : 1;
        const ra = renewals.get(a)!;
        const rb = renewals.get(b)!;
        for (let k = 0; k < Math.max(ra.length, rb.length); k++) {
          const x = ra[k] ?? 0;
          const y = rb[k] ?? 0;
          if (x === y) continue;
          if (x === 0 || y === 0) return x === 0 ? 1 : -1;
          return x - y;
        }
        return a.index - b.index;
      });
      return order([...fine, ...low, ...spent]);
    }
    const paces = new Map(
      fine.map((entry) => [entry, this.#pace(entry.candidate, now)]),
    );
    const learning = fine.filter((entry) => entry.learns);
    const rest = fine
      .filter((entry) => !entry.learns)
      .sort((a, b) => paces.get(b)! - paces.get(a)! || a.index - b.index);
    const banded: Ranked[] = [];
    let band: Ranked[] = [];
    let top = Infinity;
    const close = () =>
      banded.push(
        ...band.sort((a, b) => a.tokens - b.tokens || a.index - b.index),
      );
    for (const entry of rest) {
      const pace = paces.get(entry)!;
      if (band.length && pace < top * 0.9) {
        close();
        band = [];
      }
      if (!band.length) top = pace;
      band.push(entry);
    }
    close();
    return order([
      ...learning.sort((a, b) => a.index - b.index),
      ...banded,
      ...low,
      ...spent,
    ]);
  }

  /**
   * The candidate's current readings: windows not yet renewed, and readings
   * without a renewal time for a day after they were taken.
   */
  readings(candidate: Candidate): AllowanceReading[] {
    const now = this.clock();
    return [
      ...(this.#readings.get(credentialKey(candidate))?.values() ?? []),
    ].filter((reading) =>
      reading.resetsAt !== undefined
        ? Date.parse(reading.resetsAt) > now
        : Date.parse(reading.observedAt) + READING_TTL_MS > now,
    );
  }

  /** Whole percent of the fullest current allowance window; 0 without readings. */
  share(candidate: Candidate): number {
    let used = 0;
    for (const reading of this.readings(candidate))
      used = Math.max(used, Math.floor(reading.usedPercent));
    return Math.min(100, Math.max(0, used));
  }

  /** Renewal times per window, longest window first, to the hour; 0 when unknown. */
  #renewals(candidate: Candidate, now: number): number[] {
    return [...(this.#readings.get(credentialKey(candidate))?.values() ?? [])]
      .sort((a, b) => (b.spanSeconds ?? 0) - (a.spanSeconds ?? 0))
      .map((reading) => {
        const at =
          reading.resetsAt !== undefined ? Date.parse(reading.resetsAt) : NaN;
        const renews =
          at > now
            ? at
            : reading.spanSeconds !== undefined
              ? now + reading.spanSeconds * 1000
              : 0;
        return renews && Math.floor(renews / 3_600_000) * 3_600_000;
      });
  }

  /**
   * Allowance left per hour until it renews (Magpie `Pace`): the tightest of
   * the windows of a day or more, a passed or unknown renewal counting a full
   * span from now; without such a window, what the account has left over a
   * week; a credential that is no subscription account, 0.
   */
  #pace(candidate: Candidate, now: number): number {
    if (!candidate.provider.subscription) return 0;
    const all = [
      ...(this.#readings.get(credentialKey(candidate))?.values() ?? []),
    ];
    const budget = all.filter(
      (reading) => (reading.spanSeconds ?? 0) >= BUDGET_SPAN_S,
    );
    if (!budget.length) return (100 - this.share(candidate)) / WEEK_HOURS;
    let pace = Infinity;
    for (const reading of budget) {
      const at =
        reading.resetsAt !== undefined ? Date.parse(reading.resetsAt) : NaN;
      const current = at > now;
      const hours = current
        ? (at - now) / 3_600_000
        : reading.spanSeconds! / 3600;
      const left = 100 - (current ? reading.usedPercent : 0);
      pace = Math.min(pace, left / Math.max(hours, 1));
    }
    return pace;
  }

  /**
   * Readings from a source other than the answer's headers, such as an
   * official client's quota events; each replaces the reading of its window.
   */
  report(
    candidate: Pick<Candidate, "provider" | "credential">,
    readings: readonly AllowanceReading[],
  ): void {
    if (!readings.length) return;
    const key = credentialKey(candidate as Candidate);
    const windows = this.#readings.get(key) ?? new Map();
    for (const reading of readings) windows.set(reading.window, reading);
    this.#readings.set(key, windows);
    this.#changed = true;
  }

  /** Every reading, for persisting the last values. */
  snapshot(): StoredReading[] {
    const stored: StoredReading[] = [];
    for (const [key, windows] of this.#readings) {
      const [provider, credential] = key.split("\u0000") as [string, string];
      for (const reading of windows.values())
        stored.push({ provider, credential, reading });
    }
    return stored;
  }

  /** Readings persisted earlier; newer readings already taken win. */
  restore(stored: readonly StoredReading[]): void {
    for (const { provider, credential, reading } of stored) {
      const key = `${provider}\u0000${credential}`;
      const windows = this.#readings.get(key) ?? new Map();
      const known = windows.get(reading.window);
      if (
        !known ||
        Date.parse(known.observedAt) < Date.parse(reading.observedAt)
      )
        windows.set(reading.window, reading);
      this.#readings.set(key, windows);
    }
  }

  /** Whether readings changed since the last call. */
  takeChanges(): boolean {
    const changed = this.#changed;
    this.#changed = false;
    return changed;
  }

  /** Tokens the candidate's credential served, halving per {@link USAGE_HALF_LIFE_MS}. */
  tokens(candidate: Candidate): number {
    return this.#decayed(credentialKey(candidate), this.clock());
  }

  #decayed(key: string, now: number): number {
    const served = this.#served.get(key);
    return served
      ? served.tokens * 2 ** (-(now - served.at) / USAGE_HALF_LIFE_MS)
      : 0;
  }

  #add(key: string, tokens: number, at: number): void {
    const now = this.clock();
    this.#served.set(key, {
      tokens:
        this.#decayed(key, now) +
        tokens * 2 ** (-(now - at) / USAGE_HALF_LIFE_MS),
      at: now,
    });
  }

  /** The rate-limit headers of any answer from the candidate's upstream, as readings of their windows. */
  observe(candidate: Candidate, headers: Headers): void {
    const now = this.clock();
    this.report(
      candidate,
      rateWindows(headers, now).map((window) => ({
        window: window.name,
        usedPercent: Math.min(
          100,
          Math.max(
            0,
            ((window.limit - Math.max(0, window.remaining)) / window.limit) *
              100,
          ),
        ),
        resetsAt: new Date(window.reset).toISOString(),
        observedAt: new Date(now).toISOString(),
      })),
    );
  }

  /**
   * Record a successful call: its tokens (at least 1, it answered) for
   * `least-used`, its first-content time for `latency`.
   */
  record(
    candidate: Candidate,
    tokens: number,
    firstContentMs: number | undefined,
  ): void {
    this.#add(credentialKey(candidate), Math.max(1, tokens), this.clock());
    if (firstContentMs === undefined) return;
    const ref = candidate.ref;
    const sample = this.#latency.get(ref);
    // An exponential average over roughly the last 50 calls.
    const alpha = 2 / 51;
    this.#latency.set(
      ref,
      sample
        ? {
            average: sample.average + alpha * (firstContentMs - sample.average),
            samples: sample.samples + 1,
          }
        : { average: firstContentMs, samples: 1 },
    );
  }

  /**
   * Add the tokens of the successful calls in the ledger's last
   * {@link USAGE_SEED_MS}, at most {@link USAGE_SEED_CALLS} of them, to the
   * usage counts. Runs once; every caller gets the same promise, which
   * never rejects: a failed read is logged and leaves the counts as they are.
   */
  seed(store: ModelPlaneStore, log: LogSink): Promise<void> {
    this.#seeding ??= (async () => {
      const now = this.clock();
      const from = new Date(now - USAGE_SEED_MS).toISOString();
      let cursor: string | undefined;
      let read = 0;
      try {
        do {
          const page = await store.listModelCalls(
            { from },
            {
              limit: Math.min(1000, USAGE_SEED_CALLS - read),
              ...(cursor === undefined ? {} : { cursor }),
            },
          );
          for (const entry of page.items) {
            const at = Date.parse(entry.occurredAt);
            if (
              entry.status >= 400 ||
              !entry.provider ||
              !entry.credentialId ||
              !entry.usage ||
              at < now - USAGE_SEED_MS
            )
              continue;
            const usage = entry.usage;
            this.#add(
              `${entry.provider}\u0000${entry.credentialId}`,
              Math.max(
                1,
                usage.input +
                  usage.cacheRead +
                  usage.cacheWrite +
                  usage.output +
                  usage.reasoning,
              ),
              Math.min(at, now),
            );
          }
          read += page.items.length;
          cursor = page.nextCursor;
        } while (cursor !== undefined && read < USAGE_SEED_CALLS);
      } catch (error) {
        log.info("gateway.usage.seed_failed", {
          error:
            error instanceof Error ? error.message.slice(0, 200) : "unknown",
        });
      }
    })();
    return this.#seeding;
  }
}

/** What one failed attempt does to its credential's breaker. */
export type BreakerEffect =
  | { kind: "none" }
  | { kind: "count" }
  | { kind: "cooldown"; ms: number }
  | { kind: "auth" }
  | { kind: "model"; ms: number };

/**
 * Why an upstream refused, as it bears on routing (Magpie `failure`):
 * `proxy` — a proxy in front of the upstream refused the connection;
 * `verify` — the vendor wants the account verified; `auth` — the credential
 * is not accepted; `credit` — no money left; `quota` — the plan's allowance
 * is used up; `rate` — a short rate limit; `model` — this credential or
 * endpoint does not serve the model; `other` — the upstream failed or timed
 * out; `request` — the request itself is at fault (context overflow included).
 */
export type FailureKind =
  | "proxy"
  | "verify"
  | "auth"
  | "credit"
  | "quota"
  | "rate"
  | "model"
  | "other"
  | "request";

/**
 * The words by which vendors say why they refused when the status does not
 * say it (Magpie `internal/gateway/routing.go` and `fallback.go`), in one
 * table for {@link failureKind} and its tests.
 */
export const FAILURE_WORDS = {
  /** No money left on the account or key. */
  credit:
    /insufficient.?(?:balance|credit|fund)|balance|credit|billing|payment|arrear|overdue|suspended|余额|欠费|充值|账户.*(?:不足|停)/i,
  /** OpenAI's code for an account without credit, sent with 429. */
  noCredit: /insufficient_quota/,
  /** The plan's allowance is used up for now. */
  usedUp:
    /quota|usage.?limit|limit.?reached|hit your .*limit|limit.{0,24}resets|exceeded.*(?:plan|limit)|额度|用量|套餐|上限/i,
  /** A short rate limit, requests or tokens per second or minute. */
  rate: /rate.?limit|too many requests|per.?(?:second|sec|minute|min)\b|\b[rt]pm\b|频率|太频繁/i,
  /** A 429 that names the plan's own allowance, rate words or not. */
  planned:
    /quota|usage.?limit|hit your .*limit|limit.{0,24}resets|per.?(?:day|week|month)|daily|weekly|monthly|额度|用量|套餐/i,
  /** The connection through a proxy failed (Go's error text, as a relay passes it on). */
  proxy: /proxyconnect |socks connect /,
  /** Google's refusal until the account is verified. */
  verify:
    /VALIDATION_REQUIRED|verify your account|account verification required/i,
  /** The model is not served by this credential or endpoint. */
  modelMissing:
    /model[^.]{0,80}(?:not (?:found|exist|available|supported|enabled|activated|accessible|allowed)|does ?n[o']t exist|unavailable|unsupported)|no such model|unknown model|unsupported model|model_not_found|invalid model|模型.{0,12}(?:不存在|不支持|无权|未开通)/i,
} as const;

/**
 * The kind of an upstream refusal from its status and text (the error body,
 * or the message of an in-stream error), checked in Magpie's order: a 502
 * from a proxy; a verification demand on 401 or 403; no credit (402, credit
 * words on any status but 429, or `insufficient_quota`); a 429 with rate
 * words and no plan words; a used-up allowance (used-up words, or a 429 with
 * plan words); any other 429 as a rate limit. Then, for HarnessHub's
 * breaker: 401 and 403 as `auth`; 404 or model-missing words on 400 and 422
 * as `model`; 408 and 5xx as `other`; everything else as `request`. A
 * context overflow is a `request` failure; the caller checks it first.
 */
export function failureKind(status: number, text: string): FailureKind {
  const words = FAILURE_WORDS;
  if (status === 502 && words.proxy.test(text)) return "proxy";
  if ((status === 401 || status === 403) && words.verify.test(text))
    return "verify";
  if (
    status === 402 ||
    (status !== 429 && words.credit.test(text)) ||
    words.noCredit.test(text)
  )
    return "credit";
  if (status === 429 && words.rate.test(text) && !words.planned.test(text))
    return "rate";
  if (words.usedUp.test(text) || (status === 429 && words.planned.test(text)))
    return "quota";
  if (status === 429) return "rate";
  if (status === 401 || status === 403) return "auth";
  if (
    status === 404 ||
    ((status === 400 || status === 422) && words.modelMissing.test(text))
  )
    return "model";
  if (status === 408 || status >= 500) return "other";
  return "request";
}

/** The ledger's error class of an upstream failure of this kind. */
export function failureClass(
  kind: FailureKind,
  status: number,
  overflow: boolean,
): string {
  switch (kind) {
    case "proxy":
      return "proxy_failed";
    case "verify":
      return "verification_required";
    case "auth":
      return "auth_failed";
    case "credit":
      return "insufficient_balance";
    case "quota":
      return "quota_exhausted";
    case "rate":
      return "rate_limited";
    case "model":
      return "model_not_found";
    case "other":
      return status === 408 || status === 504
        ? "upstream_timeout"
        : "upstream_unavailable";
    case "request":
      return overflow ? "context_length_exceeded" : "upstream_rejected";
  }
}

/** A failed attempt that wrote nothing to the client. */
export interface AttemptError {
  failure: Failure;
  errorClass: string;
  source: "gateway" | "upstream";
  /** `local`: a gateway-side condition of this candidate (busy, credential, patch). */
  phase: "connect" | "headers" | "response" | "local" | "cancelled";
  /** Upstream HTTP status, or the status an in-stream error maps to. */
  status?: number;
  /** Set for upstream answers (`response`); connection failures and timeouts are `other`. */
  kind?: FailureKind;
  /** The vendor's wait from the headers (`retryAfter`). */
  retryAfterMs?: number;
  /** When a used-up allowance comes back, as the vendor's body says (`resetIn`). */
  resetMs?: number;
}

export interface Classification {
  /** Retry the last candidate left: `once` at most one time. */
  retry: "no" | "yes" | "once";
  failover: boolean;
  breaker: BreakerEffect;
}

/** How long a failure rests its credential, by kind (Magpie `restAfterMarked`). */
export const REST_MS = {
  verify: 30 * 60_000,
  credit: 30 * 60_000,
  /** A used-up allowance whose reset the vendor did not say. */
  quota: 15 * 60_000,
  /** The longest a used-up allowance rests: a week's window and a day. */
  quotaMax: 8 * 24 * 3_600_000,
  /** A rate limit without a wait in its headers. */
  rate: 60_000,
  /** 404 and model-missing: only that credential and model. */
  model: 10 * 60_000,
} as const;

const TRANSIENT = new Set([408, 500, 502, 503, 504, 529]);
const OPEN_MAX_MS = 600_000;

/**
 * What a failed attempt means for routing. Connection failures, timeouts and
 * the transient statuses (408, 500, 502, 503, 504, 529) count towards the
 * breaker and may be retried; a header timeout at most once. `rate` rests the
 * credential for the vendor's wait, else a minute, and may be retried; `quota`
 * rests until the vendor's stated reset, else 15 minutes, at most 8 days;
 * `credit` and `verify` rest 30 minutes; `auth` rests until the credential
 * changes or 10 minutes pass; `model` marks the credential and model for 10
 * minutes; `proxy` rests nothing. All of these fail over; a `request` failure
 * is returned as it is. Retries apply only to the last candidate left.
 */
export function classify(error: AttemptError): Classification {
  switch (error.phase) {
    case "cancelled":
      return { retry: "no", failover: false, breaker: { kind: "none" } };
    case "local":
      return { retry: "no", failover: true, breaker: { kind: "none" } };
    case "connect":
      return { retry: "yes", failover: true, breaker: { kind: "count" } };
    case "headers":
      return { retry: "once", failover: true, breaker: { kind: "count" } };
    case "response":
      break;
  }
  const kind =
    error.kind ??
    (error.status === undefined
      ? "other"
      : failureKind(error.status, error.failure.message));
  const failover = (
    breaker: BreakerEffect,
    retry: Classification["retry"] = "no",
  ): Classification => ({ retry, failover: true, breaker });
  switch (kind) {
    case "proxy":
      return failover({ kind: "none" });
    case "verify":
      return failover({ kind: "cooldown", ms: REST_MS.verify });
    case "auth":
      return failover({ kind: "auth" });
    case "credit":
      return failover({ kind: "cooldown", ms: REST_MS.credit });
    case "quota":
      return failover({
        kind: "cooldown",
        ms: Math.min(
          error.resetMs ?? error.retryAfterMs ?? REST_MS.quota,
          REST_MS.quotaMax,
        ),
      });
    case "rate":
      return failover(
        { kind: "cooldown", ms: error.retryAfterMs ?? REST_MS.rate },
        "yes",
      );
    case "model":
      return failover({ kind: "model", ms: REST_MS.model });
    case "other":
      return failover(
        { kind: "count" },
        error.status === undefined || TRANSIENT.has(error.status)
          ? "yes"
          : "no",
      );
    case "request":
      return { retry: "no", failover: false, breaker: { kind: "none" } };
  }
}

/** The wait before the n-th retry (from 0): `baseBackoffMs × 2^n`, so 1, 2 and 4 s by default. */
export function backoff(policy: RetryPolicy, retry: number): number {
  return policy.baseBackoffMs * 2 ** retry;
}

/** The longest wait a vendor's headers are trusted with (Magpie `longestWait`). */
const LONGEST_WAIT_MS = 3_600_000;

/**
 * The vendor's wait in milliseconds, at most an hour: `retry-after-ms`, else
 * `retry-after` (seconds or an HTTP date), else the latest reset among the
 * headers that name a rate limit's reset (`x-ratelimit-reset-requests: 6m0s`,
 * `anthropic-ratelimit-tokens-reset: <RFC 3339>`). Undefined when none says.
 */
export function retryAfter(headers: Headers, now: number): number | undefined {
  const ms = headers.get("retry-after-ms");
  let wait: number | undefined;
  if (ms !== null && /^\d+(?:\.\d+)?$/.test(ms.trim()))
    wait = Math.ceil(Number(ms));
  const value = headers.get("retry-after")?.trim();
  if (wait === undefined && value) {
    if (/^\d+(?:\.\d+)?$/.test(value)) wait = Math.ceil(Number(value) * 1000);
    else {
      const date = Date.parse(value);
      if (!Number.isNaN(date)) wait = Math.max(0, date - now);
    }
  }
  if (wait === undefined)
    for (const [name, text] of headers) {
      if (!name.includes("ratelimit") || !name.includes("reset")) continue;
      const at = resetAt(text, now);
      if (at !== undefined && at > now)
        wait = Math.max(wait ?? 0, Math.ceil(at - now));
    }
  return wait === undefined ? undefined : Math.min(wait, LONGEST_WAIT_MS);
}

/**
 * When a used-up allowance comes back, as the refusal's body says, in
 * milliseconds from `now`: Claude Code's `limit reached|<unix>`, ChatGPT's
 * `error.resets_at` (Unix seconds) or `error.resets_in_seconds`, or Google's
 * `RetryInfo.retryDelay` (`"20s"`). Undefined when it says none of these.
 */
export function resetIn(body: string, now: number): number | undefined {
  const claude = /limit reached\|(\d{10})\b/i.exec(body);
  if (claude && Number(claude[1]) * 1000 > now)
    return Number(claude[1]) * 1000 - now;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const error = (parsed as { error?: unknown } | null)?.error;
  if (typeof error !== "object" || error === null) return undefined;
  const {
    resets_at: at,
    resets_in_seconds: seconds,
    details,
  } = error as Record<string, unknown>;
  if (typeof at === "number" && at * 1000 > now) return at * 1000 - now;
  if (typeof seconds === "number" && seconds > 0) return seconds * 1000;
  if (Array.isArray(details))
    for (const detail of details) {
      const delay = (detail as { retryDelay?: unknown } | null)?.retryDelay;
      const match =
        typeof delay === "string" ? /^(\d+(?:\.\d+)?)s$/.exec(delay) : null;
      if (match) return Math.ceil(Number(match[1]) * 1000);
    }
  return undefined;
}

interface BreakerState {
  state: "closed" | "open" | "half-open";
  failures: number;
  opens: number;
  until: number;
  probing: boolean;
  /** Credential reference when opened by an auth failure; a changed credential closes it. */
  authRef?: string;
  last?: { failure: Failure; errorClass: string; at: number };
}

/** A breaker state change, for the diagnostic log. */
export interface BreakerChange {
  provider: string;
  credential: string;
  state: BreakerState["state"];
  until?: string;
  reason: string;
}

function credentialRef(credential: ProviderCredential): string {
  return JSON.stringify([credential.ref.kind, credential.ref.value]);
}

/**
 * Per-credential breakers (closed, open, half-open), which are the rests of
 * Magpie's routing, and per credential and model marks. Three consecutive
 * counted failures open a breaker for 60 s, doubling per reopening up to 10
 * minutes; one failure of another kind opens it for as long as
 * {@link classify} says (a cooldown), or, for an auth failure, 10 minutes or
 * until the credential's reference changes. After the open time one probe
 * passes (half-open); its success closes the breaker, a counted failure
 * reopens it. A 404 or model-missing answer marks only that credential and
 * model for 10 minutes.
 */
export class Breakers {
  #states = new Map<string, BreakerState>();
  #marks = new Map<string, number>();
  constructor(
    private readonly clock: () => number,
    private readonly changed: (change: BreakerChange) => void,
  ) {}

  #key(candidate: Candidate): string {
    return credentialKey(candidate);
  }

  /**
   * Until when the candidate rests and why (the error class that opened it,
   * or `model_not_found` for a mark); undefined when it may be tried. No
   * side effects.
   */
  restOf(candidate: Candidate): { until: number; reason: string } | undefined {
    const now = this.clock();
    const mark = this.#marks.get(this.#markKey(candidate));
    if (mark !== undefined && mark > now)
      return { until: mark, reason: "model_not_found" };
    const state = this.#states.get(this.#key(candidate));
    return state?.state === "open" && now < state.until
      ? { until: state.until, reason: state.last?.errorClass ?? "cooldown" }
      : undefined;
  }

  /**
   * Whether the candidate may be tried now. A half-open breaker admits one
   * probe; the caller reports its result through {@link success},
   * {@link failure} or {@link release}.
   */
  admit(candidate: Candidate):
    | { ok: true }
    | {
        ok: false;
        reason: string;
        until: number;
        last?: { failure: Failure; errorClass: string; at: number };
      } {
    const now = this.clock();
    const mark = this.#marks.get(this.#markKey(candidate));
    if (mark !== undefined) {
      if (mark > now)
        return {
          ok: false,
          reason: `${candidate.ref} is marked unavailable on credential ${candidate.credential.id}`,
          until: mark,
        };
      this.#marks.delete(this.#markKey(candidate));
    }
    const state = this.#states.get(this.#key(candidate));
    if (!state) return { ok: true };
    if (
      state.state === "open" &&
      state.authRef !== undefined &&
      state.authRef !== credentialRef(candidate.credential)
    ) {
      this.#close(candidate, state, "credential changed");
      return { ok: true };
    }
    if (state.state === "open" && now >= state.until) {
      state.state = "half-open";
      state.probing = false;
      this.#report(candidate, state, "open time elapsed");
    }
    if (state.state === "half-open") {
      if (state.probing)
        return {
          ok: false,
          reason: `credential ${candidate.credential.id} of ${candidate.provider.id} is being probed`,
          until: now + 1000,
          ...(state.last ? { last: state.last } : {}),
        };
      state.probing = true;
      return { ok: true };
    }
    if (state.state === "open")
      return {
        ok: false,
        reason: `credential ${candidate.credential.id} of ${candidate.provider.id} is cooling down`,
        until: state.until,
        ...(state.last ? { last: state.last } : {}),
      };
    return { ok: true };
  }

  /**
   * Every credential's breaker that is not plainly closed, without failure
   * messages (they may quote an upstream): an open breaker whose time has
   * passed is reported half-open, as the next request finds it.
   */
  snapshot(): {
    provider: string;
    credential: string;
    state: BreakerState["state"];
    until?: number;
    last?: { errorClass: string; status: number; at: number };
  }[] {
    const now = this.clock();
    return [...this.#states].map(([key, state]) => {
      const [provider, credential] = key.split("\u0000") as [string, string];
      const open = state.state === "open" && now < state.until;
      return {
        provider,
        credential,
        state: state.state === "open" && !open ? "half-open" : state.state,
        ...(open ? { until: state.until } : {}),
        ...(state.last
          ? {
              last: {
                errorClass: state.last.errorClass,
                status: state.last.failure.status,
                at: state.last.at,
              },
            }
          : {}),
      };
    });
  }

  /** Whether the candidate is open or marked right now; no side effects (unlike {@link admit}). */
  blocked(candidate: Candidate): boolean {
    const now = this.clock();
    const mark = this.#marks.get(this.#markKey(candidate));
    if (mark !== undefined && mark > now) return true;
    const state = this.#states.get(this.#key(candidate));
    return state?.state === "open" && now < state.until;
  }

  success(candidate: Candidate): void {
    const state = this.#states.get(this.#key(candidate));
    if (!state) return;
    if (state.state !== "closed") this.#close(candidate, state, "success");
    else state.failures = 0;
  }

  /** The probe or attempt ended without a verdict (cancelled, or a request error). */
  release(candidate: Candidate): void {
    const state = this.#states.get(this.#key(candidate));
    if (state) state.probing = false;
  }

  failure(
    candidate: Candidate,
    effect: BreakerEffect,
    failure: Failure,
    errorClass: string,
  ): void {
    const now = this.clock();
    if (effect.kind === "model") {
      this.#marks.set(this.#markKey(candidate), now + effect.ms);
      this.release(candidate);
      return;
    }
    const key = this.#key(candidate);
    const state: BreakerState = this.#states.get(key) ?? {
      state: "closed",
      failures: 0,
      opens: 0,
      until: 0,
      probing: false,
    };
    this.#states.set(key, state);
    state.probing = false;
    if (effect.kind === "none") return;
    state.last = { failure, errorClass, at: now };
    switch (effect.kind) {
      case "count":
        state.failures++;
        if (state.state === "half-open" || state.failures >= 3)
          this.#open(candidate, state, undefined, errorClass);
        return;
      case "cooldown":
        this.#open(candidate, state, effect.ms, errorClass);
        return;
      case "auth":
        this.#open(candidate, state, OPEN_MAX_MS, errorClass);
        state.authRef = credentialRef(candidate.credential);
        return;
    }
  }

  #open(
    candidate: Candidate,
    state: BreakerState,
    ms: number | undefined,
    reason: string,
  ) {
    const duration = ms ?? Math.min(60_000 * 2 ** state.opens, OPEN_MAX_MS);
    state.state = "open";
    state.opens++;
    state.failures = 0;
    state.until = this.clock() + duration;
    delete state.authRef;
    this.#report(candidate, state, reason);
  }

  #close(candidate: Candidate, state: BreakerState, reason: string) {
    this.#states.delete(this.#key(candidate));
    this.#report(
      candidate,
      { ...state, state: "closed", failures: 0, opens: 0 },
      reason,
    );
  }

  #markKey(candidate: Candidate): string {
    return `${this.#key(candidate)}\u0000${candidate.wireModel}`;
  }

  #report(candidate: Candidate, state: BreakerState, reason: string) {
    this.changed({
      provider: candidate.provider.id,
      credential: candidate.credential.id,
      state: state.state,
      ...(state.state === "open"
        ? { until: new Date(state.until).toISOString() }
        : {}),
      reason,
    });
  }
}
