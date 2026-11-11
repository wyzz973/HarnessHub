import type { DeliveryRecord, RecoverRelay, RelayPacket, RelayRecovery, RelayRecoveredDelivery } from "../../../../contracts/relay.js";
import type { NativeSessionBinding, PublicRun, SessionSnapshot } from "../../../../contracts/session.js";
import { dispatched } from "./advance.js";
import { step } from "./delivery.js";

/**
 * The relay part of recovery (ADR-055 §9 S15), the domain function the Store's `recoverRelay` option takes: after
 * recoverSession has ended a previous owner's unfinished Runs (unknown, or cancelled when queued), the deliveries those Runs
 * left in flight are decided. A delivery whose Run was never dispatched is not recorded (never_dispatched) and its binding stays
 * as it was (a binding changes only when a Turn settles, and this one never sent anything); one whose Run was dispatched is
 * unknown (owner_ended): the packet may have reached the native side, so its binding now waits for it as an unconfirmed packet
 * (counted as the automatic resend when it was one), and the next content input sends it again once. A delivery already decided
 * (an E1 committed before the owner ended, a settlement) is left as it is. Nothing is re-sent or re-run.
 *
 * `state` is the Session as recoverSession left it, before its `session.recovered` event is appended: that event takes
 * seq `state.lastSeq + 1`, the decision seq of every outcome here and the fact seq of each Run it ended. The function
 * has no clock: `decidedAt` is the last time the Run itself recorded (a lower bound of when its owner ended). Pure and
 * synchronous; null when nothing changes. The Store calls it inside the Session's own SAVEPOINT, checks what it returns
 * and rolls only this Session back when anything of it fails.
 */
export const recoverRelay: RecoverRelay = (state: SessionSnapshot, deliveries: readonly DeliveryRecord[], packets: readonly RelayPacket[] = []): RelayRecovery | null => {
  const seq = state.lastSeq + 1;
  const decided: RelayRecoveredDelivery[] = [];
  let bindings: readonly NativeSessionBinding[] | undefined = state.nativeBindings;
  for (const record of deliveries) {
    if (record.outcome.kind !== "in_flight") continue;
    const run = state.runs.find(row => row.id === record.runId);
    if (run === undefined) continue;
    const at = lastTime(run);
    if (!dispatched(run)) {
      decided.push({ runId: run.id, outcome: { kind: "not_recorded", reason: "never_dispatched", decidedSeq: seq, decidedAt: at } });
      continue;
    }
    decided.push({ runId: run.id, outcome: { kind: "unknown", reason: "owner_ended", decidedSeq: seq, decidedAt: at } });
    const manifest = packets.findLast(packet => packet.id === record.packetId);
    if (manifest === undefined) continue;
    bindings = bindings?.map(binding => {
      const relay = binding.relay;
      if (relay === undefined || binding.status === "archived" || binding.harnessId !== run.selection.harnessId || binding.controlId !== run.selection.controlId) return binding;
      // The binding the Turn ran on, in its epoch: a later binding of the same control (a cleared one) did not receive it.
      if (run.relay?.executedOn != null && run.relay.executedOn.nativeEpoch !== relay.epoch) return binding;
      return { ...binding, relay: step(relay, { kind: "unconfirmed", packet: { id: manifest.id, fromSeq: manifest.range.fromSeq, throughSeq: manifest.range.throughSeq }, autoResend: record.autoResend }) };
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
