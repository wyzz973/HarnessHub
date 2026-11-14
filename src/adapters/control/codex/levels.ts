import { dirname } from "node:path";
import type { NativeOption, NativeOptions } from "../../../contracts/control.js";
import { ControlError, object, string } from "../../../infrastructure/control/json-rpc-process.js";
import { line } from "./mapping.js";

/**
 * Thread-level permission settings Codex accepts on thread/start and thread/resume. They apply to the Hub's own thread only;
 * the user's config.toml is never written. `on-failure` is gone: app-server 0.169.0's AskForApproval no longer has it.
 */
export const PERMISSION_SETTINGS = {
  approval_policy: { name: "审批策略", config: "approval_policy", param: "approvalPolicy", values: { untrusted: "仅可信命令自动执行", "on-request": "按需请求审批", never: "从不请求审批" } },
  sandbox: { name: "沙箱", config: "sandbox_mode", param: "sandbox", values: { "read-only": "只读", "workspace-write": "工作区可写", "danger-full-access": "完全访问" } },
} as const;
export type PermissionSetting = keyof typeof PERMISSION_SETTINGS;
export const SANDBOX_TYPES: Readonly<Record<string, string>> = { readOnly: "read-only", workspaceWrite: "workspace-write", dangerFullAccess: "danger-full-access" };
/** Who reviews approvals (ApprovalsReviewer): the user, or Codex's own auto-review sub-agent. */
export const REVIEWERS = ["user", "auto_review", "guardian_subagent"] as const;
/** `turn/start.summary`: the user's `model_reasoning_summary`, else `auto` (a catalog can default to none and hide the reasoning). */
const SUMMARIES = ["auto", "concise", "detailed", "none"] as const;
export function reasoningSummary(configured: Readonly<Record<string, unknown>>): string {
  const own = configured.model_reasoning_summary;
  return typeof own === "string" && (SUMMARIES as readonly string[]).includes(own) ? own : "auto";
}

/**
 * Codex's collaboration mode (plan mode) as a native option, offered for every Codex: whether a Codex has it is what its
 * collaborationMode/list answers when a Run that chose a mode opens its thread, not the version it reports (ADR-053).
 */
export const COLLABORATION_MODE = "collaboration_mode";
export const COLLABORATION_MODES: NativeOption["values"] = [{ value: "default", name: "默认" }, { value: "plan", name: "计划" }];
export const COLLABORATION_OPTION: NativeOption = { id: COLLABORATION_MODE, name: "协作模式", category: "mode", currentValue: "default", values: COLLABORATION_MODES };

/**
 * The settings a thread/start or thread/resume response reports, each only when present with a value an option knows: the
 * approval policy and the sandbox type, and the effective collaboration mode, which thread/resume reports.
 */
export function threadReport(response: Record<string, unknown>): { readonly settings: NativeOptions; readonly mode: string | null } {
  const approval = response.approvalPolicy, part = (value: unknown, key: string) => value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined;
  const sandbox = part(response.sandbox, "type"), mode = part(response.collaborationMode, "mode");
  return { settings: { ...(typeof approval === "string" && Object.hasOwn(PERMISSION_SETTINGS.approval_policy.values, approval) ? { approval_policy: approval } : {}),
    ...(typeof sandbox === "string" && Object.hasOwn(SANDBOX_TYPES, sandbox) ? { sandbox: SANDBOX_TYPES[sandbox]! } : {}) },
    mode: typeof mode === "string" && COLLABORATION_MODES.some(row => row.value === mode) ? mode : null };
}
export function permissionOptions(configured: Record<string, unknown>): NativeOption[] {
  return (Object.keys(PERMISSION_SETTINGS) as PermissionSetting[]).map(id => {
    // Offered whether or not the configuration names it; the current value is the configuration's, or none said when it names none.
    const setting = PERMISSION_SETTINGS[id], configuredValue = configured[setting.config], current = typeof configuredValue === "string" && Object.hasOwn(setting.values, configuredValue) ? configuredValue : "";
    return { id, name: setting.name, category: "permission", currentValue: current, values: Object.entries(setting.values).map(([value, name]) => ({ value, name })) };
  });
}

/**
 * A model's speed as Codex lists it (`Model.serviceTiers`, `{id, name, description}`; the deprecated `additionalSpeedTiers` before it): standard
 * ("default", the word `serviceTierForTurn` gives it) and each tier. The value the thread runs without being given one is the configuration's
 * `service_tier` (Codex reads "fast" as priority), else the model's `defaultServiceTier`, else standard. Null for a model with no tier beyond standard.
 */
export const SERVICE_TIER = "service_tier", STANDARD_TIER = "default";
export const tierOf = (value: unknown): unknown => value === "fast" ? "priority" : value;
export function serviceTierOption(row: Record<string, unknown>, configured: Record<string, unknown>): NativeOption | null {
  let tiers: { readonly id: string; readonly name: string }[] = [];
  if (row.serviceTiers != null) {
    if (!Array.isArray(row.serviceTiers) || row.serviceTiers.length > 32) throw new ControlError("INVALID_PROTOCOL", "invalid service tier catalog");
    tiers = row.serviceTiers.map(value => {
      const tier = object(value, "service tier"), id = string(tier.id, "service tier", 128), name = typeof tier.name === "string" && tier.name.trim() ? line(tier.name, 256) : id;
      return { id, name: typeof tier.description === "string" && tier.description.trim() ? name + " · " + line(tier.description, 512) : name };
    });
  }
  if (!tiers.length && Array.isArray(row.additionalSpeedTiers)) tiers = row.additionalSpeedTiers.slice(0, 32).filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 128).map(id => ({ id, name: id === "fast" ? "Fast" : id }));
  const values: { value: string; name: string }[] = [{ value: STANDARD_TIER, name: "标准" }];
  for (const tier of tiers) if (!values.some(value => value.value === tier.id)) values.push({ value: tier.id, name: tier.name });
  if (values.length < 2) return null;
  const listed = (id: unknown): id is string => typeof id === "string" && values.some(value => value.value === id);
  const set = configured.service_tier, own = listed(set) ? set : listed(tierOf(set)) ? tierOf(set) as string : listed(row.defaultServiceTier) ? row.defaultServiceTier : STANDARD_TIER;
  return { id: SERVICE_TIER, name: "速度", category: "speed", currentValue: own, values };
}

/**
 * Codex persists project trust into the user's config.toml when a thread is opened with an explicit writable sandbox (`workspace-write`
 * or `danger-full-access`) in a directory that has a project marker and no trust decision yet (probe of 2026-11-14, codex 0.169.0, a temporary
 * CODEX_HOME: `[projects."<cwd>"] trust_level = "trusted"` appeared; a parent's entry is not inherited). The same decision given for this thread
 * alone (`config.projects.<cwd>.trust_level = "trusted"`, which merges with the user's other entries) leaves the file as it was and runs the thread
 * as Codex would after writing it. Only then: with a decision of the user's for this directory nothing is added, so nothing they chose changes.
 */
export function trustOverride(projects: unknown, cwd: string, sandbox: string | undefined, gitRoot: string | null): Readonly<Record<string, unknown>> | null {
  if (sandbox !== "workspace-write" && sandbox !== "danger-full-access") return null;
  const entries = projects !== null && typeof projects === "object" && !Array.isArray(projects) ? projects as Record<string, unknown> : {};
  const trim = (path: string) => path.length > 1 ? path.replace(/\/+$/u, "") : path;
  const decided = new Set(Object.keys(entries).map(trim));
  const candidates = [...new Set([trim(cwd), ...(gitRoot === null ? [] : [trim(gitRoot)])])];
  if (candidates.some(path => decided.has(path))) return null;
  return Object.fromEntries(candidates.map(path => [path, { trust_level: "trusted" }]));
}
/** The nearest directory at or above `cwd` that holds a `.git` entry (a checkout or a worktree), by the given existence check; null when none. */
export function gitRootOf(cwd: string, exists: (path: string) => boolean): string | null {
  let dir = cwd;
  for (let depth = 0; depth < 64; depth++) {
    if (exists(dir + (dir.endsWith("/") ? "" : "/") + ".git")) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}
