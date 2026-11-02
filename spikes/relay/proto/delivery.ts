// 原型，仅用于测量，不是实现。v1 §7.2 同步状态转换表里 A→B→A 用得到的几行，外加原型补的一行（见 README）。
import { sha256hex } from "./text.ts";
import type { BindingRelayState, DeliveredMark, EvidenceClass, Fingerprint, RelayPacket } from "./types.ts";

export function freshBinding(harnessId: string, controlId: string): BindingRelayState {
  return { harnessId, controlId, nativeEpoch: 1, sync: { kind: "fresh", basis: "new" }, reanchor: false };
}
/** 内容回合派发，携带包 P（在 run.context_prepared 事务内）：fresh / synced / suspect → pending。 */
export function onDispatchWithPacket(state: BindingRelayState, packet: RelayPacket): BindingRelayState {
  const mark = state.sync.kind === "fresh" ? null : state.sync.mark;
  return { ...state, sync: { kind: "pending", mark, packetId: packet.id, range: packet.range, bodySha256: packet.body.sha256, attempts: 1 } };
}
/** 结算：recorded → synced（mark 推进到 P 的区间上界，chain 追加 P 的正文指纹）；not_recorded → 回到派发前；unknown → 保持 pending。 */
export function onSettled(state: BindingRelayState, outcome: "recorded" | "not_recorded" | "unknown", evidence: EvidenceClass): BindingRelayState {
  if (state.sync.kind !== "pending") return state;
  const s = state.sync;
  if (outcome === "unknown") return state;
  if (outcome === "not_recorded") return { ...state, sync: s.mark === null ? { kind: "fresh", basis: "new" } : { kind: "synced", mark: s.mark } };
  const mark: DeliveredMark = { throughSeq: s.range.throughSeq, chain: sha256hex((s.mark?.chain ?? "") + s.bodySha256) as Fingerprint, lastPacketId: s.packetId, evidence, basis: "evidence" };
  return { ...state, sync: { kind: "synced", mark } };
}
/**
 * 原型补的一行：fresh 绑定在本纪元执行了一个不带包、且当时 need = ∅ 的普通回合并已记录，
 * 说明它此刻知道 contextThroughSeq 之前的全部公共事实 → synced{basis: own_run}。
 * v1 §7.2 没有 fresh → synced 的边，所以原始 Harness A 在 A→B→A 返回时会被 §6.3 判为 kind=packet（见 README 发现 F4）。
 */
export function onOwnRunRecorded(state: BindingRelayState, contextThroughSeq: number, needWasEmpty: boolean): BindingRelayState {
  if (state.sync.kind !== "fresh" || !needWasEmpty) return state;
  return { ...state, sync: { kind: "synced", mark: { throughSeq: contextThroughSeq, chain: sha256hex("") as Fingerprint, lastPacketId: null, evidence: "E3", basis: "own_run" } } };
}
