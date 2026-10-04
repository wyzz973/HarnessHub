// SPDX-License-Identifier: MIT
// The console's routing helpers (packages/console/lib/routing.ts): members,
// typed rules and the words they mark, key quotas and budgets, and route
// decisions. The module runs on the SDK's build, as the browser runs it.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { consoleModule } from "./console-module.mjs";

// The assertions below read Chinese texts, the catalogs' source language.
const i18n = await consoleModule("lib/i18n.ts");
i18n.setLocale("zh-CN");

async function routingModule() {
  return consoleModule("lib/routing.ts");
}

/** Run `check` with the console in English, then back in Chinese. */
async function inEnglish(check) {
  i18n.setLocale("en");
  try {
    await check();
  } finally {
    i18n.setLocale("zh-CN");
  }
}

const providers = [
  {
    id: "p",
    models: { list: [{ id: "small" }, { id: "r1:free" }, { id: "big" }] },
  },
];

test("group members are read and written as the daemon stores them", async () => {
  const lib = await routingModule();
  assert.deepEqual(lib.memberRow("p/big:HIGH:fast", providers), {
    kind: "model",
    ref: "p/big",
    effort: "high",
    fast: true,
  });
  // A colon of a model the provider lists stays in the model.
  assert.deepEqual(lib.memberRow("p/r1:free", providers), {
    kind: "model",
    ref: "p/r1:free",
    fast: false,
  });
  assert.deepEqual(lib.memberRow("group/inner", providers), {
    kind: "group",
    ref: "group/inner",
    fast: false,
  });
  assert.equal(
    lib.memberRowText({ kind: "model", ref: "p/big", effort: "max", fast: true }),
    "p/big:max:fast",
  );
  assert.equal(
    lib.memberRowText({ kind: "model", ref: "p/small", fast: false }),
    "p/small",
  );
  assert.equal(
    lib.memberRowText({ kind: "group", ref: "group/inner", fast: false }),
    "group/inner",
  );
  assert.deepEqual(lib.moved(["a", "b", "c"], 2, 0), ["c", "a", "b"]);
  assert.deepEqual(lib.moved(["a", "b"], 0, 5), ["a", "b"], "out of range");
});

test("a typed rule reads as the daemon reads it, and an error marks the word at fault", async () => {
  const lib = await routingModule();
  const members = ["p/small", "p/big:high"];
  const read = (text, hasClassifier = false) =>
    lib.readTypedRule(text, members, "g", hasClassifier);
  const ok = read(
    'use=BIG tokens=200k intent="a  quick question" classifier=q/judge at=1',
  );
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.rule, {
    use: "p/big:high",
    tokens: 200_000,
    intent: "a quick question",
  });
  assert.deepEqual([ok.at, ok.classifier], [1, "q/judge"]);
  assert.equal(ok.line, 'use=p/big:high tokens=200000 intent="a quick question"');
  const marked = (result, text) =>
    result.spans.map((span) => text.slice(span.start, span.end));
  for (const [text, word, message] of [
    ["use=small colour=red", "colour=red", /unknown "colour=red"/],
    ["use=small tokens=lots images", "tokens=lots", /tokens "lots" is not a length/],
    ["use=small effort=huge", "effort=huge", /effort is on or one of/],
    ["use=small days=mon,funday", "days=mon,funday", /"funday" is not a day/],
    ["use=nobody images", "use=nobody", /nobody is not in group\/g/],
    // Checked after it is read: the word of the field at fault.
    ["use=small time=09:00-09:00", "time=09:00-09:00", /the whole day, every day/],
    // An intent needs the group's classifier.
    ['use=small intent="a question"', 'intent="a question"', /分类器/],
  ]) {
    const result = read(text);
    assert.equal(result.ok, false, text);
    assert.match(result.message, message, text);
    assert.deepEqual(marked(result, text), [word], text);
  }
  // Nothing to mark when the word is missing.
  const missing = read("images");
  assert.equal(missing.ok, false);
  assert.match(missing.message, /use=<model> is missing/);
  assert.deepEqual(missing.spans, []);
  assert.equal(read('use=small intent="a question"', true).ok, true);
  assert.deepEqual(
    lib.markedParts("use=a colour=red x", [{ start: 6, end: 16 }]),
    [
      { text: "use=a ", marked: false },
      { text: "colour=red", marked: true },
      { text: " x", marked: false },
    ],
  );
  assert.deepEqual(
    [...lib.ruleFailures({ "/rules/2/tokens": "too small", "/rules/2": "no", "/members/0": "x" })],
    [[2, ["tokens too small", "no"]]],
  );
});

test("the quota form gives a quota, 0 included, and names the fields it refuses", async () => {
  const lib = await routingModule();
  const form = lib.quotaFormOf({
    requestsPerMinute: 30,
    budgets: [
      { period: "day", tokens: 0, cacheReads: true },
      { period: "month", costUsd: 20 },
    ],
  });
  assert.deepEqual(lib.quotaOf(form), {
    ok: true,
    quota: {
      requestsPerMinute: 30,
      budgets: [
        { period: "day", tokens: 0, cacheReads: true },
        { period: "month", costUsd: 20 },
      ],
    },
  });
  assert.deepEqual(lib.quotaOf(lib.quotaFormOf(undefined)), {
    ok: true,
    quota: undefined,
  });
  const broken = lib.quotaFormOf(undefined);
  broken.rpm = "0";
  broken.budgets.day = { on: true, tokens: "1.5", cost: "-1", cacheReads: false };
  broken.budgets.week = { on: true, tokens: "", cost: "", cacheReads: false };
  assert.deepEqual(lib.quotaOf(broken), {
    ok: false,
    problems: {
      rpm: "每分钟请求数是大于 0 的整数",
      "day.tokens": "token 上限是 0 或更大的整数",
      "day.cost": "成本上限是 0 或更大的美元数",
      week: "至少填写 token 或成本中的一个上限",
    },
  });
  assert.deepEqual(
    lib.quotaSummary({
      requestsPerMinute: 60,
      budgets: [
        { period: "day", tokens: 2_000_000, cacheReads: true },
        { period: "week", tokens: 0 },
        { period: "month", costUsd: 20 },
      ],
    }),
    [
      "60 次/分钟",
      "每天 2 百万 token（含缓存读取）",
      "每周 0 token（拒绝所有调用）",
      // A USD amount in the locale's currency format.
      `每月 ${i18n.formatUsd(20, "zh-CN")}`,
    ],
  );
  await inEnglish(() => {
    assert.deepEqual(
      lib.quotaSummary({
        requestsPerMinute: 1,
        budgets: [
          { period: "day", tokens: 2_000_000, cacheReads: true },
          { period: "week", tokens: 1500 },
          { period: "month", tokens: 0, costUsd: 0 },
        ],
      }),
      [
        "1 request per minute",
        "Daily: 2 million tokens (cache reads included)",
        "Weekly: 1,500 tokens",
        "Monthly: 0 tokens (refuses every call), $0.00 (refuses every call)",
      ],
    );
    assert.deepEqual(lib.quotaOf({ ...lib.quotaFormOf(undefined), rpm: "0" }), {
      ok: false,
      problems: { rpm: "Requests per minute must be a whole number greater than 0" },
    });
  });
  const status = {
    period: "day",
    tokens: 600,
    reservedTokens: 200,
    tokenLimit: 1000,
    costUsd: 1,
    reservedCostUsd: 0,
    costLimitUsd: 0,
  };
  assert.deepEqual(lib.budgetUse(status), {
    tokens: { used: 600, held: 200, limit: 1000, share: 0.8 },
    cost: { used: 1, held: 0, limit: 0, share: 1 },
  });
});

test("route decisions merge by call, newest first, and read as words", async () => {
  const lib = await routingModule();
  const decision = (callId, at, seq, extra = {}) => ({
    callId,
    at,
    seq,
    conversation: "c",
    requested: "group/g",
    rules: [],
    candidates: [],
    done: false,
    ...extra,
  });
  const first = lib.mergeDecisions([], {
    seq: 2,
    items: [
      decision("a", "2026-10-05T00:00:00.000Z", 1),
      decision("b", "2026-10-05T00:01:00.000Z", 2),
    ],
  });
  assert.deepEqual(first.map((item) => item.callId), ["b", "a"]);
  const later = lib.mergeDecisions(first, {
    seq: 3,
    items: [decision("a", "2026-10-05T00:00:00.000Z", 3, { done: true, status: 200 })],
  });
  assert.deepEqual(
    later.map((item) => [item.callId, item.done]),
    [["b", false], ["a", true]],
  );
  assert.equal(
    lib.ruleDecisionText({
      group: "g",
      kind: "turn",
      n: 2,
      use: "p/big",
      when: ["tokens ≥ 200000"],
      then: [],
      unready: true,
      instead: "p/small",
    }),
    "规则 2 → p/big（tokens ≥ 200000）；它没有就绪的凭据，改由 p/small 先试",
  );
  assert.equal(
    lib.ruleDecisionText({ group: "g", kind: "turn", n: 0, then: [] }),
    "没有规则命中，按组的策略排列",
  );
  assert.equal(
    lib.classifierText({
      by: "q/judge",
      intents: ["a quick question"],
      intent: "a quick question",
      cached: true,
      resting: false,
    }),
    "q/judge 判断：意图是 a quick question（10 分钟内问过同一消息，用的是那次的回答）",
  );
  assert.deepEqual(
    lib
      .decisionSessions(
        [{ key: "old", requested: "group/g", lastAt: "2026-10-04T00:00:00.000Z" }],
        later,
      )
      .map((item) => [item.key, item.lastAt]),
    [
      ["c", "2026-10-05T00:01:00.000Z"],
      ["old", "2026-10-04T00:00:00.000Z"],
    ],
  );
  assert.equal(lib.stickyText("broken:rule"), "粘性被打破：规则把它换到了别的成员");
  assert.equal(lib.stickyText("hit"), "留在上次应答的凭据");
  assert.equal(lib.stickyText(undefined), undefined);
  // A reason the console does not know shows as the daemon sends it.
  assert.equal(lib.stickyText("missed:something_new"), "没有沿用：something_new");
  await inEnglish(() => {
    assert.equal(
      lib.ruleDecisionText({
        group: "g",
        kind: "turn",
        n: 2,
        use: "p/big",
        when: ["tokens ≥ 200000", "images"],
        then: [],
        unready: true,
        instead: "p/small",
      }),
      "Rule 2 → p/big (tokens ≥ 200000, images); it has no ready credential, so p/small is tried first instead",
    );
    assert.equal(lib.ruleDecisionText({ group: "g", kind: "held", n: 0, then: [] }), "Kept the turn's decision");
    assert.equal(
      lib.classifierText({
        by: "q/judge",
        intents: ["a quick question"],
        intent: "a quick question",
        effort: "high",
        cached: false,
        resting: false,
      }),
      "q/judge decided: the intent is a quick question, it needs high reasoning",
    );
    assert.equal(lib.stickyText("broken:breaker"), "Stickiness broken: the last credential is resting");
    assert.equal(lib.budgetPeriodName("week"), "Weekly");
  });
});

/** The `node:` modules a built module imports, following its own and core's imports. */
async function nodeImports(start) {
  const seen = new Set();
  const found = new Set();
  const visit = async (url) => {
    if (seen.has(url.href)) return;
    seen.add(url.href);
    const source = await readFile(url, "utf8");
    for (const [, specifier] of source.matchAll(
      /(?:^|\n)\s*(?:import|export)\b[^"'`]*?\bfrom\s*["']([^"']+)["']/g,
    )) {
      if (specifier.startsWith("node:")) found.add(specifier);
      else if (specifier.startsWith("."))
        await visit(new URL(specifier, url));
      else if (specifier.startsWith("@harnesshub/core/"))
        await visit(
          new URL(
            `../packages/core/dist/src/${specifier.slice("@harnesshub/core/".length)}.js`,
            import.meta.url,
          ),
        );
    }
  };
  await visit(new URL(start, import.meta.url));
  return [...found];
}

test("the rule code the console bundles needs no Node module", async () => {
  assert.deepEqual(
    await nodeImports("../packages/sdk/dist/src/route-rules.js"),
    [],
  );
  // The check finds one: model-plane.js imports node:crypto.
  assert.deepEqual(
    await nodeImports("../packages/core/dist/src/model-plane.js"),
    ["node:crypto"],
  );
});
