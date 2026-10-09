import snapshot from "../infrastructure/catalog/acp-registry.json" with { type: "json" };
import { importRegistry } from "../infrastructure/catalog/registry.js";
import { validateDefinitions } from "../contexts/catalog/domain/catalog-parser.js";
import type { HarnessDefinition } from "../contexts/catalog/domain/catalog.js";

const nativeDefinitions: readonly HarnessDefinition[] = [
  {
    id: "codex", name: "Codex", aliases: [], binaryNames: ["codex"], configHints: [".codex"],
    controls: [{ id: "codex-native", protocol: "codex-app-server", executableNames: ["codex"], args: ["app-server", "--listen", "stdio://"], env: {}, package: null, distribution: null, requiredExecutables: [],
      source: { repository: "openai/codex", revision: "9b738582b13c2cdbeff54af0afd04c50c3e7ba09", upstreamId: "codex", url: "https://github.com/openai/codex/blob/9b738582b13c2cdbeff54af0afd04c50c3e7ba09/codex-rs/app-server/README.md" } }],
  },
  {
    id: "pi", name: "Pi", aliases: [], binaryNames: ["pi"], configHints: [".pi/agent"],
    controls: [{ id: "pi-native", protocol: "pi-rpc", executableNames: ["pi"], args: ["--mode", "rpc"], env: {}, package: null, distribution: null, requiredExecutables: [],
      source: { repository: "badlogic/pi-mono", revision: "6fb2e7815167e6b19006fc526d1a5d0f5f998787", upstreamId: "pi", url: "https://github.com/badlogic/pi-mono/blob/6fb2e7815167e6b19006fc526d1a5d0f5f998787/packages/coding-agent/docs/rpc.md" } }],
  },
  {
    id: "openclaw", name: "OpenClaw", aliases: [], binaryNames: ["openclaw"], configHints: [".openclaw"],
    controls: [{ id: "openclaw-native", protocol: "acp-v1", executableNames: ["openclaw"], args: ["acp"], env: {}, package: null, distribution: null, requiredExecutables: [],
      source: { repository: "openclaw/acpx", revision: "b3cd84337952e0d2cadd094f564612e89d71daa5", upstreamId: "openclaw", url: "https://github.com/openclaw/acpx/blob/b3cd84337952e0d2cadd094f564612e89d71daa5/src/agent-registry.ts" } }],
  },
];

/** Build the offline catalog. Only reviewed product mappings combine control entries. */
export function loadBuiltinCatalog(platform: string): readonly HarnessDefinition[] {
  const definitions = [...importRegistry(snapshot, platform)];
  for (const native of nativeDefinitions) {
    const index = definitions.findIndex((definition) => definition.id === native.id);
    if (index === -1) { definitions.push(native); continue; }
    const upstream = definitions[index];
    if (upstream === undefined) throw new Error("catalog merge index is invalid");
    definitions[index] = {
      id: upstream.id, name: native.name, aliases: [...new Set([...upstream.aliases, ...native.aliases])],
      binaryNames: [...new Set([...upstream.binaryNames, ...native.binaryNames])],
      configHints: [...new Set([...upstream.configHints, ...native.configHints])], controls: [...native.controls, ...upstream.controls],
    };
  }
  validateDefinitions(definitions);
  return definitions;
}
