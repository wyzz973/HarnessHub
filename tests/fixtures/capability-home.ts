import { mkdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Values written into the fixture's configuration that must never appear in a capability view. */
export const SECRETS = ["sk-literal-secret", "sk-arg-secret", "literal-docs-secret", "literal-header-secret", "sk-hook-secret", "token=abc", "/v1/sse", "q=secret", "check-secret",
  "user:pass", "/Users/someone", "model-key-value"] as const;
export const SYNCED_BUCKET = "11111111-2222-4333-8444-555555555555_66666666-7777-4888-8999-000000000000";

async function file(path: string, text: string): Promise<void> { await mkdir(dirname(path), { recursive: true }); await writeFile(path, text); }
async function link(target: string, path: string): Promise<void> { await mkdir(dirname(path), { recursive: true }); await symlink(target, path); }
const skill = (name: string | null, description: string | null, body = "Do the thing.\n") =>
  "---\n" + (name === null ? "" : "name: " + name + "\n") + (description === null ? "" : "description: " + description + "\n") + "---\n" + body;

/**
 * The user-level files of the nine Harnesses as they look on a machine where several of them are in use: shared skills
 * with per-Harness links, own copies, disabled skills in every Harness's own switch, MCP servers in each format with
 * references and literal values, instructions with fallbacks, subagents, commands, hooks and plugins. `outside` is a
 * directory outside `home` for a skill link that leaves its root.
 */
export async function capabilityHome(home: string, outside: string): Promise<void> {
  const shared = join(home, ".agents", "skills");
  // ~/.agents/skills: the shared directory, managed by vercel-labs/skills for alpha.
  await file(join(shared, "alpha", "SKILL.md"), skill("alpha", "Shared alpha skill"));
  await file(join(shared, "alpha", "scripts", "run.sh"), "#!/bin/sh\necho alpha\n");
  await file(join(shared, "beta", "SKILL.md"), skill("beta", "Beta, turned off everywhere it can be"));
  await file(join(shared, "gamma", "SKILL.md"), skill("gamma", null));
  await file(join(shared, "delta", "SKILL.md"), "---\nname: [unclosed\n---\nbody\n");
  await file(join(shared, "Mismatch", "SKILL.md"), skill("mismatch-name", "Its name differs from its folder"));
  await file(join(shared, ".hidden", "SKILL.md"), skill("hidden", "Never read"));
  await file(join(shared, "nested", "inner", "SKILL.md"), skill("inner", "Only a recursive reader finds it"));
  await file(join(outside, "outside", "SKILL.md"), skill("outside", "A development link to a folder elsewhere"));
  await link(join(outside, "outside"), join(shared, "outside"));
  await link(join(home, "gone"), join(shared, "broken"));
  await file(join(home, ".agents", ".skill-lock.json"), JSON.stringify({ version: 3, skills: { alpha: { source: "owner/repo", sourceType: "github", sourceUrl: "https://user:pass@github.com/owner/repo.git?ref=main", skillPath: "skills/alpha/SKILL.md" } }, dismissed: {}, lastSelectedAgents: [] }));

  // Claude Code: links to the shared directory (one relative, one absolute to the same folder), an own copy, synced skills.
  const claude = join(home, ".claude");
  await link("../../.agents/skills/alpha", join(claude, "skills", "alpha"));
  await link(join(shared, "alpha"), join(claude, "skills", "alpha-again"));
  await link("../../.agents/skills/beta", join(claude, "skills", "beta"));
  await file(join(claude, "skills", "epsilon", "SKILL.md"), skill("epsilon", "Claude's own epsilon"));
  await file(join(claude, "skills", "synced", SYNCED_BUCKET, "zeta", "SKILL.md"), skill("zeta", "Synced from the account"));
  await file(join(claude, "skills", "synced", SYNCED_BUCKET, "epsilon", "SKILL.md"), skill("epsilon", "The account's epsilon"));
  await file(join(claude, "skills", "synced", ".bucket-" + SYNCED_BUCKET, "state.json"), "{}");
  await file(join(claude, "settings.json"), JSON.stringify({ model: "model-key-value", skillOverrides: { beta: "off", alpha: "user-invocable-only" },
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "/Users/someone/bin/guard.sh --token sk-hook-secret" }] }] }, enabledPlugins: { "tool@market": true, "off@market": false } }));
  await file(join(claude, "CLAUDE.md"), "# Mine\n<!-- harnesshub:begin id=shared sha=0 -->\nshared\n<!-- harnesshub:end -->\n");
  await file(join(claude, "agents", "reviewer.md"), "---\nname: reviewer\ndescription: Reviews changes\n---\nReview.\n");
  await file(join(claude, "commands", "frontend", "review.md"), "---\ndescription: Review the frontend\n---\nGo.\n");
  await file(join(claude, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "tool@market": [{ scope: "user", version: "1.2.0", installPath: "/x" }],
    "off@market": [{ scope: "user", version: "0.1.0" }], "project@market": [{ scope: "project", projectPath: "/p", version: "9.9.9" }] } }));
  await file(join(home, ".claude.json"), JSON.stringify({ numStartups: 3, mcpServers: {
    github: { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_TOKEN: "${GITHUB_TOKEN}", API_KEY: "sk-literal-secret" } },
    remote: { type: "http", url: "https://mcp.example.com/v1/sse?token=abc", headers: { Authorization: "Bearer ${REMOTE_TOKEN}" } } } }));

  // Codex: an own copy beside the shared one, a bundled system skill, TOML with table arrays and both MCP transports.
  const codex = join(home, ".codex");
  await file(join(codex, "skills", "alpha", "SKILL.md"), skill("alpha", "Codex's own alpha"));
  await file(join(codex, "skills", ".system", "imagegen", "SKILL.md"), skill("imagegen", "Bundled with Codex"));
  await file(join(codex, "config.toml"), [
    "model = \"model-key-value\" # the model stays as it is",
    "", "[[skills.config]]", "path = \"" + join(shared, "beta", "SKILL.md") + "\"", "enabled = false",
    "", "[mcp_servers.docs]", "command = \"uvx\"", "args = [\"docs-mcp\", \"--api-key\", \"sk-arg-secret\"]", "env = { DOCS_KEY = \"literal-docs-secret\" }", "env_vars = [\"DOCS_TOKEN\"]",
    "", "[mcp_servers.remote]", "url = \"https://remote.example.com/mcp/path?q=secret\"", "bearer_token_env_var = \"REMOTE_BEARER\"", "http_headers = { \"X-Api-Key\" = \"literal-header-secret\" }", "enabled = false",
    "", "[plugins.\"sample@openai\"]", "enabled = false", ""].join("\n"));
  await file(join(codex, "AGENTS.md"), "Base rules\n");
  await file(join(codex, "AGENTS.override.md"), "Override rules\n");
  await file(join(codex, "agents", "helper.toml"), "name = \"helper\"\ndescription = \"Helps\"\ndeveloper_instructions = \"Help.\"\n");
  await file(join(codex, "prompts", "fix.md"), "Fix it.\n");
  await file(join(codex, "hooks.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "notify-send done" }] }] } }));

  // Cursor: MCP with its own reference syntax and hooks of its own; it reads Claude's and Codex's subagents and Claude's hooks.
  const cursor = join(home, ".cursor");
  await file(join(cursor, "mcp.json"), JSON.stringify({ mcpServers: { linear: { url: "https://mcp.linear.app/sse", headers: { Authorization: "Bearer ${env:LINEAR_TOKEN}" } } } }));
  await file(join(cursor, "hooks.json"), JSON.stringify({ version: 1, hooks: { beforeShellExecution: [{ command: "./audit.sh" }] } }));

  // OpenCode: JSONC with comments and a permission rule; no AGENTS.md of its own, so it falls back to ~/.claude/CLAUDE.md.
  const opencode = join(home, ".config", "opencode");
  await file(join(opencode, "opencode.jsonc"), "{\n  // the user's notes\n  \"permission\": { \"skill\": { \"*\": \"allow\", \"be*\": \"deny\" } },\n"
    + "  \"mcp\": { \"local-one\": { \"type\": \"local\", \"command\": [\"bunx\", \"some-mcp\"], \"environment\": { \"TOKEN\": \"{env:OC_TOKEN}\" } } },\n  \"plugin\": [\"opencode-foo@1.0.0\"],\n}\n");
  await file(join(opencode, "config.json"), "{ \"broken\": ");
  await file(join(opencode, "commands", "deploy.md"), "---\ndescription: Deploy\n---\nDeploy.\n");

  // Gemini CLI: shared skills win over its own copy; context.fileName names two files; an excluded server.
  const gemini = join(home, ".gemini");
  await file(join(gemini, "skills", "alpha", "SKILL.md"), skill("alpha", "Gemini's own alpha"));
  await file(join(gemini, "settings.json"), JSON.stringify({ model: { name: "model-key-value" }, skills: { disabled: ["beta"] },
    mcpServers: { srv: { httpUrl: "https://g.example.com/mcp", headers: { "X-Key": "$GEM_KEY" } }, legacy: { url: "https://sse.example.com/events" } }, mcp: { excluded: ["legacy"] },
    hooks: { BeforeTool: [{ matcher: "write_file", hooks: [{ type: "command", command: "lint.sh" }] }] }, context: { fileName: ["GEMINI.md", "AGENTS.md"] } }));
  await file(join(gemini, "GEMINI.md"), "Gemini rules\n");
  await file(join(gemini, "AGENTS.md"), "Shared rules\n");
  await file(join(gemini, "extensions", "ext-one", "gemini-extension.json"), JSON.stringify({ name: "ext-one", version: "0.3.0" }));
  await file(join(gemini, "extensions", "extension-enablement.json"), "{}");
  await file(join(gemini, "commands", "git", "commit.toml"), "description = \"Commit\"\nprompt = \"Commit {{args}}\"\n");

  // OpenClaw: JSON5 with comments, a redundant link to the shared directory, a workspace and an extra directory.
  const openclaw = join(home, ".openclaw");
  await file(join(openclaw, "openclaw.json"), "{\n  // JSON5, as OpenClaw writes it\n  agents: { defaults: { workspace: '~/claw-ws' } },\n  skills: { entries: { beta: { enabled: false } }, load: { extraDirs: ['~/extra-skills'] } },\n"
    + "  plugins: { entries: { 'ext-a': { enabled: false } } },\n  hooks: { internal: { entries: { 'my-hook': { enabled: false } } } },\n}\n");
  await link("../../.agents/skills/alpha", join(openclaw, "skills", "alpha"));
  await file(join(home, "claw-ws", "skills", "omega", "SKILL.md"), skill("omega", "In the agent workspace"));
  await file(join(home, "claw-ws", "AGENTS.md"), "Workspace rules\n");
  await file(join(home, "extra-skills", "kappa", "SKILL.md"), skill("kappa", "From an extra directory"));
  await file(join(openclaw, "hooks", "my-hook", "HOOK.md"), "---\nname: my-hook\nevents: [\"command:new\"]\n---\nHook.\n");
  await file(join(openclaw, "extensions", "ext-a", "openclaw.plugin.json"), JSON.stringify({ id: "ext-a" }));
  await file(join(openclaw, "extensions", "ext-a", "package.json"), JSON.stringify({ version: "1.0.0" }));

  // Hermes: a link and a category folder in its own directory, the shared directory as an external one, YAML with comments.
  const hermes = join(home, ".hermes");
  await file(join(hermes, "config.yaml"), "# Hermes settings\nmodel:\n  default: model-key-value\nskills:\n  disabled: [beta]\n  external_dirs:\n    - ~/.agents/skills\n"
    + "mcp_servers:\n  fs:\n    command: npx\n    args: [\"-y\", \"@modelcontextprotocol/server-filesystem\"]\n    env:\n      FS_TOKEN: ${FS_TOKEN}\n"
    + "hooks:\n  pre_tool_call:\n    - command: \"/opt/bin/check --flag check-secret\"\nplugins:\n  enabled: [plug-one]\n");
  await link("../../.agents/skills/alpha", join(hermes, "skills", "alpha"));
  await file(join(hermes, "skills", "category", "sigma", "SKILL.md"), skill("sigma", "Bundled with Hermes"));
  await file(join(hermes, "skills", ".bundled_manifest"), "sigma:0123456789abcdef\n");
  await file(join(hermes, "plugins", "plug-one", "plugin.yaml"), "name: plug-one\nversion: 0.1.0\n");
  await file(join(hermes, "SOUL.md"), "A persona.\n");

  // Pi and DeepSeek Harness: their own skills and instructions.
  await file(join(home, ".pi", "agent", "skills", "pi-only", "SKILL.md"), skill("pi-only", "Pi's skill"));
  // A description naming the home directory by its absolute path, as users write them.
  await file(join(home, ".pi", "agent", "skills", "notes", "SKILL.md"), skill("notes", "\"Keeps notes in " + home + "/notes and " + home + "\""));
  await file(join(home, ".pi", "agent", "AGENTS.md"), "Pi rules\n");
  await file(join(home, ".pi", "agent", "prompts", "hello.md"), "Hello.\n");
  await file(join(home, ".dsh", "skills", "dsh-only", "SKILL.md"), skill("dsh-only", "DeepSeek Harness's skill"));
  await file(join(home, ".dsh", "AGENTS.md"), "dsh rules\n");
}
