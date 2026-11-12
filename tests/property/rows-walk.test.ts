import assert from "node:assert/strict";
import { test } from "node:test";
import type { Conversation, ConversationRun, HeldItem } from "../../src/contracts/conversation.js";
import type { ItemStatus } from "../../src/contracts/protocol.js";
import { loadConversation, loadItems, WHOLE } from "../../src/infrastructure/session/load.js";
import { NOW, SESSION, bytes, commit, conversation, event, item, openDatabase, reduce, replaceRun, replyItem, run, sendCommand, toolItem, userItem } from "../fixtures/conversation-builder.js";

// Random conversations written commit by commit through diff and apply, read back after every commit: a Turn is sent, started, grows items and
// text, and ends, many times over, with the text made of whole code points of every width. Each case names its seed. The oracle is the text each
// item should hold, kept beside the conversation; the tables must give it back chunk by chunk and whole.

function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (state + 0x6d2b79f5) >>> 0; let value = Math.imul(state ^ (state >>> 15), 1 | state); value ^= value + Math.imul(value ^ (value >>> 7), 61 | value); return ((value ^ (value >>> 14)) >>> 0) / 4294967296; };
}
const PIECES = ["abc", "Hello, ", "你好", "😀", "é", " ", "\n", "世界。", "𝒳", "x".repeat(300), "语言 language ", "👨‍👩‍👧"];
function words(random: () => number): string { return Array.from({ length: 1 + Math.floor(random() * 4) }, () => PIECES[Math.floor(random() * PIECES.length)]!).join(""); }
const pick = <T>(random: () => number, list: readonly T[]): T => list[Math.floor(random() * list.length)]!;

for (const seed of [11, 4242, 90210]) {
  test("a random walk of commits (seed " + seed + ") reads back as committed after every commit, and the text comes back chunk by chunk", t => {
    const env = openDatabase(t), random = generator(seed);
    let state = commit(env, null, conversation(), [event("session.created")]).conversation;
    const oracle = new Map<string, string[]>();
    const keyOf = (runId: string, seq: number): string => runId + "#" + seq;
    let commits = 1, turns = 0;
    const apply = (next: Conversation, events: readonly ReturnType<typeof event>[]): void => {
      state = commit(env, state, next, events).conversation; commits++;
      assert.deepEqual(loadConversation(env.db, SESSION), state, "after commit " + commits);
    };
    const mapItems = (current: Conversation, change: (items: readonly HeldItem[]) => readonly HeldItem[]): Conversation =>
      reduce(current, c => ({ runs: c.runs.map((entry): ConversationRun => entry.items !== undefined && entry.status === "running" ? { ...entry, items: change(entry.items) } : entry) }));
    const live = (): ConversationRun => state.runs.at(-1)!;
    for (let step = 0; step < 260; step++) {
      const last = state.runs.at(-1);
      if (last === undefined || (last.status !== "running" && last.status !== "queued")) {
        // A Turn is sent.
        const ordinal = state.runs.length, id = "run-" + ordinal, text = words(random);
        apply(reduce(state, c => ({ runs: [...c.runs, run(ordinal, "queued", [userItem(id, text)])], commands: [...c.commands, sendCommand(ordinal)] })), [event("message.accepted", { runId: id })]);
        oracle.set(keyOf(id, 1), [text]); turns++;
        continue;
      }
      if (last.status === "queued") {
        apply(reduce(state, c => ({ activeRunId: last.id, runs: replaceRun(c, last.ordinal, entry => ({ ...entry, status: "running", timing: { acceptedAt: NOW, preparingAt: NOW + 1, readyAt: NOW + 2, dispatchedAt: NOW + 3 } })) })), [event("run.started")]);
        continue;
      }
      const items = last.items!, id = last.id, nextSeq = items.length + 1;
      const open = items.filter(it => it.type === "assistant_message" && it.status === "running");
      const choice = random();
      if (choice < 0.18 || (choice < 0.45 && open.length === 0)) {
        const first = words(random), seq = nextSeq;
        apply(mapItems(state, list => [...list, replyItem(id, seq, seq, "running", [first])]), [event("run.output")]);
        oracle.set(keyOf(id, seq), [first]);
      } else if (choice < 0.55 && open.length > 0) {
        const target = pick(random, open), more = random() < 0.2 ? [words(random), words(random)] : [words(random)];
        apply(mapItems(state, list => list.map(it => it.seq === target.seq ? { ...it, text: [...it.text, ...more] } : it)), [event("run.output")]);
        oracle.get(keyOf(id, target.seq))!.push(...more);
      } else if (choice < 0.62) {
        apply(mapItems(state, list => [...list, toolItem(id, nextSeq, "t" + nextSeq, "running")]), [event("run.output")]);
      } else if (choice < 0.74 && items.some(it => it.type === "command" && it.status === "running")) {
        const target = pick(random, items.filter(it => it.type === "command" && it.status === "running")), status = pick(random, ["completed", "failed"] as const);
        apply(mapItems(state, list => list.map(it => it.seq === target.seq ? { ...it, status, endedAt: NOW + step } : it)), [event("run.output")]);
      } else if (choice < 0.78) {
        apply(mapItems(state, list => [...list, item(id, nextSeq, "permission:" + nextSeq, "approval", "waiting", { subject: "command", title: "OK?", options: [] })]), [event("run.permission_requested")]);
      } else if (choice < 0.84 && items.some(it => it.type === "approval" && it.status === "waiting")) {
        const target = pick(random, items.filter(it => it.type === "approval" && it.status === "waiting"));
        apply(mapItems(state, list => list.map(it => it.seq === target.seq ? { ...it, status: "completed" as ItemStatus, fields: { ...it.fields, decision: { role: "allow_once", by: "user", at: NOW } } as typeof it.fields } : it)), [event("run.permission_decided")]);
      } else if (choice < 0.93) {
        // The end: every open item is closed by the Run's end, then the Run is terminal; the conversation no longer names it.
        const status = pick(random, ["completed", "failed", "cancelled"] as const);
        apply(reduce(state, c => ({ activeRunId: null, runs: replaceRun(c, last.ordinal, entry => ({ ...entry, status, backend: { status: status === "completed" ? "completed" : status, reason: "done" }, cleanup: { closed: true, exitCode: 0, signal: null, protocolFailure: null },
          items: entry.items!.map(it => it.status === "running" || it.status === "pending" || it.status === "waiting" ? { ...it, status: (status === "cancelled" ? "cancelled" : it.type === "assistant_message" ? "completed" : status === "failed" ? "failed" : "completed") as ItemStatus } : it) })) })), [event("run.ended", { runId: id, status })]);
      }
    }
    assert.ok(turns >= 4 && commits >= 100, "the walk made " + turns + " Turns in " + commits + " commits");
    // Every item's text, from the tables: chunk by chunk as it was committed, whole as it was meant, sizes as counted.
    for (const [key, chunks] of oracle) {
      const [runId, seq] = key.split("#") as [string, string];
      const row = loadItems(env.db, runId, WHOLE).find(it => it.seq === Number(seq))!;
      assert.deepEqual(row.text, chunks, key);
      assert.equal(row.textBytes, chunks.reduce((total, chunk) => total + bytes(chunk), 0), key);
      assert.equal(row.textChunks, chunks.length, key);
    }
    assert.equal(Number(env.db.prepare("SELECT COUNT(*) AS n FROM items i WHERE i.text_bytes<>COALESCE((SELECT SUM(bytes) FROM item_text t WHERE t.run_id=i.run_id AND t.item_seq=i.seq),0)").get()!.n), 0);
    assert.equal(live().ordinal, state.runs.length - 1);
  });
}
