// SPDX-License-Identifier: MIT
/**
 * The Library as the daemon runs it (04-agent-plane section 8): instruction
 * sets, MCP servers and skills in `<dataDir>/library`, synced into the
 * agents of the wiring home by `@harnesshub/agents/library`. MCP secrets
 * are references only: a value given to the API goes to the secret store
 * and the item keeps its `store` reference. References to HarnessHub's own
 * credentials are refused when an item is registered and again when it is
 * synced (07-data-security section 4.6, 400 SECRET_REF_FORBIDDEN); a value
 * reaches an agent's file only with explicit consent, and never when it is
 * one of HarnessHub's credentials.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import type { SecretReference } from "@harnesshub/core/engine-configuration";
import { HubError } from "@harnesshub/core/errors";
import { NO_LOG, type LogSink } from "@harnesshub/core/logging";
import type { ModelPlaneStore } from "@harnesshub/core/model-plane";
import {
  applyLibrarySync,
  LibraryError,
  LibraryStore,
  parseAgents,
  parseInstructionSet,
  parseMcpServer,
  planLibrarySync,
  SKILL_LIMITS,
  type ConfirmedLibraryPlan,
  type InstructionSet,
  type LibraryAgent,
  type LibraryIndex,
  type LibraryPlan,
  type LibrarySecretRef,
  type LibrarySources,
  type McpServerItem,
  type SkillItem,
} from "@harnesshub/agents/library/index";
import type { WiringHome } from "./agents-wiring.js";
import {
  SKILL_FILE_LIMIT,
  SKILLS_LIMIT,
  type BackupInstructionSet,
  type BackupLibrary,
  type BackupLibrarySecret,
  type BackupMcpServer,
  type BackupSkill,
  type LibraryRestore,
} from "./library-backup.js";

/** The secret store as the Library needs it (`SecretStore` of `@harnesshub/secrets`). */
export interface LibrarySecrets {
  create(value: string): Promise<SecretReference>;
  delete(ref: SecretReference): Promise<boolean>;
  resolve(
    ref: SecretReference,
    environment: Readonly<NodeJS.ProcessEnv>,
  ): Promise<string>;
}

export interface LibraryServiceOptions {
  dataDir: string;
  /** The config root; the file secret backend's master key is `<configDir>/secrets.key`. */
  configDir: string;
  /** Whose credentials MCP secrets may not refer to. */
  providers: Pick<ModelPlaneStore, "listProviders">;
  secrets: LibrarySecrets;
  /** The daemon's environment, which provider credentials' env references read. */
  environment: Readonly<NodeJS.ProcessEnv>;
  /** SHA-256 of the admin token, a value no MCP secret may have. */
  adminTokenDigest: Buffer;
  /** Where agents' files are; absent, syncing fails with AGENT_WIRING_UNAVAILABLE (503). */
  home: WiringHome | undefined;
  clock?: () => Date;
  log?: LogSink;
}

/** What to sync: `agents` default to every Library agent. */
export interface LibrarySyncRequest {
  agents?: LibraryAgent[];
  allowPlaintextSecret?: boolean;
  placement?: "auto" | "copy";
}

type SecretField = "secretEnv" | "secretHeaders";

/** A store reference stands in for a value until the value is stored. */
const PENDING = "pending";

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function forbidden(reason: string): LibraryError {
  return new LibraryError("SECRET_REF_FORBIDDEN", reason);
}

function refsOf(server: Pick<McpServerItem, SecretField>): LibrarySecretRef[] {
  return [
    ...Object.values(server.secretEnv ?? {}),
    ...Object.values(server.secretHeaders ?? {}),
  ];
}

/** The real path of `file`, or its absolute path while it does not exist. */
async function canonical(file: string): Promise<string> {
  const absolute = path.resolve(file);
  try {
    return await realpath(absolute);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return absolute;
    throw error;
  }
}

function within(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

/**
 * Runs Library operations one at a time. Items change only through the
 * store; agents' files change only through `apply`, under the agents'
 * wiring locks, which global wiring shares.
 */
export class LibraryService {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly store: LibraryStore;
  /** Files of stored skill versions by version, for backups and syncs. */
  private readonly skillCache = new Map<string, CarriedFile[]>();
  private readonly log: LogSink;

  constructor(private readonly options: LibraryServiceOptions) {
    this.store = new LibraryStore(options.dataDir, options.clock);
    this.log = options.log ?? NO_LOG;
  }

  /** Every item. */
  index(): Promise<LibraryIndex> {
    return this.serial(() => this.store.index());
  }

  /** One instruction set with its text; 404 LIBRARY_NOT_FOUND. */
  instructions(id: string): Promise<InstructionSet & { text: string }> {
    return this.serial(async () => {
      const item = (await this.store.index()).instructions.find(
        (other) => other.id === id,
      );
      if (!item) throw notFound("instruction set", id);
      return { ...item, text: (await this.store.instructionText(id)).trim() };
    });
  }

  /**
   * Creates (`create`: 409 LIBRARY_EXISTS when the id is taken) or replaces
   * an instruction set from `input` (name, text, agents).
   */
  putInstructions(
    id: string,
    input: unknown,
    create: boolean,
  ): Promise<InstructionSet & { text: string }> {
    return this.serial(async () => {
      if (
        create &&
        (await this.store.index()).instructions.some((item) => item.id === id)
      )
        throw exists("instruction set", id);
      return this.store.putInstructionSet(id, input);
    });
  }

  /** One MCP server; 404 LIBRARY_NOT_FOUND. */
  mcp(name: string): Promise<McpServerItem> {
    return this.serial(async () => {
      const item = (await this.store.index()).mcp.find(
        (other) => other.name === name,
      );
      if (!item) throw notFound("MCP server", name);
      return item;
    });
  }

  /**
   * Creates (`create`: 409 LIBRARY_EXISTS when the name is taken) or
   * replaces an MCP server. A secret is a reference `{kind: env|file,
   * value}`, a `{kind: store, value}` the server already holds, or a value
   * `{secret}`, which goes to the secret store. A reference or value that is
   * one of HarnessHub's credentials fails with 400 SECRET_REF_FORBIDDEN
   * before anything is stored. Store secrets the server no longer uses are
   * deleted after the item is saved.
   */
  putMcp(
    name: string,
    input: unknown,
    create: boolean,
  ): Promise<McpServerItem> {
    return this.serial(async () => {
      const previous = (await this.store.index()).mcp.find(
        (other) => other.name === name,
      );
      if (create && previous) throw exists("MCP server", name);
      if (!object(input))
        throw new LibraryError(
          "LIBRARY_INVALID",
          "The MCP server must be an object",
        );
      const held = new Set(
        refsOf(previous ?? {})
          .filter((ref) => ref.kind === "store")
          .map((ref) => ref.value),
      );
      const values: Array<{ field: SecretField; name: string; value: string }> =
        [];
      const body: Record<string, unknown> = { ...input };
      for (const field of ["secretEnv", "secretHeaders"] as const) {
        const map = input[field];
        if (!object(map)) continue;
        const refs: Record<string, unknown> = {};
        for (const [key, entry] of Object.entries(map)) {
          if (object(entry) && Object.hasOwn(entry, "secret")) {
            if (
              Object.keys(entry).length !== 1 ||
              typeof entry.secret !== "string" ||
              !entry.secret ||
              entry.secret.length > 8192
            )
              throw new LibraryError(
                "LIBRARY_INVALID",
                `${field}.${key} must be {secret} with a value of 1 to 8192 characters`,
              );
            values.push({ field, name: key, value: entry.secret });
            refs[key] = { kind: "store", value: PENDING };
            continue;
          }
          if (
            object(entry) &&
            entry.kind === "store" &&
            (typeof entry.value !== "string" || !held.has(entry.value))
          )
            throw new LibraryError(
              "LIBRARY_INVALID",
              `${field}.${key}: a store reference must be one this server already holds; give a new value as {secret}`,
            );
          refs[key] = entry;
        }
        body[field] = refs;
      }
      const server = parseMcpServer(body, name);
      for (const ref of refsOf(server))
        if (!(
          ref.kind === "store" &&
          (ref.value === PENDING || held.has(ref.value))
        )) {
          const reason = await this.forbiddenRef(ref);
          if (reason) throw forbidden(reason);
        }
      for (const item of values)
        if (await this.forbiddenValue(item.value))
          throw forbidden(
            `${item.field}.${item.name} is the value of one of HarnessHub's own credentials`,
          );
      const created: SecretReference[] = [];
      let saved: McpServerItem;
      try {
        for (const item of values) {
          const ref = await this.options.secrets.create(item.value);
          created.push(ref);
          server[item.field]![item.name] = { kind: "store", value: ref.value };
        }
        saved = (await this.store.putMcpServer(server)).item;
      } catch (error) {
        await this.deleteSecrets(created, error);
        throw error;
      }
      const kept = new Set(refsOf(saved).map((ref) => ref.value));
      await this.dropSecrets(
        refsOf(previous ?? {}).filter(
          (ref) => ref.kind === "store" && !kept.has(ref.value),
        ),
      );
      return saved;
    });
  }

  /** One skill; 404 LIBRARY_NOT_FOUND. */
  skill(name: string): Promise<SkillItem> {
    return this.serial(async () => {
      const item = (await this.store.index()).skills.find(
        (other) => other.name === name,
      );
      if (!item) throw notFound("skill", name);
      return item;
    });
  }

  /**
   * Imports a skill as a new version, for `input.agents`: the directory
   * `input.source` (an absolute path on this machine), or an upload of its
   * files, `input.name` with `input.files` (base64 by path with `/` below the
   * skill directory, as backups carry skills) and `input.exec` (the paths
   * that are executable). Either is validated against the Agent Skills
   * specification the same way (400 LIBRARY_SKILL_INVALID): at most 500
   * files and 20 MiB, counted before content is read; paths every platform
   * can hold, none twice where case and Unicode normalization are ignored,
   * none out of the directory; an upload holds regular files only, so it
   * cannot carry a link. A skill of the same name is replaced only with
   * `input.replace: true`; otherwise 409 LIBRARY_EXISTS, and nothing is
   * stored.
   */
  importSkill(input: unknown): Promise<SkillItem> {
    return this.serial(async () => {
      if (!object(input))
        throw new LibraryError(
          "LIBRARY_INVALID",
          "A skill import is an object",
        );
      const upload = input.files !== undefined;
      const fields = upload
        ? ["name", "files", "exec", "agents", "replace"]
        : ["source", "agents", "replace"];
      for (const key of Object.keys(input))
        if (!fields.includes(key))
          throw new LibraryError(
            "LIBRARY_INVALID",
            `${key} is not a field of a skill ${upload ? "upload" : "import"}`,
          );
      if (input.replace !== undefined && typeof input.replace !== "boolean")
        throw new LibraryError("LIBRARY_INVALID", "replace is true or false");
      const options = { replace: input.replace === true };
      // Every Library agent has a skills directory.
      const agents = parseAgents(input.agents, () => undefined);
      let item: SkillItem;
      if (upload) {
        if (typeof input.name !== "string")
          throw new LibraryError(
            "LIBRARY_INVALID",
            "A skill upload needs name, the skill's directory name",
          );
        item = await this.store.importSkillFiles(
          input.name,
          uploadedFiles(input.files, input.exec),
          agents,
          options,
        );
      } else {
        if (typeof input.source !== "string")
          throw new LibraryError(
            "LIBRARY_INVALID",
            "A skill import needs source, the absolute path of the skill directory, or name and files",
          );
        item = await this.store.importSkill(input.source, agents, options);
      }
      await this.store.collect();
      return item;
    });
  }

  /** Replaces the agents a skill goes to. */
  setSkillAgents(name: string, input: unknown): Promise<SkillItem> {
    return this.serial(async () => {
      if (!object(input) || Object.keys(input).some((key) => key !== "agents"))
        throw new LibraryError(
          "LIBRARY_INVALID",
          "Only agents of a skill can change",
        );
      return this.store.setSkillAgents(
        name,
        parseAgents(input.agents, () => undefined),
      );
    });
  }

  /**
   * Deletes an item from the Library; agents keep it until the next sync
   * takes it out. An MCP server's store secrets are deleted with it.
   */
  remove(kind: "instructions" | "mcp" | "skills", key: string): Promise<void> {
    return this.serial(async () => {
      const item = await this.store.remove(kind, key);
      if (kind === "mcp")
        await this.dropSecrets(
          refsOf(item as McpServerItem).filter((ref) => ref.kind === "store"),
        );
      if (kind === "skills") await this.store.collect();
    });
  }

  /** What syncing would change in each agent's files; nothing is written. */
  plan(request: LibrarySyncRequest): Promise<LibraryPlan> {
    return this.serial(async () =>
      planLibrarySync(
        await this.store.index(),
        await this.store.applied(),
        this.sources(),
        this.context(),
        request,
      ),
    );
  }

  /**
   * Syncs as the confirmed plan `expect` shows: a file changed since fails
   * with 409 LIBRARY_CONCURRENT_MODIFICATION before that agent is written.
   * Agents are written one by one; each one's state is saved before the
   * next starts.
   */
  apply(
    request: LibrarySyncRequest & { expect: ConfirmedLibraryPlan },
  ): Promise<LibraryPlan> {
    return this.serial(async () => {
      const result = await applyLibrarySync(
        await this.store.index(),
        await this.store.applied(),
        this.sources(),
        this.context(),
        {
          ...request,
          persist: (state) => this.store.saveApplied(state),
        },
      );
      await this.store.collect();
      for (const agent of result.agents)
        if (agent.changed)
          this.log.info("library.synced", {
            agent: agent.agent,
            files: agent.files.filter((file) => file.action !== "unchanged")
              .length,
            skills: agent.skills.filter((skill) => skill.action !== "unchanged")
              .length,
            refused: agent.refused.length,
          });
      return result;
    });
  }

  /**
   * The Library as a backup carries it (`library-backup.ts`): the values
   * of stored MCP secrets only with `keys`, outside references always, and
   * each skill's files within the size limits.
   */
  carry(keys: boolean): Promise<BackupLibrary> {
    return this.serial(async () => {
      const index = await this.store.index();
      const carrySecrets = async (
        secrets: Record<string, LibrarySecretRef> | undefined,
      ) => {
        if (!secrets) return undefined;
        const result: Record<string, BackupLibrarySecret> = {};
        for (const [name, ref] of Object.entries(secrets))
          result[name] =
            ref.kind === "store"
              ? {
                  source: "store",
                  ...(keys
                    ? {
                        value: await this.options.secrets.resolve(
                          ref,
                          this.options.environment,
                        ),
                      }
                    : {}),
                }
              : { source: "reference", kind: ref.kind, name: ref.value };
        return result;
      };
      const instructions: BackupInstructionSet[] = [];
      for (const item of index.instructions)
        instructions.push({
          id: item.id,
          name: item.name,
          text: (await this.store.instructionText(item.id)).trim(),
          agents: [...item.agents],
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
        });
      const mcp: BackupMcpServer[] = [];
      for (const item of index.mcp) {
        const { secretEnv, secretHeaders, ...rest } = item;
        const env = await carrySecrets(secretEnv);
        const headers = await carrySecrets(secretHeaders);
        mcp.push({
          ...rest,
          agents: [...item.agents],
          ...(env ? { secretEnv: env } : {}),
          ...(headers ? { secretHeaders: headers } : {}),
        });
      }
      for (const version of this.skillCache.keys())
        if (!index.skills.some((item) => item.sha256 === version))
          this.skillCache.delete(version);
      let budget = SKILLS_LIMIT;
      const skills: BackupSkill[] = [];
      for (const item of index.skills) {
        const carried = carrySkill(
          await this.skillFiles(item.sha256, item.name),
          budget,
        );
        budget = carried.budget;
        skills.push({
          name: item.name,
          description: item.description,
          agents: [...item.agents],
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
          ...carried.skill,
        });
      }
      return { instructions, mcp, skills };
    });
  }

  /**
   * Brings a carried Library in: items of the same id or name replaced,
   * the others added, and with `mirror` (sync) the items it lacks removed;
   * timestamps are kept. Each item is checked as the API checks it: one
   * that fails, or whose secret is one of HarnessHub's credentials
   * (SECRET_REF_FORBIDDEN), is refused and named. A stored secret without
   * a value keeps this machine's secret of the same server and name, or is
   * left out and named. A skill whose carried files are as this machine's
   * keeps this machine's version. With `dryRun` nothing is written. Agents'
   * files are not touched: syncing them is a separate plan and apply.
   */
  bring(
    library: BackupLibrary,
    options: { mirror: boolean; dryRun: boolean },
  ): Promise<LibraryRestore> {
    return this.serial(async () => {
      const index = await this.store.index();
      const result: LibraryRestore = {
        instructions: { added: [], replaced: [], removed: [] },
        mcp: { added: [], replaced: [], removed: [], needSecret: [] },
        skills: { added: [], replaced: [], removed: [], incomplete: [] },
        refused: [],
      };
      const refuse = (
        kind: LibraryRestore["refused"][number]["kind"],
        name: string,
        error: unknown,
      ) => {
        if (!(error instanceof HubError)) throw error;
        result.refused.push({ kind, name, reason: error.message });
      };
      const sets: Array<InstructionSet & { text: string }> = [];
      for (const item of library.instructions)
        try {
          const fields = parseInstructionSet(
            { name: item.name, text: item.text, agents: item.agents },
            item.id,
          );
          sets.push({
            id: item.id,
            name: fields.name,
            sha256: createHash("sha256").update(fields.text).digest("hex"),
            size: Buffer.byteLength(fields.text),
            agents: fields.agents,
            text: fields.text,
            createdAt: item.createdAt,
            updatedAt: item.updatedAt,
          });
        } catch (error) {
          refuse("instructions", item.id, error);
        }
      const servers: McpServerItem[] = [];
      const values: Array<{
        server: McpServerItem;
        field: SecretField;
        name: string;
        value: string;
      }> = [];
      for (const item of library.mcp)
        try {
          const local = index.mcp.find((other) => other.name === item.name);
          const pending: Array<Omit<(typeof values)[number], "server">> = [];
          const missing: string[] = [];
          const body: Record<string, unknown> = {
            transport: item.transport,
            ...(item.command !== undefined ? { command: item.command } : {}),
            ...(item.args ? { args: item.args } : {}),
            ...(item.url !== undefined ? { url: item.url } : {}),
            ...(item.env ? { env: item.env } : {}),
            ...(item.headers ? { headers: item.headers } : {}),
            agents: item.agents,
          };
          for (const field of ["secretEnv", "secretHeaders"] as const) {
            const refs: Record<string, LibrarySecretRef> = {};
            for (const [name, secret] of Object.entries(item[field] ?? {})) {
              if (secret.source === "reference") {
                const ref = { kind: secret.kind, value: secret.name };
                const reason = await this.forbiddenRef(ref);
                if (reason) throw forbidden(reason);
                refs[name] = ref;
              } else if (secret.value !== undefined) {
                if (await this.forbiddenValue(secret.value))
                  throw forbidden(
                    `${field}.${name} is the value of one of HarnessHub's own credentials`,
                  );
                refs[name] = { kind: "store", value: PENDING };
                pending.push({ field, name, value: secret.value });
              } else {
                const own = local?.[field]?.[name];
                if (own?.kind === "store") refs[name] = own;
                else missing.push(`${item.name}: ${name}`);
              }
            }
            if (Object.keys(refs).length) body[field] = refs;
          }
          const parsed = parseMcpServer(body, item.name);
          const server: McpServerItem = {
            ...parsed,
            createdAt: item.createdAt,
            updatedAt: item.updatedAt,
          };
          for (const entry of pending) values.push({ ...entry, server });
          result.mcp.needSecret.push(...missing);
          servers.push(server);
        } catch (error) {
          refuse("mcp", item.name, error);
        }
      const skills: SkillItem[] = [];
      const versions: Array<{ item: BackupSkill; agents: LibraryAgent[] }> = [];
      for (const item of library.skills)
        try {
          const agents = parseAgents(item.agents, () => undefined);
          const local = index.skills.find((other) => other.name === item.name);
          if (
            local &&
            sameFiles(
              carrySkill(
                await this.skillFiles(local.sha256, local.name),
                SKILLS_LIMIT,
              ).skill,
              item,
            )
          )
            skills.push({
              ...local,
              agents,
              createdAt: item.createdAt,
              updatedAt: item.updatedAt,
            });
          else versions.push({ item, agents });
        } catch (error) {
          refuse("skills", item.name, error);
        }
      const tally = <T>(
        target: { added: string[]; replaced: string[]; removed: string[] },
        given: readonly T[],
        here: readonly T[],
        key: (item: T) => string,
      ) => {
        const names = new Set(here.map(key));
        for (const item of given)
          (names.has(key(item)) ? target.replaced : target.added).push(
            key(item),
          );
        if (options.mirror) {
          const kept = new Set(given.map(key));
          target.removed.push(...[...names].filter((name) => !kept.has(name)));
        }
      };
      const refusedNames = (kind: string) =>
        new Set(
          result.refused
            .filter((item) => item.kind === kind)
            .map((item) => item.name),
        );
      if (options.dryRun) {
        tally(result.instructions, sets, index.instructions, (item) => item.id);
        tally(result.mcp, servers, index.mcp, (item) => item.name);
        tally(
          result.skills,
          [
            ...skills.map((item) => item.name),
            ...versions.map(({ item }) => item.name),
          ],
          index.skills.map((item) => item.name),
          (name) => name,
        );
        for (const { item } of versions)
          if (item.left?.length) result.skills.incomplete.push(item.name);
        return excludeRefused(result, refusedNames);
      }
      for (const { item, agents } of versions)
        try {
          const version = await this.store.storeSkillFiles(
            item.name,
            Object.entries(item.files).map(([file, data]) => ({
              path: file,
              bytes: Buffer.from(data, "base64"),
              executable: item.exec?.includes(file) === true,
            })),
          );
          skills.push({
            ...version,
            agents,
            createdAt: item.createdAt,
            updatedAt: item.updatedAt,
          });
          if (item.left?.length) result.skills.incomplete.push(item.name);
        } catch (error) {
          refuse("skills", item.name, error);
        }
      // A refused item stays as this machine has it, also under `mirror`.
      const keep = <T>(
        here: readonly T[],
        kind: string,
        key: (item: T) => string,
      ) => {
        const names = refusedNames(kind);
        return here.filter((item) => names.has(key(item)));
      };
      const created: SecretReference[] = [];
      try {
        for (const entry of values) {
          const own = index.mcp.find(
            (other) => other.name === entry.server.name,
          )?.[entry.field]?.[entry.name];
          let ref: SecretReference | undefined;
          if (
            own?.kind === "store" &&
            (await this.options.secrets.resolve(
              own,
              this.options.environment,
            )) === entry.value
          )
            ref = own;
          else {
            ref = await this.options.secrets.create(entry.value);
            created.push(ref);
          }
          entry.server[entry.field]![entry.name] = {
            kind: "store",
            value: ref.value,
          };
        }
        const instructionsKept = await Promise.all(
          keep(index.instructions, "instructions", (item) => item.id).map(
            async (item) => ({
              ...item,
              text: (await this.store.instructionText(item.id)).trim(),
            }),
          ),
        );
        const { removed, replaced } = await this.store.restore(
          {
            instructions: [...sets, ...instructionsKept],
            mcp: [...servers, ...keep(index.mcp, "mcp", (item) => item.name)],
            skills: [
              ...skills,
              ...keep(index.skills, "skills", (item) => item.name),
            ],
          },
          options.mirror,
        );
        tally(result.instructions, sets, index.instructions, (item) => item.id);
        tally(result.mcp, servers, index.mcp, (item) => item.name);
        tally(result.skills, skills, index.skills, (item) => item.name);
        const used = new Set(
          [...servers, ...keep(index.mcp, "mcp", (item) => item.name)].flatMap(
            (server) => refsOf(server).map((ref) => ref.value),
          ),
        );
        await this.dropSecrets(
          [...removed.mcp, ...replaced.mcp]
            .flatMap((server) => refsOf(server))
            .filter((ref) => ref.kind === "store" && !used.has(ref.value)),
        );
      } catch (error) {
        await this.deleteSecrets(created, error);
        throw error;
      }
      await this.store.collect();
      return excludeRefused(result, refusedNames);
    });
  }

  /** When the Library last changed here: its items' newest `updatedAt`. */
  lastChange(): Promise<string | undefined> {
    return this.serial(async () => {
      const index = await this.store.index();
      const times = [...index.instructions, ...index.mcp, ...index.skills].map(
        (item) => Date.parse(item.updatedAt),
      );
      const latest = Math.max(...times);
      return Number.isFinite(latest)
        ? new Date(latest).toISOString()
        : undefined;
    });
  }

  /**
   * A stored version's files as carried: versions never change, so each is
   * read once; the bytes of a file too big to carry are not kept.
   */
  private async skillFiles(
    sha256: string,
    name: string,
  ): Promise<CarriedFile[]> {
    const cached = this.skillCache.get(sha256);
    if (cached) return cached;
    const files = (await this.store.skillFiles(sha256, name)).map(
      (file): CarriedFile => ({
        path: file.path,
        size: file.bytes.length,
        executable: file.executable,
        ...(file.bytes.length <= SKILL_FILE_LIMIT ? { bytes: file.bytes } : {}),
      }),
    );
    this.skillCache.set(sha256, files);
    return files;
  }

  private sources(): LibrarySources {
    const home = this.home();
    return {
      instructionText: (id) => this.store.instructionText(id),
      skillDirectory: (sha256, name) => this.store.skillDirectory(sha256, name),
      skillsRoot: path.join(this.store.directory, "skills"),
      // The agent reads an env secret from its own environment.
      resolve: (ref) =>
        this.options.secrets.resolve(
          ref,
          ref.kind === "env" ? home.env : this.options.environment,
        ),
      forbiddenValue: (value) => this.forbiddenValue(value),
      forbiddenRef: (ref) => this.forbiddenRef(ref),
    };
  }

  /**
   * Why `ref` may not be a tool's secret (07 section 4.6), or undefined:
   * an `HH_` or `HARNESSHUB_` variable, a file in HarnessHub's data or
   * configuration directory (admin token, secret store and its master key),
   * or the same reference as a provider credential (same store id, same
   * variable, same file after resolving links).
   */
  private async forbiddenRef(
    ref: LibrarySecretRef,
  ): Promise<string | undefined> {
    const caseless = process.platform === "win32";
    const same = (a: string, b: string) =>
      caseless ? a.toUpperCase() === b.toUpperCase() : a === b;
    if (ref.kind === "env" && /^(HH_|HARNESSHUB_)/i.test(ref.value))
      return `${ref.value} is one of HarnessHub's own environment variables`;
    const file = ref.kind === "file" ? await canonical(ref.value) : undefined;
    if (file)
      for (const [root, what] of [
        [this.options.dataDir, "data"],
        [this.options.configDir, "configuration"],
      ] as const)
        if (within(await canonical(root), file))
          return `${ref.value} is in HarnessHub's ${what} directory, which holds its own credentials`;
    for (const provider of await this.options.providers.listProviders())
      for (const credential of provider.credentials) {
        const other = credential.ref;
        if (other.kind !== ref.kind) continue;
        const match =
          ref.kind === "env"
            ? same(other.value, ref.value)
            : ref.kind === "file"
              ? (await canonical(other.value)) === file
              : other.value === ref.value;
        if (match)
          return `it is the reference of credential ${credential.id} of provider ${provider.id}`;
      }
    return undefined;
  }

  /**
   * Whether `value` is one of HarnessHub's credentials: a Gateway Key
   * (`hhk_`), the admin token, or the value of a provider credential,
   * compared by SHA-256 digest. A credential whose reference does not
   * resolve here (SECRET_UNAVAILABLE: an unset variable, a missing file, a
   * locked keychain) has no value to match; other failures reject.
   */
  private async forbiddenValue(value: string): Promise<boolean> {
    if (value.startsWith("hhk_")) return true;
    const digest = sha256(value);
    if (timingSafeEqual(digest, this.options.adminTokenDigest)) return true;
    for (const provider of await this.options.providers.listProviders())
      for (const credential of provider.credentials) {
        let other: string;
        try {
          other = await this.options.secrets.resolve(
            credential.ref,
            this.options.environment,
          );
        } catch (error) {
          // Missing, locked or unreadable here: there is no value to match.
          if (error instanceof HubError && error.code === "SECRET_UNAVAILABLE")
            continue;
          throw error;
        }
        if (timingSafeEqual(digest, sha256(other))) return true;
      }
    return false;
  }

  /** Deletes secrets created for a failed save; a failure joins the save's. */
  private async deleteSecrets(
    refs: readonly SecretReference[],
    cause: unknown,
  ): Promise<void> {
    const failures: unknown[] = [];
    for (const ref of refs)
      await this.options.secrets.delete(ref).catch((error: unknown) => {
        failures.push(error);
      });
    if (failures.length)
      throw new AggregateError(
        [cause, ...failures],
        "Saving the MCP server failed and the secrets stored for it could not all be deleted",
      );
  }

  /**
   * Deletes store secrets an item no longer uses. The item is already
   * saved, so a failure is logged with the secret's id (never its value)
   * for removal by hand instead of failing the request.
   */
  private async dropSecrets(refs: readonly SecretReference[]): Promise<void> {
    for (const ref of refs)
      await this.options.secrets.delete(ref).catch((error: unknown) => {
        this.log.info("library.secret_delete_failed", {
          secret: ref.value,
          message: error instanceof Error ? error.message : String(error),
        });
      });
  }

  private home(): WiringHome {
    const home = this.options.home;
    if (!home)
      throw new HubError(
        "AGENT_WIRING_UNAVAILABLE",
        "This daemon was started without a wiring home; hh serve sets it to your home directory",
        503,
      );
    return home;
  }

  private context() {
    const home = this.home();
    return {
      home: home.home,
      dataDir: this.options.dataDir,
      env: home.env,
      ...(this.options.clock ? { clock: this.options.clock } : {}),
    };
  }

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action, action);
    this.queue = result.catch(() => undefined);
    return result;
  }
}

/**
 * The files of a skill upload, decoded and checked before anything is
 * written: within the skill limits and strict base64. Their paths are
 * checked before they are written (`storeSkillFiles`).
 *
 * @throws LibraryError `LIBRARY_SKILL_INVALID`, `LIBRARY_INVALID`.
 */
function uploadedFiles(
  files: unknown,
  exec: unknown,
): Array<{ path: string; bytes: Buffer; executable: boolean }> {
  const fail = (message: string) =>
    new LibraryError("LIBRARY_SKILL_INVALID", message);
  if (!object(files))
    throw new LibraryError(
      "LIBRARY_INVALID",
      "files maps each path below the skill directory to its base64 content",
    );
  if (
    exec !== undefined &&
    !(Array.isArray(exec) && exec.every((item) => typeof item === "string"))
  )
    throw new LibraryError("LIBRARY_INVALID", "exec lists file paths");
  const entries = Object.entries(files);
  if (entries.length > SKILL_LIMITS.files)
    throw fail(`The skill exceeds ${SKILL_LIMITS.files} files`);
  let total = 0;
  const decoded = entries.map(([file, data]) => {
    const where = JSON.stringify(file.slice(0, 200));
    if (
      typeof data !== "string" ||
      data.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(data)
    )
      throw fail(`The content of ${where} is not base64`);
    const bytes = Buffer.from(data, "base64");
    total += bytes.length;
    if (total > SKILL_LIMITS.bytes)
      throw fail(`The skill exceeds ${SKILL_LIMITS.bytes} bytes`);
    return { path: file, bytes, executable: false };
  });
  for (const file of (exec as string[] | undefined) ?? []) {
    const found = decoded.find((item) => item.path === file);
    if (!found)
      throw fail(
        `exec names ${JSON.stringify(file.slice(0, 200))}, which is not a file of the skill`,
      );
    found.executable = true;
  }
  return decoded;
}

/**
 * A skill's files as a backup carries them: base64 by path, the
 * executable ones, and those left out (over 2 MiB, or past `budget`).
 */
/** A skill file as backups carry it; `bytes` absent when it is too big to carry. */
interface CarriedFile {
  path: string;
  size: number;
  executable: boolean;
  bytes?: Buffer;
}

function carrySkill(
  files: readonly CarriedFile[],
  budget: number,
): { skill: Pick<BackupSkill, "files" | "exec" | "left">; budget: number } {
  const carried: Record<string, string> = {};
  const exec: string[] = [];
  const left: string[] = [];
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    if (!file.bytes || file.size > budget) {
      left.push(file.path);
      continue;
    }
    budget -= file.size;
    carried[file.path] = file.bytes.toString("base64");
    if (file.executable) exec.push(file.path);
  }
  return {
    skill: {
      files: carried,
      ...(exec.length ? { exec } : {}),
      ...(left.length ? { left } : {}),
    },
    budget,
  };
}

/** Whether two carried skills hold the same files; what was left out does not count. */
function sameFiles(
  here: Pick<BackupSkill, "files" | "exec">,
  there: Pick<BackupSkill, "files" | "exec">,
): boolean {
  const names = (skill: Pick<BackupSkill, "files">) =>
    Object.keys(skill.files).sort().join("\0");
  return (
    names(here) === names(there) &&
    Object.entries(here.files).every(
      ([file, data]) => there.files[file] === data,
    ) &&
    [...(here.exec ?? [])].sort().join("\0") ===
      [...(there.exec ?? [])].sort().join("\0")
  );
}

/** The result without the items that were refused. */
function excludeRefused(
  result: LibraryRestore,
  refused: (kind: string) => Set<string>,
): LibraryRestore {
  const without = (kind: string, names: string[]) =>
    names.filter((name) => !refused(kind).has(name));
  return {
    ...result,
    instructions: {
      added: without("instructions", result.instructions.added),
      replaced: without("instructions", result.instructions.replaced),
      removed: without("instructions", result.instructions.removed),
    },
    mcp: {
      ...result.mcp,
      added: without("mcp", result.mcp.added),
      replaced: without("mcp", result.mcp.replaced),
      removed: without("mcp", result.mcp.removed),
    },
    skills: {
      ...result.skills,
      added: without("skills", result.skills.added),
      replaced: without("skills", result.skills.replaced),
      removed: without("skills", result.skills.removed),
    },
  };
}

function notFound(kind: string, key: string): LibraryError {
  return new LibraryError(
    "LIBRARY_NOT_FOUND",
    `No ${kind} in the Library is named ${JSON.stringify(key.slice(0, 120))}`,
  );
}

function exists(kind: string, key: string): LibraryError {
  return new LibraryError(
    "LIBRARY_EXISTS",
    `The Library already has the ${kind} ${JSON.stringify(key.slice(0, 120))}; replace it with PUT`,
  );
}
