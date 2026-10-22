import type { NativeResumeView } from "../../contracts/web.js";

// This file holds only each product's continue-command table (ADR-039, ADR-053). The version a command was checked on
// is evidence, never an input: on 2026-10-22, Claude Code 2.1.306 for real and 2.1.307 by source; Codex 0.162.1 for real
// and 0.163.0 by source; OpenCode 1.18.35 for real and 1.19.3 by source; Hermes Agent 0.12.0 for real and v0.22.4 by
// source; DeepSeek Harness 0.2.0-rc.2 for real and 0.2.1-rc.2 by source. The verified-version table that named the file
// went with ADR-053: versions stay as evidence in the capability matrix, docs/verification and the read tables' `checkedOn`.
// The path stays until M2 T-ARCH-03 moves this table into the Harness description module, so that plan/slices.json's
// allowed_files and the link in docs/engineering/real-acceptance.md change once, not twice.

/** The question placeholder of a one-question command; the user replaces it. */
const QUESTION = "\"你的问题\"";
/** What a command may depend on in the conversation's workspace, read without changing it. */
export interface ResumeWorkspace { readonly git: boolean }
type ResumeCommands = { readonly interactive?: (id: string) => string; readonly once: (id: string, workspace: ResumeWorkspace) => string; readonly onceNote?: (workspace: ResumeWorkspace) => string | null };
/**
 * How each Harness's own program continues one of its sessions (ADR-039, ADR-053): the interactive command as the
 * program's help gives it, for a program that has one, and the one-question command with its question placeholder. Both
 * are given for whatever version is installed; only differences of the product itself remain. Pi's session reference is
 * a file path, so it is only pointed to; OpenClaw's sessions live in the user's own OpenClaw Gateway, so nothing is
 * shown. The versions each command was checked on are evidence (the file header), never an input.
 */
const RESUME_COMMANDS: Readonly<Record<string, ResumeCommands | { readonly list: string } | { readonly hidden: true }>> = {
  claude: { interactive: id => `claude --resume ${id}`, once: id => `claude -p --resume ${id} ${QUESTION}` },
  // `codex exec` refuses a directory outside a Git repository unless told otherwise; the flag bypasses that check, so it is
  // given only where it is needed. `codex resume` has no such flag (its help lists none): it asks about the folder itself.
  codex: { interactive: id => `codex resume ${id}`, once: (id, workspace) => workspace.git ? `codex exec resume ${id} ${QUESTION}` : `codex exec --skip-git-repo-check resume ${id} ${QUESTION}`,
    onceNote: workspace => workspace.git ? null : "工作区不是 git 仓库，Codex 需要这个标志" },
  opencode: { interactive: id => `opencode -s ${id}`, once: id => `opencode run -s ${id} ${QUESTION}` },
  hermes: { interactive: id => `hermes --resume ${id}`, once: id => `hermes chat --resume ${id} -q ${QUESTION}` },
  // DeepSeek Harness has no interactive form to give: the profiles 0.2.0-rc.2 ships are acp, web, headless, sdk and
  // sdk-minimal (dsh-app-boot PROFILE_TEMPLATES), and `dsh tui --resume <session>`, an example in its help, starts a tui
  // profile only a user made; without one dsh stops with "profile "tui" does not exist". The headless form keeps --session-id.
  // Its credentials are a prerequisite: 0.2.1-rc.2's dsh-headless profile disables the credentials, authorization and
  // deepseek-account lines, so the key saved in the DeepSeek Harness interface and its account sign-in are not read.
  dsh: { once: id => `dsh headless --session-id ${id} ${QUESTION}`, onceNote: () => DSH_HEADLESS_NOTE },
  pi: { list: "见 Pi 自己的会话列表" },
  openclaw: { hidden: true },
};
/** What the user must have in the terminal before dsh's one-question command works (fixed: it does not depend on the workspace). */
const DSH_HEADLESS_NOTE = "dsh headless 不读 DeepSeek Harness 界面里保存的密钥和账号登录，只用终端环境的 DEEPSEEK_API_KEY、工作区 .env 或 ~/.dsh/.env；只在界面里保存过密钥的用户要先在终端 export（0.2.1-rc.2 的 dsh-headless 把 credentials、authorization、deepseek-account 三行设为 disabled）";
/** Only a plain identifier is shown or put into a command; anything else the program reported stays private. */
const PLAIN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
/**
 * How the user can continue a conversation's native session in the Harness's own program (ADR-039, ADR-053), from its
 * native reference alone: the installed version plays no part. Both commands are given for a plain identifier of a
 * product with commands, the interactive one only for a program that has one; a product without commands gets the
 * identifier alone and `no-command`. Null for a hidden program and for a reference that is no plain identifier.
 * Nothing here runs a program.
 */
export function nativeResume(harnessId: string, reference: string, workspace: ResumeWorkspace): NativeResumeView | null {
  const commands = Object.hasOwn(RESUME_COMMANDS, harnessId) ? RESUME_COMMANDS[harnessId]! : null;
  if (commands !== null && "hidden" in commands) return null;
  if (commands !== null && "list" in commands) return { harnessId, list: commands.list };
  if (!PLAIN_ID.test(reference)) return null;
  if (commands === null) return { harnessId, nativeId: reference, note: "no-command" };
  const note = commands.onceNote?.(workspace) ?? null;
  return { harnessId, nativeId: reference, ...(commands.interactive === undefined ? {} : { interactive: commands.interactive(reference) }),
    once: commands.once(reference, workspace), ...(note === null ? {} : { onceNote: note }) };
}
