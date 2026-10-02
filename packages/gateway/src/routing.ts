// SPDX-License-Identifier: MIT
/**
 * Candidate selection, per-credential breakers and the retry table of the
 * shared gateway (03 section 5). Everything here is in memory and owned by one
 * handler; nothing is persisted.
 */
import {
  DEFAULT_RETRY_POLICY,
  type ModelRef,
  type ProviderConfig,
  type ProviderCredential,
  type ProviderModel,
  type RetryPolicy,
  type RouteGroup,
  type RouteGroupId,
  type WireProtocol,
} from "@harnesshub/core/model-plane";
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

/** Upstream protocols tried, in order, when neither passthrough nor Chat is possible. */
const TRANSLATION_TARGETS = ["anthropic", "responses", "gemini"] as const;

/**
 * Candidates of one Model Ref for an inbound protocol, one per enabled
 * credential in configuration order. A credential serves the inbound
 * protocol natively (passthrough) when the provider declares that endpoint,
 * is not `translateOnly` and the credential is valid for it; otherwise it is
 * translated to the provider's Chat endpoint, else to its Anthropic,
 * Responses or Gemini endpoint in that order. Credentials valid for none of
 * the provider's endpoints are reported in `skipped`.
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
  for (const credential of provider.credentials) {
    if (!credential.enabled) continue;
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

/** The group's retry policy over the 03 defaults; `totalAttempts` never exceeds the hard cap of 8. */
export function retryPolicy(
  overrides: Partial<RetryPolicy> | undefined,
): RetryPolicy {
  const policy = { ...DEFAULT_RETRY_POLICY, ...overrides };
  return { ...policy, totalAttempts: Math.min(policy.totalAttempts, 8) };
}
/** Retry waits of one call stop once they would pass this total. */
export const RETRY_BUDGET_MS = 30_000;

/**
 * Member order per strategy. `order` keeps the configuration; `rotate` starts
 * one member later on every call; `least-used` prefers the member with the
 * fewest tokens in the last 24 hours; `latency` prefers the lowest moving
 * average of first-content time, members with fewer than 5 samples first.
 * Usage and latency are counted from calls through this handler since it
 * started; stickiness is not implemented.
 */
export class Router {
  #rotation = new Map<RouteGroupId, number>();
  /** Model Ref → hour index → tokens. */
  #tokens = new Map<string, Map<number, number>>();
  #latency = new Map<string, { average: number; samples: number }>();
  constructor(private readonly clock: () => number) {}

  order(group: RouteGroup): ModelRef[] {
    const members = [...group.members];
    switch (group.strategy) {
      case "order":
        return members;
      case "rotate": {
        const turn = this.#rotation.get(group.id) ?? 0;
        this.#rotation.set(group.id, turn + 1);
        const start = members.length ? turn % members.length : 0;
        return [...members.slice(start), ...members.slice(0, start)];
      }
      case "least-used": {
        const used = new Map(members.map((ref) => [ref, this.#used(ref)]));
        return members
          .map((ref, index) => ({ ref, index }))
          .sort(
            (a, b) => used.get(a.ref)! - used.get(b.ref)! || a.index - b.index,
          )
          .map(({ ref }) => ref);
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

  /** Record a successful call: tokens for `least-used`, first-content time for `latency`. */
  record(ref: ModelRef, tokens: number, firstContentMs: number | undefined) {
    const hour = Math.floor(this.clock() / 3_600_000);
    const buckets = this.#tokens.get(ref) ?? new Map<number, number>();
    for (const old of buckets.keys()) if (old <= hour - 24) buckets.delete(old);
    buckets.set(hour, (buckets.get(hour) ?? 0) + tokens);
    this.#tokens.set(ref, buckets);
    if (firstContentMs === undefined) return;
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

  #used(ref: ModelRef): number {
    const hour = Math.floor(this.clock() / 3_600_000);
    let total = 0;
    for (const [at, tokens] of this.#tokens.get(ref) ?? [])
      if (at > hour - 24) total += tokens;
    return total;
  }
}

/** What one failed attempt does to its credential's breaker. */
export type BreakerEffect =
  | { kind: "none" }
  | { kind: "count" }
  | { kind: "cooldown"; ms: number }
  | { kind: "auth" }
  | { kind: "model"; ms: number };

/** A failed attempt that wrote nothing to the client. */
export interface AttemptError {
  failure: Failure;
  errorClass: string;
  source: "gateway" | "upstream";
  /** `local`: a gateway-side condition of this candidate (busy, credential, patch). */
  phase: "connect" | "headers" | "response" | "local" | "cancelled";
  /** Upstream HTTP status, or the status an in-stream error maps to. */
  status?: number;
  retryAfterMs?: number;
}

export interface Classification {
  /** `after`: retry once the Retry-After wait passed; `once`: at most one retry. */
  retry: "no" | "yes" | "once" | "after";
  failover: boolean;
  breaker: BreakerEffect;
}

const TRANSIENT = new Set([408, 500, 502, 503, 504, 529]);
const QUOTA =
  /quota|insufficient[_ ]quota|billing|exceeded your current|credit|balance/i;
const MODEL_MISSING =
  /model[^.]{0,80}(?:not (?:found|exist|available|supported|enabled|activated)|does ?n[o']t exist|unavailable)|no such model|unknown model|model_not_found|invalid model/i;
const OPEN_MAX_MS = 600_000;

/** The 03 section 5 retry table. */
export function classify(
  error: AttemptError,
  policy: RetryPolicy,
): Classification {
  const status = error.status;
  if (error.phase === "cancelled")
    return { retry: "no", failover: false, breaker: { kind: "none" } };
  if (error.phase === "local")
    return { retry: "no", failover: true, breaker: { kind: "none" } };
  if (error.phase === "connect")
    return { retry: "yes", failover: true, breaker: { kind: "count" } };
  if (error.phase === "headers")
    return { retry: "once", failover: true, breaker: { kind: "count" } };
  if (status === undefined)
    return { retry: "yes", failover: true, breaker: { kind: "count" } };
  if (error.failure.contextOverflow)
    return { retry: "no", failover: false, breaker: { kind: "none" } };
  if (status === 429) {
    const wait = error.retryAfterMs;
    if (QUOTA.test(error.failure.message))
      return {
        retry: "no",
        failover: true,
        breaker: {
          kind: "cooldown",
          ms: Math.min(wait ?? 60_000, OPEN_MAX_MS),
        },
      };
    if (wait !== undefined && wait <= policy.retryAfterWaitCapMs)
      return {
        retry: "after",
        failover: true,
        breaker: { kind: "cooldown", ms: wait },
      };
    return {
      retry: "no",
      failover: true,
      breaker: { kind: "cooldown", ms: Math.min(wait ?? 60_000, OPEN_MAX_MS) },
    };
  }
  if (status === 401 || status === 402 || status === 403)
    return { retry: "no", failover: true, breaker: { kind: "auth" } };
  if (
    status === 404 ||
    ((status === 400 || status === 422) &&
      MODEL_MISSING.test(error.failure.message))
  )
    return {
      retry: "no",
      failover: true,
      breaker: { kind: "model", ms: 600_000 },
    };
  if (TRANSIENT.has(status))
    return { retry: "yes", failover: true, breaker: { kind: "count" } };
  if (status >= 500)
    return { retry: "no", failover: true, breaker: { kind: "count" } };
  return { retry: "no", failover: false, breaker: { kind: "none" } };
}

/** `500 ms × 2^n` capped at `maxBackoffMs`, with ±20% jitter. */
export function backoff(policy: RetryPolicy, retry: number): number {
  const base = Math.min(policy.maxBackoffMs, policy.baseBackoffMs * 2 ** retry);
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

/**
 * Milliseconds from `retry-after-ms` or `retry-after` (seconds or an HTTP
 * date), or `undefined` when absent or malformed.
 */
export function retryAfter(headers: Headers, now: number): number | undefined {
  const ms = headers.get("retry-after-ms");
  if (ms !== null && /^\d+(?:\.\d+)?$/.test(ms.trim()))
    return Math.ceil(Number(ms));
  const value = headers.get("retry-after")?.trim();
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
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
 * Per-credential breakers (closed, open, half-open) and per credential and
 * model marks. Three consecutive counted failures, or one auth or quota
 * failure, open a breaker: for the upstream's wait when it gave one,
 * otherwise 60 s doubling per reopening up to 10 minutes. An auth failure
 * also ends when the credential's reference changes. After the open time one
 * probe passes (half-open); its success closes the breaker, a counted
 * failure reopens it. A 404 or model-missing answer marks only that
 * credential and model for 10 minutes.
 */
export class Breakers {
  #states = new Map<string, BreakerState>();
  #marks = new Map<string, number>();
  constructor(
    private readonly clock: () => number,
    private readonly changed: (change: BreakerChange) => void,
  ) {}

  #key(candidate: Candidate): string {
    return `${candidate.provider.id}\u0000${candidate.credential.id}`;
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
