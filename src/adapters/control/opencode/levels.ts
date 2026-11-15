import type { HarnessFlavor } from "../../../contracts/flavor.js";
import type { PermissionLevel } from "../../../contracts/protocol.js";
import { TABLE_MCP_NAME } from "../../../contracts/table.js";
import { record } from "./mapping.js";

/** One rule of OpenCode's permission rulesets (`Permission.Rule`): the last that matches wins. */
export interface Rule { readonly action: string; readonly resource: string; readonly effect: "allow" | "ask" | "deny" }
export function isRule(value: unknown): value is Rule {
  const row = record(value);
  return row !== null && typeof row.action === "string" && typeof row.resource === "string" && (row.effect === "allow" || row.effect === "ask" || row.effect === "deny");
}
/** The rules a level's declaration names (flavors/opencode.ts, `session.rules`); none for no level. */
export function levelRules(flavor: HarnessFlavor | undefined, level: PermissionLevel | undefined): Rule[] {
  const declared = level === undefined ? undefined : flavor?.permission[level]?.session?.rules;
  return Array.isArray(declared) ? declared.filter(isRule) : [];
}
/** The paths an agent allows to be changed in spite of the rest (the plan agent's own plan files, T3 Code's agentPaths): kept writable after a level's denials. */
export function agentPaths(rules: readonly unknown[]): Rule[] {
  return rules.filter(isRule).filter(rule => rule.effect === "allow" && rule.resource !== "*" && (rule.action === "edit" || rule.action === "external_directory"));
}
/**
 * A session's ruleset (T3 Code's sessionRules, v2/adapter.ts:426-444): the level's rules, what the user allowed for this session, the agent's own path
 * allowances, and the Hub's own tools allowed (they read this conversation back and touch nothing of the user's). Session rules come after the agent's.
 */
export function sessionRules(level: readonly Rule[], grants: readonly Rule[], paths: readonly Rule[], hubTools: boolean): Rule[] {
  return [...level, ...grants, ...paths, ...(hubTools ? [{ action: TABLE_MCP_NAME + "_*", resource: "*", effect: "allow" as const }] : [])];
}
export function sameRules(left: readonly Rule[] | undefined, right: readonly Rule[]): boolean {
  return left !== undefined && left.length === right.length && left.every((rule, index) => rule.action === right[index]!.action && rule.resource === right[index]!.resource && rule.effect === right[index]!.effect);
}
