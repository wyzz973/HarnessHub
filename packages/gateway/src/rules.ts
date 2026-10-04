// SPDX-License-Identifier: MIT
/**
 * Route group rules at request time (Magpie `gw/rules.go`). A group's rules
 * are looked at when a user's turn begins, and what they decided holds for
 * the rest of the turn: the agent's tool results go back to the model that
 * asked for them. The one exception is a conversation that grows past 95%
 * of the window of the model it is on while a rule sends it to one with
 * more room. A compaction is looked at on its own and changes nothing the
 * turn decided. The rules of a group inside the group decide among its own
 * members, down the member that goes first. Decisions are kept in memory,
 * per group, conversation and the conversation's first words (so that an
 * agent's subagent keeps its own), for as long as stickiness keeps a
 * conversation.
 */
import { createHash } from "node:crypto";
import type {
  GroupRule,
  ReasoningEffort,
  RouteGroup,
  RouteGroupId,
  WireProtocol,
} from "@harnesshub/core/model-plane";
import { parseModelRef } from "@harnesshub/core/model-plane";
import {
  matchRule,
  ruleIntents,
  thenUses,
  type RuleRequest,
} from "@harnesshub/core/route-rules";
import type { Classifier } from "./classify.js";
import { isCompactionRequest } from "./compacting.js";
import { record } from "./protocol.js";
import type { Candidate } from "./routing.js";
import { STICKY_ENTRIES, STICKY_TTL_MS } from "./sticky.js";

/** A turn's decisions remembered, at most (and for {@link STICKY_TTL_MS}). */
const TURNS = Math.max(STICKY_ENTRIES * 8, 4096);
/** A conversation moves within a turn once it is this share of its model's window. */
const OUTGROWN_SHARE = 0.95;

type Part = "text" | "image" | "result" | "other";
interface Message {
  user: boolean;
  parts: { kind: Part; text?: string }[];
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Text, image and tool-result parts of message content, by protocol. */
function partsOf(content: unknown): Message["parts"] {
  if (typeof content === "string") return [{ kind: "text", text: content }];
  return list(content).map((item): Message["parts"][number] => {
    const part = record(item) ?? {};
    const type = part.type;
    if (
      typeof part.text === "string" &&
      (type === undefined || /text/.test(String(type)))
    )
      return { kind: "text", text: part.text };
    if (
      type === "image_url" ||
      type === "input_image" ||
      type === "image" ||
      /^image\//.test(
        String(
          record(part.inlineData ?? part.inline_data)?.mimeType ??
            record(part.inlineData ?? part.inline_data)?.mime_type ??
            record(part.fileData ?? part.file_data)?.mimeType ??
            "",
        ),
      )
    )
      return { kind: "image" };
    if (type === "tool_result" || part.functionResponse !== undefined)
      return { kind: "result" };
    return { kind: "other" };
  });
}

/** A request's messages, user or not, with their parts (Magpie's parsed `Request`). */
function messagesOf(protocol: WireProtocol, raw: Record<string, unknown>) {
  const out: Message[] = [];
  switch (protocol) {
    case "chat":
      for (const item of list(raw.messages)) {
        const message = record(item) ?? {};
        if (message.role === "tool")
          out.push({ user: true, parts: [{ kind: "result" }] });
        else
          out.push({
            user: message.role === "user",
            parts: partsOf(message.content),
          });
      }
      break;
    case "responses":
      if (typeof raw.input === "string")
        out.push({ user: true, parts: [{ kind: "text", text: raw.input }] });
      for (const entry of list(raw.input)) {
        const item = record(entry) ?? {};
        const type = item.type ?? "message";
        if (type === "message")
          out.push({
            user: item.role === "user",
            parts: partsOf(item.content),
          });
        else if (
          type === "function_call_output" ||
          type === "custom_tool_call_output" ||
          type === "tool_search_output"
        )
          out.push({ user: true, parts: [{ kind: "result" }] });
        else out.push({ user: false, parts: [] });
      }
      break;
    case "anthropic":
      for (const item of list(raw.messages)) {
        const message = record(item) ?? {};
        const parts = partsOf(message.content);
        // An image inside a tool result is an image the request carries.
        for (const block of list(message.content)) {
          const value = record(block);
          if (value?.type === "tool_result")
            parts.push(
              ...partsOf(value.content).filter((part) => part.kind === "image"),
            );
        }
        out.push({ user: message.role === "user", parts });
      }
      break;
    case "gemini":
      for (const item of list(raw.contents)) {
        const content = record(item) ?? {};
        out.push({
          user: content.role === undefined || content.role === "user",
          parts: partsOf(content.parts),
        });
      }
      break;
  }
  return out;
}

/** Characters of the request's text: strings, but no base64 media nor sealed reasoning. */
function textSize(value: unknown, key = ""): number {
  if (typeof value === "string")
    return key === "data" ||
      key === "signature" ||
      key === "encrypted_content" ||
      key === "thoughtSignature" ||
      key === "thought_signature" ||
      value.startsWith("data:")
      ? 0
      : value.length;
  if (Array.isArray(value))
    return value.reduce<number>((sum, item) => sum + textSize(item), 0);
  const object = record(value);
  if (!object) return 0;
  let size = 0;
  for (const [name, item] of Object.entries(object))
    size += textSize(item, name);
  return size;
}

/** The reasoning the agent asked for: whether any, and the level when it said. */
function reasoningOf(
  protocol: WireProtocol,
  raw: Record<string, unknown>,
): { thinking: boolean; effort?: string } {
  const level = (value: unknown) =>
    typeof value === "string" && value ? value.toLowerCase() : undefined;
  let effort: string | undefined;
  let thinking = false;
  switch (protocol) {
    case "chat":
      effort = level(raw.reasoning_effort);
      break;
    case "responses":
      effort = level(record(raw.reasoning)?.effort);
      break;
    case "anthropic": {
      const type = record(raw.thinking)?.type;
      thinking = type === "enabled" || type === "adaptive";
      effort = level(record(raw.output_config)?.effort);
      break;
    }
    case "gemini": {
      const config = record(
        record(raw.generationConfig ?? raw.generation_config)?.thinkingConfig,
      );
      effort = level(config?.thinkingLevel);
      const budget = config?.thinkingBudget;
      thinking = typeof budget === "number" && budget !== 0;
      break;
    }
  }
  if (effort === "none") return { thinking: false };
  return {
    thinking: thinking || effort !== undefined,
    ...(effort ? { effort } : {}),
  };
}

/** What the rules see in one request. */
export interface RuleView {
  /** Its length in tokens: its text in characters / 4. */
  tokens: number;
  images: boolean;
  thinking: boolean;
  effort?: string;
  /** The user's turns so far (messages with words of their own, not tool results). */
  turn: number;
  /** The request hands tool results back: the turn goes on. */
  within: boolean;
  /** A hash of the conversation's first user words, which tells an agent's subagents from it. */
  firstWords: string;
  /** What the user said to begin the turn, for the classifier. */
  text: string;
}

const REMINDERS = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

/** What the rules see in a request of `protocol`. Pure. */
export function ruleView(
  protocol: WireProtocol,
  raw: Record<string, unknown>,
): RuleView {
  const messages = messagesOf(protocol, raw);
  let turn = 0;
  let within = false;
  for (const message of messages) {
    if (!message.user) continue;
    const words = message.parts.some(
      (part) => part.kind === "text" || part.kind === "image",
    );
    const result = message.parts.some((part) => part.kind === "result");
    if (words && !result) turn++;
    within = result;
  }
  const texts = (message: Message | undefined) =>
    (message?.parts ?? [])
      .filter((part) => part.kind === "text")
      .map((part) => part.text ?? "");
  const first = messages.find((message) => message.user);
  const last = messages.findLast(
    (message) =>
      message.user && message.parts.some((part) => part.kind !== "result"),
  );
  let text = texts(last).join("\n").replace(REMINDERS, "").trim();
  const characters = [...text];
  if (characters.length > 4000)
    text = `${characters.slice(0, 3000).join("")}\n…\n${characters.slice(-1000).join("")}`;
  return {
    tokens: Math.floor(textSize(raw) / 4),
    images: messages.some(
      (message) =>
        message.user && message.parts.some((part) => part.kind === "image"),
    ),
    ...reasoningOf(protocol, raw),
    turn,
    within,
    firstWords: createHash("sha256")
      .update(texts(first).join(""))
      .digest("hex")
      .slice(0, 24),
    text,
  };
}

/** What the classifier was asked as a turn began, and said. */
export interface Classified {
  by: string;
  intents: string[];
  intent?: string;
  effort?: ReasoningEffort;
  cached?: boolean;
  resting?: boolean;
  error?: string;
}

/** What a group's rules decided for one request (Magpie `RuleHit`). */
export interface RuleHit {
  /** The rule, from 1; 0 when none matched. */
  n: number;
  /** The member it puts first. */
  use?: string;
  /** The members the rules after it that match too send to, in turn. */
  then: string[];
  /** Decided when the turn began. */
  held?: boolean;
  /** The turn began before the gateway saw it (or its rule changed): nothing moves it. */
  waits?: boolean;
  /** The conversation outgrew its model within the turn and a rule moved it. */
  grown?: boolean;
  /** A compaction, looked at on its own; `small` the members passed over as too short for it. */
  compact?: boolean;
  small?: string[];
  turn: number;
  tokens: number;
  classified?: Classified;
  /** The reasoning the classifier picked for the turn (`effort: "auto"`). */
  pick?: ReasoningEffort;
}

interface Turn {
  turn: number;
  use?: string;
  n: number;
  at: number;
  /** What the vendor counted the conversation's last request as. */
  input: number;
  intent?: string;
  effort?: ReasoningEffort;
}

/** Whether a group decides anything as a turn begins. */
export function ruled(group: RouteGroup | undefined): boolean {
  return Boolean(group?.rules?.length || group?.effort === "auto");
}

/** The decisions of route group rules, owned by one gateway handler. */
export class GroupRules {
  #turns = new Map<string, Turn>();
  constructor(
    private readonly clock: () => number,
    readonly classifier: Classifier,
  ) {}

  /**
   * The rule `group`'s request goes by (Magpie `ruleFor`): at a turn's
   * start the first rule it matches, asking the classifier first when a
   * rule that may match has an intent, or when the group picks the turn's
   * effort and the agent asked for reasoning; within the turn, what was
   * decided when it began, unless it outgrew its model; a compaction, the
   * first `compact` rule whose member can take it. `contexts` are the
   * members' windows where known; `ask` is false for a classifier's own
   * call, which asks no classifier in turn.
   */
  async decide(input: {
    key: string;
    group: RouteGroup;
    contexts: ReadonlyMap<string, number>;
    view: RuleView;
    agent?: string;
    compact: boolean;
    timeZone: string;
    ask: boolean;
    signal: AbortSignal;
  }): Promise<RuleHit> {
    const { key, group, contexts, view } = input;
    const rules = group.rules ?? [];
    const now = this.clock();
    let had = this.#turns.get(key);
    if (had && now - had.at > STICKY_TTL_MS) had = undefined;
    const request: RuleRequest = {
      tokens: Math.max(view.tokens, had?.input ?? 0),
      images: view.images,
      thinking: view.thinking,
      ...(view.effort ? { effort: view.effort } : {}),
      ...(input.agent ? { agent: input.agent } : {}),
      compact: false,
      at: now,
      timeZone: input.timeZone,
    };
    const hit: RuleHit = {
      n: 0,
      then: [],
      turn: view.turn,
      tokens: request.tokens,
    };
    const finish = () => {
      if (hit.use && hit.n >= 1)
        hit.then = thenUses(rules, request, hit.n, hit.use);
      return hit;
    };
    if (input.compact && rules.some((rule) => rule.compact)) {
      // On its own: the requests after it go on as the turn would. A model
      // known to take less than the conversation would only refuse it.
      request.compact = true;
      hit.compact = true;
      for (const [index, rule] of rules.entries()) {
        if (!ruleMatchesNow(rules, index, request)) continue;
        const window = contexts.get(rule.use) ?? 0;
        if (window > 0 && window < request.tokens) {
          (hit.small ??= []).push(rule.use);
          continue;
        }
        hit.n = index + 1;
        hit.use = rule.use;
        break;
      }
      return finish();
    }
    if (view.within) {
      if (had?.intent) request.intent = had.intent;
      if (!had || (had.turn !== view.turn && view.turn > 0)) hit.waits = true;
      else if (had.use === undefined) hit.held = true;
      else if (had.n >= 1 && rules[had.n - 1]?.use === had.use) {
        hit.held = true;
        hit.n = had.n;
        hit.use = had.use;
      } else hit.waits = true;
      if (!hit.waits && view.thinking && had?.effort) hit.pick = had.effort;
      const grown = outgrown(rules, contexts, hit, request);
      if (grown) {
        this.#keep(key, {
          turn: view.turn,
          n: grown.n,
          use: grown.use,
          at: now,
          input: had?.input ?? 0,
          ...(request.intent ? { intent: request.intent } : {}),
          ...(had?.effort ? { effort: had.effort } : {}),
        });
        delete hit.held;
        delete hit.waits;
        hit.grown = true;
        hit.n = grown.n;
        hit.use = grown.use;
        return finish();
      }
      if (had) had.at = now;
      return finish();
    }
    // A new turn: the classifier only when a rule that could be the first
    // to match waits on its intent, or it picks the turn's effort.
    const intents = ruleIntents(rules, request);
    const effort = group.effort === "auto" && view.thinking;
    if (intents.length || effort) {
      const classified: Classified = {
        by: group.classifier ?? "",
        intents,
      };
      const before = {
        ...(had?.intent && intents.includes(had.intent)
          ? { intent: had.intent }
          : {}),
        ...(had?.effort && effort ? { effort: had.effort } : {}),
      };
      if (!group.classifier) classified.error = "the group has no classifier";
      else if (!input.ask)
        classified.error =
          "this is a classifier's own call, which asks no classifier";
      else if (!view.text) classified.error = "the message has no words";
      else {
        const said = await this.classifier.classify(
          group.classifier,
          intents,
          before,
          effort,
          view.text,
          input.signal,
        );
        if (said.verdict.intent) classified.intent = said.verdict.intent;
        if (said.verdict.effort) classified.effort = said.verdict.effort;
        if (said.cached) classified.cached = true;
        if (said.resting) classified.resting = true;
        if (said.error) classified.error = said.error;
      }
      if (classified.intent) request.intent = classified.intent;
      hit.classified = classified;
      if (classified.effort) hit.pick = classified.effort;
    }
    const index = matchRule(rules, request);
    if (index >= 0) {
      hit.n = index + 1;
      hit.use = rules[index]!.use;
    }
    this.#keep(key, {
      turn: view.turn,
      n: hit.n,
      at: now,
      // What the vendor counted, kept from the turn before.
      input: this.#turns.get(key)?.input ?? had?.input ?? 0,
      ...(hit.use ? { use: hit.use } : {}),
      ...(request.intent ? { intent: request.intent } : {}),
      ...(hit.pick ? { effort: hit.pick } : {}),
    });
    return finish();
  }

  /** The conversation's request was answered, the vendor counting `input` tokens of it: its next turns go by at least that. */
  answered(key: string, input: number): void {
    const turn = this.#turns.get(key);
    if (turn && input > 0) turn.input = input;
  }

  #keep(key: string, turn: Turn): void {
    this.#turns.delete(key);
    this.#turns.set(key, turn);
    for (const [oldest, kept] of this.#turns) {
      if (this.#turns.size <= TURNS) break;
      if (this.#turns.size > TURNS || turn.at - kept.at > STICKY_TTL_MS)
        this.#turns.delete(oldest);
    }
  }
}

function ruleMatchesNow(
  rules: readonly GroupRule[],
  index: number,
  request: RuleRequest,
): boolean {
  // matchRule over the one rule keeps the matching in one place.
  return matchRule([rules[index]!], request) === 0;
}

/**
 * The rule a request within a turn moves by when it no longer fits the
 * model the turn is on (Magpie `outgrown`): it is at least 95% of that
 * member's window (of the smallest member's, when no rule decided), and
 * the first rule it matches sends it to a member known to take more.
 */
function outgrown(
  rules: readonly GroupRule[],
  contexts: ReadonlyMap<string, number>,
  held: RuleHit,
  request: RuleRequest,
): { n: number; use: string } | undefined {
  let limit = 0;
  if (held.use) limit = contexts.get(held.use) ?? 0;
  else
    for (const window of contexts.values())
      if (window > 0 && (limit === 0 || window < limit)) limit = window;
  if (limit === 0 || request.tokens < limit * OUTGROWN_SHARE) return undefined;
  const index = matchRule(rules, request);
  const rule = rules[index];
  if (!rule || rule.use === held.use || (contexts.get(rule.use) ?? 0) <= limit)
    return undefined;
  return { n: index + 1, use: rule.use };
}

/** The windows of a group's members where known: a group inside it, the smallest of its models'. */
function memberContexts(
  candidates: readonly Candidate[],
  depth: number,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const candidate of candidates) {
    const member = candidate.path?.[depth];
    if (member === undefined) continue;
    const window = candidate.model?.contextWindow ?? 0;
    const known = out.get(member);
    if (known === undefined || (window > 0 && (known === 0 || window < known)))
      out.set(member, window);
  }
  return out;
}

/**
 * Put first the candidates of `order`'s members (by `memberOf`) that are
 * not resting, a member's before the next's and each's in the order they
 * had; everyone else follows as they were (Magpie `ruleFirst`). `lead` is
 * the index in `order` of the member that now goes first, -1 when none of
 * them is ready (the candidates are then as they were).
 */
function ruleFirst(
  order: readonly string[],
  candidates: readonly Candidate[],
  memberOf: (candidate: Candidate) => string | undefined,
  blocked: (candidate: Candidate) => boolean,
): { candidates: Candidate[]; lead: number } {
  const rank = (candidate: Candidate) => {
    if (blocked(candidate)) return -1;
    const member = memberOf(candidate);
    return member === undefined ? -1 : order.indexOf(member);
  };
  const ranked = candidates.map((candidate, index) => ({
    candidate,
    index,
    rank: rank(candidate),
  }));
  ranked.sort((a, b) => {
    if (a.rank === b.rank) return a.index - b.index;
    if (a.rank < 0) return 1;
    if (b.rank < 0) return -1;
    return a.rank - b.rank;
  });
  const lead = ranked[0]?.rank ?? -1;
  return lead < 0
    ? { candidates: [...candidates], lead }
    : { candidates: ranked.map((item) => item.candidate), lead };
}

/**
 * The ledger's words for a decision: `rule:2`, `rule:held:none`,
 * `rule:compact:1`…, none for a group without rules (it only picks the
 * effort); then how the classifier answered.
 */
function hitPatches(hit: RuleHit, prefix: string, rules: boolean): string[] {
  const n = hit.n ? String(hit.n) : "none";
  const out: string[] = [];
  if (rules)
    out.push(
      hit.compact
        ? `${prefix}:compact:${n}`
        : hit.grown
          ? `${prefix}:grown:${n}`
          : hit.waits
            ? `${prefix}:waits`
            : hit.held
              ? `${prefix}:held:${n}`
              : `${prefix}:${n}`,
    );
  const classified = hit.classified;
  if (classified)
    out.push(
      classified.cached
        ? "classifier:cached"
        : classified.resting
          ? "classifier:resting"
          : classified.error
            ? "classifier:failed"
            : "classifier:asked",
    );
  return out;
}

/** What the rules did to one call. */
export interface RulesApplied {
  candidates: Candidate[];
  /** For the ledger: `rule:…`, `classifier:…`, `effort:auto:<level>`. */
  patches: string[];
  /** A compaction a rule routed: it leaves the conversation's records alone. */
  compact: boolean;
  /** A rule moved the conversation off the candidate stickiness kept. */
  brokeSticky: boolean;
  /** The conversation's request was answered, the vendor counting `input` tokens. */
  answered(input: number): void;
}

/**
 * Apply the rules of `group`, and of the groups inside it down the member
 * that goes first, to its planned candidates (Magpie's use of `ruleFor`,
 * `applyRule` and `nestedRules`). A rule's member, then those of the rules
 * after it that match too, go first, over the candidate stickiness kept as
 * a turn begins; within a turn stickiness stands. The effort the
 * classifier picked goes to the candidates without one of their own.
 * Undefined when no group on the way decides anything.
 */
export async function applyRules(input: {
  rules: GroupRules;
  group: RouteGroup;
  groups: ReadonlyMap<RouteGroupId, RouteGroup>;
  candidates: Candidate[];
  protocol: WireProtocol;
  raw: Record<string, unknown>;
  conversation: string;
  agent?: string;
  timeZone: string;
  ask: boolean;
  signal: AbortSignal;
  /** Stickiness put the conversation's last candidate first. */
  stuck: boolean;
  blocked: (candidate: Candidate) => boolean;
}): Promise<RulesApplied | undefined> {
  if (!ruled(input.group) && ![...input.groups.values()].some(ruled))
    return undefined;
  const view = ruleView(input.protocol, input.raw);
  const compact = isCompactionRequest(input.protocol, input.raw);
  const base = `${input.group.id}|${input.conversation}|${view.firstWords}`;
  const patches: string[] = [];
  const keys: string[] = [];
  let candidates = input.candidates;
  let brokeSticky = false;
  let pick: ReasoningEffort | undefined;
  let compacted = false;
  const decideAt = async (
    group: RouteGroup,
    key: string,
    depth: number,
    within: (candidate: Candidate) => boolean,
    prefix: string,
  ) => {
    const hit = await input.rules.decide({
      key,
      group,
      contexts: memberContexts(candidates.filter(within), depth),
      view,
      ...(input.agent ? { agent: input.agent } : {}),
      compact,
      timeZone: input.timeZone,
      ask: input.ask,
      signal: input.signal,
    });
    patches.push(...hitPatches(hit, prefix, Boolean(group.rules?.length)));
    if (!hit.compact) keys.push(key);
    pick ??= hit.pick;
    if (hit.use && !(hit.held && input.stuck && !brokeSticky)) {
      const was = candidates[0];
      const ordered = ruleFirst(
        [hit.use, ...hit.then],
        candidates,
        (candidate) =>
          within(candidate) ? candidate.path?.[depth] : undefined,
        input.blocked,
      );
      candidates = ordered.candidates;
      if (ordered.lead !== 0) patches.push(`${prefix}:unready`);
      if (ordered.lead >= 0 && input.stuck && candidates[0] !== was)
        brokeSticky = true;
    }
    return hit;
  };
  if (ruled(input.group)) {
    const hit = await decideAt(input.group, base, 0, () => true, "rule");
    compacted = hit.compact === true;
  }
  let key = base;
  for (let depth = 1; candidates.length; depth++) {
    const lead = candidates[0]!;
    const path = lead.path ?? [];
    if (path.length <= depth) break;
    const named = parseModelRef(path[depth - 1]!);
    if (named?.kind !== "group") break;
    key += `>${named.group}`;
    const inner = input.groups.get(named.group);
    if (!ruled(inner)) continue;
    const head = path.slice(0, depth).join("\u0000");
    await decideAt(
      inner!,
      key,
      depth,
      (candidate) =>
        (candidate.path ?? []).slice(0, depth).join("\u0000") === head &&
        (candidate.path?.length ?? 0) > depth,
      `rule@${named.group}`,
    );
  }
  if (pick) {
    const effort = pick;
    candidates = candidates.map((candidate) =>
      candidate.effort ? candidate : { ...candidate, effort },
    );
    patches.push(`effort:auto:${effort}`);
  }
  return {
    candidates,
    patches,
    compact: compacted,
    brokeSticky,
    answered: (tokens) => {
      for (const at of keys) input.rules.answered(at, tokens);
    },
  };
}
