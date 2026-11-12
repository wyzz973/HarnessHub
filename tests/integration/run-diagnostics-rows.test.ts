import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { nativeConversationId, singleText, type BackendResult, type CleanupEvidence, type HarnessControl } from "../../src/contracts/control.js";
import type { ConversationReader } from "../../src/contracts/conversation.js";
import { SessionError, sessionId, type HarnessSelection, type PreparedSessionBinding, type SelectionRequest, type SessionBindingFactory, type SessionConfiguration } from "../../src/contracts/session.js";
import { SessionRuntime } from "../../src/contexts/session/application/runtime.js";
import { messageStarts, turnSource } from "../../src/contexts/session/domain/turn-source.js";
import type { SqliteConversationStore } from "../../src/infrastructure/session/conversation-store.js";
import { turnDiagnostics } from "../../src/web/run-diagnostics.js";
import { runDiagnostics, type RunDiagnosticsInput } from "../fixtures/old-shape.js";
import { appStore } from "../fixtures/runtime-store.js";
import { temporary } from "../fixtures/store-helpers.js";
import { V13_FIXTURES, loadV13Fixture, writeV13Root } from "../fixtures/storage/v13/database.js";

// The report of one Turn (ADR-037) made from the rows of that Turn, and from the starts of the conversation's messages, held to the report made from the conversation's old whole shape; and the
// starts of the messages of a conversation with a long reply read no more than the first bytes of each text.

const stamp = new Date("2026-11-13T00:00:00.000Z"), clean: CleanupEvidence = { closed: true, exitCode: 0, signal: null, protocolFailure: null };
const base = (input: Partial<RunDiagnosticsInput>): Omit<RunDiagnosticsInput, "session" | "run"> => ({ events: [], eventsComplete: true, stderr: null, harness: { name: "Fixture", programVersion: "1.0", installedVersion: "1.1" }, build: "abcdef0123456789",
  runtime: { node: "26.13.0", platform: "darwin", release: "27", arch: "arm64" }, now: new Date("2026-11-13T00:00:00.000Z"), includeContent: false, scrub: text => text, ...input });

for (const name of V13_FIXTURES) {
  test(`${name}: the report of each Turn made from its rows is the report made from the old whole shape, with and without the conversation's content`, { timeout: 60_000 }, t => {
    const fixture = loadV13Fixture(name), data = join(temporary(t), "data");
    writeV13Root(data, [fixture]);
    const store = appStore(data, { now: () => stamp });
    try {
      for (const row of fixture.sessions) {
        const id = sessionId(row.id), snapshot = store.snapshot(id), turns = turnSource(store, id), starts = () => messageStarts(store, id);
        const first = snapshot.messages[0]?.text.trim().slice(0, 32) ?? "", log = "INFO started\n" + (first.length >= 4 ? first + " words that must not leave\n" : "") + "INFO Prompt on session x: secret question\nok\n" + "x".repeat(6000) + "\nend";
        for (const [ordinal, run] of snapshot.runs.entries()) for (const includeContent of [false, true]) for (const stderr of [null, { text: log, truncated: false }]) {
          const extra = base({ includeContent, stderr });
          const fromOld = runDiagnostics({ ...extra, session: snapshot, run }), fromRows = turnDiagnostics({ ...extra, turn: turns.turn(ordinal)!, turns: turns.count, messages: starts });
          assert.equal(fromRows, fromOld, name + " " + row.id + " turn " + (ordinal + 1) + (includeContent ? " with content" : " without content") + (stderr === null ? " no log" : " log"));
        }
      }
    } finally { store.close(); }
  });
}

class Quiet implements SessionBindingFactory {
  constructor(private readonly reply: string) {}
  async validate(request: SelectionRequest): Promise<HarnessSelection> {
    if (request.harnessId !== "alpha") throw new SessionError("HARNESS_UNAVAILABLE", "fixture target is unavailable");
    return { harnessId: "alpha", controlId: "alpha-acp" };
  }
  async prepare(_selected: HarnessSelection, configuration: SessionConfiguration): Promise<PreparedSessionBinding> {
    let opened = false;
    const control: HarnessControl = {
      initialize: async () => ({ protocol: "acp-v1", protocolVersion: 1, agentName: "fake", agentVersion: "1", authenticationMethods: [], capabilities: {} }),
      open: async () => { opened = true; return nativeConversationId("native-alpha"); },
      checkpoint: async () => opened ? "private-native-alpha" : null,
      startText: async (_id, turn, output) => {
        singleText(turn); output({ type: "text", text: this.reply });
        return { result: Promise.resolve<BackendResult>({ status: "completed", reason: "fake", input: "recorded" }), requestStop: async () => ({ requested: true }) };
      },
      close: async () => clean,
    };
    return { control, workspace: configuration.workspace, assertOwned: () => {}, close: () => control.close() };
  }
}

test("the starts of the messages of a conversation with a reply of 900 KiB are read from the first bytes of each text, and withhold what a log quotes of them", { timeout: 60_000 }, async t => {
  const open: { app?: SessionRuntime; store?: SqliteConversationStore } = {};
  t.after(async () => { await open.app?.close(); open.store?.close(); });
  const root = temporary(t), workspace = join(root, "workspace"), data = join(root, "data");
  mkdirSync(workspace);
  const store = appStore(data, { now: () => stamp }); open.store = store;
  const reply = "   The reply begins with a sentence the log may quote. " + "long ".repeat(180_000);
  let next = 0;
  const app = new SessionRuntime(store, new Quiet(reply), { id: () => String(++next), now: () => stamp, publish: () => {}, fingerprint: value => createHash("sha256").update(value).digest("hex") });
  open.app = app;
  const session = await app.create({ workspace, manifestPath: null, manifestSha256: null, configHome: null, packageRoots: [], searchDirs: [], pathOnly: true }, { harnessId: "alpha" }, "create");
  app.send(session.id, "What is the question that nobody has answered yet?", "one"); await app.wait(session.id);
  // A reader that says what it is asked for: the starts are read with a bound, and from a range of the text when the text is longer.
  const asked: string[] = [];
  const spy: Pick<ConversationReader, "head" | "turnAt" | "text"> = {
    head: id => store.head(id),
    turnAt: (id, ordinal, options) => { asked.push("turnAt " + options?.inlineBytes); return store.turnAt(id, ordinal, options); },
    text: (runId, seq, range) => { asked.push("text " + range?.from + "-" + range?.to); return store.text(runId, seq, range); },
  };
  const starts = messageStarts(spy, session.id);
  assert.deepEqual(starts.map(start => start.trim().slice(0, 32)), ["What is the question that nobody", "The reply begins with a sentence"]);
  assert.deepEqual(asked, ["turnAt 512", "text 0-512"], "the Turn's items without their long bodies, and the first 512 bytes of the reply");
  const snapshot = store.snapshot(session.id), turns = turnSource(store, session.id), run = snapshot.runs[0]!;
  const log = "ok\nThe reply begins with a sentence the log may quote and more\nend";
  const input = base({ stderr: { text: log, truncated: false } });
  const fromRows = turnDiagnostics({ ...input, turn: turns.turn(0)!, turns: 1, messages: () => starts }), fromOld = runDiagnostics({ ...input, session: snapshot, run });
  assert.equal(fromRows, fromOld);
  assert.match(fromRows, /The reply begins with a sentence the log may quote and more\n|\[对话内容已隐去\]/u);
  assert.doesNotMatch(fromRows, /sentence the log may quote and more/u, "the log's quotation of the reply is withheld");
});
