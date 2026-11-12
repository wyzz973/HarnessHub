import { SqliteConversationStore } from "../../dist/src/infrastructure/session/conversation-store.js";
import { Scenario, newConversation } from "../../dist/tests/fixtures/store-helpers.js";
import { commandId, switchId } from "../../dist/src/contracts/session.js";

// A process that opens the store of conversations on the data root it is given, for the tests that need another owner: one that holds the lock, one that is killed with work
// not finished, one that starts (and may upgrade) under a clock the parent stops.
//
//   node conversation-store-peer.mjs <root> hold         open, say `ready`, hold the lock until SIGTERM
//   node conversation-store-peer.mjs <root> unfinished   open, leave a conversation with an active Turn (with items), a queued input and a pending switch, say `ready`
//   node conversation-store-peer.mjs <root> open [--pause <ms>] [--kill-at <step>]
//                                                        open (upgrading what is there), print one line of JSON {generation, seconds, maxRssKb} and close; with --pause every
//                                                        step of the migration waits that long, with --kill-at the process kills itself at that step
//
// A message `{ type: "ready", generation }` or `{ type: "rejected", code }` goes to the parent over the IPC channel.
const [root, mode = "hold", ...rest] = process.argv.slice(2);
const option = name => { const at = rest.indexOf(name); return at < 0 ? undefined : Number(rest[at + 1]); };
const pause = option("--pause"), killAt = option("--kill-at");
const sleep = new Int32Array(new SharedArrayBuffer(4));
let steps = 0;
let store;
try {
  const started = process.hrtime.bigint();
  store = new SqliteConversationStore(root, mode === "open" ? { migrationStep: () => {
    steps++;
    if (pause !== undefined && pause > 0) Atomics.wait(sleep, 0, 0, pause);
    if (killAt !== undefined && steps === killAt) process.kill(process.pid, "SIGKILL");
  } } : {});
  if (mode === "open") {
    const seconds = Number(process.hrtime.bigint() - started) / 1e9;
    process.stdout.write(JSON.stringify({ generation: store.ownerGeneration, seconds, steps, maxRssKb: process.resourceUsage().maxRSS }) + "\n");
    store.close();
  } else {
    if (mode === "unfinished") {
      const made = newConversation(root, "peer");
      store.create(made, [{ type: "session.created", data: {} }]);
      const turn = new Scenario(store, made.id, "run-peer");
      // The active Turn: a reply being said, a call running and an approval waiting.
      turn.accept("unfinished input");
      turn.start(0);
      turn.say(0, "half an ans");
      turn.tool(0, "t1", "running");
      const state = turn.state;
      const waiting = { runId: "run-peer-0", seq: 4, itemId: "permission:p1", type: "approval", status: "waiting", startedAt: null, endedAt: null, parentId: null, createdSeq: null, textBytes: 0, textChunks: 0, text: [],
        fields: { type: "approval", subject: "command", title: "Run it?", options: [{ id: "once", role: "allow_once", label: "Allow" }] } };
      store.transact(made.id, state.version, current => ({ next: { ...current, runs: current.runs.map(entry => entry.ordinal === 0 ? { ...entry, items: [...entry.items, waiting] } : entry) }, events: [{ type: "run.permission_requested", data: { runId: "run-peer-0" } }] }));
      turn.accept("not yet dispatched");
      const pending = switchId("switch-peer");
      store.transact(made.id, turn.state.version, current => ({ next: { ...current, pendingSwitchId: pending,
        switches: [{ id: pending, commandId: commandId("command-peer-switch"), requested: { harnessId: "other" }, requestedSeq: current.lastSeq + 1, target: null, status: "requested", throughSeq: current.lastSeq, sourceRunIds: [], error: null }],
        commands: [...current.commands, { id: commandId("command-peer-switch"), kind: "switch", fingerprint: "d".repeat(64), resultId: pending }] }, events: [{ type: "switch.requested", data: { switchId: pending } }] }));
    }
    process.send?.({ type: "ready", generation: store.ownerGeneration });
    const timer = setInterval(() => {}, 1000);
    process.once("SIGTERM", () => { clearInterval(timer); store.close(); process.exit(0); });
  }
} catch (error) {
  process.send?.({ type: "rejected", code: error.code ?? "ERROR", message: error.message });
  process.stdout.write(JSON.stringify({ error: { code: error?.code ?? null, message: String(error?.message ?? error) } }) + "\n");
  process.exitCode = 2;
}
