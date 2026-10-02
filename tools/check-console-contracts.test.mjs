// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";
import ts from "typescript";

// Execute the actual browser schemas without a Next server. Only import paths
// change; TypeScript's compiler erases types before Node loads the modules.
async function consoleContracts() {
  const require = createRequire(
    new URL("../packages/console/package.json", import.meta.url),
  );
  const zod = pathToFileURL(require.resolve("zod")).href;
  const asModule = (source) =>
    `data:text/javascript;base64,${Buffer.from(
      ts.transpileModule(source, {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2024,
        },
      }).outputText,
    ).toString("base64")}`;
  const configuration = asModule(
    (
      await readFile(
        new URL("../packages/console/lib/engine-configuration.ts", import.meta.url),
        "utf8",
      )
    ).replace('from "zod"', `from ${JSON.stringify(zod)}`),
  );
  const contract = asModule(
    (
      await readFile(
        new URL("../packages/console/lib/contracts.ts", import.meta.url),
        "utf8",
      )
    )
      .replace('from "zod"', `from ${JSON.stringify(zod)}`)
      .replace(
        'from "./engine-configuration"',
        `from ${JSON.stringify(configuration)}`,
      ),
  );
  return import(contract);
}

test("console engine list and edit schemas preserve bounded ACP initialization without requiring resume", async () => {
  const { engineSchema, registrationSchema, candidateSchema } =
    await consoleContracts();
  const registration = {
    id: "openclaw",
    driver: "acp",
    command: ["node.exe", "launch-openclaw-bundled.mjs"],
    // The bundled OpenClaw budget, above the former 60 s bound.
    acp: { initializeTimeoutMs: 180000 },
  };
  assert.deepEqual(
    registrationSchema.parse(registration).acp,
    registration.acp,
  );
  const engine = engineSchema.parse({
    ...registration,
    revision: "revision",
    enabled: true,
    maxConcurrency: 1,
    capabilities: {
      configured: { resume: false, permissions: true, images: false },
      observed: null,
      validated: null,
    },
  });
  assert.deepEqual(engine.acp, registration.acp);
  assert.deepEqual(
    candidateSchema.parse({
      id: "openclaw",
      name: "OpenClaw",
      executable: "node.exe",
      source: "manifest",
      status: "ready",
      registration,
      notes: [],
    }).registration.acp,
    registration.acp,
  );
  for (const acp of [
    { initializeTimeoutMs: 0 },
    { initializeTimeoutMs: 300001 },
    { initializeTimeoutMs: 1.5 },
    { initializeTimeoutMs: "60000" },
    { sessionMode: "invalid" },
    { timeout: 1000 },
  ]) {
    assert.equal(
      registrationSchema.safeParse({ ...registration, acp }).success,
      false,
    );
    assert.equal(engineSchema.safeParse({ ...engine, acp }).success, false);
  }
  assert.deepEqual(
    registrationSchema.parse({
      ...registration,
      acp: { sessionMode: "resume", initializeTimeoutMs: 60000 },
    }).acp,
    { sessionMode: "resume", initializeTimeoutMs: 60000 },
  );
});

test("console reads Session diagnostics pages with free-form records and rejects malformed pages", async () => {
  const { sessionLogsSchema } = await consoleContracts();
  const page = {
    source: "gateway",
    file: "C:\\hh\\data\\logs\\gateway.log",
    exists: true,
    records: [
      {
        time: "2026-09-19T12:00:00.000Z",
        level: "info",
        event: "model.call",
        runId: "r1",
        usage: { input: 3 },
      },
      {
        time: "2026-09-19T12:00:01.000Z",
        level: "debug",
        event: "acp.update",
        params: "{}",
      },
    ],
    cursor: "123456789:4096",
    truncated: false,
    skipped: 0,
  };
  const parsed = sessionLogsSchema.parse(page);
  assert.equal(
    parsed.records[0].usage.input,
    3,
    "event-specific fields are kept",
  );
  assert.equal(
    sessionLogsSchema.parse({
      ...page,
      exists: false,
      records: [],
      cursor: null,
    }).cursor,
    null,
  );
  for (const invalid of [
    { ...page, source: "worker" },
    { ...page, cursor: undefined },
    { ...page, skipped: -1 },
    { ...page, records: [{ level: "info", event: "no-time" }] },
    { ...page, records: [{ time: "2026-09-19T12:00:00.000Z", level: "info" }] },
  ])
    assert.equal(
      sessionLogsSchema.safeParse(invalid).success,
      false,
      JSON.stringify(invalid),
    );
});

/** A console module transpiled for Node, with the SDK resolved to its build. */
async function consoleModule(file, replacements = {}) {
  const sdk = (name) =>
    JSON.stringify(
      new URL(`../packages/sdk/dist/src/${name}.js`, import.meta.url).href,
    );
  let source = await readFile(
    new URL(`../packages/console/${file}`, import.meta.url),
    "utf8",
  );
  source = source
    .replaceAll('from "@harnesshub/sdk/client"', `from ${sdk("client")}`)
    .replaceAll('from "@harnesshub/sdk/local"', `from ${sdk("local")}`);
  for (const [from, to] of Object.entries(replacements))
    source = source.replaceAll(from, to);
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2024 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

test("the console proxy adds the admin token to /api/v1 only and keeps its local-origin checks", async (t) => {
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { createServer } = await import("node:http");
  const os = await import("node:os");
  const path = await import("node:path");
  const directory = await mkdtemp(path.join(os.tmpdir(), "hh-console-proxy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const token = "T".repeat(40) + "abc";
  await writeFile(path.join(directory, "admin.token"), `${token}\n`, { mode: 0o600 });
  const seen = [];
  const upstream = createServer((request, response) => {
    seen.push({ url: request.url, authorization: request.headers.authorization });
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"items":[],"nextCursor":null}');
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const saved = {
    url: process.env.HARNESSHUB_GATEWAY_URL,
    dir: process.env.HARNESSHUB_DATA_DIR,
  };
  t.after(() => {
    for (const [name, value] of [
      ["HARNESSHUB_GATEWAY_URL", saved.url],
      ["HARNESSHUB_DATA_DIR", saved.dir],
    ])
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  });
  process.env.HARNESSHUB_GATEWAY_URL = `http://127.0.0.1:${upstream.address().port}`;
  process.env.HARNESSHUB_DATA_DIR = directory;
  const proxy = await consoleModule("app/api/gateway/[...path]/route.ts");
  const call = (segments, init = {}) =>
    proxy.GET(
      new Request(`http://127.0.0.1:3330/api/gateway/${segments.join("/")}`, init),
      { params: Promise.resolve({ path: segments }) },
    );

  // /api/v1: the browser's own Authorization is replaced by the daemon token.
  const listed = await call(["api", "v1", "providers"], {
    headers: { authorization: "Bearer from-the-browser" },
  });
  assert.equal(listed.status, 200);
  const body = await listed.text();
  assert.equal(body, '{"items":[],"nextCursor":null}');
  assert.deepEqual(seen.at(-1), {
    url: "/api/v1/providers",
    authorization: `Bearer ${token}`,
  });
  for (const [name, value] of listed.headers) {
    assert.equal(value.includes(token), false, name);
  }
  // Other roots get no credentials.
  await call(["v1", "engines"], { headers: { authorization: "Bearer x" } });
  assert.deepEqual(seen.at(-1), { url: "/v1/engines", authorization: undefined });

  // Refused before any upstream request; /api errors are problem details.
  const before = seen.length;
  const cases = [
    [["api", "admin"], {}, 400, "INVALID_GATEWAY_PATH"],
    [["api"], {}, 400, "INVALID_GATEWAY_PATH"],
    [["api", "v1", ".."], {}, 400, "INVALID_GATEWAY_PATH"],
    [["api", "v1", "providers"], { headers: { origin: "http://evil.example" } }, 403, "LOCAL_ACCESS_REQUIRED"],
    [["api", "v1", "providers"], { headers: { "sec-fetch-site": "cross-site" } }, 403, "LOCAL_ACCESS_REQUIRED"],
  ];
  for (const [segments, init, status, code] of cases) {
    const refused = await call(segments, init);
    assert.equal(refused.status, status, segments.join("/"));
    assert.match(refused.headers.get("content-type"), /^application\/problem\+json/);
    assert.equal((await refused.json()).code, code);
  }
  const legacy = await call(["admin"]);
  assert.equal(legacy.status, 400);
  assert.equal((await legacy.json()).error.code, "INVALID_GATEWAY_PATH");

  // Without a readable token the proxy answers 503 and forwards nothing.
  await writeFile(path.join(directory, "admin.token"), "short\n", { mode: 0o600 });
  const broken = await call(["api", "v1", "providers"]);
  assert.equal(broken.status, 503);
  assert.equal((await broken.json()).code, "ADMIN_TOKEN_UNAVAILABLE");
  delete process.env.HARNESSHUB_DATA_DIR;
  const unset = await call(["api", "v1", "providers"]);
  assert.equal(unset.status, 503);
  assert.equal((await unset.json()).code, "ADMIN_TOKEN_UNAVAILABLE");
  assert.equal(seen.length, before);
  assert.equal(typeof proxy.PATCH, "function");
});

test("the model-plane pages build API requests and read problem details", async () => {
  const lib = await consoleModule("lib/model-plane.ts");
  const { HarnessHubError } = await import(
    new URL("../packages/sdk/dist/src/client.js", import.meta.url).href
  );
  const form = {
    ...lib.emptyProviderForm(),
    id: " deepseek ",
    name: "DeepSeek",
    endpoints: {
      chat: " https://api.deepseek.com/v1 ",
      responses: "",
      anthropic: "https://api.deepseek.com/anthropic",
      gemini: "",
    },
    models: "deepseek-chat\n\n deepseek-reasoner \ndeepseek-chat\n",
    expose: ["deepseek-reasoner", "gone"],
  };
  assert.deepEqual(lib.providerInput(form), {
    id: "deepseek",
    name: "DeepSeek",
    kind: "vendor",
    auth: { apiKeyHeader: "authorization-bearer" },
    endpoints: {
      chat: "https://api.deepseek.com/v1",
      anthropic: "https://api.deepseek.com/anthropic",
    },
    models: {
      source: "manual",
      list: [{ id: "deepseek-chat" }, { id: "deepseek-reasoner" }],
      expose: ["deepseek-reasoner"],
    },
  });
  const previous = {
    schemaVersion: 1,
    id: "deepseek",
    name: "DeepSeek",
    kind: "vendor",
    endpoints: { chat: "https://api.deepseek.com/v1", gemini: "https://g.example" },
    auth: { apiKeyHeader: "authorization-bearer" },
    credentials: [],
    models: {
      source: "live",
      list: [{ id: "deepseek-chat", contextWindow: 64000 }],
      expose: "all",
    },
    createdAt: "2026-10-02T00:00:00.000Z",
    updatedAt: "2026-10-02T00:00:00.000Z",
  };
  const edited = lib.providerFormOf(previous);
  const patch = lib.providerPatch(
    {
      ...edited,
      name: "",
      endpoints: { ...edited.endpoints, gemini: "" },
      models: "deepseek-chat\nnew-model",
    },
    previous,
  );
  // A cleared endpoint is removed with null; kept models keep their metadata.
  assert.deepEqual(patch.endpoints, { chat: "https://api.deepseek.com/v1", gemini: null });
  assert.equal(patch.name, "deepseek");
  assert.deepEqual(patch.models, {
    source: "live",
    list: [{ id: "deepseek-chat", contextWindow: 64000 }, { id: "new-model" }],
    expose: "all",
  });

  // Model metadata cells show the resolved values; tooltips name the source.
  const cells = lib.modelMetadataCells({
    ref: "deepseek/deepseek-chat",
    listed: true,
    fields: {
      contextWindow: { value: 128000, source: "catalog", at: "2026-10-02T00:00:00.000Z" },
      "price.input": { value: 0.27, source: "override", at: "2026-10-02T00:00:00.000Z" },
      maxOutputTokens: { value: 8192, source: "preset", at: "2026-09-30" },
    },
    unknown: ["price.output"],
    overrides: [],
  });
  assert.equal(cells.context.text, (128000).toLocaleString());
  assert.match(cells.context.note, /^来源：models\.dev 目录快照，/);
  assert.equal(cells.output.note, "来源：provider 预设，核对于 2026-09-30");
  assert.equal(cells.price.text, "$0.27 / ?");
  assert.match(cells.price.note, /^输入：来源：模型覆盖，.*\n输出：未知：没有来源提供此值/);
  const empty = lib.modelMetadataCells(undefined);
  assert.deepEqual(
    [empty.context.text, empty.output.text, empty.price.text],
    ["—", "—", "—"],
  );
  assert.match(empty.context.note, /^未知/);

  const now = Date.parse("2026-10-02T00:00:00.000Z");
  assert.equal(lib.expiresAtFor("never", now), null);
  assert.equal(lib.expiresAtFor("30d", now), "2026-11-01T00:00:00.000Z");
  assert.equal(lib.rangeStart("all", now), undefined);
  assert.equal(lib.rangeStart("24h", now), "2026-10-01T00:00:00.000Z");
  assert.equal(lib.addAmounts(["0.1", "0.2", "0.0000001", "3"]), "3.3000001");
  assert.equal(lib.addAmounts([]), "0");

  const failure = lib.failureOf(
    new HarnessHubError({
      type: "https://harnesshub.dev/problems/provider-invalid",
      title: "Bad Request",
      status: 400,
      code: "PROVIDER_INVALID",
      requestId: "req-1",
      errors: [
        { pointer: "/endpoints/chat", detail: "must be the base URL" },
        { parameter: "limit", detail: "must be <= 200" },
      ],
    }),
  );
  assert.equal(failure.code, "PROVIDER_INVALID");
  assert.deepEqual(failure.fields, {
    "/endpoints/chat": "must be the base URL",
    limit: "must be <= 200",
  });
  const blocked = lib.failureOf(
    new HarnessHubError({
      type: "x",
      title: "Conflict",
      status: 409,
      code: "SOMETHING_NEW",
      requestId: "req-2",
      detail: "Daemon detail",
      references: [{ type: "route-group", id: "fast" }],
    }),
  );
  // Unknown codes keep the daemon's detail; references are kept for display.
  assert.equal(blocked.message, "Daemon detail");
  assert.deepEqual(blocked.references, [{ type: "route-group", id: "fast" }]);
  assert.equal(lib.failureOf(new Error("plain")).message, "plain");
});
