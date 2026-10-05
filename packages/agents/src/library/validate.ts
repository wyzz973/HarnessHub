// SPDX-License-Identifier: MIT
/**
 * Validation of Library items as they arrive (API bodies are `unknown`) and
 * of skill directories against the Agent Skills specification
 * (agentskills.io/specification): `SKILL.md` with YAML front matter whose
 * `name` (lowercase letters, digits and hyphens, the directory's own name)
 * and `description` are required.
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { LibraryError } from "./errors.js";
import { libraryCapabilities } from "./targets.js";
import {
  libraryAgents,
  type LibraryAgent,
  type LibrarySecretRef,
  type McpServerItem,
} from "./types.js";

export const INSTRUCTION_SET_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const MCP_SERVER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
export const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;
const MAX_TEXT = 8192;
const MAX_INSTRUCTIONS = 256 * 1024;
const MAX_MAP = 32;
const MAX_ARGS = 128;
/** The most files and bytes a skill holds. */
export const SKILL_LIMITS = Object.freeze({
  files: 500,
  bytes: 20 * 1024 * 1024,
});
/**
 * The longest name of one file or directory, the most levels and the
 * longest path (UTF-8 bytes, `/` between segments) of a file inside a skill:
 * what every file system HarnessHub stores and syncs skills on can hold
 * below the directories it adds.
 */
export const SKILL_PATH_LIMITS = Object.freeze({
  segmentBytes: 255,
  depth: 16,
  pathBytes: 512,
});

/** Names Windows reserves for devices, with or without an extension. */
const WINDOWS_DEVICE =
  /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/i;

/** Why one path (with `/`) below a skill directory cannot be a file of it, or undefined. */
function skillPathProblem(file: string): string | undefined {
  const where = JSON.stringify(file.slice(0, 200));
  const segments = file.split("/");
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        /[<>:"\\|?*\u0000-\u001f]/.test(segment),
    )
  )
    return `${where} is not a file inside a skill`;
  if (segments.length > SKILL_PATH_LIMITS.depth)
    return `${where} is more than ${SKILL_PATH_LIMITS.depth} levels deep`;
  if (Buffer.byteLength(file) > SKILL_PATH_LIMITS.pathBytes)
    return `${where} is longer than ${SKILL_PATH_LIMITS.pathBytes} bytes`;
  for (const segment of segments) {
    if (Buffer.byteLength(segment) > SKILL_PATH_LIMITS.segmentBytes)
      return `${where} has a name longer than ${SKILL_PATH_LIMITS.segmentBytes} bytes`;
    if (WINDOWS_DEVICE.test(segment) || /[. ]$/.test(segment))
      return `${where} has a name Windows cannot hold`;
  }
  return undefined;
}

/**
 * A path as file systems that ignore case and Unicode normalization (APFS,
 * NTFS) compare it: NFC, then upper case.
 */
function skillPathKey(file: string): string {
  return file.normalize("NFC").toUpperCase();
}

/**
 * Why `paths` (with `/`, below a skill directory) cannot be the files of
 * one skill, or undefined. Each must be a path every platform can hold
 * ({@link SKILL_PATH_LIMITS}; no `.` or `..`, characters Windows forbids,
 * device names such as `CON`, or a trailing dot or space), no two may be
 * one file where case and Unicode normalization are ignored, and none may
 * be both a file and a directory.
 */
export function skillPathsProblem(
  paths: readonly string[],
): string | undefined {
  const keys = new Set<string>();
  const directories = new Set<string>();
  for (const file of paths) {
    const problem = skillPathProblem(file);
    if (problem) return problem;
    const key = skillPathKey(file);
    if (keys.has(key))
      return `${JSON.stringify(file.slice(0, 200))} is given twice`;
    keys.add(key);
    const segments = key.split("/");
    for (let index = 1; index < segments.length; index++)
      directories.add(segments.slice(0, index).join("/"));
  }
  for (const file of paths)
    if (directories.has(skillPathKey(file)))
      return `${JSON.stringify(file.slice(0, 200))} is both a file and a directory`;
  return undefined;
}

/** Entries of a skill directory that are not part of it. */
export const SKIPPED_SKILL_ENTRIES: ReadonlySet<string> = new Set([
  ".DS_Store",
  ".git",
  ".harnesshub-skill",
]);
const SKIPPED = SKIPPED_SKILL_ENTRIES;

function invalid(message: string): LibraryError {
  return new LibraryError("LIBRARY_INVALID", message);
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, field: string, max = MAX_TEXT): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw invalid(
      `${field} must be a non-empty string of at most ${max} characters`,
    );
  return value;
}

/** The agents an item goes to: known, unique, and able to take `kind`. */
export function parseAgents(
  value: unknown,
  check: (agent: LibraryAgent) => string | undefined,
): LibraryAgent[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalid("agents must be a list");
  const agents: LibraryAgent[] = [];
  for (const item of value) {
    if (!(libraryAgents as readonly unknown[]).includes(item))
      throw invalid(
        `${JSON.stringify(String(item).slice(0, 64))} is not an agent the Library writes into (${libraryAgents.join(", ")})`,
      );
    const agent = item as LibraryAgent;
    const reason = check(agent);
    if (reason)
      throw new LibraryError("LIBRARY_UNSUPPORTED", `${agent}: ${reason}`);
    if (!agents.includes(agent)) agents.push(agent);
  }
  return agents;
}

/** The fields of an instruction set: name, Markdown text and agents. */
export function parseInstructionSet(
  input: unknown,
  id: string,
): { name: string; text: string; agents: LibraryAgent[] } {
  if (!INSTRUCTION_SET_ID.test(id))
    throw invalid(
      "An instruction set id is 1 to 63 lowercase letters, digits and hyphens",
    );
  if (!object(input)) throw invalid("The instruction set must be an object");
  for (const key of Object.keys(input))
    if (!["id", "name", "text", "agents"].includes(key))
      throw invalid(`${key} is not a field of an instruction set`);
  const body = text(input.text, "text", MAX_INSTRUCTIONS);
  return {
    name: input.name === undefined ? id : text(input.name, "name", 200),
    text: body.replace(/\r\n/g, "\n").trim(),
    agents: parseAgents(input.agents, (agent) =>
      libraryCapabilities[agent].instructions
        ? undefined
        : "has no user-wide instructions file",
    ),
  };
}

/**
 * Names that carry credentials by convention. Their values are secrets, so
 * they go in `secretEnv` or `secretHeaders` as references, never as plain
 * values in the Library or an agent's file.
 */
const SECRET_NAME =
  /(?:^|[_-])(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY)(?:$|[_-])/i;
const SECRET_HEADER =
  /^(?:authorization|proxy-authorization|cookie|x-api-key|api-key|x-auth-token)$/i;

function stringMap(
  value: unknown,
  field: string,
  key: RegExp,
  secret: RegExp,
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!object(value) || Object.keys(value).length > MAX_MAP)
    throw invalid(`${field} must be an object of at most ${MAX_MAP} entries`);
  for (const [name, item] of Object.entries(value)) {
    if (!key.test(name))
      throw invalid(
        `${field} has an invalid name ${JSON.stringify(name.slice(0, 64))}`,
      );
    if (secret.test(name))
      throw invalid(
        `${field}.${name} carries a credential; give it as a secret reference in secret${field[0]!.toUpperCase()}${field.slice(1)}`,
      );
    text(item, `${field}.${name}`);
  }
  return Object.keys(value).length
    ? (value as Record<string, string>)
    : undefined;
}

/**
 * Secret references of an MCP server as given: `{kind: env|file, value}`,
 * or, from the daemon after storing a value, `{kind: store, value: id}`.
 */
function secretMap(
  value: unknown,
  field: string,
  key: RegExp,
): Record<string, LibrarySecretRef> | undefined {
  if (value === undefined) return undefined;
  if (!object(value) || Object.keys(value).length > MAX_MAP)
    throw invalid(`${field} must be an object of at most ${MAX_MAP} entries`);
  const result: Record<string, LibrarySecretRef> = {};
  for (const [name, item] of Object.entries(value)) {
    if (!key.test(name))
      throw invalid(
        `${field} has an invalid name ${JSON.stringify(name.slice(0, 64))}`,
      );
    if (
      !object(item) ||
      !["store", "env", "file"].includes(item.kind as string) ||
      Object.keys(item).some(
        (member) => member !== "kind" && member !== "value",
      )
    )
      throw invalid(
        `${field}.${name} must be a secret reference {kind: env|file|store, value}`,
      );
    const reference = text(item.value, `${field}.${name}.value`);
    if (item.kind === "env" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(reference))
      throw invalid(`${field}.${name} names an invalid environment variable`);
    if (item.kind === "file" && !path.isAbsolute(reference))
      throw invalid(`${field}.${name} must name an absolute file`);
    result[name] = {
      kind: item.kind as LibrarySecretRef["kind"],
      value: reference,
    };
  }
  return Object.keys(result).length ? result : undefined;
}

/**
 * The fields of an MCP server (no timestamps). Secret values never get
 * here: the daemon has stored them and passes `store` references.
 */
export function parseMcpServer(
  input: unknown,
  name: string,
): Omit<McpServerItem, "createdAt" | "updatedAt"> {
  if (!MCP_SERVER_NAME.test(name))
    throw invalid(
      "An MCP server name is 1 to 64 letters, digits, underscores and hyphens",
    );
  if (!object(input)) throw invalid("The MCP server must be an object");
  for (const key of Object.keys(input))
    if (
      ![
        "name",
        "transport",
        "command",
        "args",
        "url",
        "env",
        "secretEnv",
        "headers",
        "secretHeaders",
        "agents",
      ].includes(key)
    )
      throw invalid(`${key} is not a field of an MCP server`);
  const transport = input.transport;
  if (transport !== "stdio" && transport !== "http" && transport !== "sse")
    throw invalid("transport must be stdio, http or sse");
  const env = stringMap(input.env, "env", ENV_NAME, SECRET_NAME);
  const secretEnv = secretMap(input.secretEnv, "secretEnv", ENV_NAME);
  const headers = stringMap(
    input.headers,
    "headers",
    HEADER_NAME,
    SECRET_HEADER,
  );
  const secretHeaders = secretMap(
    input.secretHeaders,
    "secretHeaders",
    HEADER_NAME,
  );
  const agents = parseAgents(input.agents, (agent) =>
    libraryCapabilities[agent].transports.includes(transport)
      ? undefined
      : `does not reach MCP servers over ${transport}`,
  );
  if (transport === "stdio") {
    if (input.url !== undefined || headers || secretHeaders)
      throw invalid("A stdio server has a command, not a URL or headers");
    if (
      input.args !== undefined &&
      (!Array.isArray(input.args) || input.args.length > MAX_ARGS)
    )
      throw invalid(`args must be a list of at most ${MAX_ARGS} strings`);
    const args: string[] = [];
    for (const [index, item] of (
      (input.args as unknown[] | undefined) ?? []
    ).entries()) {
      if (typeof item !== "string" || item.length > MAX_TEXT)
        throw invalid(`args[${index}] must be a string`);
      args.push(item);
    }
    for (const name of Object.keys(env ?? {}))
      if (secretEnv?.[name])
        throw invalid(`${name} is both in env and secretEnv`);
    return {
      name,
      transport,
      command: text(input.command, "command"),
      ...(args.length ? { args } : {}),
      ...(env ? { env } : {}),
      ...(secretEnv ? { secretEnv } : {}),
      agents,
    };
  }
  if (
    input.command !== undefined ||
    input.args !== undefined ||
    env ||
    secretEnv
  )
    throw invalid(
      `An ${transport} server has a URL, not a command or environment`,
    );
  const url = text(input.url, "url");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw invalid("url must be an http(s) URL");
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password
  )
    throw invalid("url must be an http(s) URL without credentials");
  for (const parameter of parsed.searchParams.keys())
    if (
      SECRET_NAME.test(parameter) ||
      /^(?:key|apikey|access_token)$/i.test(parameter)
    )
      throw invalid(
        `The url parameter ${parameter} carries a credential; give it as a secret header instead`,
      );
  for (const name of Object.keys(headers ?? {}))
    if (
      Object.keys(secretHeaders ?? {}).some(
        (secret) => secret.toLowerCase() === name.toLowerCase(),
      )
    )
      throw invalid(`${name} is both in headers and secretHeaders`);
  return {
    name,
    transport,
    url,
    ...(headers ? { headers } : {}),
    ...(secretHeaders ? { secretHeaders } : {}),
    agents,
  };
}

/** One file of a skill as read: its path below the skill directory and bytes. */
export interface SkillFile {
  path: string;
  bytes: Buffer;
  executable: boolean;
}

/**
 * A regular file's bytes and mode, or why it cannot be read as a file of a
 * skill: its size is checked against `room` before anything is read (a
 * large or sparse file is never loaded), and again on the open handle,
 * which neither follows a link nor waits on a pipe swapped in meanwhile.
 */
async function readSkillFile(
  file: string,
  room: number,
): Promise<{ bytes: Buffer; mode: number } | "too large" | "not a file"> {
  const before = await lstat(file);
  if (!before.isFile()) return "not a file";
  if (before.size > room) return "too large";
  let handle;
  try {
    handle = await open(
      file,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
  } catch (error) {
    // A link swapped in after the directory was read.
    if ((error as NodeJS.ErrnoException).code === "ELOOP") return "not a file";
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return "not a file";
    if (info.size > room) return "too large";
    const bytes = Buffer.alloc(info.size);
    let read = 0;
    while (read < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        read,
        bytes.length - read,
        read,
      );
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    // A file that grew while it was read may now be over the limit.
    if ((await handle.read(Buffer.alloc(1), 0, 1, read)).bytesRead > 0)
      return "too large";
    return { bytes: bytes.subarray(0, read), mode: info.mode };
  } finally {
    await handle.close();
  }
}

/**
 * Reads and validates a skill directory: regular files and directories only
 * (no links), at most 500 files and 20 MiB, `SKILL.md` front matter as the
 * specification requires, the directory named as the skill. Sizes count
 * before content is read, so a directory over the limit costs no memory.
 *
 * @throws LibraryError `LIBRARY_SKILL_INVALID`.
 */
export async function readSkill(source: string): Promise<{
  name: string;
  description: string;
  files: SkillFile[];
  sha256: string;
}> {
  const fail = (message: string) =>
    new LibraryError("LIBRARY_SKILL_INVALID", message);
  if (!path.isAbsolute(source))
    throw fail("The skill directory must be an absolute path");
  const root = path.resolve(source);
  const info = await lstat(root).catch(() => undefined);
  if (!info?.isDirectory()) throw fail("The skill source is not a directory");
  const files: SkillFile[] = [];
  let total = 0;
  const walk = async (relative: string): Promise<void> => {
    const entries = await readdir(path.join(root, relative), {
      withFileTypes: true,
    });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIPPED.has(entry.name)) continue;
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink())
        throw fail(`${name} is a link; a skill holds files only`);
      if (entry.isDirectory()) {
        await walk(name);
        continue;
      }
      if (!entry.isFile()) throw fail(`${name} is not a regular file`);
      const tooLarge = () =>
        fail(
          `The skill exceeds ${SKILL_LIMITS.files} files or ${SKILL_LIMITS.bytes} bytes`,
        );
      if (files.length >= SKILL_LIMITS.files) throw tooLarge();
      const read = await readSkillFile(
        path.join(root, name),
        SKILL_LIMITS.bytes - total,
      );
      if (read === "too large") throw tooLarge();
      if (read === "not a file") throw fail(`${name} is not a regular file`);
      total += read.bytes.length;
      files.push({
        path: name,
        bytes: read.bytes,
        executable: process.platform !== "win32" && (read.mode & 0o100) !== 0,
      });
    }
  };
  await walk("");
  const manifest = files.find((file) => file.path === "SKILL.md");
  if (!manifest) throw fail("A skill needs SKILL.md at its top");
  let markdown: string;
  try {
    markdown = new TextDecoder("utf-8", { fatal: true }).decode(manifest.bytes);
  } catch {
    throw fail("SKILL.md must be UTF-8");
  }
  const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (!front)
    throw fail("SKILL.md must start with YAML front matter between --- lines");
  let fields: unknown;
  try {
    fields = parseYaml(front[1]!);
  } catch {
    throw fail("The front matter of SKILL.md is not valid YAML");
  }
  if (!object(fields))
    throw fail("The front matter of SKILL.md must be a mapping");
  const name = fields.name;
  const description = fields.description;
  if (typeof name !== "string" || name.length > 64 || !SKILL_NAME.test(name))
    throw fail(
      "The skill name must be 1 to 64 lowercase letters, digits and single hyphens",
    );
  if (name !== path.basename(root))
    throw fail(`The skill name ${name} must be the name of its directory`);
  if (
    typeof description !== "string" ||
    !description.trim() ||
    description.length > 1024
  )
    throw fail("The skill needs a description of at most 1024 characters");
  const hash = createHash("sha256");
  for (const file of files)
    hash.update(
      `${file.path}\0${file.executable ? "x" : "-"}\0${createHash("sha256").update(file.bytes).digest("hex")}\n`,
    );
  return {
    name,
    description: description.trim(),
    files,
    sha256: hash.digest("hex"),
  };
}
