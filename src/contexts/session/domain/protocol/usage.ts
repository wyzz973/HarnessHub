import type { NativeUsage } from "../../../../contracts/control.js";
import type { TurnUsage } from "../../../../contracts/protocol.js";
import type { RunStatus } from "../../../../contracts/session.js";

/**
 * A Turn's usage in the protocol's one meaning (docs/proposals/protocol/hub-protocol.html §5): `input` is everything the Turn's
 * model requests read, the cached part included; `output` is everything they generated, reasoning included. The Drivers pass on
 * what each Harness reports, and the Harnesses do not mean the same by it, so each is read here by what it is known to mean. Each
 * row says how it was settled; a row that is not settled by a real report is marked, and the totals the Harnesses report themselves
 * (`total`) agree with every row below (the trial conversation's numbers, tests/fixtures/protocol/trial-2026-11-11.json).
 * Pure.
 */

/** `inside`: the number already contains that part (Codex's `input` contains `cachedInput`); `beside`: it is reported in addition and is added. */
interface Meaning { readonly cache: "inside" | "beside"; readonly reasoning: "inside" | "beside" }

const MEANING: ReadonlyMap<string, Meaning> = new Map(Object.entries({
  // Codex (codex.ts:924-938): the thread's token totals minus the Turn's baseline. Its `inputTokens` contain `cachedInputTokens` (a
  // request's cached part is never larger than it: fixture n=9 `requests`) and `total` is input + output (356,323 + 1,935 = 358,258).
  codex: { cache: "inside", reasoning: "inside" },
  // Claude Code through claude-agent-acp (acp.ts:741-745 maps ACP's `usage`): `inputTokens` leaves out what was read from and written to
  // the cache, which are reported beside it, and `total` is all four (fixture n=4: 4 + 1,248 + 46,940 + 46,383 = 94,575).
  claude: { cache: "beside", reasoning: "inside" },
  // OpenCode through its ACP agent (the same mapping): the cache is beside the input (fixture n=3: 34,816 cached against 20,774 input),
  // and `total` adds `reasoning` to `output` (20,774 + 684 + 34,816 + 368 = 56,642), so reasoning is beside the output. One Turn only
  // was seen: its numbers are the sums over its requests (the input plus the cache, 55,590, is larger than the context the Turn ends on, 19,761).
  opencode: { cache: "beside", reasoning: "beside" },
  // OpenClaw (openclaw.ts:136-176): the Driver adds up its transcript's per-request usage, which is the Pi message format: `input` leaves out
  // `cacheRead` and `cacheWrite`, and the output contains its reasoning. Inferred from that format; no trial conversation had an OpenClaw Turn.
  openclaw: { cache: "beside", reasoning: "inside" },
  pi: { cache: "beside", reasoning: "inside" },
} satisfies Record<string, Meaning>));
// Not here, on purpose: DeepSeek Harness reports only its context window (acp.ts:847-858; its prompt result carries no usage, docs/verification/
// native-capability-matrix.md:340), and Hermes reports its agent's counters for the whole native session, not the Turn (the result of
// `run_conversation` carries the `session_*` counters, hermes-agent `agent/turn_finalizer.py:708` and `acp_adapter/server.py:997`; `agent/turn_usage.py:181`
// adds to them for every request). The Hermes Driver passes them on without a baseline, so a native session's second Turn would show
// the first one's tokens again: the Hub withholds them until the Driver subtracts what the session had before the Turn, as Codex's does.

/**
 * `complete` needs both `input` and `output`, and a Turn that ended `completed`: the numbers of a Turn that was stopped, failed or is
 * still running may be missing its last requests, so they are `partial`. A Harness that reports no Turn numbers, one whose numbers
 * are not a Turn's, and a Turn with no report at all are `unavailable`. The context size and the cost are passed on whichever it is.
 */
export function turnUsage(harnessId: string, native: NativeUsage | undefined, run: RunStatus): TurnUsage {
  const context = native?.context === undefined ? {} : { context: { used: native.context.used, ...(native.context.size === undefined ? {} : { size: native.context.size }) } };
  const cost = native?.cost === undefined ? {} : { cost: { amount: native.cost.amount, currency: native.cost.currency, scope: native.cost.scope } };
  const turn = native?.turn, meaning = MEANING.get(harnessId);
  if (turn === undefined || meaning === undefined) return { completeness: "unavailable", ...context, ...cost };
  const input = turn.input === undefined ? undefined : meaning.cache === "inside" ? turn.input : turn.input + (turn.cachedInput ?? 0) + (turn.cacheWrite ?? 0);
  const output = turn.output === undefined ? undefined : meaning.reasoning === "inside" ? turn.output : turn.output + (turn.reasoning ?? 0);
  if (input === undefined && output === undefined) return { completeness: "unavailable", ...context, ...cost };
  return { completeness: input !== undefined && output !== undefined && run === "completed" ? "complete" : "partial",
    ...(input === undefined ? {} : { input }), ...(turn.cachedInput === undefined ? {} : { cachedInput: turn.cachedInput }), ...(output === undefined ? {} : { output }), ...context, ...cost };
}
