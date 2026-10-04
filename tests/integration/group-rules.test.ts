// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { startHub } from "@harnesshub/daemon/main";
import { HarnessHubError, type HarnessHubClient } from "@harnesshub/sdk/client";
import { connectLocal } from "@harnesshub/sdk/local";
import { HH_ENTRY } from "../support/entries.js";
import {
  startFakeProvider,
  type FakeProvider,
} from "../support/fake-provider.js";
import { temporaryDirectory } from "../support/temporary.js";

// Synthetic values only: they never reach a real service.
const KEY = "sk-synthetic-group-rules-0001";

interface Hub {
  client: HarnessHubClient;
  url: string;
  dataDir: string;
  directory: string;
  fake: FakeProvider;
  v1: string;
}

/**
 * A daemon with provider `fake` (small, big, deep, seer) and provider
 * `judge` (the classifier, on a credential of its own), both on the strict
 * fake upstream, which answers the classifier by the message it is shown.
 */
async function hub(t: TestContext): Promise<Hub> {
  const { directory, defer } = await temporaryDirectory(t, "hh-rules-");
  const answer = (contains: string, text: string) => ({
    when: { contains: `<message>\n${contains}` },
    text,
    repeat: true,
  });
  const fake = await startFakeProvider({
    models: ["small", "big", "deep", "seer", "judge"],
    keys: { upstream: KEY },
    chunkDelayMs: 0,
    // An upstream that takes OpenAI's reasoning_effort, as the effort rule sends it on.
    fields: { chat: { allowed: { topLevel: ["reasoning_effort"] } } },
    script: {
      turns: [
        answer("QUICK", "1"),
        answer("HARD", "2"),
        {
          when: { contains: "<message>\nBROKEN" },
          status: 400,
          error: "the judge refused",
          repeat: true,
        },
      ],
    },
  });
  defer(() => fake.close());
  const dataDir = path.join(directory, "data");
  await mkdir(path.join(directory, "home"));
  const started = await startHub({
    dataDir,
    configDir: path.join(directory, "config"),
    secretsBackend: "file",
    demo: true,
    cwd: directory,
    port: 0,
    host: "127.0.0.1",
    catalog: { autoRefresh: false },
    wiringHome: {
      home: path.join(directory, "home"),
      env: { PATH: path.join(directory, "bin") },
    },
  });
  defer(() => started.server.close());
  const client = await connectLocal({ dataDir, url: started.url });
  const model = (id: string, contextWindow: number, image = false) => ({
    id,
    contextWindow,
    maxOutputTokens: 4_096,
    reasoning: true,
    inputModalities: image ? ["text", "image"] : ["text"],
  });
  await client.providers.create({
    id: "fake",
    name: "Fake",
    kind: "custom",
    endpoints: { chat: `${fake.url}/v1` },
    models: {
      source: "manual",
      list: [
        model("small", 1_000),
        model("big", 200_000),
        model("deep", 200_000),
        model("seer", 200_000, true),
      ],
      expose: "all",
    } as never,
    credential: { value: KEY },
  });
  await client.providers.create({
    id: "judge",
    name: "Judge",
    kind: "custom",
    endpoints: { chat: `${fake.url}/v1` },
    models: {
      source: "manual",
      list: [{ id: "judge" }],
      expose: "all",
    },
    credential: { value: KEY },
  });
  const info = await client.system.info();
  return {
    client,
    url: started.url,
    dataDir,
    directory,
    fake,
    v1: info.gateway!.openaiBaseUrl,
  };
}

/** Run the real `hh` launcher against the hub; stdin is piped, so it never asks. */
function hh(
  on: Hub,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(HH_ENTRY),
        ...args,
        "--data-dir",
        on.dataDir,
        "--url",
        on.url,
      ],
      { cwd: on.directory, stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout
      .setEncoding("utf8")
      .on("data", (chunk: string) => (stdout += chunk));
    child.stderr
      .setEncoding("utf8")
      .on("data", (chunk: string) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) =>
      resolve({ code: code ?? -1, stdout, stderr }),
    );
    child.stdin.end("");
  });
}

/** Minutes past local midnight, `delta` minutes from now, as HH:MM. */
function localClock(delta: number): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      hourCycle: "h23",
      hour: "2-digit",
      minute: "2-digit",
    })
      .formatToParts(Date.now())
      .map((part) => [part.type, part.value]),
  );
  const minutes =
    (((Number(parts.hour) * 60 + Number(parts.minute) + delta) % 1440) + 1440) %
    1440;
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

void test("each rule field, through the daemon, sends what it matches to its member and leaves the rest to the group's order", async (t) => {
  const on = await hub(t);
  const { client, fake } = on;
  const created = await client.gatewayKeys.create({
    name: "rules",
    modelAllow: [
      "tokens",
      "images",
      "effort",
      "agents",
      "compact",
      "now",
      "later",
    ].map((id) => `group/${id}`),
  });
  let conversation = 0;
  /** One new conversation's request to `group/<id>`; the model the upstream was asked for. */
  const ask = async (
    group: string,
    messages: unknown[],
    extra: Record<string, unknown> = {},
    headers: Record<string, string> = {},
  ) => {
    const response = await fetch(`${on.v1}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${created.key}`,
        "content-type": "application/json",
        "x-hh-conversation": `c${++conversation}`,
        ...headers,
      },
      body: JSON.stringify({ model: `group/${group}`, messages, ...extra }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    await response.text();
    return fake.records().at(-1)?.model;
  };
  const user = (content: unknown) => ({ role: "user", content });
  const make = (id: string, rules: unknown[], extra = {}) =>
    client.routeGroups.create({
      id,
      members: ["fake/small", "fake/big", "fake/deep", "fake/seer"],
      rules: rules as never,
      ...extra,
    });
  await make("tokens", [{ use: "fake/big", tokens: 300 }]);
  assert.equal(await ask("tokens", [user("x".repeat(1_600))]), "big");
  assert.equal(await ask("tokens", [user("short")]), "small");
  await make("images", [{ use: "fake/seer", images: true }]);
  const picture = user([
    { type: "text", text: "what is this" },
    {
      type: "image_url",
      image_url: { url: "data:image/png;base64,iVBORw0KGgo=" },
    },
  ]);
  assert.equal(await ask("images", [picture]), "seer");
  assert.equal(await ask("images", [user("words only")]), "small");
  await make("effort", [{ use: "fake/deep", effort: "high" }]);
  assert.equal(
    await ask("effort", [user("think")], { reasoning_effort: "high" }),
    "deep",
  );
  assert.equal(
    await ask("effort", [user("think")], { reasoning_effort: "low" }),
    "small",
  );
  await make("agents", [{ use: "fake/big", agents: ["claude"] }]);
  assert.equal(
    await ask("agents", [user("hi")], {}, { "user-agent": "claude-cli/2.1.0" }),
    "big",
  );
  assert.equal(
    await ask(
      "agents",
      [user("hi")],
      {},
      { "user-agent": "codex_cli_rs/0.40" },
    ),
    "small",
  );
  await make("compact", [{ use: "fake/deep", compact: true }]);
  assert.equal(
    await ask("compact", [
      user("long work"),
      { role: "assistant", content: "done" },
      user(
        "Your task is to create a detailed summary of the conversation so far",
      ),
    ]),
    "deep",
  );
  assert.equal(await ask("compact", [user("carry on")]), "small");
  // Hours around now hold; hours two hours on do not (the daemon's local time).
  await make("now", [
    { use: "fake/big", time: { from: localClock(-60), to: localClock(60) } },
  ]);
  await make("later", [
    { use: "fake/big", time: { from: localClock(120), to: localClock(180) } },
  ]);
  assert.equal(await ask("now", [user("hi")]), "big");
  assert.equal(await ask("later", [user("hi")]), "small");
  // The routed call says which rule put its member first.
  const calls = await client.modelCalls.list({ limit: 1 });
  assert.ok(
    calls.items[0]!.patches.includes("rule:none"),
    JSON.stringify(calls.items[0]!.patches),
  );
  assert.deepEqual(fake.violations(), []);
});

void test("the classifier through the daemon: asked once per message, its call in the ledger, rested after a failure", async (t) => {
  const on = await hub(t);
  const { client, fake } = on;
  await client.routeGroups.create({
    id: "smart",
    members: ["fake/small", "fake/big", "fake/seer"],
    classifier: "judge/judge",
    rules: [
      { use: "fake/big", intent: "a quick question" },
      { use: "fake/seer", intent: "a hard problem" },
    ],
  });
  const created = await client.gatewayKeys.create({
    name: "smart",
    modelAllow: ["group/smart"],
  });
  let conversation = 0;
  const ask = async (text: string) => {
    const response = await fetch(`${on.v1}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${created.key}`,
        "content-type": "application/json",
        "x-hh-conversation": `k${++conversation}`,
      },
      body: JSON.stringify({
        model: "group/smart",
        messages: [{ role: "user", content: text }],
      }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    await response.text();
    return fake.records().at(-1)?.model;
  };
  const judged = () =>
    fake.records().filter((record) => record.model === "judge").length;
  assert.equal(await ask("QUICK what is 2 + 2"), "big");
  assert.equal(await ask("HARD design a scheduler"), "seer");
  assert.equal(judged(), 2);
  // The same message again: the answer kept, the classifier not asked.
  assert.equal(await ask("QUICK what is 2 + 2"), "big");
  assert.equal(judged(), 2);
  // Its calls are the gateway's own in the ledger, with their cost visible.
  const own = await client.modelCalls.list({ agent: "harnesshub-classify" });
  assert.equal(own.items.length, 2);
  assert.ok(own.items.every((call) => call.modelRef === "judge/judge"));
  const routed = await client.modelCalls.list({ limit: 1 });
  assert.ok(routed.items[0]!.patches.includes("classifier:cached"));
  // A failure: no intent matches, the group's order serves; within 30
  // seconds the classifier is left alone.
  assert.equal(await ask("BROKEN now"), "small");
  const after = judged();
  assert.equal(await ask("HARD and new"), "small");
  assert.equal(judged(), after);
  const rested = await client.modelCalls.list({ limit: 1 });
  assert.ok(
    rested.items[0]!.patches.includes("classifier:resting"),
    JSON.stringify(rested.items[0]!.patches),
  );
  assert.deepEqual(fake.violations(), []);
});

void test("rules are checked on write and through hh group rule, which names the word at fault", async (t) => {
  const on = await hub(t);
  const { client } = on;
  await client.routeGroups.create({
    id: "g",
    members: ["fake/small", "fake/big:high"],
  });
  const invalid = (pointer: string, detail: RegExp) => (error: unknown) => {
    assert.ok(error instanceof HarnessHubError, String(error));
    assert.equal(error.code, "ROUTE_GROUP_INVALID");
    const found = (error.problem.errors ?? []).find(
      (item) => item.pointer === pointer,
    );
    assert.ok(found, JSON.stringify(error.problem.errors));
    assert.match(found.detail, detail);
    return true;
  };
  await assert.rejects(
    client.routeGroups.update("g", {
      rules: [{ use: "fake/deep", images: true }],
    }),
    invalid("/rules/0/use", /fake\/deep is not a member of the group/),
  );
  await assert.rejects(
    client.routeGroups.update("g", { rules: [{ use: "fake/small" }] }),
    invalid("/rules/0", /needs a condition/),
  );
  await assert.rejects(
    client.routeGroups.update("g", {
      rules: [{ use: "fake/small", intent: "a quick question" }],
    }),
    invalid("/rules/0/intent", /needs the group's classifier/),
  );
  await assert.rejects(
    client.routeGroups.update("g", { classifier: "nobody/judge" }),
    invalid("/classifier", /existing provider/),
  );
  await assert.rejects(
    client.routeGroups.update("g", { effort: "auto" }),
    invalid("/effort", /auto needs the group's classifier/),
  );
  // The typed form, member named as members are (case and suffixes).
  const added = await hh(on, [
    "group",
    "rule",
    "add",
    "g",
    "use=FAKE/BIG:HIGH tokens=200k time=9:00-17:00 days=mon-fri",
  ]);
  assert.equal(added.code, 0, added.stderr);
  const quick = await hh(on, [
    "group",
    "rule",
    "add",
    "g",
    "use=small",
    "intent=a quick question",
    "classifier=judge/judge",
    "at=1",
  ]);
  assert.equal(quick.code, 0, quick.stderr);
  assert.deepEqual((await client.routeGroups.get("g")).rules, [
    { use: "fake/small", intent: "a quick question" },
    {
      use: "fake/big:high",
      tokens: 200_000,
      time: {
        from: "09:00",
        to: "17:00",
        days: ["mon", "tue", "wed", "thu", "fri"],
      },
    },
  ]);
  assert.equal((await client.routeGroups.get("g")).classifier, "judge/judge");
  const listed = await hh(on, ["group", "rule", "list", "g"]);
  assert.match(listed.stdout, /classifier judge\/judge/);
  assert.match(listed.stdout, /tokens ≥ 200000, time 09:00–17:00 Mon–Fri/);
  for (const [words, message] of [
    [["use=small", "colour=red"], /unknown "colour=red"/],
    [["use=small", "tokens=lots"], /tokens "lots" is not a length/],
    [["use=small", "effort=huge"], /effort is on or one of/],
    [["use=small", "days=funday"], /"funday" is not a day of the week/],
    [["use=nobody", "images"], /nobody is not in group\/g/],
    [["images"], /use=<model> is missing/],
  ] as const) {
    const refused = await hh(on, ["group", "rule", "add", "g", ...words]);
    assert.equal(refused.code, 2, refused.stderr);
    assert.match(refused.stderr, message);
  }
  const moved = await hh(on, ["group", "rule", "move", "g", "2", "1"]);
  assert.equal(moved.code, 0, moved.stderr);
  assert.equal(
    (await client.routeGroups.get("g")).rules?.[0]?.use,
    "fake/big:high",
  );
  const effort = await hh(on, ["group", "rule", "effort", "g", "auto"]);
  assert.equal(effort.code, 0, effort.stderr);
  assert.equal((await client.routeGroups.get("g")).effort, "auto");
  // A member a rule sends to cannot leave the group, nor the classifier group be removed.
  await assert.rejects(
    client.routeGroups.update("g", { members: ["fake/small"] }),
    invalid("/rules/0/use", /not a member/),
  );
  await client.routeGroups.create({ id: "judges", members: ["judge/judge"] });
  await client.routeGroups.update("g", { classifier: "group/judges" });
  await assert.rejects(
    client.routeGroups.remove("judges"),
    (error: unknown) => {
      assert.ok(error instanceof HarnessHubError);
      assert.equal(error.code, "ROUTE_GROUP_IN_USE");
      return true;
    },
  );
  for (const verb of [
    ["remove", "g", "2"],
    ["remove", "g", "1"],
  ]) {
    const removed = await hh(on, ["group", "rule", ...verb]);
    assert.equal(removed.code, 0, removed.stderr);
  }
  const cleared = await hh(on, ["group", "rule", "effort", "g", "off"]);
  assert.equal(cleared.code, 0, cleared.stderr);
  const group = await client.routeGroups.get("g");
  assert.deepEqual([group.rules, group.effort], [undefined, undefined]);
});

void test("a Gateway Key reads its own limits and use at /v1/harnesshub/limit through the daemon", async (t) => {
  const on = await hub(t);
  const limited = await on.client.gatewayKeys.create({
    name: "limited",
    modelAllow: ["fake/*"],
    quota: { budgets: [{ period: "week", tokens: 50_000 }] },
  });
  const plain = await on.client.gatewayKeys.create({
    name: "plain",
    modelAllow: ["fake/*"],
  });
  const read = async (key: string) => {
    const response = await fetch(`${on.v1}/harnesshub/limit`, {
      headers: { authorization: `Bearer ${key}` },
    });
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    };
  };
  const own = await read(limited.key);
  assert.equal(own.status, 200);
  assert.equal(own.body.limited, true);
  assert.equal(own.body.keyId, limited.gatewayKey.keyId);
  assert.equal(own.body.name, "limited");
  const [week] = own.body.budgets as { period: string; tokenLimit: number }[];
  assert.deepEqual([week?.period, week?.tokenLimit], ["week", 50_000]);
  const other = await read(plain.key);
  assert.deepEqual(
    [other.body.limited, other.body.keyId],
    [false, plain.gatewayKey.keyId],
  );
  assert.ok(!JSON.stringify(other.body).includes(limited.gatewayKey.keyId));
  assert.equal((await read("hh_c_not_a_key")).status, 401);
});

void test("through the daemon, a group advertises what its rules reach, and each turn's decision can be followed", async (t) => {
  const on = await hub(t);
  const { client, fake } = on;
  await client.routeGroups.create({
    id: "reach",
    members: ["fake/small", "fake/seer"],
    rules: [
      { use: "fake/seer", images: true },
      { use: "fake/seer", tokens: 900 },
    ],
  });
  const created = await client.gatewayKeys.create({
    name: "reach",
    modelAllow: ["group/reach"],
  });
  const listed = await fetch(`${on.v1}/models/group/reach`, {
    headers: { authorization: `Bearer ${created.key}` },
  });
  const model = (await listed.json()) as Record<string, unknown>;
  assert.deepEqual(
    [model.context_window, model.input_modalities],
    [200_000, ["text", "image"]],
  );
  // Wiring offers the same: OpenCode is told the larger window.
  const plan = await client.agents.plan("opencode", {
    model: "group/reach",
    models: ["group/reach"],
  });
  const written = JSON.parse(
    plan.files[0]!.changes.find(
      (change) => change.keyPath.join("/") === "provider/harnesshub",
    )?.after ?? "{}",
  ) as { models?: Record<string, { limit?: { context?: number } }> };
  assert.equal(written.models?.["group/reach"]?.limit?.context, 200_000);

  // A long poll for the next decision is answered by the next turn.
  const start = await client.routing.decisions();
  const waiting = client.routing.decisions({ after: start.seq, wait: 20 });
  const answer = await fetch(`${on.v1}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${created.key}`,
      "content-type": "application/json",
      "x-hh-conversation": "followed",
    },
    body: JSON.stringify({
      model: "group/reach",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this" },
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,iVBORw0KGgo=" },
            },
          ],
        },
      ],
    }),
  });
  assert.equal(answer.status, 200, await answer.clone().text());
  await answer.text();
  const page = await waiting;
  const [decided] = page.items;
  assert.ok(decided, JSON.stringify(page));
  assert.equal(decided.requested, "group/reach");
  assert.deepEqual(
    [decided.rules[0]?.n, decided.rules[0]?.use, decided.candidates[0]?.model],
    [1, "fake/seer", "fake/seer"],
  );
  assert.equal(fake.records().at(-1)?.model, "seer");
  // Its conversation's decisions, finished with what answered.
  const calls = await client.modelCalls.list({ limit: 1 });
  const conversation = calls.items[0]!.conversationKey!;
  const own = await client.routing.decisions({ session: conversation });
  assert.deepEqual(
    own.items.map((item) => [item.callId, item.done, item.served?.model]),
    [[decided.callId, true, "fake/seer"]],
  );
  assert.equal(
    (await client.routing.decisions({ session: "nobody" })).items.length,
    0,
  );
  // Administrators only.
  const anonymous = await fetch(`${on.url}/api/v1/routing/decisions`);
  assert.equal(anonymous.status, 401);
  await assert.rejects(
    client.routing.decisions({ wait: 61 }),
    (error: unknown) =>
      error instanceof HarnessHubError && error.code === "INVALID_REQUEST",
  );
});
