// SPDX-License-Identifier: MIT
/**
 * The route decision trace (Magpie's route trace and `/v1/magpie/route`):
 * the latest routing decisions of one gateway handler, each published as
 * it is made, before the vendor is asked, and again when its call ends, so
 * that the console can show why a turn went where it did while the answer
 * is still on its way. A bounded ring in memory: a restart starts it over,
 * and nothing in it is a record of the ledger.
 */
import type {
  RouteDecision,
  RouteDecisionCandidate,
  RouteDecisionPage,
  RouteDecisionQuery,
} from "@harnesshub/core/model-plane";
import type { Candidate } from "./routing.js";

/** Decisions kept, the oldest dropped first. */
export const DECISIONS_KEPT = 256;
/** Candidates a decision lists. */
export const DECISION_CANDIDATES = 20;
/** The longest one read waits for a new decision. */
export const DECISION_WAIT_MAX_MS = 60_000;

/** A candidate as a decision lists it. */
export function decisionCandidate(
  candidate: Candidate,
): RouteDecisionCandidate {
  return {
    provider: candidate.provider.id,
    credential: candidate.credential.id,
    model: candidate.ref,
    ...(candidate.path?.[0] ? { member: candidate.path[0] } : {}),
    ...(candidate.effort ? { effort: candidate.effort } : {}),
    ...(candidate.fast ? { fast: true } : {}),
  };
}

/** The decisions of one gateway handler. */
export class DecisionTrace {
  #records: RouteDecision[] = [];
  #seq = 0;
  #waiters = new Set<() => void>();
  #closed = false;
  constructor(private readonly clock: () => number) {}

  /** Publish a decision as it is made; returns the record that {@link finish} completes. */
  publish(
    fields: Omit<RouteDecision, "seq" | "at" | "done" | "candidates"> & {
      candidates: readonly Candidate[];
    },
  ): RouteDecision {
    const { candidates, ...rest } = fields;
    const record: RouteDecision = {
      ...rest,
      seq: ++this.#seq,
      at: new Date(this.clock()).toISOString(),
      candidates: candidates
        .slice(0, DECISION_CANDIDATES)
        .map(decisionCandidate),
      ...(candidates.length > DECISION_CANDIDATES
        ? { more: candidates.length - DECISION_CANDIDATES }
        : {}),
      done: false,
    };
    this.#records.push(record);
    if (this.#records.length > DECISIONS_KEPT)
      this.#records.splice(0, this.#records.length - DECISIONS_KEPT);
    this.#wake();
    return record;
  }

  /** The decision's call ended with `status`, answered by `served` when it was. */
  finish(
    record: RouteDecision,
    status: number | undefined,
    served: Candidate | undefined,
  ): void {
    record.done = true;
    if (status !== undefined) record.status = status;
    if (served) record.served = decisionCandidate(served);
    record.seq = ++this.#seq;
    this.#wake();
  }

  /**
   * The decisions after `query.after` (of `query.session` when given),
   * oldest first, and the latest `seq`; with `wait`, waits up to that long
   * for one when there is none, until `signal` aborts or the trace closes.
   * An `after` past the latest `seq` (the gateway started over) reads from
   * the start.
   */
  async read(
    query: RouteDecisionQuery,
    signal: AbortSignal,
  ): Promise<RouteDecisionPage> {
    const after = (query.after ?? 0) > this.#seq ? 0 : (query.after ?? 0);
    const limit = Math.min(Math.max(query.limit ?? 50, 1), DECISIONS_KEPT);
    const pick = (): RouteDecisionPage => ({
      seq: this.#seq,
      items: this.#records
        .filter(
          (record) =>
            record.seq > after &&
            (query.session === undefined ||
              record.conversation === query.session ||
              record.sessionId === query.session),
        )
        .sort((a, b) => a.seq - b.seq)
        .slice(0, limit)
        .map((record) => structuredClone(record)),
    });
    const wait = Math.min(
      Math.max((query.wait ?? 0) * 1000, 0),
      DECISION_WAIT_MAX_MS,
    );
    let page = pick();
    if (page.items.length || wait === 0 || this.#closed || signal.aborted)
      return page;
    await new Promise<void>((resolve) => {
      const waiters = this.#waiters;
      let timer: NodeJS.Timeout | undefined;
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        waiters.delete(check);
        resolve();
      };
      const check = () => {
        page = pick();
        if (page.items.length || this.#closed) done();
      };
      timer = setTimeout(done, wait);
      timer.unref();
      waiters.add(check);
      signal.addEventListener("abort", done, { once: true });
    });
    return page;
  }

  /** Wake every read: the handler is closing. */
  close(): void {
    this.#closed = true;
    this.#wake();
  }

  #wake(): void {
    for (const waiter of [...this.#waiters]) waiter();
  }
}
