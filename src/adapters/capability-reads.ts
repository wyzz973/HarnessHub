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
  /** Entries directly under the root that belong to another root of the same table. */
  readonly exclude?: readonly string[];
  /**
   * How the Harness finds skills below the root. Without it, a folder holding SKILL.md is one skill and nothing below it
   * is read, and hidden entries are skipped. `files`: every SKILL.md at any depth is one, inside skill folders too
   * (Hermes's `os.walk(followlinks=True)`, OpenCode's glob for SKILL.md at any depth), skipping the names in `skip` and, unless
   * `hidden`, every hidden folder.
   */
  readonly find?: SkillFind;
}
export interface SkillFind { readonly mode: "files"; readonly hidden: boolean; readonly skip: readonly string[] }
/** Hermes 0.12 `agent/skill_utils.py` `iter_skill_index_files`: every SKILL.md, links followed, only these folders skipped. */
const HERMES_FIND: SkillFind = { mode: "files", hidden: true, skip: [".git", ".github", ".hub", ".archive"] };
/** OpenCode 1.18.35 `skill/index.ts`: its glob for SKILL.md at any depth, which does not match hidden folders. */
const OPENCODE_FIND: SkillFind = { mode: "files", hidden: false, skip: [] };
/** A list of skill directories a Harness's configuration adds, read from `path` in `file`, with ~ expanded. */
/** `relativeTo`: where a relative entry is resolved (Hermes: its home); without it, relative entries are not read. */
export interface ExternalSkillDirs { readonly file: string; readonly format: "yaml" | "json5"; readonly path: readonly string[]; readonly precedence: number; readonly containment: boolean; readonly depth: number;
  readonly find?: SkillFind; readonly relativeTo?: string }
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
  /** DeepSeek Harness: its user patch layers, the one for every profile (`file`) and each profile's own under `profiles`. */
  | { readonly style: "dsh"; readonly file: string; readonly profiles: string }
  | { readonly style: "unsupported"; readonly reason: string };
/** A user-level instructions file the Harness may read; `compat` marks another product's file it falls back to. */
export interface InstructionCandidate { readonly path: string; readonly role: "own" | "compat" }
export type InstructionSpec =
  | { readonly kind: "files"; readonly candidates: readonly InstructionCandidate[]; readonly rule: "first-existing" | "first-nonempty" }
  | { readonly kind: "unsupported" | "invisible"; readonly reason: string };
/**
 * A directory of subagent or command files. `separator` joins the parts of a nested file's name (`:` by default,
 * OpenCode's `/`); `regularOnly` and `skipPrefix` name files the Harness does not read (Gemini skips links and names
 * starting with `_`), listed with why.
 */
export interface FileListSpec { readonly dir: string; readonly format: "markdown" | "toml"; readonly role: "own" | "compat"; readonly recursive: boolean; readonly separator?: "/" | ":";
  readonly regularOnly?: boolean; readonly skipPrefix?: string }
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
  /** The Harness's built-in subagents, by evidence: a user-level one of the same name replaces or loses to it, so HarnessHub writes none. */
  readonly reservedSubagents?: readonly string[];
  /** The Harness's built-in commands and bundled skills, by evidence: a skill of the same name competes with one (a warning when one is made). */
  readonly builtinCommands?: readonly string[];
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
  // OpenCode reads its flags as booleans (runtime-flags.ts `Config.boolean`): true, yes, on or 1.
  const flag = (name: string) => /^(?:true|yes|on|1)$/iu.test(environment.values[name] ?? "");
  const dirs = harnessDirectories(environment), disableClaudeSkills = flag("OPENCODE_DISABLE_CLAUDE_CODE_SKILLS") || flag("OPENCODE_DISABLE_CLAUDE_CODE");
  const disableClaudePrompt = flag("OPENCODE_DISABLE_CLAUDE_CODE_PROMPT") || flag("OPENCODE_DISABLE_CLAUDE_CODE");
  const hermes = resolved.hermesHome, workspace = resolved.openclawWorkspace;
  const opencodeConfigs = [join(dirs.opencode, "config.json"), join(dirs.opencode, "opencode.json"), join(dirs.opencode, "opencode.jsonc")];
  return [
    {
      harnessId: "claude", verified: ">=2.1.277 <2.2.0",
      evidence: ["code.claude.com/docs/en/skills、mcp、memory、sub-agents、hooks、plugins/loading（2026-10-18，页面引用到 v2.1.296）",
        "本机 2.1.302 程序：skills/synced/<org>_<account>/ 下的技能以 syncedSkills 加载；skillOverrides 取值 on、name-only、user-invocable-only、off",
        "code.claude.com/docs/en/sub-agents（2026-10-19：~/.claude/agents 递归，身份只看 name，同名的用户子 Agent 顶替内置；运行中的会话不检测新建的目录）；本机 2.1.303 包的 agentType 字符串（general-purpose、statusline-setup、claude、Plan、Explore、comment-thread-analyst、teammate、agent、subagent、main、main-session）与 claude-code-guide",
        "code.claude.com/docs/en/commands（2026-10-19：内置命令与捆绑技能共 119 个，另有别名；同名的用户技能与它们争用 / 命令）"],
      skills: { roots: [{ role: "own", path: join(dirs.claude, "skills"), precedence: 1, containment: false, depth: 1, exclude: ["synced"] },
        { role: "synced", path: join(dirs.claude, "skills", "synced"), precedence: 1, containment: false, depth: 2 }], duplicates: "dedupe-realpath", requiresDescription: false,
        nameMustMatchDirectory: false, switch: { kind: "claude-skill-overrides", file: join(dirs.claude, "settings.json") }, separate: ["synced"] },
      mcp: { style: "claude", file: dirs.claudeJson },
      instructions: { kind: "files", candidates: [{ path: join(dirs.claude, "CLAUDE.md"), role: "own" }], rule: "first-existing" },
      subagents: [{ dir: join(dirs.claude, "agents"), format: "markdown", role: "own", recursive: true }],
      reservedSubagents: ["general-purpose", "statusline-setup", "claude-code-guide", "claude", "explore", "plan", "comment-thread-analyst", "teammate", "agent", "subagent", "main", "main-session"],
      builtinCommands: ["add-dir", "advisor", "agents", "artifact-capabilities", "artifact-diagramming", "artifacts", "auto-mode-setup", "autocompact", "autofix-pr", "background", "batch", "branch", "btw", "bug", "cd", "chrome", "claude-api", "claude-in-chrome", "clear", "code-review", "color", "compact", "config", "context", "copy", "cost", "dataviz", "debug", "deep-research", "design", "design-login", "design-sync", "desktop", "diff", "doctor", "effort", "exit", "export", "fast", "feedback", "fewer-permission-prompts", "focus", "fork", "goal", "heapdump", "help", "hooks", "ide", "import", "init", "insights", "install-github-app", "install-slack-app", "keybindings", "list-agents", "login", "logout", "loop", "mcp", "memory", "mobile", "model", "output-style", "passes", "permissions", "plan", "plugin", "plugin-authoring", "powerup", "pr-comments", "privacy-settings", "radio", "rate-limit-options", "recap", "release-notes", "reload-plugins", "reload-skills", "remote-control", "remote-env", "rename", "resume", "review", "rewind", "run", "run-skill-generator", "sandbox", "schedule", "scroll-speed", "security-review", "setup-bedrock", "setup-vertex", "simplify", "skill-doctor", "skills", "slides", "stats", "status", "statusline", "stickers", "stop", "subtask", "tasks", "team-onboarding", "teleport", "terminal-setup", "theme", "tui", "ultraplan", "ultrareview", "update-config", "upgrade", "usage", "usage-credits", "verify", "vim", "voice", "web-setup", "workflow-authoring", "workflows", "bg", "share", "reset", "new", "settings", "app", "checkup", "quit", "proactive", "ios", "android", "allowed-tools", "rc", "continue", "checkpoint", "undo", "routines"],
      commands: [{ dir: join(dirs.claude, "commands"), format: "markdown", role: "own", recursive: true }],
      hooks: [{ file: join(dirs.claude, "settings.json"), style: "claude", role: "own" }],
      plugins: { kind: "claude", installed: join(dirs.claude, "plugins", "installed_plugins.json"), settings: join(dirs.claude, "settings.json") },
      notes: ["自定义命令已并入技能，同名时技能优先。"],
    },
    {
      harnessId: "codex", verified: ">=0.158.0 <0.170.0",
      evidence: ["learn.chatgpt.com/docs/build-skills（用户级 $HOME/.agents/skills；同名“both can appear”）", "openai/codex codex-rs/ext/skills/src/host_roots.rs（$CODEX_HOME/skills 已弃用但仍读取）", "config-reference（mcp_servers、[[skills.config]]）",
        "openai/codex rust-v0.162.1 codex-rs/codex-home/src/instructions/mod.rs（用户级依次读 AGENTS.override.md、AGENTS.md，trim 后第一个非空者生效，整文件读、没有字节上限；project_doc_max_bytes 只限项目文件，见 core/src/agents_md.rs）",
        "rust-v0.162.1 agent-roles/src/discovery.rs、loader.rs、agent_role_config.rs（agents/**/*.toml 递归，必填 name、description、developer_instructions，名字以 name 为准；config.toml 的 [agents.<名>] 也声明角色）与 core/src/agent/role.rs（内置 default、explorer、worker，awaiter 已注释；同名的用户角色优先）",
        "rust-v0.118.0 PR #16115（删除自定义 prompts，~/.codex/prompts 不再读取，官方改用技能）"],
      skills: { roots: [{ role: "shared", path: dirs.shared, precedence: 1, containment: false, depth: 1 }, { role: "own", path: join(dirs.codex, "skills"), precedence: 1, containment: false, depth: 1 },
        { role: "bundled", path: join(dirs.codex, "skills", ".system"), precedence: 1, containment: false, depth: 1 }],
        duplicates: "all-visible", requiresDescription: true, nameMustMatchDirectory: false, switch: { kind: "codex-skills-config", file: join(dirs.codex, "config.toml") } },
      mcp: { style: "codex", file: join(dirs.codex, "config.toml") },
      instructions: { kind: "files", candidates: [{ path: join(dirs.codex, "AGENTS.override.md"), role: "own" }, { path: join(dirs.codex, "AGENTS.md"), role: "own" }], rule: "first-nonempty" },
      subagents: [{ dir: join(dirs.codex, "agents"), format: "toml", role: "own", recursive: true }],
      reservedSubagents: ["default", "explorer", "worker", "awaiter"],
      commands: null,
      hooks: [{ file: join(dirs.codex, "hooks.json"), style: "codex-json", role: "own" }, { file: join(dirs.codex, "config.toml"), style: "codex-toml", role: "own" }],
      plugins: { kind: "codex", config: join(dirs.codex, "config.toml") },
      notes: ["0.118.0 起不再读取 ~/.codex/prompts，自定义命令改用技能。config.toml 的 [agents.<名>] 也能声明子 Agent。改 config.toml 后要重启 Codex。"],
    },
    {
      harnessId: "cursor", verified: ">=2026.6.0 <2027.0.0",
      evidence: ["cursor.com/docs/context/skills（四个用户级位置，含 Claude、Codex 的兼容目录）", "cursor.com/docs/context/subagents、reference/third-party-hooks（读 Claude 的子 Agent 与 Hooks）",
        "本机 cursor-agent 2026.10.01：index.js 的 computeAgentsDirs 只有工作区的 .cursor/agents、.claude/agents、.grok/agents，没有家目录；9577.index.js 的 loadCommandsFromDirectory 读 ~/.claude/commands（claude-user）与 ~/.cursor/commands（user）顶层的 .md"],
      skills: { roots: [{ role: "shared", path: dirs.shared, precedence: 2, containment: false, depth: 1 }, { role: "own", path: join(dirs.cursor, "skills"), precedence: 2, containment: false, depth: 1 },
        { role: "compat", path: join(dirs.claude, "skills"), precedence: 1, containment: false, depth: 1 }, { role: "compat", path: join(dirs.codex, "skills"), precedence: 1, containment: false, depth: 1 }],
        duplicates: "unknown", requiresDescription: true, nameMustMatchDirectory: true, switch: null },
      mcp: { style: "cursor", file: join(dirs.cursor, "mcp.json") },
      instructions: { kind: "invisible", reason: "Cursor 的用户规则保存在应用设置里，不在磁盘上；它只读项目根目录的 AGENTS.md 与 CLAUDE.md。" },
      subagents: null,
      commands: [{ dir: join(dirs.cursor, "commands"), format: "markdown", role: "own", recursive: false }, { dir: join(dirs.claude, "commands"), format: "markdown", role: "compat", recursive: false }],
      hooks: [{ file: join(dirs.cursor, "hooks.json"), style: "cursor", role: "own" }, { file: join(dirs.claude, "settings.json"), style: "claude", role: "compat" }],
      plugins: { kind: "invisible", reason: "Cursor 不在磁盘上记录已装的插件，只能在会话里用 /plugin 查看；它默认导入 Claude Code 已装的插件。" },
      notes: ["Cursor 没有按技能停用的开关。", "~/.cursor/mcp.json 与 Cursor 编辑器共用。", "本机 CLI 只读工作区里的子 Agent；文档所列的家目录位置在 CLI 程序里没有，编辑器是否读取未核实。"],
    },
    {
      harnessId: "opencode", verified: ">=1.18.0 <1.19.0",
      evidence: ["anomalyco/opencode v1.18.35 packages/opencode/src/skill/index.ts（发现 .claude 与 .agents 的 skills/**/SKILL.md 与配置目录；并发加载，同名后写入者覆盖并警告）",
        "anomalyco/opencode v1.18.35 packages/opencode/src/session/instruction.ts（全局指令取第一个存在的文件：配置目录的 AGENTS.md，然后 ~/.claude/CLAUDE.md；空文件也算存在；每一步重新读）与 effect/runtime-flags.ts（OPENCODE_DISABLE_CLAUDE_CODE 或 OPENCODE_DISABLE_CLAUDE_CODE_PROMPT 关掉回退）",
        "v1.18.35 config/agent.ts（{agent,agents}/**/*.md 递归，名字是相对路径、以 / 连接；{mode,modes}/*.md 也定义 Agent）、config/command.ts（{command,commands}/**/*.md）、agent/agent.ts（内置 build、plan、general、explore、compaction、title、summary，同名文件逐字段覆盖）",
        "v1.18.35 command/index.ts（内置命令 init、review；技能在名字未被占用时补成命令）与 session/prompt.ts（命令与技能模板里的 !`cmd` 不经权限检查就执行）"],
      skills: { roots: [...(disableClaudeSkills ? [] : [{ role: "compat" as const, path: join(dirs.claude, "skills"), precedence: 1, containment: false, depth: 8, find: OPENCODE_FIND }]),
        { role: "shared", path: dirs.shared, precedence: 1, containment: false, depth: 8, find: OPENCODE_FIND }, { role: "own", path: join(dirs.opencode, "skills"), precedence: 1, containment: false, depth: 8, find: OPENCODE_FIND },
        { role: "own", path: join(dirs.opencode, "skill"), precedence: 1, containment: false, depth: 8, find: OPENCODE_FIND }],
        duplicates: "last-wins-unordered", requiresDescription: true, nameMustMatchDirectory: false, switch: { kind: "opencode-permission", files: opencodeConfigs } },
      mcp: { style: "opencode", files: opencodeConfigs },
      instructions: { kind: "files", candidates: [{ path: join(dirs.opencode, "AGENTS.md"), role: "own" }, ...(disableClaudePrompt ? [] : [{ path: join(environment.home, ".claude", "CLAUDE.md"), role: "compat" as const }])], rule: "first-existing" },
      subagents: [{ dir: join(dirs.opencode, "agents"), format: "markdown", role: "own", recursive: true, separator: "/" }, { dir: join(dirs.opencode, "agent"), format: "markdown", role: "own", recursive: true, separator: "/" },
        { dir: join(dirs.opencode, "modes"), format: "markdown", role: "own", recursive: false, separator: "/" }, { dir: join(dirs.opencode, "mode"), format: "markdown", role: "own", recursive: false, separator: "/" }],
      reservedSubagents: ["build", "plan", "general", "explore", "compaction", "title", "summary"],
      builtinCommands: ["init", "review"],
      commands: [{ dir: join(dirs.opencode, "commands"), format: "markdown", role: "own", recursive: true, separator: "/" }, { dir: join(dirs.opencode, "command"), format: "markdown", role: "own", recursive: true, separator: "/" }],
      hooks: null,
      plugins: { kind: "opencode", files: opencodeConfigs, dir: join(dirs.opencode, "plugins") },
      notes: [disableClaudeSkills ? "环境里设置了关闭 .claude 技能来源的变量，OpenCode 不读 ~/.claude/skills。" : "OpenCode 也读 ~/.claude/skills；可以在终端环境里设置 OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1 关掉这个来源。", "OpenCode 没有声明式的 Hooks，由插件实现。"],
    },
    {
      harnessId: "gemini", verified: ">=0.60.0 <0.70.0",
      evidence: ["google-gemini/gemini-cli v0.62.0 docs/cli/skills.md 与 packages/core/src/skills（用户层 ~/.gemini/skills 与 ~/.agents/skills，同层 .agents 优先）", "docs/reference/configuration.md（mcpServers、skills.disabled、hooks）",
        "本机 0.62.0 bundle：loadAgentsFromDirectory 只读 ~/.gemini/agents 顶层、isFile 的 .md，跳过以 _ 开头的与符号链接；本地 Agent 的 schema 是 strict（name 为 slug、description 必填）；内置 codebase_investigator、cli_help、generalist、browser_agent 先注册，同名的用户 Agent 被忽略；acpCommandHandler 只有内置命令，--acp 不展开自定义命令"],
      skills: { roots: [{ role: "own", path: join(dirs.gemini, "skills"), precedence: 1, containment: false, depth: 1 }, { role: "shared", path: dirs.shared, precedence: 2, containment: false, depth: 1 }],
        duplicates: "precedence", requiresDescription: true, nameMustMatchDirectory: false, switch: { kind: "gemini-skills-disabled", file: join(dirs.gemini, "settings.json") } },
      mcp: { style: "gemini", file: join(dirs.gemini, "settings.json") },
      instructions: { kind: "files", candidates: [{ path: join(dirs.gemini, "GEMINI.md"), role: "own" }], rule: "first-existing" },
      subagents: [{ dir: join(dirs.gemini, "agents"), format: "markdown", role: "own", recursive: false, regularOnly: true, skipPrefix: "_" }],
      reservedSubagents: ["generalist", "codebase_investigator", "cli_help", "browser_agent"],
      commands: [{ dir: join(dirs.gemini, "commands"), format: "toml", role: "own", recursive: true }],
      hooks: [{ file: join(dirs.gemini, "settings.json"), style: "gemini", role: "own" }],
      plugins: { kind: "gemini", extensions: join(dirs.gemini, "extensions"), enablement: join(dirs.gemini, "extensions", "extension-enablement.json") },
      notes: ["Gemini CLI 已对免费层与 Google One 用户停止服务（2026-06-18），由 Antigravity CLI 取代；Antigravity 不共用这些配置。", "运行中的 Gemini 会话保存设置时，会按启动时的快照覆盖 settings.json。",
        "Gemini 以 --acp 运行时不展开自定义命令，HarnessHub 的会话里用不了；终端里可以。"],
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
      skills: { roots: [{ role: "own", path: join(hermes, "skills"), precedence: 2, containment: false, depth: 8, find: HERMES_FIND }], duplicates: "precedence", requiresDescription: false, nameMustMatchDirectory: false,
        switch: { kind: "hermes-skills-disabled", file: join(hermes, "config.yaml") },
        externalDirs: { file: join(hermes, "config.yaml"), format: "yaml", path: ["skills", "external_dirs"], precedence: 1, containment: false, depth: 8, find: HERMES_FIND, relativeTo: hermes } },
      mcp: { style: "hermes", file: join(hermes, "config.yaml") },
      instructions: { kind: "unsupported", reason: "Hermes 没有用户级指令文件；SOUL.md 是人格文件，HarnessHub 不写它。" },
      subagents: null, commands: null,
      hooks: [{ file: join(hermes, "config.yaml"), style: "hermes", role: "own" }],
      plugins: { kind: "hermes", dir: join(hermes, "plugins"), config: join(hermes, "config.yaml") },
      notes: ["Hermes 0.12 不读 ~/.agents/skills；长驻进程要 /reload-skills 或重启才看到新技能。"],
    },
    {
      harnessId: "dsh", verified: ">=0.2.0 <0.3.0",
      evidence: ["deepseek-ai/deepseek-harness 5badb15 docs/subsystems/skills.md（$DSH_HOME/skills 优先于 ~/.agents/skills）",
        "@deepseek-ai/dsh 0.2.0-rc.2 dsh-app-boot：依次应用各 bundle、profile 自己的 cordis.patch.yml、$DSH_HOME/cordis.patch.yml；补丁文件必须是顶层 YAML 数组（docs/user/guide/mcp-memory.md：MCP 客户端行 @deepseek-ai/dsh-mcp-client）"],
      skills: { roots: [{ role: "own", path: join(dirs.dsh, "skills"), precedence: 2, containment: false, depth: 1 }, { role: "shared", path: dirs.dshAgents, precedence: 1, containment: false, depth: 1 }],
        duplicates: "precedence", requiresDescription: true, nameMustMatchDirectory: false, switch: null },
      mcp: { style: "dsh", file: join(dirs.dsh, "cordis.patch.yml"), profiles: join(dirs.dsh, "profiles") },
      instructions: { kind: "files", candidates: [{ path: join(dirs.dsh, "AGENTS.md"), role: "own" }], rule: "first-existing" },
      subagents: null, commands: null, hooks: null, plugins: null,
      notes: ["DeepSeek Harness 没有按技能停用的开关。"],
    },
  ];
}
