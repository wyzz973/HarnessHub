// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { startHub } from "@harnesshub/daemon/main";
import type {
  DoctorCheck,
  DoctorItem,
  ProviderInput,
} from "@harnesshub/sdk/client";
import { connectLocal, readAdminToken } from "@harnesshub/sdk/local";
import { HH_ENTRY } from "../support/entries.js";
import {
  startFakeProvider,
  type FakeProvider,
} from "../support/fake-provider.js";
import { temporaryDirectory } from "../support/temporary.js";

const KEY = "sk-synthetic-doctor-key-000001";
const MODEL = "upstream-sim";

/** The tool round trip and context probe as a model would answer them. */
const SCRIPT = {
  turns: [
    { when: { toolResult: true }, repeat: true, text: "It is sunny in Paris." },
    {
      when: { contains: "get_weather" },
      repeat: true,
      reasoning: "The user wants the weather; call the tool.",
      toolCalls: [{ name: "get_weather", arguments: { city: "Paris" } }],
    },
  ],
};
const OVERFLOW = {
  when: { contains: "HH-DOCTOR-CONTEXT-PROBE" },
  repeat: true,
  status: 400,
  error:
    "This model's maximum context length is 100 tokens. However, your messages resulted in 6200 tokens.",
};

async function daemon(t: TestContext) {
  const { directory, defer } = await temporaryDirectory(
    t,
    "harnesshub-doctor-",
  );
  const dataDir = path.join(directory, "data");
  const hub = await startHub({
    dataDir,
    configDir: path.join(directory, "config"),
    secretsBackend: "file",
    demo: true,
    cwd: directory,
    port: 0,
    host: "127.0.0.1",
  });
  defer(() => hub.server.close());
  const bodies: string[] = [];
  const client = await connectLocal({
    dataDir,
    url: hub.url,
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      bodies.push(await response.clone().text());
      return response;
    },
  });
  return { hub, client, bodies, dataDir, directory };
}

async function fake(t: TestContext, options: Record<string, unknown> = {}) {
  const provider = await startFakeProvider({
    keys: { main: KEY },
    chunkDelayMs: 0,
    script: SCRIPT,
    ...options,
  });
  t.after(() => provider.close());
  return provider;
}

function provider(
  id: string,
  upstream: FakeProvider,
  fields: Partial<ProviderInput> = {},
): ProviderInput {
  return {
    id,
    endpoints: { chat: `${upstream.url}/v1` },
    models: {
      source: "manual",
      list: [
        { id: MODEL, contextWindow: 100, inputModalities: ["text", "image"] },
      ],
      expose: "all",
    },
    credential: { value: KEY },
    ...fields,
  } as ProviderInput;
}

function items(report: { items?: DoctorItem[] }) {
  const byCheck = new Map(
    (report.items ?? []).map((item) => [item.check, item]),
  );
  return (check: DoctorCheck) => {
    const item = byCheck.get(check);
    assert.ok(item, check);
    return item;
  };
}

void test("a healthy upstream passes every check, and each request is in the ledger", async (t) => {
  const { client, bodies } = await daemon(t);
  const upstream = await fake(t, {
    fields: {
      chat: {
        allowed: {
          topLevel: [
            "stream_options",
            "store",
            "metadata",
            "service_tier",
            "user",
            "parallel_tool_calls",
            "max_completion_tokens",
          ],
        },
      },
    },
    script: { turns: [...SCRIPT.turns, OVERFLOW] },
  });
  await client.providers.create(
    provider("healthy", upstream, {
      endpoints: {
        chat: `${upstream.url}/v1`,
        responses: `${upstream.url}/v1`,
      },
      capabilities: { requiresReasoningReplay: true },
    }),
  );

  const dry = await client.providers.doctor("healthy", {
    deep: true,
    dryRun: true,
  });
  assert.equal(dry.items, undefined);
  assert.equal(dry.plan.protocol, "chat");
  assert.equal(dry.plan.model, MODEL);
  assert.equal(dry.plan.estimatedCostUsd, null);
  assert.ok(dry.plan.estimatedTokens.input > 100);
  // A dry run sends nothing.
  assert.equal((await client.modelCalls.list()).items.length, 0);

  const report = await client.providers.doctor("healthy", { deep: true });
  const statuses = Object.fromEntries(
    (report.items ?? []).map((item) => [
      item.check,
      `${item.status}: ${item.summary}`,
    ]),
  );
  for (const [check, status] of Object.entries(statuses))
    assert.match(status, /^pass: /, `${check} ${status}`);
  assert.equal(report.patch, undefined);
  const get = items(report);
  assert.match(
    get("context-overflow").summary,
    /recognized as a context overflow/,
  );
  assert.equal(get("context-overflow").httpStatus, 400);
  assert.ok(get("latency").values?.firstByteMs !== undefined);
  // Every request ran as planned and is one ledger entry of client:doctor.
  assert.equal(report.modelCalls, dry.plan.modelCalls);
  const calls = (await client.modelCalls.list({ limit: 200 })).items;
  assert.equal(calls.length, report.modelCalls);
  for (const call of calls) {
    assert.deepEqual(call.scope, { kind: "client", name: "doctor" });
    assert.equal(call.provider, "healthy");
    assert.match(call.inbound.path, /^\/doctor\//);
  }
  assert.ok(
    calls.some((call) => call.inbound.path === "/doctor/optional-fields/store"),
  );
  // Refused on purpose: the replay probe without reasoning, and the context probe.
  assert.deepEqual(
    calls
      .filter((call) => call.status !== 200)
      .map((call) => call.inbound.path)
      .sort(),
    ["/doctor/context-overflow", "/doctor/reasoning-replay"],
  );

  // provider test: one request per declared endpoint.
  const tested = await client.providers.test("healthy");
  assert.deepEqual(
    tested.endpoints.map((item) => [
      item.protocol,
      item.ok,
      item.status,
      item.servedModel,
    ]),
    [
      ["chat", true, 200, MODEL],
      ["responses", true, 200, MODEL],
    ],
  );
  assert.equal(tested.modelCalls, 2);
  assert.equal(bodies.join("\n").includes(KEY), false);
});

void test("the doctor finds the wrong key header, missing replay, refused fields, images, extra endpoints, a swapped model and slowness", async (t) => {
  const { client, bodies } = await daemon(t);
  const upstream = await fake(t, {
    fields: {
      chat: {
        forbidden: { contentPart: { image_url: "this model takes no images" } },
      },
    },
    quirks: { servedModel: "other-model", slowHeaders: 60 },
  });
  await client.providers.create(
    provider("faulty", upstream, { auth: { apiKeyHeader: "x-api-key" } }),
  );
  const report = await client.providers.doctor("faulty", { slowMs: 30 });
  const get = items(report);

  assert.equal(get("endpoints").status, "pass");
  const auth = get("auth");
  assert.equal(auth.status, "fail");
  assert.match(auth.summary, /authorization-bearer, not x-api-key/);
  assert.deepEqual(auth.patch, {
    auth: { apiKeyHeader: "authorization-bearer" },
  });
  assert.equal(auth.httpStatus, 401);
  // Later checks went on with the working header.
  assert.equal(get("models").status, "pass");
  assert.equal(get("tools").status, "pass");

  const replay = get("reasoning-replay");
  assert.equal(replay.status, "fail");
  assert.deepEqual(replay.patch, {
    capabilities: { requiresReasoningReplay: true },
  });

  const optional = get("optional-fields");
  assert.equal(optional.status, "fail");
  assert.match(
    optional.summary,
    /^store, metadata, service_tier, user, stream_options, parallel_tool_calls are refused when added alone$/,
  );
  assert.equal(optional.httpStatus, 400);
  assert.match(optional.excerpt ?? "", /store/);

  const image = get("image");
  assert.equal(image.status, "fail");
  assert.deepEqual(image.suggestions, [
    `hh model set faulty/${MODEL} modalities=text`,
  ]);

  const native = get("native-endpoints");
  assert.equal(native.status, "warn");
  assert.deepEqual(native.patch, {
    endpoints: { responses: `${upstream.url}/v1` },
  });

  assert.equal(get("served-model").status, "warn");
  assert.match(get("served-model").summary, /other-model/);
  assert.equal(get("latency").status, "warn");
  assert.match(get("latency").summary, /^Slow: /);
  assert.equal(get("context-overflow").status, "skip");
  assert.equal(get("max-tokens").status, "pass");
  assert.equal(get("usage").status, "pass");

  // One proposed patch combines every fix, keeping what the provider has.
  assert.deepEqual(report.patch, {
    auth: { apiKeyHeader: "authorization-bearer" },
    capabilities: { requiresReasoningReplay: true },
    patches: {
      chat: {
        patches: ["drop-fields"],
        dropFields: [
          "store",
          "metadata",
          "service_tier",
          "user",
          "stream_options",
          "parallel_tool_calls",
        ],
      },
    },
    endpoints: { responses: `${upstream.url}/v1` },
  });
  for (const item of report.items ?? [])
    if (item.patch)
      assert.ok(item.suggestions[0]?.endsWith("--fix"), item.check);

  // Applied, the patch makes the same checks pass.
  await client.providers.update("faulty", report.patch as never);
  const again = items(
    await client.providers.doctor("faulty", { slowMs: 30_000 }),
  );
  for (const check of [
    "auth",
    "reasoning-replay",
    "optional-fields",
    "native-endpoints",
  ] as const)
    assert.equal(
      again(check).status,
      "pass",
      `${check}: ${again(check).summary} ${again(check).details.join("; ")}`,
    );
  assert.equal(bodies.join("\n").includes(KEY), false);
});

void test("the doctor reports a wrong path with its URL and a model the upstream does not list", async (t) => {
  const { client } = await daemon(t);
  const upstream = await fake(t);
  await client.providers.create(
    provider("wrong-path", upstream, {
      endpoints: {
        chat: `${upstream.url}/wrong/v1`,
        responses: `${upstream.url}/v1`,
      },
    }),
  );
  const report = await client.providers.doctor("wrong-path");
  const get = items(report);
  const endpoints = get("endpoints");
  assert.equal(endpoints.status, "fail");
  assert.equal(endpoints.httpStatus, 404);
  assert.equal(endpoints.url, `${upstream.url}/wrong/v1/chat/completions`);
  assert.match(
    endpoints.summary,
    /wrong\/v1\/chat\/completions: the base URL or path is wrong/,
  );
  // The other endpoint works, so removing this one is proposed.
  assert.deepEqual(endpoints.patch, { endpoints: { chat: null } });
  assert.equal(get("native-endpoints").status, "fail");
  for (const check of ["streaming", "tools", "image", "latency"] as const)
    assert.equal(get(check).status, "skip", check);

  await client.providers.create(
    provider("unlisted", upstream, {
      models: {
        source: "manual",
        list: [{ id: "alias", wire: "missing-model" }],
        expose: "all",
      },
    }),
  );
  const unlisted = items(await client.providers.doctor("unlisted"));
  assert.equal(unlisted("models").status, "fail");
  assert.match(
    unlisted("models").summary,
    /^missing-model is not among the 1 listed models \(model alias\)$/,
  );
  assert.ok(
    unlisted("models").suggestions.includes(
      `hh provider doctor unlisted --model ${MODEL}`,
    ),
  );
  // A 404 that names the model is not a wrong URL.
  assert.equal(unlisted("endpoints").status, "pass");
  assert.match(unlisted("endpoints").summary, /does not know the model/);
});

void test("the doctor finds the output limit field, missing usage, refused tools and a context window larger than declared", async (t) => {
  const { client } = await daemon(t);
  const upstream = await fake(t, {
    fields: {
      chat: {
        allowed: { topLevel: ["max_completion_tokens"] },
        forbidden: {
          topLevel: {
            max_tokens: "use max_completion_tokens",
            tools: "this upstream has no tools",
          },
        },
      },
    },
    quirks: { noUsage: true },
  });
  await client.providers.create(provider("limits", upstream));
  const report = await client.providers.doctor("limits", { deep: true });
  const get = items(report);
  const limit = get("max-tokens");
  assert.equal(limit.status, "fail");
  assert.match(limit.summary, /wants max_completion_tokens/);
  assert.deepEqual(limit.patch, {
    patches: { chat: { patches: ["max-tokens-field"] } },
  });
  // The rest ran with max_completion_tokens.
  assert.equal(get("endpoints").status, "pass");
  assert.equal(get("streaming").status, "pass");
  assert.equal(get("usage").status, "warn");
  assert.match(get("usage").summary, /No answer reports usage/);
  assert.equal(get("tools").status, "fail");
  assert.match(get("tools").excerpt ?? "", /tools/);
  assert.equal(get("reasoning-replay").status, "skip");
  const overflow = get("context-overflow");
  assert.equal(overflow.status, "fail");
  assert.match(overflow.summary, /declared window of 100 tokens was accepted/);

  // With the patch on, max_completion_tokens passes.
  await client.providers.update("limits", report.patch as never);
  const fixed = items(await client.providers.doctor("limits"));
  assert.equal(fixed("max-tokens").status, "pass");
});

void test("the doctor tells a broken stream, an optional replay, already dropped fields and an unknown overflow wording", async (t) => {
  const { client } = await daemon(t);
  const broken = await fake(t, { quirks: { midStreamError: 1 } });
  await client.providers.create(provider("broken-stream", broken));
  const stream = items(await client.providers.doctor("broken-stream"))(
    "streaming",
  );
  assert.equal(stream.status, "fail");
  assert.match(stream.summary, /stream failed/);

  const lenient = await fake(t, {
    reasoningReplay: false,
    script: {
      turns: [
        ...SCRIPT.turns,
        { ...OVERFLOW, error: "Request rejected by the gateway." },
      ],
    },
  });
  await client.providers.create(
    provider("lenient", lenient, {
      patches: {
        chat: {
          patches: ["drop-fields"],
          dropFields: [
            "store",
            "metadata",
            "service_tier",
            "user",
            "stream_options",
            "parallel_tool_calls",
          ],
        },
      },
    }),
  );
  const get = items(await client.providers.doctor("lenient", { deep: true }));
  assert.equal(get("reasoning-replay").status, "pass");
  assert.match(get("reasoning-replay").summary, /optional/);
  assert.equal(get("optional-fields").status, "pass");
  assert.match(get("optional-fields").summary, /already dropped/);
  assert.equal(get("context-overflow").status, "warn");
  assert.match(
    get("context-overflow").summary,
    /not recognized as a context overflow/,
  );
});

void test("doctor and test refuse unknown providers and a provider without a model", async (t) => {
  const { client } = await daemon(t);
  await assert.rejects(client.providers.doctor("nope"), {
    code: "PROVIDER_NOT_FOUND",
  });
  await assert.rejects(client.providers.test("nope"), {
    code: "PROVIDER_NOT_FOUND",
  });
  await client.providers.create({
    id: "empty",
    endpoints: { chat: "http://127.0.0.1:9/v1" },
  });
  await assert.rejects(client.providers.doctor("empty", { dryRun: true }), {
    code: "DOCTOR_MODEL_REQUIRED",
  });
  // An unreachable upstream is a report, not an error.
  const report = await client.providers.test("empty", { model: "m" });
  assert.equal(report.endpoints[0]?.ok, false);
  assert.equal(report.endpoints[0]?.status, 0);
  assert.match(report.endpoints[0]?.error ?? "", /request failed/);
});

/** Run the real `hh` launcher with piped stdin (never interactive). */
function hh(cwd: string, args: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(
        process.execPath,
        [fileURLToPath(HH_ENTRY), ...args],
        {
          cwd,
          env: process.env,
          stdio: ["pipe", "pipe", "pipe"],
        },
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
      child.stdin.end();
    },
  );
}

void test(
  "hh provider test and doctor print the plan, the report and apply --fix only when confirmed",
  { timeout: 120_000 },
  async (t) => {
    const { hub, client, dataDir, directory } = await daemon(t);
    const upstream = await fake(t);
    await client.providers.create(provider("cli", upstream));
    const run = (args: string[]) =>
      hh(directory, [...args, "--url", hub.url, "--data-dir", dataDir]);

    const tested = await run(["provider", "test", "cli"]);
    assert.equal(tested.code, 0, tested.stderr);
    assert.match(tested.stdout, /^Test: cli, model upstream-sim\n/);
    assert.match(
      tested.stdout,
      /\nchat +200 +\d+ ms +\d+ ms +upstream-sim +http:\/\/127\.0\.0\.1:\d+\/v1\/chat\/completions\n/,
    );
    assert.match(
      tested.stdout,
      /\n1 model calls, cost \$0\.000000 \(1 without a price\)\n$/,
    );

    const doctor = await run(["provider", "doctor", "cli"]);
    assert.equal(doctor.code, 0, doctor.stderr);
    assert.match(
      doctor.stdout,
      /^Doctor: cli, model upstream-sim, on the chat endpoint\nPlan: \d+ model calls \(at most \d+\) and 1 model list request; estimated cost unknown/,
    );
    assert.match(
      doctor.stdout,
      /\nPASS  endpoints +Every declared endpoint answered \(chat\)\n/,
    );
    assert.match(
      doctor.stdout,
      /\nFAIL  optional-fields +store, .* are refused when added alone\n(.|\n)*?      try: hh provider doctor cli --fix\n/,
    );
    assert.match(
      doctor.stdout,
      /\n\d+ pass, \d+ warn, \d+ fail, \d+ skip; \d+ model calls, cost \$0\.000000/,
    );
    assert.match(
      doctor.stdout,
      /\nProposed change: hh provider doctor cli --fix\n$/,
    );

    const json = await run(["provider", "doctor", "cli", "--json"]);
    assert.equal(json.code, 0, json.stderr);
    const report = JSON.parse(json.stdout) as {
      items: DoctorItem[];
      patch: object;
    };
    assert.equal(report.items.length, 14);
    assert.ok(report.patch);

    // --fix without a terminal or --yes changes nothing.
    const refused = await run(["provider", "doctor", "cli", "--fix"]);
    assert.equal(refused.code, 4, refused.stderr);
    assert.match(
      refused.stdout,
      /\nProposed change to provider cli \(PATCH \/api\/v1\/providers\/cli\):\n\{/,
    );
    assert.match(refused.stderr, /pass --yes/);
    assert.equal((await client.providers.get("cli")).patches, undefined);
    const fixed = await run(["provider", "doctor", "cli", "--fix", "--yes"]);
    assert.equal(fixed.code, 0, fixed.stderr);
    assert.match(fixed.stdout, /\nUpdated provider cli\.\n$/);
    assert.deepEqual(
      (await client.providers.get("cli")).patches?.chat?.patches,
      ["drop-fields"],
    );

    const deep = await run(["provider", "doctor", "cli", "--deep"]);
    assert.equal(
      deep.code,
      4,
      "--deep asks before sending a context-sized input",
    );
    for (const outcome of [tested, doctor, json, refused, fixed, deep])
      assert.equal(`${outcome.stdout}${outcome.stderr}`.includes(KEY), false);
    const usage = await run(["provider", "doctor", "cli", "--slow-ms", "0"]);
    assert.equal(usage.code, 2);
  },
);

void test("a request cancelled by the client is still recorded, and nothing more is sent", async (t) => {
  const { hub, client, dataDir } = await daemon(t);
  const upstream = await fake(t, { quirks: { slowHeaders: 5_000 } });
  await client.providers.create(provider("slow", upstream));
  const abort = new AbortController();
  const pending = fetch(`${hub.url}/api/v1/providers/slow/doctor`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${await readAdminToken(dataDir)}`,
      "content-type": "application/json",
    },
    body: "{}",
    signal: abort.signal,
  });
  // Cancel once the first request reached the upstream.
  const deadline = Date.now() + 5_000;
  while (upstream.activity().responses === 0) {
    assert.ok(Date.now() < deadline, "the doctor never reached the upstream");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  abort.abort();
  await assert.rejects(pending);
  let calls: Awaited<ReturnType<typeof client.modelCalls.list>>["items"] = [];
  while (!calls.length) {
    assert.ok(Date.now() < deadline, "the cancelled request was not recorded");
    await new Promise((resolve) => setTimeout(resolve, 20));
    calls = (await client.modelCalls.list()).items;
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.status, 499);
  assert.equal(calls[0]?.errorClass, "client_cancelled");
  assert.equal(calls[0]?.inbound.path, "/doctor/endpoints");
  await upstream.idle();
  assert.equal(upstream.records().length, 1);
});
