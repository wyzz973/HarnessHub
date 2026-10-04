// SPDX-License-Identifier: MIT
/**
 * The Library's own storage under `<dataDir>/library/` (04 section 8):
 * `library.json` lists the items, `instructions/<id>.md` holds each
 * instruction set's text, `skills/<sha256>/<name>/` each stored skill
 * version (content-addressed, never changed in place, so a link an agent
 * follows always sees a whole skill), and `applied.json` what the Library
 * owns in each agent. Files are private (0600, directories 0700) and
 * written through a temporary file and a rename. One process owns a data
 * directory; callers serialize operations.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { LibraryError } from "./errors.js";
import {
  INSTRUCTION_SET_ID,
  MCP_SERVER_NAME,
  parseInstructionSet,
  readSkill,
  SKILL_NAME,
  SKIPPED_SKILL_ENTRIES,
  type SkillFile,
} from "./validate.js";
import {
  libraryAgents,
  type AppliedState,
  type InstructionSet,
  type LibraryAgent,
  type LibraryIndex,
  type McpServerItem,
  type SkillItem,
} from "./types.js";

const EMPTY_INDEX: LibraryIndex = {
  schemaVersion: 1,
  instructions: [],
  mcp: [],
  skills: [],
};

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

/** Writes a private file through a temporary file and a rename. */
async function writePrivate(
  file: string,
  data: string | Buffer,
): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    await writeFile(temporary, data, { flag: "wx", mode: 0o600 });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch (error) {
    if (isCode(error, "ENOENT")) return undefined;
    throw new LibraryError(
      "LIBRARY_INVALID",
      `${file} is not valid JSON; fix or remove it`,
    );
  }
}

/** A minimal structural check of a stored index; items were validated when written. */
function isIndex(value: unknown): value is LibraryIndex {
  return (
    object(value) &&
    value.schemaVersion === 1 &&
    Array.isArray(value.instructions) &&
    Array.isArray(value.mcp) &&
    Array.isArray(value.skills) &&
    value.instructions.every(
      (item) =>
        object(item) &&
        typeof item.id === "string" &&
        INSTRUCTION_SET_ID.test(item.id) &&
        Array.isArray(item.agents),
    ) &&
    value.mcp.every(
      (item) =>
        object(item) &&
        typeof item.name === "string" &&
        MCP_SERVER_NAME.test(item.name) &&
        Array.isArray(item.agents),
    ) &&
    value.skills.every(
      (item) =>
        object(item) &&
        typeof item.name === "string" &&
        SKILL_NAME.test(item.name) &&
        typeof item.sha256 === "string" &&
        /^[0-9a-f]{64}$/.test(item.sha256) &&
        Array.isArray(item.agents),
    )
  );
}

function isApplied(value: unknown): value is AppliedState {
  return (
    object(value) &&
    value.schemaVersion === 1 &&
    object(value.agents) &&
    Object.keys(value.agents).every((agent) =>
      (libraryAgents as readonly string[]).includes(agent),
    )
  );
}

export class LibraryStore {
  readonly directory: string;

  constructor(
    dataDir: string,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.directory = path.join(dataDir, "library");
  }

  /** The items. @throws LibraryError `LIBRARY_INVALID` for a damaged `library.json`. */
  async index(): Promise<LibraryIndex> {
    const value = await readJson(path.join(this.directory, "library.json"));
    if (value === undefined) return structuredClone(EMPTY_INDEX);
    if (!isIndex(value))
      throw new LibraryError(
        "LIBRARY_INVALID",
        "library.json is not a Library index; fix or remove it",
      );
    return value;
  }

  /** What the Library owns in each agent. */
  async applied(): Promise<AppliedState> {
    const value = await readJson(path.join(this.directory, "applied.json"));
    if (value === undefined) return { schemaVersion: 1, agents: {} };
    if (!isApplied(value))
      throw new LibraryError(
        "LIBRARY_INVALID",
        "applied.json is not a Library state; restore it from a backup",
      );
    return value;
  }

  async saveApplied(state: AppliedState): Promise<void> {
    await writePrivate(
      path.join(this.directory, "applied.json"),
      `${JSON.stringify(state, null, 2)}\n`,
    );
  }

  /** The text of an instruction set. */
  async instructionText(id: string): Promise<string> {
    return readFile(
      path.join(this.directory, "instructions", `${id}.md`),
      "utf8",
    );
  }

  /** Where a stored skill version is: a directory named as the skill. */
  skillDirectory(sha256: string, name: string): string {
    return path.join(this.directory, "skills", sha256, name);
  }

  /**
   * Creates or replaces an instruction set (`input`: name, text, agents).
   * An agent gets one set: one that another set already goes to fails with
   * `LIBRARY_CONFLICT`.
   */
  async putInstructionSet(
    id: string,
    input: unknown,
  ): Promise<InstructionSet & { text: string }> {
    const fields = parseInstructionSet(input, id);
    const index = await this.index();
    for (const other of index.instructions)
      if (other.id !== id) {
        const shared = other.agents.filter((agent) =>
          fields.agents.includes(agent),
        );
        if (shared.length)
          throw new LibraryError(
            "LIBRARY_CONFLICT",
            `${shared.join(", ")} already ${shared.length === 1 ? "gets" : "get"} the instruction set ${other.id}; an agent gets one set`,
          );
      }
    const now = this.now();
    const existing = index.instructions.find((item) => item.id === id);
    const item: InstructionSet = {
      id,
      name: fields.name,
      sha256: createHash("sha256").update(fields.text).digest("hex"),
      size: Buffer.byteLength(fields.text),
      agents: fields.agents,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await writePrivate(
      path.join(this.directory, "instructions", `${id}.md`),
      `${fields.text}\n`,
    );
    index.instructions = [
      ...index.instructions.filter((other) => other.id !== id),
      item,
    ].sort((a, b) => a.id.localeCompare(b.id));
    await this.saveIndex(index);
    return { ...item, text: fields.text };
  }

  /**
   * Creates or replaces an MCP server; its secrets are references (the
   * caller stored any value first).
   */
  async putMcpServer(
    server: Omit<McpServerItem, "createdAt" | "updatedAt">,
  ): Promise<{ item: McpServerItem; previous: McpServerItem | undefined }> {
    const index = await this.index();
    const previous = index.mcp.find((item) => item.name === server.name);
    const now = this.now();
    const item: McpServerItem = {
      ...server,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    index.mcp = [
      ...index.mcp.filter((other) => other.name !== server.name),
      item,
    ].sort((a, b) => a.name.localeCompare(b.name));
    await this.saveIndex(index);
    return { item, previous };
  }

  /**
   * Imports a skill directory (`readSkill` validates it) as a new stored
   * version, or replaces the agents of the skill of that name when its
   * content is unchanged.
   */
  async importSkill(
    source: string,
    agents: LibraryAgent[],
  ): Promise<SkillItem> {
    const skill = await readSkill(source);
    await this.storeVersion(skill);
    return this.indexSkill(versionOf(skill), agents);
  }

  /**
   * Imports a skill from uploaded files (paths with `/` below the skill
   * directory) as `importSkill` imports a directory: the same validation
   * through `storeSkillFiles`, then the index. Entries a skill directory
   * does not hold (`.DS_Store`, `.git`) are dropped first.
   *
   * @throws LibraryError `LIBRARY_SKILL_INVALID`.
   */
  async importSkillFiles(
    name: string,
    files: ReadonlyArray<{ path: string; bytes: Buffer; executable: boolean }>,
    agents: LibraryAgent[],
  ): Promise<SkillItem> {
    const kept = files.filter(
      (file) =>
        !file.path
          .split("/")
          .some((segment) => SKIPPED_SKILL_ENTRIES.has(segment)),
    );
    return this.indexSkill(await this.storeSkillFiles(name, kept), agents);
  }

  /** Points the skill of the version's name at it, for `agents`. */
  private async indexSkill(
    version: Omit<SkillItem, "agents" | "createdAt" | "updatedAt">,
    agents: LibraryAgent[],
  ): Promise<SkillItem> {
    const index = await this.index();
    const previous = index.skills.find((item) => item.name === version.name);
    const now = this.now();
    const item: SkillItem = {
      ...version,
      agents,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    index.skills = [
      ...index.skills.filter((other) => other.name !== version.name),
      item,
    ].sort((a, b) => a.name.localeCompare(b.name));
    await this.saveIndex(index);
    return item;
  }

  /**
   * Stores a skill version from its files (paths with `/` below the skill
   * directory), validated as `readSkill` validates a directory named
   * `name`; the index is not changed. A path that leaves the directory, or
   * that a skill directory cannot hold, fails with LIBRARY_SKILL_INVALID.
   *
   * @returns The version's fields.
   */
  async storeSkillFiles(
    name: string,
    files: ReadonlyArray<{ path: string; bytes: Buffer; executable: boolean }>,
  ): Promise<Omit<SkillItem, "agents" | "createdAt" | "updatedAt">> {
    if (!SKILL_NAME.test(name))
      throw new LibraryError(
        "LIBRARY_SKILL_INVALID",
        `${JSON.stringify(name.slice(0, 64))} is not a skill name`,
      );
    const incoming = path.join(
      this.directory,
      "skills",
      `.staging-${randomBytes(6).toString("hex")}`,
    );
    try {
      for (const file of files) {
        const segments = file.path.split("/");
        if (
          segments.some(
            (segment) =>
              !segment ||
              segment === "." ||
              segment === ".." ||
              /[\\:\0]/.test(segment),
          )
        )
          throw new LibraryError(
            "LIBRARY_SKILL_INVALID",
            `${JSON.stringify(file.path.slice(0, 200))} is not a file inside a skill`,
          );
        const destination = path.join(incoming, name, ...segments);
        await mkdir(path.dirname(destination), {
          recursive: true,
          mode: 0o700,
        });
        await writeFile(destination, file.bytes, {
          flag: "wx",
          mode: file.executable ? 0o700 : 0o600,
        });
      }
      const skill = await readSkill(path.join(incoming, name));
      const read = skill.files.map((file) => file.path).sort();
      const given = files.map((file) => file.path).sort();
      if (read.join("\0") !== given.join("\0"))
        throw new LibraryError(
          "LIBRARY_SKILL_INVALID",
          `The files of ${name} include some that a skill does not hold`,
        );
      await this.storeVersion(skill);
      return versionOf(skill);
    } finally {
      await rm(incoming, { recursive: true, force: true });
    }
  }

  /** A stored version's files, as `readSkill` reads them. */
  async skillFiles(sha256: string, name: string): Promise<SkillFile[]> {
    return (await readSkill(this.skillDirectory(sha256, name))).files;
  }

  /**
   * Writes items brought from a backup or another machine with their own
   * timestamps: an item of the same id or name is replaced and the others
   * are added; with `mirror`, items not given are removed. Skills name
   * versions already stored (`storeSkillFiles`). An agent keeps one
   * instruction set: a set kept from here gives up the agents a given set
   * takes. Instruction texts are written before the index, which is
   * written once.
   *
   * @returns The items removed or replaced, for their owners to release
   *   (an MCP server's store secrets).
   */
  async restore(
    items: {
      instructions: ReadonlyArray<InstructionSet & { text: string }>;
      mcp: readonly McpServerItem[];
      skills: readonly SkillItem[];
    },
    mirror: boolean,
  ): Promise<{
    removed: { instructions: string[]; mcp: McpServerItem[]; skills: string[] };
    replaced: { mcp: McpServerItem[] };
  }> {
    const index = await this.index();
    const given = {
      instructions: new Set(items.instructions.map((item) => item.id)),
      mcp: new Set(items.mcp.map((item) => item.name)),
      skills: new Set(items.skills.map((item) => item.name)),
    };
    const taken = new Set(items.instructions.flatMap((item) => item.agents));
    const keptSets = mirror
      ? []
      : index.instructions
          .filter((item) => !given.instructions.has(item.id))
          .map((item) => ({
            ...item,
            agents: item.agents.filter((agent) => !taken.has(agent)),
          }));
    for (const item of items.instructions)
      await writePrivate(
        path.join(this.directory, "instructions", `${item.id}.md`),
        `${item.text}\n`,
      );
    const removed = {
      instructions: mirror
        ? index.instructions
            .filter((item) => !given.instructions.has(item.id))
            .map((item) => item.id)
        : [],
      mcp: mirror ? index.mcp.filter((item) => !given.mcp.has(item.name)) : [],
      skills: mirror
        ? index.skills
            .filter((item) => !given.skills.has(item.name))
            .map((item) => item.name)
        : [],
    };
    const replaced = {
      mcp: index.mcp.filter((item) => given.mcp.has(item.name)),
    };
    const byId = <T>(list: T[], key: (item: T) => string) =>
      list.sort((a, b) => key(a).localeCompare(key(b)));
    await this.saveIndex({
      schemaVersion: 1,
      instructions: byId(
        [
          ...keptSets,
          ...items.instructions.map(({ text: _text, ...item }) => item),
        ],
        (item) => item.id,
      ),
      mcp: byId(
        [
          ...(mirror
            ? []
            : index.mcp.filter((item) => !given.mcp.has(item.name))),
          ...items.mcp,
        ],
        (item) => item.name,
      ),
      skills: byId(
        [
          ...(mirror
            ? []
            : index.skills.filter((item) => !given.skills.has(item.name))),
          ...items.skills,
        ],
        (item) => item.name,
      ),
    });
    for (const id of removed.instructions)
      await rm(path.join(this.directory, "instructions", `${id}.md`), {
        force: true,
      });
    return { removed, replaced };
  }

  /** Replaces the agents of a stored skill. */
  async setSkillAgents(
    name: string,
    agents: LibraryAgent[],
  ): Promise<SkillItem> {
    const index = await this.index();
    const item = index.skills.find((other) => other.name === name);
    if (!item) throw notFound("skill", name);
    item.agents = agents;
    item.updatedAt = this.now();
    await this.saveIndex(index);
    return item;
  }

  /**
   * Deletes an item from the Library; agents keep it until the next sync
   * removes it. @returns The deleted item.
   */
  async remove(
    kind: "instructions" | "mcp" | "skills",
    key: string,
  ): Promise<InstructionSet | McpServerItem | SkillItem> {
    const index = await this.index();
    if (kind === "instructions") {
      const item = index.instructions.find((other) => other.id === key);
      if (!item) throw notFound("instruction set", key);
      index.instructions = index.instructions.filter((other) => other !== item);
      await this.saveIndex(index);
      await rm(path.join(this.directory, "instructions", `${key}.md`), {
        force: true,
      });
      return item;
    }
    if (kind === "mcp") {
      const item = index.mcp.find((other) => other.name === key);
      if (!item) throw notFound("MCP server", key);
      index.mcp = index.mcp.filter((other) => other !== item);
      await this.saveIndex(index);
      return item;
    }
    const item = index.skills.find((other) => other.name === key);
    if (!item) throw notFound("skill", key);
    index.skills = index.skills.filter((other) => other !== item);
    await this.saveIndex(index);
    return item;
  }

  /**
   * Removes stored skill versions that neither the index nor any agent
   * (`applied`) refers to, and what an interrupted import left.
   */
  async collect(): Promise<void> {
    const referenced = new Set<string>();
    for (const item of (await this.index()).skills) referenced.add(item.sha256);
    for (const agent of Object.values((await this.applied()).agents))
      for (const skill of Object.values(agent?.skills ?? {}))
        referenced.add(skill.sha256);
    let names: string[];
    try {
      names = await readdir(path.join(this.directory, "skills"));
    } catch (error) {
      if (isCode(error, "ENOENT")) return;
      throw error;
    }
    for (const name of names)
      if (
        (/^[0-9a-f]{64}$/.test(name) && !referenced.has(name)) ||
        // Left by an import that was interrupted; operations are serialized.
        name.startsWith(".staging-")
      ) {
        await rm(path.join(this.directory, "skills", name), {
          recursive: true,
          force: true,
        });
      }
  }

  /** Stores a read skill under `skills/<sha256>/<name>/` unless that version is there. */
  private async storeVersion(skill: ReadSkill): Promise<void> {
    const target = path.join(this.directory, "skills", skill.sha256);
    if (await exists(target)) return;
    const staging = path.join(
      this.directory,
      "skills",
      `.staging-${randomBytes(6).toString("hex")}`,
    );
    try {
      for (const file of skill.files) {
        const destination = path.join(
          staging,
          skill.name,
          ...file.path.split("/"),
        );
        await mkdir(path.dirname(destination), {
          recursive: true,
          mode: 0o700,
        });
        await writeFile(destination, file.bytes, {
          flag: "wx",
          mode: file.executable ? 0o700 : 0o600,
        });
      }
      await rename(staging, target);
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      if (!(await exists(target))) throw error;
    }
  }

  private async saveIndex(index: LibraryIndex): Promise<void> {
    await writePrivate(
      path.join(this.directory, "library.json"),
      `${JSON.stringify(index, null, 2)}\n`,
    );
  }

  private now(): string {
    return this.clock().toISOString();
  }
}

type ReadSkill = Awaited<ReturnType<typeof readSkill>>;

function versionOf(
  skill: ReadSkill,
): Omit<SkillItem, "agents" | "createdAt" | "updatedAt"> {
  return {
    name: skill.name,
    description: skill.description,
    sha256: skill.sha256,
    files: skill.files.length,
    size: skill.files.reduce((total, file) => total + file.bytes.length, 0),
  };
}

function notFound(kind: string, key: string): LibraryError {
  return new LibraryError(
    "LIBRARY_NOT_FOUND",
    `No ${kind} in the Library is named ${JSON.stringify(key.slice(0, 120))}`,
  );
}

async function exists(file: string): Promise<boolean> {
  try {
    await readdir(file);
    return true;
  } catch (error) {
    if (isCode(error, "ENOENT")) return false;
    throw error;
  }
}
