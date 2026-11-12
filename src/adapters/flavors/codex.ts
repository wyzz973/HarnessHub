import type { HarnessFlavor, NativeWant } from "../../contracts/flavor.js";
import { policyLevels } from "./common.js";

// Codex's collaboration mode is named for plan only: naming it needs the app-server's experimental API, which an older Codex lacks; leaving plan
// sets it back to default (the neutral), since a thread keeps the mode it was last given.
const CODEX = (approval: string, sandbox: string, plan = false): readonly NativeWant[] => [
  ...(plan ? [{ ids: ["collaboration_mode"], category: "mode", value: "plan" }] : []), { ids: ["approval_policy"], category: "permission", value: approval }, { ids: ["sandbox"], category: "permission", value: sandbox }];
/** Codex: its thread settings (approval policy and sandbox) and its collaboration mode carry every level; it asks about commands and patches. */
export const codexFlavor: HarnessFlavor = {
  harnessId: "codex",
  permission: policyLevels({ read: false, edit: true, execute: true }, { plan: CODEX("on-request", "read-only", true), ask: CODEX("untrusted", "workspace-write"), auto_edit: CODEX("on-request", "workspace-write"),
    auto: CODEX("never", "workspace-write"), full: CODEX("never", "danger-full-access") }),
  neutral: [{ ids: ["collaboration_mode"], category: "mode", value: "default" }],
  effort: { option: { ids: ["reasoning_effort"], category: "thought_level" }, values: {} },
  asks: { read: false, edit: true, execute: true },
  nativePlan: true,
  capabilities: { sessionMcp: "config", resume: "native", fork: "native", attachments: "native", usage: "turn", questions: "native" },
};
