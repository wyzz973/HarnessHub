// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import {
  isGatewayKeyRecord,
  isRouteGroup,
} from "../src/model-plane-records.js";
import type {
  ModelRef,
  ProviderModel,
  RouteGroup,
  RouteGroupId,
} from "../src/model-plane.js";
import {
  GROUP_NEST_LIMIT,
  groupCapabilities,
  groupModels,
  memberText,
  nestingProblems,
  parseGroupMember,
} from "../src/route-groups.js";

const STAMP = "2026-10-04T00:00:00.000Z";

function group(id: string, members: string[]): RouteGroup {
  return {
    id: id as RouteGroupId,
    strategy: "order",
    stickiness: "auto",
    members,
    createdAt: STAMP,
    updatedAt: STAMP,
  };
}

function lookup(...groups: RouteGroup[]) {
  const byId = new Map(groups.map((item) => [item.id, item]));
  return (id: RouteGroupId) => byId.get(id);
}

void test("a member's effort and :fast are split off, a model's own colon is kept", () => {
  assert.deepEqual(parseGroupMember("openai/gpt-5:high:fast"), {
    kind: "model",
    ref: "openai/gpt-5",
    provider: "openai",
    model: "gpt-5",
    effort: "high",
    fast: true,
  });
  assert.deepEqual(parseGroupMember("openai/gpt-5:FAST"), {
    kind: "model",
    ref: "openai/gpt-5",
    provider: "openai",
    model: "gpt-5",
    fast: true,
  });
  // Not a level: OpenRouter's free variant, Ollama's size.
  for (const text of ["or/deepseek-r1:free", "ollama/qwen:7b"])
    assert.deepEqual(parseGroupMember(text), {
      kind: "model",
      ref: text,
      provider: text.split("/")[0],
      model: text.split("/")[1],
      fast: false,
    });
  // A model the provider lists with a level in its id stays whole.
  const listed = (_: string, model: string) => model === "think:high";
  assert.equal(
    parseGroupMember("p/think:high", listed)?.kind === "model" &&
      (parseGroupMember("p/think:high", listed) as { model: string }).model,
    "think:high",
  );
  assert.deepEqual(parseGroupMember("group/fast"), {
    kind: "group",
    group: "fast",
  });
  // A group takes no suffix of its own.
  assert.equal(parseGroupMember("group/fast:high"), undefined);
  assert.equal(parseGroupMember("no-slash"), undefined);
  assert.equal(memberText(parseGroupMember("p/m:HIGH:Fast")!), "p/m:high:fast");
});

void test("records take model members with suffixes and group members", () => {
  assert.ok(isRouteGroup(group("g", ["p/m:low", "p/m:high:fast", "group/x"])));
  assert.ok(!isRouteGroup(group("g", ["group/x:high"])));
  assert.ok(!isRouteGroup(group("g", ["p/m", "p/m"])));
});

void test("groupModels walks nested groups in order, keeps the first of a model at an effort, and cuts loops and depth", () => {
  const inner = group("inner", ["b/two", "a/one", "c/three:low"]);
  const loop = group("loop", ["group/outer", "d/four"]);
  const outer = group("outer", [
    "a/one",
    "group/inner",
    "a/one:high",
    "group/missing",
    "group/loop",
  ]);
  const models = groupModels(outer, lookup(inner, loop, outer));
  assert.deepEqual(
    models.map((item) => [item.member, item.via, item.ref, item.effort ?? ""]),
    [
      ["a/one", [], "a/one", ""],
      ["group/inner", ["inner"], "b/two", ""],
      ["group/inner", ["inner"], "c/three", "low"],
      ["a/one:high", [], "a/one", "high"],
      ["group/loop", ["loop"], "d/four", ""],
    ],
  );
  // A chain deeper than the limit is cut there.
  const chain = Array.from({ length: GROUP_NEST_LIMIT + 2 }, (_, index) =>
    group(
      `g${index}`,
      index === GROUP_NEST_LIMIT + 1
        ? ["z/deep"]
        : [`group/g${index + 1}`, `m/at-${index}`],
    ),
  );
  const found = groupModels(chain[0]!, lookup(...chain)).map(
    (item) => item.ref,
  );
  assert.ok(found.includes(`m/at-${GROUP_NEST_LIMIT}` as ModelRef));
  assert.ok(!found.includes("z/deep" as ModelRef));
});

void test("nesting problems: a missing group, a loop however deep, and more than 8 levels", () => {
  const a = group("a", ["group/b"]);
  const b = group("b", ["group/c", "p/m"]);
  const c = group("c", ["p/n"]);
  assert.deepEqual(nestingProblems(a, lookup(a, b, c)), []);
  // c would contain a, which contains c through b.
  const looped = group("c", ["group/a"]);
  assert.deepEqual(nestingProblems(looped, lookup(a, b, c)), [
    {
      index: 0,
      detail:
        "group/a contains group/c (c ⊃ a ⊃ b ⊃ c), so group/c would contain itself",
    },
  ]);
  assert.deepEqual(nestingProblems(group("x", ["group/x"]), lookup()), [
    { index: 0, detail: "a group cannot contain itself" },
  ]);
  assert.deepEqual(
    nestingProblems(group("x", ["p/m", "group/nope"]), lookup()),
    [{ index: 1, detail: "there is no group nope" }],
  );
  // l1 ⊃ l2 ⊃ … ⊃ l8: putting l1 in a new group makes it 8 deep, l0 in it 9.
  const levels = Array.from({ length: 9 }, (_, index) =>
    group(`l${index}`, index === 8 ? ["p/m"] : [`group/l${index + 1}`]),
  );
  assert.deepEqual(
    nestingProblems(group("top", ["group/l1"]), lookup(...levels)),
    [],
  );
  assert.deepEqual(
    nestingProblems(group("top", ["group/l0"]), lookup(...levels)),
    [
      {
        index: 0,
        detail: "groups would sit 9 deep inside group/top; at most 8 may",
      },
    ],
  );
});

void test("capabilities: the smallest window and output, shared modalities, the levels unfixed models share", () => {
  const metadata = new Map<string, ProviderModel>([
    [
      "a/big",
      {
        id: "big",
        contextWindow: 1_000_000,
        maxOutputTokens: 64_000,
        reasoning: true,
        inputModalities: ["text", "image"],
      },
    ],
    [
      "b/small",
      {
        id: "small",
        contextWindow: 200_000,
        maxOutputTokens: 8_192,
        reasoning: true,
        inputModalities: ["text", "image"],
      },
    ],
    [
      "c/plain",
      {
        id: "plain",
        contextWindow: 128_000,
        reasoning: false,
        inputModalities: ["text"],
      },
    ],
  ]);
  const read = (ref: ModelRef) => metadata.get(ref);
  const of = (members: string[], ...nested: RouteGroup[]) =>
    groupCapabilities(
      groupModels(group("g", members), lookup(...nested)),
      read,
    );
  assert.deepEqual(of(["a/big", "group/inner"], group("inner", ["b/small"])), {
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    reasoning: true,
    efforts: ["low", "medium", "high"],
    inputModalities: ["text", "image"],
  });
  // A model without reasoning narrows the levels to none.
  assert.deepEqual(of(["a/big", "c/plain"]), {
    contextWindow: 128_000,
    reasoning: false,
    efforts: [],
    inputModalities: ["text"],
  });
  // A model fixed at an effort takes any level, so it does not narrow them.
  assert.deepEqual(of(["a/big", "c/plain:high"]).efforts, [
    "low",
    "medium",
    "high",
  ]);
  // Every model fixed: the levels they are fixed at, lowest first.
  const fixed = of(["a/big:max", "b/small:minimal", "c/plain:max"]);
  assert.deepEqual(fixed.efforts, ["minimal", "max"]);
  assert.equal(fixed.reasoning, true);
  // An unknown model's window is unknown, so the group's is too.
  assert.equal(of(["a/big", "z/unknown"]).contextWindow, undefined);
});

void test("key quotas take budgets: one per period, caps of 0 or more, no fields of before", () => {
  const key = (quota: unknown) => ({
    keyId: "abcdefghijkl",
    name: "k",
    scope: { kind: "client", name: "k" },
    modelAllow: ["*"],
    quota,
    secretHash: "0".repeat(64),
    createdAt: STAMP,
  });
  for (const quota of [
    {},
    { requestsPerMinute: 60 },
    {
      requestsPerMinute: 1,
      budgets: [
        { period: "day", tokens: 1000, cacheReads: true },
        { period: "week", costUsd: 2.5 },
        { period: "month", tokens: 5, costUsd: 0.01 },
      ],
    },
    // A cap of 0 blocks the key for the window.
    { budgets: [{ period: "day", tokens: 0 }] },
    { budgets: [{ period: "month", costUsd: 0 }] },
  ])
    assert.ok(isGatewayKeyRecord(key(quota)), JSON.stringify(quota));
  for (const quota of [
    { tokensPerDay: 1000 },
    { costPerMonthUsd: 2 },
    { budgets: [{ period: "year", tokens: 1 }] },
    { budgets: [{ period: "day" }] },
    { budgets: [{ period: "day", tokens: -1 }] },
    { budgets: [{ period: "day", tokens: 1.5 }] },
    { budgets: [{ period: "day", tokens: "5" }] },
    { budgets: [{ period: "day", costUsd: -0.01 }] },
    { budgets: [{ period: "day", costUsd: Number.POSITIVE_INFINITY }] },
    { budgets: [{ period: "day", cacheReads: true }] },
    { budgets: [{ period: "day", tokens: 1, extra: true }] },
    {
      budgets: [
        { period: "day", tokens: 1 },
        { period: "day", costUsd: 1 },
      ],
    },
    { requestsPerMinute: 0 },
  ])
    assert.ok(!isGatewayKeyRecord(key(quota)), JSON.stringify(quota));
});
