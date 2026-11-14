import type { NativeOption, NativeOptions } from "./control.js";
import { EFFORT_LEVELS, PERMISSION_LEVELS, type EffortLevel, type PermissionLevel } from "./protocol.js";

/**
 * A Harness's adapter declaration (docs/contracts/harness-adapters.md): how the Hub's one set of controls is carried out on this Harness. The
 * principle is T3 Code's: the complexity sits at the adapter's edge, the orchestration stays plain and the page stays dumb, and every Harness
 * offers every level, what its native side lacks being done by the adapter (here, the Hub's own answer to its permission requests). One file
 * per Harness declares it (src/adapters/flavors/<harnessId>.ts); the page draws its lists from what the declaration says, read with the
 * Harness's catalog, and never from the Harness's name.
 */

/** One native value a level needs: an option of the Harness's catalog, by its id when known (one of `ids`) or else by its category, set to `value`. */
export interface NativeWant { readonly ids?: readonly string[]; readonly category: string; readonly value: string }

/** What a permission request is about, as the Hub's policy tells it (from the request's own subject and the call it is for). */
export const REQUEST_KINDS = ["read", "edit", "execute", "network", "tool", "other"] as const;
export type RequestKind = typeof REQUEST_KINDS[number];
/** The Hub's answer to a request of one kind: the user decides, allowed once, or refused (with the reason told to the model). */
export type PolicyAnswer = "ask" | "allow" | "deny";
export type LevelPolicy = Readonly<Record<RequestKind, PolicyAnswer>>;

/**
 * How one permission level is carried out on this Harness; the three ways add up. `native`: the native options or modes set. `session`: what
 * opening the session or starting the process carries (parameters, environment, per-session rules). `policy`: how the Hub answers the
 * permission requests the Harness sends under this level. `note`: how this falls short of the level, said under it in the list (never a
 * reason to grey it); `impossible`: the level cannot be done at all on this Harness, and why.
 */
export interface PermissionWay {
  readonly native?: readonly NativeWant[];
  readonly session?: { readonly params?: Readonly<Record<string, unknown>>; readonly env?: Readonly<Record<string, string>>; readonly rules?: readonly unknown[] };
  readonly policy?: LevelPolicy;
  readonly note?: string;
  readonly impossible?: string;
}
/** The levels' native values for thinking: the catalog option (by category, or ids), and for each level the native values it is, preferred first. */
export interface EffortWays {
  readonly option?: { readonly ids?: readonly string[]; readonly category: string };
  readonly values: Partial<Record<EffortLevel, readonly string[]>>;
  readonly note?: string;
}
/** Which operations this Harness asks about (sends a permission request for), which is what the Hub's policy can answer. */
export interface AsksFor { readonly read: boolean; readonly edit: boolean; readonly execute: boolean; readonly note?: string }
/**
 * How the Hub's own MCP server (TABLE_MCP_NAME: the conversation's history, the task list, the wrap-up) reaches a session of this Harness,
 * through an entry of that one session or process, never the Harness's configuration:
 * - `acp`: ACP `mcpServers` on session/new, session/load and session/resume, with the process's table address and token;
 * - `thread-config`: Codex's `config` on thread/start and thread/resume (`mcp_servers.<name>`), the user's own entry of that name kept;
 * - `cli`: the Harness takes no tool entry for one session, but its agent runs commands: the Hub writes a command of this conversation
 *   (TableMount, a file that carries the table's address and this process's token) and the session's instructions say how to run it. The
 *   same tools, called as `<command> turns`, `<command> delegate …` (hub-tools.ts); they are there only where the Harness may run a command;
 * - `none`: the Harness has no such entry (its declaration says why), so the tools are not there.
 */
export type HubToolsEntry = "acp" | "thread-config" | "cli" | "none";
/**
 * Where the Hub's session instructions (how to use the task list and the wrap-up) go, after anything of the user's own:
 * - `acp-meta`: the session request's `_meta.systemPrompt.append` (claude-agent-acp keeps its own preset and adds this);
 * - `developer-instructions`: Codex's thread `developerInstructions`, the user's own `developer_instructions` first;
 * - `mcp-instructions`: the Hub's MCP server says them in its `initialize` instructions, which this Harness puts into its system prompt;
 * - `first-prompt`: a text block after the first content prompt of a native session the connection opened new (the Harness has neither
 *   a system prompt entry nor a use for MCP instructions); the Hub's own record of the user's words stays as typed;
 * - `none`: nowhere (without the tools they would name nothing).
 */
export type InstructionsEntry = "acp-meta" | "developer-instructions" | "mcp-instructions" | "first-prompt" | "none";
/** The two entries a Driver reads (ControlOptions.entry), from the declaration's capabilities. */
export interface SessionEntry { readonly tools: HubToolsEntry; readonly instructions: InstructionsEntry }
/** The capabilities the adapter will declare later; the fields are fixed now so that each adapter fills them in its own time. */
export interface FlavorCapabilities {
  readonly sessionMcp?: HubToolsEntry;
  readonly systemPrompt?: InstructionsEntry;
  /** The task list and the wrap-up: the Hub's own two tools (`hub`, through sessionMcp), only the Harness's own task tool (`native`), or none. */
  readonly planTool?: "native" | "hub" | "none";
  readonly questions?: "native" | "none";
  readonly usage?: "turn" | "session" | "context" | "none";
  readonly resume?: "native" | "none";
  readonly fork?: "native" | "none";
  readonly attachments?: "native" | "pointer" | "none";
  /**
   * How the Harness reads the record of its task (2026-11-13): with its own file tools on the directory the Hub keeps (`files`: nothing to learn, no tool definition to pay
   * for), or with the Hub's reading tools (`tools`, the default: hub_turns, hub_read_turn, hub_search, hub_task, hub_board, or the conversation's command).
   */
  readonly record?: "files" | "tools";
  /**
   * Words the user sends while a Turn runs (2026-11-14): `native`, the Harness takes them into the turn in progress (`POST /sessions/:id/steer`,
   * HarnessControl.steer), so the page may offer to send them now; `none` (the default), it cannot, and the page keeps them until the Turn
   * ends (its queue). Never done by stopping the turn and sending again. The page reads this from the catalog's `flavor` and still falls back
   * to its queue on any refusal of the steer (STEER_UNSUPPORTED, STEER_NO_ACTIVE_TURN, STEER_REFUSED).
   */
  readonly steer?: "native" | "none";
}
export interface HarnessFlavor {
  readonly harnessId: string;
  /** Every level, each with how it is done here. */
  readonly permission: Readonly<Record<PermissionLevel, PermissionWay>>;
  /** Native values that undo one a level set, when the next level names none (a thread keeps its mode; OpenCode's build agent). */
  readonly neutral?: readonly NativeWant[];
  readonly effort: EffortWays;
  readonly asks: AsksFor;
  /** The Harness has a plan mode of its own (else "plan" is the Hub's policy refusing every change). */
  readonly nativePlan: boolean;
  readonly capabilities?: FlavorCapabilities;
}

// ---- the Hub's policies --------------------------------------------------------------------------------------------------

/**
 * The Hub's answers by level (T3 Code's client policy, packages/provider-acp/src/server/clientPolicy.ts): a read, a search or a thought is never
 * asked about; "ask" asks about every change and command; "auto_edit" allows changes to files and asks about commands; "auto" and "full" allow
 * what is asked; "plan" refuses every change and command and tells the model it is read only.
 */
export const HUB_POLICIES: Readonly<Record<PermissionLevel, LevelPolicy>> = {
  plan: { read: "allow", edit: "deny", execute: "deny", network: "allow", tool: "ask", other: "deny" },
  ask: { read: "allow", edit: "ask", execute: "ask", network: "ask", tool: "ask", other: "ask" },
  auto_edit: { read: "allow", edit: "allow", execute: "ask", network: "ask", tool: "ask", other: "ask" },
  auto: { read: "allow", edit: "allow", execute: "allow", network: "allow", tool: "allow", other: "allow" },
  full: { read: "allow", edit: "allow", execute: "allow", network: "allow", tool: "allow", other: "allow" },
};
/** The selection's level, kept among its native options under this key (the Drivers never see it: `nativeOnly`). */
export const PERMISSION_KEY = "hub_permission";
/** How the Hub's tools and its session instructions reach this Harness's sessions, as its declaration says; neither when it says nothing. */
export function sessionEntryOf(flavor: HarnessFlavor | undefined): SessionEntry {
  return { tools: flavor?.capabilities?.sessionMcp ?? "none", instructions: flavor?.capabilities?.systemPrompt ?? "none" };
}
/** The selection's native options without the Hub's own keys: what a Driver is given. */
export function nativeOnly(values: NativeOptions | undefined): NativeOptions | undefined {
  if (values === undefined) return undefined;
  const kept = Object.entries(values).filter(([id]) => !id.startsWith("hub_"));
  return kept.length === Object.keys(values).length ? values : Object.fromEntries(kept);
}
/** The selection's effort level, kept the same way: the adapter makes it the running model's own value when the session opens. */
export const EFFORT_KEY = "hub_effort";
/** The permission level a selection names, when it names one. */
export function selectedPermission(values: NativeOptions | undefined): PermissionLevel | undefined {
  const value = values?.[PERMISSION_KEY];
  return value !== undefined && (PERMISSION_LEVELS as readonly string[]).includes(value) ? value as PermissionLevel : undefined;
}
/** The effort level a selection names, when it names one. */
export function selectedEffort(values: NativeOptions | undefined): EffortLevel | undefined {
  const value = values?.[EFFORT_KEY];
  return value !== undefined && (EFFORT_LEVELS as readonly string[]).includes(value) ? value as EffortLevel : undefined;
}
/** The levels a selection names by the Hub's keys; either absent: the Harness's own setting for it. */
export interface ChosenLevels { readonly permission?: PermissionLevel; readonly effort?: EffortLevel }
export function selectedLevels(values: NativeOptions | undefined): ChosenLevels {
  const permission = selectedPermission(values), effort = selectedEffort(values);
  return { ...(permission === undefined ? {} : { permission }), ...(effort === undefined ? {} : { effort }) };
}

// ---- reading a declaration with a catalog ------------------------------------------------------------------------------

/**
 * One level as this Harness's catalog makes it: its native values (with the Hub's key), how it falls short, or why it cannot be done. `near`:
 * the model lacks this effort level, and these are the values of the nearest level it has, which is the level that runs.
 */
export interface LevelValues<L extends string> { readonly level: L; readonly options: NativeOptions; readonly note?: string; readonly impossible?: string; readonly near?: L }
export interface NativeLevels {
  readonly permission: readonly LevelValues<PermissionLevel>[];
  readonly permissionNeutral?: NativeOptions;
  readonly effort: readonly LevelValues<EffortLevel>[];
  readonly effortMissing: string;
}
function resolve(options: readonly NativeOption[], wants: readonly NativeWant[]): NativeOptions | null {
  const out: Record<string, string> = {};
  for (const want of wants) {
    const option = options.find(row => (want.ids ? want.ids.includes(row.id) : false) && row.values.some(value => value.value === want.value))
      ?? options.find(row => row.category === want.category && (want.ids === undefined || want.ids.includes(row.id)) && row.values.some(value => value.value === want.value));
    if (option === undefined) return null;
    out[option.id] = want.value;
  }
  return out;
}
/** The effort level a native reasoning value is, by its name; null for one that is none of them (adaptive, auto, default). */
export function effortOfValue(value: string): EffortLevel | null {
  const name = value.trim().toLowerCase();
  if (["off", "none", "disabled", "no"].includes(name)) return "off";
  if (["minimal", "min", "low", "lite"].includes(name)) return "low";
  if (["medium", "med", "normal"].includes(name)) return "medium";
  if (name === "high") return "high";
  if (["xhigh", "x-high", "max", "maximum", "highest", "ultra"].includes(name)) return "max";
  return null;
}
const EFFORT_NAMES: Readonly<Record<EffortLevel, string>> = { off: "关", low: "低", medium: "中", high: "高", max: "最高" };
const EFFORT_PREFERENCE: Readonly<Record<EffortLevel, readonly string[]>> = { off: ["off", "none"], low: ["low", "minimal"], medium: ["medium"], high: ["high"], max: ["max", "xhigh", "ultra"] };

/**
 * What a declaration offers with this catalog. Every permission level is there: its native values when the catalog has them all (a level whose
 * native values are missing falls back to the Hub's policy, and says so), and always the Hub's key naming the level, which the Runtime's
 * policy answers by. A level the declaration calls impossible is there with its reason.
 */
export function nativeLevels(flavor: HarnessFlavor | undefined, options: readonly NativeOption[]): NativeLevels {
  const permission = PERMISSION_LEVELS.map((level): LevelValues<PermissionLevel> => {
    const way = flavor?.permission[level];
    const resolved = way?.native === undefined ? {} : resolve(options, way.native);
    const note = resolved === null ? "这个版本没有报这一档的原生设置，由 Hub 按档位答复它的权限请求" : way?.note;
    return { level, options: { ...(resolved ?? {}), [PERMISSION_KEY]: level }, ...(note === undefined ? {} : { note }), ...(way?.impossible === undefined ? {} : { impossible: way.impossible }) };
  });
  const neutral = flavor?.neutral === undefined ? null : resolve(options, flavor.neutral);
  const category = flavor?.effort.option?.category ?? "thought_level";
  const thought = options.find(option => option.category === category && (flavor?.effort.option?.ids === undefined || flavor.effort.option.ids.includes(option.id)));
  const exact = thought === undefined ? [] : EFFORT_LEVELS.flatMap(level => {
    const declared = flavor?.effort.values[level];
    const candidates = thought.values.map(value => value.value).filter(value => declared !== undefined ? declared.includes(value) : effortOfValue(value) === level);
    if (candidates.length === 0) return [];
    const order = declared ?? EFFORT_PREFERENCE[level];
    const chosen = order.map(name => candidates.find(value => value.toLowerCase() === name.toLowerCase())).find(value => value !== undefined) ?? candidates[0]!;
    return [{ level, options: { [thought.id]: chosen } }];
  });
  // Every effort level is offered where the model has any: one it lacks is the nearest it has (the higher of two as near), said under it. The
  // exact ones come first, so that a native value is read as its own level and not as one it stands in for.
  const near = exact.length === 0 ? [] : EFFORT_LEVELS.filter(level => !exact.some(entry => entry.level === level)).map(level => {
    const at = EFFORT_LEVELS.indexOf(level);
    const best = [...exact].sort((left, right) => Math.abs(EFFORT_LEVELS.indexOf(left.level) - at) - Math.abs(EFFORT_LEVELS.indexOf(right.level) - at) || EFFORT_LEVELS.indexOf(right.level) - EFFORT_LEVELS.indexOf(left.level))[0]!;
    return { level, options: best.options, note: "这个模型没有这一档，用最接近的“" + EFFORT_NAMES[best.level] + "”", near: best.level };
  });
  const effort = [...exact, ...near];
  return { permission, ...(neutral === null ? {} : { permissionNeutral: neutral }), effort, effortMissing: thought === undefined ? "这一家没有思考强度可选" : "这个模型没有这一档" };
}
/**
 * The native values a session is opened with, as the adapter applies them once the session's catalog is known (its options, for the model it
 * runs): the selection's own native values without the Hub's keys, and over them what its levels come to on this catalog. The permission
 * level's are the declaration's (a restored session also gets the neutral's for an option the level names none of, undoing what an earlier
 * level set); the effort level's are the model's own value for it, the nearest it has where it lacks it. A level wins over a native value of
 * the same option. A level whose values this catalog lacks adds none: the permission level is then the Hub's answers alone, and an effort level
 * on a model without a thinking option leaves the model's own. Undefined when there is nothing to apply and the selection named nothing.
 */
export function levelOptions(flavor: HarnessFlavor | undefined, options: readonly NativeOption[], selected: NativeOptions | undefined, levels: ChosenLevels, restored = false): NativeOptions | undefined {
  const own = nativeOnly(selected);
  if (levels.permission === undefined && levels.effort === undefined) return own;
  const offered = nativeLevels(flavor, options), out: Record<string, string> = { ...own };
  if (levels.permission !== undefined) {
    const values = nativeOnly(offered.permission.find(entry => entry.level === levels.permission)?.options) ?? {};
    if (restored) for (const [id, value] of Object.entries(offered.permissionNeutral ?? {})) if (values[id] === undefined) out[id] = value;
    Object.assign(out, values);
  }
  if (levels.effort !== undefined) Object.assign(out, offered.effort.find(entry => entry.level === levels.effort)?.options ?? {});
  return own === undefined && Object.keys(out).length === 0 ? undefined : out;
}
/** The level `values` are among `offered`, or null when they are none of them. */
export function levelOf<L extends string>(offered: readonly LevelValues<L>[], values: NativeOptions): L | null {
  return offered.find(entry => Object.entries(entry.options).every(([id, value]) => values[id] === value))?.level ?? null;
}
