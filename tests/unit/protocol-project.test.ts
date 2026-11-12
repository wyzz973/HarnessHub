import assert from "node:assert/strict";
import test from "node:test";
import { builtinHarnessName } from "../../src/cli/session-application.js";
import { projectTurn, projectTurns, type ProjectionEnv, type ProjectionInput } from "../../src/contexts/session/domain/protocol/index.js";
import { ITEM_TYPES, PROTOCOL_VERSION, type ProtocolItem, type ProtocolTurn, type SwitchItem } from "../../src/contracts/protocol.js";
import { contentId } from "../../src/contracts/content.js";
import { messageId, type NativeSessionBinding, type PublicMessage, type PublicTool, type RunId } from "../../src/contracts/session.js";
import type { RunRelayView, WebRun } from "../../src/contracts/web.js";
import { messagesOf, trialConversation, webRun } from "../fixtures/protocol-trial.js";

// What the Hub stores of a conversation, read as protocol Turns (docs/proposals/protocol/hub-protocol.html §4–§5, step 1 of §17).

const NAMES: Readonly<Record<string, string>> = { dsh: "DeepSeek Harness", codex: "Codex", opencode: "OpenCode", claude: "Claude Code", hermes: "Hermes Agent" };
const env = (over: Partial<ProjectionEnv> = {}): ProjectionEnv => ({ harnessName: id => NAMES[id] ?? null, detail: () => null, ...over });
const read = (runs: readonly WebRun[], messages: readonly PublicMessage[] = runs.flatMap(run => messagesOf(run)), extra: Partial<ProjectionInput> = {}): ProjectionInput => ({ runs, messages, ...extra });
const types = (turn: ProtocolTurn): string[] => turn.items.map(item => item.type);
const tool = (id: string, title: string, over: Partial<PublicTool> = {}): PublicTool => ({ id, title, status: "completed", ...over });
const relay = (over: Partial<RunRelayView> = {}): RunRelayView => ({ packetId: null, kind: null, continuity: { kind: "native_resume" }, executedOn: null, ...over });

test("the trial conversation of five Harnesses reads as eleven Turns, each told the same way whoever ran it", () => {
  const { runs, messages, heads } = trialConversation();
  const turns = projectTurns(read(runs, messages), env({ detail: ref => heads.get(ref.id) ?? null }));
  assert.equal(turns.length, 11);
  turns.forEach((turn, index) => { assert.equal(turn.version, PROTOCOL_VERSION); assert.equal(turn.n, index + 1); assert.equal(turn.runId, runs[index]!.id); assert.equal(turn.status, "completed"); assert.equal(turn.stopReason, "end_turn"); });
  // The Harness is named as the catalog names it; the model, where the Run named one, in the words a person reads.
  assert.deepEqual(turns.map(turn => turn.executor.harness), ["DeepSeek Harness", "Codex", "OpenCode", "Claude Code", "Hermes Agent", "Claude Code", "Claude Code", "Claude Code", "Codex", "Codex", "Claude Code"]);
  assert.deepEqual(turns.map(turn => turn.executor.model?.label), ["DeepSeek Flash", undefined, "GLM 5.3 Flash Free", undefined, "DeepSeek Flash", undefined, undefined, undefined, undefined, undefined, undefined]);
  assert.deepEqual(turns[0]!.executor.model, { id: "[\"deepseek-official\",\"deepseek-flash\"]", label: "DeepSeek Flash", vendor: "DeepSeek" });
  // What each Turn holds: the user's words, the calls in their order, the reply.
  assert.deepEqual(types(turns[0]!), ["user_message", ...Array<string>(4).fill("command"), ...Array<string>(7).fill("file_read"), "command", "command", "assistant_message"]);
  assert.deepEqual(types(turns[1]!), ["switch", "user_message", "assistant_message"]);
  assert.deepEqual(types(turns[8]!), ["switch", "user_message", "command", "mcp_tool", "command", "mcp_tool", "mcp_tool", "mcp_tool", "mcp_tool", "mcp_tool", "mcp_tool", "command", "assistant_message"]);
  assert.deepEqual(types(turns[9]!).filter(type => type === "file_change"), ["file_change"]);
  // Items are numbered in the order they are told, from 0, and no two share an identity.
  for (const turn of turns) { assert.deepEqual(turn.items.map(item => item.seq), turn.items.map((_, at) => at)); assert.equal(new Set(turn.items.map(item => item.id)).size, turn.items.length); for (const item of turn.items) assert.ok((ITEM_TYPES as readonly string[]).includes(item.type)); }
  // Every Turn's usage is in one meaning: the input contains the cache; a Turn without numbers has none.
  assert.deepEqual(turns.map(turn => turn.usage.completeness), ["unavailable", "complete", "complete", "complete", "unavailable", "complete", "complete", "complete", "complete", "complete", "complete"]);
  assert.equal(turns[3]!.usage.input, 93327); assert.equal(turns[8]!.usage.input, 356323); assert.equal(turns[0]!.usage.input, undefined);
  // The Executor changed before Turns 2, 3, 4, 5, 6, 9 and 11; the trial conversation carries no relay facts, so what was brought is not claimed.
  assert.deepEqual(turns.flatMap(turn => turn.items.filter((item): item is SwitchItem => item.type === "switch").map(item => [turn.n, item.from.harnessId, item.to.harnessId, item.context, item.session])),
    [[2, "dsh", "codex", "unknown", "unknown"], [3, "codex", "opencode", "unknown", "unknown"], [4, "opencode", "claude", "unknown", "unknown"], [5, "claude", "hermes", "unknown", "unknown"],
      [6, "hermes", "claude", "unknown", "unknown"], [9, "claude", "codex", "unknown", "unknown"], [11, "codex", "claude", "unknown", "unknown"]]);
  // Timing is the Hub's: from accepting the input to the end.
  assert.equal(turns[0]!.startedAt, 1000); assert.equal(turns[0]!.durationMs, 600);
});

test("the Harness's display name is the catalog's, the one the relay already names Harnesses by", () => {
  const name = builtinHarnessName();
  assert.equal(name("claude"), "Claude Code"); assert.equal(name("codex"), "Codex"); assert.equal(name("dsh"), "DeepSeek Harness"); assert.equal(name("hermes"), "Hermes Agent"); assert.equal(name("no-such-harness"), null);
  const turn = projectTurn(read([webRun(1, "dsh")]), 0, { harnessName: name, detail: () => null });
  assert.equal(turn.executor.harness, "DeepSeek Harness"); assert.equal(projectTurn(read([webRun(1, "unlisted")]), 0, env()).executor.harness, "unlisted");
});

test("a Turn's items come in the order the interface has always drawn a Run: switch, words, reasoning, calls, plan, notices, reply, error, artifacts, context events", () => {
  const first = webRun(1, "claude");
  const content = { id: contentId("content-art-1"), name: "report.png", mediaType: "image/png", kind: "image" as const, bytes: 4, sha256: "1".repeat(64) };
  const run = webRun(2, "codex", {
    status: "failed", error: { code: "NATIVE_QUOTA_EXCEEDED", message: "quota" }, backend: { status: "failed", reason: "error" }, thinking: "weighing the options",
    tools: [tool("a", "bash", { kind: "other" }), tool("b", "TodoWrite", { name: "TodoWrite" }), tool("agent:thread-1", "子 Agent · Dewey", { kind: "subagent", name: "codex-subagent" }), tool("c", "Read a.ts", { kind: "read", parentId: "agent:thread-1" })],
    plan: { entries: [{ content: "read", status: "completed" }, { content: "write", status: "in_progress" }], explanation: "two steps" },
    notices: [{ severity: "info", title: "Model fallback", detail: "switched" }, { severity: "error", title: "The request failed" }],
    activities: [{ id: "thread-1", kind: "subagent", title: "Dewey", status: "completed" }, { id: "w", kind: "subagent", title: "Wren", status: "running" }, { id: "compact-1", kind: "compaction", title: "上下文压缩", status: "completed" },
      { id: "retry", kind: "retry", title: "模型请求重试", status: "running", detail: "overloaded" }],
    outputs: [{ kind: "content", content }, { kind: "link", uri: "https://example.invalid/report", name: "report", title: "Report" }],
  });
  const turn = projectTurn(read([first, run]), 1, env());
  assert.deepEqual(types(turn), ["switch", "user_message", "reasoning", "command", "subagent", "file_read", "subagent", "plan", "notice", "notice", "assistant_message", "error", "artifact", "artifact", "context_event"]);
  // The task-list call is the plan, not a row; a sub-agent Codex also reports as an activity is one item, and the one only the activity knows follows the calls.
  const byId = new Map(turn.items.map(item => [item.id, item]));
  assert.ok(!byId.has("b")); assert.equal(byId.get("agent:thread-1")?.type, "subagent"); assert.equal(byId.get("c")?.parentId, "agent:thread-1"); assert.equal(byId.get("hh:subagent:w")?.status, "running"); assert.ok(!byId.has("hh:subagent:thread-1"));
  const plan = byId.get("hh:plan")!; assert.ok(plan.type === "plan"); assert.deepEqual(plan.steps, [{ text: "read", status: "completed" }, { text: "write", status: "in_progress" }]); assert.equal(plan.explanation, "two steps");
  // A notice that is a failure the Run also reports as its error is told once, as the error.
  const notices = turn.items.filter(item => item.type === "notice"); assert.deepEqual(notices.map(item => item.type === "notice" ? [item.severity, item.code, item.text, item.more, item.status] : null), [["info", undefined, "Model fallback", "switched", "completed"], ["warning", "retry", "模型请求重试", "overloaded", "running"]]);
  const error = turn.items.find(item => item.type === "error")!; assert.ok(error.type === "error"); assert.equal(error.class, "quota"); assert.equal(error.code, "NATIVE_QUOTA_EXCEEDED"); assert.equal(turn.stopReason, "error"); assert.equal(turn.status, "failed");
  const artifacts = turn.items.filter(item => item.type === "artifact").map(item => item.type === "artifact" ? [item.kind, item.name, item.uri] : null); assert.deepEqual(artifacts, [["image", "report.png", undefined], ["link", "Report", "https://example.invalid/report"]]);
  const reasoning = turn.items[2]!; assert.ok(reasoning.type === "reasoning"); assert.equal(reasoning.text, "weighing the options"); assert.equal(reasoning.status, "completed");
  // Without a plan of its own, an error notice is the error.
  const bare = projectTurn(read([webRun(1, "codex", { notices: [{ severity: "error", title: "Down", detail: "503" }] })]), 0, env());
  assert.deepEqual(bare.items.filter(item => item.type === "error").map(item => item.type === "error" ? [item.class, item.message] : null), [["unknown", "Down\n503"]]);
});

test("a task list that only a call carries is the plan when its steps read exactly, and stays a visible call when they do not", () => {
  const detail = (input: string) => () => ({ input });
  const ref = { id: contentId("content-todo"), name: "t.json", mediaType: "application/json", kind: "file" as const, bytes: 1, sha256: "2".repeat(64) };
  const todos = JSON.stringify({ todos: [{ content: "read", status: "completed" }, { content: "write", status: "pending" }] });
  const run = (title: string) => webRun(1, "opencode", { tools: [tool("t", title, { name: "todowrite", detail: ref })] });
  const read1 = projectTurn(read([run("2 todos")]), 0, env({ detail: detail(todos) }));
  assert.deepEqual(types(read1), ["user_message", "plan", "assistant_message"]); const plan = read1.items[1]!; assert.ok(plan.type === "plan"); assert.deepEqual(plan.steps, [{ text: "read", status: "completed" }, { text: "write", status: "pending" }]);
  const unreadable = projectTurn(read([run("2 todos")]), 0, env());
  assert.deepEqual(types(unreadable), ["user_message", "tool", "assistant_message"]); assert.equal(unreadable.items[1]!.type === "tool" ? unreadable.items[1].name : "", "todowrite");
  // The Harness's own plan wins, and the call adds nothing.
  const both = projectTurn(read([webRun(1, "opencode", { plan: { entries: [{ content: "own", status: "pending" }] }, tools: [tool("t", "2 todos", { name: "todowrite", detail: ref })] })]), 0, env({ detail: detail(todos) }));
  assert.deepEqual(types(both), ["user_message", "plan", "assistant_message"]); assert.deepEqual((both.items[1] as { steps: unknown }).steps, [{ text: "own", status: "pending" }]);
});

test("what a Turn brought along from the Executor before it, read from the relay facts the Run carries", () => {
  const before = webRun(1, "claude");
  const next = (over: Partial<WebRun>, to = "codex", model?: string): SwitchItem | undefined => projectTurn(read([before, webRun(2, to, { ...(model === undefined ? {} : { selection: { harnessId: to, controlId: to + "-acp", nativeModel: model } }), ...over })]), 1, env()).items.find((item): item is SwitchItem => item.type === "switch");
  const row = (item: SwitchItem | undefined) => item === undefined ? null : [item.context, item.session, item.turns, item.delivery, item.packetId, item.status];
  const packet = "relay-aaaaaaaaaaaaaaaaaaaa" as RunRelayView["packetId"];
  // A packet into a new native session: the whole conversation; what the target had missed; the same again.
  assert.deepEqual(row(next({ relay: relay({ packetId: packet, continuity: { kind: "rehydrate", tier: "full", complete: true }, delivery: { state: "recorded", evidence: "E1" } }), sourceRunIds: ["run-1" as RunId] })), ["full", "new", 1, "confirmed", packet, "completed"]);
  assert.deepEqual(row(next({ relay: relay({ packetId: packet, continuity: { kind: "native_resume_delta", tier: "full", runs: 2 }, delivery: { state: "recorded", evidence: "E3" } }) })), ["delta", "resumed", 2, "confirmed", packet, "completed"]);
  assert.deepEqual(row(next({ relay: relay({ packetId: packet, continuity: { kind: "native_resume_delta", tier: "full", runs: 3 }, decision: { kind: "carry", by: "policy", cause: "delivery_unconfirmed", resend: "auto" } }) })), ["resend", "resumed", 3, "unconfirmed", packet, "unknown"]);
  assert.deepEqual(row(next({ relay: relay({ packetId: packet, continuity: { kind: "native_resume_delta", tier: "full", runs: 3 }, decision: { kind: "carry", by: "policy", cause: "delivery_unconfirmed", resend: "grown" } }) })), ["delta", "resumed", 3, "unconfirmed", packet, "unknown"]);
  // What happened to the packet: on its way while the Turn runs; not sent when the Harness refused it.
  assert.deepEqual(row(next({ status: "running", backend: null, relay: relay({ packetId: packet, continuity: { kind: "rehydrate", tier: "brief", complete: false }, delivery: { state: "in_flight", evidence: null } }) })), ["full", "new", undefined, "sending", packet, "running"]);
  assert.deepEqual(row(next({ relay: relay({ packetId: packet, continuity: { kind: "rehydrate", tier: "full", complete: true }, delivery: { state: "not_recorded", evidence: null } }) })), ["full", "new", undefined, "not_sent", packet, "failed"]);
  // Nothing sent: the user's words alone, a conversation cleared, a native session that already holds the conversation.
  assert.deepEqual(row(next({ relay: relay({ decision: { kind: "alone", by: "user" } }) })), ["none", "resumed", undefined, undefined, undefined, "completed"]);
  assert.deepEqual(row(next({ relay: relay({ continuity: { kind: "native_cleared" } }), backend: { status: "completed", reason: "cleared" } })), ["none", "new", undefined, undefined, undefined, "completed"]);
  assert.deepEqual(row(next({ relay: relay({ continuity: { kind: "blocked", code: "NATIVE_STATE_UNCONFIRMED" } }) })), ["none", "unknown", undefined, undefined, undefined, "completed"]);
  assert.deepEqual(row(next({ relay: relay() })), ["native", "resumed", undefined, undefined, undefined, "completed"]);
  // The same Harness on another model is the same native session: nothing needed.
  assert.deepEqual(row(next({ relay: relay() }, "claude", "claude-opus-5-5")), ["native", "resumed", undefined, undefined, undefined, "completed"]);
  assert.equal(next({ relay: relay() }, "claude"), undefined, "no change of Harness or model, no switch");
  // The same executor went on, and the message still carried the conversation again, or went alone: said between it and itself.
  const again = next({ relay: relay({ packetId: packet, continuity: { kind: "native_resume_delta", tier: "full", runs: 1 }, decision: { kind: "carry", by: "policy", cause: "delivery_unconfirmed", resend: "auto" }, delivery: { state: "recorded", evidence: "E3" } }) }, "claude");
  assert.deepEqual([row(again), again?.from, again?.to], [["resend", "resumed", 1, "confirmed", packet, "completed"], { harnessId: "claude", harness: "Claude Code" }, { harnessId: "claude", harness: "Claude Code" }]);
  assert.deepEqual(row(next({ relay: relay({ decision: { kind: "alone", by: "user" } }) }, "claude")), ["none", "resumed", undefined, undefined, undefined, "completed"]);
  // A Run from before the relay kept facts says nothing of what was brought.
  assert.deepEqual(row(next({})), ["unknown", "unknown", undefined, undefined, undefined, "completed"]);
  // `from` is who ran the Turn before, `to` who runs this one, models as a person reads them.
  const item = next({ relay: relay() }, "claude", "claude-opus-5-5")!; assert.deepEqual([item.from, item.to], [{ harnessId: "claude", harness: "Claude Code" }, { harnessId: "claude", harness: "Claude Code", model: { id: "claude-opus-5-5", label: "Claude Opus 5.5", vendor: "Anthropic" } }]);
  // A model that changes and changes back is no switch.
  assert.equal(projectTurn(read([webRun(1, "claude"), webRun(2, "claude")]), 1, env()).items.some(item => item.type === "switch"), false);
});

test("a Turn still going: its calls say where they stand, its stop reason is not yet, and a decision it waits for is its status", () => {
  const running = webRun(1, "claude", { status: "running", backend: null, tools: [tool("a", "ls", { kind: "execute", status: "in_progress" }), tool("b", "Read a", { kind: "read", status: "pending" }), tool("c", "x", { kind: "other", status: "completed" })] });
  const turn = projectTurn(read([running], messagesOf(running, false)), 0, env());
  assert.equal(turn.status, "running"); assert.equal(turn.stopReason, undefined); assert.equal(turn.durationMs, undefined); assert.deepEqual(turn.items.map(item => item.status), ["completed", "running", "pending", "completed"]);
  assert.equal(projectTurn(read([running], messagesOf(running, false), { waiting: new Set([running.id]) }), 0, env()).status, "waiting");
  // Once over without a word on how a call ended, it is not taken to have completed; stopped, it was stopped.
  const over = (status: "completed" | "cancelled", over: Partial<WebRun> = {}) => projectTurn(read([webRun(1, "claude", { ...running, status, ...over })]), 0, env()).items.map(item => item.status);
  assert.deepEqual(over("completed"), ["completed", "unknown", "unknown", "completed", "completed"]); assert.deepEqual(over("cancelled", { cancelRequested: true, backend: { status: "cancelled", reason: "interrupted" } }), ["completed", "cancelled", "cancelled", "completed", "cancelled"]);
  assert.equal(projectTurn(read([webRun(1, "claude", { status: "cancelled", cancelRequested: true, backend: { status: "cancelled", reason: "interrupted" } })]), 0, env()).stopReason, "user_stopped");
  // A Turn queued or being prepared has no reply and no calls yet.
  for (const status of ["queued", "preparing"] as const) { const early = projectTurn(read([webRun(1, "claude", { status, backend: null, timing: { acceptedAt: 5 } })], []), 0, env()); assert.equal(early.status, status); assert.deepEqual(types(early), ["user_message"]); assert.equal(early.startedAt, 5); }
});

test("a call's stored detail that cannot be read is no error: the call is told by its title and the Turn is still whole", () => {
  const ref = { id: contentId("content-gone"), name: "t.json", mediaType: "application/json", kind: "file" as const, bytes: 1, sha256: "3".repeat(64) };
  const run = webRun(1, "dsh", { tools: [tool("a", "bash", { kind: "other", detail: ref }), tool("b", "read", { kind: "other", detail: ref })] });
  const turn = projectTurn(read([run]), 0, env());
  assert.deepEqual(turn.items.slice(1, 3).map(item => [item.type, item.type === "command" ? item.command : item.type === "file_read" ? item.path : ""]), [["command", ""], ["file_read", null]]);
  assert.deepEqual(turn.items[1]!.detail, ref);
});

test("the model a Run ran with: the one it named, a Hub Provider's first, else what the binding reported at the end of its latest Turn", () => {
  const binding = (model: string | null): NativeSessionBinding => ({ harnessId: "claude", controlId: "claude-acp", checkpoint: "c", throughRunId: null, status: "ready", observed: { model, options: {} } });
  const runs = [webRun(1, "claude"), webRun(2, "claude"), webRun(3, "claude", { selection: { harnessId: "claude", controlId: "claude-acp", nativeModel: "sonnet" } }), webRun(4, "claude", { selection: { harnessId: "claude", controlId: "claude-acp", provider: { providerId: "provider-1", revision: 1, model: "glm-5" } } })];
  const label = (list: readonly WebRun[], index: number, bindings: readonly NativeSessionBinding[] | undefined, modelName?: ProjectionEnv["modelName"]) => projectTurn(read(list, undefined, { nativeBindings: bindings }), index, env({ modelName })).executor.model?.label;
  assert.deepEqual(runs.map((_, index) => label(runs, index, [binding("claude-opus-5-5")])), [undefined, undefined, "Sonnet", "GLM 5"]);
  assert.equal(label(runs.slice(0, 2), 1, [binding("claude-opus-5-5")]), "Claude Opus 5.5"); assert.equal(label(runs.slice(0, 2), 0, [binding("claude-opus-5-5")]), undefined, "an earlier Turn's model is not known from what the binding said last");
  assert.equal(label(runs.slice(0, 2), 1, [binding(null)]), undefined); assert.equal(label(runs.slice(0, 2), 1, undefined), undefined);
  // The catalog's name for the model is what is shown when the Hub has it.
  assert.equal(label(runs.slice(0, 2), 1, [binding("opus")], (harnessId, native) => harnessId === "claude" && native === "opus" ? "Opus 5.5" : null), "Opus 5.5");
});

test("a long reasoning is carried whole: no length cuts it, and nothing says it was cut", () => {
  const long = "t".repeat(3 * 1024 * 1024), run = webRun(1, "claude", { thinking: long }), item = projectTurn(read([run]), 0, env()).items[1]!;
  assert.ok(item.type === "reasoning"); assert.equal(item.text.length, long.length); assert.equal(item.truncated, undefined); assert.equal(run.thinking!.length, long.length);
  const short = projectTurn(read([webRun(1, "claude", { thinking: "short" })]), 0, env()).items[1]!; assert.ok(short.type === "reasoning"); assert.equal(short.truncated, undefined);
  // Reasoning with no reply yet, in a Turn still going, is still going.
  const going = webRun(1, "claude", { thinking: "hmm", status: "running", backend: null }), early = projectTurn(read([going], messagesOf(going, false)), 0, env()).items[1]!; assert.equal(early.status, "running");
});

test("the Hub's clear is a context event, and a reply that does not exist yet is no item", () => {
  const cleared = projectTurn(read([webRun(1, "claude", { backend: { status: "completed", reason: "cleared" } })], []), 0, env());
  assert.deepEqual(types(cleared), ["user_message", "context_event"]); assert.equal(cleared.stopReason, "cleared"); assert.deepEqual(cleared.items[1], { id: "hh:clear", seq: 1, status: "completed", type: "context_event", kind: "clear" });
  assert.throws(() => projectTurn(read([]), 0, env()), RangeError);
  // The reply's item belongs to the Run's own reply, not to any message.
  const other: PublicMessage = { id: messageId("message-other"), runId: "run-9" as RunId, role: "assistant", text: "x", seq: 3, status: "completed" };
  assert.equal(projectTurn(read([webRun(1, "claude")], [other]), 0, env()).items.some(item => item.type === "assistant_message"), false);
  const item: ProtocolItem | undefined = projectTurn(read([webRun(1, "claude")]), 0, env()).items.at(-1); assert.ok(item?.type === "assistant_message" && item.phase === "final" && item.messageId === messageId("message-reply-1"));
});
