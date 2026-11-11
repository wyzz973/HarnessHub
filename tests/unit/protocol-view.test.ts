import assert from "node:assert/strict";
import test from "node:test";
import type { ContentRef } from "../../src/contracts/content.js";
import { contentId } from "../../src/contracts/content.js";
import type { SessionSnapshot } from "../../src/contracts/session.js";
import { DetailHeads, ProtocolView, type DetailSource } from "../../src/web/protocol-view.js";
import { conversation, tool, names } from "../fixtures/relay-scenarios.js";

// What the web view brings to the protocol's reading of a conversation: the heads of the stored tool details it reads from the
// content store (bounded, and kept), and the Turns made from them.

const ref = (name: string): ContentRef => ({ id: contentId("content-" + name), name: name + ".json", mediaType: "application/json", kind: "file", bytes: 10, sha256: "4".repeat(64) });
/** A content store that holds some details and counts how often each is read. */
function source(held: Record<string, unknown>): DetailSource & { readonly reads: Map<string, number> } {
  const reads = new Map<string, number>();
  return { reads, readTextSync: item => { reads.set(item.id, (reads.get(item.id) ?? 0) + 1); const value = held[item.id]; return value === undefined ? null : typeof value === "string" ? value : JSON.stringify(value); } };
}

test("a detail's head is read once and kept, for as many views as ask", () => {
  const store = source({ "content-a": { input: "pwd", output: "x".repeat(10_000), locations: ["/w"] }, "content-b": { diff: "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-1\n+2\n" } });
  const heads = new DetailHeads(store), view = heads.reader();
  assert.deepEqual(view.read(ref("a")), { input: "pwd", locations: ["/w"] }, "the output is not kept: it is fetched when a call is opened");
  assert.deepEqual(view.read(ref("b")), { files: [{ path: "x", op: "edit", added: 1, removed: 1 }] });
  const next = heads.reader(); next.read(ref("a")); next.read(ref("b"));
  assert.deepEqual([...store.reads], [["content-a", 1], ["content-b", 1]]); assert.equal(heads.size, 2);
});

test("a detail that cannot be read is no error: it is missed, not asked for again for a while, and read once it can be", () => {
  let now = 1000;
  const held: Record<string, unknown> = { "content-text": "not json" }, store = source(held), heads = new DetailHeads(store, { retryMs: 500, now: () => now });
  let view = heads.reader();
  assert.equal(view.read(ref("gone")), null); assert.equal(view.read(ref("text")), null);
  held["content-gone"] = { input: "ls" };
  view = heads.reader(); assert.equal(view.read(ref("gone")), null, "within the wait it is not asked for again"); assert.equal(store.reads.get("content-gone"), 1);
  now += 600; view = heads.reader(); assert.deepEqual(view.read(ref("gone")), { input: "ls" }); assert.equal(store.reads.get("content-gone"), 2);
  assert.equal(new DetailHeads(undefined).reader().read(ref("any")), null, "a Gateway with no store to read from tells every call by its title");
  assert.equal(new DetailHeads({ readTextSync: () => { throw new Error("disk"); } }).reader().read(ref("any")), null, "a read that throws is a detail not read");
});

test("what is kept is bounded, and so is what one view reads: the rest is left for a later view", () => {
  const store = source(Object.fromEntries(["a", "b", "c", "d", "e"].map(name => ["content-" + name, { input: name }]))), heads = new DetailHeads(store, { maxEntries: 3, readsPerView: 2 });
  const view = heads.reader();
  assert.deepEqual(["a", "b", "c", "d"].map(name => view.read(ref(name))?.input), ["a", "b", undefined, undefined]);
  const later = heads.reader();
  assert.deepEqual(["a", "b", "c", "d"].map(name => later.read(ref(name))?.input), ["a", "b", "c", "d"], "held ones are free; two more are read");
  // Three heads are kept, the longest unused leaving first: a, and then b, went; c, d and e stayed.
  assert.equal(heads.size, 3); const last = heads.reader(); last.read(ref("d")); last.read(ref("e")); assert.equal(heads.size, 3);
  assert.deepEqual([...store.reads].map(([id, count]) => id + ":" + count), ["content-a:1", "content-b:1", "content-c:1", "content-d:1", "content-e:1"]);
  const again = heads.reader(); again.read(ref("c")); again.read(ref("a")); assert.equal(store.reads.get("content-c"), 1, "c was kept"); assert.equal(store.reads.get("content-a"), 2, "a had left, so it was read again");
});

test("each Run of a view gets its Turn, told again with what has become readable and with what a catalog has since named", () => {
  const scenario = conversation([
    { input: "first", harnessId: "dsh", reply: "done", tools: [tool("t1", "bash", "other", { detail: ref("t1") })] },
    { input: "second", harnessId: "codex", reply: "done too", tools: [tool("t2", "/bin/zsh -lc 'npm test'", "execute", { name: "shell", exitCode: 1, status: "failed", detail: ref("t2") })] },
    { input: "third", harnessId: "codex" },
  ]);
  const snapshot: SessionSnapshot = { ...scenario.state, runs: scenario.state.runs.map((run, index) => index === 2 ? { ...run, status: "running" } : run) };
  const held: Record<string, unknown> = {}, store = source(held);
  let label = (id: string, model: string): string | null => null;
  const view = new ProtocolView({ heads: new DetailHeads(store, { retryMs: 0 }), harnessName: names, modelName: (id, model) => label(id, model) });
  const commandItem = (runs: ReturnType<ProtocolView["attach"]>, index: number) => { const item = runs[index]!.protocol!.items.find(item => item.type === "command"); assert.ok(item?.type === "command"); return item; };

  let runs = view.attach(snapshot, snapshot.runs, new Set());
  assert.deepEqual(runs.map(run => run.protocol?.n), [1, 2, 3]); assert.equal(runs[0]!.protocol!.executor.harness, "DeepSeek Harness"); assert.equal(runs[1]!.protocol!.executor.harness, "Codex");
  assert.equal(commandItem(runs, 0).command, "", "DeepSeek Harness's bash has only its name for a title until its detail is read");
  assert.equal(commandItem(runs, 1).command, "npm test", "Codex's title is its command, told without its shell"); assert.equal(commandItem(runs, 1).cwd, undefined, "where it ran is in its detail");
  // The facts of each Run are kept as they were.
  assert.deepEqual(runs.map(run => run.id), snapshot.runs.map(run => run.id)); assert.equal(runs[1]!.tools![0]!.exitCode, 1); assert.deepEqual(runs[0]!.tools, snapshot.runs[0]!.tools);
  // The details become readable: the Turns are told again, now whole.
  held["content-t1"] = { input: "pwd && ls -la" }; held["content-t2"] = { input: "/bin/zsh -lc 'npm test'", locations: ["/w"] };
  runs = view.attach(snapshot, snapshot.runs, new Set());
  assert.equal(commandItem(runs, 0).command, "pwd && ls -la"); assert.equal(commandItem(runs, 1).command, "npm test"); assert.equal(commandItem(runs, 1).cwd, "/w"); assert.equal(commandItem(runs, 1).status, "failed");
  const reads = [store.reads.get("content-t1"), store.reads.get("content-t2")]; view.attach(snapshot, snapshot.runs, new Set());
  assert.deepEqual([store.reads.get("content-t1"), store.reads.get("content-t2")], reads, "their heads were kept");
  // A Run that waits for a decision is waiting; a model a catalog names is shown by that name.
  assert.equal(runs[2]!.protocol!.status, "running");
  assert.equal(view.attach(snapshot, snapshot.runs, new Set([snapshot.runs[2]!.id]))[2]!.protocol!.status, "waiting");
  const withModel: SessionSnapshot = { ...snapshot, runs: snapshot.runs.map((run, index) => index === 1 ? { ...run, selection: { ...run.selection, nativeModel: "gpt-5.5" } } : run) };
  assert.equal(view.attach(withModel, withModel.runs, new Set())[1]!.protocol!.executor.model?.label, "GPT 5.5");
  label = () => "Codex GPT-5.5 (catalog)"; assert.equal(view.attach(withModel, withModel.runs, new Set())[1]!.protocol!.executor.model?.label, "Codex GPT-5.5 (catalog)");
});
