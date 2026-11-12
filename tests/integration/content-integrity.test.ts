import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import { collectContent } from "../../src/cli/session-application.js";
import { nativeConversationId, singleText, type BackendResult, type CleanupEvidence, type ControlEvent, type HarnessControl } from "../../src/contracts/control.js";
import type { ConversationReader, SessionListCursor } from "../../src/contracts/conversation.js";
import { sessionId, type HarnessSelection, type PreparedSessionBinding, type SelectionRequest, type SessionBindingFactory, type SessionConfiguration, type SessionId } from "../../src/contracts/session.js";
import { SessionRuntime } from "../../src/contexts/session/application/runtime.js";
import { mentionedContent, verify } from "../../src/contexts/session/domain/conversation-verify.js";
import { CONTENT_RETENTION_MS, LocalContentStore } from "../../src/infrastructure/session/content-store.js";
import type { SqliteConversationStore } from "../../src/infrastructure/session/conversation-store.js";
import { appStore } from "../fixtures/runtime-store.js";
import { loadV13Fixture, writeV13Root } from "../fixtures/storage/v13/database.js";
import { rawDatabase, temporary } from "../fixtures/store-helpers.js";

// The content collector deletes what no registered reference keeps (content_refs), and a backup of the database cannot bring that back: the one loss of content that cannot be
// undone. So every content a conversation's rows mention must be registered, in every way a conversation is made and changed: a call's detail (stored once its updates are merged,
// and again when a later update changes it), an attachment, an artifact, a branch's quoted history, a Turn cancelled in the middle, a conversation a crash left and the next owner
// recovered, and a conversation migrated from v13 that is then continued. This runs them all on one data root with a real Runtime, a real store and a real content store
// (only the Harness and the model are made up), lets the content age past its retention, starts the store again, collects for real, and reads every conversation whole:
// every detail, artifact and attachment that could be read before the collection can be read after it, and every text.

const clean: CleanupEvidence = { closed: true, exitCode: 0, signal: null, protocolFailure: null };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]);
const CREATED = Date.parse("2026-10-01T00:00:00Z");

class Gate<T = void> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;
  constructor() { this.promise = new Promise(resolve => { this.resolve = resolve; }); }
}
type Script = (input: string, output: (event: ControlEvent) => void, stop: Promise<void>) => Promise<BackendResult>;
/** A Harness that does what the test's script says in each Turn, with a native session of its own per conversation, and stops when asked. */
class Scripted implements SessionBindingFactory {
  script: Script = async () => ({ status: "completed", reason: "scripted", input: "recorded" });
  async validate(request: SelectionRequest): Promise<HarnessSelection> { return { harnessId: request.harnessId, controlId: request.controlId ?? request.harnessId + "-acp" }; }
  async prepare(selected: HarnessSelection, configuration: SessionConfiguration, session: SessionId): Promise<PreparedSessionBinding> {
    let native: string | null = null;
    const stopped = new Gate();
    const control: HarnessControl = {
      initialize: async () => ({ protocol: "acp-v1", protocolVersion: 1, agentName: "scripted", agentVersion: "1", authenticationMethods: [], capabilities: {} }),
      open: async (_directory, _model, _options, checkpoint) => { native = checkpoint ?? "native-" + session; return nativeConversationId(native); },
      checkpoint: async () => native,
      startText: async (_id, text, output) => ({ result: this.script(singleText(text), output, stopped.promise), requestStop: async () => { stopped.resolve(); return { requested: true }; } }),
      close: async () => clean,
    };
    return { control, workspace: configuration.workspace, assertOwned: () => {}, close: () => control.close() };
  }
}
const ok: BackendResult = { status: "completed", reason: "scripted", input: "recorded" };
async function until(what: string, ready: () => boolean): Promise<void> {
  for (let waited = 0; !ready(); waited += 10) { if (waited > 10_000) throw new Error("timed out waiting for " + what); await pause(10); }
}
async function* body(value: Uint8Array) { yield value; }

/** Every content a conversation's rows mention, with the place: its Turns' items (whole), the Runs' attachments, the history it quoted. */
function mentions(reader: ConversationReader, id: SessionId): ReadonlyMap<string, string> {
  const found = new Map<string, string>(), head = reader.head(id);
  for (let ordinal = 0; ordinal < head.runCount; ordinal++) {
    const turn = reader.turnAt(id, ordinal, { inlineBytes: Infinity })!;
    for (const content of mentionedContent({ ...turn.run.facts })) found.set(content, "run " + ordinal + " facts");
    for (const item of turn.items) for (const content of mentionedContent(item.fields)) found.set(content, "run " + ordinal + " item " + item.seq);
  }
  for (const row of reader.originHistory?.(id) ?? []) for (const content of mentionedContent(row.message)) found.set(content, "quoted message " + row.idx);
  return found;
}
/** The ids of the content store that can be read, among those given. */
function readable(content: LocalContentStore, ids: Iterable<string>): Set<string> {
  const found = new Set<string>();
  for (const id of ids) { try { content.read(id); found.add(id); } catch { /* not there */ } }
  return found;
}
function everyConversation(store: SqliteConversationStore): readonly SessionId[] {
  const ids: SessionId[] = [];
  for (let after: SessionListCursor | undefined; ;) { const page = store.list({ limit: 50, ...(after === undefined ? {} : { after }) }); ids.push(...page.rows.map(row => row.id)); if (page.next === null) return ids; after = page.next; }
}

test("every content the rows of a conversation mention survives a real collection, in every way a conversation is made: details, attachments, artifacts, branches, cancels, a crash, a migrated conversation continued", { timeout: 120_000 }, async t => {
  const root = temporary(t), data = join(root, "data"), workspace = join(root, "workspace");
  await mkdir(workspace);
  const configuration: SessionConfiguration = { workspace, manifestPath: null, manifestSha256: null, configHome: null, packageRoots: [], searchDirs: [], pathOnly: true };
  // A v13 database with a conversation full of calls (the fixture 'tools'): the store converts it when it opens the root.
  writeV13Root(data, [loadV13Fixture("tools")]);
  const migrated = sessionId("session-tl-1");
  let clock = CREATED;
  const harness = new Scripted();

  // ------------------------------------------------------------------------------------------------------------------------------------
  // The first owner: the ways a conversation is made, and a crash in the middle of a Turn
  // ------------------------------------------------------------------------------------------------------------------------------------
  const first = appStore(data, { now: () => new Date(clock) }), firstContent = new LocalContentStore(data, () => first.assertOwner(), () => clock);
  let counter = 0;
  const one = new SessionRuntime(first, harness, { id: () => "one-" + String(++counter), now: () => new Date(clock), publish: () => {}, fingerprint: value => createHash("sha256").update(value).digest("hex"), content: firstContent });
  const orphan = await firstContent.storeOutput({ workspace, name: "orphan.txt", mediaType: "text/plain", data: Buffer.from("nothing refers to this") });

  // A: attachments, a call whose detail is updated three times, another with an edit, an artifact; then a Turn that is cancelled with a call already made.
  const a = await one.create(configuration, { harnessId: "alpha" }, "create-a");
  const upload = await firstContent.stage({ workspace, name: "shot.png", mediaType: "image/png", commandId: "upload-a", declaredBytes: PNG.length, source: body(PNG) });
  harness.script = async (_input, output) => {
    output({ type: "tool", id: "shell", title: "ls", status: "in_progress", detail: { kind: "execute", name: "Bash", input: "ls" } });
    output({ type: "tool", id: "shell", title: "ls", status: "in_progress", detail: { output: "x".repeat(70_000) } });
    output({ type: "tool", id: "shell", title: "ls", status: "completed", detail: { exitCode: 0 } });
    output({ type: "tool", id: "edit", title: "Edit a.txt", status: "completed", detail: { kind: "edit", diff: "--- a/a.txt\n+++ b/a.txt\n" } });
    output({ type: "output", output: { kind: "content", name: "chart.png", mediaType: "image/png", data: PNG } });
    output({ type: "text", text: "done" });
    return ok;
  };
  one.send(a.id, "look at this", "a-1", [upload.id]); await one.wait(a.id);
  // The same call reported again after it completed, with more to its detail: the detail stored first stays referenced as the one that was superseded.
  harness.script = async (_input, output) => {
    output({ type: "tool", id: "build", title: "build", status: "completed", detail: { kind: "execute", name: "Bash", input: "pnpm build", output: "built" } });
    output({ type: "tool", id: "build", title: "build", status: "completed", detail: { output: "built, then rebuilt", exitCode: 0 } });
    output({ type: "text", text: "second" });
    return ok;
  };
  one.send(a.id, "second", "a-2"); await one.wait(a.id);
  harness.script = async (_input, output, stop) => {
    output({ type: "tool", id: "test", title: "pnpm test", status: "completed", detail: { kind: "execute", name: "Bash", input: "pnpm test", output: "ok" } });
    output({ type: "tool", id: "watch", title: "watch", status: "in_progress", detail: { kind: "execute", name: "Bash", input: "tail -f log" } });
    await stop;
    return { status: "cancelled", reason: "stopped" };
  };
  one.send(a.id, "third, to be cancelled", "a-3");
  await until("the third Turn to run", () => first.get(a.id).runs[2]?.status === "running");
  one.cancel(a.id, "cancel-a-3"); await one.wait(a.id);
  assert.equal(first.get(a.id).runs[2]?.status, "cancelled");

  // B: a branch of A from its first Turn, which quotes the Turn's attachment; and the branch's own Turn with a call.
  const b = one.fork(a.id, "branch-b", first.get(a.id).runs[0]!.id);
  assert.ok(first.originHistory(b.id).some(row => (row.message.attachments ?? []).some(ref => ref.id === upload.id)), "the branch quotes the attachment");
  harness.script = async (_input, output) => { output({ type: "tool", id: "own", title: "own", status: "completed", detail: { kind: "execute", name: "Bash", input: "echo b", output: "b" } }); output({ type: "text", text: "b" }); return ok; };
  one.send(b.id, "branch work", "b-1"); await one.wait(b.id);

  // C: a native session continued as a conversation.
  (harness as SessionBindingFactory).readNativeSession = async (_selection, _configuration, nativeId) => ({ checkpoint: "private-" + nativeId, title: "Earlier", history: [{ role: "user", text: "earlier question" }, { role: "assistant", text: "earlier answer" }], omitted: 0, complete: true, historyRead: true });
  const c = await one.importNative(configuration, { harnessId: "alpha" }, "native-c", "import-c");
  harness.script = async (_input, output) => { output({ type: "tool", id: "imported", title: "imported", status: "completed", detail: { kind: "execute", name: "Bash", input: "ls", output: "files" } }); return ok; };
  one.send(c.id, "continue", "c-1"); await one.wait(c.id);

  // D: a Turn the owner dies in the middle of, after a call's detail was stored.
  const d = await one.create(configuration, { harnessId: "alpha" }, "create-d");
  const never = new Gate();
  harness.script = async (_input, output) => { output({ type: "tool", id: "before-the-crash", title: "ls", status: "completed", detail: { kind: "execute", name: "Bash", input: "ls", output: "files" } }); await never.promise; return ok; };
  one.send(d.id, "work that is interrupted", "d-1");
  await until("a detail stored in the Turn the owner dies in", () => (first.turnAt(d.id, 0, { inlineBytes: Infinity })?.items ?? []).some(item => mentionedContent(item.fields).size > 0));
  for (const id of [a.id, b.id, c.id]) assert.deepEqual(verify(first.get(id), first), [], "before the crash: " + id);
  // The owner dies: its store goes away under it, and what it was doing is never finished.
  first.close();
  never.resolve();
  try { await one.close(); } catch { /* the Runtime of a dead owner fails as it stops */ }

  // ------------------------------------------------------------------------------------------------------------------------------------
  // The next owner: recovery, then the migrated conversation continued
  // ------------------------------------------------------------------------------------------------------------------------------------
  const second = appStore(data, { now: () => new Date(clock) }), secondContent = new LocalContentStore(data, () => second.assertOwner(), () => clock);
  const two = new SessionRuntime(second, harness, { id: () => "two-" + String(++counter), now: () => new Date(clock), publish: () => {}, fingerprint: value => createHash("sha256").update(value).digest("hex"), content: secondContent });
  assert.notEqual(second.get(d.id).runs[0]?.status, "running", "recovery ended the Turn the dead owner left");
  assert.deepEqual(verify(second.get(d.id), second), [], "the recovered conversation");
  harness.script = async (_input, output) => {
    output({ type: "tool", id: "after-upgrade", title: "continue", status: "completed", detail: { kind: "execute", name: "Bash", input: "ls", output: "after" } });
    output({ type: "output", output: { kind: "content", name: "after.png", mediaType: "image/png", data: PNG } });
    return ok;
  };
  two.send(migrated, "continue after the upgrade", "m-1"); await two.wait(migrated);
  assert.equal(second.get(migrated).runs.at(-1)?.status, "completed");
  const everyone = everyConversation(second);
  assert.equal(everyone.length, 5, "the migrated conversation and the four the scenarios made");
  for (const id of everyone) assert.deepEqual(verify(second.get(id), second), [], "after the second owner: " + id);
  await two.close(); second.close();

  // ------------------------------------------------------------------------------------------------------------------------------------
  // The collection, for real: the content is old, the store is opened again, the first start reports and the next collects
  // ------------------------------------------------------------------------------------------------------------------------------------
  clock = CREATED + CONTENT_RETENTION_MS + 24 * 60 * 60 * 1000;
  const third = appStore(data, { now: () => new Date(clock) });
  t.after(() => { try { third.close(); } catch { /* closed below */ } });
  const aged = new LocalContentStore(data, () => third.assertOwner(), () => clock);
  const mentioned = new Map<string, string>();
  for (const id of everyConversation(third)) for (const [content, where] of mentions(third, id)) mentioned.set(content, id + " " + where);
  assert.ok(mentioned.size >= 8, "the scenarios made content: " + mentioned.size);
  const before = readable(aged, mentioned.keys());
  assert.ok(before.size >= 8, "most of what the rows mention is in the content store: " + before.size + " of " + mentioned.size);
  assert.ok([...before].some(id => id === upload.id), "the attachment is in it");
  const reports: string[] = [];
  collectContent(third, aged, line => reports.push(line));
  assert.equal(reports.length, 1); assert.match(reports[0]!, /only reports/u);
  assert.equal(readable(aged, [orphan.id]).size, 1, "the first start deletes nothing");
  assert.deepEqual(third.collectionGate(), { allowed: true, reportOnly: false, reason: null });
  collectContent(third, aged, line => reports.push(line));
  assert.equal(reports.length, 1, "the next start collects without a word");
  assert.equal(readable(aged, [orphan.id]).size, 0, "what nothing refers to is collected: the collection was real");

  // ------------------------------------------------------------------------------------------------------------------------------------
  // Everything is read: every text, and every content that could be read before
  // ------------------------------------------------------------------------------------------------------------------------------------
  let turns = 0, texts = 0, contents = 0;
  for (const id of everyConversation(third)) {
    const head = third.head(id);
    assert.deepEqual(verify(third.get(id), third), [], "after the collection: " + id);
    for (let ordinal = 0; ordinal < head.runCount; ordinal++) {
      const turn = third.turnAt(id, ordinal, { inlineBytes: Infinity })!; turns++;
      for (const item of turn.items) {
        if (item.textBytes > 0) { assert.equal(Buffer.byteLength(third.text(item.runId, item.seq).text), item.textBytes, id + " run " + ordinal + " item " + item.seq + ": its text is whole"); texts++; }
        for (const content of mentionedContent(item.fields)) {
          if (!before.has(content)) continue;
          const read = aged.read(content);
          assert.equal(read.ref.id, content); contents++;
          if ((item.fields as { detail?: { id: string } }).detail?.id === content) assert.notEqual(await aged.readText(read.ref, 1024 * 1024), null, id + " run " + ordinal + " item " + item.seq + ": the detail of a call can be read");
        }
      }
    }
    for (const [content, where] of mentions(third, id)) if (before.has(content)) { aged.read(content); contents++; assert.ok(where.length > 0); }
  }
  assert.ok(turns >= 20 && texts >= 20 && contents >= 8, `read ${turns} Turns, ${texts} texts and ${contents} contents`);
  const roles = rawDatabase(data, true);
  try {
    const byRole = Object.fromEntries(roles.prepare("SELECT role, COUNT(*) AS n FROM content_refs GROUP BY role").all().map(row => [String(row.role), Number(row.n)]));
    t.diagnostic(`read ${turns} Turns, ${texts} texts and ${contents} contents; the references by role: ${JSON.stringify(byRole)}`);
    for (const role of ["tool_detail", "output", "attachment", "origin_attachment"]) assert.ok((byRole[role] ?? 0) > 0, "the scenarios registered a " + role);
  } finally { roles.close(); }
  // Nothing that was readable before the collection and is referenced was lost; what the collector deleted nobody referenced.
  const referenced = third.contentReferences();
  for (const id of before) assert.ok(referenced.has(id), id + " was readable and mentioned, and is registered");
  third.close();
});

test("a reference that was not registered is found by the check, and the collection then deletes the content a Turn still shows", { timeout: 60_000 }, async t => {
  const root = temporary(t), data = join(root, "data"), workspace = join(root, "workspace");
  await mkdir(workspace);
  const configuration: SessionConfiguration = { workspace, manifestPath: null, manifestSha256: null, configHome: null, packageRoots: [], searchDirs: [], pathOnly: true };
  let clock = CREATED;
  const harness = new Scripted(), store = appStore(data, { now: () => new Date(clock) }), content = new LocalContentStore(data, () => store.assertOwner(), () => clock);
  const app = new SessionRuntime(store, harness, { id: () => "t-" + String(++counterOf.value), now: () => new Date(clock), publish: () => {}, fingerprint: value => createHash("sha256").update(value).digest("hex"), content });
  harness.script = async (_input, output) => { output({ type: "tool", id: "call", title: "ls", status: "completed", detail: { kind: "execute", name: "Bash", input: "ls", output: "files" } }); return ok; };
  const made = await app.create(configuration, { harnessId: "alpha" }, "create");
  app.send(made.id, "work", "one"); await app.wait(made.id);
  await app.close();
  const shown = [...mentions(store, made.id).keys()];
  assert.equal(shown.length, 1);
  assert.deepEqual(verify(store.get(made.id), store), [], "as the Runtime wrote it");
  // The registration is lost (as a writer that forgot to make it would leave it).
  const db = rawDatabase(data);
  try { db.prepare("DELETE FROM content_refs WHERE content_id=?").run(shown[0]!); } finally { db.close(); }
  const found = verify(store.get(made.id), store);
  assert.deepEqual(found.map(violation => violation.rule), ["content-refs-complete"]);
  assert.match(found[0]!.where, /run run-.* item 2/u);
  // And the collection that follows deletes what the Turn shows: the check is what stands between a forgotten registration and that loss.
  clock = CREATED + CONTENT_RETENTION_MS + 24 * 60 * 60 * 1000;
  store.acknowledgeFirstStart();
  const aged = new LocalContentStore(data, () => store.assertOwner(), () => clock);
  assert.equal(readable(aged, shown).size, 1);
  collectContent(store, aged, () => {});
  assert.equal(readable(aged, shown).size, 0, "the content a Turn still shows was deleted");
  store.close();
});
const counterOf = { value: 0 };
