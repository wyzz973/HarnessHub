// SPDX-License-Identifier: MIT
/** Route group rules at request time: turns, compaction, stickiness, the classifier, nested groups, and a key's own limits. */
import test from "node:test";
import assert from "node:assert/strict";
import type {
  GroupRule,
  ModelCallEntry,
  ProviderConfig,
  RouteGroup,
} from "@harnesshub/core/model-plane";
import { ruleView } from "../src/rules.js";
import {
  addKey,
  group,
  MemoryStore,
  mount,
  provider,
  send,
  upstream,
  type Reply,
  type Seen,
} from "./shared-support.js";

/** Provider `p`: small (1,000 tokens), big, deep and seer (sees images). */
function models(): ProviderConfig["models"] {
  return {
    source: "manual",
    expose: "all",
    list: [
      { id: "small", contextWindow: 1_000, inputModalities: ["text"] },
      { id: "big", contextWindow: 100_000, inputModalities: ["text"] },
      { id: "deep", contextWindow: 100_000, inputModalities: ["text"] },
      {
        id: "seer",
        contextWindow: 100_000,
        inputModalities: ["text", "image"],
      },
    ],
  };
}

function completion(content: string): Reply {
  return (response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        id: "chatcmpl-up",
        object: "chat.completion",
        model: "served",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      }),
    );
  };
}

/**
 * The judge answers by the message it is shown: `judge(text)` gives the
 * answer, or a status for a failure; every other model answers "ok".
 */
async function rig(
  t: test.TestContext,
  groups: RouteGroup[],
  judge: (text: string) => string | number = () => "0",
) {
  const reply: Reply = (response, seen, request) => {
    const body = seen.json();
    if (body.model !== "judge")
      return completion("ok")(response, seen, request);
    const said = judge(JSON.stringify(body.messages));
    if (typeof said === "number") {
      response.writeHead(said, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "judge is down" } }));
      return;
    }
    return completion(said)(response, seen, request);
  };
  const up = await upstream(t, reply);
  const store = new MemoryStore();
  await store.putProvider(
    provider("p", { chat: `${up.base}/v1` }, { models: models() }),
  );
  // The classifier on a credential of its own: its failures rest only it.
  await store.putProvider(
    provider(
      "q",
      { chat: `${up.base}/v1` },
      {
        secrets: ["key-b"],
        models: {
          source: "manual",
          expose: "all",
          list: [{ id: "judge", contextWindow: 8_000 }],
        },
      },
    ),
  );
  for (const item of groups) await store.putRouteGroup(item);
  const key = await addKey(store, ["*"]);
  const gw = await mount(t, store, {}, { timeZone: "UTC" });
  const served = () =>
    up.seen
      .filter((seen) => seen.json().model !== "judge")
      .map((seen) => seen.json().model);
  const judged = () =>
    up.seen.filter((seen) => seen.json().model === "judge").length;
  const chat = async (
    messages: unknown[],
    extra: Record<string, unknown> = {},
    headers: Record<string, string> = {},
  ) => {
    const answer = await send(gw.port, "/v1/chat/completions", {
      headers: {
        authorization: `Bearer ${key.text}`,
        "x-hh-conversation": "c1",
        ...headers,
      },
      body: { model: "group/g", messages, ...extra },
    });
    assert.equal(answer.status, 200, answer.text);
    return answer;
  };
  /** The routed calls' entries, newest last, without the classifier's. */
  const routed = () =>
    store.entries.filter(
      (entry: ModelCallEntry) => entry.agent?.id !== "harnesshub-classify",
    );
  return { up, store, gw, key, chat, served, judged, routed };
}

const user = (content: unknown) => ({ role: "user", content });
const toolTurn = (ask: string) => [
  user(ask),
  {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: "call_1",
        type: "function",
        function: { name: "read", arguments: "{}" },
      },
    ],
  },
];
const result = (text: string) => ({
  role: "tool",
  tool_call_id: "call_1",
  content: text,
});
const lastPatches = (entries: ModelCallEntry[]) =>
  entries
    .at(-1)!
    .patches.filter(
      (patch) =>
        patch.startsWith("rule") ||
        patch.startsWith("classifier") ||
        patch.startsWith("sticky") ||
        patch.startsWith("effort"),
    );

void test("what the rules see: length without media, images in any turn, reasoning asked, turns and tool results", () => {
  const view = ruleView("chat", {
    messages: [
      { role: "system", content: "x".repeat(400) },
      user([
        { type: "text", text: "look" },
        {
          type: "image_url",
          image_url: { url: `data:image/png;base64,${"A".repeat(40_000)}` },
        },
      ]),
      ...toolTurn("go on").slice(1),
      result("done"),
    ],
    reasoning_effort: "high",
  });
  assert.equal(view.images, true);
  assert.ok(view.tokens > 100 && view.tokens < 200, String(view.tokens));
  assert.deepEqual(
    [view.thinking, view.effort, view.turn, view.within],
    [true, "high", 1, true],
  );
  const anthropic = ruleView("anthropic", {
    thinking: { type: "enabled", budget_tokens: 2048 },
    messages: [
      {
        role: "user",
        content: "first <system-reminder>hidden</system-reminder>",
      },
      { role: "assistant", content: "a" },
      { role: "user", content: [{ type: "text", text: "second" }] },
    ],
  });
  assert.deepEqual(
    [
      anthropic.thinking,
      anthropic.effort,
      anthropic.turn,
      anthropic.within,
      anthropic.text,
    ],
    [true, undefined, 2, false, "second"],
  );
  assert.equal(
    ruleView("responses", { input: "hi", reasoning: { effort: "none" } })
      .thinking,
    false,
  );
});

void test("each rule field puts its member first when it holds and not when it does not", async (t) => {
  const rules: GroupRule[] = [
    { use: "p/big", tokens: 300 },
    { use: "p/seer", images: true },
    { use: "p/deep", effort: "high" },
    { use: "p/big", agents: ["claude"] },
    { use: "p/seer", time: { from: "11:00", to: "13:00" } },
  ];
  const { chat, served, gw, routed } = await rig(t, [
    group("g", ["p/small", "p/big", "p/seer", "p/deep"], { rules }),
  ]);
  let conversation = 0;
  const ask = async (
    messages: unknown[],
    extra: Record<string, unknown> = {},
    headers: Record<string, string> = {},
  ) => {
    await chat(messages, extra, {
      "x-hh-conversation": `c${++conversation}`,
      ...headers,
    });
    return served().at(-1);
  };
  // 12:00 UTC is within rule 5's hours; 14:00 is not.
  gw.clock.now = Date.parse("2026-10-02T14:00:00.000Z");
  assert.equal(await ask([user("hi")]), "small", "no rule holds");
  assert.deepEqual(lastPatches(routed()), ["rule:none"]);
  assert.equal(await ask([user("x".repeat(1_400))]), "big", "tokens");
  assert.deepEqual(lastPatches(routed()), ["rule:1"]);
  assert.equal(await ask([user("x".repeat(800))]), "small", "too short");
  assert.equal(
    await ask([
      user([
        { type: "text", text: "what is this" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      ]),
    ]),
    "seer",
    "images",
  );
  assert.equal(
    await ask([user("think")], { reasoning_effort: "xhigh" }),
    "deep",
    "effort at least high",
  );
  assert.equal(
    await ask([user("think")], { reasoning_effort: "medium" }),
    "small",
    "effort below high",
  );
  assert.equal(
    await ask([user("hi")], {}, { "user-agent": "claude-cli/2.1.0" }),
    "big",
    "agent",
  );
  assert.equal(
    await ask([user("hi")], {}, { "user-agent": "codex_cli_rs/0.40" }),
    "small",
    "another agent",
  );
  gw.clock.now = Date.parse("2026-10-02T12:00:00.000Z");
  assert.equal(await ask([user("hi")]), "seer", "time");
  assert.deepEqual(lastPatches(routed()), ["rule:5"]);
});

void test("a turn keeps its rule; it moves only when it outgrows its model and a rule sends it to a larger one", async (t) => {
  const { chat, served, routed } = await rig(t, [
    group("g", ["p/big", "p/small"], {
      rules: [
        { use: "p/big", tokens: 950 },
        { use: "p/small", agents: ["codex"] },
      ],
    }),
  ]);
  const codex = { "user-agent": "codex_cli_rs/0.40" };
  await chat([user("fix it")], {}, codex);
  assert.equal(served().at(-1), "small");
  assert.deepEqual(lastPatches(routed()), ["rule:2"]);
  // Tool results within the turn stay with the turn's model…
  await chat([...toolTurn("fix it"), result("a".repeat(2_000))], {}, codex);
  assert.equal(served().at(-1), "small");
  assert.deepEqual(lastPatches(routed()), ["rule:held:2"]);
  // …until the conversation is 95% of its window: 3,900 characters are
  // 975 tokens of small's 1,000, and rule 1 sends it to big.
  await chat([...toolTurn("fix it"), result("a".repeat(3_900))], {}, codex);
  assert.equal(served().at(-1), "big");
  assert.deepEqual(lastPatches(routed()), ["rule:grown:1"]);
  // A turn the gateway never saw begin is not moved by a rule.
  await chat(
    [...toolTurn("other"), result("b")],
    {},
    {
      ...codex,
      "x-hh-conversation": "unseen",
    },
  );
  assert.deepEqual(lastPatches(routed()), ["rule:waits"]);
  assert.equal(served().at(-1), "big", "the group's order");
});

void test("a compaction goes by the compact rules, passes over models too small for it, and leaves stickiness where it was", async (t) => {
  const summarize = (size: number) => [
    user("x".repeat(size)),
    user(
      "Your task is to create a detailed summary of the conversation so far",
    ),
  ];
  const { chat, served, routed } = await rig(t, [
    group("g", ["p/seer", "p/small", "p/big"], {
      stickiness: "session",
      rules: [
        { use: "p/small", compact: true },
        { use: "p/big", compact: true },
      ],
    }),
  ]);
  await chat([user("hello")]);
  assert.equal(served().at(-1), "seer");
  await chat(summarize(10));
  assert.equal(served().at(-1), "small");
  assert.deepEqual(lastPatches(routed()), [
    "sticky:broken:rule",
    "rule:compact:1",
  ]);
  // Longer than small's window: small is passed over.
  await chat(summarize(8_000));
  assert.equal(served().at(-1), "big");
  assert.deepEqual(lastPatches(routed()), [
    "sticky:broken:rule",
    "rule:compact:2",
  ]);
  // The conversation stays where it was before the compactions.
  await chat([
    user("hello"),
    { role: "assistant", content: "ok" },
    user("more"),
  ]);
  assert.equal(served().at(-1), "seer");
  assert.deepEqual(lastPatches(routed()), ["sticky:hit", "rule:none"]);
});

void test("a rule that picks another member as a turn begins takes the conversation off its sticky credential", async (t) => {
  const { chat, served, routed } = await rig(t, [
    group("g", ["p/small", "p/seer"], {
      stickiness: "session",
      rules: [{ use: "p/seer", images: true }],
    }),
  ]);
  await chat([user("hi")]);
  assert.equal(served().at(-1), "small");
  await chat([
    user("hi"),
    { role: "assistant", content: "ok" },
    user([
      { type: "text", text: "and this?" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    ]),
  ]);
  assert.equal(served().at(-1), "seer");
  assert.deepEqual(lastPatches(routed()), ["sticky:broken:rule", "rule:1"]);
});

void test("the classifier is asked once a turn, its answer kept 10 minutes, and left alone 30 seconds after it fails", async (t) => {
  const { chat, served, judged, routed, gw, store } = await rig(
    t,
    [
      group("g", ["p/small", "p/big", "p/seer"], {
        classifier: "q/judge",
        rules: [
          { use: "p/big", intent: "a quick question" },
          { use: "p/seer", intent: "a hard problem" },
        ],
      }),
    ],
    (text) =>
      text.includes("QUICK")
        ? "1"
        : text.includes("HARD")
          ? "2"
          : text.includes("BROKEN")
            ? // A refusal: it opens no breaker, so only the classifier's rest holds.
              400
            : text.includes("RAMBLE")
              ? "I cannot say"
              : "0",
  );
  let conversation = 0;
  const ask = async (text: string) => {
    await chat([user(text)], {}, { "x-hh-conversation": `k${++conversation}` });
    return served().at(-1);
  };
  assert.equal(await ask("QUICK what is 2+2"), "big");
  assert.equal(judged(), 1);
  assert.deepEqual(lastPatches(routed()), ["rule:1", "classifier:asked"]);
  // Its call is in the ledger as the gateway's own, with its usage.
  const own = store.entries.filter(
    (entry) => entry.agent?.id === "harnesshub-classify",
  );
  assert.equal(own.length, 1);
  assert.equal(own[0]!.modelRef, "q/judge");
  assert.equal(own[0]!.usage?.output, 2);
  // The same message: the kept answer.
  assert.equal(await ask("QUICK what is 2+2"), "big");
  assert.equal(judged(), 1);
  assert.deepEqual(lastPatches(routed()), ["rule:1", "classifier:cached"]);
  // Within a turn the classifier is not asked.
  await chat(
    [...toolTurn("HARD one"), result("x")],
    {},
    {
      "x-hh-conversation": `k${conversation}`,
    },
  );
  assert.equal(judged(), 1);
  // Ten minutes on, it is asked again.
  gw.clock.now += 10 * 60_000 + 1;
  assert.equal(await ask("QUICK what is 2+2"), "big");
  assert.equal(judged(), 2);
  // A failure: no intent matches, the group's order serves, and the
  // classifier is left alone for 30 seconds.
  assert.equal(await ask("BROKEN"), "small");
  assert.deepEqual(lastPatches(routed()), ["rule:none", "classifier:failed"]);
  const failedCalls = judged();
  assert.equal(await ask("HARD design"), "small");
  assert.deepEqual(lastPatches(routed()), ["rule:none", "classifier:resting"]);
  assert.equal(judged(), failedCalls, "resting: not asked");
  gw.clock.now += 30_001;
  assert.equal(await ask("HARD design"), "seer");
  assert.equal(judged(), failedCalls + 1);
  // An answer that is not a number is no failure: the next turn asks again.
  assert.equal(await ask("RAMBLE on"), "small");
  assert.deepEqual(lastPatches(routed()), ["rule:none", "classifier:failed"]);
  assert.equal(await ask("HARD again"), "seer");
  assert.equal(judged(), failedCalls + 3);
});

void test("effort auto: the classifier picks the turn's reasoning, which its requests ask for", async (t) => {
  const { chat, up, judged, routed } = await rig(
    t,
    [
      group("g", ["p/small"], {
        classifier: "q/judge",
        effort: "auto",
      }),
    ],
    (text) => (text.includes("Levels:") ? "3" : "0"),
  );
  const last = () =>
    up.seen
      .filter((seen: Seen) => seen.json().model !== "judge")
      .at(-1)!
      .json();
  await chat([user("plan the migration")], { reasoning_effort: "low" });
  assert.equal(judged(), 1);
  assert.equal(last().reasoning_effort, "high");
  assert.deepEqual(lastPatches(routed()), [
    "classifier:asked",
    "effort:auto:high",
  ]);
  // The turn keeps it.
  await chat([...toolTurn("plan the migration"), result("x")], {
    reasoning_effort: "low",
  });
  assert.equal(last().reasoning_effort, "high");
  assert.equal(judged(), 1);
  // An agent that asked for no reasoning is left as it is.
  await chat([user("hi")], {}, { "x-hh-conversation": "plain" });
  assert.equal(judged(), 1);
  assert.equal(last().reasoning_effort, undefined);
});

void test("the rules of a group inside the group decide among its own members", async (t) => {
  const { chat, served, routed } = await rig(t, [
    group("g", ["group/inner", "p/big"]),
    group("inner", ["p/small", "p/seer"], {
      rules: [{ use: "p/seer", images: true }],
    }),
  ]);
  await chat([user("hi")]);
  assert.equal(served().at(-1), "small");
  assert.deepEqual(lastPatches(routed()), ["rule@inner:none"]);
  await chat(
    [
      user([
        { type: "text", text: "see" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      ]),
    ],
    {},
    { "x-hh-conversation": "c2" },
  );
  assert.equal(served().at(-1), "seer");
  assert.deepEqual(lastPatches(routed()), ["rule@inner:1"]);
});

void test("a key sees its own limits and use at /v1/harnesshub/limit, and no other key's", async (t) => {
  const store = new MemoryStore();
  const limited = await addKey(store, ["*"], {
    quota: {
      requestsPerMinute: 30,
      budgets: [{ period: "day", tokens: 1_000 }],
    },
  });
  const plain = await addKey(store, ["*"]);
  const gw = await mount(t, store, {}, { timeZone: "UTC" });
  const read = (text?: string, path = "/v1/harnesshub/limit") =>
    send(gw.port, path, {
      headers: text ? { authorization: `Bearer ${text}` } : {},
    });
  const own = await read(limited.text);
  assert.equal(own.status, 200, own.text);
  const body = own.json();
  assert.equal(body.object, "gateway_key.limit");
  assert.equal(body.limited, true);
  assert.equal(body.keyId, limited.keyId);
  assert.equal(body.requestsPerMinute, 30);
  assert.equal(body.timeZone, "UTC");
  assert.deepEqual(
    (body.budgets as { period: string; tokenLimit: number }[]).map((budget) => [
      budget.period,
      budget.tokenLimit,
    ]),
    [["day", 1_000]],
  );
  const other = await read(plain.text);
  assert.deepEqual(
    [other.json().limited, other.json().keyId, other.json().budgets],
    [false, plain.keyId, []],
  );
  assert.ok(!other.text.includes(limited.keyId));
  assert.equal((await read()).status, 401);
  assert.equal((await read(limited.text, "/harnesshub/limit")).status, 404);
  assert.equal(
    (
      await send(gw.port, "/v1/harnesshub/limit", {
        method: "POST",
        headers: { authorization: `Bearer ${limited.text}` },
        body: {},
      })
    ).status,
    404,
  );
});

void test("/v1/models lists a group with what its rules make reachable", async (t) => {
  const { gw, key } = await rig(t, [
    group("g", ["p/small", "p/seer"], {
      rules: [
        { use: "p/seer", images: true },
        { use: "p/seer", tokens: 900 },
      ],
    }),
  ]);
  const listed = await send(gw.port, "/v1/models/group/g", {
    headers: { authorization: `Bearer ${key.text}` },
  });
  assert.equal(listed.status, 200, listed.text);
  assert.deepEqual(
    [listed.json().context_window, listed.json().input_modalities],
    [100_000, ["text", "image"]],
  );
});

void test("route decisions: one per new turn of a group, finished when its call ends, read after a seq and waited for", async (t) => {
  const { chat, gw } = await rig(
    t,
    [
      group("g", ["p/small", "p/big", "p/seer"], {
        stickiness: "session",
        classifier: "q/judge",
        rules: [
          { use: "p/seer", images: true },
          { use: "p/big", intent: "a quick question" },
        ],
      }),
    ],
    (text) => (text.includes("QUICK") ? "1" : "0"),
  );
  const read = (query: Parameters<typeof gw.handler.routeDecisions>[0]) =>
    gw.handler.routeDecisions(query, new AbortController().signal);
  assert.deepEqual(await read({}), { seq: 0, items: [] });
  // A read that waits is answered by the next decision.
  const waiting = read({ wait: 5 });
  await chat([user("QUICK what is 2 + 2")]);
  const first = await waiting;
  assert.equal(first.items.length, 1);
  const [made] = first.items;
  assert.equal(made!.requested, "group/g");
  assert.equal(made!.turn, 1);
  assert.deepEqual(made!.rules, [
    {
      group: "g",
      kind: "turn",
      n: 2,
      use: "p/big",
      when: ['intent "a quick question"'],
      then: [],
      classifier: {
        by: "q/judge",
        intents: ["a quick question"],
        intent: "a quick question",
        cached: false,
        resting: false,
      },
    },
  ]);
  assert.equal(made!.sticky, "miss:new");
  assert.deepEqual(
    made!.candidates.map((candidate) => candidate.model),
    ["p/big", "p/small", "p/seer"],
  );
  // The call has ended by now: the decision is done, with what answered.
  const all = await read({});
  const done = all.items.find((item) => item.callId === made!.callId)!;
  assert.equal(done.done, true);
  assert.equal(done.status, 200);
  assert.equal(done.served?.model, "p/big");
  assert.ok(done.seq > made!.seq);
  // Tool results within the turn are no new decision.
  const before = all.seq;
  await chat([...toolTurn("QUICK what is 2 + 2"), result("4")]);
  assert.deepEqual((await read({ after: before })).items, []);
  // A rule that moves the conversation off its credential says so.
  await chat([
    user("QUICK what is 2 + 2"),
    { role: "assistant", content: "4" },
    user([
      { type: "text", text: "and this?" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    ]),
  ]);
  const moved = (await read({ after: before })).items.at(-1)!;
  assert.deepEqual(
    [moved.rules[0]!.n, moved.sticky, moved.candidates[0]!.model],
    [1, "broken:rule", "p/seer"],
  );
  // The classifier's own call is no decision of a group.
  assert.ok(
    (await read({})).items.every((item) => item.requested === "group/g"),
  );
  // One conversation's decisions; an after past the latest reads from the start.
  const other = await chat([user("hi")], {}, { "x-hh-conversation": "other" });
  assert.equal(other.status, 200);
  const latest = await read({});
  const conversation = latest.items.at(-1)!.conversation;
  assert.deepEqual(
    (await read({ session: conversation })).items.map(
      (item) => item.conversation,
    ),
    [conversation],
  );
  assert.equal(
    (await read({ after: latest.seq + 100 })).items.length,
    latest.items.length,
  );
  // A wait ends when the handler closes.
  const parked = read({ after: latest.seq, wait: 30 });
  await gw.handler.close();
  assert.deepEqual((await parked).items, []);
});
