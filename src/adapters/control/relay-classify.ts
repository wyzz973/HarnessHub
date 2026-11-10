import type { ContentKind } from "../../contracts/content.js";
import { catalogCommands, sharedReading, type CommandClass, type CommandLookup, type ContextEffect, type NativeCommand, type NativeModelCatalog } from "../../contracts/control.js";
import type { RelayCapabilities } from "../../contracts/relay.js";

/**
 * How each native side reads one input (ADR-055 §7.4, VF1-06): the single source of every Driver's reading. A Driver's
 * HarnessControl.classify (what the Runtime and the Driver's own startText go by, R0d) and its relay declaration
 * (RelayCapabilities.commands.classify, what the relay reads at admission, F10) are both this module's reading for that
 * native side, over the catalog each is given; they differ only in that the declaration also says which commands take
 * relay content (acceptsRelay), which nativeReading() leaves out.
 *
 * Every reading here is pure and synchronous and reads nothing but its arguments. A reading takes the catalog as a lookup
 * (CommandLookup): a native catalog through catalogCommands(), a relay declaration's catalog through relayCommands().
 */

/** A relay declaration's catalog: the commands it knows, each with its effect (possibly by arguments) and relay acceptance. */
export type RelayCatalog = NonNullable<Parameters<RelayCapabilities["commands"]["classify"]>[1]>;
export type RelayCatalogEntry = RelayCatalog[number];
/** The relay declaration's classify (the contract's type): text, the catalog or null, and the input's attachment kinds. */
export type RelayClassify = RelayCapabilities["commands"]["classify"];

/** A relay catalog as a lookup: the first entry of a name, its effect for these arguments, and whether it takes relay content. */
export function relayCommands(catalog: RelayCatalog): CommandLookup {
  return (name, args) => {
    const entry = catalog.find(command => command.name === name);
    if (entry === undefined) return undefined;
    const effect = typeof entry.effect === "string" ? entry.effect : entry.effect.byArgs(args);
    return { effect, ...(entry.acceptsRelay === true ? { acceptsRelay: true } : {}) };
  };
}
/** Native commands as relay catalog entries: a command that declares no effect has an unknown one. */
export function relayEntries(commands: readonly NativeCommand[]): readonly RelayCatalogEntry[] {
  return commands.map(command => ({ name: command.name, effect: command.contextEffect ?? "unknown" }));
}
/** A reading as HarnessControl.classify returns it: the same reading without the relay declaration's acceptsRelay. */
export function nativeReading(reading: CommandClass): CommandClass {
  if (reading.kind !== "command" || reading.acceptsRelay === undefined) return reading;
  return { kind: "command", name: reading.name, args: reading.args, effect: reading.effect };
}
function lookupOf(catalog: NativeModelCatalog | null): CommandLookup | null { return catalog === null ? null : catalogCommands(catalog); }
/**
 * A Driver's relay declaration as its module exports it: the same object for every connection and for the factory's
 * lookup, frozen throughout so that no reader can change what another one reads.
 */
export function relayDeclaration(declaration: RelayCapabilities): RelayCapabilities {
  const freeze = (value: unknown): void => {
    if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
    Object.freeze(value);
    for (const item of Object.values(value)) freeze(item);
  };
  freeze(declaration);
  return declaration;
}
const accepts = (listed: { readonly acceptsRelay?: true } | undefined): { readonly acceptsRelay?: true } => listed?.acceptsRelay ? { acceptsRelay: true } : {};

// ---------------------------------------------------------------------------------------------------------------------
// The shared reading and a native side without commands
// ---------------------------------------------------------------------------------------------------------------------

/** The shared reading (control.ts sharedReading) as a relay declaration's classify. */
export const sharedClassify: RelayClassify = (text, catalog) => sharedReading(text, catalog === null ? null : relayCommands(catalog));
/** A native side that has no commands and sends every input, a slash one included, as text to its model (unlistedSlash text). */
export const textClassify: RelayClassify = () => ({ kind: "content" });

// ---------------------------------------------------------------------------------------------------------------------
// Claude Code (claude-agent-acp)
// ---------------------------------------------------------------------------------------------------------------------

/** The Hub's own `/export` of a Claude Code transcript, offered when the agent lists no `export` of its own. */
export const CLAUDE_EXPORT = { name: "export", description: "导出原生会话记录（Claude Code 转录 JSONL）", contextEffect: "none" } as const;
/** A command name as Claude Code reads one after a leading slash (its CLI strings); a path such as `/Users/…` names none. */
const CLAUDE_COMMAND_NAME = /^[a-zA-Z0-9_][a-zA-Z0-9:_-]*$/u;
/**
 * Commands Claude Code runs although claude-agent-acp does not list them (ADR-055 R0d): `/clear` and its aliases start a
 * new native conversation, and the adapter's `/remote-control`, which the Claude driver refuses, changes nothing.
 */
export const CLAUDE_HIDDEN: readonly NativeCommand[] = [
  ...["clear", "reset", "new"].map(name => ({ name, description: "清空 Claude Code 的会话上下文", contextEffect: "clear" as const })),
  { name: "remote-control", description: "Claude Code 的 Remote Control（HarnessHub 不发送）", contextEffect: "none" },
];
/** Listed commands that are no prompt: compaction, and the CLI's local reports, which leave the context as it is; any other listed command (a skill, a custom command) enters it like a message. */
export const CLAUDE_LISTED_EFFECTS: Readonly<Record<string, ContextEffect>> = { compact: "compact", model: "none", status: "none", usage: "none", context: "none", mcp: "none", cost: "none", export: "none" };
/**
 * The effect CLAUDE_LISTED_EFFECTS names for a command, or undefined: only its own entries count, so a command named after
 * an Object member (`constructor`, `toString`, `__proto__`…) gets no function or object for an effect.
 */
export function claudeListedEffect(name: string): ContextEffect | undefined { return Object.hasOwn(CLAUDE_LISTED_EFFECTS, name) ? CLAUDE_LISTED_EFFECTS[name] : undefined; }
/** The command an input names as Claude Code reads one: after leading whitespace, a slash and a command name; null for content. */
export function claudeCommand(text: string): { readonly name: string; readonly args: string } | null {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("/")) return null;
  const name = trimmed.slice(1).split(/\s/u)[0]!;
  return CLAUDE_COMMAND_NAME.test(name) ? { name, args: trimmed.slice(1 + name.length).trim() } : null;
}
/**
 * Claude Code's reading: after leading whitespace, a slash and a command name is a command, listed or not, since Claude
 * Code runs commands its adapter does not list (an unlisted one has an unknown effect); a slash path is content. With any
 * attachment every input is content: the prompt's blocks go to the CLI in order (claude-agent-acp 0.99.1 promptToClaude,
 * acp-agent.js:10316, a file as a link text or the file's context after the words, an image as an image block), and the CLI
 * looks for a command only in the last block (CLI 2.1.312 `Aj`), which is then the attachment's. The adapter's own
 * `/remote-control` reads a prompt of one text block only (acp-agent.js:191-205).
 */
export function claudeReading(text: string, commands: CommandLookup | null, attachments: readonly ContentKind[]): CommandClass {
  const named = attachments.length ? null : claudeCommand(text);
  if (named === null) return { kind: "content" };
  const { name, args } = named, hidden = CLAUDE_HIDDEN.find(command => command.name === name);
  if (hidden !== undefined) return { kind: "command", name, args, effect: hidden.contextEffect ?? "unknown" };
  if (commands === null) return { kind: "possible_command", name };
  const listed = commands(name, args);
  return { kind: "command", name, args, effect: listed === undefined ? "unknown" : listed.effect ?? claudeListedEffect(name) ?? "keep", ...accepts(listed) };
}
export const claudeClassify: RelayClassify = (text, catalog, attachments = []) => claudeReading(text, catalog === null ? null : relayCommands(catalog), attachments);
/** HarnessControl.classify of the Claude driver. */
export function claudeNativeClassify(text: string, catalog: NativeModelCatalog | null, attachments: readonly ContentKind[]): CommandClass {
  return nativeReading(claudeReading(text, lookupOf(catalog), attachments));
}

// ---------------------------------------------------------------------------------------------------------------------
// Codex (app-server)
// ---------------------------------------------------------------------------------------------------------------------

/** The Codex driver's own thread operations, listed in its catalog. */
export const CODEX_THREAD_COMMANDS = [{ name: "compact", description: "压缩当前会话上下文（原生 thread/compact/start）", contextEffect: "compact" }, { name: "export", description: "导出原生会话记录（Codex rollout JSONL）", contextEffect: "none" }] as const;
/** The inputs the Codex driver turns into thread operations or skill inputs (startText); every other input is text to Codex. */
const CODEX_EXPORT_INPUT = /^\/export\s*$/u, CODEX_COMPACT_INPUT = /^\/compact\s*$/u;
export const CODEX_SKILL_INPUT = /^\/skill:([A-Za-z0-9][A-Za-z0-9._:-]{0,255})(?:\s+([\s\S]*))?$/u;
/** The driver's own thread operation an input asks for, read once for classify() and startText(): with attachments, none. */
export function codexThreadOperation(text: string, attached: boolean): "export" | "compact" | null {
  return attached ? null : CODEX_EXPORT_INPUT.test(text) ? "export" : CODEX_COMPACT_INPUT.test(text) ? "compact" : null;
}
/**
 * Codex's reading: the app-server has no slash commands. Exactly `/export` and `/compact`, without attachments, are the
 * driver's thread operations, and `/skill:<name> …` is an input with that skill when the catalog lists it (only the catalog
 * settles the name), which submits its text as a prompt (acceptsRelay). Anything else, leading whitespace included, is text.
 */
export function codexReading(text: string, commands: CommandLookup | null, attachments: readonly ContentKind[]): CommandClass {
  const operation = codexThreadOperation(text, attachments.length > 0);
  if (operation !== null) { const own = CODEX_THREAD_COMMANDS.find(command => command.name === operation)!; return { kind: "command", name: own.name, args: "", effect: own.contextEffect }; }
  const invoked = CODEX_SKILL_INPUT.exec(text);
  if (invoked === null) return { kind: "content" };
  const name = "skill:" + invoked[1]!;
  if (commands === null) return { kind: "possible_command", name };
  const args = invoked[2]?.trim() ?? "", listed = commands(name, args);
  return listed === undefined ? { kind: "content" } : { kind: "command", name, args, effect: listed.effect ?? "keep", acceptsRelay: true };
}
export const codexClassify: RelayClassify = (text, catalog, attachments = []) => codexReading(text, catalog === null ? null : relayCommands(catalog), attachments);
/** HarnessControl.classify of the Codex driver. */
export function codexNativeClassify(text: string, catalog: NativeModelCatalog | null, attachments: readonly ContentKind[]): CommandClass {
  return nativeReading(codexReading(text, lookupOf(catalog), attachments));
}

// ---------------------------------------------------------------------------------------------------------------------
// OpenCode
// ---------------------------------------------------------------------------------------------------------------------

/** OpenCode's `/compact`, which its ACP takes without announcing it on some lines; the driver lists it when OpenCode does not. */
export const OPENCODE_COMPACT = { name: "compact", description: "压缩上下文（OpenCode 的 /compact；原程序的 ACP 目录没有列出，由 HarnessHub 补入）", contextEffect: "compact" } as const;
/** The command an input names as OpenCode's ACP reads one (`Iuf`): the trimmed input's first word after its slash; null for text. */
export function openCodeCommand(text: string): { readonly name: string; readonly args: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const [name, ...rest] = trimmed.slice(1).split(/\s+/u);
  return name ? { name, args: rest.join(" ").trim() } : null;
}
/**
 * OpenCode's reading: trimmed, `/compact` or a listed command is a command, with or without attachments; a configured
 * command's template enters the session (keep, also for an unknown effect); any other slash input is text for the model.
 */
export function openCodeReading(text: string, commands: CommandLookup | null): CommandClass {
  const named = openCodeCommand(text);
  if (named === null) return { kind: "content" };
  if (named.name === OPENCODE_COMPACT.name) return { kind: "command", name: OPENCODE_COMPACT.name, args: named.args, effect: OPENCODE_COMPACT.contextEffect };
  if (commands === null) return { kind: "possible_command", name: named.name };
  const listed = commands(named.name, named.args);
  return listed === undefined ? { kind: "content" } : { kind: "command", name: named.name, args: named.args, effect: listed.effect === undefined || listed.effect === "unknown" ? "keep" : listed.effect, ...accepts(listed) };
}
export const openCodeClassify: RelayClassify = (text, catalog) => openCodeReading(text, catalog === null ? null : relayCommands(catalog));
/** HarnessControl.classify of the OpenCode driver. */
export function openCodeNativeClassify(text: string, catalog: NativeModelCatalog | null): CommandClass { return nativeReading(openCodeReading(text, lookupOf(catalog))); }

// ---------------------------------------------------------------------------------------------------------------------
// Hermes Agent (gateway viewer)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * What Python's `str.isspace()` accepts (Unicode 15): Hermes's viewer strips an input with `lstrip()` and splits its first
 * word off with `split()` (acp_adapter/gateway_server.py), so a full-width or no-break space before `/clear` still runs it.
 */
const PYTHON_SPACE = "\\t\\n\\v\\f\\r\\u001c-\\u001f \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
export const HERMES_LEADING_SPACE = new RegExp("^[" + PYTHON_SPACE + "]+", "u");
const HERMES_SPACE = new RegExp("^[" + PYTHON_SPACE + "]$", "u"), HERMES_SPACES = new RegExp("[" + PYTHON_SPACE + "]+", "u");
/** Python's `strip()`, one character at a time from each end (a trailing-space pattern would be quadratic on a 64 KiB input). */
function pythonStrip(text: string): string {
  let start = 0, end = text.length;
  while (start < end && HERMES_SPACE.test(text[start]!)) start++;
  while (end > start && HERMES_SPACE.test(text[end - 1]!)) end--;
  return text.slice(start, end);
}
/**
 * Hermes's command registry, each name followed by its aliases: a copy checked against v0.22.5, from hermes_cli/commands.py
 * COMMAND_REGISTRY (ADR-053). The viewer resolves a slash word through it lower-cased (`resolve_command`), and only a word it
 * resolves is a command (gateway_server.py `_slash_command`): the names ROUTES answers itself are all among them, and the
 * gateway's slash.exec answers the rest. Any other slash word, and a path, is prompt text for the model. A later Hermes can
 * add names, so a word that reads like one is never taken for recorded content (the driver's readsAsContent).
 */
export const HERMES_REGISTRY: ReadonlyMap<string, string> = new Map(("start new,reset topic clear redraw history save retry prompt,compose undo title handoff branch,fork worktree compress,compact rollback " +
  "snapshot,snap export import stop discard pause approve deny bg btw agents,tasks journey,learning,memory-graph queue,q steer,s goal " +
  "heartbeat,hb refine review loop,proactive plan moa subgoal status egress context,ctx whoami profile sethome,set-home resume sessions config " +
  "model codex-runtime,codex_runtime personality statusbar,sb battery timestamps,ts diff verbose focus footer yolo approvals reasoning fast " +
  "skin indicator voice wake busy autoprune tools toolsets skills memory bundles pet hatch,generate-pet learn init cron suggestions,suggest " +
  "blueprint,bp curator kanban reload reload-mcp,reload_mcp reload-skills,reload_skills browser plugins commands help palette restart usage " +
  "subscription,upgrade login topup insights platforms,gateway platform copy paste image update version,v debug quit,exit").split(" ").flatMap(entry => {
  const [name, ...aliases] = entry.split(",") as [string, ...string[]];
  return [name, ...aliases].map(key => [key, name] as const);
}));
/**
 * What Hermes's own commands do to its session, by registry name (gateway_commands.py ROUTES, v0.22.5): new and clear
 * clear it; compress compacts it; undo and retry rewind it; steer and queue submit their text as a prompt; the others named
 * here report or set something and leave the history alone. Any other registry command is answered by the gateway's
 * slash.exec, which may report, refuse or submit a turn: unknown.
 */
export const HERMES_EFFECTS: Readonly<Record<string, ContextEffect>> = { new: "clear", clear: "clear", compress: "compact", undo: "rewind", retry: "rewind", steer: "keep", queue: "keep",
  help: "none", model: "none", tools: "none", context: "none", usage: "none", status: "none", version: "none", title: "none", discard: "none", branch: "none", export: "none" };
/**
 * Registry commands that submit their text as a prompt (gateway_commands.py, RT5-16), which can carry relay content; without
 * text they only answer their usage and submit nothing, so a bare one takes none.
 */
const HERMES_PROMPTING: ReadonlySet<string> = new Set(["queue", "steer"]);
/**
 * `/compress` flags that leave the session as it is, in any case (hermes_cli/partial_compress.py `extract_compress_flags`):
 * a preview only reports, and `--aggressive` is refused before anything reaches the gateway.
 */
const HERMES_UNCHANGING_FLAGS: ReadonlySet<string> = new Set(["--preview", "--dry-run", "--dryrun", "--aggressive"]);
/** A slash word that reads like a registry name (lower-case letters, digits, `-` and `_`, in any case). */
export const HERMES_COMMAND_WORD = /^[a-z0-9][a-z0-9_-]*$/iu;
/** Commands Hermes routes but does not announce (gateway_session_meta.py lists reset, not new or clear). */
export const HERMES_HIDDEN: readonly NativeCommand[] = ["new", "clear"].map(name => ({ name, description: "清空 Hermes 的会话历史", contextEffect: "clear" as const }));
/** A registry command's effect for these arguments: `/compress` with a flag that leaves the session alone changes nothing. */
function hermesEffect(name: string, args: string): ContextEffect {
  if (name === "compress" && args.split(HERMES_SPACES).some(flag => HERMES_UNCHANGING_FLAGS.has(flag.toLowerCase()))) return "none";
  return Object.hasOwn(HERMES_EFFECTS, name) ? HERMES_EFFECTS[name]! : "unknown";
}
/** An input's slash word and arguments as the viewer splits them (`_slash_command`, `_run_slash`), or null for prompt text. */
export function hermesCommand(text: string): { readonly word: string; readonly args: string } | null {
  const stripped = text.replace(HERMES_LEADING_SPACE, "");
  if (!stripped.startsWith("/")) return null;
  const word = stripped.slice(1).split(HERMES_SPACES)[0]!;
  // A lone slash, a slash before a space and a path (`/etc/hosts …`) are prompt text.
  if (!word || word.includes("/")) return null;
  return { word, args: pythonStrip(stripped.slice(1 + word.length)) };
}
/**
 * Whether the viewer looks for a slash command in a prompt with these attachments: not when it carries an image, which it
 * stages as an attachment (`_run_slash` runs only without one); a file goes as a text pointer here and an audio block is
 * dropped by its converter (acp_adapter/content.py), which leave the prompt text alone.
 */
export function hermesReadsSlash(attachments: readonly ContentKind[]): boolean { return !attachments.includes("image"); }
/**
 * Hermes's reading: stripped and split as Python does, a slash word the registry resolves (any case, aliases included) is a
 * command with the effect HERMES_EFFECTS names for its arguments, and so is a word outside the registry that this Hermes
 * announced; a path, any other slash word and every input with an image are prompt text. `/queue` and `/steer` submit
 * their text as a prompt (acceptsRelay).
 */
export function hermesReading(text: string, commands: CommandLookup | null, attachments: readonly ContentKind[]): CommandClass {
  const named = hermesReadsSlash(attachments) ? hermesCommand(text) : null;
  if (named === null) return { kind: "content" };
  const name = HERMES_REGISTRY.get(named.word.toLowerCase());
  if (name !== undefined) return { kind: "command", name, args: named.args, effect: hermesEffect(name, named.args), ...(HERMES_PROMPTING.has(name) && named.args !== "" ? { acceptsRelay: true } : {}) };
  // A word outside the registry is a command only when this Hermes announced it.
  if (commands === null) return { kind: "possible_command", name: named.word };
  const listed = commands(named.word, named.args);
  return listed === undefined ? { kind: "content" } : { kind: "command", name: named.word, args: named.args, effect: listed.effect ?? "unknown", ...accepts(listed) };
}
export const hermesClassify: RelayClassify = (text, catalog, attachments = []) => hermesReading(text, catalog === null ? null : relayCommands(catalog), attachments);
/** HarnessControl.classify of the Hermes driver. */
export function hermesNativeClassify(text: string, catalog: NativeModelCatalog | null, attachments: readonly ContentKind[]): CommandClass {
  return nativeReading(hermesReading(text, lookupOf(catalog), attachments));
}

// ---------------------------------------------------------------------------------------------------------------------
// OpenClaw (ACP bridge to its Gateway)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * What OpenClaw's own slash commands do to its session (docs/tools/slash-commands.md, v2026.10.9): `/new` archives it and
 * starts another, `/reset` resets it in place (`/reset soft` keeps the transcript), `/compact` compacts it, `/stop` stops
 * the run; the settings commands change no history; `/restart` and `/bash` act outside the session (unknown effect).
 */
export const OPENCLAW_COMMAND_EFFECTS: Readonly<Record<string, ContextEffect>> = { new: "clear", reset: "clear", compact: "compact", stop: "none", restart: "unknown", bash: "unknown",
  think: "none", verbose: "none", trace: "none", reasoning: "none", elevated: "none", model: "none", queue: "none", usage: "none", fast: "none" };
/** The effect OPENCLAW_COMMAND_EFFECTS names for a command, or undefined: only its own entries count (no Object member). */
export function openClawCommandEffect(name: string): ContextEffect | undefined { return Object.hasOwn(OPENCLAW_COMMAND_EFFECTS, name) ? OPENCLAW_COMMAND_EFFECTS[name] : undefined; }
function openClawEffect(name: string, args: string): ContextEffect {
  return name === "reset" && args.split(/\s+/u)[0] === "soft" ? "compact" : openClawCommandEffect(name) ?? "unknown";
}
/** OpenClaw's reading: the bridge's listed commands (the shared reading), with the effects OpenClaw gives its own by arguments. */
export function openClawReading(text: string, commands: CommandLookup | null): CommandClass {
  const reading = sharedReading(text, commands);
  // The effect of a command OpenClaw names here depends on its arguments (`/reset soft`), whatever the catalog declares.
  return reading.kind === "command" && openClawCommandEffect(reading.name) !== undefined ? { ...reading, effect: openClawEffect(reading.name, reading.args) } : reading;
}
export const openClawClassify: RelayClassify = (text, catalog) => openClawReading(text, catalog === null ? null : relayCommands(catalog));
/** HarnessControl.classify of the OpenClaw driver. */
export function openClawNativeClassify(text: string, catalog: NativeModelCatalog | null): CommandClass { return nativeReading(openClawReading(text, lookupOf(catalog))); }
