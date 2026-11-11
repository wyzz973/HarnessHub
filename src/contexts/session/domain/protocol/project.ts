import type { ContentRef } from "../../../../contracts/content.js";
import {
  PROTOCOL_VERSION, type ArtifactItem, type AssistantMessageItem, type ContextEventItem, type ErrorItem, type Executor, type ItemStatus, type NoticeItem, type PlanItem,
  type PlanStep, type ProtocolItem, type ProtocolTurn, type ReasoningItem, type SubagentItem, type SwitchItem, type UserMessageItem,
} from "../../../../contracts/protocol.js";
import type { NativeSessionBinding, PublicMessage } from "../../../../contracts/session.js";
import type { WebRun } from "../../../../contracts/web.js";
import type { ToolDetailInput } from "./changes.js";
import { modelLabel } from "./models.js";
import { errorClass, runEnded, runItemStatus, stopReason, turnStatus } from "./status.js";
import { normalizeTool, planFromInput, plainTool } from "./tools.js";
import { turnUsage } from "./usage.js";

/**
 * What the Hub already stores of one Run, as a protocol Turn (docs/proposals/protocol/hub-protocol.html §4–§5; step 1 of §17): the
 * conversation is not stored in the protocol's shape yet, so this reads it into it. The items follow the order the interface has
 * always drawn a Run in, not the time things happened (that needs the order stored, which is step 2): the switch before the Turn,
 * the user's words, the reasoning, the tool calls in the order they were first seen, the plan, the notices, the reply, the error,
 * the artifacts, the context events. Pure: what it reads of stored tool details comes through `env.detail`, ahead of time.
 */

/** What the projection needs of a conversation: its Runs in order (as the web view shows them, with the relay's delivery state read in), its messages, its native bindings. */
export interface ProjectionInput {
  readonly runs: readonly WebRun[];
  readonly messages: readonly PublicMessage[];
  /** For the model a Harness reported it ran when its Run did not name one. */
  readonly nativeBindings?: readonly NativeSessionBinding[] | undefined;
  /** The Runs that wait for the user's decision now. */
  readonly waiting?: ReadonlySet<string> | undefined;
}
export interface ProjectionEnv {
  /** A Harness's display name by its id (its catalog name); null when it has none, and the id is shown. */
  readonly harnessName: (harnessId: string) => string | null;
  /** The display name the Harness's own model catalog gives a native model, when the Hub has read it. */
  readonly modelName?: ((harnessId: string, nativeModel: string) => string | null | undefined) | undefined;
  /** The head of a tool call's stored detail; null when it cannot be read now (not an error: the call is then told by its title). Synchronous; never throws. */
  readonly detail: (ref: ContentRef) => ToolDetailInput | null;
}

/** How much of a Turn's reasoning one Turn of the protocol carries; the rest is in the Run's own `thinking`. */
export const REASONING_MAX = 64 * 1024;

/** The Harness and control that last dispatched a Run, by Harness and control: only that Run's model is known from what its binding reported at the end. */
function latestDispatched(runs: readonly WebRun[]): ReadonlyMap<string, string> {
  const latest = new Map<string, string>();
  for (const run of runs) if (run.timing?.dispatchedAt !== undefined || (run.timing === undefined && run.backend !== null)) latest.set(run.selection.harnessId + "\n" + run.selection.controlId, run.id);
  return latest;
}
/** The model a Run ran with as far as the record says: the one its selection named (a Hub Provider's model first, as the interface has always shown it), else the one its binding reported when this was its last Turn. */
function nativeModelOf(run: WebRun, bindings: readonly NativeSessionBinding[], latest: ReadonlyMap<string, string>): string | undefined {
  const named = run.selection.provider?.model ?? run.selection.nativeModel;
  if (named !== undefined && named.trim() !== "") return named;
  if (latest.get(run.selection.harnessId + "\n" + run.selection.controlId) !== run.id) return undefined;
  const observed = bindings.find(row => row.harnessId === run.selection.harnessId && row.controlId === run.selection.controlId && row.status !== "archived")?.observed?.model;
  return typeof observed === "string" && observed.trim() !== "" ? observed : undefined;
}
function executorOf(run: WebRun, bindings: readonly NativeSessionBinding[], latest: ReadonlyMap<string, string>, env: ProjectionEnv): Executor {
  const harnessId = run.selection.harnessId, native = nativeModelOf(run, bindings, latest);
  return { harnessId, harness: env.harnessName(harnessId) ?? harnessId, ...(native === undefined ? {} : { model: modelLabel(harnessId, native, env.modelName?.(harnessId, native) ?? null) }) };
}

/** Whether the Harness or the model changed from one Run to the next (the interface's own test of where a hand-over line goes). */
function changed(previous: WebRun, run: WebRun): boolean {
  return previous.selection.harnessId !== run.selection.harnessId || previous.selection.nativeModel !== run.selection.nativeModel || previous.selection.provider?.model !== run.selection.provider?.model;
}
/**
 * What the Run brought along from the executor before it, read from the relay facts the Run carries (web/src/lib/relay-state.ts read
 * the same ones for the divider; this is that derivation moved here). A Run with no relay facts is from before the relay kept any:
 * nothing is claimed of it.
 */
function switchOf(run: WebRun, from: Executor, to: Executor, seq: number): SwitchItem {
  const relay = run.relay, ended = runEnded(run.status);
  if (relay === undefined) return { id: "hh:switch", seq, status: "completed", type: "switch", from, to, context: "unknown", session: "unknown" };
  const level = relay.continuity, decision = relay.decision, packetId = relay.packetId;
  const session: SwitchItem["session"] = level.kind === "rehydrate" || level.kind === "native_cleared" || level.kind === "native_fork" ? "new" : level.kind === "blocked" ? "unknown" : "resumed";
  let context: SwitchItem["context"], turns: number | undefined;
  if (packetId !== null) {
    // The same facts again are a resend whatever carried them; a packet for newer facts that also holds the unconfirmed one is what the target had missed.
    const resent = decision?.kind === "carry" && (decision.resend === "auto" || decision.resend === "all");
    if (resent) context = "resend";
    else if (level.kind === "native_resume_delta") context = "delta";
    else context = "full";
    turns = level.kind === "native_resume_delta" ? level.runs : run.sourceRunIds.length || undefined;
  } else if (level.kind === "native_cleared" || level.kind === "blocked" || run.backend?.reason === "cleared" || decision?.kind === "alone") context = "none";
  else context = "native";
  // What is known of the packet's arrival; a state nothing settled is "unconfirmed" once the Turn is over.
  let delivery: SwitchItem["delivery"];
  if (packetId !== null) {
    switch (relay.delivery?.state) {
      case "recorded": delivery = "confirmed"; break;
      case "not_recorded": delivery = "not_sent"; break;
      case "in_flight": case "unknown": case undefined: delivery = ended ? "unconfirmed" : "sending"; break;
    }
  }
  const status: ItemStatus = delivery === "sending" ? "running" : delivery === "unconfirmed" ? "unknown" : delivery === "not_sent" ? "failed" : "completed";
  return { id: "hh:switch", seq, status, type: "switch", from, to, context, ...(turns === undefined ? {} : { turns }), session,
    ...(delivery === undefined ? {} : { delivery }), ...(packetId === null ? {} : { packetId }) };
}

/** The task list a Turn shows: the Harness's own plan when it reported one, else the last task-list call whose input reads exactly. */
function planOf(run: WebRun, derived: readonly PlanStep[] | null, seq: number, ended: boolean): PlanItem | null {
  const status: ItemStatus = ended ? "completed" : "running";
  if (run.plan !== undefined) return { id: "hh:plan", seq, status, type: "plan", steps: run.plan.entries.map(entry => ({ text: entry.content, status: entry.status })), ...(run.plan.explanation === undefined ? {} : { explanation: run.plan.explanation }) };
  return derived === null ? null : { id: "hh:plan", seq, status, type: "plan", steps: derived };
}

/** One Turn of the conversation, `index` counting from 0. */
export function projectTurn(input: ProjectionInput, index: number, env: ProjectionEnv, latest: ReadonlyMap<string, string> = latestDispatched(input.runs)): ProtocolTurn {
  const run = input.runs[index];
  if (run === undefined) throw new RangeError("no Run " + index);
  const bindings = input.nativeBindings ?? [], ended = runEnded(run.status), cancelled = run.status === "cancelled", previous = index > 0 ? input.runs[index - 1] : undefined;
  const executor = executorOf(run, bindings, latest, env);
  const items: ProtocolItem[] = [];
  const seq = () => items.length;

  if (previous !== undefined && changed(previous, run)) items.push(switchOf(run, executorOf(previous, bindings, latest, env), executor, seq()));
  const user: UserMessageItem = { id: "hh:user", seq: seq(), status: "completed", type: "user_message", messageId: run.userMessageId };
  items.push(user);
  if (run.thinking !== undefined && run.thinking !== "") {
    const reasoning: ReasoningItem = { id: "hh:reasoning", seq: seq(), status: ended || input.messages.some(message => message.id === run.assistantMessageId) ? "completed" : "running", type: "reasoning",
      text: run.thinking.length > REASONING_MAX ? run.thinking.slice(0, REASONING_MAX) : run.thinking, ...(run.thinking.length > REASONING_MAX ? { truncated: true as const } : {}) };
    items.push(reasoning);
  }

  // The calls, in the order they were first seen. A task-list call is the Turn's plan and not a row; one that cannot be read as a plan stays a row.
  let derived: readonly PlanStep[] | null = null;
  const toolIds = new Set((run.tools ?? []).map(tool => tool.id));
  for (const tool of run.tools ?? []) {
    const detail = tool.detail === undefined ? null : env.detail(tool.detail), context = { seq: seq(), detail, turn: cancelled ? "cancelled" as const : ended ? "ended" as const : "going" as const };
    const result = normalizeTool(tool, context);
    if (result.row) { items.push(result.item); continue; }
    const steps = run.plan === undefined ? planFromInput(detail?.input) : null;
    if (run.plan !== undefined || steps !== null) { if (steps !== null) derived = steps; continue; }
    items.push(plainTool(tool, context));
  }
  // A sub-agent the Harness reports as an activity too (Codex does) is the call already listed.
  for (const activity of run.activities ?? []) {
    if ((activity.kind !== "subagent" && activity.kind !== "task") || toolIds.has(activity.id) || toolIds.has("agent:" + activity.id.slice(0, 200))) continue;
    const item: SubagentItem = { id: "hh:subagent:" + activity.id, seq: seq(), status: activity.status, type: "subagent", title: activity.title };
    items.push(item);
  }
  const plan = planOf(run, derived, seq(), ended);
  if (plan !== null) items.push(plan);

  // Notices. A failure the Run also reports as its error is told once, as the error.
  (run.notices ?? []).forEach((notice, at) => {
    if (notice.severity === "error") {
      if (run.error !== null) return;
      const error: ErrorItem = { id: "hh:notice:" + at, seq: seq(), status: "failed", type: "error", class: "unknown", message: notice.detail === undefined ? notice.title : notice.title + "\n" + notice.detail };
      items.push(error); return;
    }
    const item: NoticeItem = { id: "hh:notice:" + at, seq: seq(), status: "completed", type: "notice", severity: notice.severity, text: notice.title, ...(notice.detail === undefined ? {} : { more: notice.detail }) };
    items.push(item);
  });
  for (const activity of run.activities ?? []) {
    if (activity.kind !== "retry" && activity.kind !== "review") continue;
    const item: NoticeItem = { id: "hh:" + activity.kind + ":" + activity.id, seq: seq(), status: activity.status, type: "notice", severity: activity.kind === "retry" ? "warning" : "info", code: activity.kind,
      text: activity.title, ...(activity.detail === undefined ? {} : { more: activity.detail }) };
    items.push(item);
  }

  const reply = input.messages.find(message => message.id === run.assistantMessageId && message.role === "assistant");
  if (reply !== undefined) { const item: AssistantMessageItem = { id: "hh:reply", seq: seq(), status: runItemStatus(reply.status), type: "assistant_message", messageId: reply.id, phase: "final" }; items.push(item); }
  if (run.error !== null && (run.status === "failed" || run.status === "unknown")) {
    const error: ErrorItem = { id: "hh:error", seq: seq(), status: "failed", type: "error", class: errorClass(run.error.code), code: run.error.code, message: run.error.message };
    items.push(error);
  }
  (run.outputs ?? []).forEach((output, at) => {
    const item: ArtifactItem = output.kind === "content"
      ? { id: "hh:artifact:" + at, seq: seq(), status: "completed", type: "artifact", kind: output.content.kind === "image" ? "image" : "file", name: output.content.name, content: output.content }
      : { id: "hh:artifact:" + at, seq: seq(), status: "completed", type: "artifact", kind: "link", name: output.title ?? output.name, uri: output.uri };
    items.push(item);
  });
  for (const activity of run.activities ?? []) {
    if (activity.kind !== "compaction") continue;
    const item: ContextEventItem = { id: "hh:context:" + activity.id, seq: seq(), status: activity.status, type: "context_event", kind: "compaction" };
    items.push(item);
  }
  if (run.backend?.reason === "cleared") { const item: ContextEventItem = { id: "hh:clear", seq: seq(), status: "completed", type: "context_event", kind: "clear" }; items.push(item); }

  const reason = stopReason(run), timing = run.timing;
  return { version: PROTOCOL_VERSION, runId: run.id, n: index + 1, status: turnStatus(run.status, input.waiting?.has(run.id) === true), ...(reason === undefined ? {} : { stopReason: reason }), executor,
    usage: turnUsage(run.selection.harnessId, run.usage, run.status), ...(timing === undefined ? {} : { startedAt: timing.acceptedAt }),
    ...(ended && timing?.endedAt !== undefined ? { durationMs: Math.max(0, timing.endedAt - timing.acceptedAt) } : {}), items };
}

/** Every Turn of the conversation, in order. The newest Turn's details are read first, so that a conversation too long to read in full shows its latest Turns whole. */
export function projectTurns(input: ProjectionInput, env: ProjectionEnv): readonly ProtocolTurn[] {
  const latest = latestDispatched(input.runs), turns = new Array<ProtocolTurn>(input.runs.length);
  for (let index = input.runs.length - 1; index >= 0; index--) turns[index] = projectTurn(input, index, env, latest);
  return turns;
}
