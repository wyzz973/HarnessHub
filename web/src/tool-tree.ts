import type { PublicTool } from "../../src/contracts/session.js";

/**
 * The call a tool is shown under: its listed parent. A parent chain that loops is shown flat, and a chain deeper than
 * three levels hangs under its third-level ancestor, so every tool is shown exactly once.
 */
export function toolParents(tools: readonly Pick<PublicTool, "id" | "parentId">[]): ReadonlyMap<string, string> {
  const byId = new Map(tools.map(tool => [tool.id, tool])), result = new Map<string, string>();
  const parentOf = (tool: Pick<PublicTool, "id" | "parentId">) => tool.parentId !== undefined && tool.parentId !== tool.id && byId.has(tool.parentId) ? tool.parentId : undefined;
  for (const tool of tools) {
    const chain: string[] = [], seen = new Set([tool.id]); let looped = false;
    for (let id = parentOf(tool); id !== undefined; id = parentOf(byId.get(id)!)) { if (seen.has(id)) { looped = true; break; } seen.add(id); chain.push(id); }
    if (!looped && chain.length) result.set(tool.id, chain.length <= 3 ? chain[0]! : chain[chain.length - 3]!);
  }
  return result;
}
