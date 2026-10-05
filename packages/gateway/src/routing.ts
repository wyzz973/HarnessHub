// SPDX-License-Identifier: MIT
/**
 * Candidate selection, per-credential breakers and the retry table of the
 * shared gateway (03 section 5, with Magpie's failure kinds and rests).
 * Everything here is in memory and owned by one handler; nothing is
 * persisted, and `least-used` starts from a bounded read of the ledger.
 */
import type { LogSink } from "@harnesshub/core/logging";
import {
  credentialUnlisted,
  DEFAULT_RETRY_POLICY,
  modelAllowed,
  type AllowanceReading,
  type ModelPlaneStore,
  type ModelRef,
  type ProviderConfig,
  type ProviderCredential,
  type ProviderId,
  type ProviderModel,
  type ReasoningEffort,
  type RetryPolicy,
  type RouteGroup,
  type RouteGroupId,
  type WireProtocol,
  wireName,
} from "@harnesshub/core/model-plane";
import {
  fastMode,
  GROUP_NEST_LIMIT,
  parseGroupMember,
} from "@harnesshub/core/route-groups";
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
  /** The effort a group's member is fixed at: asked of the model whatever the request asked. */
  effort?: ReasoningEffort;
  /** A group's member sent in its vendor's fast mode (core `fastMode`). */
  fast?: boolean;
  /**
   * The members it is of, from the requested group's own down to the model
   * (Magpie `Member.Path`): `["a/m"]` for a model the group names,
   * `["group/inner", "b/n"]` for one of the group inside it. Absent for a
   * Model Ref asked for directly.
   */
  path?: string[];
  /**
   * The credential is limited to protocols other than those of the
   * best-fitting credential of its model ({@link modelCandidates}): a
   * weighed group tries it after the others.
   */
  aside?: true;
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
 * The protocol a model is at home in, when its name says (Magpie
 * `modelFamily`): Anthropic's for Claude, Chat (OpenAI's) for GPT, Codex
 * and the o-series.
 */
function modelFamily(model: string): "anthropic" | "chat" | undefined {
  const name = model.toLowerCase().slice(model.lastIndexOf("/") + 1);
  if (name.startsWith("claude")) return "anthropic";
  if (name.startsWith("gpt-") || name.includes("codex") || /^o[1-9]/.test(name))
    return "chat";
  return undefined;
}

/**
 * How well a credential suits a request, best first (Magpie `keyFit`): 0
 * fits, 1 needs the request translated, 2 is made for another vendor's
 * models. A credential not limited to protocols fits; one limited fits a
 * Claude model when it takes Anthropic's protocol, a GPT model when it
 * takes another, and any other model when it takes the inbound protocol
 * at an endpoint the provider has.
 */
function keyFit(
  candidate: Candidate,
  modelId: string,
  inbound: WireProtocol,
): number {
  const { protocols } = candidate.credential;
  if (protocols === undefined) return 0;
  switch (modelFamily(modelId)) {
    case "anthropic":
      return protocols.includes("anthropic") ? 0 : 2;
    case "chat":
      return protocols.some((protocol) => protocol !== "anthropic") ? 0 : 2;
    case undefined:
      return candidate.provider.endpoints[inbound] !== undefined &&
        protocols.includes(inbound)
        ? 0
        : 1;
  }
}

/** The protocols a credential is limited to, as one comparable value. */
const limitedTo = (credential: ProviderCredential) =>
  credential.protocols ? [...credential.protocols].sort().join(",") : "";

/**
 * Candidates of one Model Ref for an inbound protocol, one per enabled
 * credential in configuration order. A credential serves the inbound
 * protocol natively (passthrough) when the provider declares that endpoint,
 * is not `translateOnly` and the credential is valid for it; otherwise it is
 * translated to the provider's Chat endpoint, else to its Anthropic,
 * Responses or Gemini endpoint in that order. Credentials valid for none of
 * the provider's endpoints are reported in `skipped`. A provider without
 * credentials has one keyless candidate.
 *
 * A credential whose own model list is known to lack the model
 * (`credentialUnlisted`, Magpie `Serves`) is left out and counted in
 * `unlisted`; when every credential's list lacks it, they are all tried
 * the same (`unlistedTried`). The candidates are then in Magpie's `keyFit`
 * order, best first; those limited to other protocols than the first are
 * moved after the rest and marked `aside`.
 */
export function modelCandidates(
  provider: ProviderConfig,
  modelId: string,
  inbound: WireProtocol,
): {
  candidates: Candidate[];
  skipped: string[];
  unlisted: number;
  unlistedTried: boolean;
} {
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
  // A credential whose own list lacks the model would only refuse it; when
  // every list lacks it, they are all asked the same.
  const listing = candidates.filter(
    (candidate) =>
      !credentialUnlisted(provider, candidate.credential.id, modelId),
  );
  const unlisted = candidates.length - listing.length;
  const unlistedTried = unlisted > 0 && listing.length === 0;
  const kept = unlistedTried ? candidates : listing;
  const fit = new Map(
    kept.map((candidate) => [candidate, keyFit(candidate, modelId, inbound)]),
  );
  kept.sort((a, b) => fit.get(a)! - fit.get(b)!);
  const first = kept[0] && limitedTo(kept[0].credential);
  const pool = kept.filter(
    (candidate) => limitedTo(candidate.credential) === first,
  );
  const aside = kept
    .filter((candidate) => limitedTo(candidate.credential) !== first)
    .map((candidate): Candidate => ({ ...candidate, aside: true }));
  return {
    candidates: [...pool, ...aside],
    skipped,
    unlisted: unlistedTried ? 0 : unlisted,
    unlistedTried,
  };
}

/** What {@link planGroup} reads and weighs with. */
export interface GroupPlanning {
  provider(id: ProviderId): Promise<ProviderConfig | undefined>;
  /** A stored group, or a visible automatic one. */
  group(id: RouteGroupId): Promise<RouteGroup | undefined>;
  /** The group's members in the order it tries them (`Router.order`). */
  order(group: RouteGroup): readonly string[];
  /** The candidates of a `least-used`, `smart` or `pace` group by its strategy (`Router.weigh`). */
  weigh(group: RouteGroup, candidates: Candidate[]): Promise<Candidate[]>;
  /** A candidate whose breaker is open, passed over when a nested group is weighed by its first candidate. */
  blocked(candidate: Candidate): boolean;
}

const WEIGHED = new Set(["least-used", "smart", "pace"]);

/**
 * The candidates of a route group for an inbound protocol (Magpie
 * `planGroup`). Each model member gives its credentials' candidates, fixed
 * at the member's effort and sent fast where the model has a fast mode
 * (`:fast` on another model is sent as it is); the same model at the same
 * effort through the same credential is kept where it came first. A group
 * member is planned by its own strategy and stays together: in member order
 * for `order`, `rotate` and `latency`; for `least-used`, `smart` and `pace`
 * each credential of the group's own models and each group member as one
 * unit are weighed together, a group member by its first candidate that is
 * not resting. Groups that are unknown, already on the way down, or deeper
 * than {@link GROUP_NEST_LIMIT} are skipped with a reason.
 */
export async function planGroup(
  group: RouteGroup,
  inbound: WireProtocol,
  planning: GroupPlanning,
): Promise<{
  candidates: Candidate[];
  skipped: string[];
  /** The groups inside the group that were planned, by ID. */
  groups: Map<RouteGroupId, RouteGroup>;
  /** Credentials left out because their own lists lack a member's model ({@link modelCandidates}). */
  unlisted: number;
  /** Members whose every credential's list lacks the model, all asked the same. */
  unlistedTried: boolean;
}> {
  const skipped: string[] = [];
  let unlisted = 0;
  let unlistedTried = false;
  const groups = new Map<RouteGroupId, RouteGroup>();
  const seen = new Set<string>();
  const providers = new Map<string, Promise<ProviderConfig | undefined>>();
  const provider = (id: ProviderId) => {
    let found = providers.get(id);
    if (!found) {
      found = planning.provider(id);
      providers.set(id, found);
    }
    return found;
  };
  const level = async (
    current: RouteGroup,
    via: RouteGroupId[],
    path: string[],
  ): Promise<Candidate[]> => {
    const units: Candidate[][] = [];
    /** Candidates limited to other protocols than their model's best: after the weighed ones. */
    const late: Candidate[] = [];
    for (const text of planning.order(current)) {
      const named = parseGroupMember(text);
      if (!named) {
        skipped.push(`${text}: not a model or a group`);
        continue;
      }
      if (named.kind === "group") {
        if (named.group === group.id || via.includes(named.group)) {
          skipped.push(`${text}: the group is already on the way down`);
          continue;
        }
        if (via.length >= GROUP_NEST_LIMIT) {
          skipped.push(`${text}: groups nest at most ${GROUP_NEST_LIMIT} deep`);
          continue;
        }
        const inner = await planning.group(named.group);
        if (!inner) {
          skipped.push(`${text}: unknown group`);
          continue;
        }
        groups.set(inner.id, inner);
        const planned = await level(
          inner,
          [...via, named.group],
          [...path, text],
        );
        if (planned.length) units.push(planned);
        continue;
      }
      const found = await provider(named.provider);
      if (!found) {
        skipped.push(`${text}: unknown provider`);
        continue;
      }
      // A colon that belongs to a model the provider lists is the model's.
      const member = parseGroupMember(text, (_, model) =>
        found.models.list.some((entry) => entry.id === model),
      );
      if (member?.kind !== "model") continue;
      const result = modelCandidates(found, member.model, inbound);
      skipped.push(...result.skipped);
      unlisted += result.unlisted;
      unlistedTried ||= result.unlistedTried;
      for (const candidate of result.candidates) {
        const key = `${credentialKey(candidate)}\u0000${candidate.ref}\u0000${member.effort ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        candidate.path = [...path, text];
        if (member.effort) candidate.effort = member.effort;
        if (member.fast) {
          if (fastMode(found, candidate.wireModel, candidate.upstream))
            candidate.fast = true;
          else
            skipped.push(
              `${text}: ${candidate.ref} has no fast mode on its ${candidate.upstream} endpoint; sent as it is`,
            );
        }
        if (candidate.aside && WEIGHED.has(current.strategy))
          late.push(candidate);
        else units.push([candidate]);
      }
    }
    if (!WEIGHED.has(current.strategy) || units.length < 2)
      return [...units.flat(), ...late];
    const heads = units.map(
      (unit) =>
        unit.find((candidate) => !planning.blocked(candidate)) ?? unit[0]!,
    );
    const order = await planning.weigh(current, heads);
    const byHead = new Map(heads.map((head, index) => [head, units[index]!]));
    return [...order.flatMap((head) => byHead.get(head) ?? [head]), ...late];
  };
  const candidates = await level(group, [], []);
  return { candidates, skipped, groups, unlisted, unlistedTried };
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
  order(group: RouteGroup): string[] {
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
        const score = (ref: string) => {
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
 * `proxy` — a proxy in front of the upstream refused the connection (a
 * relay's, from its error text, or the daemon's own, `proxy_failed`);
 * `verify` — the vendor wants the account verified; `auth` — the credential
 * is not accepted; `credit` — no money left; `quota` — the plan's allowance
 * is used up; `rate` — a short rate limit; `model` — this credential or
 * endpoint does not serve the model; `policy` — the vendor's safety filter
 * refused this request, which another account or vendor may answer;
 * `refused` — the vendor refuses requests from this client or channel
 * altogether; `shape` — the vendor's API cannot read the request's shape
 * (an item, field or parameter it does not know), which another API may;
 * `other` — the upstream failed, timed out or was busy; `request` — the
 * request itself is at fault for every provider (context overflow, a
 * malformed body, a missing required field).
 */
export type FailureKind =
  | "proxy"
  | "verify"
  | "auth"
  | "credit"
  | "quota"
  | "rate"
  | "model"
  | "policy"
  | "refused"
  | "shape"
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
  /** The model is not served by this credential or endpoint (Magpie `unservedWords`). */
  modelMissing:
    /model[^.]{0,80}(?:not (?:found|exist|available|supported|enabled|activated|accessible|allowed)|does ?n[o']t exist|unavailable|unsupported|unknown|invalid)|no such model|unknown model|unsupported model|model_not_found|invalid model|模型.{0,12}(?:不存在|不支持|无权|未开通)/i,
  /**
   * How a vendor says "out of quota" or "slow down" when its status does
   * not (Magpie `quotaWords`): a 400 or 422 with them fails over. Credit and
   * used-up words are their own kinds; the rest (busy, overloaded, a rate
   * limit said with 400) are `other`.
   */
  busy: /quota|insufficient|balance|credit|billing|exceeded|rate.?limit|usage.?limit|limit.?reached|hit your .*limit|limit.{0,24}resets|too many requests|overloaded|余额|额度|欠费|限流|频率|套餐|用量|上限/i,
  /**
   * The vendor will not take requests from this client at all (Magpie
   * `refusedWords`: WorkBuddy's "Illegal API invocation from an unapproved
   * channel"): a refusal of the provider, not of the request.
   */
  refused: /unapproved channel|illegal api invocation/i,
  /**
   * The vendor's API cannot read the request's shape (Magpie `shapeWords`):
   * xAI's 422 "Failed to deserialize the JSON body …: unknown item type",
   * OpenAI's "Unknown parameter". Another vendor's API may take it.
   */
  shape:
    /failed to deserialize|unknown (?:item |content |input )?(?:type|variant|field|parameter)|unknown_parameter|unrecognized (?:request argument|field|parameter)|extra (?:inputs|fields) are not permitted|additional properties are not allowed/i,
  /**
   * The request is at fault for every provider: a body that is not JSON,
   * or one missing what every API requires (the messages). Checked before
   * the lists that fail over, as such a body may match one of them (axum's
   * "Failed to deserialize the JSON body …: missing field `messages`").
   */
  clientFault:
    /missing (?:required )?(?:field|parameter|property|argument)|field required|required (?:field|parameter|property)|\b(?:messages?|contents|input) (?:is|are) required|at least (?:one|1) message|(?:messages?|contents|input)[^.]{0,40}(?:must not|cannot|may not) be empty|expecting value|json ?decode|(?:invalid|malformed) json|not valid json|could not parse (?:the )?(?:json|request body)|unexpected (?:token|end of (?:json|input))|eof while parsing|json syntax/i,
} as const;

/**
 * How a vendor's safety filter says it stopped a request or a reply
 * (Magpie `filterReasons`): Anthropic's stop reason, OpenAI's finish reason
 * and error code, Azure's, and Gemini's finish and block reasons.
 */
const FILTER_REASONS = new Set([
  "refusal",
  "content_filter",
  "content_policy_violation",
  "SAFETY",
  "PROHIBITED_CONTENT",
  "BLOCKLIST",
  "SPII",
  "IMAGE_SAFETY",
]);

/**
 * Whether an error (its body, or `code message` of an in-stream error) is
 * the vendor's safety filter refusing the request (Magpie
 * `policyRefusal`): a code or type that is a filter reason, a
 * `<name>_policy` code such as OpenAI's `bio_policy`, or `invalid_prompt`
 * flagged against the usage policy. Not the request at fault as another
 * 400 is: another account or vendor may answer it.
 */
export function policyRefusal(text: string): boolean {
  let code = "";
  let message = text;
  try {
    const value: unknown = JSON.parse(text);
    const body =
      typeof value === "object" && value !== null
        ? (value as Record<string, unknown>)
        : {};
    const inner =
      typeof body.error === "object" && body.error !== null
        ? (body.error as Record<string, unknown>)
        : body;
    const named = typeof inner.code === "string" ? inner.code : "";
    code = named || (typeof inner.type === "string" ? inner.type : "");
    message = typeof inner.message === "string" ? inner.message : "";
  } catch {
    // An in-stream error as `code message`.
    const at = text.indexOf(" ");
    code = at < 0 ? text : text.slice(0, at);
    message = at < 0 ? "" : text.slice(at + 1);
  }
  return (
    FILTER_REASONS.has(code) ||
    /^[a-z]+_policy$/.test(code) ||
    (code === "invalid_prompt" && /flagged|usage polic/i.test(message))
  );
}

/**
 * How a vendor says a request asked for too short a reply (Magpie
 * `tooFewTokens`): "max_tokens must be greater than 2", "Expected >= 16";
 * a `>` may come JSON-escaped.
 */
const TOO_FEW_TOKENS =
  /max_(?:completion_|output_)?tokens.{0,60}?(greater than|more than|larger than|at least|(?:>|\\u003e)=?)\s*(\d+)/i;

/**
 * The least reply length a vendor said it takes, or 0 when the error is not
 * about that (Magpie `tokenFloor`); at most 1024.
 */
export function tokenFloor(text: string): number {
  const found = TOO_FEW_TOKENS.exec(text);
  if (!found) return 0;
  const n = Number(found[2]);
  if (!Number.isSafeInteger(n) || n < 0 || n > 1024) return 0;
  const sign = found[1]!;
  return /^at least$/i.test(sign) || sign.endsWith("=") ? n : n + 1;
}

/**
 * `body` (an upstream request, JSON) asking for at least `floor` tokens of
 * reply wherever its protocol keeps the length (Magpie `withTokenFloor`):
 * `max_tokens`, `max_completion_tokens`, `max_output_tokens` and Gemini's
 * `generationConfig.maxOutputTokens`. Undefined when it asked for that much
 * already, or asked for no length, so the error was about something else.
 */
export function withTokenFloor(
  body: string,
  floor: number,
): string | undefined {
  if (floor <= 0) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const request = value as Record<string, unknown>;
  const raise = (holder: Record<string, unknown>, key: string): boolean => {
    const n = holder[key];
    if (typeof n !== "number" || n >= floor) return false;
    holder[key] = floor;
    return true;
  };
  let raised = false;
  for (const key of [
    "max_tokens",
    "max_completion_tokens",
    "max_output_tokens",
  ])
    raised = raise(request, key) || raised;
  const config = request.generationConfig;
  if (typeof config === "object" && config !== null && !Array.isArray(config))
    raised =
      raise(config as Record<string, unknown>, "maxOutputTokens") || raised;
  return raised ? JSON.stringify(request) : undefined;
}

/**
 * The kind of an upstream refusal from its status and text (the error body,
 * or the message of an in-stream error), checked in Magpie's order: a 502
 * from a proxy; a verification demand on 401 or 403; no credit (402, credit
 * words on any status but 429, or `insufficient_quota`); a 429 with rate
 * words and no plan words; a used-up allowance (used-up words, or a 429 with
 * plan words); any other 429 as a rate limit. Then, for HarnessHub's
 * breaker: 401 and 403 as `auth`; 404 as `model`. A 400 or 422 fails over
 * as Magpie's `retryable` and `shapeRefused` say, unless it is the
 * request's own fault for every provider (`clientFault` words): model-
 * missing words as `model`, refusal words as `refused`, busy words as
 * `other`, shape words as `shape`. A safety filter's refusal (any status but
 * 429, {@link policyRefusal}) comes first, as `policy`. 408 and 5xx are
 * `other`; everything else is `request`. A context overflow is a `request`
 * failure; the caller checks it first.
 */
export function failureKind(status: number, text: string): FailureKind {
  const words = FAILURE_WORDS;
  // An in-stream refusal may come mapped to a 5xx: its code says what it is.
  if (status !== 429 && policyRefusal(text)) return "policy";
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
  if (status === 404) return "model";
  if (status === 400 || status === 422) {
    if (words.clientFault.test(text)) return "request";
    if (words.modelMissing.test(text)) return "model";
    if (words.refused.test(text)) return "refused";
    if (words.busy.test(text)) return "other";
    if (words.shape.test(text)) return "shape";
    return "request";
  }
  if (status === 408 || status >= 500) return "other";
  return "request";
}

/** A word of {@link echoFree}: one CJK character, or a run of other letters and digits. */
const WORD =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[\p{L}\p{N}]+/gu;
/**
 * The key every request has whose name the failure lists need ("model …
 * not found"); its value, which the gateway sets, is read as any other.
 */
const MODEL_KEY = "model";
/** How much of an error is read for a rest. */
const REST_TEXT_MAX = 16 * 1024;

/**
 * `text`, an upstream error, without the words that `request` (the client's
 * request as parsed JSON: its string values, and its keys but `model`)
 * also holds; words compare without regard to case, a CJK character as a
 * word. A vendor that echoes a field name or value of the request
 * ("Unrecognized request argument supplied: <name>") cannot then be made
 * to say that a credential is out of credit or quota, or lacks a model.
 * Removes more than an echo (a word the vendor's message and the prompt
 * share), so the result decides only rests, which a word removed makes
 * shorter or none, and never the request's own failover. Reads the first
 * 16 KiB of `text`.
 */
export function echoFree(text: string, request: unknown): string {
  const head = text.slice(0, REST_TEXT_MAX);
  const words = new Set<string>();
  for (const [word] of head.matchAll(WORD)) words.add(word.toLowerCase());
  const echoed = new Set<string>();
  const look = (value: string) => {
    for (const [word] of value.matchAll(WORD)) {
      const lower = word.toLowerCase();
      if (words.has(lower)) echoed.add(lower);
    }
  };
  const stack: unknown[] = [request];
  while (stack.length) {
    const value = stack.pop();
    if (typeof value === "string") look(value);
    else if (Array.isArray(value)) stack.push(...value);
    else if (typeof value === "object" && value !== null) {
      const prototype: unknown = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) continue;
      for (const [key, item] of Object.entries(value)) {
        if (key !== MODEL_KEY) look(key);
        stack.push(item);
      }
    }
  }
  return echoed.size
    ? head.replace(WORD, (word) =>
        echoed.has(word.toLowerCase()) ? " " : word,
      )
    : head;
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
    case "policy":
      return "safety_refused";
    case "refused":
      return "client_refused";
    case "shape":
      return "request_shape_unsupported";
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
  /**
   * The kind that decides the credential's rest, when it is not `kind`:
   * the error read without the request's own words ({@link echoFree}).
   */
  restKind?: FailureKind;
  /** The vendor's wait from the headers (`retryAfter`). */
  retryAfterMs?: number;
  /** When a used-up allowance comes back, as the vendor's body says (`resetIn`). */
  resetMs?: number;
  /** The least reply length a 400 said the vendor takes ({@link tokenFloor}). */
  floor?: number;
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
 * The longest rest one Gateway Key's failure gives a credential (H2): a
 * longer one is cut to this, and the next failure of a long rest, from
 * another key (the probe after this rest, as nobody else reaches it
 * before), gives it in full.
 */
export const PROVISIONAL_MS = 60_000;

/**
 * What a failed attempt means for routing. Connection failures, timeouts and
 * the transient statuses (408, 500, 502, 503, 504, 529) count towards the
 * breaker and may be retried; a header timeout at most once. `rate` rests the
 * credential for the vendor's wait, else a minute, and may be retried; `quota`
 * rests until the vendor's stated reset, else 15 minutes, at most 8 days;
 * `credit` and `verify` rest 30 minutes; `auth` rests until the credential
 * changes or 10 minutes pass; `model` marks the credential and model for 10
 * minutes; `refused` counts towards the breaker; `proxy`, `policy` and
 * `shape` rest nothing (Magpie: nothing is wrong with the credential), and
 * `proxy`, when the daemon's own proxy failed to connect, is not retried.
 * All of these fail over; a `request` failure is returned as it is.
 * Retries apply only to the last candidate left. The rest (`breaker`) follows
 * `restKind` when an upstream answer has one: the error read without the
 * request's own words, which a client cannot make a vendor echo.
 */
export function classify(error: AttemptError): Classification {
  const verdict = classifyAs(error, error.kind);
  // What the request itself put in the error decides no rest (H2).
  return error.restKind === undefined || error.phase !== "response"
    ? verdict
    : { ...verdict, breaker: classifyAs(error, error.restKind).breaker };
}

function classifyAs(
  error: AttemptError,
  given: FailureKind | undefined,
): Classification {
  switch (error.phase) {
    case "cancelled":
      return { retry: "no", failover: false, breaker: { kind: "none" } };
    case "local":
      return { retry: "no", failover: true, breaker: { kind: "none" } };
    case "connect":
      // A failed proxy is not the credential's fault, and retrying it is no use.
      return error.kind === "proxy"
        ? { retry: "no", failover: true, breaker: { kind: "none" } }
        : { retry: "yes", failover: true, breaker: { kind: "count" } };
    case "headers":
      return { retry: "once", failover: true, breaker: { kind: "count" } };
    case "response":
      break;
  }
  const kind =
    given ??
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
    case "policy":
    case "shape":
      // Nothing is wrong with the credential: it does not rest.
      return failover({ kind: "none" });
    case "refused":
      // Every request of this client would be refused: it rests as a failure.
      return failover({ kind: "count" });
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

/**
 * Whether `modelDeny` (a Gateway Key's, such as an agent's hidden models)
 * names `ref` or a group of `path`, the groups a member is reached
 * through: a model the key hides is not reached through a group either.
 */
export function hiddenBy(
  modelDeny: readonly string[] | undefined,
  ref: string,
  path: readonly string[] = [],
): boolean {
  return (
    !!modelDeny?.length &&
    [ref, ...path.filter((step) => step.startsWith("group/"))].some(
      (step) => !modelAllowed(["*"], step, modelDeny),
    )
  );
}

/**
 * The vendor a candidate's requests go to: its endpoint's host (two
 * providers on one API are one vendor), else its provider.
 */
export function vendorOf(candidate: Candidate): string {
  try {
    return new URL(candidate.endpoint).host;
  } catch {
    return `provider:${candidate.provider.id}`;
  }
}

/**
 * After a safety filter refused the request at `queue[index]`, takes the
 * candidates of that vendor out of the rest of the queue (M2): another
 * account of the vendor applies the same policy, and asking each would put
 * the flagged prompt before every one of them.
 */
export function dropVendor(queue: Candidate[], index: number): void {
  const vendor = vendorOf(queue[index]!);
  const left = queue.slice(index + 1);
  queue.splice(
    index + 1,
    left.length,
    ...left.filter((next) => vendorOf(next) !== vendor),
  );
}

/** Safety-filter refusals of one key's requests that fail over within {@link POLICY_WINDOW_MS}. */
export const POLICY_FAILOVERS = 5;
export const POLICY_WINDOW_MS = 10 * 60_000;

/**
 * Safety-filter refusals per Gateway Key (M2): a key whose requests were
 * refused {@link POLICY_FAILOVERS} times within {@link POLICY_WINDOW_MS}
 * gets the next refusals as they are, without asking another vendor.
 */
export class PolicyRefusals {
  #times = new Map<string, number[]>();
  constructor(private readonly clock: () => number) {}

  /** Notes a refusal of `keyId`'s request; whether it may still fail over. */
  note(keyId: string): boolean {
    const now = this.clock();
    const recent = (this.#times.get(keyId) ?? []).filter(
      (at) => now - at < POLICY_WINDOW_MS,
    );
    recent.push(now);
    this.#times.delete(keyId);
    this.#times.set(keyId, recent);
    // Keys that went quiet are dropped first.
    if (this.#times.size > 10_000)
      this.#times.delete(this.#times.keys().next().value!);
    return recent.length <= POLICY_FAILOVERS;
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
 * milliseconds from `now`: ChatGPT's `error.resets_at` (Unix seconds) or
 * `error.resets_in_seconds`, Google's `RetryInfo.retryDelay` (`"20s"`), or,
 * read from `plain` only, Claude Code's `limit reached|<unix>`. That form is
 * free text a vendor's error may echo from the request, so the caller passes
 * `plain` only for a 429 or a subscription backend, and without the
 * request's own words ({@link echoFree}). Undefined when it says none.
 */
export function resetIn(
  body: string,
  now: number,
  plain?: string,
): number | undefined {
  const claude =
    plain === undefined ? null : /limit reached\|(\d{10})\b/i.exec(plain);
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
  /** A long rest cut to {@link PROVISIONAL_MS}: the key whose failure asked for it. */
  provisional?: string;
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
 * model for 10 minutes. A rest or mark longer than {@link PROVISIONAL_MS}
 * is that long at first; only a failure that asks for one again from
 * another Gateway Key gives the full time, so one key cannot rest a shared
 * credential for long.
 */
export class Breakers {
  #states = new Map<string, BreakerState>();
  /** Model marks until when, and the key of one cut short; kept after they pass, until a success. */
  #marks = new Map<string, { until: number; provisional?: string }>();
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
    if (mark !== undefined && mark.until > now)
      return { until: mark.until, reason: "model_not_found" };
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
    if (mark !== undefined && mark.until > now)
      return {
        ok: false,
        reason: `${candidate.ref} is marked unavailable on credential ${candidate.credential.id}`,
        until: mark.until,
      };
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
    if (mark !== undefined && mark.until > now) return true;
    const state = this.#states.get(this.#key(candidate));
    return state?.state === "open" && now < state.until;
  }

  success(candidate: Candidate): void {
    this.#marks.delete(this.#markKey(candidate));
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

  /**
   * Applies `effect` of a failed attempt for the Gateway Key `keyId`
   * (`undefined`: the gateway's own), shortened to {@link PROVISIONAL_MS}
   * as the class says.
   */
  failure(
    candidate: Candidate,
    effect: BreakerEffect,
    failure: Failure,
    errorClass: string,
    keyId: string | undefined,
  ): void {
    const now = this.clock();
    const by = keyId ?? "";
    if (effect.kind === "model") {
      const key = this.#markKey(candidate);
      const previous = this.#marks.get(key)?.provisional;
      this.#marks.set(
        key,
        effect.ms > PROVISIONAL_MS &&
          (previous === undefined || previous === by)
          ? { until: now + PROVISIONAL_MS, provisional: by }
          : { until: now + effect.ms },
      );
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
      case "auth": {
        const ms = effect.kind === "auth" ? OPEN_MAX_MS : effect.ms;
        const previous = state.provisional;
        if (
          ms > PROVISIONAL_MS &&
          (previous === undefined || previous === by)
        ) {
          this.#open(candidate, state, PROVISIONAL_MS, errorClass);
          state.provisional = by;
        } else {
          this.#open(candidate, state, ms, errorClass);
          delete state.provisional;
        }
        if (effect.kind === "auth")
          state.authRef = credentialRef(candidate.credential);
        return;
      }
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
