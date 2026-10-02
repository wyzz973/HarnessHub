// SPDX-License-Identifier: MIT

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
