import snapshot from "../../infrastructure/catalog/acp-registry.json" with { type: "json" };
import { loadBuiltinCatalog } from "../catalog.js";
import { catalogTarget } from "../../infrastructure/catalog/platform.js";
import type { ManagementRecipe } from "../../contracts/management.js";

const namedBins: Readonly<Record<string, string>> = { "agoragentic-acp": "agoragentic-mcp", autohand: "autohand-acp",
  "codebuddy-code": "codebuddy", deepagents: "deepagents-acp", dimcode: "dimcode", dirac: "dirac", "fast-agent": "fast-agent-acp",
  "github-copilot": "copilot-language-server", "glm-acp-agent": "glm-acp-agent", "minion-code": "minion-code", nova: "nova" };
/**
 * OpenClaw's services (ADR-043, citing the 2026.3.23-2 sources): its own update restarts only the gateway's launchd job;
 * its node host is restarted by `openclaw node restart` alone. A profile or an overridden label is not declared, so such a
 * job is left to the user. Its npm installation upgrades through the sequence its documentation gives (ADR-052, 2026-11-01
 * 实现裁决; docs.openclaw.ai/install/updating "Upgrading very old versions"): the gateway stopped, each release installed
 * with `--allow-scripts=openclaw` and its Doctor run, the gateway started after the last; installations from before July
 * 2026 go through 2026.9.5 first. The Doctor rotates ~/.openclaw/openclaw.json.bak (.bak.1–.bak.4) on every rewrite
 * (docs.openclaw.ai/cli/doctor/checks); an older release cannot open a newer release's database, so the previous version is
 * only returned to from `openclaw backup create` (docs.openclaw.ai/cli/backup, install/updating/rollback-and-recovery).
 */
const OPENCLAW_MAINTENANCE: Pick<ManagementRecipe, "services" | "processNames" | "pluginDirectory" | "upgradeNotes" | "upgradeSequence"> = {
  services: [{ label: "ai.openclaw.gateway", name: "OpenClaw Gateway", restart: true, portFlag: "--port" },
    { label: "ai.openclaw.node", name: "OpenClaw Node", restart: false, restartCommand: "openclaw node restart" }],
  processNames: ["openclaw-gateway", "openclaw-node"],
  pluginDirectory: ".openclaw/extensions",
  upgradeSequence: {
    bridge: { before: "2026.7.0", version: "2026.9.5" },
    npmFlags: ["--allow-scripts=openclaw"],
    gateway: { label: "ai.openclaw.gateway", stop: ["gateway", "stop"], start: ["gateway", "start"], status: ["gateway", "status", "--deep"] },
    doctor: ["doctor", "--fix", "--yes"],
    restarts: [{ label: "ai.openclaw.node", args: ["node", "restart"] }],
    backupCommand: "openclaw backup create --output <目录> --verify",
    migrates: [".openclaw/openclaw.json"],
    migrationBackups: "Doctor 每次改写配置都先把原件轮换保存为 ~/.openclaw/openclaw.json.bak（更早的是 .bak.1 到 .bak.4）。",
    rollback: "退回旧版本只能从升级前的备份恢复：openclaw backup restore <备份文件> --target <新目录>（不在原目录上恢复）。旧版本打不开新版本迁移过的数据库，所以用 npm 装回旧版本不能恢复。",
  },
  upgradeNotes: [
    "HarnessHub 按 OpenClaw 官方文档的步骤升级：先 openclaw gateway stop，逐个版本 npm install --allow-scripts=openclaw 并运行 openclaw doctor --fix --yes，最后 openclaw gateway start 并核实它重新运行、在端口上监听。2026 年 7 月之前的安装先经 2026.9.5，这是上游要求的迁移步骤，不是版本门槛（ADR-052）。",
    "升级期间 Gateway 停止，微信、飞书等渠道离线，直到最后一跳的 Doctor 通过并重新启动；HarnessHub 不再用 launchctl kickstart 重启它。最好选一个能接受中断的时间升级。",
    "Doctor 报告退役的记忆索引（要求先经 2026.9.7）或拒绝改写时，任务停在那一跳并给出 Doctor 的原话，已装入的版本如实记录，不回滚也不重试。",
    "OpenClaw 自带的官方插件由 Doctor 按核心版本修复；第三方插件（例如 openclaw-weixin）可能需要在升级后运行 openclaw plugins update。某个渠道没有恢复时先检查对应插件。",
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
