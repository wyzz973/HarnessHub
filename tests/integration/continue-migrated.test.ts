import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import test from "node:test";
import { nativeConversationId, type CleanupEvidence, type HarnessControl } from "../../src/contracts/control.js";
import { sessionId, SessionError, type HarnessSelection, type PreparedSessionBinding, type SelectionRequest, type SessionBindingFactory, type SessionConfiguration, type SessionId } from "../../src/contracts/session.js";
import { SessionRuntime } from "../../src/contexts/session/application/runtime.js";
import { verify } from "../../src/contexts/session/domain/conversation-verify.js";
import { V13_FIXTURES, loadV13Fixture, writeV13Root } from "../fixtures/storage/v13/database.js";
import { appStore } from "../fixtures/runtime-store.js";
import { temporary } from "../fixtures/store-helpers.js";

// What the upgrade is for: the conversations a v13 Hub left are continued by this one. Each frozen v13 fixture is written as a data root, the store converts it (and recovers what
// its owner left unfinished), and the Runtime sends a new input into every conversation that is open: the Harness is a fake that resumes the native session the conversation holds
// and answers with a tool call and a reply. The new Turn must complete and leave a conversation the whole-conversation checker has nothing to say about; the Turns before it must
// be the Turns they were, to the byte of the old shape; a conversation a crash left blocked is refused the way it always was, and one blocked with its cleanup confirmed is taken
// over by a recovery switch and continues.

const clean: CleanupEvidence = { closed: true, exitCode: 0, signal: null, protocolFailure: null };
const stamp = new Date("2026-11-13T00:00:00.000Z");

/** A Harness that resumes the native session the conversation holds (or opens one of its own) and answers at once. */
function resumingHarness(sessionOf: (id: SessionId) => readonly { readonly harnessId: string; readonly controlId: string; readonly checkpoint: string; readonly status: string }[]): SessionBindingFactory {
  let opened = 0;
  return {
    async validate(request: SelectionRequest): Promise<HarnessSelection> { return { harnessId: request.harnessId, controlId: request.controlId ?? request.harnessId + "-acp" }; },
    async prepare(selected: HarnessSelection, configuration: SessionConfiguration, session: SessionId): Promise<PreparedSessionBinding> {
      const held = sessionOf(session).find(binding => binding.harnessId === selected.harnessId && binding.controlId === selected.controlId && binding.status !== "archived");
      let native: string | null = held?.checkpoint ?? null;
      const control: HarnessControl = {
        initialize: async () => ({ protocol: "acp-v1", protocolVersion: 1, agentName: "continued", agentVersion: "1", authenticationMethods: [], capabilities: {} }),
        open: async (_directory, _model, _options, checkpoint) => { native = checkpoint ?? "continued-" + session + "-" + ++opened; return nativeConversationId(native); },
        checkpoint: async () => native,
        startText: async (_id, _text, output) => {
          output({ type: "tool", id: "after-upgrade", title: "continue", status: "completed" });
          output({ type: "text", text: "continued after the upgrade" });
          return { result: Promise.resolve({ status: "completed", reason: "fixture", input: "recorded" }), requestStop: async () => ({ requested: true }) };
        },
        close: async () => clean,
      };
      return { control, workspace: configuration.workspace, assertOwned: () => {}, close: () => control.close() };
    },
  };
}

for (const name of V13_FIXTURES) {
  test(`${name}: the conversations of the v13 fixture are continued by the Runtime after the upgrade, each Turn before the new one as it was`, { timeout: 60_000 }, async t => {
    const fixture = loadV13Fixture(name), data = join(temporary(t), "data");
    writeV13Root(data, [fixture]);
    const store = appStore(data, { now: () => stamp });
    let counter = 0;
    const app = new SessionRuntime(store, resumingHarness(id => store.get(id).nativeBindings ?? []), { id: () => "continue-" + name + "-" + String(++counter), now: () => stamp, publish: () => {},
      fingerprint: value => createHash("sha256").update(value).digest("hex") });
    let continued = 0;
    try {
      // What a previous owner kept running is settled at the start (the Runtime here has no process control: nothing is signalled, and the keeping is recorded as lost).
      await app.reapKept();
      for (const row of fixture.sessions) {
        const id = sessionId(row.id), before = store.snapshot(id), where = name + " " + row.id;
        if (before.status === "open") {
          const receipt = app.send(id, "continue after the upgrade", "after-upgrade-" + row.id);
          await app.wait(id);
          const after = store.snapshot(id), run = after.runs.find(item => item.id === receipt.runId);
          assert.equal(run?.status, "completed", where + ": the new Turn completes: " + JSON.stringify(run?.error));
          assert.equal(after.runs.length, before.runs.length + 1, where + ": one Turn more");
          assert.deepEqual(after.runs.slice(0, before.runs.length), before.runs, where + ": the Turns before it are as they were");
          assert.deepEqual(after.messages.slice(0, before.messages.length), before.messages, where + ": and so are the messages");
          assert.deepEqual(verify(store.get(id), store), [], where + ": the conversation breaks no rule");
          assert.equal(run?.tools?.at(-1)?.id, "after-upgrade", where + ": the new Turn's call is in it");
          continued++;
        } else if (before.status === "blocked") {
          // Taken over by a recovery switch when what ran is confirmed stopped; refused, as it always was, when it is not.
          const target = { harnessId: before.selection.harnessId, controlId: before.selection.controlId };
          try { app.resume(id, target, "recover-" + row.id, true); } catch (error) {
            assert.ok(error instanceof SessionError && error.code === "RECOVERY_UNSAFE", where + ": refused for the reason it always was: " + String(error));
            assert.equal(store.snapshot(id).status, "blocked", where + ": and still blocked");
            assert.deepEqual(store.snapshot(id).runs, before.runs, where + ": its history untouched");
            continue;
          }
          await app.wait(id);
          assert.equal(store.snapshot(id).status, "open", where + ": the recovery switch opened it");
          const receipt = app.send(id, "continue after the recovery", "after-recovery-" + row.id); await app.wait(id);
          assert.equal(store.snapshot(id).runs.find(item => item.id === receipt.runId)?.status, "completed", where + ": and it continues");
          assert.deepEqual(verify(store.get(id), store), [], where + ": the conversation breaks no rule");
          continued++;
        } else {
          // A closed conversation takes no input.
          assert.throws(() => app.send(id, "too late", "closed-" + row.id), (error: unknown) => error instanceof SessionError, where + ": a closed conversation is refused");
        }
      }
    } finally { try { await app.close(); } finally { store.close(); } }
    t.diagnostic(name + ": " + continued + " of " + fixture.sessions.length + " conversations continued");
  });
}

test("the fixtures hold open conversations enough for the continuation to mean something", () => {
  const open = V13_FIXTURES.flatMap(fixture => loadV13Fixture(fixture).sessions).filter(row => row.snapshot.status === "open").length;
  assert.ok(open >= 35, "only " + open + " open conversations");
});
