/*
 * FROZEN COPY (ADR-057 3.6, step-2 plan T2): taken from src/contexts/session/domain/relay/advance.ts as it was at the end of store v13 (commit 1a5f020), WITHOUT its bounds lifted.
 * The conversion of a v13 database (and the ladder from v1 to v13 that runs before it) reads old snapshots with exactly this code, so that nothing the
 * live code changes later (a bound opened, a field added) can change what an old snapshot means. Do not edit it and do not import a live parser into it;
 * tests/integration/legacy-parse.test.ts holds it to the live code on the repository's fixtures and holds this folder to its own imports.
 */
import type { ContextEffect } from "../../../contracts/control.js";
import type { PublicRun } from "../../../contracts/session.js";


/**
 * What a settled Turn's facts say, as pure rules (ADR-055 §7.6): what is known of its input reaching the native history, what
 * became of a command Turn and what it did to the native context, and which Runs count as dispatched. Nothing here reads a
 * clock, a store or a process.
 */

/** What is known of a dispatched Turn's input reaching the native history; no evidence is unknown, never not recorded. */
export type InputOutcome = "recorded" | "not_recorded" | "unknown";

/**
 * What became of a command Turn: executed (the native side ran it), not_recorded (it never reached the native side, or
 * the native side did not take it), noop (the native side took it and changed nothing) or unknown.
 */
export type CommandOutcome = "executed" | "not_recorded" | "noop" | "unknown";

/**
 * A command Turn's outcome from what the Runtime saw: never dispatched or reported not recorded, executed when its Harness
 * settled it as completed, noop when it completed and its driver read the native answer as a no-op (`noop`, from the
 * Turn's result), and unknown otherwise (no settlement, or a failure or cancellation that may have come before or after
 * the command ran).
 */
export function commandOutcome(dispatched: boolean, status: "completed" | "cancelled" | "failed" | null, input: InputOutcome, noop = false): CommandOutcome {
  if (!dispatched || input === "not_recorded") return "not_recorded";
  if (status !== "completed") return "unknown";
  return noop ? "noop" : "executed";
}

/**
 * The effect a command Turn had on the native context: its declared effect only when it was executed; none when it did not
 * run or changed nothing; unknown when its outcome is unknown, unless its declared effect leaves the context coherent
 * either way (keep, none).
 */
export function commandEffect(declared: ContextEffect, outcome: CommandOutcome): ContextEffect {
  switch (outcome) {
    case "executed": return declared;
    case "not_recorded": case "noop": return "none";
    case "unknown": return declared === "keep" || declared === "none" ? declared : "unknown";
  }
}

/**
 * Whether a Run was handed to its Harness. Session v10 and later record when (`timing.dispatchedAt`). A Run from before v10
 * has no times: it counts as dispatched when its Harness settled it or it ended unknown, since only those can have reached
 * a Harness (one that ended unknown before dispatch is counted too).
 */
export function dispatched(run: PublicRun): boolean {
  return run.timing === undefined ? run.backend !== null || run.status === "unknown" : run.timing.dispatchedAt !== undefined;
}
