// SPDX-License-Identifier: MIT
/**
 * Route group rules (Magpie `pv/grouprule.go` and `pv/ruleparse.go`): which
 * member a request goes to first, by what can be seen in the request
 * itself (its length, an image, the reasoning asked for, the agent, a
 * compaction, the hour) and, for a rule with an intent, by what the
 * group's classifier says the user's message is. Checking, matching and
 * the typed form (`use=a/m tokens=200k images`) are here; the gateway reads
 * requests and keeps each turn's decision (`gateway/rules.ts`).
 */
import type {
  GroupRule,
  ModelRef,
  ProviderModel,
  RouteGroup,
  RuleTimeWindow,
} from "./model-plane.js";
import {
  parseModelRef,
  ruleEfforts,
  weekdays,
  type RuleEffort,
  type Weekday,
} from "./model-refs.js";
import {
  groupCapabilities,
  parseGroupMember,
  type GroupCapabilities,
  type ResolvedMember,
} from "./route-groups.js";

/** Rules a group may have. */
export const MAX_RULES = 50;
/** How long an intent may be, in characters (Magpie `MaxIntent`). */
export const MAX_INTENT = 200;
/** Agents one rule may name. */
export const MAX_RULE_AGENTS = 20;

/** The week as a window shows it, Monday first. */
const DAY_ORDER: readonly Weekday[] = [
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
  "sun",
];
const DAY_NAMES = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

/** `HH:MM` or `H:MM` as minutes past midnight. */
function clockMinutes(text: string): number | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!match) return undefined;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours <= 23 && minutes <= 59 ? hours * 60 + minutes : undefined;
}

function clockText(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** A day of the week, `mon` or `Monday` (three letters at least), as {@link weekdays} has it. */
export function parseDay(text: string): Weekday | undefined {
  const lower = text.trim().toLowerCase();
  if (lower.length < 3) return undefined;
  const index = DAY_NAMES.findIndex((name) => name.startsWith(lower));
  return index < 0 ? undefined : weekdays[index];
}

/** A problem with a group's rules: the field (a JSON pointer in the group) and what is wrong. */
export interface RuleProblem {
  pointer: string;
  detail: string;
}

/** What a rule matches, for a list or a ledger entry: `tokens ≥ 200000`, `images`… */
export function ruleConditions(rule: GroupRule): string[] {
  const out: string[] = [];
  if (rule.tokens) out.push(`tokens ≥ ${rule.tokens}`);
  if (rule.images) out.push("images");
  if (rule.effort === "on") out.push("reasoning");
  else if (rule.effort) out.push(`effort ≥ ${rule.effort}`);
  if (rule.agents?.length) out.push(`agent ${rule.agents.join("|")}`);
  if (rule.intent) out.push(`intent "${rule.intent}"`);
  if (rule.compact) out.push("compacting");
  if (rule.time) out.push(`time ${windowText(rule.time)}`);
  return out;
}

/** The days of a window for a list: `Mon–Fri`, `Sat,Sun`; empty for every day. */
function daysText(days: readonly Weekday[]): string {
  const name = (day: Weekday) => day[0]!.toUpperCase() + day.slice(1);
  const out: string[] = [];
  for (let index = 0; index < DAY_ORDER.length;) {
    if (!days.includes(DAY_ORDER[index]!)) {
      index++;
      continue;
    }
    let end = index;
    while (end + 1 < DAY_ORDER.length && days.includes(DAY_ORDER[end + 1]!))
      end++;
    if (end === index) out.push(name(DAY_ORDER[index]!));
    else if (end === index + 1)
      out.push(name(DAY_ORDER[index]!), name(DAY_ORDER[end]!));
    else out.push(`${name(DAY_ORDER[index]!)}–${name(DAY_ORDER[end]!)}`);
    index = end + 1;
  }
  return out.join(",");
}

/** A window as a rule's conditions show it: `09:00–18:00 Mon–Fri`, `all day Sat,Sun`. */
export function windowText(window: RuleTimeWindow): string {
  const hours =
    window.from === window.to ? "all day" : `${window.from}–${window.to}`;
  const days = daysText(window.days ?? []);
  return days ? `${hours} ${days}` : hours;
}

/**
 * A rule checked and put the one way: `use` one of `members`, positive
 * whole `tokens`, `effort` `on` or a level, agents lowercase and once each,
 * the intent's spaces collapsed, the window's hours as `HH:MM` and its days
 * in the week's order (none for all seven), conditions that are false or
 * empty left out. Problems point below `at` (the rule's pointer).
 */
export function cleanRule(
  rule: GroupRule,
  members: readonly string[],
  at: string,
): { rule: GroupRule; problems: RuleProblem[] } {
  const problems: RuleProblem[] = [];
  const problem = (field: string, detail: string) =>
    problems.push({ pointer: `${at}${field}`, detail });
  const use = typeof rule.use === "string" ? rule.use.trim() : "";
  const out: GroupRule = { use };
  if (!use) problem("/use", "says which member the rule sends to");
  else if (!members.includes(use))
    problem(
      "/use",
      `${use} is not a member of the group (its members: ${members.join(", ")})`,
    );
  if (rule.tokens !== undefined) {
    if (!Number.isSafeInteger(rule.tokens) || rule.tokens < 1)
      problem("/tokens", "is a whole number of tokens above 0");
    else out.tokens = rule.tokens;
  }
  if (rule.images) out.images = true;
  if (rule.effort !== undefined) {
    const effort = String(rule.effort).trim().toLowerCase();
    if (effort !== "on" && !(ruleEfforts as readonly string[]).includes(effort))
      problem(
        "/effort",
        `is on or one of ${ruleEfforts.join(", ")}, not ${JSON.stringify(rule.effort)}`,
      );
    else out.effort = effort as "on" | RuleEffort;
  }
  if (rule.agents !== undefined) {
    const agents = [
      ...new Set(
        rule.agents
          .map((agent) => String(agent).trim().toLowerCase())
          .filter(Boolean),
      ),
    ];
    if (!agents.length) problem("/agents", "names at least one agent");
    else if (agents.length > MAX_RULE_AGENTS)
      problem("/agents", `names at most ${MAX_RULE_AGENTS} agents`);
    else if (agents.some((agent) => agent.length > 64))
      problem("/agents", "has an agent id longer than 64 characters");
    else out.agents = agents;
  }
  if (rule.intent !== undefined) {
    const intent = String(rule.intent).split(/\s+/).filter(Boolean).join(" ");
    if (!intent)
      problem(
        "/intent",
        'says what the message asks for: "writing or fixing tests"',
      );
    else if ([...intent].length > MAX_INTENT)
      problem("/intent", `is at most ${MAX_INTENT} characters`);
    else out.intent = intent;
  }
  if (rule.compact) out.compact = true;
  if (rule.time !== undefined) {
    const from = clockMinutes(String(rule.time.from ?? ""));
    const to = clockMinutes(String(rule.time.to ?? ""));
    const days = (rule.time.days ?? []).map((day) => [day, parseDay(day)]);
    const unknown = days.find(([, day]) => day === undefined);
    if (from === undefined)
      problem("/time/from", `${JSON.stringify(rule.time.from)} is not HH:MM`);
    else if (to === undefined)
      problem("/time/to", `${JSON.stringify(rule.time.to)} is not HH:MM`);
    else if (unknown)
      problem(
        "/time/days",
        `${JSON.stringify(unknown[0])} is not a day of the week (mon … sun)`,
      );
    else {
      const named = new Set(days.map(([, day]) => day));
      const ordered = DAY_ORDER.filter((day) => named.has(day));
      const window: RuleTimeWindow = {
        from: clockText(from),
        to: clockText(to),
        ...(ordered.length && ordered.length < 7 ? { days: ordered } : {}),
      };
      if (window.from === window.to && !window.days)
        problem(
          "/time",
          "is the whole day, every day: give days or other hours",
        );
      else out.time = window;
    }
  }
  if (!problems.length && !ruleConditions(out).length)
    problem(
      "",
      "needs a condition (tokens, images, effort, agents, intent, compact or time)",
    );
  return { rule: out, problems };
}

/**
 * A group's rules, classifier and effort checked and put the one way (see
 * {@link cleanRule}): at most {@link MAX_RULES} rules, each sending to one
 * of the members; a rule with an intent, and `effort: "auto"`, need the
 * classifier; the classifier is a Model Ref or another group. Whether the
 * classifier exists is the caller's to check. Problems point into the group.
 */
export function cleanGroupRules(
  group: Pick<RouteGroup, "id" | "members" | "rules" | "classifier" | "effort">,
): {
  rules: GroupRule[] | undefined;
  problems: RuleProblem[];
} {
  const problems: RuleProblem[] = [];
  const rules: GroupRule[] = [];
  if ((group.rules?.length ?? 0) > MAX_RULES)
    problems.push({
      pointer: "/rules",
      detail: `a group has at most ${MAX_RULES} rules`,
    });
  else
    (group.rules ?? []).forEach((rule, index) => {
      const cleaned = cleanRule(rule, group.members, `/rules/${index}`);
      problems.push(...cleaned.problems);
      rules.push(cleaned.rule);
      if (cleaned.rule.intent && !group.classifier)
        problems.push({
          pointer: `/rules/${index}/intent`,
          detail:
            "a rule with an intent needs the group's classifier, the model that tells which intent a message is",
        });
    });
  if (group.classifier !== undefined) {
    const named = parseModelRef(group.classifier);
    if (!named)
      problems.push({
        pointer: "/classifier",
        detail: "is a Model Ref (provider/model) or group/<id>",
      });
    else if (named.kind === "group" && named.group === group.id)
      problems.push({
        pointer: "/classifier",
        detail: "a group cannot be its own classifier",
      });
  }
  if (group.effort !== undefined && group.effort !== "auto")
    problems.push({ pointer: "/effort", detail: "is auto when given" });
  else if (group.effort === "auto" && !group.classifier)
    problems.push({
      pointer: "/effort",
      detail:
        "auto needs the group's classifier, the model that judges how much reasoning a turn wants",
    });
  return { rules: rules.length ? rules : undefined, problems };
}

/** What a rule looks at in a request (Magpie `RuleRequest`). */
export interface RuleRequest {
  /** How long the request is taken to be, in tokens. */
  tokens: number;
  /** It carries an image, in this turn or before. */
  images: boolean;
  /** The agent asked for reasoning. */
  thinking: boolean;
  /** At what level, when it said. */
  effort?: string;
  /** The agent's id, as the ledger shows it. */
  agent?: string;
  /** The one of the rules' intents the classifier said the message is. */
  intent?: string;
  /** The agent is compacting its conversation. */
  compact: boolean;
  /** When the turn began (epoch milliseconds), read in `timeZone`. */
  at: number;
  timeZone: string;
}

const clocks = new Map<string, Intl.DateTimeFormat>();

/** The minutes past midnight and the weekday of `at` in `timeZone`. */
function localClock(
  at: number,
  timeZone: string,
): { minutes: number; day: number } {
  let format = clocks.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
    if (clocks.size > 64) clocks.clear();
    clocks.set(timeZone, format);
  }
  const parts = Object.fromEntries(
    format.formatToParts(at).map((part) => [part.type, part.value]),
  );
  return {
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
    day: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
      parts.weekday ?? "",
    ),
  };
}

/** Whether `at` is within the window, in `timeZone` (Magpie `TimeWindow.Holds`). */
export function windowHolds(
  window: RuleTimeWindow,
  at: number,
  timeZone: string,
): boolean {
  const from = clockMinutes(window.from);
  const to = clockMinutes(window.to);
  if (from === undefined || to === undefined || !Number.isFinite(at))
    return false;
  const clock = localClock(at, timeZone);
  let day = clock.day;
  if (from < to) {
    if (clock.minutes < from || clock.minutes >= to) return false;
  } else if (from > to) {
    if (clock.minutes >= to && clock.minutes < from) return false;
    // Before `to`: the window began the day before.
    if (clock.minutes < to) day = (day + 6) % 7;
  }
  return !window.days?.length || window.days.includes(weekdays[day]!);
}

/** Whether the request matches the rule but for its intent: whether the classifier's answer is all it waits on. */
export function ruleMatchesBesidesIntent(
  rule: GroupRule,
  request: RuleRequest,
): boolean {
  if (rule.tokens && request.tokens < rule.tokens) return false;
  if (rule.images && !request.images) return false;
  if (rule.compact && !request.compact) return false;
  if (rule.time && !windowHolds(rule.time, request.at, request.timeZone))
    return false;
  if (rule.effort === "on") {
    if (!request.thinking) return false;
  } else if (rule.effort) {
    const asked = (ruleEfforts as readonly string[]).indexOf(
      request.effort ?? "",
    );
    if (asked < ruleEfforts.indexOf(rule.effort)) return false;
  }
  if (
    rule.agents?.length &&
    !rule.agents.includes((request.agent ?? "").toLowerCase())
  )
    return false;
  return ruleConditions(rule).length > 0;
}

/** Whether the request is one the rule is for (Magpie `Rule.Matches`). */
export function ruleMatches(rule: GroupRule, request: RuleRequest): boolean {
  if (
    rule.intent &&
    rule.intent.toLowerCase() !== (request.intent ?? "").toLowerCase()
  )
    return false;
  return ruleMatchesBesidesIntent(rule, request);
}

/** The index of the first rule the request matches, -1 for none. */
export function matchRule(
  rules: readonly GroupRule[],
  request: RuleRequest,
): number {
  return rules.findIndex((rule) => ruleMatches(rule, request));
}

/**
 * The members the rules after the `n`-th (from 1) that also match send to,
 * each once, leaving out `use`: where a request the rule sent to `use`
 * fails over to before the group's others (Magpie `ThenUses`).
 */
export function thenUses(
  rules: readonly GroupRule[],
  request: RuleRequest,
  n: number,
  use: string,
): string[] {
  const out: string[] = [];
  for (const rule of rules.slice(n))
    if (
      rule.use !== use &&
      !out.includes(rule.use) &&
      ruleMatches(rule, request)
    )
      out.push(rule.use);
  return out;
}

/**
 * The intents the classifier is to choose among: those of the rules that
 * match but for their intent, up to the first that matches outright (no
 * rule after it could be the first to match); none when no rule before it
 * has an intent, and the classifier is then not asked (Magpie `Intents`).
 */
export function ruleIntents(
  rules: readonly GroupRule[],
  request: RuleRequest,
): string[] {
  const out: string[] = [];
  for (const rule of rules) {
    if (!ruleMatchesBesidesIntent(rule, request)) continue;
    if (!rule.intent) break;
    if (
      !out.some((intent) => intent.toLowerCase() === rule.intent!.toLowerCase())
    )
      out.push(rule.intent);
  }
  return out;
}

/** A typed rule that cannot be read: `word` is the part at fault. */
export class RuleSyntaxError extends Error {
  constructor(
    readonly word: string,
    message: string,
  ) {
    super(message);
    this.name = "RuleSyntaxError";
  }
}

/** One word of a typed line and where it stands in the line (UTF-16 offsets, `end` exclusive). */
export interface RuleWord {
  word: string;
  start: number;
  end: number;
}

/**
 * A typed line split into words, a `"quoted"` part kept in one
 * (`intent="a quick question"` is the word `intent=a quick question`), each
 * with where it stands, for an editor to mark the word an error names.
 */
export function ruleWordSpans(line: string): RuleWord[] {
  const out: RuleWord[] = [];
  let word = "";
  let start = -1;
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!;
    if (!quoted && (char === " " || char === "\t")) {
      if (start >= 0) out.push({ word, start, end: index });
      word = "";
      start = -1;
      continue;
    }
    if (start < 0) start = index;
    if (char === '"') quoted = !quoted;
    else word += char;
  }
  if (start >= 0) out.push({ word, start, end: line.length });
  return out;
}

/** A typed line split into words ({@link ruleWordSpans} without the places). */
export function ruleWords(line: string): string[] {
  return ruleWordSpans(line).map((span) => span.word);
}

/**
 * The words of `line` a {@link RuleSyntaxError} names: the word itself, else
 * the words it is part of (a day of `days=mon,funday`); none for a word the
 * line lacks (`use` when it is missing).
 */
export function faultySpans(line: string, word: string): RuleWord[] {
  const spans = ruleWordSpans(line);
  const exact = spans.filter((span) => span.word === word);
  return exact.length
    ? exact
    : word
      ? spans.filter((span) => span.word.includes(word))
      : [];
}

/** A length typed as `200000`, `200k` or `1.5m`, in tokens. */
export function parseTokens(text: string): number | undefined {
  const lower = text.trim().toLowerCase().replaceAll("_", "");
  const multiplier = lower.endsWith("k") ? 1e3 : lower.endsWith("m") ? 1e6 : 1;
  const digits = multiplier === 1 ? lower : lower.slice(0, -1);
  if (!/^\d+(?:\.\d+)?$/.test(digits)) return undefined;
  const tokens = Math.floor(Number(digits) * multiplier);
  return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : undefined;
}

/** Days typed as `mon-fri`, `sat,sun` or `mon,wed-fri`; a range may run past Sunday (`fri-mon`). */
export function parseDays(text: string): Weekday[] {
  const out: Weekday[] = [];
  for (const part of text.split(/[,\s]+/).filter(Boolean)) {
    const [a = "", b] = part.replaceAll("–", "-").split("-", 2);
    const from = parseDay(a);
    if (!from)
      throw new RuleSyntaxError(
        part,
        `days: ${JSON.stringify(a)} is not a day of the week (mon … sun)`,
      );
    const to = b === undefined ? from : parseDay(b);
    if (!to)
      throw new RuleSyntaxError(
        part,
        `days: ${JSON.stringify(b)} is not a day of the week (mon … sun)`,
      );
    for (let index = weekdays.indexOf(from); ; index = (index + 1) % 7) {
      if (!out.includes(weekdays[index]!)) out.push(weekdays[index]!);
      if (weekdays[index] === to) break;
    }
  }
  if (!out.length)
    throw new RuleSyntaxError(
      text,
      "days names the days of the week it holds on: days=mon-fri",
    );
  return out;
}

/**
 * The group's member a typed model names (Magpie `GroupMember`): its whole
 * text, else its model, else its model's last part, else the same without
 * the member's effort and `:fast`, each ignoring case; one match only.
 */
export function memberNamed(
  members: readonly string[],
  text: string,
  groupId: string,
): string {
  const asked = text.trim();
  const bare = (member: string) => member.slice(member.indexOf("/") + 1);
  const last = (member: string) => member.slice(member.lastIndexOf("/") + 1);
  const plain = (member: string) => {
    const named = parseGroupMember(member);
    return named?.kind === "model" ? named.ref : member;
  };
  const same = (text: string) => text.toLowerCase() === asked.toLowerCase();
  for (const match of [
    (member: string) => member === asked,
    (member: string) => same(member),
    (member: string) => same(bare(member)),
    (member: string) => same(last(member)),
    (member: string) => same(plain(member)),
    (member: string) => same(bare(plain(member))),
  ]) {
    const hits = members.filter(match);
    if (hits.length === 1) return hits[0]!;
    if (hits.length > 1)
      throw new RuleSyntaxError(
        `use=${text}`,
        `${asked} is ${hits.join(" and ")}: name one`,
      );
  }
  throw new RuleSyntaxError(
    `use=${text}`,
    `${asked || "(nothing)"} is not in group/${groupId} (its members: ${members.join(", ")})`,
  );
}

/** The words {@link parseRule} reads, as `key` or `key=value`. */
export const RULE_KEYS: ReadonlySet<string> = new Set([
  "use",
  "model",
  "to",
  "tokens",
  "context",
  "longer",
  "images",
  "image",
  "compact",
  "compacting",
  "compaction",
  "effort",
  "reasoning",
  "thinking",
  "agents",
  "agent",
  "intent",
  "asks",
  "about",
  "time",
  "hours",
  "between",
  "days",
  "day",
  "classifier",
  "classify",
  "by",
  "at",
]);

/** The key of a typed word: `tokens` of `tokens=200k`, lowercase. */
export function ruleKey(word: string): string {
  const equals = word.indexOf("=");
  return (equals < 0 ? word : word.slice(0, equals)).trim().toLowerCase();
}

const SWITCH_ON = ["", "yes", "true", "on", "1"];
const SWITCH_OFF = ["no", "false", "off", "0"];

/** A typed rule: the rule, the place asked for (from 1) and the classifier given with it. */
export interface TypedRule {
  rule: GroupRule;
  at?: number;
  classifier?: string;
}

/**
 * Read a typed rule (Magpie `ParseRule`): `use=<member>` with `tokens=200k`,
 * `images`, `effort[=on|low…max]`, `agents=a,b`, `intent="…"`, `compact`,
 * `time=09:00-18:00`, `days=mon-fri`, `classifier=<model>` and `at=<n>`
 * (the common synonyms too). The member is found among `members`
 * ({@link memberNamed}). Throws {@link RuleSyntaxError} naming the word at
 * fault; the rule is then to be checked with {@link cleanRule}.
 */
export function parseRule(
  members: readonly string[],
  groupId: string,
  words: readonly string[],
): TypedRule {
  const rule: Partial<GroupRule> = {};
  let at: number | undefined;
  let classifier: string | undefined;
  const toggle = (word: string, name: string, value: string): boolean => {
    const lower = value.toLowerCase();
    if (SWITCH_ON.includes(lower)) return true;
    if (SWITCH_OFF.includes(lower)) return false;
    throw new RuleSyntaxError(
      word,
      `${name} takes no value (or yes/no), not ${JSON.stringify(value)}`,
    );
  };
  for (const word of words) {
    const equals = word.indexOf("=");
    const key = ruleKey(word);
    const value = equals < 0 ? "" : word.slice(equals + 1);
    switch (key) {
      case "use":
      case "model":
      case "to":
        rule.use = memberNamed(members, value, groupId);
        break;
      case "tokens":
      case "context":
      case "longer": {
        const tokens = parseTokens(value);
        if (tokens === undefined)
          throw new RuleSyntaxError(
            word,
            `tokens ${JSON.stringify(value)} is not a length (200000, 200k, 1m)`,
          );
        rule.tokens = tokens;
        break;
      }
      case "images":
      case "image":
        rule.images = toggle(word, "images", value);
        break;
      case "compact":
      case "compacting":
      case "compaction":
        rule.compact = toggle(word, "compact", value);
        break;
      case "effort":
      case "reasoning":
      case "thinking": {
        const effort = equals < 0 ? "on" : value.trim().toLowerCase();
        if (
          effort !== "on" &&
          !(ruleEfforts as readonly string[]).includes(effort)
        )
          throw new RuleSyntaxError(
            word,
            `effort is on or one of ${ruleEfforts.join(", ")}, not ${JSON.stringify(value)}`,
          );
        rule.effort = effort as "on" | RuleEffort;
        break;
      }
      case "agents":
      case "agent":
        rule.agents = value.split(/[,\s]+/).filter(Boolean);
        if (!rule.agents.length)
          throw new RuleSyntaxError(
            word,
            "agents names agents: agents=claude,codex",
          );
        break;
      case "intent":
      case "asks":
      case "about":
        rule.intent = value.trim();
        if (!rule.intent)
          throw new RuleSyntaxError(
            word,
            'intent says what the message asks for: intent="writing or fixing tests"',
          );
        break;
      case "time":
      case "hours":
      case "between": {
        const [from = "", to] = value.replaceAll("–", "-").split("-", 2);
        if (
          to === undefined ||
          clockMinutes(from) === undefined ||
          clockMinutes(to) === undefined
        )
          throw new RuleSyntaxError(
            word,
            `time is hours of the day, local time: time=09:00-18:00 (or 22:00-08:00, past midnight), not ${JSON.stringify(value)}`,
          );
        rule.time = {
          from: from.trim(),
          to: to.trim(),
          ...(rule.time?.days ? { days: rule.time.days } : {}),
        };
        break;
      }
      case "days":
      case "day":
        rule.time = {
          // The whole day, unless time= says otherwise.
          from: rule.time?.from ?? "00:00",
          to: rule.time?.to ?? "00:00",
          days: parseDays(value),
        };
        break;
      case "classifier":
      case "classify":
      case "by":
        classifier = value.trim();
        if (!classifier || !parseModelRef(classifier))
          throw new RuleSyntaxError(
            word,
            "classifier=<provider/model>: the model that tells which intent a message is",
          );
        break;
      case "at": {
        const place = Number(value);
        if (!/^\d+$/.test(value) || place < 1)
          throw new RuleSyntaxError(
            word,
            `at is a place from 1, not ${JSON.stringify(value)}`,
          );
        at = place;
        break;
      }
      default:
        throw new RuleSyntaxError(
          word,
          `unknown ${JSON.stringify(word)} (use, tokens, images, effort, agents, intent, compact, time, days, classifier, at)`,
        );
    }
  }
  if (!rule.use)
    throw new RuleSyntaxError(
      "use",
      `use=<model> is missing: one of ${members.join(", ")}`,
    );
  return {
    rule: rule as GroupRule,
    ...(at !== undefined ? { at } : {}),
    ...(classifier !== undefined ? { classifier } : {}),
  };
}

/** A rule as {@link parseRule} reads it back. */
export function ruleLine(rule: GroupRule): string {
  const out = [`use=${rule.use}`];
  if (rule.tokens) out.push(`tokens=${rule.tokens}`);
  if (rule.images) out.push("images");
  if (rule.effort) out.push(`effort=${rule.effort}`);
  if (rule.agents?.length) out.push(`agents=${rule.agents.join(",")}`);
  if (rule.intent) out.push(`intent="${rule.intent.replaceAll('"', "")}"`);
  if (rule.compact) out.push("compact");
  if (rule.time) {
    if (rule.time.from !== rule.time.to || !rule.time.days?.length)
      out.push(`time=${rule.time.from}-${rule.time.to}`);
    if (rule.time.days?.length)
      out.push(
        `days=${daysText(rule.time.days).toLowerCase().replaceAll("–", "-")}`,
      );
  }
  return out.join(" ");
}

/**
 * A group's capabilities with what its rules make reachable (Magpie
 * `ruledEntry`), over {@link groupCapabilities} of its models:
 *
 * - images, when a rule of images alone (no other condition) sends every
 *   request with an image to a member whose models all take images, and
 *   every rule before it, which may take such a request first, sends to a
 *   member that takes them too;
 * - a larger window, when a rule of length alone (`tokens` and nothing
 *   else) sends every request at least that long to a member with more
 *   room: the window is that member's, if every other member whose window
 *   is known takes requests up to the rule's length, and no larger than
 *   the window of any rule before it (a member of a rule before it whose
 *   window is not known leaves the group's as it was).
 *
 * A member's window is the smallest known of its models'. Without rules
 * the group offers what all its models do.
 */
export function ruledCapabilities(
  group: Pick<RouteGroup, "members" | "rules">,
  models: readonly ResolvedMember[],
  metadata: (ref: ModelRef) => ProviderModel | undefined,
): GroupCapabilities {
  const base = groupCapabilities(models, metadata);
  const rules = group.rules ?? [];
  if (!rules.length) return base;
  /** What a member's models take: the smallest known window (0 when none is), and whether all take images. */
  const of = (member: string) => {
    const known = models
      .filter((model) => model.member === member)
      .map((model) => metadata(model.ref));
    if (!known.length) return undefined;
    let window = 0;
    for (const model of known) {
      const value = model?.contextWindow ?? 0;
      if (value > 0 && (window === 0 || value < window)) window = value;
    }
    return {
      window,
      sees: known.every(
        (model) => model?.inputModalities?.includes("image") === true,
      ),
    };
  };
  let window = base.contextWindow ?? 0;
  let images = base.inputModalities?.includes("image") === true;
  rules.forEach((rule, index) => {
    const target = of(rule.use);
    if (!target) return;
    const before = rules.slice(0, index);
    const alone = (field: keyof GroupRule) =>
      (Object.keys(rule) as (keyof GroupRule)[]).every(
        (name) => name === "use" || name === field,
      );
    if (
      rule.images &&
      alone("images") &&
      target.sees &&
      !images &&
      !before.some((earlier) => !of(earlier.use)?.sees)
    )
      images = true;
    if (!rule.tokens || !alone("tokens") || target.window <= window) return;
    // Every request up to the rule's length must fit whoever may get it.
    let fits = target.window;
    for (const member of group.members) {
      if (member === rule.use) continue;
      const other = of(member);
      if (other && other.window > 0 && other.window < rule.tokens) fits = 0;
    }
    // A longer one may still be taken by a rule before it.
    for (const earlier of before) {
      const other = of(earlier.use);
      if (!other) fits = 0;
      else if (other.window < fits) fits = other.window;
    }
    if (fits > window) window = fits;
  });
  const modalities =
    images && !base.inputModalities?.includes("image")
      ? [...(base.inputModalities ?? ["text"]), "image" as const]
      : base.inputModalities;
  return {
    ...base,
    ...(window > 0 ? { contextWindow: window } : {}),
    ...(modalities ? { inputModalities: modalities } : {}),
  };
}
