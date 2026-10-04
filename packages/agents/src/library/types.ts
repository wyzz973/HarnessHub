// SPDX-License-Identifier: MIT
import type { SecretReference } from "@harnesshub/core/engine-configuration";

/** The agents the Library writes into; the core Adapters of 04 section 2. */
export const libraryAgents = [
  "claude",
  "codex",
  "gemini",
  "qwen",
  "opencode",
  "pi",
  "crush",
  "kimi",
  "hermes",
] as const;
export type LibraryAgent = (typeof libraryAgents)[number];

/** What the Library keeps: instruction sets, MCP servers and skills. */
export type LibraryKind = "instructions" | "mcp" | "skills";

/**
 * A secret of an MCP server, never its value: HarnessHub's secret store, an
 * environment variable of the agent's (and the daemon's) environment, or a
 * file (07 section 4.3).
 */
export type LibrarySecretRef = SecretReference & {
  kind: "store" | "env" | "file";
};

/** A Markdown instruction set; an agent gets at most one. */
export interface InstructionSet {
  id: string;
  name: string;
  /** SHA-256 of the text, which lives in `instructions/<id>.md`. */
  sha256: string;
  size: number;
  agents: LibraryAgent[];
  createdAt: string;
  updatedAt: string;
}

/** One MCP server: a command the agent starts, or a URL it reaches. */
export interface McpServerItem {
  name: string;
  transport: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  url?: string;
  /** Plain environment of a stdio server. */
  env?: Record<string, string>;
  /** Environment whose values are secrets, by reference. */
  secretEnv?: Record<string, LibrarySecretRef>;
  /** Plain headers of an http or sse server. */
  headers?: Record<string, string>;
  /** Headers whose values are secrets, by reference. */
  secretHeaders?: Record<string, LibrarySecretRef>;
  agents: LibraryAgent[];
  createdAt: string;
  updatedAt: string;
}

/** An Agent Skill: a directory with `SKILL.md`, kept by content. */
export interface SkillItem {
  name: string;
  description: string;
  /** SHA-256 over the sorted file list and contents; names the stored copy. */
  sha256: string;
  files: number;
  size: number;
  agents: LibraryAgent[];
  createdAt: string;
  updatedAt: string;
}

/** `<dataDir>/library/library.json`. */
export interface LibraryIndex {
  schemaVersion: 1;
  instructions: InstructionSet[];
  mcp: McpServerItem[];
  skills: SkillItem[];
}

/** What the Library last wrote into one file of an agent. */
export interface AppliedFile {
  path: string;
  /** The directory the file must resolve within (the home or an override). */
  root: string;
  /** The original bytes' backup (absent: the file did not exist). */
  original?: { sha256: string; mode: number };
  /** SHA-256 of the file as last written. */
  afterHash: string;
  /**
   * Whether the original bytes may be written back as they are once nothing
   * of the Library is left and the file is as last written. False after a
   * write over a file the user had changed since the Library's last one.
   */
  byteRestore: boolean;
  /** Directories created for the file, outermost first. */
  createdDirectories: string[];
}

/** What the Library owns in one agent. */
export interface AppliedAgent {
  files: AppliedFile[];
  /** The instruction set whose block is in the instructions file. */
  instructions?: { path: string; set: string; sha256: string };
  /** MCP servers written, by name: the file and the container key path. */
  mcp?: {
    path: string;
    container: string[];
    /** Whether the Library created the container object. */
    createdContainer: boolean;
    servers: string[];
  };
  /** Skills placed, by name. */
  skills: Record<
    string,
    { path: string; mode: "link" | "copy"; sha256: string }
  >;
  /** Directories created for skills, outermost first. */
  skillDirectories: string[];
}

/** `<dataDir>/library/applied.json`, by agent. */
export interface AppliedState {
  schemaVersion: 1;
  agents: Partial<Record<LibraryAgent, AppliedAgent>>;
}
