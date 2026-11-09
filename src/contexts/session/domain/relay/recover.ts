import type { DeliveryRecord, RecoverRelay, RelayRecovery, RelayRecoveredDelivery } from "../../../../contracts/relay.js";
import type { NativeSessionBinding, PublicRun, SessionSnapshot } from "../../../../contracts/session.js";
import { dispatched } from "./advance.js";

/**
 * The relay part of recovery (ADR-055 §9 S15), the domain function the Store's `recoverRelay` option takes: after
 * recoverSession has ended a previous owner's unfinished Runs (unknown, or cancelled when queued), the deliveries those Runs
 * left in flight are decided and their bindings put back where the evidence allows. A delivery whose Run was never
 * dispatched is not recorded (never_dispatched) and its binding, pending on that packet, returns to its prior; one whose
 * Run was dispatched is unknown (owner_ended) and its binding stays pending, to be checked at the next open; a delivery
 * already decided (an E1 committed before the owner ended, a settlement) is left as it is. Nothing is re-sent or re-run
 * (INV-11).
 *
 * `state` is the Session as recoverSession left it, before its `session.recovered` event is appended: that event takes
 * seq `state.lastSeq + 1`, the decision seq of every outcome here and the fact seq of each Run it ended (VF1-15). The function
 * has no clock: `decidedAt` is the last time the Run itself recorded (a lower bound of when its owner ended). Pure and
 * synchronous; null when nothing changes. The Store calls it inside the Session's own SAVEPOINT, checks what it returns
 * and rolls only this Session back when anything of it fails.
 */
export const recoverRelay: RecoverRelay = (state: SessionSnapshot, deliveries: readonly DeliveryRecord[]): RelayRecovery | null => {
  const seq = state.lastSeq + 1;
  const decided: RelayRecoveredDelivery[] = [];
  let bindings: readonly NativeSessionBinding[] | undefined = state.nativeBindings;
  for (const record of deliveries) {
    if (record.outcome.kind !== "in_flight") continue;
    const run = state.runs.find(row => row.id === record.runId);
    if (run === undefined) continue;
    const at = lastTime(run);
    if (dispatched(run)) {
      decided.push({ runId: run.id, outcome: { kind: "unknown", reason: "owner_ended", decidedSeq: seq, decidedAt: at } });
      continue;
    }
    decided.push({ runId: run.id, outcome: { kind: "not_recorded", reason: "never_dispatched", decidedSeq: seq, decidedAt: at } });
    // The packet never left: the binding that went pending on it for this Run returns to the state before it (RT2-07, K7, K8).
    bindings = bindings?.map(binding => {
      const relay = binding.relay;
      if (relay === undefined || binding.status === "archived" || binding.harnessId !== run.selection.harnessId || binding.controlId !== run.selection.controlId) return binding;
      if (relay.sync.kind !== "pending" || relay.sync.packetId !== record.packetId) return binding;
      return { ...binding, relay: { ...relay, sync: relay.sync.prior } };
    });
  }
  if (decided.length === 0) return null;
  return { next: bindings === state.nativeBindings ? state : { ...state, ...(bindings === undefined ? {} : { nativeBindings: bindings }) }, deliveries: decided };
};

/** The latest time a Run recorded: its last phase, or when it was accepted; 0 for a Run from before v10, which has no times. */
function lastTime(run: PublicRun): number {
  const timing = run.timing;
  if (timing === undefined) return 0;
  return Math.max(timing.acceptedAt, timing.preparingAt ?? 0, timing.contextReadyAt ?? 0, timing.readyAt ?? 0, timing.dispatchedAt ?? 0, timing.firstOutputAt ?? 0, timing.endedAt ?? 0, timing.recordedAt ?? 0);
}
