// SPDX-License-Identifier: MIT
import { HubError } from "./errors.js";

/**
 * Ownership marker of one POSIX Session Worker's process tree.
 *
 * The ProcessHost sets it to the Worker's owner token, so the engine and every
 * tool that inherits the environment carry it. Cleanup uses it to find
 * descendants that left the Worker's process group (setsid, daemonizing) after
 * their parent exited. A process started with a fresh environment does not
 * carry it; HarnessHub adds it to the stdio MCP servers it configures, and the
 * Worker keeps it when it applies a prepared engine environment. Windows
 * Workers do not receive it: their Job Object contains every descendant.
 *
 * The value is public: any process of the same user can read it from the
 * Worker's argv or a descendant's environment, and any process can set it to
 * have itself and its descendants reclaimed with the tree. It must never
 * become a credential: nothing, including Worker IPC and the Windows Job name
 * derived from the same token, may rely on it being secret.
 */
export const WORKER_TREE_ENVIRONMENT = "HARNESSHUB_WORKER_TREE";

/**
 * Windows variables that locate the system and installed programs.
 *
 * Child processes that HarnessHub starts with an allowlisted environment
 * (Session Workers, configuration probes) receive these from the parent.
 * Without them, engines and their tools cannot find PowerShell modules, Git,
 * Python or machine-wide configuration. The names use the Windows spelling;
 * Windows compares environment names case-insensitively, and on other platforms
 * they are normally absent.
 */
export const WINDOWS_SYSTEM_ENVIRONMENT: readonly string[] = [
  "PATHEXT",
  "SystemRoot",
  "windir",
  "ComSpec",
  "SystemDrive",
  "OS",
  "PROCESSOR_ARCHITECTURE",
  "NUMBER_OF_PROCESSORS",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "CommonProgramFiles",
  "CommonProgramFiles(x86)",
  "CommonProgramW6432",
  "ProgramData",
  "ALLUSERSPROFILE",
  "PUBLIC",
  // Without it, Windows PowerShell 5.1 spends ~22 s on every command that
  // autoloads a module (Write-Output, Out-File, ConvertTo-Json); engine shell
  // tools start it per command, and Gemini CLI twice (AST parser, command).
  "PSModulePath",
];

/**
 * `HOMEDRIVE` and `HOMEPATH` naming a Windows home directory, so that their
 * concatenation is `home` (with `/` written as `\`). A drive path C:\a\home
 * gives C: and \a\home; a UNC path \\server\share\home gives \\server\share
 * (not a drive letter; `HOMESHARE` is not set) and \home; a \\?\ or \\.\
 * path keeps its prefix and first component as the "drive".
 *
 * Every environment that points `USERPROFILE` at a private home must set
 * both: when an explicit child environment lacks them, Node's libuv copies the
 * launching process's values, which name the real profile.
 *
 * Throws `WORKER_PRIVATE_PATH_INVALID` for a path without a drive, share or
 * device root (relative, drive-relative or rooted without a drive).
 */
export function windowsHomeEnvironment(home: string): {
  HOMEDRIVE: string;
  HOMEPATH: string;
} {
  const windows = home.replaceAll("/", "\\");
  const root =
    /^\\\\[?.]\\[^\\]+/.exec(windows) ??
    /^\\\\[^\\]+\\[^\\]+/.exec(windows) ??
    /^[A-Za-z]:(?=\\)/.exec(windows);
  if (!root)
    throw new HubError(
      "WORKER_PRIVATE_PATH_INVALID",
      "Private home is not an absolute Windows path with a drive, share or device root",
      503,
    );
  const drive = root[0];
  return {
    HOMEDRIVE: drive,
    HOMEPATH: windows.slice(drive.length) || "\\",
  };
}
