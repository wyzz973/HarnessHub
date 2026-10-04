// SPDX-License-Identifier: MIT
/**
 * Syncing the Library into agents (04 section 8): each agent gets the
 * instruction set, MCP servers and skills assigned to it, and loses what the
 * Library wrote before that is no longer assigned. Writes follow global
 * wiring: a plan with a diff first; under the agent's wiring lock, the
 * original bytes are saved before a file is first changed, files are
 * replaced atomically and read back, and a failure restores what was
 * written. The Library owns only what it wrote: the marked instructions
 * block, the MCP entries it added and the skills it placed. An entry of the
 * same name that is the user's is reported, never replaced. Once nothing of
 * the Library is left in a file that is as the Library last wrote it, the
 * original bytes come back (or the file goes, when the Library created it).
 */
import { randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  rmdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { readOriginal, saveOriginal } from "../wiring/backups.js";
import { unifiedDiff } from "../wiring/diff.js";
import {
  createParents,
  decodeText,
  deleteFile,
  encodeText,
  isCode,
  readState,
  removeEmptyDirectories,
  removeStaleTemporaries,
  resolveFile,
  sha256,
  withAdapterLock,
  writeAtomic,
  type FileState,
} from "../wiring/files.js";
import {
  editors,
  type ConfigFormat,
  type ConfigValue,
} from "../wiring/formats/index.js";
import {
  clone,
  deepEqual,
  deletePath,
  getPath,
  isRecord,
} from "../wiring/formats/values.js";
import {
  adapterEnvironment,
  checkContext,
  type WiringContext,
} from "../wiring/operations.js";
import type { FileLocation } from "../wiring/adapters/types.js";
import { LibraryError } from "./errors.js";
import { encodeServer, renderSecrets, type SecretRendering } from "./mcp.js";
import { libraryTarget, type LibraryTarget } from "./targets.js";
import { readSkill } from "./validate.js";
import {
  libraryAgents,
  type AppliedAgent,
  type AppliedFile,
  type AppliedState,
  type LibraryAgent,
  type LibraryIndex,
  type LibraryKind,
  type LibrarySecretRef,
} from "./types.js";

const BLOCK_BEGIN = "<!-- harnesshub:begin";
const BLOCK_END = "<!-- harnesshub:end -->";
/** The file a copied skill carries, naming the stored version it copies. */
export const SKILL_MARKER = ".harnesshub-skill";
const VERSION = /^[0-9a-f]{64}$/;

/** What syncing reads besides the index: texts, stored skills and secrets. */
export interface LibrarySources extends Omit<
  SecretRendering,
  "allowPlaintext"
> {
  instructionText(id: string): Promise<string>;
  /** The stored directory of a skill version, named as the skill. */
  skillDirectory(sha256: string, name: string): string;
  /** The directory every stored skill version is under. */
  skillsRoot: string;
  /**
   * Why a secret reference may not reach a tool (07 section 4.6: a provider
   * credential, a HarnessHub credential file, an `HH_` or `HARNESSHUB_`
   * variable); undefined when it may.
   */
  forbiddenRef(ref: LibrarySecretRef): Promise<string | undefined>;
}

export interface LibrarySyncOptions {
  /** The agents to sync; default: every Library agent. */
  agents?: readonly LibraryAgent[];
  /** Write the values of secrets an agent cannot reference; the plan warns. */
  allowPlaintextSecret?: boolean;
  /** `copy` copies skills; `auto` links them, copying where links are refused. */
  placement?: "auto" | "copy";
}

export interface LibraryPlanFile {
  kind: "instructions" | "mcp";
  path: string;
  exists: boolean;
  /** SHA-256 of the current bytes; `applyLibrarySync` checks it against `expect`. */
  hash?: string;
  /** `restore` writes the original bytes back; `delete` removes a file the Library created. */
  action: "write" | "restore" | "delete" | "unchanged";
  /** Unified diff; secret values written as plain text show as `<secret>`. */
  diff: string;
}

export interface LibraryPlanSkill {
  name: string;
  path: string;
  action: "place" | "replace" | "remove" | "unchanged";
}

export interface LibraryRefusal {
  kind: LibraryKind;
  name: string;
  reason: string;
}

export interface LibraryAgentPlan {
  agent: LibraryAgent;
  name: string;
  changed: boolean;
  files: LibraryPlanFile[];
  skills: LibraryPlanSkill[];
  /** Items assigned to the agent that are not written, and why. */
  refused: LibraryRefusal[];
  warnings: string[];
}

export interface LibraryPlan {
  changed: boolean;
  agents: LibraryAgentPlan[];
}

/** What `applyLibrarySync` compares of a confirmed plan: each file's existence and hash. */
export interface ConfirmedLibraryPlan {
  agents: ReadonlyArray<{
    agent: string;
    files: ReadonlyArray<{ path: string; exists: boolean; hash?: string }>;
  }>;
}

interface FilePlan {
  kind: "instructions" | "mcp";
  path: string;
  realPath: string;
  root: string;
  format: ConfigFormat | "markdown";
  state: FileState;
  bom: boolean;
  before: string | undefined;
  /** The text written; undefined for `delete`. */
  after: string | undefined;
  /** The original bytes `restore` writes. */
  original?: Buffer;
  action: LibraryPlanFile["action"];
  record: AppliedFile | undefined;
  /** Nothing of the Library is left in the file afterwards. */
  ownsNothing: boolean;
  /** Checks the written text beyond reading back the same bytes. */
  verify: (text: string) => boolean;
  masks: readonly string[];
}

interface SkillPlan extends LibraryPlanSkill {
  sha256?: string;
  /** What is at `path` now, for `replace` and `remove`. */
  placed?: "link" | "copy";
}

interface AgentPlan {
  view: LibraryAgentPlan;
  target: LibraryTarget;
  files: FilePlan[];
  skills: SkillPlan[];
  /** The agent's state once the plan is written. */
  next: AppliedAgent;
  /** Whether `next` differs from the current state. */
  stateChanged: boolean;
}

interface SetBlock {
  id: string;
  sha256: string;
  text: string;
}

/**
 * Plans the sync of `options.agents` (default all). Reads only: the same
 * index, state and files give the same plan, and an agent already in step
 * has `changed: false`.
 *
 * @throws WiringError for a configuration file that cannot be parsed or
 *   edited in place, or that resolves outside its root.
 */
export async function planLibrarySync(
  index: LibraryIndex,
  applied: AppliedState,
  sources: LibrarySources,
  context: WiringContext,
  options: LibrarySyncOptions = {},
): Promise<LibraryPlan> {
  await checkContext(context);
  const agents: LibraryAgentPlan[] = [];
  for (const agent of selected(options))
    agents.push(
      (await planAgent(agent, index, applied, sources, context, options)).view,
    );
  return { changed: agents.some((agent) => agent.changed), agents };
}

/**
 * Applies the sync agent by agent, each under its wiring lock (the one
 * global wiring takes, as both edit some of the same files): re-plans,
 * checks `expect` when given (a file changed since fails with
 * LIBRARY_CONCURRENT_MODIFICATION), saves originals, writes and reads back.
 * After each agent `persist` receives the whole new state and must commit it
 * before resolving; when it fails, that agent's files are restored. A
 * failure restores what was written for the agent and stops; agents before
 * it stay synced and persisted.
 */
export async function applyLibrarySync(
  index: LibraryIndex,
  applied: AppliedState,
  sources: LibrarySources,
  context: WiringContext,
  options: LibrarySyncOptions & {
    expect?: ConfirmedLibraryPlan;
    persist: (state: AppliedState) => Promise<void>;
  },
): Promise<LibraryPlan> {
  await checkContext(context);
  let state = structuredClone(applied);
  const agents: LibraryAgentPlan[] = [];
  for (const agent of selected(options)) {
    const view = await withAdapterLock(context.dataDir, agent, async () => {
      const plan = await planAgent(
        agent,
        index,
        state,
        sources,
        context,
        options,
      );
      if (options.expect) checkExpected(plan, options.expect);
      if (!plan.view.changed && !plan.stateChanged) return plan.view;
      const written = await write(plan, context, sources, options);
      const next: AppliedState = {
        ...state,
        agents: { ...state.agents, [agent]: plan.next },
      };
      if (isEmpty(plan.next)) delete next.agents[agent];
      try {
        await options.persist(next);
      } catch (error) {
        await written.undo().catch((cleanup: unknown) => {
          throw new AggregateError(
            [error, cleanup],
            `Saving the Library state of ${agent} failed and its files could not all be restored`,
          );
        });
        throw error;
      }
      state = next;
      plan.view.warnings.push(...(await written.finish()));
      return plan.view;
    });
    agents.push(view);
  }
  return { changed: agents.some((agent) => agent.changed), agents };
}

function selected(options: LibrarySyncOptions): LibraryAgent[] {
  const agents = options.agents ?? libraryAgents;
  return libraryAgents.filter((agent) => agents.includes(agent));
}

function emptyAgent(): AppliedAgent {
  return { files: [], skills: {}, skillDirectories: [] };
}

function isEmpty(agent: AppliedAgent): boolean {
  return (
    agent.files.length === 0 &&
    !agent.instructions &&
    !agent.mcp &&
    Object.keys(agent.skills).length === 0 &&
    agent.skillDirectories.length === 0
  );
}

function checkExpected(plan: AgentPlan, expect: ConfirmedLibraryPlan): void {
  const confirmed = expect.agents.find(
    (item) => item.agent === plan.view.agent,
  );
  for (const file of plan.files) {
    if (file.action === "unchanged") continue;
    const seen = confirmed?.files.find((item) => item.path === file.path);
    if (
      seen === undefined ||
      seen.exists !== file.state.exists ||
      (file.state.exists && seen.hash !== file.state.hash)
    )
      throw new LibraryError(
        "LIBRARY_CONCURRENT_MODIFICATION",
        `${file.path} changed since the plan was shown; plan again`,
      );
  }
}

async function planAgent(
  agent: LibraryAgent,
  index: LibraryIndex,
  applied: AppliedState,
  sources: LibrarySources,
  context: WiringContext,
  options: LibrarySyncOptions,
): Promise<AgentPlan> {
  const target = libraryTarget(agent, adapterEnvironment(context));
  const own = applied.agents[agent] ?? emptyAgent();
  const next: AppliedAgent = structuredClone(own);
  const refused: LibraryRefusal[] = [];
  const warnings: string[] = [];
  const files: FilePlan[] = [];
  const settle = settler(context.dataDir, agent, own, next);

  // Instructions: the one set assigned, as a marked block.
  const set = index.instructions.find((item) => item.agents.includes(agent));
  let block: SetBlock | undefined;
  if (set && !target.instructions)
    refused.push({
      kind: "instructions",
      name: set.id,
      reason: "this agent has no user-wide instructions file",
    });
  else if (set)
    block = {
      id: set.id,
      sha256: set.sha256,
      text: (await sources.instructionText(set.id)).trim(),
    };
  const instructionsAt = target.instructions
    ? await locate(target.instructions.file)
    : undefined;
  if (own.instructions && own.instructions.path !== instructionsAt)
    files.push(
      await instructionsPlan(
        own.instructions.path,
        rootOf(own, own.instructions.path),
        undefined,
        settle,
        warnings,
      ),
    );
  if (target.instructions && instructionsAt) {
    if (block && target.instructions.override)
      if (await present(target.instructions.override))
        warnings.push(
          `${target.instructions.override} exists, and Codex reads it instead of ${instructionsAt}`,
        );
    if (block || own.instructions?.path === instructionsAt)
      files.push(
        await instructionsPlan(
          instructionsAt,
          target.instructions.file.root,
          block,
          settle,
          warnings,
        ),
      );
  }
  if (block && instructionsAt)
    next.instructions = {
      path: instructionsAt,
      set: block.id,
      sha256: block.sha256,
    };
  else delete next.instructions;

  // MCP servers, in the agent's own spelling.
  const servers = new Map<string, ConfigValue>();
  const masks: string[] = [];
  for (const server of index.mcp.filter((item) =>
    item.agents.includes(agent),
  )) {
    if (!target.mcp) {
      refused.push({
        kind: "mcp",
        name: server.name,
        reason: "this agent has no MCP configuration the Library knows of",
      });
      continue;
    }
    let forbidden: string | undefined;
    for (const ref of [
      ...Object.values(server.secretEnv ?? {}),
      ...Object.values(server.secretHeaders ?? {}),
    ])
      forbidden ??= await sources.forbiddenRef(ref);
    if (forbidden) {
      refused.push({
        kind: "mcp",
        name: server.name,
        reason: `SECRET_REF_FORBIDDEN: ${forbidden}`,
      });
      continue;
    }
    const rendered = await renderSecrets(server, target.mcp, {
      allowPlaintext: options.allowPlaintextSecret === true,
      resolve: (ref) => sources.resolve(ref),
      forbiddenValue: (value) => sources.forbiddenValue(value),
    });
    if ("refused" in rendered) {
      refused.push({
        kind: "mcp",
        name: server.name,
        reason: rendered.refused,
      });
      continue;
    }
    if (rendered.plaintext) {
      warnings.push(
        `${server.name}: secret values are written to the agent's file as plain text`,
      );
      for (const secret of [
        ...Object.values(rendered.env),
        ...Object.values(rendered.headers),
      ])
        if ("value" in secret) masks.push(secret.value);
    }
    servers.set(server.name, encodeServer(target.mcp.style, server, rendered));
  }
  const mcpAt = target.mcp ? await locate(target.mcp.file) : undefined;
  if (own.mcp && own.mcp.path !== mcpAt)
    files.push(
      await mcpPlan({
        file: own.mcp.path,
        root: rootOf(own, own.mcp.path),
        format: formatOf(own.mcp.path),
        container: own.mcp.container,
        servers: new Map(),
        own,
        next,
        refused,
        masks,
        settle,
      }),
    );
  if (target.mcp && mcpAt && (servers.size || own.mcp?.path === mcpAt))
    files.push(
      await mcpPlan({
        file: mcpAt,
        root: target.mcp.file.root,
        format: target.mcp.format,
        container: target.mcp.container,
        servers,
        own,
        next,
        refused,
        masks,
        settle,
      }),
    );

  // Skills: a link to (or a marked copy of) the stored version.
  const skills: SkillPlan[] = [];
  const wanted = index.skills.filter((item) => item.agents.includes(agent));
  for (const skill of wanted) {
    if (!target.skills) {
      refused.push({
        kind: "skills",
        name: skill.name,
        reason: "this agent has no skills directory",
      });
      continue;
    }
    const where = path.join(target.skills.directory, skill.name);
    const found = await placement(where, skill.name, sources);
    if (found.kind === "other") {
      refused.push({
        kind: "skills",
        name: skill.name,
        reason: `${where} is not the Library's; it is left as it is`,
      });
      if (own.skills[skill.name]?.path === where)
        delete next.skills[skill.name];
      continue;
    }
    skills.push({
      name: skill.name,
      path: where,
      sha256: skill.sha256,
      ...(found.kind === "absent" ? {} : { placed: found.kind }),
      action:
        found.kind === "absent"
          ? "place"
          : found.sha256 === skill.sha256 &&
              (options.placement !== "copy" || found.kind === "copy")
            ? "unchanged"
            : "replace",
    });
  }
  for (const [name, placed] of Object.entries(own.skills)) {
    if (skills.some((skill) => skill.path === placed.path)) continue;
    if (refused.some((item) => item.kind === "skills" && item.name === name))
      continue;
    const found = await placement(placed.path, name, sources);
    if (found.kind === "link" || found.kind === "copy")
      skills.push({
        name,
        path: placed.path,
        action: "remove",
        placed: found.kind,
      });
    else {
      if (found.kind === "other")
        warnings.push(
          `${placed.path} was changed by hand; it is the user's now and is left as it is`,
        );
      delete next.skills[name];
    }
  }

  const view: LibraryAgentPlan = {
    agent,
    name: target.name,
    changed:
      files.some((file) => file.action !== "unchanged") ||
      skills.some((skill) => skill.action !== "unchanged"),
    files: files.map((file) => ({
      kind: file.kind,
      path: file.path,
      exists: file.state.exists,
      ...(file.state.exists ? { hash: file.state.hash } : {}),
      action: file.action,
      diff:
        file.action === "unchanged"
          ? ""
          : mask(
              unifiedDiff(
                file.before,
                file.after,
                file.path,
                file.format === "markdown" ? 1 : 3,
              ),
              file.masks,
            ),
    })),
    skills: skills.map(({ name, path: where, action }) => ({
      name,
      path: where,
      action,
    })),
    refused,
    warnings,
  };
  return {
    view,
    target,
    files,
    skills,
    next,
    stateChanged: JSON.stringify(next) !== JSON.stringify(own),
  };
}

/**
 * The root a file the Library wrote must resolve within: the one recorded
 * with it, or its own directory for a file whose content was already as
 * planned (nothing was written, so nothing was recorded).
 */
function rootOf(own: AppliedAgent, file: string): string {
  return (
    own.files.find((item) => item.path === file)?.root ?? path.dirname(file)
  );
}

function formatOf(file: string): ConfigFormat {
  const extension = path.extname(file);
  if (extension === ".toml") return "toml";
  if (extension === ".yaml" || extension === ".yml") return "yaml";
  return "json";
}

/** The first existing candidate, else the path to create. */
async function locate(location: FileLocation): Promise<string> {
  for (const candidate of location.candidates)
    if (await present(candidate)) return candidate;
  return location.create;
}

async function present(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (isCode(error, "ENOENT") || isCode(error, "ENOTDIR")) return false;
    throw error;
  }
}

/**
 * Decides a file's action once its edited text is known: when nothing of
 * the Library is left and the file is as the Library last wrote it, the
 * original comes back (or the created file goes). Updates the file records
 * of `next`; `write` replaces the record of a written file.
 */
function settler(
  dataDir: string,
  agent: LibraryAgent,
  own: AppliedAgent,
  next: AppliedAgent,
) {
  return async (
    file: string,
    state: FileState,
    before: string | undefined,
    after: string,
    ownsNothing: boolean,
  ): Promise<Pick<FilePlan, "action" | "after" | "original" | "record">> => {
    const record = own.files.find((item) => item.path === file);
    if (ownsNothing)
      next.files = next.files.filter((item) => item.path !== file);
    if (
      ownsNothing &&
      record &&
      state.exists &&
      record.byteRestore &&
      state.hash === record.afterHash
    ) {
      if (!record.original)
        return { action: "delete", after: undefined, record };
      const original = await readOriginal(
        dataDir,
        `library-${agent}`,
        record.original.sha256,
      );
      return {
        action: "restore",
        after: decodeText(original, file).text,
        original,
        record,
      };
    }
    if (ownsNothing && !state.exists)
      return { action: "unchanged", after, record };
    return {
      action: state.exists && before === after ? "unchanged" : "write",
      after,
      record,
    };
  };
}

type Settle = ReturnType<typeof settler>;

async function readCurrent(file: string, root: string) {
  const { realPath } = await resolveFile(file, [root]);
  const state = await readState(realPath);
  const decoded = state.exists
    ? decodeText(state.bytes, file)
    : { text: undefined, bom: false };
  return { realPath, state, before: decoded.text, bom: decoded.bom };
}

function blockText(block: SetBlock, newline: string): string {
  return `${BLOCK_BEGIN} id=${block.id} sha=${block.sha256} -->\n${block.text}\n${BLOCK_END}`.replace(
    /\n/g,
    newline,
  );
}

/** Splits a file around the Library's block; `block` is undefined when there is none. */
function splitBlock(text: string): {
  before: string;
  block?: string;
  after: string;
} {
  const start = text.indexOf(BLOCK_BEGIN);
  const end = start < 0 ? -1 : text.indexOf(BLOCK_END, start);
  if (end < 0) return { before: text, after: "" };
  return {
    before: text.slice(0, start),
    block: text.slice(start, end + BLOCK_END.length),
    after: text.slice(end + BLOCK_END.length),
  };
}

/** Whether a block's text no longer matches the hash in its first line. */
function editedByHand(block: string): boolean {
  const first = block.indexOf("\n");
  const sha = /\bsha=([0-9a-f]{64})\b/.exec(block.slice(0, first))?.[1];
  const inner = block
    .slice(first + 1, block.length - BLOCK_END.length)
    .replace(/\r\n/g, "\n")
    .replace(/\n$/, "");
  return first < 0 || sha !== sha256(inner);
}

/**
 * `text` with the Library's block set to `block`, or taken out. A new block
 * goes after the user's text, separated by a blank line; taking it out
 * joins the text around it with one blank line.
 */
function withBlock(
  text: string,
  block: SetBlock | undefined,
  newline: string,
): string {
  const parts = splitBlock(text);
  if (block) {
    const body = blockText(block, newline);
    if (parts.block !== undefined)
      return `${parts.before}${body}${parts.after}`;
    return text.trim()
      ? `${text.replace(/\s+$/, "")}${newline}${newline}${body}${newline}`
      : `${body}${newline}`;
  }
  if (parts.block === undefined) return text;
  const head = parts.before.replace(/\s+$/, "");
  const tail = parts.after.replace(/^(?:[ \t]*\r?\n)+/, "");
  if (!head && !tail.trim()) return "";
  if (!tail.trim()) return `${head}${newline}`;
  return head ? `${head}${newline}${newline}${tail}` : tail;
}

async function instructionsPlan(
  file: string,
  root: string,
  block: SetBlock | undefined,
  settle: Settle,
  warnings: string[],
): Promise<FilePlan> {
  const { realPath, state, before, bom } = await readCurrent(file, root);
  const current = before ?? "";
  const newline = current.includes("\r\n") ? "\r\n" : "\n";
  const found = splitBlock(current).block;
  const after = withBlock(current, block, newline);
  if (found !== undefined && editedByHand(found) && after !== current)
    warnings.push(
      `The Library's block in ${file} was edited by hand; the sync ${block ? "replaces" : "removes"} it`,
    );
  const settled = await settle(file, state, before, after, !block);
  return {
    kind: "instructions",
    path: file,
    realPath,
    root,
    format: "markdown",
    state,
    bom,
    before,
    ...settled,
    ownsNothing: !block,
    verify: (text) => {
      const written = splitBlock(text).block;
      return block
        ? written === blockText(block, newline)
        : written === undefined;
    },
    masks: [],
  };
}

async function mcpPlan(input: {
  file: string;
  root: string;
  format: ConfigFormat;
  container: readonly string[];
  servers: ReadonlyMap<string, ConfigValue>;
  own: AppliedAgent;
  next: AppliedAgent;
  refused: LibraryRefusal[];
  masks: readonly string[];
  settle: Settle;
}): Promise<FilePlan> {
  const { file, root, format, container, own, next } = input;
  const editor = editors[format];
  const { realPath, state, before, bom } = await readCurrent(file, root);
  const document = editor.parse(before ?? "");
  const owned = own.mcp?.path === file ? own.mcp.servers : [];
  const existing = getPath(document, container);
  if (existing !== undefined && !isRecord(existing))
    throw new LibraryError(
      "LIBRARY_CONFLICT",
      `${file}: ${container.join(".")} is not an object, so MCP servers cannot be kept in it`,
    );
  const createdContainer =
    own.mcp?.path === file ? own.mcp.createdContainer : existing === undefined;
  const keep = new Map<string, ConfigValue>();
  for (const [name, entry] of input.servers) {
    if (existing && Object.hasOwn(existing, name) && !owned.includes(name)) {
      input.refused.push({
        kind: "mcp",
        name,
        reason: `${file} already has a server named ${name}; it is the user's and is left as it is`,
      });
      continue;
    }
    keep.set(name, entry);
  }
  const removed = owned.filter((name) => !keep.has(name));
  let text = before ?? "";
  for (const name of removed) text = editor.remove(text, [...container, name]);
  for (const [name, entry] of keep)
    if (!deepEqual(getPath(editor.parse(text), [...container, name]), entry))
      text = editor.set(text, [...container, name], entry);
  const left = getPath(editor.parse(text), container);
  if (createdContainer && isRecord(left) && Object.keys(left).length === 0)
    text = editor.remove(text, container);
  if (keep.size)
    next.mcp = {
      path: file,
      container: [...container],
      createdContainer,
      servers: [...keep.keys()].sort(),
    };
  else if (next.mcp?.path === file) delete next.mcp;
  const settled = await input.settle(
    file,
    state,
    before,
    text,
    keep.size === 0,
  );
  // Everything but the Library's entries is as it was.
  const rest = (value: Record<string, unknown>) => {
    const copy = clone(value);
    for (const name of [...owned, ...keep.keys()])
      deletePath(copy, [...container, name]);
    const box = getPath(copy, container);
    if (createdContainer && isRecord(box) && Object.keys(box).length === 0)
      deletePath(copy, container);
    return copy;
  };
  return {
    kind: "mcp",
    path: file,
    realPath,
    root,
    format,
    state,
    bom,
    before,
    ...settled,
    ownsNothing: keep.size === 0,
    verify: (written) => {
      const after = editor.parse(written);
      for (const [name, entry] of keep)
        if (!deepEqual(getPath(after, [...container, name]), entry))
          return false;
      return (
        removed.every(
          (name) => getPath(after, [...container, name]) === undefined,
        ) && deepEqual(rest(document), rest(after))
      );
    },
    masks: input.masks,
  };
}

type Found =
  | { kind: "absent" }
  | { kind: "link" | "copy"; sha256: string }
  | { kind: "other" };

/**
 * What is at a skill's place: nothing, the Library's link or copy (with
 * its version), or something else. A copy is the Library's only while its
 * files still match the version its marker names.
 */
async function placement(
  where: string,
  name: string,
  sources: LibrarySources,
): Promise<Found> {
  let info;
  try {
    info = await lstat(where);
  } catch (error) {
    if (isCode(error, "ENOENT")) return { kind: "absent" };
    throw error;
  }
  if (info.isSymbolicLink()) {
    const target = path.resolve(path.dirname(where), await readlink(where));
    const version = path.basename(path.dirname(target));
    return path.dirname(path.dirname(target)) ===
      path.resolve(sources.skillsRoot) &&
      path.basename(target) === name &&
      VERSION.test(version)
      ? { kind: "link", sha256: version }
      : { kind: "other" };
  }
  if (!info.isDirectory()) return { kind: "other" };
  let marker: unknown;
  try {
    marker = JSON.parse(await readFile(path.join(where, SKILL_MARKER), "utf8"));
  } catch (error) {
    if (isCode(error, "ENOENT") || error instanceof SyntaxError)
      return { kind: "other" };
    throw error;
  }
  if (
    !isRecord(marker) ||
    typeof marker.sha256 !== "string" ||
    !VERSION.test(marker.sha256)
  )
    return { kind: "other" };
  let content;
  try {
    content = await readSkill(where);
  } catch (error) {
    if (error instanceof LibraryError) return { kind: "other" };
    throw error;
  }
  return content.sha256 === marker.sha256
    ? { kind: "copy", sha256: marker.sha256 }
    : { kind: "other" };
}

/** Copies a stored skill to `where` through a temporary directory, with the marker. */
async function copySkill(
  from: string,
  where: string,
  version: string,
): Promise<void> {
  const temporary = `${where}.${randomBytes(6).toString("hex")}.tmp`;
  const copy = async (source: string, destination: string): Promise<void> => {
    await mkdir(destination, { mode: 0o700 });
    for (const entry of await readdir(source, { withFileTypes: true })) {
      const item = path.join(source, entry.name);
      if (entry.isDirectory())
        await copy(item, path.join(destination, entry.name));
      else
        await writeFile(
          path.join(destination, entry.name),
          await readFile(item),
          {
            flag: "wx",
            mode: (await lstat(item)).mode & 0o777,
          },
        );
    }
  };
  try {
    await copy(from, temporary);
    await writeFile(
      path.join(temporary, SKILL_MARKER),
      `${JSON.stringify({ sha256: version, note: "Copied by the HarnessHub Library; a sync replaces or removes this copy while its files are unchanged." })}\n`,
      { flag: "wx", mode: 0o600 },
    );
    await rename(temporary, where);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

/** Links a stored skill to `where`, or copies it where links are refused or `copy` is asked. */
async function placeSkill(
  from: string,
  where: string,
  version: string,
  option: LibrarySyncOptions["placement"],
): Promise<"link" | "copy"> {
  if (option !== "copy")
    try {
      // A junction needs no privilege on Windows; a directory link may.
      await symlink(
        from,
        where,
        process.platform === "win32" ? "junction" : "dir",
      );
      return "link";
    } catch (error) {
      if (!isCode(error, "EPERM") && !isCode(error, "EACCES")) throw error;
    }
  await copySkill(from, where, version);
  return "copy";
}

function aside(where: string): string {
  return `${where}.${randomBytes(6).toString("hex")}.old`;
}

/**
 * Writes one agent's plan. Resolves to `undo`, which restores what was
 * written (for a failure after it), and `finish`, which removes what was
 * moved aside and resolves to warnings for what could not be removed. A
 * failure here restores by itself.
 */
async function write(
  plan: AgentPlan,
  context: WiringContext,
  sources: LibrarySources,
  options: LibrarySyncOptions,
): Promise<{
  undo: () => Promise<void>;
  finish: () => Promise<string[]>;
}> {
  const backupId = `library-${plan.view.agent}`;
  const steps: Array<() => Promise<void>> = [];
  const asides: Array<{ path: string; recursive: boolean }> = [];
  /** Directories the Library created and no longer needs, removed when empty. */
  const emptied: string[] = [];
  const undo = async () => {
    for (const step of steps.reverse()) await step();
  };
  const finish = async () => {
    const warnings: string[] = [];
    for (const item of asides)
      await rm(item.path, { recursive: item.recursive, force: true }).catch(
        (error: unknown) => {
          warnings.push(
            `${item.path} could not be removed (${error instanceof Error ? error.message : String(error)}); remove it by hand`,
          );
        },
      );
    await removeIfEmpty(emptied).catch((error: unknown) => {
      warnings.push(
        `An empty directory the Library created could not be removed (${error instanceof Error ? error.message : String(error)})`,
      );
    });
    return warnings;
  };
  try {
    for (const file of plan.files) {
      if (file.action === "unchanged") continue;
      const { state } = file;
      // A record of a file that is gone no longer describes it.
      const previous = state.exists ? file.record : undefined;
      await removeStaleTemporaries(file.realPath);
      const created = state.exists ? [] : await createParents(file.realPath);
      steps.push(() => removeEmptyDirectories(created));
      // Undoes a change that left `bytes` (undefined: deleted the file).
      const changed = (bytes: Buffer | undefined) => {
        steps.push(async () => {
          if (!state.exists) return deleteFile(file.realPath);
          if (!bytes) await createParents(file.realPath);
          await writeAtomic(file.realPath, state.bytes, {
            mode: state.mode,
            expectedHash: bytes && sha256(bytes),
            inPlace: bytes !== undefined && state.links > 1,
          });
        });
      };
      if (file.action === "delete") {
        const current = await readState(file.realPath);
        if (!current.exists || !state.exists || current.hash !== state.hash)
          throw new LibraryError(
            "LIBRARY_CONCURRENT_MODIFICATION",
            `${file.path} changed while the Library was syncing; plan again`,
          );
        await deleteFile(file.realPath);
        changed(undefined);
        emptied.push(...(previous?.createdDirectories ?? []));
        continue;
      }
      const bytes =
        file.action === "restore"
          ? file.original!
          : encodeText(file.after!, file.bom);
      const original =
        previous?.original ??
        (state.exists && !previous
          ? {
              sha256: await saveOriginal(
                context.dataDir,
                backupId,
                state.bytes,
              ),
              mode: state.mode,
            }
          : undefined);
      await writeAtomic(file.realPath, bytes, {
        mode:
          file.action === "restore"
            ? previous!.original!.mode
            : state.exists
              ? state.mode
              : 0o600,
        expectedHash: state.exists ? state.hash : undefined,
        inPlace: state.exists && state.links > 1,
      });
      changed(bytes);
      const read = await readFile(file.realPath);
      if (
        sha256(read) !== sha256(bytes) ||
        (file.action === "write" &&
          !file.verify(decodeText(read, file.path).text))
      )
        throw new LibraryError(
          "LIBRARY_CONCURRENT_MODIFICATION",
          `${file.path} did not read back as written`,
        );
      if (file.action === "write" && !file.ownsNothing) {
        const record: AppliedFile = {
          path: file.path,
          root: file.root,
          ...(original ? { original } : {}),
          afterHash: sha256(bytes),
          byteRestore: previous
            ? previous.byteRestore &&
              state.exists &&
              previous.afterHash === state.hash
            : true,
          createdDirectories: [
            ...(previous?.createdDirectories ?? []),
            ...created,
          ],
        };
        plan.next.files = [
          ...plan.next.files.filter((item) => item.path !== file.path),
          record,
        ];
      }
    }
    for (const skill of plan.skills) {
      if (skill.action === "unchanged") continue;
      if (skill.placed) {
        const moved = aside(skill.path);
        await rename(skill.path, moved);
        steps.push(() => rename(moved, skill.path));
        asides.push({ path: moved, recursive: skill.placed === "copy" });
      }
      if (skill.action === "remove") {
        delete plan.next.skills[skill.name];
        continue;
      }
      const created = await createParents(skill.path);
      steps.push(() => removeEmptyDirectories(created));
      plan.next.skillDirectories.push(...created);
      const mode = await placeSkill(
        sources.skillDirectory(skill.sha256!, skill.name),
        skill.path,
        skill.sha256!,
        options.placement,
      );
      steps.push(() =>
        rm(skill.path, { recursive: mode === "copy", force: true }),
      );
      plan.next.skills[skill.name] = {
        path: skill.path,
        mode,
        sha256: skill.sha256!,
      };
    }
    if (Object.keys(plan.next.skills).length === 0) {
      emptied.push(...plan.next.skillDirectories);
      plan.next.skillDirectories = [];
    }
    return { undo, finish };
  } catch (error) {
    await undo().catch((cleanup: unknown) => {
      throw new AggregateError(
        [error, cleanup],
        `Syncing the Library into ${plan.view.agent} failed and what was written could not all be restored`,
      );
    });
    throw error;
  }
}

/**
 * Removes each of `directories` that is empty, deepest first, until a pass
 * removes nothing more (paths may be spelled through different links); one
 * that is not empty (the user's files, or a directory still in use) stays.
 */
async function removeIfEmpty(directories: readonly string[]): Promise<void> {
  let pending = [...new Set(directories)].sort(
    (a, b) => b.split(path.sep).length - a.split(path.sep).length,
  );
  for (let removed = true; removed && pending.length;) {
    removed = false;
    const left: string[] = [];
    for (const directory of pending)
      try {
        await rmdir(directory);
        removed = true;
      } catch (error) {
        if (isCode(error, "ENOTEMPTY") || isCode(error, "EEXIST"))
          left.push(directory);
        else if (!isCode(error, "ENOENT")) throw error;
      }
    pending = left;
  }
}

/** `text` with each value of `secrets` shown as `<secret>`. */
function mask(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const secret of [...new Set(secrets)].sort(
    (a, b) => b.length - a.length,
  ))
    if (secret) result = result.split(secret).join("<secret>");
  return result;
}
