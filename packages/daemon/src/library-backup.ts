// SPDX-License-Identifier: MIT
/**
 * The Library as a backup or a sync carries it (docs/backup-sync.md):
 * instruction sets with their text, MCP servers whose secrets are outside
 * references or, only in a backup with keys, the values of stored secrets,
 * and skills with their files. A skill file over 2 MiB is left out, and so
 * is every file once the skills come to 32 MiB, as in Magpie's
 * `internal/library/carry.go` (yetone/magpie, MIT, 2e340f7): a backup is
 * for text. What the Library wrote into each agent stays this machine's.
 */
import {
  INSTRUCTION_SET_ID,
  MCP_SERVER_NAME,
  SKILL_NAME,
} from "@harnesshub/agents/library/index";
import { isTimestamp } from "@harnesshub/core/model-plane-records";

/** A skill file bigger than this is left out of a backup. */
export const SKILL_FILE_LIMIT = 2 * 1024 * 1024;
/** Files past this many bytes of all skills together are left out. */
export const SKILLS_LIMIT = 32 * 1024 * 1024;

/** A secret of an MCP server: a stored value (with keys), or an outside reference. */
export type BackupLibrarySecret =
  | { source: "store"; value?: string }
  | { source: "reference"; kind: "env" | "file"; name: string };

export interface BackupInstructionSet {
  id: string;
  name: string;
  text: string;
  agents: string[];
  createdAt: string;
  updatedAt: string;
}

export interface BackupMcpServer {
  name: string;
  transport: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  secretEnv?: Record<string, BackupLibrarySecret>;
  headers?: Record<string, string>;
  secretHeaders?: Record<string, BackupLibrarySecret>;
  agents: string[];
  createdAt: string;
  updatedAt: string;
}

export interface BackupSkill {
  name: string;
  description: string;
  agents: string[];
  createdAt: string;
  updatedAt: string;
  /** The files carried, base64, by path with `/` below the skill directory. */
  files: Record<string, string>;
  /** The files carried that are executable. */
  exec?: string[];
  /** Files left out: over 2 MiB, or past the 32 MiB of all skills. */
  left?: string[];
}

export interface BackupLibrary {
  instructions: BackupInstructionSet[];
  mcp: BackupMcpServer[];
  skills: BackupSkill[];
}

/** What bringing a Library in does (a dry run) or did. */
export interface LibraryRestore {
  instructions: { added: string[]; replaced: string[]; removed: string[] };
  mcp: {
    added: string[];
    replaced: string[];
    removed: string[];
    /** `server: NAME`: a stored secret the backup has no value for and this machine lacks; left out. */
    needSecret: string[];
  };
  skills: {
    added: string[];
    replaced: string[];
    removed: string[];
    /** Skills brought in without the files left out of the backup. */
    incomplete: string[];
  };
  /** Items not brought in, and why. */
  refused: Array<{
    kind: "instructions" | "mcp" | "skills";
    name: string;
    reason: string;
  }>;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length <= max;

const strings = (value: unknown, max = 1000): value is string[] =>
  Array.isArray(value) &&
  value.length <= max &&
  value.every((item) => text(item, 8192));

const stringMap = (value: unknown): boolean =>
  value === undefined ||
  (object(value) &&
    Object.keys(value).length <= 64 &&
    Object.values(value).every((item) => text(item, 8192)));

function isSecret(value: unknown): value is BackupLibrarySecret {
  if (!object(value)) return false;
  if (value.source === "store")
    return (
      value.value === undefined ||
      (typeof value.value === "string" &&
        value.value.length > 0 &&
        value.value.length <= 8192)
    );
  return (
    value.source === "reference" &&
    (value.kind === "env" || value.kind === "file") &&
    typeof value.name === "string" &&
    value.name.length > 0 &&
    value.name.length <= 4096
  );
}

const secretMap = (value: unknown): boolean =>
  value === undefined ||
  (object(value) &&
    Object.keys(value).length <= 64 &&
    Object.values(value).every(isSecret));

const timestamps = (value: Record<string, unknown>) =>
  isTimestamp(value.createdAt) && isTimestamp(value.updatedAt);

function isInstructionSet(value: unknown): value is BackupInstructionSet {
  return (
    object(value) &&
    typeof value.id === "string" &&
    INSTRUCTION_SET_ID.test(value.id) &&
    text(value.name, 200) &&
    text(value.text, 256 * 1024) &&
    strings(value.agents, 64) &&
    timestamps(value)
  );
}

function isMcpServer(value: unknown): value is BackupMcpServer {
  return (
    object(value) &&
    typeof value.name === "string" &&
    MCP_SERVER_NAME.test(value.name) &&
    (value.transport === "stdio" ||
      value.transport === "http" ||
      value.transport === "sse") &&
    (value.command === undefined || text(value.command, 8192)) &&
    (value.args === undefined || strings(value.args, 128)) &&
    (value.url === undefined || text(value.url, 8192)) &&
    stringMap(value.env) &&
    stringMap(value.headers) &&
    secretMap(value.secretEnv) &&
    secretMap(value.secretHeaders) &&
    strings(value.agents, 64) &&
    timestamps(value)
  );
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function isSkill(value: unknown): value is BackupSkill {
  return (
    object(value) &&
    typeof value.name === "string" &&
    SKILL_NAME.test(value.name) &&
    text(value.description, 1024) &&
    strings(value.agents, 64) &&
    timestamps(value) &&
    object(value.files) &&
    Object.keys(value.files).length <= 500 &&
    Object.entries(value.files).every(
      ([file, data]) =>
        file.length > 0 &&
        file.length <= 1024 &&
        typeof data === "string" &&
        BASE64.test(data),
    ) &&
    (value.exec === undefined || strings(value.exec, 500)) &&
    (value.left === undefined || strings(value.left, 500))
  );
}

const unique = (names: string[]) => new Set(names).size === names.length;

/**
 * Whether `value` is a carried Library: its items well formed, each named
 * once, and no agent given two instruction sets. What an item says is
 * checked again, item by item, when it is brought in.
 */
export function isBackupLibrary(value: unknown): value is BackupLibrary {
  if (
    !object(value) ||
    !Array.isArray(value.instructions) ||
    !value.instructions.every(isInstructionSet) ||
    !Array.isArray(value.mcp) ||
    !value.mcp.every(isMcpServer) ||
    !Array.isArray(value.skills) ||
    !value.skills.every(isSkill)
  )
    return false;
  const agents = value.instructions.flatMap((item) => item.agents);
  return (
    unique(value.instructions.map((item) => item.id)) &&
    unique(value.mcp.map((item) => item.name)) &&
    unique(value.skills.map((item) => item.name)) &&
    unique(agents)
  );
}

/**
 * The Library as sync compares it: without the names of files left out,
 * which a machine that brought a skill in without them no longer has.
 */
export function libraryView(library: BackupLibrary | undefined): unknown {
  if (!library) return { instructions: [], mcp: [], skills: [] };
  return {
    ...library,
    skills: library.skills.map(({ left: _left, ...skill }) => skill),
  };
}

/**
 * `from` with the stored secret values it lacks taken from the server of
 * the same name in `to`, so that a side carrying no values does not take
 * the other's away.
 */
export function withLibraryValues(
  from: BackupLibrary,
  to: BackupLibrary | undefined,
): BackupLibrary {
  const fill = (
    secrets: Record<string, BackupLibrarySecret> | undefined,
    other: Record<string, BackupLibrarySecret> | undefined,
  ) =>
    secrets &&
    Object.fromEntries(
      Object.entries(secrets).map(([name, secret]) => {
        const there = other?.[name];
        return [
          name,
          secret.source === "store" &&
          secret.value === undefined &&
          there?.source === "store" &&
          there.value !== undefined
            ? ({ source: "store", value: there.value } as const)
            : secret,
        ];
      }),
    );
  return {
    ...from,
    mcp: from.mcp.map((server) => {
      const other = to?.mcp.find((item) => item.name === server.name);
      const secretEnv = fill(server.secretEnv, other?.secretEnv);
      const secretHeaders = fill(server.secretHeaders, other?.secretHeaders);
      return {
        ...server,
        ...(secretEnv ? { secretEnv } : {}),
        ...(secretHeaders ? { secretHeaders } : {}),
      };
    }),
  };
}

/** Whether a carried Library holds no item. */
export function emptyLibrary(library: BackupLibrary | undefined): boolean {
  return (
    !library ||
    (library.instructions.length === 0 &&
      library.mcp.length === 0 &&
      library.skills.length === 0)
  );
}
