// SPDX-License-Identifier: MIT
/**
 * Validation of Library items as they arrive (API bodies are `unknown`) and
 * of skill directories against the Agent Skills specification
 * (agentskills.io/specification): `SKILL.md` with YAML front matter whose
 * `name` (lowercase letters, digits and hyphens, the directory's own name)
 * and `description` are required.
 */
import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
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
const SKILL_LIMITS = { files: 500, bytes: 20 * 1024 * 1024 };
/** Entries of a skill directory that are not part of it. */
const SKIPPED = new Set([".DS_Store", ".git", ".harnesshub-skill"]);

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
 * Reads and validates a skill directory: regular files and directories only
 * (no links), at most 500 files and 20 MiB, `SKILL.md` front matter as the
 * specification requires, the directory named as the skill.
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
      const full = path.join(root, name);
      const bytes = await readFile(full);
      total += bytes.length;
      if (files.length >= SKILL_LIMITS.files || total > SKILL_LIMITS.bytes)
        throw fail(
          `The skill exceeds ${SKILL_LIMITS.files} files or ${SKILL_LIMITS.bytes} bytes`,
        );
      files.push({
        path: name,
        bytes,
        executable:
          process.platform !== "win32" &&
          ((await lstat(full)).mode & 0o100) !== 0,
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
