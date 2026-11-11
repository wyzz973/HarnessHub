import type { TaskId } from "./tasks.js";
import type { ToolSummary } from "./tools.js";

/*
 * The ruler's rows (one per task, way of running and route, relay-task.real.ts) and the small table printed from them. A row
 * says what the judge found and what the second step cost; the table is the same facts in a line each, and a summary of the
 * three ways of running: alone on one Harness (the baseline), handed over with the packet (the relay), handed over without it (the floor).
 */

/** `solo`: one Harness throughout. `relay`: the second step on the other Harness, the relay attaching what it owes. `floor`: the same, with the packet switched off. */
export type Mode = "solo" | "relay" | "floor";
export const MODES: readonly Mode[] = ["solo", "relay", "floor"];
/**
 * What the Hub's tools were to a step (HH_REAL_TABLE=1; docs/verification/relay-ruler.md): whether the Harness's process had them to call,
 * whether the packet said so, and what the step called. Whether the tool entry is in the Harness's configuration is the manager's to
 * settle before the run (the ruler installs nothing); this only records it, as the Hub saw it when the step ended.
 */
export interface StepTable {
  /** The step's native process was started with the table's environment (the Hub's address and a token of its own). */
  readonly carried: boolean;
  /** The Harness's configuration holds the Hub's tool entry as the Hub writes it: the fact the packet's sentences rest on. */
  readonly tools: boolean;
  /** The packet the step carried told its Harness how to read the rest back (false when it carried none). */
  readonly told: boolean;
  /** The Hub's tools the step called: how many calls, and which tool each was, in order. */
  readonly calls: number;
  readonly called: readonly string[];
}
export interface StepRow {
  readonly n: 1 | 2;
  readonly harness: string;
  readonly status: string;
  readonly error: string | null;
  readonly timedOut: boolean;
  /** From the script's send to the Session settling, and the Runtime's own preparing and running times. */
  readonly wallMs: number;
  readonly prepareMs: number | null;
  readonly turnMs: number | null;
  /** The Turn's total tokens as the Harness reported them (cached reads included), and its usage fields. */
  readonly tokens: number | null;
  readonly usage: Readonly<Record<string, number>> | null;
  readonly tools: ToolSummary;
  /** The packet the Turn carried: what the Hub decided to hand over and its estimated size; null when it carried none. */
  readonly handoff: { readonly kind: unknown; readonly tokens: unknown; readonly tier: unknown; readonly complete: unknown; readonly turns: unknown; readonly items: unknown; readonly carriedRuns: number } | null;
  readonly approvals: { readonly allowed: number; readonly questions: number; readonly unanswered: number };
  /** The start of the reply (the synthetic repo and the replies about it carry nothing private). */
  readonly reply: string;
  /** What the relay recorded around the Turn (relay-support's `summary`), for the cases the numbers above do not explain. */
  readonly relay: Readonly<Record<string, unknown>> | null;
  /** The Hub's tools to this step; null when the run did not mount the table (HH_REAL_TABLE is not set). */
  readonly table: StepTable | null;
}
export interface CellRow {
  readonly task: TaskId;
  readonly mode: Mode;
  readonly route: string;
  readonly repeat: number;
  /** The cell measures the bridge: false when the first step did not do what the second needs (or did not run). */
  readonly valid: boolean;
  readonly invalid: string | null;
  /** What went wrong with the task, in short names; empty when it was done as asked. */
  readonly problems: readonly string[];
  readonly firstChecks: Readonly<Record<string, unknown>>;
  readonly checks: Readonly<Record<string, unknown>>;
  readonly steps: readonly StepRow[];
  /** The script could not run the cell (not a verdict on the task): the reason. */
  readonly error: string | null;
  readonly ms: number;
}
export type Outcome = "PASS" | "FAIL" | "INVALID" | "ERROR";
export function outcome(row: CellRow): Outcome {
  return row.error !== null ? "ERROR" : !row.valid ? "INVALID" : row.problems.length === 0 ? "PASS" : "FAIL";
}

const seconds = (ms: number | null | undefined): string => ms === null || ms === undefined ? "-" : String(Math.round(ms / 1000));
const thousands = (value: number | null | undefined): string => value === null || value === undefined ? "-" : Math.round(value / 1000) + "k";
const count = (value: number | null | undefined): string => value === null || value === undefined ? "-" : String(value);
function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right), middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
const number = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
/** A step's table in a cell: how far the Hub's tools reached the process (no-env, env, tools, tools+told), then how many it called and which (`2:read_turn,search`). */
export function hubCell(table: StepTable | null | undefined): string {
  if (table === null || table === undefined) return "-";
  const reach = !table.carried ? "no-env" : !table.tools ? "env" : table.told ? "tools+told" : "tools";
  return reach + " " + (table.calls === 0 ? "0" : table.calls + ":" + table.called.map(name => name.replace(/^hub_/u, "")).join(","));
}
/** A left-aligned table: the first row is the header. */
function layout(table: readonly (readonly string[])[]): string {
  const widths = table[0]!.map((_, column) => Math.max(...table.map(row => (row[column] ?? "").length)));
  return table.map(row => row.map((cell, column) => cell.padEnd(widths[column]!)).join("  ").trimEnd()).join("\n");
}

/** One line per cell, then one per task and way of running (medians over the cells that measured the bridge: both routes, every repeat). */
export function renderTable(rows: readonly CellRow[]): string {
  // The Hub's tools get a column only in a run that mounted the table: a run without it prints the table it always did.
  const hub = rows.some(row => row.steps.some(step => step.table !== null));
  const cells: string[][] = [["task", "mode", "route", "result", "problems", "s2 tools", "reads", "reread", "tests", "explore", "handoff", "s1 s", "s2 s", "s2 tokens", ...(hub ? ["s2 hub"] : [])]];
  for (const row of rows) {
    const second = row.steps[1], tools = second?.tools, handoff = second?.handoff ?? null;
    cells.push([row.task, row.mode, row.route + (row.repeat > 1 ? " #" + row.repeat : ""), outcome(row), row.error !== null ? row.error.slice(0, 48) : row.invalid !== null ? row.invalid.slice(0, 48) : row.problems.join(",") || "-",
      count(tools?.total), count(tools?.filesRead.length), count(tools?.reread.length), count(tools?.testRuns), count(tools?.explore),
      handoff === null ? "-" : count(number(handoff.tokens)) + " tok", seconds(row.steps[0]?.wallMs), seconds(second?.wallMs), thousands(second?.tokens), ...(hub ? [hubCell(second?.table)] : [])]);
  }
  const summary: string[][] = [["task", "mode", "cells", "pass", "fail", "invalid", "error", "s2 tools", "reads", "reread", "explore", "handoff tok", "s2 s", ...(hub ? ["hub calls"] : [])]];
  for (const task of [...new Set(rows.map(row => row.task))]) for (const mode of MODES) {
    const mine = rows.filter(row => row.task === task && row.mode === mode);
    if (mine.length === 0) continue;
    const measured = mine.filter(row => row.valid && row.error === null && row.steps.length === 2);
    const med = (pick: (step: StepRow) => number | null): string => { const value = median(measured.flatMap(row => { const found = pick(row.steps[1]!); return found === null ? [] : [found]; })); return value === null ? "-" : String(Math.round(value * 10) / 10); };
    summary.push([task, mode, String(mine.length), String(mine.filter(row => outcome(row) === "PASS").length), String(mine.filter(row => outcome(row) === "FAIL").length),
      String(mine.filter(row => outcome(row) === "INVALID").length), String(mine.filter(row => outcome(row) === "ERROR").length),
      med(step => step.tools.total), med(step => step.tools.filesRead.length), med(step => step.tools.reread.length), med(step => step.tools.explore),
      med(step => number(step.handoff?.tokens)), med(step => step.wallMs / 1000), ...(hub ? [med(step => step.table === null ? null : step.table.calls)] : [])]);
  }
  return layout(cells) + "\n\nby task and way of running (medians of the second step, over the cells that measured the bridge)\n" + layout(summary) + "\n";
}
