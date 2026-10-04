// SPDX-License-Identifier: MIT
/**
 * The agent behind a model call, for the ledger: the adapter of an `agent:`
 * Gateway Key, else one recognized by its User-Agent (Magpie
 * `usage.AgentOf`). Only the key is established; the User-Agent is an
 * inference, and the entry says which it is.
 */
import type { CallAgent, GatewayKeyScope } from "@harnesshub/core/model-plane";

/**
 * Agents by the product name their User-Agent starts with (lowercase, before
 * the first `/` or space). The adapter id itself also matches.
 */
export const AGENT_USER_AGENTS: ReadonlyArray<{
  id: string;
  prefixes: readonly string[];
}> = [
  { id: "claude", prefixes: ["claude-cli", "claude-code"] },
  // codex_cli_rs, codex_exec and the other Codex front ends.
  { id: "codex", prefixes: ["codex"] },
  { id: "gemini", prefixes: ["geminicli", "gemini-cli"] },
  { id: "qwen", prefixes: ["qwencode", "qwen-code"] },
  { id: "kimi", prefixes: ["kimicli", "kimi-cli"] },
  { id: "opencode", prefixes: ["opencode"] },
  { id: "crush", prefixes: ["crush"] },
];

/** The call's agent: the key's adapter, else the User-Agent's known product, else none. */
export function agentOf(
  scope: GatewayKeyScope | undefined,
  userAgent: string | undefined,
): CallAgent | undefined {
  if (scope?.kind === "agent") return { id: scope.adapterId, source: "key" };
  const name = (userAgent ?? "")
    .trim()
    .split("/")[0]!
    .split(" ")[0]!
    .toLowerCase();
  if (!name) return undefined;
  const known = AGENT_USER_AGENTS.find(
    ({ id, prefixes }) =>
      name === id || prefixes.some((prefix) => name.startsWith(prefix)),
  );
  return known ? { id: known.id, source: "user-agent" } : undefined;
}
