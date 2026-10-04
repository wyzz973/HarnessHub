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
  parseMcpServer,
  planLibrarySync,
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
   * Imports the skill directory `input.source` (an absolute path on this
   * machine) as a new version, for `input.agents`. The directory is
   * validated against the Agent Skills specification first (400
   * LIBRARY_SKILL_INVALID).
   */
  importSkill(input: unknown): Promise<SkillItem> {
    return this.serial(async () => {
      if (!object(input) || typeof input.source !== "string")
        throw new LibraryError(
          "LIBRARY_INVALID",
          "A skill import needs source, the absolute path of the skill directory",
        );
      for (const key of Object.keys(input))
        if (key !== "source" && key !== "agents")
          throw new LibraryError(
            "LIBRARY_INVALID",
            `${key} is not a field of a skill import`,
          );
      // Every Library agent has a skills directory.
      const agents = parseAgents(input.agents, () => undefined);
      const item = await this.store.importSkill(input.source, agents);
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
