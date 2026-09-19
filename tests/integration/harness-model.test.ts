import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startHub } from "../../src/main.js";
import type { HarnessModelView } from "../../src/domain/harness-model.js";
import {
  isTerminal,
  type EngineProfile,
  type RunRecord,
  type SessionRecord,
} from "../../src/domain/types.js";

type Hub = Awaited<ReturnType<typeof startHub>>;
const peer = fileURLToPath(
  new URL("../fixtures/configuration-peer.js", import.meta.url),
);
const toolPack = fileURLToPath(
  new URL("../../../examples/tool-packages/developer-cli", import.meta.url),
);
// The stub ACP peer ignores provider settings; copilot configuration owns model
// selection natively, so Runs complete without contacting the unreachable model URL.
const stub = (id = "stub") => ({
  id,
  driver: "acp",
  command: [process.execPath, peer],
  model: "vendor-model",
  credentialEnv: ["HH_VENDOR_KEY"],
  configuration: {
    adapter: "copilot",
    provider: {
      protocol: "openai-completions",
      baseUrl: "https://vendor.example/v1",
    },
  },
});
const firstModel = {
  model: "GLM-V5_1-DX",
  provider: {
    protocol: "openai-completions",
    baseUrl: "http://127.0.0.1:9/v1",
    apiKey: { kind: "env", value: "HH_UNIFIED_TEST_KEY" },
    contextWindow: 131072,
  },
};
const secondModel = {
  model: "deepseek-flash",
  alias: "contest-model",
  provider: {
    protocol: "openai-completions",
    baseUrl: "http://127.0.0.1:9/v1",
    apiKey: { kind: "env", value: "HH_UNIFIED_TEST_KEY" },
  },
};

async function call<T>(
  hub: Hub,
  method: string,
  route: string,
  body?: unknown,
): Promise<{ status: number; value: T }> {
  const response = await fetch(`${hub.url}${route}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  return { status: response.status, value: (await response.json()) as T };
}
async function finished(hub: Hub, run: RunRecord): Promise<RunRecord> {
  const deadline = Date.now() + 20000;
  let current = run;
  while (!isTerminal(current.status)) {
    if (Date.now() > deadline)
      throw new Error(`Run did not finish: ${JSON.stringify(current)}`);
    await delay(25);
    current = (await call<RunRecord>(hub, "GET", `/v1/runs/${run.id}`)).value;
  }
  return current;
}
async function execute(hub: Hub, session: SessionRecord): Promise<RunRecord> {
  const accepted = await call<RunRecord>(
    hub,
    "POST",
    `/v1/sessions/${session.id}/runs`,
    { text: "report configuration", timeoutMs: 15000 },
  );
  assert.equal(accepted.status, 202, JSON.stringify(accepted.value));
  const result = await finished(hub, accepted.value);
  assert.equal(result.status, "completed", JSON.stringify(result.error));
  return result;
}
function withEnvironment(t: test.TestContext, values: Record<string, string>) {
  const previous = Object.fromEntries(
    Object.keys(values).map((name) => [name, process.env[name]]),
  );
  Object.assign(process.env, values);
  t.after(() => {
    for (const [name, value] of Object.entries(previous))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  });
}

void test(
  "file source forces the unified model over API and tool-pack registrations; PUT republishes while pinned Sessions and restart keep revisions",
  { timeout: 90000 },
  async (t) => {
    withEnvironment(t, { HH_UNIFIED_TEST_KEY: "unified-fixture-key-A1" });
    const directory = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "hh-unified-file-")),
    );
    let hub: Hub | undefined;
    t.after(async () => {
      await hub?.server.close();
      await rm(directory, { recursive: true, force: true });
    });
    const modelFile = path.join(directory, "state", "harness-model.json");
    const options = {
      dataDir: path.join(directory, "data"),
      cwd: directory,
      demo: true,
      port: 0,
      harnessModelFile: modelFile,
    };
    hub = await startHub(options);
    const empty = await call<HarnessModelView>(hub, "GET", "/v1/harness/model");
    assert.deepEqual(empty.value, {
      configured: false,
      alias: "harnesshub-model",
      engines: [],
    });
    assert.equal(
      (await call(hub, "POST", "/v1/harness/model/test", {})).status,
      409,
    );
    const put = await call<HarnessModelView>(
      hub,
      "PUT",
      "/v1/harness/model",
      firstModel,
    );
    assert.equal(put.status, 200, JSON.stringify(put.value));
    assert.equal(put.value.source, "file");
    assert.equal(
      JSON.parse(await readFile(modelFile, "utf8")).model,
      "GLM-V5_1-DX",
    );

    const registered = await call<EngineProfile>(
      hub,
      "POST",
      "/v1/engines",
      stub(),
    );
    assert.equal(registered.status, 201, JSON.stringify(registered.value));
    assert.equal(registered.value.model, "GLM-V5_1-DX");
    assert.equal(registered.value.credentialEnv, undefined);
    assert.deepEqual(registered.value.configuration?.provider, {
      ...firstModel.provider,
      modelAlias: "harnesshub-model",
    });
    for (const blocked of [
      {
        id: "cursor-cli",
        driver: "cli",
        command: [process.execPath, "-e", "process.stdin.pipe(process.stdout)"],
        configuration: { adapter: "cursor" },
      },
      {
        id: "custom",
        driver: "cli",
        command: [process.execPath, "-e", "process.stdin.pipe(process.stdout)"],
      },
    ]) {
      const response: { status: number; value: EngineProfile } =
        await call<EngineProfile>(hub, "POST", "/v1/engines", blocked);
      assert.equal(response.status, 201);
      assert.equal(response.value.enabled, false, blocked.id);
    }
    const view = await call<HarnessModelView>(hub, "GET", "/v1/harness/model");
    assert.deepEqual(
      view.value.engines.map((engine) => [engine.engineId, engine.status]),
      [
        ["stub", "applied"],
        ["cursor-cli", "unsupported"],
        ["custom", "unsupported"],
      ],
    );
    assert.match(view.value.engines[0]!.reason!, /vendor-model/);
    assert.match(view.value.engines[0]!.reason!, /HH_VENDOR_KEY/);
    const refused = await call<{ error: { code: string; message: string } }>(
      hub,
      "POST",
      "/v1/sessions",
      { engineId: "cursor-cli" },
    );
    assert.equal(refused.status, 404);
    assert.match(refused.value.error.message, /统一模型网关/);

    const workspace = await mkdtemp(path.join(directory, "workspace-"));
    const applied = await call<{ revision: string }>(
      hub,
      "POST",
      "/v1/tool-packs/apply",
      { engineId: "stub", source: toolPack, workspace },
    );
    assert.equal(applied.status, 200, JSON.stringify(applied.value));
    const packed = hub.app.engineProfile("stub");
    assert.equal(packed.revision, applied.value.revision);
    assert.equal(packed.model, "GLM-V5_1-DX");
    assert.equal(packed.credentialEnv, undefined);
    assert.ok(
      packed.configuration?.mcpServers?.some(
        (server) => server.name === "developer-cli-cli",
      ),
    );

    const oldSession = (
      await call<SessionRecord>(hub, "POST", "/v1/sessions", {
        engineId: "stub",
      })
    ).value;
    assert.equal(oldSession.profileRevision, packed.revision);
    assert.equal(oldSession.configSnapshot?.model, "GLM-V5_1-DX");
    const firstRun = await execute(hub, oldSession);
    assert.equal(firstRun.configSnapshot?.profileRevision, packed.revision);

    const changed = await call<HarnessModelView>(
      hub,
      "PUT",
      "/v1/harness/model",
      secondModel,
    );
    assert.equal(changed.status, 200);
    assert.equal(changed.value.model, "deepseek-flash");
    assert.equal(changed.value.alias, "contest-model");
    const republished = hub.app.engineProfile("stub");
    assert.notEqual(republished.revision, packed.revision);
    assert.equal(republished.model, "deepseek-flash");
    assert.equal(
      republished.configuration?.provider?.modelAlias,
      "contest-model",
    );
    const newSession = (
      await call<SessionRecord>(hub, "POST", "/v1/sessions", {
        engineId: "stub",
      })
    ).value;
    assert.equal(newSession.profileRevision, republished.revision);
    assert.equal(newSession.configSnapshot?.model, "deepseek-flash");
    assert.equal(
      (await execute(hub, newSession)).configSnapshot?.profileRevision,
      republished.revision,
    );
    assert.equal(
      (await execute(hub, oldSession)).configSnapshot?.profileRevision,
      packed.revision,
    );

    const probe = await call<{
      ok: boolean;
      status: string;
      runId: string;
      durationMs: number;
    }>(hub, "POST", "/v1/harness/model/test", { engineId: "stub" });
    assert.equal(probe.status, 200, JSON.stringify(probe.value));
    assert.equal(probe.value.ok, true);
    assert.equal(probe.value.status, "completed");
    assert.ok(probe.value.durationMs >= 0);
    const probeRun = (
      await call<RunRecord>(hub, "GET", `/v1/runs/${probe.value.runId}`)
    ).value;
    assert.equal(
      probeRun.configSnapshot?.profileRevision,
      republished.revision,
    );
    for (const [engineId, expected] of [
      ["fake", 409],
      ["cursor-cli", 409],
      ["missing", 404],
    ] as const)
      assert.equal(
        (await call(hub, "POST", "/v1/harness/model/test", { engineId }))
          .status,
        expected,
        engineId,
      );
    for (const [body, code] of [
      [
        {
          ...secondModel,
          provider: { ...secondModel.provider, protocol: "anthropic" },
        },
        "HARNESS_MODEL_PROTOCOL_UNSUPPORTED",
      ],
      [
        {
          ...secondModel,
          provider: { ...secondModel.provider, apiKey: "sk-inline" },
        },
        "INVALID_REQUEST",
      ],
      [
        {
          ...secondModel,
          provider: { ...secondModel.provider, headers: { Cookie: "x=1" } },
        },
        "INVALID_HARNESS_MODEL",
      ],
    ] as const) {
      const rejected: { status: number; value: { error: { code: string } } } =
        await call<{ error: { code: string } }>(
          hub,
          "PUT",
          "/v1/harness/model",
          body,
        );
      assert.equal(rejected.status, 400);
      assert.equal(rejected.value.error.code, code);
    }
    assert.equal(
      JSON.parse(await readFile(modelFile, "utf8")).model,
      "deepseek-flash",
    );
    assert.deepEqual((await call(hub, "GET", "/v1/runtime/info")).value, {
      competition: false,
      fullAccess: false,
    });

    await hub.server.close();
    hub = undefined;
    const database = await readFile(
      path.join(options.dataDir, "harnesshub.sqlite"),
    );
    assert.equal(
      database.includes(Buffer.from("unified-fixture-key-A1")),
      false,
    );
    hub = await startHub(options);
    const restored = hub.app.engineProfile("stub");
    assert.equal(restored.revision, republished.revision);
    assert.equal(
      (await call<HarnessModelView>(hub, "GET", "/v1/harness/model")).value
        .model,
      "deepseek-flash",
    );
  },
);

void test(
  "environment source outranks the configuration file model and cannot be overwritten through the API",
  { timeout: 60000 },
  async (t) => {
    const directory = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "hh-unified-env-")),
    );
    let hub: Hub | undefined;
    t.after(async () => {
      await hub?.server.close();
      await rm(directory, { recursive: true, force: true });
    });
    const configFile = path.join(directory, "engines.json");
    await writeFile(
      configFile,
      JSON.stringify({
        engines: [stub()],
        model: { ...firstModel, model: "settings-model" },
      }),
    );
    const options = {
      dataDir: path.join(directory, "data"),
      cwd: directory,
      demo: false,
      port: 0,
      configFile,
    };
    withEnvironment(t, { HH_UNIFIED_TEST_KEY: "settings-fixture-key-B2" });
    hub = await startHub(options);
    const fromSettings = await call<HarnessModelView>(
      hub,
      "GET",
      "/v1/harness/model",
    );
    assert.equal(fromSettings.value.source, "settings");
    assert.equal(hub.app.engineProfile("stub").model, "settings-model");
    await hub.server.close();
    hub = undefined;

    const key = "environment-fixture-key-C3";
    withEnvironment(t, {
      HARNESSHUB_MODEL: "environment-model",
      HARNESSHUB_MODEL_BASE_URL: "http://127.0.0.1:9/v1",
      HARNESSHUB_MODEL_API_KEY: key,
    });
    hub = await startHub(options);
    const fromEnvironment = await call<HarnessModelView>(
      hub,
      "GET",
      "/v1/harness/model",
    );
    assert.equal(fromEnvironment.value.source, "environment");
    assert.equal(fromEnvironment.value.model, "environment-model");
    assert.deepEqual(fromEnvironment.value.provider?.apiKey, {
      kind: "env",
      value: "HARNESSHUB_MODEL_API_KEY",
    });
    assert.equal(JSON.stringify(fromEnvironment.value).includes(key), false);
    const profile = hub.app.engineProfile("stub");
    assert.equal(profile.model, "environment-model");
    const session = (
      await call<SessionRecord>(hub, "POST", "/v1/sessions", {
        engineId: "stub",
      })
    ).value;
    await execute(hub, session);
    const refused = await call<{ error: { code: string } }>(
      hub,
      "PUT",
      "/v1/harness/model",
      secondModel,
    );
    assert.equal(refused.status, 409);
    assert.equal(
      refused.value.error.code,
      "HARNESS_MODEL_ENVIRONMENT_OVERRIDE",
    );
  },
);

void test(
  "source-mode competition starts from the engine id and HARNESSHUB_MODEL* alone by registering the discovered engine",
  { timeout: 60000 },
  async (t) => {
    const directory = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "hh-unified-source-")),
    );
    let hub: Hub | undefined;
    t.after(async () => {
      await hub?.server.close();
      await rm(directory, { recursive: true, force: true });
    });
    // Discovery only checks installation evidence; this placeholder is never executed.
    const bin = path.join(directory, "bin");
    await mkdir(bin);
    if (process.platform === "win32")
      await writeFile(path.join(bin, "opencode.cmd"), "@exit /b 1\r\n");
    else
      await writeFile(path.join(bin, "opencode"), "#!/bin/sh\nexit 1\n", {
        mode: 0o755,
      });
    withEnvironment(t, {
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      HARNESSHUB_MODEL: "GLM-V5_1-DX",
      HARNESSHUB_MODEL_BASE_URL: "http://127.0.0.1:9/v1",
      HARNESSHUB_MODEL_API_KEY: "source-fixture-key-D4",
      HARNESSHUB_MODEL_CONTEXT_WINDOW: "131072",
    });
    hub = await startHub({
      dataDir: path.join(directory, "data"),
      cwd: directory,
      demo: false,
      port: 0,
      competition: true,
      defaultEngine: "opencode",
      competitionEngine: "opencode",
    });
    const engine = hub.app.engineProfile("opencode");
    assert.equal(engine.model, "GLM-V5_1-DX");
    assert.equal(engine.configuration?.adapter, "opencode");
    assert.deepEqual(engine.configuration?.provider, {
      protocol: "openai-completions",
      baseUrl: "http://127.0.0.1:9/v1",
      apiKey: { kind: "env", value: "HARNESSHUB_MODEL_API_KEY" },
      contextWindow: 131072,
      modelAlias: "harnesshub-model",
    });
    assert.ok(
      engine.command?.includes(
        path.join(
          bin,
          process.platform === "win32" ? "opencode.cmd" : "opencode",
        ),
      ),
    );
    const view = await call<HarnessModelView>(hub, "GET", "/v1/harness/model");
    assert.equal(view.value.source, "environment");
    assert.deepEqual(view.value.engines, [
      { engineId: "opencode", status: "applied" },
    ]);
    assert.equal(hub.app.defaultEngine(), "opencode");
  },
);

void test(
  "competition startup fails for an engine the unified model cannot drive and runtime info reports the mode",
  { timeout: 60000 },
  async (t) => {
    const directory = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "hh-unified-competition-")),
    );
    const hubs: Hub[] = [];
    t.after(async () => {
      for (const hub of hubs) await hub.server.close();
      await rm(directory, { recursive: true, force: true });
    });
    const configFile = path.join(directory, "engines.json");
    await writeFile(
      configFile,
      JSON.stringify({
        engines: [
          stub(),
          {
            id: "cursor",
            driver: "cli",
            command: [
              process.execPath,
              "-e",
              "process.stdin.pipe(process.stdout)",
            ],
          },
        ],
        model: firstModel,
      }),
    );
    const base = {
      cwd: directory,
      demo: false,
      port: 0,
      configFile,
      competition: true,
    };
    await assert.rejects(
      startHub({
        ...base,
        dataDir: path.join(directory, "blocked"),
        defaultEngine: "cursor",
        competitionEngine: "cursor",
      }),
      (error: unknown) =>
        error instanceof Error &&
        /cursor/.test(error.message) &&
        /统一模型网关/.test(error.message),
    );
    withEnvironment(t, { HARNESSHUB_FULL_ACCESS: "1" });
    const hub = await startHub({
      ...base,
      dataDir: path.join(directory, "ready"),
      defaultEngine: "stub",
      competitionEngine: "stub",
      consoleUrl: "http://127.0.0.1:3330/",
    });
    hubs.push(hub);
    assert.deepEqual((await call(hub, "GET", "/v1/runtime/info")).value, {
      competition: true,
      competitionEngine: "stub",
      fullAccess: true,
      consoleUrl: "http://127.0.0.1:3330/",
    });
  },
);
