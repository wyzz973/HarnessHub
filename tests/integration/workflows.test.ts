import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk";
import { startHub } from "../../src/main.js";
import {
  isWorkflowTerminal,
  type Workflow,
  type WorkflowPlan,
} from "../../src/domain/workflows.js";
import { isTerminal } from "../../src/domain/types.js";
import { selectWorkflowEngine } from "../../src/application/workflows.js";

if (process.argv.includes("--workflow-acp-peer")) {
  let finishWaiting: (() => void) | undefined;
  new AgentSideConnection(
    (connection) => ({
      initialize: async () => ({
        protocolVersion: PROTOCOL_VERSION,
        authMethods: [],
        agentCapabilities: {},
      }),
      authenticate: async () => ({}),
      newSession: async () => ({ sessionId: randomUUID() }),
      cancel: async () => {
        finishWaiting?.();
      },
      prompt: async (request) => {
        const prompt = request.prompt
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("\n");
        let output: string;
        if (prompt.startsWith("You are the planning stage")) {
          const plan: WorkflowPlan = {
            title: "Fixture workflow",
            steps: [
              {
                id: "first",
                title: "Prepare",
                instructions: prompt.includes("wait-step")
                  ? "Wait until cancelled"
                  : prompt.includes("fail-step")
                    ? "Fail deliberately"
                    : "Produce first evidence",
                dependsOn: [],
                outputs: [],
              },
              {
                id: "second",
                title: "Summarize",
                instructions: "Use first evidence",
                dependsOn: ["first"],
                outputs: [],
              },
            ],
          };
          if (prompt.includes("cycle-plan"))
            plan.steps[0]!.dependsOn = ["second"];
          if (prompt.includes("escape-plan"))
            plan.steps[0]!.outputs = [
              { path: "../escape.txt", name: "escape.txt" },
            ];
          if (prompt.includes("conflicting-outputs")) {
            plan.steps[1]!.dependsOn = [];
            for (const step of plan.steps)
              step.outputs = [{ path: "same.txt", name: "same.txt" }];
          }
          if (prompt.includes("too-many-steps"))
            plan.steps = Array.from({ length: 9 }, (_, index) => ({
              id: `step${index}`,
              title: "Step",
              instructions: "Text",
              dependsOn: [],
              outputs: [],
            }));
          if (prompt.includes("tool-plan"))
            await connection.sessionUpdate({
              sessionId: request.sessionId,
              update: {
                sessionUpdate: "tool_call",
                toolCallId: "unexpected-tool",
                title: "Unexpected planner tool",
                kind: "read",
                status: "completed",
              },
            });
          output = prompt.includes("invalid-json")
            ? "No JSON was returned"
            : JSON.stringify(plan);
        } else {
          if (prompt.includes('"instructions":"Fail deliberately"'))
            throw new Error("Deterministic fixture step failure");
          if (prompt.includes('"instructions":"Wait until cancelled"')) {
            await new Promise<void>((resolve) => {
              finishWaiting = resolve;
            });
            return { stopReason: "cancelled" };
          }
          output =
            prompt.includes('"id":"first"') && !prompt.includes('"id":"second"')
              ? "first evidence"
              : prompt.includes('"output":"first evidence"')
                ? "dependency received"
                : "missing dependency";
        }
        await connection.sessionUpdate({
          sessionId: request.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: output },
          },
        });
        return { stopReason: "end_turn" };
      },
    }),
    ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
  );
} else {
  const profile = (id: string, enabled = true) => ({
    id,
    driver: "acp",
    enabled,
    command: [
      process.execPath,
      fileURLToPath(import.meta.url),
      "--workflow-acp-peer",
    ],
    maxConcurrency: 2,
  });
  async function request<T>(
    url: string,
    route: string,
    method = "GET",
    body?: unknown,
    key?: string,
  ) {
    const response = await fetch(`${url}${route}`, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(key ? { "idempotency-key": key } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, value: (await response.json()) as T };
  }
  async function until<T>(
    read: () => Promise<T>,
    ready: (value: T) => boolean,
  ): Promise<T> {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const value = await read();
      if (ready(value)) return value;
      if (Date.now() >= deadline)
        throw new Error(`Workflow wait expired: ${JSON.stringify(value)}`);
      await delay(20);
    }
  }
  const poll = (
    url: string,
    workflow: Workflow,
    ready: (value: Workflow) => boolean,
  ) =>
    until(
      async () =>
        (await request<Workflow>(url, `/v1/workflows/${workflow.id}`)).value,
      ready,
    );
  async function setup() {
    const directory = await mkdtemp(join(tmpdir(), "hh-workflows-"));
    const configFile = join(directory, "engines.json");
    await writeFile(
      configFile,
      JSON.stringify({
        engines: [profile("planner"), profile("worker")],
        defaultEngine: "planner",
      }),
    );
    const options = {
      dataDir: join(directory, "data"),
      cwd: directory,
      configFile,
      demo: false,
      port: 0,
    };
    const hub = await startHub(options);
    return { directory, hub, options };
  }
  void test(
    "workflow planning, approval, routing and dependent Runs use the formal Gateway and persist idempotently",
    { timeout: 30_000 },
    async (t) => {
      const fixture = await setup();
      let hub = fixture.hub;
      t.after(async () => {
        await hub.server.close();
        await rm(fixture.directory, { recursive: true, force: true });
      });
      const input = { goal: "two useful text steps", engineId: "auto" };
      const created = await request<Workflow>(
        hub.url,
        "/v1/workflows",
        "POST",
        input,
        "workflow-one",
      );
      assert.equal(created.status, 202);
      const repeated = await request<Workflow>(
        hub.url,
        "/v1/workflows",
        "POST",
        input,
        "workflow-one",
      );
      assert.equal(repeated.value.id, created.value.id);
      assert.equal(
        (
          await request(
            hub.url,
            "/v1/workflows",
            "POST",
            { goal: "changed" },
            "workflow-one",
          )
        ).status,
        409,
      );
      const draft = await poll(
        hub.url,
        created.value,
        (value) => value.status === "draft" || isWorkflowTerminal(value.status),
      );
      assert.equal(draft.status, "draft", JSON.stringify(draft));
      assert.equal(draft.steps.length, 2);
      assert.ok(draft.planningRunId);
      assert.ok(draft.steps.every((step) => step.runId === undefined));
      assert.equal(hub.app.runs().length, 1);
      assert.equal(draft.steps[0]?.selection.mode, "auto");
      assert.equal(draft.steps[0]?.selection.engineId, "planner");
      const approvals = await Promise.all([
        request<Workflow>(hub.url, `/v1/workflows/${draft.id}/approve`, "POST"),
        request<Workflow>(hub.url, `/v1/workflows/${draft.id}/approve`, "POST"),
      ]);
      assert.ok(approvals.every((result) => result.status === 202));
      assert.deepEqual(
        approvals[0]?.value.steps.map((step) => step.sessionId),
        approvals[1]?.value.steps.map((step) => step.sessionId),
      );
      // Hot replacement after approval must not migrate either bound Session.
      await request(hub.url, "/v1/engines/planner", "PUT", {
        ...profile("planner"),
        maxConcurrency: 3,
      });
      const completed = await poll(hub.url, draft, (value) =>
        isWorkflowTerminal(value.status),
      );
      assert.equal(completed.status, "completed", JSON.stringify(completed));
      assert.deepEqual(
        completed.steps.map((step) => step.output),
        ["first evidence", "dependency received"],
      );
      assert.equal(hub.app.runs().length, 3);
      for (const step of completed.steps)
        assert.equal(
          hub.app.getRun(step.runId!).configSnapshot?.profileRevision,
          draft.steps[0]?.selection.profileRevision,
        );
      const firstRun = hub.app.getRun(completed.steps[0]!.runId!);
      const secondRun = hub.app.getRun(completed.steps[1]!.runId!);
      assert.ok(
        (firstRun.finishedAt ?? Infinity) <= (secondRun.startedAt ?? 0),
      );
      const api = await request<{ paths: Record<string, unknown> }>(
        hub.url,
        "/openapi.json",
      );
      assert.ok(api.value.paths["/v1/workflows/{id}/approve"]);
      await hub.server.close();
      hub = await startHub(fixture.options);
      const durable = await request<Workflow>(
        hub.url,
        `/v1/workflows/${draft.id}`,
      );
      assert.deepEqual(
        durable.value.steps.map((step) => step.runId),
        completed.steps.map((step) => step.runId),
      );
      assert.equal(durable.value.status, "completed");
      assert.equal(
        (
          await request<Workflow>(
            hub.url,
            "/v1/workflows",
            "POST",
            input,
            "workflow-one",
          )
        ).value.id,
        draft.id,
      );
    },
  );
  void test(
    "invalid/cyclic/escaping/oversized/tool-using plans fail before approval or step execution",
    { timeout: 30_000 },
    async (t) => {
      const { hub, directory } = await setup();
      t.after(async () => {
        await hub.server.close();
        await rm(directory, { recursive: true, force: true });
      });
      for (const goal of [
        "cycle-plan",
        "escape-plan",
        "conflicting-outputs",
        "invalid-json",
        "too-many-steps",
        "tool-plan",
      ]) {
        const created = await request<Workflow>(
          hub.url,
          "/v1/workflows",
          "POST",
          { goal },
        );
        const failed = await poll(hub.url, created.value, (value) =>
          isWorkflowTerminal(value.status),
        );
        assert.equal(failed.status, "failed");
        assert.equal(failed.steps.length, 0);
        assert.ok(
          [
            "INVALID_WORKFLOW_PLAN",
            "INVALID_ARTIFACT_PATH",
            "WORKFLOW_PLANNER_USED_TOOLS",
          ].includes(failed.error?.code ?? ""),
        );
        assert.equal(
          (await request(hub.url, `/v1/workflows/${failed.id}/approve`, "POST"))
            .status,
          409,
        );
      }
      assert.equal(hub.app.runs().length, 6);
    },
  );
  void test(
    "failure blocks dependencies and cancellation converges the owned Run without rerouting",
    { timeout: 30_000 },
    async (t) => {
      const { hub, directory } = await setup();
      t.after(async () => {
        await hub.server.close();
        await rm(directory, { recursive: true, force: true });
      });
      for (const goal of ["fail-step", "wait-step"]) {
        const created = (
          await request<Workflow>(hub.url, "/v1/workflows", "POST", {
            goal,
            engineId: "worker",
          })
        ).value;
        const draft = await poll(
          hub.url,
          created,
          (value) => value.status === "draft",
        );
        await request(hub.url, `/v1/workflows/${draft.id}/approve`, "POST");
        if (goal === "wait-step") {
          await poll(
            hub.url,
            draft,
            (value) => value.steps[0]?.status === "running",
          );
          const cancelled = await request<Workflow>(
            hub.url,
            `/v1/workflows/${draft.id}/cancel`,
            "POST",
          );
          assert.ok(
            ["cancelling", "cancelled"].includes(cancelled.value.status),
          );
        }
        const terminal = await poll(hub.url, draft, (value) =>
          isWorkflowTerminal(value.status),
        );
        assert.equal(
          terminal.status,
          goal === "fail-step" ? "failed" : "cancelled",
        );
        assert.equal(terminal.steps[1]?.runId, undefined);
        assert.equal(
          terminal.steps[1]?.status,
          goal === "fail-step" ? "blocked" : "cancelled",
        );
        assert.ok(isTerminal(hub.app.getRun(terminal.steps[0]!.runId!).status));
        const repeated = await request<Workflow>(
          hub.url,
          `/v1/workflows/${draft.id}/cancel`,
          "POST",
        );
        assert.equal(repeated.value.status, terminal.status);
      }
      assert.equal(hub.app.runs().length, 4);
    },
  );
  void test(
    "approval rejects changed revisions; auto selection records capability and load exclusions",
    { timeout: 25_000 },
    async (t) => {
      const { hub, directory } = await setup();
      t.after(async () => {
        await hub.server.close();
        await rm(directory, { recursive: true, force: true });
      });
      const created = (
        await request<Workflow>(hub.url, "/v1/workflows", "POST", {
          goal: "plan pinned draft",
          engineId: "worker",
        })
      ).value;
      const draft = await poll(
        hub.url,
        created,
        (value) => value.status === "draft",
      );
      await request(hub.url, "/v1/engines/worker", "PUT", {
        ...profile("worker"),
        maxConcurrency: 3,
      });
      const rejected = await request<{ error: { code: string } }>(
        hub.url,
        `/v1/workflows/${draft.id}/approve`,
        "POST",
      );
      assert.equal(rejected.status, 409);
      assert.equal(rejected.value.error.code, "WORKFLOW_ENGINE_CHANGED");
      assert.equal(hub.app.runs().length, 1);
      await request(hub.url, "/v1/engines", "POST", {
        id: "command",
        driver: "cli",
        command: [process.execPath, "-e", "process.stdin.pipe(process.stdout)"],
      });
      await request(hub.url, "/v1/engines", "POST", profile("disabled", false));
      const route = selectWorkflowEngine(hub.app);
      assert.equal(
        route.candidates.find((candidate) => candidate.engineId === "command")
          ?.eligible,
        false,
      );
      assert.equal(
        route.candidates.find((candidate) => candidate.engineId === "disabled")
          ?.eligible,
        false,
      );
      assert.throws(
        () =>
          selectWorkflowEngine(hub.app, { requiredCapabilities: ["images"] }),
        { code: "NO_ELIGIBLE_ENGINE" },
      );
      assert.equal(
        selectWorkflowEngine(hub.app, { engineId: "command" }).mode,
        "explicit",
      );
    },
  );
  void test(
    "shutdown and restart never resubmit active steps; completed Run evidence reconciles stale workflow projection",
    { timeout: 30_000 },
    async (t) => {
      const fixture = await setup();
      let hub = fixture.hub;
      t.after(async () => {
        await hub.server.close();
        await rm(fixture.directory, { recursive: true, force: true });
      });
      const created = (
        await request<Workflow>(hub.url, "/v1/workflows", "POST", {
          goal: "wait-step",
        })
      ).value;
      const draft = await poll(
        hub.url,
        created,
        (value) => value.status === "draft",
      );
      await request(hub.url, `/v1/workflows/${draft.id}/approve`, "POST");
      const active = await poll(
        hub.url,
        draft,
        (value) => value.steps[0]?.status === "running",
      );
      await hub.server.close();
      hub = await startHub(fixture.options);
      const interrupted = (
        await request<Workflow>(hub.url, `/v1/workflows/${draft.id}`)
      ).value;
      assert.equal(interrupted.status, "interrupted");
      assert.equal(interrupted.steps[0]?.runId, active.steps[0]?.runId);
      assert.equal(interrupted.steps[1]?.runId, undefined);
      assert.equal(hub.app.runs().length, 2);
      const next = (
        await request<Workflow>(hub.url, "/v1/workflows", "POST", {
          goal: "normal",
        })
      ).value;
      const nextDraft = await poll(
        hub.url,
        next,
        (value) => value.status === "draft",
      );
      await request(hub.url, `/v1/workflows/${nextDraft.id}/approve`, "POST");
      const done = await poll(hub.url, next, (value) =>
        isWorkflowTerminal(value.status),
      );
      assert.equal(done.status, "completed");
      await hub.server.close();
      const db = new DatabaseSync(
        join(fixture.options.dataDir, "harnesshub.sqlite"),
      );
      const stale = {
        ...done,
        status: "running",
        steps: done.steps.map((step, index) => ({
          ...step,
          status: index === 1 ? "running" : step.status,
        })),
      };
      db.prepare("UPDATE workflows SET record = ? WHERE id = ?").run(
        JSON.stringify(stale),
        done.id,
      );
      db.close();
      hub = await startHub(fixture.options);
      const aligned = (
        await request<Workflow>(hub.url, `/v1/workflows/${done.id}`)
      ).value;
      assert.equal(aligned.status, "completed");
      assert.deepEqual(
        aligned.steps.map((step) => step.runId),
        done.steps.map((step) => step.runId),
      );
      assert.equal(hub.app.runs().length, 5);
    },
  );
}
