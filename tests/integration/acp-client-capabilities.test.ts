import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAcpRuntime,
  createAgentRegistry,
  createFileSessionStore,
  type AcpPermissionDecision,
} from "acpx/runtime";
import { ProcessWorkerHost } from "../../src/process/worker-host.js";
import { probeConfiguration } from "../../src/drivers/configuration/probe.js";
import { normalizeEngine } from "../../src/engine/registry.js";
import type { RunId, SessionId } from "../../src/domain/types.js";
import type { WorkerMessage } from "../../src/domain/ports.js";

const peer = fileURLToPath(
  new URL("../fixtures/acp-capabilities-peer.js", import.meta.url),
);
const disabled = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
};
async function capabilities(root: string) {
  return (await readFile(join(root, "initialize.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map(
      (line) =>
        JSON.parse(line) as { pid: number; capabilities: typeof disabled },
    );
}

void test(
  "Driver and connection probe declare disabled filesystem/terminal; the real ACP peer receives the second same-kind option",
  { timeout: 20_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "hh-acp-capabilities-"));
    const host = new ProcessWorkerHost();
    t.after(async () => {
      await host.close();
      await rm(root, { recursive: true, force: true });
    });
    const command = [process.execPath, peer, root];
    const probe = await probeConfiguration(
      { command, env: {}, instructionPrefix: "", mcpServers: [] },
      "acp",
      root,
      new AbortController().signal,
    );
    assert.equal(probe.status, "passed");
    const ready =
      Promise.withResolvers<Extract<WorkerMessage, { type: "permission" }>>();
    const sessionId = "capability-session" as SessionId;
    const run = await host.start(
      {
        sessionId,
        runId: "capability-run" as RunId,
        generation: 1,
        cwd: root,
        stateDir: join(root, "backend"),
        profile: normalizeEngine({ id: "peer", driver: "acp", command }),
        input: { text: "choose-second", timeoutMs: 10_000 },
      },
      async (message) => {
        if (message.type === "permission") ready.resolve(message);
      },
    );
    const permission = await Promise.race([
      ready.promise,
      run.result.then(() => {
        throw new Error("Peer finished without a permission request");
      }),
    ]);
    assert.deepEqual(permission.permission.options, [
      { id: "first", label: "First once option", kind: "allow_once" },
      { id: "second", label: "Second once option", kind: "allow_once" },
      { id: "reject", label: "Reject once", kind: "reject_once" },
    ]);
    await run.respondPermission(permission.permission.id, "second");
    assert.deepEqual(JSON.parse((await run.result).output!), {
      outcome: "selected",
      optionId: "second",
    });
    assert.equal(await host.closeSession(sessionId), "confirmed");
    const records = await capabilities(root);
    assert.equal(records.length, 2);
    for (const record of records) {
      assert.deepEqual(
        { fs: record.capabilities.fs, terminal: record.capabilities.terminal },
        disabled,
      );
      assert.throws(() => process.kill(record.pid, 0), { code: "ESRCH" });
    }
  },
);

for (const scenario of [
  "second",
  "unknown",
  "duplicate",
  "legacy",
  "abort",
] as const) {
  void test(
    `patched acpx public API preserves exact permission semantics: ${scenario}`,
    { timeout: 15_000 },
    async (t) => {
      const root = await mkdtemp(join(tmpdir(), "hh-acpx-exact-"));
      const controller = new AbortController();
      const runtime = createAcpRuntime({
        cwd: root,
        sessionStore: createFileSessionStore({
          stateDir: join(root, "backend"),
        }),
        agentRegistry: createAgentRegistry({
          overrides: { peer: [process.execPath, peer, root] },
        }),
        permissionMode: "deny-all",
        nonInteractivePermissions: "deny",
        fs: false,
        terminal: false,
        probeAgent: "peer",
        onPermissionRequest: async (
          _request,
          context,
        ): Promise<AcpPermissionDecision> => {
          if (scenario === "abort") {
            controller.abort();
            if (!context.signal.aborted)
              await new Promise<void>((resolve) =>
                context.signal.addEventListener("abort", () => resolve(), {
                  once: true,
                }),
              );
          }
          if (scenario === "legacy") return { outcome: "allow_once" };
          return {
            outcome: "selected",
            optionId:
              scenario === "duplicate"
                ? "first"
                : scenario === "unknown"
                  ? "unadvertised"
                  : "second",
          };
        },
      });
      if (scenario === "second") {
        assert.equal((await runtime.doctor()).ok, true);
        const [record] = await capabilities(root);
        assert.deepEqual(
          {
            fs: record!.capabilities.fs,
            terminal: record!.capabilities.terminal,
          },
          disabled,
        );
        assert.throws(() => process.kill(record!.pid, 0), { code: "ESRCH" });
      }
      const handle = await runtime.ensureSession({
        sessionKey: "exact-session",
        agent: "peer",
        mode: "persistent",
      });
      t.after(async () => {
        await runtime.close({ handle, reason: "fixture_done" });
        await rm(root, { recursive: true, force: true });
      });
      const turn = runtime.startTurn({
        handle,
        text: scenario === "duplicate" ? "duplicate-options" : "choose",
        mode: "prompt",
        requestId: "exact-request",
        signal: controller.signal,
      });
      const output: string[] = [];
      for await (const event of turn.events)
        if (event.type === "text_delta") output.push(event.text);
      const result = await turn.result;
      // The peer can end its prompt after a cancelled permission; assert the
      // actual wire decision rather than assuming prompt/cancel race ordering.
      if (scenario !== "abort") assert.equal(result.status, "completed");
      assert.deepEqual(
        JSON.parse(output.join("")),
        scenario === "unknown" ||
          scenario === "duplicate" ||
          scenario === "abort"
          ? { outcome: "cancelled" }
          : {
              outcome: "selected",
              optionId: scenario === "legacy" ? "first" : "second",
            },
      );
    },
  );
}
