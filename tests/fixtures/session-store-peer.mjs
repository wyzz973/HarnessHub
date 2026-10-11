import { SqliteSessionStore } from "../../dist/src/infrastructure/session/sqlite-store.js";
import { commandId, messageId, runId, sessionId, switchId } from "../../dist/src/contracts/session.js";

const root = process.argv[2], mode = process.argv[3] ?? "hold";
let store;
try {
  store = new SqliteSessionStore(root);
  if (mode === "unfinished") {
    const id = sessionId("session-peer");
    const created = store.create({ schemaVersion: 11, id, version: 0, lastSeq: 0, epoch: 1, status: "open",
      configuration: { workspace: root, manifestPath: null, manifestSha256: null, configHome: null, packageRoots: [], searchDirs: [], pathOnly: false },
      selection: { harnessId: "fixture", controlId: "fixture-acp" }, activeRunId: null, pendingSwitchId: null,
      runs: [], messages: [], switches: [], commands: [{ id: commandId("peer-create"), kind: "create", fingerprint: "a".repeat(64), resultId: id }] },
    [{ type: "session.created", data: {} }]);
    const active = runId("run-active"), queued = runId("run-queued"), pending = switchId("switch-pending");
    store.transact(id, created.session.version, current => ({
      next: { ...current, activeRunId: active, pendingSwitchId: pending,
        runs: [
          { id: active, commandId: commandId("peer-active"), input: "unfinished input", userMessageId: messageId("message-active-user"), assistantMessageId: messageId("message-active-assistant"), selection: current.selection, epoch: 1, status: "running", cancelRequested: false, contextThroughSeq: 1, sourceRunIds: [], backend: null, cleanup: null, error: null, stopRequested: false, awaitingSwitchId: null },
          { id: queued, commandId: commandId("peer-queued"), input: "not yet dispatched", userMessageId: messageId("message-queued-user"), assistantMessageId: messageId("message-queued-assistant"), selection: current.selection, epoch: 1, status: "queued", cancelRequested: false, contextThroughSeq: 0, sourceRunIds: [], backend: null, cleanup: null, error: null, stopRequested: false, awaitingSwitchId: null },
        ],
        messages: [
          { id: messageId("message-active-user"), runId: active, role: "user", text: "unfinished input", seq: 2, status: "running" },
          { id: messageId("message-queued-user"), runId: queued, role: "user", text: "not yet dispatched", seq: 3, status: "queued" },
        ],
        switches: [{ id: pending, commandId: commandId("peer-switch"), requested: { harnessId: "other" }, requestedSeq: 4, target: null, status: "requested", throughSeq: 1, sourceRunIds: [], error: null }],
        commands: [...current.commands,
          { id: commandId("peer-active"), kind: "send", fingerprint: "b".repeat(64), resultId: active },
          { id: commandId("peer-queued"), kind: "send", fingerprint: "c".repeat(64), resultId: queued },
          { id: commandId("peer-switch"), kind: "switch", fingerprint: "d".repeat(64), resultId: pending }],
      }, events: [{ type: "message.accepted", data: { runId: active } }, { type: "message.queued", data: { runId: queued } }, { type: "switch.requested", data: { switchId: pending } }],
    }));
  }
  process.send?.({ type: "ready", generation: store.ownerGeneration });
  const timer = setInterval(() => {}, 1000);
  process.once("SIGTERM", () => { clearInterval(timer); store.close(); process.exit(0); });
} catch (error) {
  process.send?.({ type: "rejected", code: error.code ?? "ERROR", message: error.message });
  process.exitCode = 2;
}
