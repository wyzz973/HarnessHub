import { join } from "node:path";
import type { DuplicateRule, SkillRootRole } from "../contexts/capabilities/domain/visibility.js";

/** The home directory and environment a Harness resolves its paths from; nothing here reads the process environment. */
export interface ReadEnvironment { readonly home: string; readonly values: Readonly<Record<string, string | undefined>> }
export interface SkillRootSpec {
  readonly role: SkillRootRole;
  readonly path: string;
  /** Higher wins under the `precedence` rule; equal for rules that ignore it. */
  readonly precedence: number;
  readonly containment: boolean;
  /** How deep skill directories may sit below the root: 1 for `<root>/<name>/SKILL.md`, more for category folders. */
  readonly depth: number;
  /** Entries directly under the root that belong to another root of the same table. Hidden entries are always skipped. */
  readonly exclude?: readonly string[];
}
/** A list of skill directories a Harness's configuration adds, read from `path` in `file`, with ~ expanded. */
export interface ExternalSkillDirs { readonly file: string; readonly format: "yaml" | "json5"; readonly path: readonly string[]; readonly precedence: number; readonly containment: boolean; readonly depth: number }
/** Where a Harness keeps its own switch for a skill, read to show `disabled` (writing it is a later step of ADR-045). */
export type SkillSwitchSource =
  | { readonly kind: "claude-skill-overrides"; readonly file: string }
  | { readonly kind: "codex-skills-config"; readonly file: string }
  | { readonly kind: "gemini-skills-disabled"; readonly file: string }
  | { readonly kind: "opencode-permission"; readonly files: readonly string[] }
  | { readonly kind: "hermes-skills-disabled"; readonly file: string }
  | { readonly kind: "openclaw-entries" };
export type McpSource =
  | { readonly style: "claude"; readonly file: string }
  | { readonly style: "codex" | "cursor" | "gemini" | "hermes"; readonly file: string }
  | { readonly style: "opencode"; readonly files: readonly string[] }
  | { readonly style: "openclaw" }
  | { readonly style: "unsupported"; readonly reason: string };
/** A user-level instructions file the Harness may read; `compat` marks another product's file it falls back to. */
export interface InstructionCandidate { readonly path: string; readonly role: "own" | "compat" }
export type InstructionSpec =
  | { readonly kind: "files"; readonly candidates: readonly InstructionCandidate[]; readonly rule: "first-existing" | "first-nonempty" }
  | { readonly kind: "unsupported" | "invisible"; readonly reason: string };
export interface FileListSpec { readonly dir: string; readonly format: "markdown" | "toml"; readonly role: "own" | "compat"; readonly recursive: boolean }
export interface HookSource { readonly file: string; readonly style: "claude" | "codex-json" | "codex-toml" | "cursor" | "gemini" | "hermes" | "openclaw-dirs"; readonly role: "own" | "compat" }
export type PluginSource =
  | { readonly kind: "claude"; readonly installed: string; readonly settings: string }
  | { readonly kind: "codex"; readonly config: string }
  | { readonly kind: "gemini"; readonly extensions: string; readonly enablement: string }
  | { readonly kind: "opencode"; readonly files: readonly string[]; readonly dir: string }
  | { readonly kind: "hermes"; readonly dir: string; readonly config: string }
  | { readonly kind: "openclaw"; readonly dir: string }
  | { readonly kind: "invisible"; readonly reason: string };

/**
 * What one Harness reads besides its model, for the versions `verified` names (ADR-045). Every rule carries its evidence;
 * a version outside the range is read with the same table and shown as unverified.
 */
export interface HarnessReadTable {
  readonly harnessId: string;
  /** A semver range of the product versions these rules were checked against. */
  readonly verified: string;
  readonly evidence: readonly string[];
  readonly skills: { readonly roots: readonly SkillRootSpec[]; readonly duplicates: DuplicateRule; readonly requiresDescription: boolean;
    readonly nameMustMatchDirectory: boolean; readonly switch: SkillSwitchSource | null; readonly separate?: readonly SkillRootRole[]; readonly externalDirs?: ExternalSkillDirs };
  readonly mcp: McpSource;
  readonly instructions: InstructionSpec;
  readonly subagents: readonly FileListSpec[] | null;
  readonly commands: readonly FileListSpec[] | null;
  readonly hooks: readonly HookSource[] | null;
  readonly plugins: PluginSource | null;
  readonly notes: readonly string[];
}

function tilde(environment: ReadEnvironment, path: string): string { return path.startsWith("~/") ? join(environment.home, path.slice(2)) : path; }
/** The directories each Harness resolves from its environment, as its own code or documentation names them. */
export function harnessDirectories(environment: ReadEnvironment) {
  const value = (name: string): string | undefined => { const text = environment.values[name]; return text === undefined || text === "" ? undefined : tilde(environment, text); };
  const claude = value("CLAUDE_CONFIG_DIR") ?? join(environment.home, ".claude");
  const xdg = value("XDG_CONFIG_HOME") ?? join(environment.home, ".config");
  return {
    shared: join(environment.home, ".agents", "skills"),
    claude, claudeJson: value("CLAUDE_CONFIG_DIR") === undefined ? join(environment.home, ".claude.json") : join(claude, ".claude.json"),
    codex: value("CODEX_HOME") ?? join(environment.home, ".codex"),
    cursor: join(environment.home, ".cursor"),
    opencode: value("OPENCODE_CONFIG_DIR") ?? join(xdg, "opencode"),
    gemini: join(environment.home, ".gemini"),
    openclaw: value("OPENCLAW_STATE_DIR") ?? join(environment.home, ".openclaw"),
    openclawConfig: value("OPENCLAW_CONFIG_PATH") ?? join(value("OPENCLAW_STATE_DIR") ?? join(environment.home, ".openclaw"), "openclaw.json"),
    pi: value("PI_CODING_AGENT_DIR") ?? join(environment.home, ".pi", "agent"),
    dsh: value("DSH_HOME") ?? join(environment.home, ".dsh"),
    dshAgents: join(value("DSH_AGENTS_HOME") ?? join(environment.home, ".agents"), "skills"),
  };
}

/**
 * The read tables of the nine Harnesses, checked on 2026-10-18 against the versions installed here (see
 * docs/research/native-extension-configs-2026-10-18.md and ADR-045). `hermesHome` and `openclawWorkspace` are resolved
 * by the caller: Hermes from HERMES_HOME or its active profile, OpenClaw from its own configuration.
 */
export function capabilityReadTables(environment: ReadEnvironment, resolved: { readonly hermesHome: string; readonly openclawWorkspace: string }): readonly HarnessReadTable[] {
  const dirs = harnessDirectories(environment), disableClaudeSkills = environment.values.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS || environment.values.OPENCODE_DISABLE_CLAUDE_CODE;
  const hermes = resolved.hermesHome, workspace = resolved.openclawWorkspace;
  const opencodeConfigs = [join(dirs.opencode, "config.json"), join(dirs.opencode, "opencode.json"), join(dirs.opencode, "opencode.jsonc")];
  return [
    {
      harnessId: "claude", verified: ">=2.1.277 <2.2.0",
      evidence: ["code.claude.com/docs/en/skills、mcp、memory、sub-agents、hooks、plugins/loading（2026-10-18，页面引用到 v2.1.296）",
        "本机 2.1.302 程序：skills/synced/<org>_<account>/ 下的技能以 syncedSkills 加载；skillOverrides 取值 on、name-only、user-invocable-only、off"],
      skills: { roots: [{ role: "own", path: join(dirs.claude, "skills"), precedence: 1, containment: false, depth: 1, exclude: ["synced"] },
        { role: "synced", path: join(dirs.claude, "skills", "synced"), precedence: 1, containment: false, depth: 2 }], duplicates: "dedupe-realpath", requiresDescription: false,
        nameMustMatchDirectory: false, switch: { kind: "claude-skill-overrides", file: join(dirs.claude, "settings.json") }, separate: ["synced"] },
      mcp: { style: "claude", file: dirs.claudeJson },
      instructions: { kind: "files", candidates: [{ path: join(dirs.claude, "CLAUDE.md"), role: "own" }], rule: "first-existing" },
      subagents: [{ dir: join(dirs.claude, "agents"), format: "markdown", role: "own", recursive: false }],
      commands: [{ dir: join(dirs.claude, "commands"), format: "markdown", role: "own", recursive: true }],
      hooks: [{ file: join(dirs.claude, "settings.json"), style: "claude", role: "own" }],
      plugins: { kind: "claude", installed: join(dirs.claude, "plugins", "installed_plugins.json"), settings: join(dirs.claude, "settings.json") },
      notes: ["自定义命令已并入技能，同名时技能优先。"],
    },
    {
      harnessId: "codex", verified: ">=0.158.0 <0.170.0",
      evidence: ["learn.chatgpt.com/docs/build-skills（用户级 $HOME/.agents/skills；同名“both can appear”）", "openai/codex codex-rs/ext/skills/src/host_roots.rs（$CODEX_HOME/skills 已弃用但仍读取）", "config-reference（mcp_servers、[[skills.config]]）"],
      skills: { roots: [{ role: "shared", path: dirs.shared, precedence: 1, containment: false, depth: 1 }, { role: "own", path: join(dirs.codex, "skills"), precedence: 1, containment: false, depth: 1 },
        { role: "bundled", path: join(dirs.codex, "skills", ".system"), precedence: 1, containment: false, depth: 1 }],
        duplicates: "all-visible", requiresDescription: true, nameMustMatchDirectory: false, switch: { kind: "codex-skills-config", file: join(dirs.codex, "config.toml") } },
      mcp: { style: "codex", file: join(dirs.codex, "config.toml") },
      instructions: { kind: "files", candidates: [{ path: join(dirs.codex, "AGENTS.override.md"), role: "own" }, { path: join(dirs.codex, "AGENTS.md"), role: "own" }], rule: "first-nonempty" },
      subagents: [{ dir: join(dirs.codex, "agents"), format: "toml", role: "own", recursive: false }],
      commands: [{ dir: join(dirs.codex, "prompts"), format: "markdown", role: "own", recursive: false }],
      hooks: [{ file: join(dirs.codex, "hooks.json"), style: "codex-json", role: "own" }, { file: join(dirs.codex, "config.toml"), style: "codex-toml", role: "own" }],
      plugins: { kind: "codex", config: join(dirs.codex, "config.toml") },
      notes: ["自定义 prompts 已弃用。改 config.toml 后要重启 Codex。"],
    },
    {
      harnessId: "cursor", verified: ">=2026.6.0 <2027.0.0",
      evidence: ["cursor.com/docs/context/skills（四个用户级位置，含 Claude、Codex 的兼容目录）", "cursor.com/docs/context/subagents、reference/third-party-hooks（读 Claude 的子 Agent 与 Hooks）"],
      skills: { roots: [{ role: "shared", path: dirs.shared, precedence: 2, containment: false, depth: 1 }, { role: "own", path: join(dirs.cursor, "skills"), precedence: 2, containment: false, depth: 1 },
        { role: "compat", path: join(dirs.claude, "skills"), precedence: 1, containment: false, depth: 1 }, { role: "compat", path: join(dirs.codex, "skills"), precedence: 1, containment: false, depth: 1 }],
        duplicates: "unknown", requiresDescription: true, nameMustMatchDirectory: true, switch: null },
      mcp: { style: "cursor", file: join(dirs.cursor, "mcp.json") },
      instructions: { kind: "invisible", reason: "Cursor 的用户规则保存在应用设置里，不在磁盘上；它只读项目根目录的 AGENTS.md 与 CLAUDE.md。" },
      subagents: [{ dir: join(dirs.cursor, "agents"), format: "markdown", role: "own", recursive: false }, { dir: join(dirs.claude, "agents"), format: "markdown", role: "compat", recursive: false },
        { dir: join(dirs.codex, "agents"), format: "toml", role: "compat", recursive: false }],
      commands: null,
      hooks: [{ file: join(dirs.cursor, "hooks.json"), style: "cursor", role: "own" }, { file: join(dirs.claude, "settings.json"), style: "claude", role: "compat" }],
      plugins: { kind: "invisible", reason: "Cursor 不在磁盘上记录已装的插件，只能在会话里用 /plugin 查看；它默认导入 Claude Code 已装的插件。" },
      notes: ["Cursor 没有按技能停用的开关。", "~/.cursor/mcp.json 与 Cursor 编辑器共用。"],
    },
    {
      harnessId: "opencode", verified: ">=1.18.0 <1.19.0",
      evidence: ["anomalyco/opencode v1.18.35 packages/opencode/src/skill/index.ts（发现 .claude 与 .agents 的 skills/**/SKILL.md 与配置目录；并发加载，同名后写入者覆盖并警告）", "opencode.ai/docs/rules（全局 AGENTS.md 回退读 ~/.claude/CLAUDE.md）"],
      skills: { roots: [...(disableClaudeSkills ? [] : [{ role: "compat" as const, path: join(dirs.claude, "skills"), precedence: 1, containment: false, depth: 4 }]),
        { role: "shared", path: dirs.shared, precedence: 1, containment: false, depth: 4 }, { role: "own", path: join(dirs.opencode, "skills"), precedence: 1, containment: false, depth: 4 },
        { role: "own", path: join(dirs.opencode, "skill"), precedence: 1, containment: false, depth: 4 }],
        duplicates: "last-wins-unordered", requiresDescription: true, nameMustMatchDirectory: false, switch: { kind: "opencode-permission", files: opencodeConfigs } },
      mcp: { style: "opencode", files: opencodeConfigs },
      instructions: { kind: "files", candidates: [{ path: join(dirs.opencode, "AGENTS.md"), role: "own" }, { path: join(dirs.claude, "CLAUDE.md"), role: "compat" }], rule: "first-existing" },
      subagents: [{ dir: join(dirs.opencode, "agents"), format: "markdown", role: "own", recursive: false }, { dir: join(dirs.opencode, "agent"), format: "markdown", role: "own", recursive: false }],
      commands: [{ dir: join(dirs.opencode, "commands"), format: "markdown", role: "own", recursive: false }, { dir: join(dirs.opencode, "command"), format: "markdown", role: "own", recursive: false }],
      hooks: null,
      plugins: { kind: "opencode", files: opencodeConfigs, dir: join(dirs.opencode, "plugins") },
      notes: [disableClaudeSkills ? "环境里设置了关闭 .claude 技能来源的变量，OpenCode 不读 ~/.claude/skills。" : "OpenCode 也读 ~/.claude/skills；可以在终端环境里设置 OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1 关掉这个来源。", "OpenCode 没有声明式的 Hooks，由插件实现。"],
    },
    {
      harnessId: "gemini", verified: ">=0.60.0 <0.70.0",
      evidence: ["google-gemini/gemini-cli v0.62.0 docs/cli/skills.md 与 packages/core/src/skills（用户层 ~/.gemini/skills 与 ~/.agents/skills，同层 .agents 优先）", "docs/reference/configuration.md（mcpServers、skills.disabled、hooks）"],
      skills: { roots: [{ role: "own", path: join(dirs.gemini, "skills"), precedence: 1, containment: false, depth: 1 }, { role: "shared", path: dirs.shared, precedence: 2, containment: false, depth: 1 }],
        duplicates: "precedence", requiresDescription: true, nameMustMatchDirectory: false, switch: { kind: "gemini-skills-disabled", file: join(dirs.gemini, "settings.json") } },
      mcp: { style: "gemini", file: join(dirs.gemini, "settings.json") },
      instructions: { kind: "files", candidates: [{ path: join(dirs.gemini, "GEMINI.md"), role: "own" }], rule: "first-existing" },
      subagents: [{ dir: join(dirs.gemini, "agents"), format: "markdown", role: "own", recursive: false }],
      commands: [{ dir: join(dirs.gemini, "commands"), format: "toml", role: "own", recursive: true }],
      hooks: [{ file: join(dirs.gemini, "settings.json"), style: "gemini", role: "own" }],
      plugins: { kind: "gemini", extensions: join(dirs.gemini, "extensions"), enablement: join(dirs.gemini, "extensions", "extension-enablement.json") },
      notes: ["Gemini CLI 已对免费层与 Google One 用户停止服务（2026-06-18），由 Antigravity CLI 取代；Antigravity 不共用这些配置。", "运行中的 Gemini 会话保存设置时，会按启动时的快照覆盖 settings.json。"],
    },
    {
      harnessId: "openclaw", verified: ">=2026.3.0 <2026.4.0",
      evidence: ["本机 openclaw@2026.3.23-2 dist/skills-M0AZJeXx.js（来源与合并顺序：skills.load.extraDirs 最低；filterLoadedSkillsInsideRoot 跳过越界的真实路径）", "包内 docs/tools/skills-config.md（skills.entries.<名>.enabled）"],
      skills: { roots: [{ role: "own", path: join(dirs.openclaw, "skills"), precedence: 3, containment: true, depth: 1 }, { role: "shared", path: dirs.shared, precedence: 4, containment: true, depth: 1 },
        { role: "workspace", path: join(workspace, ".agents", "skills"), precedence: 5, containment: true, depth: 1 }, { role: "workspace", path: join(workspace, "skills"), precedence: 6, containment: true, depth: 1 }],
        duplicates: "precedence", requiresDescription: true, nameMustMatchDirectory: false, switch: { kind: "openclaw-entries" },
        externalDirs: { file: dirs.openclawConfig, format: "json5", path: ["skills", "load", "extraDirs"], precedence: 1, containment: true, depth: 1 } },
      mcp: { style: "openclaw" },
      instructions: { kind: "files", candidates: [{ path: join(workspace, "AGENTS.md"), role: "own" }], rule: "first-existing" },
      subagents: null, commands: null,
      hooks: [{ file: join(dirs.openclaw, "hooks"), style: "openclaw-dirs", role: "own" }],
      plugins: { kind: "openclaw", dir: join(dirs.openclaw, "extensions") },
      notes: ["本机版改 MCP 或插件会让 Gateway 自动重启，HarnessHub 暂不写入（ADR-045 第 9 条）。", "另有随程序附带的内置技能，这里不列出。"],
    },
    {
      harnessId: "pi", verified: ">=0.85.0 <0.99.0",
      evidence: ["earendil-works/pi v0.85.1 docs/skills.md 与 settings.md（~/.pi/agent/skills、~/.agents/skills，先发现者胜出）"],
      skills: { roots: [{ role: "shared", path: dirs.shared, precedence: 1, containment: false, depth: 1 }, { role: "own", path: join(dirs.pi, "skills"), precedence: 2, containment: false, depth: 1 }],
        duplicates: "precedence", requiresDescription: true, nameMustMatchDirectory: false, switch: null },
      mcp: { style: "unsupported", reason: "Pi 0.99 之前没有内置 MCP。" },
      instructions: { kind: "files", candidates: [{ path: join(dirs.pi, "AGENTS.md"), role: "own" }, { path: join(dirs.pi, "CLAUDE.md"), role: "own" }], rule: "first-existing" },
      subagents: null,
      commands: [{ dir: join(dirs.pi, "prompts"), format: "markdown", role: "own", recursive: false }],
      hooks: null, plugins: null,
      notes: ["Pi 在官网安装存在并验证之前，不提供停用。"],
    },
    {
      harnessId: "hermes", verified: ">=0.12.0 <0.13.0",
      evidence: ["本机 hermes-agent a0556b8（v0.12.0）agent/skill_utils.py（$HERMES_HOME/skills 递归，加 skills.external_dirs，本地优先）", "hermes_cli/skills_config.py（skills.disabled、platform_disabled）", "website/docs/reference/mcp-config-reference.md（mcp_servers）"],
      skills: { roots: [{ role: "own", path: join(hermes, "skills"), precedence: 2, containment: false, depth: 3 }], duplicates: "precedence", requiresDescription: false, nameMustMatchDirectory: false,
        switch: { kind: "hermes-skills-disabled", file: join(hermes, "config.yaml") },
        externalDirs: { file: join(hermes, "config.yaml"), format: "yaml", path: ["skills", "external_dirs"], precedence: 1, containment: false, depth: 3 } },
      mcp: { style: "hermes", file: join(hermes, "config.yaml") },
      instructions: { kind: "unsupported", reason: "Hermes 没有用户级指令文件；SOUL.md 是人格文件，HarnessHub 不写它。" },
      subagents: null, commands: null,
      hooks: [{ file: join(hermes, "config.yaml"), style: "hermes", role: "own" }],
      plugins: { kind: "hermes", dir: join(hermes, "plugins"), config: join(hermes, "config.yaml") },
      notes: ["Hermes 0.12 不读 ~/.agents/skills；长驻进程要 /reload-skills 或重启才看到新技能。"],
    },
    {
      harnessId: "dsh", verified: ">=0.2.0 <0.3.0",
      evidence: ["deepseek-ai/deepseek-harness 5badb15 docs/subsystems/skills.md（$DSH_HOME/skills 优先于 ~/.agents/skills）"],
      skills: { roots: [{ role: "own", path: join(dirs.dsh, "skills"), precedence: 2, containment: false, depth: 1 }, { role: "shared", path: dirs.dshAgents, precedence: 1, containment: false, depth: 1 }],
        duplicates: "precedence", requiresDescription: true, nameMustMatchDirectory: false, switch: null },
      mcp: { style: "unsupported", reason: "DeepSeek Harness 的 MCP 写在 profile 的补丁行里，统一视图暂不读取。" },
      instructions: { kind: "files", candidates: [{ path: join(dirs.dsh, "AGENTS.md"), role: "own" }], rule: "first-existing" },
      subagents: null, commands: null, hooks: null, plugins: null,
      notes: ["DeepSeek Harness 没有按技能停用的开关。"],
    },
  ];
}
