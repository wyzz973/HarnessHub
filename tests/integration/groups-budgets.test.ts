// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { seal } from "@harnesshub/daemon/backup-envelope";
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
const KEY = "sk-synthetic-groups-budgets-0001";
const PASSPHRASE = "synthetic passphrase for groups and budgets";

interface Hub {
  client: HarnessHubClient;
  url: string;
  dataDir: string;
  directory: string;
  fake: FakeProvider;
  v1: string;
  /** Stop the daemon, run `between` (on its stopped data), and start it again on the same data. */
  restart(between: () => void): Promise<void>;
}

/** A daemon with a provider on the strict fake upstream: two priced models, one that reasons and takes images. */
async function hub(t: TestContext): Promise<Hub> {
  const { directory, defer } = await temporaryDirectory(t, "hh-groups-");
  const fake = await startFakeProvider({
    models: ["big", "small"],
    keys: { upstream: KEY },
    chunkDelayMs: 0,
  });
  defer(() => fake.close());
  const dataDir = path.join(directory, "data");
  await mkdir(path.join(directory, "home"));
  const boot = () =>
    startHub({
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
  let started: Awaited<ReturnType<typeof startHub>> | undefined = await boot();
  defer(() => started?.server.close());
  const client = await connectLocal({ dataDir, url: started.url });
  await client.providers.create({
    id: "fake",
    name: "Fake",
    kind: "custom",
    endpoints: { chat: `${fake.url}/v1` },
    models: {
      source: "manual",
      list: [
        {
          id: "big",
          contextWindow: 1_000_000,
          maxOutputTokens: 64_000,
          reasoning: true,
          inputModalities: ["text", "image"],
          price: { input: 1, output: 2 },
        },
        {
          id: "small",
          contextWindow: 200_000,
          maxOutputTokens: 8_192,
          reasoning: true,
          inputModalities: ["text"],
          price: { input: 1, output: 2 },
        },
      ],
      expose: "all",
    },
    credential: { value: KEY },
  });
  const info = await client.system.info();
  const on: Hub = {
    client,
    url: started.url,
    dataDir,
    directory,
    fake,
    v1: info.gateway!.openaiBaseUrl,
    async restart(between) {
      const running = started;
      started = undefined;
      await running?.server.close();
      between();
      started = await boot();
      on.url = started.url;
      on.client = await connectLocal({ dataDir, url: started.url });
      on.v1 = (await on.client.system.info()).gateway!.openaiBaseUrl;
    },
  };
  return on;
}

function problem(code: string, detail?: RegExp) {
  return (error: unknown) => {
    assert.ok(error instanceof HarnessHubError, String(error));
    assert.equal(error.code, code, JSON.stringify(error.problem));
    if (detail)
      assert.match(
        (error.problem.errors ?? []).map((item) => item.detail).join("\n"),
        detail,
      );
    return true;
  };
}

/** Run the real `hh` launcher against the hub; stdin is piped, so it never asks. */
function hh(
  on: Hub,
  args: string[],
  input = "",
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
    child.stdin.end(input);
  });
}

async function chat(on: Hub, key: string, model: string) {
  const response = await fetch(`${on.v1}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  return {
    status: response.status,
    headers: response.headers,
    body: await response.text(),
  };
}

void test("route groups: groups inside groups, member efforts and :fast, loops and references are checked on write", async (t) => {
  const on = await hub(t);
  const { client } = on;
  await client.routeGroups.create({ id: "inner", members: ["fake/small"] });
  const outer = await client.routeGroups.create({
    id: "outer",
    members: ["fake/big:HIGH", "group/inner"],
  });
  assert.deepEqual(outer.members, ["fake/big:high", "group/inner"]);
  // inner would contain outer, which contains inner.
  await assert.rejects(
    client.routeGroups.update("inner", { members: ["group/outer"] }),
    problem("ROUTE_GROUP_INVALID", /group\/outer contains group\/inner/),
  );
  await assert.rejects(
    client.routeGroups.create({ id: "x", members: ["group/missing"] }),
    problem("ROUTE_GROUP_INVALID", /there is no group missing/),
  );
  await assert.rejects(
    client.routeGroups.create({ id: "y", members: ["group/inner:high"] }),
    problem("ROUTE_GROUP_INVALID", /takes no effort or :fast/),
  );
  await assert.rejects(
    client.routeGroups.create({ id: "z", members: ["fake/big:fast"] }),
    problem("ROUTE_GROUP_INVALID", /fake\/big has no fast mode/),
  );
  await assert.rejects(
    client.routeGroups.create({
      id: "twice",
      members: ["fake/big:high", "fake/big:HIGH"],
    }),
    problem("ROUTE_GROUP_INVALID", /must not repeat a member/),
  );
  await assert.rejects(client.routeGroups.remove("inner"), (error: unknown) => {
    assert.ok(error instanceof HarnessHubError);
    assert.equal(error.code, "ROUTE_GROUP_IN_USE");
    assert.deepEqual(error.problem.references, [
      { type: "route-group", id: "outer" },
    ]);
    return true;
  });
  // An automatic group inside one of the user's cannot be hidden.
  await client.providers.create({
    id: "mirror",
    name: "Mirror",
    kind: "custom",
    endpoints: { chat: `${on.fake.url}/v1` },
    models: { source: "manual", list: [{ id: "small" }], expose: "all" },
    credential: { value: KEY },
  });
  await client.routeGroups.create({
    id: "wrap",
    members: ["group/auto-small"],
  });
  await assert.rejects(
    client.autoGroups.hide("auto-small"),
    (error: unknown) => {
      assert.ok(error instanceof HarnessHubError);
      assert.equal(error.code, "ROUTE_GROUP_IN_USE");
      assert.deepEqual(error.problem.references, [
        { type: "route-group", id: "wrap" },
      ]);
      return true;
    },
  );
  // Wiring describes a group the same way: OpenCode is offered the
  // smallest window of outer's models (big at high, inner's small) and the
  // levels small, which follows the request, has.
  const plan = await client.agents.plan("opencode", {
    model: "group/outer",
    models: ["group/outer"],
  });
  const provider = JSON.parse(
    plan.files[0]!.changes.find(
      (change) => change.keyPath.join("/") === "provider/harnesshub",
    )?.after ?? "{}",
  ) as {
    models?: Record<
      string,
      { limit?: { context?: number }; variants?: Record<string, unknown> }
    >;
  };
  const written = provider.models?.["group/outer"] ?? {};
  assert.equal(written.limit?.context, 200_000);
  assert.deepEqual(Object.keys(written.variants ?? {}), [
    "low",
    "medium",
    "high",
  ]);
  // The nested group serves and is listed with what its models share.
  const created = await client.gatewayKeys.create({
    name: "groups",
    modelAllow: ["group/inner"],
  });
  const answer = await chat(on, created.key, "group/inner");
  assert.equal(answer.status, 200, answer.body);
  assert.equal(on.fake.records().at(-1)?.model, "small");
  assert.deepEqual(on.fake.violations(), []);
  const listed = await fetch(`${on.v1}/models`, {
    headers: { authorization: `Bearer ${created.key}` },
  });
  const inner = (
    (await listed.json()) as { data: Record<string, unknown>[] }
  ).data.find((item) => item.id === "group/inner")!;
  assert.equal(inner.context_window, 200_000);
  assert.deepEqual(inner.supported_reasoning_levels, ["low", "medium", "high"]);
});

void test("key budgets: set on create and later, refused with Retry-After once spent, shown by the limit endpoint and hh key", async (t) => {
  const on = await hub(t);
  const { client } = on;
  await assert.rejects(
    client.gatewayKeys.create({
      name: "twice",
      modelAllow: ["fake/*"],
      quota: {
        budgets: [
          { period: "day", tokens: 10 },
          { period: "day", costUsd: 1 },
        ],
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof HarnessHubError);
      assert.equal(error.code, "GATEWAY_KEY_INVALID");
      assert.equal(
        error.problem.errors?.[0]?.pointer,
        "/quota/budgets/1/period",
      );
      return true;
    },
  );
  // The fields of before are refused, not silently ignored.
  await assert.rejects(
    client.gatewayKeys.create({
      name: "old",
      modelAllow: ["fake/*"],
      quota: { tokensPerDay: 10 } as never,
    }),
    (error: unknown) =>
      error instanceof HarnessHubError && error.status === 400,
  );
  const created = await client.gatewayKeys.create({
    name: "budgeted",
    modelAllow: ["fake/*"],
    quota: { budgets: [{ period: "day", tokens: 1 }] },
  });
  const id = created.gatewayKey.keyId;
  assert.equal((await chat(on, created.key, "fake/big")).status, 200);
  const refused = await chat(on, created.key, "fake/big");
  assert.equal(refused.status, 429, refused.body);
  assert.equal(refused.headers.get("x-should-retry"), "false");
  const reset = refused.headers.get("x-hh-limit-reset")!;
  assert.ok(Date.parse(reset) > Date.now());
  // Retry-After is the wait until the reset, rounded up, read a moment ago.
  const wait = (Date.parse(reset) - Date.now()) / 1000;
  const retryAfter = Number(refused.headers.get("retry-after"));
  assert.ok(
    retryAfter >= Math.floor(wait) && retryAfter <= Math.ceil(wait) + 1,
    `${retryAfter} for ${wait}`,
  );
  assert.match(refused.body, /quota_exceeded/);
  const limit = await client.gatewayKeys.limit(id);
  assert.equal(limit.keyId, id);
  assert.equal(
    limit.timeZone,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const day = limit.budgets[0]!;
  assert.equal(day.period, "day");
  assert.equal(day.resetsAt, reset);
  assert.equal(day.calls, 1);
  assert.ok(day.tokens > 1);
  assert.equal(day.tokenLimit, 1);
  assert.equal(day.tokensLeft, 0);
  assert.equal(day.spent, true);
  assert.equal(day.inFlight, 0);
  const shown = await hh(on, ["key", "limit", id]);
  assert.equal(shown.code, 0, shown.stderr);
  assert.match(
    shown.stdout,
    new RegExp(`^Key ${id} \\(budgeted\\); windows in `),
  );
  assert.match(shown.stdout, /\nday +\d+\/1 +.* spent$/m);
  // A new budget applies to the next request.
  const set = await hh(on, [
    "key",
    "quota",
    id,
    "--budget",
    "week:cost=5",
    "--rpm",
    "100",
  ]);
  assert.equal(set.code, 0, set.stderr);
  assert.equal(set.stdout.trim(), `Key ${id}: 100 rpm; week $5`);
  assert.deepEqual((await client.gatewayKeys.get(id)).quota, {
    requestsPerMinute: 100,
    budgets: [{ period: "week", costUsd: 5 }],
  });
  assert.equal((await chat(on, created.key, "fake/big")).status, 200);
  const cleared = await hh(on, ["key", "quota", id, "--clear"]);
  assert.equal(cleared.code, 0, cleared.stderr);
  assert.equal((await client.gatewayKeys.get(id)).quota, undefined);
  assert.deepEqual((await client.gatewayKeys.limit(id)).budgets, []);
  // hh key create takes the same options.
  const made = await hh(on, [
    "key",
    "create",
    "--name",
    "cli",
    "--allow",
    "fake/*",
    "--no-expiry",
    "--rpm",
    "10",
    "--budget",
    "day:tokens=100,cache-reads",
    "--budget",
    "month:tokens=1000,cost=2.5",
    "--json",
  ]);
  assert.equal(made.code, 0, made.stderr);
  assert.deepEqual(
    (JSON.parse(made.stdout) as { gatewayKey: { quota: unknown } }).gatewayKey
      .quota,
    {
      requestsPerMinute: 10,
      budgets: [
        { period: "day", tokens: 100, cacheReads: true },
        { period: "month", tokens: 1000, costUsd: 2.5 },
      ],
    },
  );
  const wrong = await hh(on, [
    "key",
    "create",
    "--name",
    "x",
    "--allow",
    "fake/*",
    "--budget",
    "year:tokens=1",
  ]);
  assert.equal(wrong.code, 2);
  assert.match(wrong.stderr, /--budget starts with day, week or month/);
  // A cap of 0 blocks a key, so an empty or negative cap is not read as 0.
  for (const budget of ["day:tokens=", "day:tokens=-1", "month:cost=abc"]) {
    const bad = await hh(on, [
      "key",
      "create",
      "--name",
      "x",
      "--allow",
      "fake/*",
      "--budget",
      budget,
    ]);
    assert.equal(bad.code, 2, budget);
    assert.match(
      bad.stderr,
      /--budget takes tokens=N, cost=USD and cache-reads/,
    );
  }
  const noCap = await hh(on, [
    "key",
    "quota",
    id,
    "--budget",
    "day:cache-reads",
  ]);
  assert.equal(noCap.code, 2);
  assert.match(noCap.stderr, /needs tokens=N or cost=USD/);
  assert.deepEqual(on.fake.violations(), []);
});

void test("a cap of 0 from before budgets keeps its key blocked: through migration 6 and from an old backup", async (t) => {
  const on = await hub(t);
  // Caps of 0 as the build before budgets stored them: every call refused.
  const caps = {
    tokens: { tokensPerDay: 0 },
    cost: { costPerMonthUsd: 0 },
    both: { requestsPerMinute: 5, tokensPerDay: 0, costPerMonthUsd: 0 },
  };
  const keys = new Map<string, { id: string; text: string }>();
  for (const name of Object.keys(caps)) {
    const created = await on.client.gatewayKeys.create({
      name,
      modelAllow: ["fake/*"],
    });
    keys.set(name, { id: created.gatewayKey.keyId, text: created.key });
  }
  // The data as that build left it: schema version 5, the caps of then.
  await on.restart(() => {
    const db = new DatabaseSync(path.join(on.dataDir, "harnesshub.sqlite"));
    try {
      const set = db.prepare(
        "UPDATE gateway_keys SET record = json_set(record, '$.quota', json(?)) WHERE key_id = ?",
      );
      for (const [name, quota] of Object.entries(caps))
        set.run(JSON.stringify(quota), keys.get(name)!.id);
      db.exec(
        "DELETE FROM schema_migrations WHERE version = 6; PRAGMA user_version = 5",
      );
    } finally {
      db.close();
    }
  });
  const day = { period: "day", tokens: 0, cacheReads: true };
  const month = { period: "month", costUsd: 0 };
  assert.deepEqual(
    Object.fromEntries(
      (await on.client.gatewayKeys.list()).items.map((key) => [
        key.name,
        key.quota,
      ]),
    ),
    {
      tokens: { budgets: [day] },
      cost: { budgets: [month] },
      both: { requestsPerMinute: 5, budgets: [day, month] },
    },
  );
  const seen = on.fake.records().length;
  const refusedEveryTime = async (text: string) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const refused = await chat(on, text, "fake/big");
      assert.equal(refused.status, 429, refused.body);
      assert.ok(Number(refused.headers.get("retry-after")) > 0);
      assert.equal(refused.headers.get("x-should-retry"), "false");
      assert.match(
        refused.body,
        /budget of (0 tokens|\$0), so every call is refused/,
      );
    }
  };
  for (const key of keys.values()) {
    await refusedEveryTime(key.text);
    assert.ok(
      (await on.client.gatewayKeys.limit(key.id)).budgets.every(
        (budget) => budget.spent,
      ),
    );
  }

  // An old backup's client keys: the restore shows them with the same caps,
  // as the hh key create options that give them, and keys made so are
  // refused the same way.
  const backup = await seal(
    Buffer.from(
      JSON.stringify({
        version: 1,
        createdAt: new Date().toISOString(),
        app: "HarnessHub 0.1.0",
        keys: false,
        providers: [],
        groups: [],
        settings: {},
        agents: [],
        clientKeys: Object.entries(caps).map(([name, quota]) => ({
          name: `old-${name}`,
          modelAllow: ["fake/*"],
          allowLan: false,
          quota,
        })),
      }),
    ),
    PASSPHRASE,
  );
  const file = path.join(on.directory, "old.harnesshub-backup");
  await writeFile(file, JSON.stringify(backup));
  const restored = await hh(
    on,
    ["restore", file, "--no-agents", "--yes"],
    `${PASSPHRASE}\n`,
  );
  assert.equal(restored.code, 0, restored.stderr);
  const options = {
    tokens: "--budget day:tokens=0,cache-reads",
    cost: "--budget month:cost=0",
    both: "--rpm 5 --budget day:tokens=0,cache-reads --budget month:cost=0",
  };
  for (const [name, shown] of Object.entries(options)) {
    assert.ok(
      restored.stdout.includes(`  old-${name}: fake/*, with ${shown}\n`),
      restored.stdout,
    );
    const made = await hh(on, [
      "key",
      "create",
      "--name",
      `old-${name}`,
      "--allow",
      "fake/*",
      ...shown.split(" "),
      "--json",
    ]);
    assert.equal(made.code, 0, made.stderr);
    await refusedEveryTime((JSON.parse(made.stdout) as { key: string }).key);
  }
  assert.equal(on.fake.records().length, seen, "no refused call went out");
});
