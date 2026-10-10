import snapshot from "../../infrastructure/catalog/acp-registry.json" with { type: "json" };
import { loadBuiltinCatalog } from "../catalog.js";
import { catalogTarget } from "../../infrastructure/catalog/platform.js";
import type { ManagementRecipe } from "../../contracts/management.js";

const namedBins: Readonly<Record<string, string>> = { "agoragentic-acp": "agoragentic-mcp", autohand: "autohand-acp",
  "codebuddy-code": "codebuddy", deepagents: "deepagents-acp", dimcode: "dimcode", dirac: "dirac", "fast-agent": "fast-agent-acp",
  "github-copilot": "copilot-language-server", "glm-acp-agent": "glm-acp-agent", "minion-code": "minion-code", nova: "nova" };
/** This allowlist is an install description. Compatibility and actual use are separately verified. */
export function builtinManagementRecipes(): readonly ManagementRecipe[] {
  const result: ManagementRecipe[] = [];
  for (const definition of loadBuiltinCatalog(catalogTarget())) for (const control of definition.controls) {
    const upstream = snapshot.entries.find(entry => entry.agent.id === control.source.upstreamId)?.agent;
    if (control.distribution === null) {
      const native: Readonly<Record<string, { packageName: string; bin: string }>> = {
        "codex-native": { packageName: "@openai/codex", bin: "codex" }, "openclaw-native": { packageName: "openclaw", bin: "openclaw" },
      };
      const source = native[control.id];
      if (source) result.push({ harnessId: definition.id, controlId: control.id, kind: "npm", packageName: source.packageName,
        referenceVersion: "latest", binName: source.bin, args: control.args, archiveUrl: null, archiveSha256: null,
        relativeExecutable: null, dependencies: [] });
      continue;
    }
    if (control.distribution.kind === "binary") {
      result.push({ harnessId: definition.id, controlId: control.id, kind: "binary", packageName: null,
        referenceVersion: upstream?.version ?? control.source.revision, binName: control.executableNames[0] ?? definition.id, args: control.args,
        archiveUrl: control.distribution.archive ?? null, archiveSha256: control.distribution.sha256 ?? null,
        relativeExecutable: control.distribution.relativeExecutable ?? null, dependencies: [], upstreamId: control.source.upstreamId, env: control.env });
    } else if (control.package !== null) {
      result.push({ harnessId: definition.id, controlId: control.id, kind: control.package.kind === "npm" ? "npm" : "python",
        packageName: control.package.name, referenceVersion: control.package.version,
        binName: namedBins[definition.id] ?? control.package.binNames[0] ?? control.executableNames[0] ?? definition.id,
        args: control.args, archiveUrl: null, archiveSha256: null, relativeExecutable: null,
        dependencies: definition.id === "pi" ? [{ packageName: "@earendil-works/pi-coding-agent", binName: "pi" }] : [] });
    }
  }
  return result;
}
