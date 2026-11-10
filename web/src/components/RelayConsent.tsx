import type { RelayCrossVendor, RelayWhenUnsure } from "../relay.js";
import { Segmented } from "../ui/primitives.js";

/*
 * The relay's two settings, on the settings page (the user's decision of 2026-11-10: hand-overs are allowed by default, and what
 * the relay is unsure of it settles itself). Neither blocks anything by default; each has a stricter value for a user who wants to
 * be asked. What a first hand-over says to the user is one line above the message box (RelayCard), not a card with a button.
 */

/** The cross-vendor setting's control: allow (the default), ask each time, or hand over the goal only. */
export function CrossVendorControl({ value, disabled, onChange }: { readonly value: RelayCrossVendor; readonly disabled: boolean; readonly onChange: (value: RelayCrossVendor) => void }) {
  return <Segmented<RelayCrossVendor> size="md" label="跨厂商交接" value={value} onChange={onChange}
    options={[{ value: "allow", label: "允许（默认）", disabled }, { value: "ask", label: "每次询问", disabled }, { value: "goal_only", label: "只交目标", disabled }]}/>;
}

/** What the relay does when it cannot tell whether a handoff arrived or what a native session holds: settle it itself (the default), or ask each time. */
export function WhenUnsureControl({ value, disabled, onChange }: { readonly value: RelayWhenUnsure; readonly disabled: boolean; readonly onChange: (value: RelayWhenUnsure) => void }) {
  return <Segmented<RelayWhenUnsure> size="md" label="送达拿不准时" value={value} onChange={onChange}
    options={[{ value: "auto", label: "自动处理（默认）", disabled }, { value: "ask", label: "每次问我", disabled }]}/>;
}
