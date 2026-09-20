import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startHub } from "../../src/main.js";
import { MODEL_NOT_CONFIGURED_MESSAGE } from "../../src/application/harness-model.js";
import type { HarnessModelView } from "../../src/domain/harness-model.js";
import {
  isTerminal,
  type RunRecord,
  type SessionRecord,
} from "../../src/domain/types.js";

type Hub = Awaited<ReturnType<typeof startHub>>;
const jsonHeader = { "content-type": "application/json" };

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
      : { headers: jsonHeader, body: JSON.stringify(body) }),
  });
  return { status: response.status, value: (await response.json()) as T };
}

/**
 * A portable bundle only ever uses the unified model, so a Run submitted before one is
 * configured is refused by the application before any Worker starts, on both the
 * management API and the Competition route. Configuring through the API lifts the
 * refusal for the Session that was already open.
 */
void test(
  "a Gateway that requires the unified model refuses Runs until one is configured",
  { timeout: 60000 },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hh-require-model-"));
    const dataDir = path.join(root, "data");
    let hub: Hub | undefined;
    t.after(async () => {
      await hub?.server.close();
      await rm(root, { recursive: true, force: true });
    });
    hub = await startHub({
      dataDir,
      demo: true,
      competition: true,
      competitionEngine: "fake",
      defaultEngine: "fake",
      requireHarnessModel: true,
      harnessModelFile: path.join(root, "harness-model.json"),
      cwd: root,
      port: 0,
    });

    const unconfigured = await call<HarnessModelView>(
      hub,
      "GET",
      "/v1/harness/model",
    );
    assert.equal(unconfigured.value.configured, false);

    // Management API: refused with the public code, and no Run is recorded.
    const session = await call<SessionRecord>(hub, "POST", "/v1/sessions", {
      engineId: "fake",
    });
    assert.equal(session.status, 201, JSON.stringify(session.value));
    const refused = await call<{ error: { code: string; message: string } }>(
      hub,
      "POST",
      `/v1/sessions/${session.value.id}/runs`,
      { text: "before the model exists", timeoutMs: 15000 },
    );
    assert.equal(refused.status, 503, JSON.stringify(refused.value));
    assert.equal(refused.value.error.code, "MODEL_NOT_CONFIGURED");
    assert.equal(refused.value.error.message, MODEL_NOT_CONFIGURED_MESSAGE);
    assert.deepEqual(
      (await call<{ runs: RunRecord[] }>(hub, "GET", "/v1/runs")).value.runs,
      [],
      "a refused Run is never recorded",
    );
    // No Worker started: the Session has no backend state directory.
    const backends = await readdir(path.join(dataDir, "backends")).catch(
      () => [] as string[],
    );
    assert.deepEqual(backends, []);

    // Competition route: the same refusal in the specification's error shape.
    const directory = path.join(root, "task");
    const competitionSession = await call<{ id: string }>(
      hub,
      "POST",
      "/session",
      { title: "guard", directory },
    );
    assert.equal(competitionSession.status, 200);
    const prompted = await call<{ code: string; message: string }>(
      hub,
      "POST",
      `/session/${competitionSession.value.id}/prompt_async`,
      {
        parts: [{ type: "text", text: "before the model exists" }],
        // Accepted for shape only; the Gateway always uses the unified model.
        model: { providerID: "harnesshub", modelID: "harnesshub-model" },
      },
    );
    assert.equal(prompted.status, 503, JSON.stringify(prompted.value));
    assert.equal(prompted.value.code, "SERVICE_UNAVAILABLE");
    assert.equal(prompted.value.message, MODEL_NOT_CONFIGURED_MESSAGE);

    // Configure through the API, exactly as the console's onboarding card does.
    process.env.HH_REQUIRE_MODEL_KEY = "require-model-fixture-key";
    t.after(() => {
      delete process.env.HH_REQUIRE_MODEL_KEY;
    });
    const configured = await call<HarnessModelView>(
      hub,
      "PUT",
      "/v1/harness/model",
      {
        model: "GLM-V5_1-DX",
        provider: {
          protocol: "openai-completions",
          baseUrl: "http://127.0.0.1:9/v1",
          apiKey: { kind: "env", value: "HH_REQUIRE_MODEL_KEY" },
          contextWindow: 131072,
        },
      },
    );
    assert.equal(configured.status, 200, JSON.stringify(configured.value));
    assert.equal(configured.value.configured, true);

    // The Session opened before configuration now runs; the fake engine calls no model.
    const accepted = await call<RunRecord>(
      hub,
      "POST",
      `/v1/sessions/${session.value.id}/runs`,
      { text: "after the model exists", timeoutMs: 15000 },
    );
    assert.equal(accepted.status, 202, JSON.stringify(accepted.value));
    const deadline = Date.now() + 20000;
    let run = accepted.value;
    while (!isTerminal(run.status)) {
      if (Date.now() > deadline)
        throw new Error(`Run did not finish: ${JSON.stringify(run)}`);
      run = (await call<RunRecord>(hub, "GET", `/v1/runs/${run.id}`)).value;
    }
    assert.equal(run.status, "completed", JSON.stringify(run.error));
  },
);
