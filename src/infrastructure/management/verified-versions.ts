import { gte, lte, valid } from "semver";
import type { HarnessVersionVerification } from "../../contracts/management.js";
import type { NativeResumeView } from "../../contracts/web.js";

/** Both ends had a recorded real verification; a version that is not semver is compared exactly. */
type VersionRange = readonly [from: string, to: string];
/**
 * The versions of each Harness that HarnessHub ran for real, as the capability matrix records them
 * (`plan/native-capabilities.json`, `installation`): the product's own version and, for an adapter entry, the adapter's
 * (ADR-038). Changed together with the matrix, after a real verification on another version.
 */
export const VERIFIED_VERSIONS: Readonly<Record<string, { readonly program: VersionRange; readonly adapter?: VersionRange }>> = {
  claude: { program: ["2.1.296", "2.1.296"], adapter: ["0.89.1", "0.89.1"] },
  codex: { program: ["0.162.1", "0.162.1"] },
  cursor: { program: ["2026.10.01-e373342", "2026.10.01-e373342"] },
  gemini: { program: ["0.62.0", "0.62.0"] },
  opencode: { program: ["1.18.35", "1.18.35"] },
  pi: { program: ["0.85.1", "0.85.1"] },
  openclaw: { program: ["2026.3.23-2", "2026.3.23-2"] },
  hermes: { program: ["0.12.0", "0.12.0"] },
  dsh: { program: ["0.2.1-alpha.1", "0.2.1-alpha.1"] },
};
function within(version: string, [from, to]: VersionRange): boolean {
  if (version === from || version === to) return true;
  return valid(version) !== null && valid(from) !== null && valid(to) !== null && gte(version, from) && lte(version, to);
}
function described([from, to]: VersionRange): string { return from === to ? from : from + "–" + to; }
/**
 * Whether a Harness runs a version HarnessHub verified with the real program (ADR-038). Null when nothing was verified for
 * this Harness or its product version is not known, so nothing is claimed. The answer is a hint: it never blocks a Harness.
 */
export function versionVerification(harnessId: string, programVersion: string | null, entryVersion: string | null): HarnessVersionVerification | null {
  if (!Object.hasOwn(VERIFIED_VERSIONS, harnessId) || programVersion === null) return null;
  const verified = VERIFIED_VERSIONS[harnessId]!;
  // An adapter entry in front of the product has its own version; it counts only when it is known and differs.
  const adapter = verified.adapter !== undefined && entryVersion !== null && entryVersion !== programVersion ? entryVersion : null;
  const inside = within(programVersion, verified.program) && (adapter === null || within(adapter, verified.adapter!));
  return { state: inside ? "verified" : "unverified", program: described(verified.program), ...(verified.adapter === undefined ? {} : { adapter: described(verified.adapter) }) };
}

/** The question placeholder of a one-question command; the user replaces it. */
const QUESTION = "\"你的问题\"";
/**
 * How each Harness's own program continues one of its sessions (ADR-039): the interactive command exactly as the installed
 * version's help gives it, and the one-question command that a real Turn verified on the version in VERIFIED_VERSIONS.
 * Pi's session reference is a file path, so it is only pointed to; OpenClaw's sessions live in the user's own OpenClaw
 * Gateway, so nothing is shown. Changed together with VERIFIED_VERSIONS and the verification record.
 */
/** What a command may depend on in the conversation's workspace, read without changing it. */
export interface ResumeWorkspace { readonly git: boolean }
type ResumeCommands = { readonly interactive: (id: string) => string; readonly once: (id: string, workspace: ResumeWorkspace) => string; readonly onceNote?: (workspace: ResumeWorkspace) => string | null };
const RESUME_COMMANDS: Readonly<Record<string, ResumeCommands | { readonly list: string } | { readonly hidden: true }>> = {
  claude: { interactive: id => `claude --resume ${id}`, once: id => `claude -p --resume ${id} ${QUESTION}` },
  // `codex exec` refuses a directory outside a Git repository unless told otherwise; the flag bypasses that check, so it is
  // given only where it is needed. `codex resume` has no such flag (its help lists none): it asks about the folder itself.
  codex: { interactive: id => `codex resume ${id}`, once: (id, workspace) => workspace.git ? `codex exec resume ${id} ${QUESTION}` : `codex exec --skip-git-repo-check resume ${id} ${QUESTION}`,
    onceNote: workspace => workspace.git ? null : "工作区不是 git 仓库，Codex 需要这个标志" },
  opencode: { interactive: id => `opencode -s ${id}`, once: id => `opencode run -s ${id} ${QUESTION}` },
  hermes: { interactive: id => `hermes --resume ${id}`, once: id => `hermes chat --resume ${id} -q ${QUESTION}` },
  dsh: { interactive: id => `dsh tui --resume ${id}`, once: id => `dsh headless --session-id ${id} ${QUESTION}` },
  pi: { list: "见 Pi 自己的会话列表" },
  openclaw: { hidden: true },
};
/** Only a plain identifier is shown or put into a command; anything else the program reported stays private. */
const PLAIN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
/**
 * How the user can continue a conversation's native session in the Harness's own program (ADR-039), from its native
 * reference and whether the installed version was verified. Commands are given only for a verified version and a plain
 * identifier; otherwise the identifier alone, with why. Null for a hidden program and for a reference that is no plain
 * identifier. Nothing here runs a program.
 */
export function nativeResume(harnessId: string, reference: string, verification: HarnessVersionVerification | null, workspace: ResumeWorkspace): NativeResumeView | null {
  const commands = Object.hasOwn(RESUME_COMMANDS, harnessId) ? RESUME_COMMANDS[harnessId]! : null;
  if (commands !== null && "hidden" in commands) return null;
  if (commands !== null && "list" in commands) return { harnessId, list: commands.list };
  if (!PLAIN_ID.test(reference)) return null;
  if (commands === null) return { harnessId, nativeId: reference, note: "not-verified" };
  if (verification?.state !== "verified") return { harnessId, nativeId: reference, note: "version-unverified" };
  const note = commands.onceNote?.(workspace) ?? null;
  return { harnessId, nativeId: reference, interactive: commands.interactive(reference), once: commands.once(reference, workspace), ...(note === null ? {} : { onceNote: note }) };
}
