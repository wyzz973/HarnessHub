import snapshot from "../../infrastructure/catalog/acp-registry.json" with { type: "json" };
import { loadBuiltinCatalog } from "../catalog.js";
import { catalogTarget } from "../../infrastructure/catalog/platform.js";
import type { ManagementRecipe } from "../../contracts/management.js";

const namedBins: Readonly<Record<string, string>> = { "agoragentic-acp": "agoragentic-mcp", autohand: "autohand-acp",
  "codebuddy-code": "codebuddy", deepagents: "deepagents-acp", dimcode: "dimcode", dirac: "dirac", "fast-agent": "fast-agent-acp",
  "github-copilot": "copilot-language-server", "glm-acp-agent": "glm-acp-agent", "minion-code": "minion-code", nova: "nova" };
/**
 * OpenClaw's own update restarts only its gateway's launchd job (`openclaw update` → `launchctl kickstart -k
 * gui/<uid>/ai.openclaw.gateway`); its node host is restarted by `openclaw node restart` alone (ADR-043, which cites the
 * 2026.3.23-2 sources). A profile or an overridden label is not declared, so such a job is left to the user.
 */
const OPENCLAW_MAINTENANCE: Pick<ManagementRecipe, "services" | "processNames" | "pluginDirectory" | "upgradeNotes"> = {
  services: [{ label: "ai.openclaw.gateway", name: "OpenClaw Gateway", restart: true, portFlag: "--port" },
    { label: "ai.openclaw.node", name: "OpenClaw Node", restart: false, restartCommand: "openclaw node restart" }],
  processNames: ["openclaw-gateway", "openclaw-node"],
  pluginDirectory: ".openclaw/extensions",
  upgradeNotes: [
    "升级前，HarnessHub 先把新版本装到临时目录，用你现在的配置做校验；校验隔离运行，不能写文件、不能联网。校验不通过就停下，什么都不改。",
    "重启时 Gateway 连接的消息渠道（例如微信、飞书）会断开片刻，最好选一个能接受短暂中断的时间升级。",
    "HarnessHub 不运行 openclaw doctor，也不迁移你的配置。如果升级后 OpenClaw 提示需要迁移，在终端运行 openclaw doctor，然后运行 openclaw gateway restart。",
    "已安装的插件可能与新版本不兼容；升级后如果某个渠道没有恢复，先检查对应插件。",
  ],
};
/** This allowlist is an install description. Compatibility and actual use are separately verified. */
export function builtinManagementRecipes(): readonly ManagementRecipe[] {
  const result: ManagementRecipe[] = [];
  for (const definition of loadBuiltinCatalog(catalogTarget())) for (const control of definition.controls) {
    const upstream = snapshot.entries.find(entry => entry.agent.id === control.source.upstreamId)?.agent;
    if (control.distribution === null) {
      const native: Readonly<Record<string, { packageName: string; bin: string; maintenance?: Pick<ManagementRecipe, "services" | "processNames" | "pluginDirectory" | "upgradeNotes"> }>> = {
        "codex-native": { packageName: "@openai/codex", bin: "codex" }, "openclaw-native": { packageName: "openclaw", bin: "openclaw", maintenance: OPENCLAW_MAINTENANCE },
        "pi-native": { packageName: "@earendil-works/pi-coding-agent", bin: "pi" },
      };
      const source = native[control.id];
      if (source) result.push({ harnessId: definition.id, controlId: control.id, kind: "npm", packageName: source.packageName,
        referenceVersion: "latest", binName: source.bin, args: control.args, archiveUrl: null, archiveSha256: null,
        relativeExecutable: null, dependencies: [], ...source.maintenance });
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
