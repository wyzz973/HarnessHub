import type { Engine } from "./contracts";

/** Product names of the known engine ids; unknown ids are shown as registered. */
const names: Record<string, string> = {
  opencode: "OpenCode",
  codex: "Codex",
  claude: "Claude Code",
  gemini: "Gemini CLI",
  qwen: "Qwen Code",
  hermes: "Hermes",
  pi: "Pi",
  mimo: "MiMo",
  dsh: "DSH",
  openclaw: "OpenClaw",
  kimi: "Kimi",
  copilot: "Copilot",
  cursor: "Cursor",
  kiro: "Kiro",
  qoder: "Qoder",
  antigravity: "Antigravity",
};
export function engineName(id: string): string {
  return names[id] ?? id;
}
/** One or two characters for the monogram avatar. */
export function engineMonogram(id: string): string {
  const name = engineName(id);
  const capitals = name.replace(/[^A-Z]/g, "");
  if (capitals.length >= 2) return capitals.slice(0, 2);
  return name.slice(0, 1).toUpperCase() + name.slice(1, 2).toLowerCase();
}
/** Stable hue per engine id so every engine keeps its color across the console. */
export function engineHue(id: string): number {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  return hash;
}
/**
 * Engines a person can pick for a task: enabled ones, never the development fixture.
 * `keep` retains one id even when disabled (the engine of the open session).
 */
export function selectableEngines(engines: Engine[], keep?: string): Engine[] {
  return engines.filter(
    (engine) =>
      engine.driver !== "fake" && (engine.enabled || engine.id === keep),
  );
}
/** Engines shown on management pages: everything except the development fixture. */
export function visibleEngines(engines: Engine[]): Engine[] {
  return engines.filter((engine) => engine.driver !== "fake");
}
