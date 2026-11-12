import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { PermissionRequest, PublicRun, SelectionRequest, SessionConfiguration, SessionId } from "../../../src/contracts/session.js";
import type { LocalContentStore } from "../../../src/infrastructure/session/content-store.js";
import { reply, summary, type Hub } from "../relay-support.js";
import type { WatchedMount } from "./mount.js";
import { MODES, hubCell, outcome, type CellRow, type Mode, type StepRow, type StepTable } from "./table.js";
import { TASKS, TASK_IDS, type Built, type JudgeContext, type StepJudgement, type TaskId, type Verdict } from "./tasks.js";
import { classifyTool, hubCalls, summarizeTools, type ToolRecord } from "./tools.js";
import { oldShape } from "../../fixtures/old-shape.js";

/*
 * The relay ruler's driver (relay-task.real.ts, and the same code against fake Harnesses in the dry run): for each task and way
 * of running it builds a fresh repo, opens the Session through the Hub's formal Runtime, sends the task's two messages (changing
 * Harness between them, with the packet or without it, or not at all), answers the Harnesses' approvals once each, and has the
 * task's judge look at the repo after each step. What it records is the judge's findings and what the second step cost.
 */

/** What one cell needs of a Hub: the Runtime to drive, the Store to read the relay's records from, the content store for tool details. */
export interface CellHub extends Hub {
  readonly content: Pick<LocalContentStore, "read">;
  readonly configuration: SessionConfiguration;
  /** The watched mount the Hub's native processes get the context table from (HH_REAL_TABLE=1); absent: the table is not mounted and the evidence says nothing of it. */
  readonly table?: Pick<WatchedMount, "carried" | "hasTools">;
  close(): Promise<void>;
}
export interface CellSpec { readonly task: TaskId; readonly mode: Mode; readonly first: string; readonly second: string; readonly repeat: number }
export const routeOf = (spec: CellSpec): string => spec.first === spec.second ? spec.first : spec.first + ">" + spec.second;
export interface Plan {
  readonly tasks: readonly TaskId[];
  readonly modes: readonly Mode[];
  /** The two Harnesses of the relay; each is also run alone for the baseline. */
  readonly harnesses: readonly [string, string];
  /** Both directions of the hand-over (first to second and second to first), or only the first. */
  readonly both: boolean;
  readonly repeat: number;
}
/** The cells of a plan in the order they run: every task in every way of running, once, before any is repeated. */
export function planCells(plan: Plan): readonly CellSpec[] {
  const [a, b] = plan.harnesses, cells: CellSpec[] = [];
  for (let repeat = 1; repeat <= plan.repeat; repeat++) for (const task of TASK_IDS) {
    if (!plan.tasks.includes(task)) continue;
    for (const mode of MODES) {
      if (!plan.modes.includes(mode)) continue;
      const routes: readonly (readonly [string, string])[] = mode === "solo" ? [[a, a], [b, b]] : plan.both ? [[a, b], [b, a]] : [[a, b]];
      for (const [first, second] of routes) cells.push({ task, mode, first, second, repeat });
    }
  }
  return cells;
}
/** Every cell sends two messages. */
export const promptCount = (cells: readonly CellSpec[]): number => cells.length * 2;

export interface RulerOptions {
  /** A private directory; every cell lives in a directory of its own below it. */
  readonly root: string;
  readonly cells: readonly CellSpec[];
  /** Composes the Hub for one cell (a real application, or fakes). The workspace holds the repo; `data` is for the Hub's own store. */
  readonly open: (spec: CellSpec, where: { readonly workspace: string; readonly data: string }) => Promise<CellHub>;
  readonly select: (harnessId: string) => SelectionRequest;
  /** How long a step may run before it is cancelled (the script's backstop; the Runtime has its own execution budget). */
  readonly stepLimitMs: number;
  /** A step that reports more tokens than this ends the run. */
  readonly tokenLimit: number;
  /** The run ends after this many cells the script could not run (infrastructure, not the task). */
  readonly errorLimit: number;
  /** The run also ends after this many invalid cells in a row: a first step that never does what the second needs is something to fix, not to measure on. */
  readonly invalidLimit?: number;
  /** Told before each step is sent (the dry run's fake Harnesses need to know which step they play). */
  readonly announce?: (spec: CellSpec, built: Built, step: 1 | 2) => void;
  readonly log?: (line: string) => void;
  /** Called after each cell with all rows so far (the evidence is written here, so a run cut short keeps what it had). */
  readonly onRow?: (row: CellRow, rows: readonly CellRow[]) => Promise<void> | void;
}

/** A step past the token stop line ends the run. */
class StopLine extends Error {}
const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
/** `work`, or a rejection once `ms` has passed (the timer never outlives the work). */
async function within<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(what + " took longer than " + ms / 1000 + " s")), ms); })]); }
  finally { clearTimeout(timer); }
}
const TERMINAL = new Set<PublicRun["status"]>(["completed", "failed", "cancelled", "unknown"]);
/** What the script did about the Harnesses' own questions to the user. */
interface Approvals { allowed: number; questions: number; unanswered: number }
/**
 * The one-time allow of a native approval, never a standing rule (an "always", "session" or "remember" choice, or Claude Code's
 * "allow-with-updates", which writes a permission rule into the project's settings, would outlive the temporary repo): the first
 * option whose id starts like an allow and neither id nor name says it lasts. Claude Code offers allow-once, allow-with-updates
 * and reject; Codex accept, decline and cancel.
 */
export function oneTimeAllow(request: PermissionRequest): string | null {
  const choice = request.options.find(option => /^(allow|accept|approve|once|yes|proceed)/iu.test(option.id) && !/always|session|forever|remember|persist|updates?\b/iu.test(option.id + " " + option.name));
  return choice?.id ?? null;
}
/**
 * Waits until the Session's latest Turn is over, answering the native approvals that come up (the repo is the cell's own; the
 * allow is once). Past `limitMs` the Turn is cancelled. A question the Harness asks the user is answered with its first option
 * and counted, so a run that asks questions shows it.
 */
async function settle(hub: CellHub, id: SessionId, limitMs: number, approvals: Approvals): Promise<"settled" | "late"> {
  const deadline = Date.now() + limitMs, seen = new Set<string>();
  for (;;) {
    for (const request of hub.runtime.permissionRequests(id)) {
      if (request.decided || seen.has(request.id)) continue;
      seen.add(request.id);
      const question = request.kind === "question", option = question ? request.options[0]?.id ?? null : oneTimeAllow(request);
      if (option === null) { approvals.unanswered++; continue; }
      try { await hub.runtime.decidePermission(id, request.id, option, "decide-" + randomUUID()); if (question) approvals.questions++; else approvals.allowed++; }
      catch { approvals.unanswered++; }
    }
    const run = oldShape(hub.runtime, id).runs.at(-1)!;
    if (TERMINAL.has(run.status)) { await hub.runtime.wait(id); return "settled"; }
    if (Date.now() > deadline) { hub.runtime.cancel(id, "cancel-" + randomUUID()); await hub.runtime.wait(id); return "late"; }
    await delay(200);
  }
}
/** The Run's tool calls with the details the Runtime stored for them (input, output, paths); the summary alone where a detail was not kept. */
async function toolRecords(hub: CellHub, run: PublicRun): Promise<ToolRecord[]> {
  const records: ToolRecord[] = [];
  for (const tool of run.tools ?? []) {
    let stored: Record<string, unknown> = {};
    if (tool.detail !== undefined) {
      try { stored = JSON.parse(await readFile(hub.content.read(tool.detail.id).path, "utf8")) as Record<string, unknown>; } catch { /* not kept: the summary is what there is */ }
    }
    const text = (key: string): string | undefined => typeof stored[key] === "string" ? stored[key] : undefined;
    const input = text("input"), output = text("output"), diff = text("diff"), exitCode = typeof stored.exitCode === "number" ? stored.exitCode : tool.exitCode;
    const locations = Array.isArray(stored.locations) ? stored.locations.filter((item): item is string => typeof item === "string") : undefined;
    records.push({ id: tool.id, title: tool.title, status: tool.status, ...(tool.kind === undefined ? {} : { kind: tool.kind }), ...(tool.name === undefined ? {} : { name: tool.name }),
      ...(input === undefined ? {} : { input }), ...(output === undefined ? {} : { output }), ...(diff === undefined ? {} : { diff }), ...(locations === undefined ? {} : { locations }), ...(exitCode === undefined ? {} : { exitCode }) });
  }
  return records;
}
function describe(error: unknown): string {
  const code = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? "[" + error.code + "] " : "";
  return (code + (error instanceof Error ? error.message : String(error))).replace(/\s+/gu, " ").slice(0, 240);
}
const numeric = (record: Readonly<Record<string, unknown>> | undefined): Record<string, number> | null => {
  const entries = Object.entries(record ?? {}).filter((entry): entry is [string, number] => typeof entry[1] === "number");
  return entries.length === 0 ? null : Object.fromEntries(entries);
};

/** Runs every cell of the plan, one after another, and returns the rows. */
export async function runRuler(options: RulerOptions): Promise<readonly CellRow[]> {
  const rows: CellRow[] = [], log = options.log ?? (() => {});
  let failures = 0, invalid = 0;
  for (const [index, spec] of options.cells.entries()) {
    log("[" + (index + 1) + "/" + options.cells.length + "] " + TASKS[spec.task].letter + " " + spec.task + " " + spec.mode + " " + routeOf(spec) + (spec.repeat > 1 ? " #" + spec.repeat : ""));
    const done = await runCell(options, spec, index);
    rows.push(done.row);
    log("    " + outcome(done.row) + (done.row.error !== null ? ": " + done.row.error : done.row.invalid !== null ? ": " + done.row.invalid : done.row.problems.length ? ": " + done.row.problems.join(", ") : "") + " (" + Math.round(done.row.ms / 1000) + " s)");
    await options.onRow?.(done.row, rows);
    if (done.row.error !== null && !done.halt) failures++;
    invalid = outcome(done.row) === "INVALID" ? invalid + 1 : 0;
    if (done.halt) { log("stopping: a step went past the token stop line"); break; }
    if (failures >= options.errorLimit) { log("stopping: " + failures + " cells could not be run"); break; }
    if (invalid >= (options.invalidLimit ?? 4)) { log("stopping: " + invalid + " invalid cells in a row"); break; }
  }
  return rows;
}

async function runCell(options: RulerOptions, spec: CellSpec, index: number): Promise<{ readonly row: CellRow; readonly halt: boolean }> {
  const task = TASKS[spec.task], started = performance.now(), route = routeOf(spec);
  const cell = join(options.root, String(index + 1).padStart(2, "0") + "-" + spec.task + "-" + spec.mode + "-" + route.replace(">", "-to-")), workspace = join(cell, "workspace"), data = join(cell, "data");
  const steps: StepRow[] = [], replies: string[] = [], toolSets: ToolRecord[][] = [], earlier = new Set<string>();
  let hub: CellHub | undefined, built: Built | undefined, first: StepJudgement | null = null, verdict: Verdict | null = null;
  let valid = true, invalid: string | null = null, error: string | null = null, halt = false;
  try {
    await mkdir(workspace, { recursive: true });
    built = await task.build(workspace, randomBytes(4).toString("hex"));
    const prompts = task.prompts(built), repo = built;
    hub = await options.open(spec, { workspace, data });
    const open = hub, id = (await open.runtime.create(open.configuration, options.select(spec.first), "create-" + randomUUID())).id;
    const context = (): JudgeContext => ({ built: repo, replies, tools: toolSets, first });
    /** Sends one message and reads everything the judge and the table need of the Turn. */
    const step = async (n: 1 | 2, text: string, relay: { readonly attach: "none" } | undefined): Promise<StepRow> => {
      options.announce?.(spec, repo, n);
      const approvals: Approvals = { allowed: 0, questions: 0, unanswered: 0 }, began = performance.now(), sentAt = Date.now();
      open.runtime.send(id, text, "send-" + randomUUID(), [], relay);
      const ended = await settle(open, id, options.stepLimitMs, approvals), wallMs = Math.round(performance.now() - began), settledAt = Date.now();
      const state = oldShape(open.runtime, id), run = state.runs.at(-1)!;
      let digest: Record<string, unknown> | null = null;
      try { digest = summary(open, id, state, run); } catch { /* a Turn that failed before it prepared has no record to summarize */ }
      const records = await toolRecords(open, run), facts = records.map(tool => classifyTool(tool, workspace, repo.files)), tools = summarizeTools(facts, earlier);
      for (const file of [...tools.filesRead, ...tools.filesEdited]) earlier.add(file);
      const relayRecord = digest?.relay as Record<string, unknown> | null | undefined, used = run.usage?.turn === undefined ? null : run.usage.turn.total ?? ((run.usage.turn.input ?? 0) + (run.usage.turn.output ?? 0));
      const said = reply(state, run);
      // The Hub's tools to this step: whether its process had the table, whether its Harness holds the tool entry, whether the packet said so, and what it called.
      const table: StepTable | null = open.table === undefined ? null : { carried: open.table.carried(id, run.selection.harnessId, sentAt, settledAt), tools: await open.table.hasTools(run.selection.harnessId),
        told: relayRecord?.hubTools === true, ...hubCalls(records) };
      replies.push(said); toolSets.push(records);
      const row: StepRow = { n, harness: run.selection.harnessId, status: run.status, error: run.error?.code ?? null, timedOut: ended === "late", wallMs,
        prepareMs: run.timing?.dispatchedAt !== undefined && run.timing.preparingAt !== undefined ? run.timing.dispatchedAt - run.timing.preparingAt : null,
        turnMs: run.timing?.endedAt !== undefined && run.timing.dispatchedAt !== undefined ? run.timing.endedAt - run.timing.dispatchedAt : null,
        tokens: used, usage: numeric(run.usage?.turn as Readonly<Record<string, unknown>> | undefined), tools,
        handoff: relayRecord == null || relayRecord.kind === undefined ? null : { kind: relayRecord.kind, tokens: relayRecord.tokens, tier: relayRecord.tier, complete: relayRecord.complete, turns: relayRecord.turns, items: relayRecord.items, carriedRuns: run.sourceRunIds.length },
        approvals, reply: said.slice(0, 600), relay: digest, table };
      steps.push(row);
      options.log?.("    step " + n + " " + row.harness + ": " + row.status + " in " + Math.round(wallMs / 1000) + " s, " + tools.total + " tools" + (row.handoff === null ? "" : ", handoff " + String(row.handoff.tokens) + " tok")
        + (table === null ? "" : ", hub " + hubCell(table)));
      if (used !== null && used > options.tokenLimit) { halt = true; throw new StopLine("a step reported " + used + " tokens, past the " + options.tokenLimit + " stop line"); }
      return row;
    };

    const one = await step(1, prompts[0], undefined);
    if (one.status !== "completed") { valid = false; invalid = "step 1 ended " + one.status + (one.error === null ? "" : " (" + one.error + ")"); }
    else {
      first = await task.judgeFirst(context());
      if (!first.valid) { valid = false; invalid = first.why ?? "step 1 did not do what step 2 needs"; }
    }
    if (valid) {
      if (spec.second !== spec.first) {
        open.runtime.switch(id, options.select(spec.second), "switch-" + randomUUID());
        await within(open.runtime.wait(id), options.stepLimitMs, "the switch to " + spec.second);
        if (oldShape(open.runtime, id).selection.harnessId !== spec.second) throw new Error("the switch to " + spec.second + " did not take effect");
      }
      const two = await step(2, prompts[1], spec.mode === "floor" ? { attach: "none" } : undefined);
      verdict = await task.judgeFinal(context());
      if (two.status !== "completed") verdict = { problems: ["step2-" + two.status, ...verdict.problems], checks: verdict.checks };
    }
  } catch (caught) { error = describe(caught); }
  finally { if (hub !== undefined) { try { await hub.close(); } catch (caught) { error ??= "closing the Hub failed: " + describe(caught); } } }
  const row: CellRow = { task: spec.task, mode: spec.mode, route, repeat: spec.repeat, valid: valid && error === null, invalid, problems: verdict?.problems ?? [], firstChecks: first?.checks ?? {}, checks: verdict?.checks ?? {},
    steps, error, ms: Math.round(performance.now() - started) };
  return { row, halt };
}
