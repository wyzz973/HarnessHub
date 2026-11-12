import type { ControlProtocol } from "../contexts/catalog/domain/discovery.js";
import type { ResolvedCommand } from "../contexts/catalog/domain/catalog.js";
import type { ContentKind, ContentRef, ControlAttachment } from "./content.js";
import type { RelayCapabilities, RelayPacketId, TurnText } from "./relay.js";
export type { TurnText };

declare const nativeConversationBrand: unique symbol;
export type NativeConversationId = string & { readonly [nativeConversationBrand]: true };
/**
 * The wait a driver announces with a permission request (ADR-035): only the program's own deadline (already less the driver's
 * margin, in milliseconds from now). A request the program gave no deadline has none: it waits for the user (2026-11-12: the driver
 * no longer has a deadline of its own for the Turn). The Runtime then applies an operator's wait budget, when there is one.
 */
export function requestExpiry(nativeMs: number | null): { readonly expiresInMs: number; readonly expiresBy: "native" } | Record<never, never> {
  return nativeMs === null ? {} : { expiresInMs: Math.max(0, Math.round(nativeMs)), expiresBy: "native" };
}
export function nativeConversationId(value: unknown): NativeConversationId {
  if (typeof value !== "string" || !value || value.length > 512 || /[\0\r\n]/u.test(value))
    throw new Error("invalid native conversation identity");
  return value as NativeConversationId;
}
export interface ControlLaunch extends ResolvedCommand {
  readonly protocol: "acp-v1" | "codex-app-server" | "pi-rpc";
}
export interface ControlOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly requestTimeoutMs: number;
  /**
   * The driver's own deadline for one Turn; absent (the Gateway sets none: a Turn has no time wall, 2026-11-12) it has none. It is
   * a way for a probe or a test to bound a protocol that hangs, not a limit of the product.
   */
  readonly runTimeoutMs?: number;
  /**
   * How long the start of a connection is waited for: the handshake (`initialize`), which a Harness answers only once it has started its
   * plugins, MCP servers and model catalog (a first start can take minutes), and the opening of a session. A start that is merely slow is
   * not a failure. Absent: `requestTimeoutMs`. A start that runs out of it fails with NATIVE_INITIALIZE_TIMEOUT or NATIVE_SESSION_TIMEOUT,
   * which say which step it was waiting for.
   */
  readonly startupTimeoutMs?: number;
  readonly maxFrameBytes: number;
  readonly maxDiagnosticBytes: number;
  readonly closeGraceMs: number;
  /**
   * How long a host's close evidence waits for processes that left the program's process group to exit on their own before
   * it records them as remaining (ADR-056 §4.11); they are never signalled, and close() itself never waits for them. The
   * host budgets' default (resolveHostBudgets) when absent.
   */
  readonly closeOutsideWaitMs?: number;
  /**
   * The native options the connection's conversation is chosen to open with, known before initialize (a Run's selection).
   * A driver whose protocol fixes capabilities at initialize reads them; open() still validates what it receives.
   */
  readonly selectedOptions?: NativeOptions;
}
export interface ProtocolObservation {
  readonly protocol: ControlProtocol;
  readonly protocolVersion: number | null;
  readonly agentName: string | null;
  readonly agentVersion: string | null;
  readonly authenticationMethods: readonly string[];
  readonly capabilities: Readonly<Record<string, unknown>>;
}
/** Bounded native tool facts. Drivers trim previews; complete payloads never leave the Driver unbounded. */
export interface NativeToolDetail {
  /** Native tool family (execute/edit/read/search/fetch/think/mcp/subagent/image/...). */
  readonly kind?: string;
  /** Native tool name, e.g. Bash or server/tool. */
  readonly name?: string;
  readonly input?: string;
  readonly output?: string;
  /** Unified diff text for file changes. */
  readonly diff?: string;
  readonly locations?: readonly string[];
  readonly exitCode?: number;
  /** Owning parent tool or sub-agent identity inside the same Turn. */
  readonly parentId?: string;
  /** Written by builds before 2026-11-12 that cut a preview to its byte budget. No driver cuts a detail any more (the content store keeps it whole); the flag stays so that what was written reads. */
  readonly truncated?: boolean;
}
export interface NativePlanEntry { readonly content: string; readonly status: "pending" | "in_progress" | "completed"; readonly priority?: "high" | "medium" | "low" }
/** Latest native accounting. Turn tokens belong to this Run; context and cost carry their own scope. */
export interface NativeUsage {
  /**
   * `own`: the Driver turned the native session's running totals into this Turn's own numbers (Hermes, 2026-11-12). A Harness that reports
   * session totals is read by them only when it is set: the same Harness's earlier records hold the totals and are not a Turn's.
   */
  readonly turn?: { readonly input?: number; readonly output?: number; readonly cachedInput?: number; readonly cacheWrite?: number; readonly reasoning?: number; readonly total?: number; readonly own?: true };
  readonly context?: { readonly used: number; readonly size?: number };
  readonly cost?: { readonly amount: number; readonly currency: string; readonly scope: "turn" | "session" };
  /**
   * The Turn's model requests one by one, oldest first, all of them (they were the latest 64 until 2026-11-12): what each read and
   * what the cache gave it (ADR-055 §3.2, VF2-09). Absent when the native side reports only totals.
   */
  readonly requests?: readonly { readonly input: number; readonly cachedInput?: number; readonly cacheWrite?: number }[];
}
/** Non-text native output. Bytes are handed to the content owner; links are never fetched. */
export type NativeOutput =
  | { readonly kind: "content"; readonly name: string; readonly mediaType: string; readonly data: Uint8Array }
  | { readonly kind: "link"; readonly uri: string; readonly name: string; readonly title?: string; readonly mediaType?: string };
export type ControlEvent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "thinking"; readonly text: string }
  | { readonly type: "tool"; readonly id: string; readonly title: string; readonly status: string; readonly detail?: NativeToolDetail }
  | { readonly type: "plan"; readonly entries: readonly NativePlanEntry[]; readonly explanation?: string }
  | { readonly type: "usage"; readonly usage: NativeUsage }
  | { readonly type: "notice"; readonly severity: "info" | "warning" | "error"; readonly title: string; readonly detail?: string }
  | { readonly type: "activity"; readonly id: string; readonly kind: "subagent" | "task" | "compaction" | "retry" | "review"; readonly title: string; readonly status: "running" | "completed" | "failed" | "cancelled"; readonly detail?: string }
  | { readonly type: "output"; readonly output: NativeOutput }
  | { readonly type: "permission_requested"; readonly id: string; readonly title: string; readonly detail?: string; readonly input?: {readonly kind:"text"|"editor"|"secret";readonly value:string}; readonly options: readonly { readonly id: string; readonly name: string }[];
      /**
       * How long the request can still wait from now, and whose deadline that is (ADR-035): the program's own ("native": it
       * refuses or withdraws then, and the driver closes the request just before) or this Turn's ("turn": the driver's hard
       * cap). The Runtime replaces a "turn" deadline with what is left of the Turn's wait budget (ADR-036), and keeps a
       * "native" one only when it is earlier. Absent when the driver knows neither.
       */
      readonly expiresInMs?: number; readonly expiresBy?: "native" | "turn";
      /** A question the program asks (a form, a choice, free text) rather than an approval of its own action; approval when absent. */
      readonly kind?: "approval" | "question";
      /** The id the program gave the call this approval is about (the `id` of its `tool` event), when it names it: ACP's `toolCall.toolCallId`, Codex's `itemId`. */
      readonly forCall?: string }
  | { readonly type: "permission"; readonly id: string; readonly decision: "denied" | "cancelled" }
  | { readonly type: "diagnostic"; readonly message: string }
  /**
   * The native side recorded this Turn's input in its history (ADR-055 §7.1, evidence E1): its protocol said so, or it echoed
   * the user entry. `packetId` is the relay packet the Driver saw in that entry, when it looked for one. Sent at most once per
   * Turn, before the Turn's result; never inferred from the reply alone (that is BackendResult.input).
   */
  | { readonly type: "input_recorded"; readonly packetId?: RelayPacketId };
export interface BackendResult {
  readonly status: "completed" | "cancelled" | "failed";
  readonly reason: string;
  readonly error?: { readonly code: string; readonly message: string };
  /**
   * What the driver knows of the prompt reaching the native history (ADR-055 §7.1), whatever the status: "recorded" when
   * the native side took it into its history (it answered the prompt, or its protocol says so even of a failure after the
   * prompt was inserted), "not_recorded" when nothing was sent or the native side refused it before inserting it (the
   * driver's own results, such as a refused command or an unapplied model, included). Absent is unknown: no evidence either
   * way, which is never read as not recorded. A command prompt is never reported recorded on its reply alone. The Session
   * keeps this only in the Turn's end event; its snapshot never stores it.
   */
  readonly input?: "recorded" | "not_recorded";
  /**
   * What the driver knows of a command prompt beyond its status (ADR-055 §7.6): "noop" when the native side answered, in
   * its own fixed words, that the command it ran changed nothing (Hermes's `/compress` with nothing to remove). Absent says
   * nothing. The Session reads it only for the command's effect and stores it nowhere.
   */
  readonly command?: "noop";
  /**
   * The Driver ran the Hub's clear (decision log 2026-11-11: clearing is the Hub's, on every Harness): it sent nothing to the
   * native side and gave the native session up, so the next Turn opens a new native session (a session never prompted cannot be
   * resumed by another process, so a Driver does not open one ahead). Absent says nothing happened. The Session writes its
   * conclusion into the Turn's end event; the snapshot never holds it.
   */
  readonly native?: { readonly cleared: true };
}
/**
 * The default placement of a Turn's text: the input alone, or the relay packet, a blank line and the user's words as one
 * text. A Driver whose declaration places them otherwise (RelayCapabilities.placement) does so itself.
 */
export function singleText(text: TurnText): string { return typeof text === "string" ? text : `${text.relay.body}\n\n${text.user}`; }
export interface NativeOption {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly currentValue: string;
  readonly values: readonly { readonly value: string; readonly name: string }[];
}
export type NativeOptions = Readonly<Record<string, string>>;
/**
 * Prompt content a native interface accepts besides text, as it declares it: ACP promptCapabilities, Codex
 * Model.inputModalities, Pi Model.input. `file` means a file can be handed over as a readable path, link or embedded text.
 */
export interface NativeInputs { readonly image: boolean; readonly audio: boolean; readonly file: boolean }
/**
 * What the installed Harness has loaded besides its model, as it reports it: skills (invocable ones are also commands),
 * MCP servers with their connection state and tool count, and plugins or extensions. Read-only; Hub never changes them.
 */
export interface NativeExtensions {
  readonly skills: readonly { readonly name: string; readonly description: string; readonly scope?: string; readonly enabled: boolean; readonly command?: string }[];
  readonly mcpServers: readonly { readonly name: string; readonly status: string; readonly auth?: string; readonly tools: number; readonly failed: boolean }[];
  readonly plugins: readonly { readonly name: string; readonly enabled: boolean; readonly version?: string; readonly source?: string }[];
  /** Lists cut at their bounds; the Harness has more than shown. No Driver cuts them since 2026-11-12; kept for a reader of an older answer. */
  readonly truncated?: boolean;
}
/** One native session of a workspace as the installed Harness lists it; `id` is the Harness's own session identity. */
export interface NativeSessionSummary {
  readonly id: string;
  readonly title: string | null;
  /** Milliseconds since the epoch, when the Harness reports it. */
  readonly updatedAt: number | null;
  /** Where the Harness says the session came from (cli, vscode, exec, appServer…), when it says. */
  readonly source?: string;
}
export interface NativeSessionPage { readonly sessions: readonly NativeSessionSummary[]; readonly nextCursor: string | null }
/** A listed native session read for continuing it: its recovery reference and the most recent public messages. */
export interface NativeSessionImport {
  readonly checkpoint: string;
  readonly title: string | null;
  readonly history: readonly { readonly role: "user" | "assistant"; readonly text: string }[];
  /** Older messages read but not returned; drivers read the whole history (2026-11-12), so this is 0 unless a Harness itself withholds some. */
  readonly omitted: number;
  /** True when the returned and omitted messages cover the whole native history. */
  readonly complete: boolean;
  /** False when the interface can continue the session but cannot read its history. */
  readonly historyRead: boolean;
}
/**
 * What running a native command does to the native context (ADR-055 R0d): it enters the history like a message (keep),
 * leaves the history alone (none), compacts, clears or rewinds it, or the driver cannot tell (unknown).
 */
export type ContextEffect = "keep" | "none" | "compact" | "clear" | "rewind" | "unknown";
/** A native command as its driver declares it; an absent effect is unknown. */
export interface NativeCommand { readonly name: string; readonly description: string; readonly contextEffect?: ContextEffect }
/**
 * How the native side reads one input, as its driver reproduces the native parsing (leading whitespace, names, aliases,
 * paths): a command with its effect for these arguments, content, or a possible command whose name only the catalog can
 * settle (read without a catalog).
 *
 * `acceptsRelay` is true only for a command whose arguments the native side submits as a prompt, which may then carry relay
 * content (ADR-055 §7.4: Codex `/skill:…`, Hermes `/queue` and `/steer`); absent means it does not. Only a Driver's relay
 * declaration (RelayCapabilities.commands.classify) sets it; HarnessControl.classify leaves it out.
 */
export type CommandClass =
  | { readonly kind: "command"; readonly name: string; readonly args: string; readonly effect: ContextEffect; readonly acceptsRelay?: true }
  | { readonly kind: "content" }
  | { readonly kind: "possible_command"; readonly name: string };
/**
 * What a catalog says of one command name, consulted by a reading: undefined when it does not list the name, otherwise the
 * effect it declares for these arguments (absent when it declares none, which each reading settles its own way) and
 * whether the command takes relay content. Pure and synchronous.
 */
export type CommandLookup = (name: string, args: string) => { readonly effect?: ContextEffect; readonly acceptsRelay?: true } | undefined;
/** A native catalog's commands as a lookup: the first listed command of a name, with its declared contextEffect. */
export function catalogCommands(catalog: NativeModelCatalog): CommandLookup {
  return name => {
    const listed = catalog.commands?.find(command => command.name === name);
    return listed === undefined ? undefined : listed.contextEffect === undefined ? {} : { effect: listed.contextEffect };
  };
}
/**
 * The reading every native interface shares unless its driver knows better, over any lookup (a native catalog, or a relay
 * declaration's catalog): an input that starts with "/" names a command by its first word, which is a command when the
 * lookup lists it (its declared effect, unknown when it declares none) and content otherwise. Without a lookup such an
 * input is a possible command.
 */
export function sharedReading(text: string, commands: CommandLookup | null): CommandClass {
  if (!text.startsWith("/")) return { kind: "content" };
  const name = text.slice(1).split(/\s/u)[0]!;
  if (!name) return { kind: "content" };
  if (commands === null) return { kind: "possible_command", name };
  const args = text.slice(1 + name.length).trim(), listed = commands(name, args);
  return listed === undefined ? { kind: "content" } : { kind: "command", name, args, effect: listed.effect ?? "unknown", ...(listed.acceptsRelay ? { acceptsRelay: true } : {}) };
}
/** The shared reading (sharedReading) against a native catalog; without a catalog a slash word is a possible command. */
export function listedCommand(text: string, catalog: NativeModelCatalog | null): CommandClass {
  return sharedReading(text, catalog === null ? null : catalogCommands(catalog));
}
export interface NativeModelCatalog {
  readonly models: readonly { readonly id: string; readonly name: string; readonly options?: readonly NativeOption[]; readonly inputs?: NativeInputs }[];
  /** Agent-level inputs; a model's own `inputs` take precedence when the native interface declares them per model. */
  readonly inputs?: NativeInputs;
  /** The native configured default before any session-local model override. */
  readonly defaultModel: string | null;
  readonly selectionError?: { readonly code: string; readonly message: string };
  readonly authentication: "ready" | "missing" | "unknown";
  readonly canSelect: boolean;
  readonly options?: readonly NativeOption[];
  readonly commands?: readonly NativeCommand[];
}
export interface StopRequestReceipt { readonly requested: true }
export interface CleanupEvidence {
  readonly closed: true;
  readonly exitCode: number | null;
  readonly signal: string | null;
  /** Process cleanup can succeed while the connection has suffered a protocol failure. */
  readonly protocolFailure: { readonly code: string; readonly message: string } | null;
}
export interface ControlRun {
  readonly result: Promise<BackendResult>;
  /** Receipt is not backend settlement or process cleanup. */
  requestStop(): Promise<StopRequestReceipt>;
}
/**
 * One native conversation and active run per connection, unless the driver has the optional multi-session methods below
 * (ADR-056; no driver has them yet); all resources are owned by close().
 */
export interface HarnessControl {
  /**
   * The Driver's static relay declaration (ADR-055 §3.2, §8.1): the same module-level object its factory returns for the
   * harness without an instance (relayCapabilities in adapters/control/factory.ts), never changed by the connection.
   * Absent for a Driver that declares none, which the relay treats as the most conservative declaration (INV-16).
   */
  readonly relayCapabilities?: RelayCapabilities;
  initialize(): Promise<ProtocolObservation>;
  open(cwd: string, model?: string, options?: NativeOptions, checkpoint?: string): Promise<NativeConversationId>;
  /**
   * Opens one more native session on this connection (new, or the one behind `checkpoint`) and returns its identity, without
   * changing the session open() opened or any other (ADR-056 §4.2). Declared for multi-session hosts; a driver without it
   * carries one session per process. Rejects as open() does; a session it opened is closed by closeSession() or close().
   */
  openSession?(cwd: string, model?: string, options?: NativeOptions, checkpoint?: string): Promise<NativeConversationId>;
  /**
   * Closes one open session in the program and leaves the connection and its other sessions running. Rejects while the
   * session has an active run; resolves once the program confirmed the close. Whether that returns the session's resources
   * is the driver's sessionRelease declaration.
   */
  closeSession?(id: NativeConversationId): Promise<void>;
  /** Makes an open session the program's active one, on a connection with one active session at a time; rejects while another session runs. */
  switchSession?(id: NativeConversationId): Promise<void>;
  /** Private Driver-owned recovery reference, never credentials. Null means the current native interface cannot resume. */
  checkpoint?(): Promise<string | null>;
  models?(): Promise<NativeModelCatalog>;
  /**
   * Reads an input the way the native side will (ADR-055 R0d), synchronously and without I/O: with this connection's
   * catalog (models()), or with null before it is read, when a name only the catalog can settle is a possible command.
   * `attachments` are the kinds of the input's attachments, none by default: with some kinds a native side reads any input
   * as a prompt (Hermes with an image). startText treats the input by this same reading. Absent means the shared reading
   * (listedCommand).
   */
  classify?(text: string, catalog: NativeModelCatalog | null, attachments?: readonly ContentKind[]): CommandClass;
  /**
   * Rejects with ATTACHMENT_UNSUPPORTED (or a size code) before anything is sent when the open conversation's agent or
   * model cannot take one of the attachments. Called by the Runtime before dispatch; a control without it takes none.
   */
  checkAttachments?(attachments: readonly ContentRef[]): Promise<void>;
  /**
   * Creates a native copy of the session behind `checkpoint` and returns the copy's own recovery reference; the source
   * session is left as it was. Rejects with NATIVE_FORK_UNAVAILABLE when the installed interface cannot branch. Used on a
   * connection that opens no other conversation.
   */
  fork?(checkpoint: string, cwd: string): Promise<string>;
  /**
   * The open conversation's current model and option values as the native side reports them after a Turn, including
   * changes made by its own commands. Identities are the catalog's (model ids, option ids and values) so the Hub can apply
   * them again; a null model means the interface cannot tell. Called only after the Turn settled, before close; a failure
   * leaves the configuration unknown and never changes the Turn's result. Absent when the interface cannot report it; null
   * when this Turn told nothing about the native values, so the earlier report stands (a resumed Codex thread whose
   * collaboration mode Codex did not report).
   */
  nativeConfig?(): Promise<{ readonly model: string | null; readonly options: NativeOptions } | null>;
  /** Native skills, MCP servers and plugins; absent when the interface cannot list them. */
  extensions?(): Promise<NativeExtensions>;
  /**
   * Whether this connection can still take a Turn: initialized, without a protocol failure, its process still running. A
   * conversation that keeps its process (ADR-030) checks it before reusing it; absent means it cannot tell.
   */
  healthy?(): boolean;
  /** The process group this connection's program leads (its pid), for recognizing a kept process later; null before it started. */
  processGroup?(): number | null;
  /** A position in the program's stderr, to read what it logs from here on (a Turn's diagnostics). */
  diagnosticMark?(): number;
  /**
   * What the program logged on stderr after `mark`, as far as a bounded recent window still holds it. Private text: it may
   * name the user's paths or the program's own credentials, and is redacted before it leaves the Gateway.
   */
  diagnosticsSince?(mark: number): string;
  /** Updates the native side sent outside any Turn of this connection (background work, autonomous follow-ups); counted only. */
  readonly unattributedUpdates?: number;
  /**
   * The installed Harness's own sessions whose working directory is `cwd`, newest first, on a connection that opens none
   * of them. Absent when the interface cannot list sessions; NATIVE_SESSION_LIST_UNAVAILABLE when it declares but refuses.
   */
  nativeSessions?(cwd: string, cursor?: string): Promise<NativeSessionPage>;
  /**
   * Reads one listed session of `cwd` for continuing it in the Hub: confirms it belongs to `cwd`, returns its recovery
   * reference and recent messages. Sends no prompt and changes nothing; the connection is closed afterwards.
   */
  importSession?(id: string, cwd: string): Promise<NativeSessionImport>;
  /**
   * Names the open conversation on the native side, for a session a handoff created; called after open() and before its
   * first prompt, only when the declaration's `title` is "set". A failure never fails the Turn.
   */
  setTitle?(id: NativeConversationId, title: string): Promise<void>;
  /**
   * Sends one prompt: the input alone, or the user's words with a relay packet the Driver places by its declaration
   * (singleText by default). Attachments were accepted by checkAttachments; their private copies stay readable for the Turn.
   */
  startText(id: NativeConversationId, text: TurnText, onEvent: (event: ControlEvent) => void, attachments?: readonly ControlAttachment[]): Promise<ControlRun>;
  /** Enables interactive requests for a public Run. Standalone probes keep their explicit deny default. */
  enablePermissions?(): void;
  /** Selects an actual pending option; receipt does not assert backend acknowledgement. */
  decidePermission?(id: string, option: string, input?: string): Promise<void>;
  close(): Promise<CleanupEvidence>;
}
