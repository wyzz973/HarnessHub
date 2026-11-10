import type { RelayCrossVendor } from "../relay.js";
import { Notice, Segmented } from "../ui/primitives.js";

/**
 * The note shown once, the first time the conversation is about to go to another Harness (relay-architecture §10.4, the
 * user's decision of 2026-11-10): hand-overs are allowed by default, so this blocks nothing and asks nothing. It says what
 * is sent, that it cannot be taken back, and where to change it.
 */
export function RelayIntro({ target, onDismiss }: { readonly target: string; readonly onDismiss: () => void }) {
  return <Notice tone="neutral" className="relay-intro" title="第一次把对话交给另一个 Harness"
    action={<button type="button" className="btn btn-sm" onClick={onDismiss}>知道了</button>}>
    发送时，HarnessHub 会把之前对话的要点（你的原话、改动的文件、失败的命令，已隐去疑似密钥）附给 {target}，让它接着做。它用的模型服务可能是另一家，发出后不能收回。想每次先确认，可以在设置里把“跨厂商交接”改为“每次询问”。
  </Notice>;
}

/** The cross-vendor setting's control: allow (the default) or ask each time. A value set elsewhere (goal only) is shown, not chosen here. */
export function CrossVendorControl({ value, disabled, onChange }: { readonly value: RelayCrossVendor; readonly disabled: boolean; readonly onChange: (value: RelayCrossVendor) => void }) {
  return <Segmented<RelayCrossVendor> size="md" label="跨厂商交接" value={value} onChange={onChange}
    options={[{ value: "allow", label: "允许（默认）", disabled }, { value: "ask", label: "每次询问", disabled }, ...(value === "goal_only" ? [{ value: "goal_only" as const, label: "只交目标", disabled: true }] : [])]}/>;
}
