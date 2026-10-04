// SPDX-License-Identifier: MIT
/**
 * The agents the real-agent suites run, and how: the executable, its
 * documented non-interactive mode, and what the conformance suite knows
 * about each one's tools and requests. Used by agents.test.ts and by
 * `pnpm test:real` (tests/real/check.ts).
 */
import path from "node:path";

export interface AgentSpec {
  id: string;
  executable: string;
  /**
   * `anthropic`: the agent is wired to the upstream's Anthropic endpoint,
   * which its requests pass through to (Claude Code); otherwise to Chat.
   */
  upstream?: "anthropic";
  /** Install directories outside PATH, relative to the account's home. */
  installDirectories?: string[];
  /** The documented non-interactive mode with `prompt`. */
  args(prompt: string): string[];
  /**
   * The same, for runs that need the agent's tools to work inside the
   * outer sandbox where its own sandbox cannot start (Codex); `args` when
   * absent.
   */
  outerSandboxArgs?(prompt: string): string[];
  /**
   * The agent's own tool that reads a file, and its arguments for `file`
   * (an absolute path in the working directory); absent when the agent
   * cannot run one non-interactively without switching its safety prompts
   * off, and `toolsNotRun` says why.
   */
  readTool?: { name: string; args(file: string): Record<string, unknown> };
  toolsNotRun?: string;
  /**
   * Why the tool runs but cannot read the file here: the tools item is then
   * partial, which the suite accepts.
   */
  toolsLimitation?: string;
  /**
   * When no request reaches the gateway with the refused proxy variables
   * set, the agent runs again without them (the sandbox still allows only
   * the gateway's port), and the first run is recorded.
   */
  proxyProbe?: boolean;
  /**
   * A shortcoming of the request the agent sends, which the strict upstream
   * rejects although the wiring works: the run is then partially verified.
   */
  knownUpstreamRejection?: RegExp;
  /** Notes when the agent says something worth recording. */
  notes?(run: { stdout: string; stderr: string }): string[];
}

export const AGENTS: readonly AgentSpec[] = [
  {
    id: "claude",
    executable: "claude",
    upstream: "anthropic",
    args: (prompt) => ["-p", prompt],
    readTool: { name: "Read", args: (file) => ({ file_path: file }) },
    notes: ({ stderr }) =>
      /auto-mode-classifier-billing/.test(stderr)
        ? [
            "prints that auto mode's classifier billing needs a gateway feature (code.claude.com/docs/en/auto-mode-classifier-billing); requests work",
          ]
        : [],
  },
  {
    id: "codex",
    executable: "codex",
    args: (prompt) => ["exec", "--skip-git-repo-check", prompt],
    outerSandboxArgs: (prompt) => [
      "exec",
      "--skip-git-repo-check",
      "--sandbox",
      "danger-full-access",
      prompt,
    ],
    // Codex reads files with a command, which `codex exec` runs in its own
    // read-only sandbox without asking.
    readTool: {
      name: "exec_command",
      args: (file) => ({ cmd: `cat ${path.basename(file)}` }),
    },
    toolsLimitation:
      "Codex runs the command in its own Seatbelt sandbox, which cannot start inside the suite's (sandbox-exec: sandbox_apply: Operation not permitted); only --sandbox danger-full-access would run it, which the suite does not use",
  },
  {
    id: "gemini",
    executable: "gemini",
    args: (prompt) => ["-p", prompt],
    readTool: { name: "read_file", args: (file) => ({ file_path: file }) },
    proxyProbe: true,
  },
  {
    id: "opencode",
    executable: "opencode",
    args: (prompt) => ["run", prompt],
    readTool: { name: "read", args: (file) => ({ filePath: file }) },
  },
  {
    id: "pi",
    executable: "pi",
    args: (prompt) => ["-p", prompt],
    readTool: { name: "read", args: (file) => ({ path: file }) },
    knownUpstreamRejection: /max_completion_tokens/,
  },
  {
    id: "hermes",
    executable: "hermes",
    args: (prompt) => ["chat", "-Q", "-q", prompt],
    readTool: { name: "read_file", args: (file) => ({ path: file }) },
  },
  {
    id: "mimocode",
    executable: "mimo",
    installDirectories: [".mimocode/bin"],
    args: (prompt) => ["run", prompt],
    readTool: { name: "read", args: (file) => ({ filePath: file }) },
    knownUpstreamRejection: /system message must be the first message/,
  },
  {
    // Grok Build's non-interactive flag is from xAI's documentation; it has
    // not run here (no grok binary on the machine this suite was made on).
    id: "grok",
    executable: "grok",
    args: (prompt) => ["-p", prompt],
    toolsNotRun: "its read tool is not known here",
  },
];
