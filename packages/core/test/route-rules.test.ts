// SPDX-License-Identifier: MIT
/** Route group rules: the typed form, checking, matching and the stored record. */
import test from "node:test";
import assert from "node:assert/strict";
import type {
  GroupRule,
  ProviderModel,
  RouteGroup,
} from "../src/model-plane.js";
import { isRouteGroup } from "../src/model-plane-records.js";
import { groupModels } from "../src/route-groups.js";
import {
  cleanGroupRules,
  cleanRule,
  matchRule,
  parseRule,
  ruleConditions,
  ruleIntents,
  ruleLine,
  ruledCapabilities,
  ruleMatches,
  ruleWords,
  RuleSyntaxError,
  thenUses,
  windowHolds,
  type RuleRequest,
} from "../src/route-rules.js";

const MEMBERS = [
  "openai/gpt-5",
  "deepseek/deepseek-v4-flash",
  "glm/glm-5:high",
];

void test("a typed rule: every word, its synonyms, a quoted intent, and the member found by part of its name", () => {
  const typed = parseRule(
    MEMBERS,
    "g",
    ruleWords(
      'model=deepseek-v4-flash longer=1.5m image effort agents=Claude,codex about="a  quick question" compacting hours=22:00-08:00 days=fri-mon classifier=groq/llama at=2',
    ),
  );
  assert.deepEqual(typed, {
    rule: {
      use: "deepseek/deepseek-v4-flash",
      tokens: 1_500_000,
      images: true,
      effort: "on",
      agents: ["Claude", "codex"],
      intent: "a  quick question",
      compact: true,
      time: {
        from: "22:00",
        to: "08:00",
        days: ["fri", "sat", "sun", "mon"],
      },
    },
    at: 2,
    classifier: "groq/llama",
  });
  // Checked, it is put the one way and reads back the same.
  const { rule, problems } = cleanRule(typed.rule, MEMBERS, "");
  assert.deepEqual(problems, []);
  assert.deepEqual(rule.agents, ["claude", "codex"]);
  assert.equal(rule.intent, "a quick question");
  assert.deepEqual(rule.time?.days, ["mon", "fri", "sat", "sun"]);
  assert.equal(
    ruleLine(rule),
    'use=deepseek/deepseek-v4-flash tokens=1500000 images effort=on agents=claude,codex intent="a quick question" compact time=22:00-08:00 days=mon,fri-sun',
  );
  assert.deepEqual(
    cleanRule(
      parseRule(MEMBERS, "g", ruleWords(ruleLine(rule))).rule,
      MEMBERS,
      "",
    ).rule,
    rule,
  );
  // A member named by its whole text, its model, or its model's last part.
  for (const name of ["glm/glm-5:high", "GLM-5:HIGH", "gpt-5", "glm-5"])
    assert.ok(parseRule(MEMBERS, "g", [`use=${name}`, "images"]).rule.use);
  // days alone is the whole of those days.
  assert.deepEqual(
    parseRule(MEMBERS, "g", ["use=gpt-5", "days=sat,sun"]).rule.time,
    { from: "00:00", to: "00:00", days: ["sat", "sun"] },
  );
});

void test("a typed rule that cannot be read names the word at fault", () => {
  const fails = (line: string, word: string, message: RegExp) =>
    assert.throws(
      () => parseRule(MEMBERS, "g", ruleWords(line)),
      (error: unknown) =>
        error instanceof RuleSyntaxError &&
        error.word === word &&
        message.test(error.message),
      line,
    );
  fails(
    "use=gpt-5 colour=red",
    "colour=red",
    /unknown "colour=red" \(use, tokens/,
  );
  fails(
    "use=gpt-5 tokens=lots",
    "tokens=lots",
    /tokens "lots" is not a length/,
  );
  fails("use=gpt-5 tokens=-5", "tokens=-5", /not a length/);
  fails(
    "use=gpt-5 effort=huge",
    "effort=huge",
    /effort is on or one of low, medium, high, xhigh, max, not "huge"/,
  );
  fails("use=gpt-5 images=maybe", "images=maybe", /images takes no value/);
  fails(
    "use=gpt-5 compact=sometimes",
    "compact=sometimes",
    /compact takes no value/,
  );
  fails("use=gpt-5 time=9-5", "time=9-5", /time is hours of the day/);
  fails("use=gpt-5 time=25:00-08:00", "time=25:00-08:00", /time is hours/);
  fails("use=gpt-5 days=funday", "funday", /"funday" is not a day of the week/);
  fails("use=gpt-5 days=mon-xyz", "mon-xyz", /"xyz" is not a day/);
  fails("use=gpt-5 at=0", "at=0", /at is a place from 1/);
  fails(
    "use=gpt-5 classifier=nonsense",
    "classifier=nonsense",
    /classifier=<provider\/model>/,
  );
  fails(
    'use=gpt-5 intent=""',
    "intent=",
    /intent says what the message asks for/,
  );
  fails("use=gpt-5 agents=", "agents=", /agents names agents/);
  fails("use=claude images", "use=claude", /claude is not in group\/g/);
  fails("tokens=200k", "use", /use=<model> is missing/);
  assert.throws(
    () => parseRule(["a/m:high", "a/m:low"], "g", ["use=m", "images"]),
    /m is a\/m:high and a\/m:low: name one/,
  );
});

void test("checking rules: a member to send to, a condition, valid fields, and the classifier rules with intents need", () => {
  const problems = (group: Partial<RouteGroup>) =>
    cleanGroupRules({
      id: "g" as RouteGroup["id"],
      members: MEMBERS,
      ...group,
    }).problems;
  assert.deepEqual(
    problems({
      rules: [
        { use: "openai/gpt-4", images: true },
        { use: "openai/gpt-5" },
        { use: "openai/gpt-5", tokens: 0 },
        { use: "openai/gpt-5", tokens: 1.5 },
        { use: "openai/gpt-5", effort: "huge" as "high" },
        { use: "openai/gpt-5", agents: [" "] },
        { use: "openai/gpt-5", intent: "x".repeat(201) },
        { use: "openai/gpt-5", time: { from: "9", to: "17:00" } },
        {
          use: "openai/gpt-5",
          time: { from: "09:00", to: "17:00", days: ["xyz" as "mon"] },
        },
        { use: "openai/gpt-5", time: { from: "09:00", to: "09:00" } },
        {
          use: "openai/gpt-5",
          time: {
            from: "00:00",
            to: "00:00",
            days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
          },
        },
        { use: "openai/gpt-5", intent: "a quick question" },
      ],
    }).map((problem) => problem.pointer),
    [
      "/rules/0/use",
      "/rules/1",
      "/rules/2/tokens",
      "/rules/3/tokens",
      "/rules/4/effort",
      "/rules/5/agents",
      "/rules/6/intent",
      "/rules/7/time/from",
      "/rules/8/time/days",
      "/rules/9/time",
      "/rules/10/time",
      "/rules/11/intent",
    ],
  );
  assert.deepEqual(
    problems({ classifier: "group/g" }).map((problem) => problem.detail),
    ["a group cannot be its own classifier"],
  );
  assert.deepEqual(
    problems({ classifier: "no slash" }).map((problem) => problem.pointer),
    ["/classifier"],
  );
  assert.deepEqual(
    problems({ effort: "auto" }).map((problem) => problem.pointer),
    ["/effort"],
  );
  assert.deepEqual(problems({ effort: "auto", classifier: "a/judge" }), []);
  assert.deepEqual(
    problems({
      rules: Array.from({ length: 51 }, () => ({
        use: "openai/gpt-5",
        images: true,
      })),
    }).map((problem) => problem.pointer),
    ["/rules"],
  );
});

const request = (fields: Partial<RuleRequest> = {}): RuleRequest => ({
  tokens: 100,
  images: false,
  thinking: false,
  compact: false,
  // Friday 2 October 2026, 12:00 UTC.
  at: Date.parse("2026-10-02T12:00:00.000Z"),
  timeZone: "UTC",
  ...fields,
});

void test("each field matches when it holds and fails when it does not", () => {
  const cases: [GroupRule, Partial<RuleRequest>, Partial<RuleRequest>][] = [
    [{ use: "a", tokens: 200 }, { tokens: 200 }, { tokens: 199 }],
    [{ use: "a", images: true }, { images: true }, { images: false }],
    [{ use: "a", effort: "on" }, { thinking: true }, { thinking: false }],
    [
      { use: "a", effort: "high" },
      { thinking: true, effort: "xhigh" },
      { thinking: true, effort: "medium" },
    ],
    // A level the rules do not know is below every one.
    [
      { use: "a", effort: "low" },
      { thinking: true, effort: "low" },
      { thinking: true, effort: "minimal" },
    ],
    [{ use: "a", agents: ["claude"] }, { agent: "Claude" }, { agent: "codex" }],
    [{ use: "a", agents: ["claude"] }, { agent: "claude" }, {}],
    [
      { use: "a", intent: "a quick question" },
      { intent: "A Quick Question" },
      { intent: "a hard problem" },
    ],
    [{ use: "a", compact: true }, { compact: true }, { compact: false }],
    [
      { use: "a", time: { from: "11:00", to: "13:00" } },
      {},
      { at: Date.parse("2026-10-02T13:00:00.000Z") },
    ],
    // The daemon's time zone decides the hour: 12:00 UTC is 20:00 in Shanghai.
    [
      { use: "a", time: { from: "19:00", to: "21:00" } },
      { timeZone: "Asia/Shanghai" },
      {},
    ],
    [
      { use: "a", time: { from: "00:00", to: "00:00", days: ["fri"] } },
      {},
      { at: Date.parse("2026-10-03T12:00:00.000Z") },
    ],
    // Past midnight, the window is of the day it began: Friday's 22:00–08:00
    // takes Saturday's early hours, and Friday's early hours are Thursday's.
    [
      { use: "a", time: { from: "22:00", to: "08:00", days: ["fri"] } },
      { at: Date.parse("2026-10-03T03:00:00.000Z") },
      { at: Date.parse("2026-10-02T03:00:00.000Z") },
    ],
    [
      { use: "a", time: { from: "22:00", to: "08:00", days: ["fri"] } },
      { at: Date.parse("2026-10-02T23:00:00.000Z") },
      { at: Date.parse("2026-10-03T23:00:00.000Z") },
    ],
  ];
  for (const [rule, holds, fails] of cases) {
    assert.ok(ruleMatches(rule, request(holds)), JSON.stringify([rule, holds]));
    assert.ok(
      !ruleMatches(rule, request(fails)),
      JSON.stringify([rule, fails]),
    );
  }
  // Every condition of a rule must hold, and a rule without one matches nothing.
  const both: GroupRule = { use: "a", images: true, tokens: 200 };
  assert.ok(ruleMatches(both, request({ images: true, tokens: 300 })));
  assert.ok(!ruleMatches(both, request({ images: true, tokens: 100 })));
  assert.ok(!ruleMatches({ use: "a" }, request()));
  assert.ok(!windowHolds({ from: "11:00", to: "13:00" }, Number.NaN, "UTC"));
  assert.deepEqual(
    ruleConditions({
      use: "a",
      tokens: 5,
      images: true,
      effort: "high",
      agents: ["claude", "codex"],
      intent: "x",
      compact: true,
      time: {
        from: "09:00",
        to: "18:00",
        days: ["mon", "tue", "wed", "thu", "fri"],
      },
    }),
    [
      "tokens ≥ 5",
      "images",
      "effort ≥ high",
      "agent claude|codex",
      'intent "x"',
      "compacting",
      "time 09:00–18:00 Mon–Fri",
    ],
  );
});

void test("the first rule that matches decides; the rules after it that match too come next; the classifier chooses among intents up to it", () => {
  const rules: GroupRule[] = [
    { use: "a", intent: "a hard problem" },
    { use: "b", images: true },
    { use: "c", intent: "a quick question" },
    { use: "d", tokens: 50 },
    { use: "b", tokens: 10 },
    { use: "e", intent: "never asked" },
  ];
  const plain = request();
  assert.equal(matchRule(rules, plain), 3);
  assert.deepEqual(thenUses(rules, plain, 4, "d"), ["b"]);
  assert.equal(matchRule(rules, request({ tokens: 1 })), -1);
  // The intents of rules before the first that matches outright.
  assert.deepEqual(ruleIntents(rules, plain), [
    "a hard problem",
    "a quick question",
  ]);
  assert.deepEqual(ruleIntents(rules, request({ images: true })), [
    "a hard problem",
  ]);
  // When the first rule that could match has no intent, nobody is asked.
  assert.deepEqual(ruleIntents([{ use: "b", tokens: 1 }, ...rules], plain), []);
  assert.equal(matchRule(rules, request({ intent: "a quick question" })), 2);
});

void test("a stored group's rules are checked and already in their stored form", () => {
  const stored = (rules: unknown, extra: Record<string, unknown> = {}) => ({
    id: "g",
    strategy: "order",
    stickiness: "auto",
    members: MEMBERS,
    rules,
    createdAt: "2026-10-05T00:00:00.000Z",
    updatedAt: "2026-10-05T00:00:00.000Z",
    ...extra,
  });
  assert.ok(isRouteGroup(stored([{ use: "openai/gpt-5", images: true }])));
  assert.ok(
    isRouteGroup(
      stored([{ use: "openai/gpt-5", intent: "a quick question" }], {
        classifier: "groq/llama",
        effort: "auto",
      }),
    ),
  );
  for (const [rules, extra] of [
    // Not in the stored form.
    [[{ use: "openai/gpt-5", effort: "HIGH" }], {}],
    [[{ use: "openai/gpt-5", time: { from: "9:00", to: "17:00" } }], {}],
    [[{ use: "openai/gpt-5", images: false, tokens: 5 }], {}],
    // Invalid.
    [[{ use: "openai/gpt-4", images: true }], {}],
    [[{ use: "openai/gpt-5" }], {}],
    [[{ use: "openai/gpt-5", images: true, extra: 1 }], {}],
    [[{ use: "openai/gpt-5", tokens: "5" }], {}],
    [[{ use: "openai/gpt-5", intent: "x" }], {}],
    [[], { effort: "manual" }],
    [[], { classifier: 5 }],
  ] as const)
    assert.ok(
      !isRouteGroup(stored(rules, extra)),
      JSON.stringify([rules, extra]),
    );
});

void test("a group advertises what its rules make reachable: images and a larger window, as Magpie's ruledEntry", () => {
  const metadata = new Map<string, ProviderModel>([
    [
      "a/small",
      { id: "small", contextWindow: 8_000, inputModalities: ["text"] },
    ],
    ["a/mid", { id: "mid", contextWindow: 100_000, inputModalities: ["text"] }],
    [
      "a/big",
      { id: "big", contextWindow: 200_000, inputModalities: ["text", "image"] },
    ],
    ["a/blind", { id: "blind" }],
  ]);
  const of = (members: string[], rules: GroupRule[]) => {
    const group = {
      id: "g",
      strategy: "order",
      stickiness: "auto",
      members,
      rules,
      createdAt: "2026-10-05T00:00:00.000Z",
      updatedAt: "2026-10-05T00:00:00.000Z",
    } as RouteGroup;
    return ruledCapabilities(
      group,
      groupModels(group, () => undefined),
      (ref) => metadata.get(ref),
    );
  };
  const plain = of(["a/small", "a/big"], []);
  assert.deepEqual(
    [plain.contextWindow, plain.inputModalities],
    [8_000, ["text"]],
  );
  // A rule of images alone, to a member that takes them.
  assert.deepEqual(
    of(["a/small", "a/big"], [{ use: "a/big", images: true }]).inputModalities,
    ["text", "image"],
  );
  // Not with another condition, nor after a rule to a member that does not.
  assert.deepEqual(
    of(["a/small", "a/big"], [{ use: "a/big", images: true, tokens: 5 }])
      .inputModalities,
    ["text"],
  );
  assert.deepEqual(
    of(
      ["a/small", "a/big"],
      [
        { use: "a/small", agents: ["claude"] },
        { use: "a/big", images: true },
      ],
    ).inputModalities,
    ["text"],
  );
  // A rule of length alone: the larger window, when every other member
  // takes requests up to the rule's length.
  assert.equal(
    of(["a/small", "a/big"], [{ use: "a/big", tokens: 8_000 }]).contextWindow,
    200_000,
  );
  assert.equal(
    of(["a/small", "a/big"], [{ use: "a/big", tokens: 9_000 }]).contextWindow,
    8_000,
    "small cannot take a request of 8,500 tokens, which no rule moves",
  );
  assert.equal(
    of(["a/small", "a/big"], [{ use: "a/big", tokens: 8_000, images: true }])
      .contextWindow,
    8_000,
    "not with another condition",
  );
  // A rule before it caps the window by its member's.
  assert.equal(
    of(
      ["a/small", "a/mid", "a/big"],
      [
        { use: "a/mid", agents: ["claude"] },
        { use: "a/big", tokens: 8_000 },
      ],
    ).contextWindow,
    100_000,
  );
  // A member whose window is not known, in a rule before it, leaves the group's as it was.
  assert.equal(
    of(
      ["a/small", "a/blind", "a/big"],
      [
        { use: "a/blind", agents: ["claude"] },
        { use: "a/big", tokens: 8_000 },
      ],
    ).contextWindow,
    undefined,
  );
});
