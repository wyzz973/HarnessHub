import type {
  Engine,
  ToolPackApply,
  ToolPackEngineResult,
  ToolPackRecord,
} from "./contracts";

function mentionsDigest(engine: Engine, digest: string) {
  const configuration = engine.configuration;
  if (!configuration || digest.length < 16) return false;
  const has = (value: string | undefined) =>
    !!value && value.toLowerCase().includes(digest);
  return (
    (configuration.skills ?? []).some((skill) => has(skill.path)) ||
    (configuration.mcpServers ?? []).some(
      (server) =>
        has(server.command) ||
        (server.args ?? []).some(has) ||
        Object.values(server.env ?? {}).some(has),
    )
  );
}
/**
 * Engines whose current revision uses this installed package. Installed files live under
 * `objects/<digest>`, so the digest identifies the exact version. An MCP name prefixed with
 * `<id>-` counts only when no other installed version of the same id explains it.
 */
export function boundEngineIds(
  pack: ToolPackRecord,
  packages: ToolPackRecord[],
  engines: Engine[],
): string[] {
  const digest = pack.digest.toLowerCase();
  const siblings = packages.filter(
    (other) => other.id === pack.id && other.digest !== pack.digest,
  );
  return engines
    .filter((engine) => {
      if (engine.driver === "fake") return false;
      if (mentionsDigest(engine, digest)) return true;
      const named = (engine.configuration?.mcpServers ?? []).some((server) =>
        server.name.toLowerCase().startsWith(`${pack.id.toLowerCase()}-`),
      );
      return (
        named &&
        !siblings.some((other) =>
          mentionsDigest(engine, other.digest.toLowerCase()),
        )
      );
    })
    .map((engine) => engine.id);
}
/** Per-engine rows for both the ADR 0013 `results` array and the legacy single-engine reply. */
export function applyRows(result: ToolPackApply | undefined) {
  if (!result) return [];
  if (result.results) return result.results;
  return result.engineId
    ? [
        {
          engineId: result.engineId,
          status: "applied",
          ...(result.revision ? { revision: result.revision } : {}),
        } satisfies ToolPackEngineResult,
      ]
    : [];
}
export const toolPackStatusNames: Record<string, string> = {
  applied: "已应用",
  skipped: "已跳过",
  failed: "失败",
  removed: "已解除",
  unbound: "已解除",
  unchanged: "无变化",
};
export const toolPackKinds = [
  { id: "auto", label: "自动识别" },
  { id: "skills", label: "Skill" },
  { id: "mcp", label: "MCP" },
  { id: "cli", label: "CLI" },
] as const;
