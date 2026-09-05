import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import {
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk";
import { startHub } from "../../src/main.js";
import type {
  ObservabilityOverview,
  RunObservations,
} from "../../src/domain/observability.js";
import type { RunRecord, SessionRecord } from "../../src/domain/types.js";

if (process.argv.includes("--observation-peer")) {
  let turns = 0;
  new AgentSideConnection(
    (connection) => ({
      initialize: async () => ({
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: {},
        authMethods: [],
      }),
      newSession: async () => ({
        sessionId: "observation-session",
        models: {
          currentModelId: "observed-model",
          availableModels: [{ modelId: "observed-model", name: "Observed" }],
        },
      }),
      authenticate: async () => ({}),
      cancel: async () => {},
      prompt: async (request) => {
        turns++;
        await connection.sessionUpdate({
          sessionId: request.sessionId,
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "thinking" },
          },
        });
        await connection.sessionUpdate({
          sessionId: request.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `result-${turns}` },
          },
        });
        await connection.sessionUpdate({
          sessionId: request.sessionId,
          update: {
            sessionUpdate: "usage_update",
            used: 120,
            size: 10000,
            cost: { amount: turns * 0.02, currency: "USD" },
            _meta: {
              usage: {
                inputTokens: 100,
                outputTokens: 20,
                totalTokens: 120,
                thoughtTokens: 5,
                cachedReadTokens: 30,
              },
            },
          },
        });
        return { stopReason: "end_turn" };
      },
    }),
    ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
  );
} else {
  void test(
    "formal Gateway/ACP Worker observations survive restart, avoid duplicate session totals, and expose sample coverage",
    { timeout: 20000 },
    async (t) => {
      const directory = await mkdtemp(
        path.join(os.tmpdir(), "hub-observe-http-"),
      );
      const configFile = path.join(directory, "engines.json");
      await writeFile(
        configFile,
        JSON.stringify({
          engines: [
            {
              id: "observed",
              driver: "acp",
              command: [
                process.execPath,
                fileURLToPath(import.meta.url),
                "--observation-peer",
              ],
              maxConcurrency: 1,
            },
          ],
          workspaces: [{ id: "test", path: directory }],
        }),
      );
      const options = {
        dataDir: path.join(directory, "data"),
        configFile,
        demo: false,
        cwd: directory,
        port: 0,
      };
      let hub = await startHub(options);
      t.after(async () => {
        await hub.server.close();
        await rm(directory, { recursive: true, force: true });
      });
      async function get<T>(url: string): Promise<T> {
        const response = await fetch(`${hub.url}${url}`);
        assert.equal(response.status, 200);
        return (await response.json()) as T;
      }
      async function post<T>(url: string, body: unknown): Promise<T> {
        const response = await fetch(`${hub.url}${url}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        assert.ok(response.ok);
        return (await response.json()) as T;
      }
      const session = await post<SessionRecord>("/v1/sessions", {});
      const collected: RunObservations[] = [];
      for (let i = 0; i < 2; i++) {
        const run = await post<RunRecord>(`/v1/sessions/${session.id}/runs`, {
          text: "Observe this turn",
          timeoutMs: 8000,
        });
        const deadline = Date.now() + 9000;
        for (;;) {
          const state = await get<RunRecord>(`/v1/runs/${run.id}`);
          if (state.status === "completed") break;
          assert.ok(
            Date.now() < deadline,
            `run did not complete: ${state.status}`,
          );
          await delay(10);
        }
        const observation = await get<RunObservations>(
          `/v1/runs/${run.id}/observations`,
        );
        assert.equal(observation.tokens.input, 100);
        assert.equal(observation.tokens.output, 20);
        assert.equal(observation.tokens.total, 120);
        assert.equal(observation.tokens.reasoning, 5);
        assert.equal(observation.model.actual, "observed-model");
        assert.equal(observation.cost.kind, "reported");
        assert.ok(Math.abs(observation.cost.amount! - 0.02) < 1e-10);
        assert.equal(observation.timings.cleanupMs, 0);
        assert.equal(observation.coverage.eventsComplete, true);
        assert.equal(observation.coverage.installation, true);
        assert.equal(observation.counts.reasoningCharacters, 8);
        collected.push(observation);
      }
      const overview = await get<ObservabilityOverview>(
        "/v1/observability?limit=1",
      );
      assert.equal(overview.scope.totalRuns, 2);
      assert.equal(overview.scope.sampledRuns, 1);
      assert.equal(overview.summary.knownTotalTokens, 120);
      assert.equal(overview.summary.usageCoverage, 1);
      assert.equal(
        (await fetch(`${hub.url}/v1/observability?limit=201`)).status,
        400,
      );
      const openapi = await get<{ paths: Record<string, unknown> }>(
        "/openapi.json",
      );
      assert.ok(openapi.paths["/v1/runs/{id}/observations"]);
      await hub.server.close();
      hub = await startHub(options);
      for (const item of collected)
        assert.deepEqual(
          await get<RunObservations>(`/v1/runs/${item.runId}/observations`),
          item,
        );
      const restored = await get<ObservabilityOverview>("/v1/observability");
      assert.equal(restored.summary.knownTotalTokens, 240);
      assert.equal(restored.summary.completedRuns, 2);
    },
  );
}
