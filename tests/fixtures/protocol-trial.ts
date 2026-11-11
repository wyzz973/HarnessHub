// The trial conversation of 2026-11-11 (tests/fixtures/protocol/trial-2026-11-11.json) as the Hub stored it: eleven Turns of five
// Harnesses, as public Runs with their tool calls and the heads of their stored details. Real events; only the helpers are new.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { detailHead, type ToolDetailInput } from "../../src/contexts/session/domain/protocol/index.js";
import { contentId, type ContentRef } from "../../src/contracts/content.js";
import type { NativeUsage } from "../../src/contracts/control.js";
import { commandId, messageId, runId, type PublicMessage, type PublicTool, type RunStatus } from "../../src/contracts/session.js";
import type { WebRun } from "../../src/contracts/web.js";

export interface TrialTool {
  readonly statuses: readonly string[]; readonly title: string; readonly kind?: string; readonly name?: string; readonly exitCode?: number;
  readonly detail?: Readonly<Record<string, unknown>>;
}
export interface TrialRun {
  readonly n: number; readonly harnessId: string; readonly nativeModel: string | null; readonly status: string;
  readonly backend: { readonly status: "completed" | "cancelled" | "failed"; readonly reason: string };
  readonly usage: Readonly<Record<string, unknown>>; readonly tools: readonly TrialTool[];
}
export const TRIAL: { readonly runs: readonly TrialRun[] } = JSON.parse(readFileSync(fileURLToPath(new URL("../../../tests/fixtures/protocol/trial-2026-11-11.json", import.meta.url)), "utf8")) as { runs: TrialRun[] };
export const WORKSPACE = "/Users/me/.cache/harnesshub-acceptance/trial/workspace/";

function ref(n: number, index: number): ContentRef { return { id: contentId("content-trial-" + n + "-" + index), name: "tool-" + index + ".json", mediaType: "application/json", kind: "file", bytes: 1, sha256: "0".repeat(64) }; }
/** A tool call of the trial as the Run stored it (its last status, a reference to its detail when it has one) and the head of that detail by the reference's id. */
export function trialTools(run: TrialRun): { readonly tools: PublicTool[]; readonly heads: Map<string, ToolDetailInput> } {
  const heads = new Map<string, ToolDetailInput>();
  const tools = run.tools.map((entry, index): PublicTool => {
    const stored = entry.detail === undefined ? undefined : ref(run.n, index);
    if (stored !== undefined) heads.set(stored.id, detailHead(entry.detail)!);
    return { id: "tool-" + run.n + "-" + index, title: entry.title, status: entry.statuses.at(-1)!, ...(entry.kind === undefined ? {} : { kind: entry.kind }), ...(entry.name === undefined ? {} : { name: entry.name }),
      ...(entry.exitCode === undefined ? {} : { exitCode: entry.exitCode }), ...(stored === undefined ? {} : { detail: stored }) };
  });
  return { tools, heads };
}

/** A public Run as the web view carries it, with the fields the tests do not care about filled in; `over` replaces any of them. */
export function webRun(n: number, harnessId: string, over: Partial<WebRun> = {}, status: RunStatus = "completed"): WebRun {
  return { id: runId("run-" + n), commandId: commandId("send-" + n), input: "input " + n, userMessageId: messageId("message-user-" + n), assistantMessageId: messageId("message-reply-" + n),
    selection: { harnessId, controlId: harnessId + "-acp" }, epoch: 1, status, cancelRequested: false, contextThroughSeq: 0, sourceRunIds: [], backend: { status: "completed", reason: "end_turn" },
    cleanup: null, error: null, stopRequested: false, awaitingSwitchId: null, timing: { acceptedAt: n * 1000, dispatchedAt: n * 1000 + 10, endedAt: n * 1000 + 600 }, ...over };
}
/** The user's message and (with a reply) the assistant's of a Run. */
export function messagesOf(run: WebRun, reply = true): PublicMessage[] {
  return [{ id: run.userMessageId, runId: run.id, role: "user", text: run.input, seq: 1, status: run.status },
    ...(reply ? [{ id: run.assistantMessageId, runId: run.id, role: "assistant" as const, text: "reply to " + run.input, seq: 2, status: run.status }] : [])];
}

/** The whole trial conversation as Runs of the web view, with its messages and the heads of its stored details. */
export function trialConversation(): { readonly runs: WebRun[]; readonly messages: PublicMessage[]; readonly heads: Map<string, ToolDetailInput> } {
  const heads = new Map<string, ToolDetailInput>(), runs: WebRun[] = [], messages: PublicMessage[] = [];
  for (const entry of TRIAL.runs) {
    const { tools, heads: own } = trialTools(entry);
    for (const [id, head] of own) heads.set(id, head);
    const run = webRun(entry.n, entry.harnessId, { backend: entry.backend, ...(entry.nativeModel === null ? {} : { selection: { harnessId: entry.harnessId, controlId: entry.harnessId + "-acp", nativeModel: entry.nativeModel } }),
      usage: entry.usage as NativeUsage, ...(tools.length ? { tools } : {}) });
    runs.push(run); messages.push(...messagesOf(run));
  }
  return { runs, messages, heads };
}
