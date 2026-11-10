import { RELAY_PREF_DEFAULTS, RELAY_STRICT_PREFS, type RelayPrefKey } from "../../src/contracts/relay.js";

/**
 * The relay's settings for a test (permissive-defaults §4). The installation's defaults are permissive: another vendor takes the
 * history (logged at its first use), an unprobed Driver takes it, what the relay is unsure of it settles itself, a data directory
 * in the workspace is warned about. A test of the strict design — the 409s and the failures the defaults turned into notices —
 * sets the four preferences that turn every strict behavior back on (RELAY_STRICT_PREFS); its assertions are then the strict
 * design's, unchanged (P9).
 */
type Prefs = { setPref(key: RelayPrefKey, value: string): void };
/** Turns every strict behavior of the relay back on: crossVendor ask, allowUnprobed false, whenUnsure ask, dataRootInWorkspace block. */
export function strictRelay(store: Prefs): void {
  for (const [key, value] of Object.entries(RELAY_STRICT_PREFS)) store.setPref(key as RelayPrefKey, value);
}
/** Only the policy's questions asked as the strict design asked them (RELAY_CHOICE_REQUIRED); the gates keep their defaults. */
export function askWhenUnsure(store: Prefs): void { store.setPref("relay.whenUnsure", "ask"); }
/** Every preference at its default, explicitly (a test that must not depend on what an earlier one stored). */
export function defaultRelay(store: Prefs): void {
  for (const [key, value] of Object.entries(RELAY_PREF_DEFAULTS)) store.setPref(key as RelayPrefKey, value);
}
