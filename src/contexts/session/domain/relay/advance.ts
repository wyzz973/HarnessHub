import type { ContextEffect } from "../../../../contracts/control.js";
import type { PublicRun } from "../../../../contracts/session.js";

/**
 * The v12 transition rules of the relay (ADR-055 §7.6, P0): Session v12 has one native position per binding
 * (`throughRunId`), and these pure rules decide when a settled Turn moves it, what a command Turn did to the native context,
 * and which Runs count as dispatched. v13 replaces the position rule by delivery watermarks; nothing here reads a clock,
 * a store or a process.
 */

/** What is known of a dispatched Turn's input reaching the native history; no evidence is unknown, never not recorded. */
export type InputOutcome = "recorded" | "not_recorded" | "unknown";

/** The facts of one settled Turn on its binding that decide whether the binding's native position moves to it. */
export interface TurnFacts {
  /** The input was handed to the Harness (`run.dispatched` was committed). */
  readonly dispatched: boolean;
  /**
   * How many public facts the Turn owed its binding when it started (the due set); the history a branch or an import
   * started from counts as one while the binding's native session does not hold it.
   */
  readonly due: number;
  /** The Turn sent those facts with its input instead of the input alone. */
  readonly carried: boolean;
  readonly input: InputOutcome;
  /** The Turn sent again what an earlier Turn on the binding carried with an unknown outcome (`relayResendOf`). */
  readonly resend: boolean;
}

/**
 * advance ⇔ dispatched ∧ (due = ∅ ∨ carried ∧ (input = recorded ∨ input = unknown ∧ resent once)). Without facts owed,
 * every dispatched Turn advances, one the native side never took included, so the next Turn goes unchanged. With facts
 * owed, a command or an input sent alone never advances, a carried Turn advances once recorded, and an unknown one only
 * after it was sent again once (which can deliver the facts twice; v13 checks instead). A not recorded one never advances.
 */
export function advances(turn: TurnFacts): boolean {
  if (!turn.dispatched) return false;
  if (turn.due === 0) return true;
  if (!turn.carried) return false;
  switch (turn.input) {
    case "recorded": return true;
    case "unknown": return turn.resend;
    case "not_recorded": return false;
  }
}

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
