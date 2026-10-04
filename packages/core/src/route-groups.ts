// SPDX-License-Identifier: MIT
/**
 * The members of route groups (Magpie `pv/group.go`, `groupeffort.go` and
 * `groupfast.go`). A member is written as a string:
 *
 * - `provider/model`: the model, reasoning as the request asks;
 * - `provider/model:<effort>`: the model asked for that reasoning effort
 *   (`none` to `max`) whatever the request asked; the same model at another
 *   effort is another member;
 * - either of those with `:fast` last: sent in its vendor's fast mode where
 *   the model has one (OpenAI's priority processing, Anthropic's fast
 *   mode);
 * - `group/<id>`: another group, planned by its own strategy, at most
 *   {@link GROUP_NEST_LIMIT} deep and never inside itself.
 *
 * A model's own id may have a colon (`deepseek-r1:free`, `qwen:7b`), so a
 * last part is a suffix only when it names a level or `fast` and the whole
 * id is not a model the provider lists.
 */
import {
  parseModelRef,
  reasoningEfforts,
  type ModelRef,
  type ProviderConfig,
  type ProviderId,
  type ProviderModel,
  type ReasoningEffort,
  type RouteGroup,
  type RouteGroupId,
  type WireProtocol,
} from "./model-plane.js";

/** How deep groups may sit inside groups (Magpie `maxNest`). */
export const GROUP_NEST_LIMIT = 8;

/** The last part of a member sent in its vendor's fast mode. */
export const FAST_SUFFIX = "fast";

/** OpenAI models with priority processing. */
const OPENAI_FAST = /^(?:gpt-|o\d)/;
/** Claude models with fast mode (Anthropic `speed: "fast"`), a dated id as its model's. */
const CLAUDE_FAST = ["claude-opus-4-8", "claude-opus-5", "claude-opus-5-5"];

function host(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * How a model is sent in its vendor's fast mode, if its model has one
 * the gateway can ask for (Magpie `CanFast`): `service_tier: "priority"` for
 * OpenAI's GPT and o-series models on api.openai.com and a ChatGPT
 * account's GPT models, `speed: "fast"` for the Claude models with fast
 * mode on api.anthropic.com. A relay or another cloud may refuse the field,
 * so they have none.
 */
export function fastMode(
  provider: ProviderConfig,
  model: string,
  upstream: WireProtocol,
): "priority" | "speed" | undefined {
  if (provider.subscription)
    return provider.subscription.backend === "siwc" &&
      model.startsWith("gpt-") &&
      upstream === "responses"
      ? "priority"
      : undefined;
  if (
    (upstream === "responses" || upstream === "chat") &&
    host(provider.endpoints[upstream]) === "api.openai.com" &&
    OPENAI_FAST.test(model)
  )
    return "priority";
  if (
    upstream === "anthropic" &&
    host(provider.endpoints.anthropic) === "api.anthropic.com" &&
    CLAUDE_FAST.includes(model.toLowerCase().replace(/-\d{8}$/, ""))
  )
    return "speed";
  return undefined;
}

/** Whether some upstream of the provider has a fast mode for the model; for checking a member as it is written. */
export function canFast(provider: ProviderConfig, model: string): boolean {
  const upstreams: WireProtocol[] = provider.subscription
    ? ["responses"]
    : ["responses", "chat", "anthropic"];
  return upstreams.some(
    (upstream) => fastMode(provider, model, upstream) !== undefined,
  );
}

/** One member of a route group, its suffixes split off. */
export type GroupMember =
  | {
      kind: "model";
      /** `provider/model`, without the suffixes. */
      ref: ModelRef;
      provider: ProviderId;
      model: string;
      /** The effort the member is fixed at; absent follows the request. */
      effort?: ReasoningEffort;
      fast: boolean;
    }
  | { kind: "group"; group: RouteGroupId };

/** Whether a provider lists a model of exactly this id; used to keep colons that are part of an id. */
export type ListedModel = (provider: ProviderId, model: string) => boolean;

const notListed: ListedModel = () => false;

function isEffort(value: string): value is ReasoningEffort {
  return (reasoningEfforts as readonly string[]).includes(value);
}

/**
 * Split a member as written into what it names. A model member's last part
 * `fast` (any case) marks it fast, and a last part that is a reasoning
 * effort fixes its effort, each only when `listed` says the provider has no
 * model of the id with that part. Undefined for text that names neither a
 * model nor a group; a group takes no suffix, so `group/<id>:high` is
 * undefined.
 */
export function parseGroupMember(
  text: string,
  listed: ListedModel = notListed,
): GroupMember | undefined {
  const parsed = parseModelRef(text);
  if (!parsed) return undefined;
  if (parsed.kind === "group") return parsed;
  let model = parsed.model;
  let fast = false;
  let effort: ReasoningEffort | undefined;
  const last = (value: string) => {
    const at = value.lastIndexOf(":");
    return at > 0
      ? { head: value.slice(0, at), tail: value.slice(at + 1).toLowerCase() }
      : undefined;
  };
  const fastPart = last(model);
  if (fastPart?.tail === FAST_SUFFIX && !listed(parsed.provider, model)) {
    fast = true;
    model = fastPart.head;
  }
  const effortPart = last(model);
  if (
    effortPart &&
    isEffort(effortPart.tail) &&
    !listed(parsed.provider, model)
  ) {
    effort = effortPart.tail;
    model = effortPart.head;
  }
  return {
    kind: "model",
    ref: `${parsed.provider}/${model}` as ModelRef,
    provider: parsed.provider,
    model,
    ...(effort !== undefined ? { effort } : {}),
    fast,
  };
}

/** A member as it is stored: suffixes lowercase, the effort before `:fast`. */
export function memberText(member: GroupMember): string {
  if (member.kind === "group") return `group/${member.group}`;
  return `${member.ref}${member.effort ? `:${member.effort}` : ""}${member.fast ? `:${FAST_SUFFIX}` : ""}`;
}

/** One model a group routes to, wherever it sits. */
export interface ResolvedMember {
  /** The member of the group itself that leads to it: the model, or the group it is in. */
  member: string;
  /** The groups between the group and the model, outermost first; empty for its own models. */
  via: RouteGroupId[];
  ref: ModelRef;
  provider: ProviderId;
  model: string;
  effort?: ReasoningEffort;
  fast: boolean;
}

/**
 * Every model of a group in member order, a group in it giving its own in
 * its place. A model met again at the same effort is kept where it came
 * first; a group that is unknown, already on the way down, or deeper than
 * {@link GROUP_NEST_LIMIT} is left out, so a loop written around the API
 * ends where it closes.
 */
export function groupModels(
  group: RouteGroup,
  lookup: (id: RouteGroupId) => RouteGroup | undefined,
  listed: ListedModel = notListed,
): ResolvedMember[] {
  const out: ResolvedMember[] = [];
  const seen = new Set<string>();
  const walk = (
    current: RouteGroup,
    via: RouteGroupId[],
    top: string | undefined,
  ) => {
    for (const text of current.members) {
      const member = parseGroupMember(text, listed);
      if (!member) continue;
      if (member.kind === "group") {
        if (
          member.group === group.id ||
          via.includes(member.group) ||
          via.length >= GROUP_NEST_LIMIT
        )
          continue;
        const inner = lookup(member.group);
        if (inner) walk(inner, [...via, member.group], top ?? text);
        continue;
      }
      const key = `${member.ref}:${member.effort ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        member: top ?? text,
        via,
        ref: member.ref,
        provider: member.provider,
        model: member.model,
        ...(member.effort ? { effort: member.effort } : {}),
        fast: member.fast,
      });
    }
  };
  walk(group, [], undefined);
  return out;
}

/** Why a member of a group cannot be stored, and which member. */
export interface NestingProblem {
  index: number;
  detail: string;
}

/**
 * Check the groups inside `group` as it would be stored: each must exist,
 * none may contain `group` however deep (it would contain itself), and the
 * nesting below `group` may go at most {@link GROUP_NEST_LIMIT} deep.
 * `lookup` returns the stored groups (and visible automatic ones); the
 * group's own stored version is ignored.
 */
export function nestingProblems(
  group: RouteGroup,
  lookup: (id: RouteGroupId) => RouteGroup | undefined,
): NestingProblem[] {
  const find = (id: RouteGroupId) => (id === group.id ? group : lookup(id));
  /** The path from `from` down to `group`, when `from` contains it. */
  const wayTo = (from: RouteGroup, path: RouteGroupId[]): RouteGroupId[] => {
    for (const text of from.members) {
      const member = parseGroupMember(text);
      if (member?.kind !== "group" || path.includes(member.group)) continue;
      if (member.group === group.id) return [...path, member.group];
      const inner = find(member.group);
      if (inner) {
        const way = wayTo(inner, [...path, member.group]);
        if (way.length) return way;
      }
    }
    return [];
  };
  /** How deep the groups below `from` go: 0 for none. */
  const depth = (from: RouteGroup, path: RouteGroupId[]): number => {
    let deepest = 0;
    for (const text of from.members) {
      const member = parseGroupMember(text);
      if (member?.kind !== "group" || path.includes(member.group)) continue;
      const inner = find(member.group);
      if (inner)
        deepest = Math.max(deepest, 1 + depth(inner, [...path, member.group]));
    }
    return deepest;
  };
  const problems: NestingProblem[] = [];
  group.members.forEach((text, index) => {
    const member = parseGroupMember(text);
    if (member?.kind !== "group") return;
    if (member.group === group.id) {
      problems.push({ index, detail: "a group cannot contain itself" });
      return;
    }
    const inner = lookup(member.group);
    if (!inner) {
      problems.push({ index, detail: `there is no group ${member.group}` });
      return;
    }
    const way = wayTo(inner, [member.group]);
    if (way.length) {
      problems.push({
        index,
        detail: `group/${member.group} contains group/${group.id} (${[group.id, ...way].join(" ⊃ ")}), so group/${group.id} would contain itself`,
      });
      return;
    }
    const below = 1 + depth(inner, [group.id, member.group]);
    if (below > GROUP_NEST_LIMIT)
      problems.push({
        index,
        detail: `groups would sit ${below} deep inside group/${group.id}; at most ${GROUP_NEST_LIMIT} may`,
      });
  });
  return problems;
}

/** The levels an agent is offered for a reasoning model whose own levels are not known. */
export const DEFAULT_REASONING_EFFORTS: readonly ReasoningEffort[] =
  Object.freeze(["low", "medium", "high"]);

/** The reasoning levels a model offers: {@link DEFAULT_REASONING_EFFORTS} when it reasons, none otherwise. */
export function modelEfforts(
  model: ProviderModel | undefined,
): ReasoningEffort[] {
  return model?.reasoning === true ? [...DEFAULT_REASONING_EFFORTS] : [];
}

/** What a group offers as one model. */
export interface GroupCapabilities {
  /** The smallest window, when every model's is known. */
  contextWindow?: number;
  /** The smallest output limit, when every model's is known. */
  maxOutputTokens?: number;
  /** Whether it reasons: it offers levels, or every model reasons. */
  reasoning?: boolean;
  /** The levels offered, lowest first. */
  efforts: ReasoningEffort[];
  /** The input modalities every model takes, when every model's are known. */
  inputModalities?: NonNullable<ProviderModel["inputModalities"]>;
}

/**
 * A group's capabilities from its models ({@link groupModels}): the
 * smallest window and output limit, input modalities only when every model
 * has them, and the reasoning levels every model that follows the request
 * offers. A model fixed at an effort takes whatever level is asked, so it
 * does not narrow them; with every model fixed, the group offers the levels
 * they are fixed at, lowest first.
 */
export function groupCapabilities(
  models: readonly ResolvedMember[],
  metadata: (ref: ModelRef) => ProviderModel | undefined,
): GroupCapabilities {
  const known = models.map((member) => metadata(member.ref));
  const complete =
    known.length > 0 && known.every((model) => model !== undefined);
  const least = (values: Array<number | undefined>) =>
    values.length && values.every((value) => value !== undefined)
      ? Math.min(...(values as number[]))
      : undefined;
  const contextWindow = least(known.map((model) => model?.contextWindow));
  const maxOutputTokens = least(known.map((model) => model?.maxOutputTokens));
  let efforts: ReasoningEffort[] | undefined;
  const fixed = new Set<ReasoningEffort>();
  models.forEach((member, index) => {
    if (member.effort) {
      fixed.add(member.effort);
      return;
    }
    const offered = modelEfforts(known[index]);
    efforts = efforts
      ? efforts.filter((level) => offered.includes(level))
      : offered;
  });
  const levels =
    efforts ?? reasoningEfforts.filter((level) => fixed.has(level));
  const modalities = complete
    ? known
        .map((model) => model!.inputModalities)
        .reduce<ProviderModel["inputModalities"]>(
          (all, list) =>
            all === undefined || list === undefined
              ? undefined
              : all.filter((value) => list.includes(value)),
          known[0]!.inputModalities,
        )
    : undefined;
  const allReason =
    complete && known.every((model) => model!.reasoning !== undefined)
      ? known.every((model) => model!.reasoning === true)
      : undefined;
  return {
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(levels.length
      ? { reasoning: true }
      : allReason !== undefined
        ? { reasoning: allReason }
        : {}),
    efforts: levels,
    ...(modalities !== undefined ? { inputModalities: modalities } : {}),
  };
}
