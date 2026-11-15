import { randomBytes } from "node:crypto";
import type { BackendResult, ControlEvent, ControlLaunch, ControlOptions, ControlRun, NativeConversationId, NativeOptions, NativeToolDetail, SteerOutcome, TurnText } from "../../../contracts/control.js";
import type { ControlAttachment } from "../../../contracts/content.js";
import type { FlavorCapabilities } from "../../../contracts/flavor.js";
import { ControlError, object } from "../../../infrastructure/control/json-rpc-process.js";
import { AcpControl } from "../acp.js";
import { codebuddyRelayCapabilities } from "./reading.js";

/** CodeBuddy Code 2.184's own `_meta` keys on its ACP updates and prompts. */
const META = { parent: "codebuddy.ai/parentToolCallId", tool: "codebuddy.ai/toolName", compact: "codebuddy.ai/isCompactInternal", request: "codebuddy.ai/conversationRequestId" } as const;
/** Its extension methods (the ACP SDK hands it every method it does not know, by its full name). */
const ROLLBACK = "_codebuddy.ai/session/rollback", STEER = "session/steer";
/** A whole summary as it ends: the last wrapper's words (its start may come once alone, then again with the summary). */
const SUMMARY = /^[\s\S]*<conversation_history_summary>\s*<summary>([\s\S]*?)<\/summary>\s*<\/conversation_history_summary>\s*$/u;
const COMPACT_COMMAND = /^\/compact(?:\s|$)/u;
/** A compaction streaming now: `command` when the Turn is a `/compact` (its every reply chunk is the summary), else only marked chunks are. */
interface Compaction { readonly id: string; readonly command: boolean; text: string }

/** A conversation request id as CodeBuddy Code takes one from its client (`assertClientConversationRequestId`): a lowercase UUIDv7 as 32 hex digits. */
export function conversationRequestId(now = Date.now(), random: Uint8Array = randomBytes(10)): string {
  const hex = Buffer.from(random).toString("hex");
  return now.toString(16).padStart(12, "0").slice(-12) + "7" + hex.slice(0, 3) + (8 + (random[2]! & 3)).toString(16) + hex.slice(4, 19);
}
function record(value: unknown): Readonly<Record<string, unknown>> | null { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function blocksText(content: unknown): string {
  const blocks = Array.isArray(content) ? content : [content];
  return blocks.map(block => { const row = record(block); return row?.type === "text" && typeof row.text === "string" ? row.text : ""; }).join("");
}

/**
 * CodeBuddy Code (`@tencent-ai/codebuddy-code`, `codebuddy --acp`) on ACP stdio. Its own sign-in stays its own: the driver never authenticates (that
 * signs the user out first) and a session it cannot open for want of one says so. What it adds to ACP:
 * - a compaction streams its summary as reply text: marked `codebuddy.ai/isCompactInternal` when it compacts itself, unmarked for a `/compact` (seen on
 *   2.184.0), each time wrapped in `<conversation_history_summary><summary>`: one compaction activity, its thinking dropped;
 * - a sub-agent's words stream into the root session with `codebuddy.ai/parentToolCallId`: dropped (its calls stay, under their parent);
 * - its catalog pushes arrive as `model_update`, a turn's end as `session_end`;
 * - words in the middle of a turn are `session/steer`, a rollback is `_codebuddy.ai/session/rollback` to before a turn's request: each only where the
 *   declaration says so (flavors/codebuddy-code.ts), the request ids then going with the prompts (`codebuddy.ai/conversationRequestId`).
 */
export class CodeBuddyControl extends AcpControl {
  /** The request ids of the Turns this connection ran on its session (the ones the Hub counts), oldest first. */
  private turns: string[] = [];
  /** The request id the prompt now sent carries; null when it carries none. */
  private inFlight: string | null = null;
  private compacting: Compaction | null = null;
  /** The prompt now sent is a `/compact`: its Turn's first update begins the compaction. */
  private compactDue = false;
  private compactions = 0;

  constructor(launch: ControlLaunch, private readonly settings: ControlOptions) { super(launch, settings, codebuddyRelayCapabilities); }
  protected override get product(): string { return "CodeBuddy Code"; }
  private declared(capability: keyof FlavorCapabilities): boolean { return this.settings.flavor?.capabilities?.[capability] === "native"; }

  override async open(cwd: string, model?: string, options?: NativeOptions, checkpoint?: string): Promise<NativeConversationId> {
    this.turns = []; this.compacting = null; this.compactDue = false;
    return super.open(cwd, model, options, checkpoint);
  }
  override async startText(id: NativeConversationId, turn: TurnText, onEvent: (event: ControlEvent) => void, attachments: readonly ControlAttachment[] = []): Promise<ControlRun> {
    this.inFlight = null; this.compactDue = false;
    const run = await super.startText(id, turn, onEvent, attachments), request = this.inFlight;
    const counted = (result: BackendResult): boolean => result.status === "completed" || result.status === "cancelled" || result.input === "recorded";
    if (request !== null) void run.result.then(result => { if (counted(result)) this.turns.push(request); }, () => undefined).finally(() => { if (this.inFlight === request) this.inFlight = null; });
    // A `/compact` that completed with no whole summary leaves its words as the reply; the compaction stays open, and the Turn's end tells it as unknown
    // (cancelled when it was stopped).
    const ended = (completed: boolean): void => {
      const open = this.compacting; this.compactDue = false;
      if (open?.command !== true) return;
      this.compacting = null;
      if (completed && open.text) onEvent({ type: "text", text: open.text });
    };
    return { ...run, result: run.result.then(result => { ended(result.status === "completed"); return result; }, (error: unknown) => { ended(false); throw error; }) };
  }
  protected override promptMeta(prompt: string, content: boolean): Readonly<Record<string, unknown>> | null {
    this.compactDue = !content && COMPACT_COMMAND.test(prompt.trim());
    if (!content || !(this.declared("rollback") || this.declared("steer"))) return null;
    this.inFlight = conversationRequestId();
    return { [META.request]: this.inFlight };
  }
  /** Signed out: `session/new` and `session/load` answer -32000 `{category: "auth"}`, and the Hub says how to sign in, never signing in itself. */
  protected override refusal(method: string, error: ControlError): { readonly code: string; readonly message: string } | null {
    if (error.remoteCode !== -32000 || error.remoteFields?.category !== "auth") return null;
    if (method.startsWith("session/")) this.setAuthentication("missing");
    return { code: "NATIVE_AUTH_REQUIRED", message: "CodeBuddy Code 还没有登录：在终端运行 codebuddy，按提示登录一次后再试。" };
  }
  /** Its own notices (`_codebuddy.ai/command` workspace_info, checkpoints, artifacts…) are for its own clients: taken, nothing to show. */
  protected override extensionNotification(method: string): boolean { return method.startsWith("_codebuddy.ai/"); }
  protected override ownUpdate(kind: string, update: Readonly<Record<string, unknown>>, report: ((event: ControlEvent) => void) | null): boolean {
    if (this.compactDue && report !== null) {
      this.compactDue = false;
      this.compacting = { id: `compaction-${++this.compactions}`, command: true, text: "" };
      report({ type: "activity", id: this.compacting.id, kind: "compaction", title: "上下文压缩", status: "running" });
    }
    if (kind === "session_end") return true;
    if (kind === "model_update") { if (typeof update.currentModelId === "string") this.adoptModel(update.currentModelId); return true; }
    if (kind !== "agent_message_chunk" && kind !== "agent_thought_chunk") return false;
    const meta = record(update._meta), text = blocksText(update.content), item = typeof update.messageId === "string" && update.messageId.length <= 512 ? update.messageId : undefined;
    const marked = meta?.[META.compact] === true;
    if (this.compacting === null && marked) {
      this.compacting = { id: item ?? `compaction-${++this.compactions}`, command: false, text: "" };
      report?.({ type: "activity", id: this.compacting.id, kind: "compaction", title: "上下文压缩", status: "running" });
    }
    const compaction = this.compacting;
    if (compaction !== null && (compaction.command || marked)) {
      if (kind === "agent_thought_chunk") return true;
      compaction.text += text;
      const whole = /<\/conversation_history_summary>\s*$/u.test(compaction.text.slice(-64)) ? SUMMARY.exec(compaction.text) : null;
      if (whole) {
        this.compacting = null;
        const summary = whole[1]!.trim();
        report?.({ type: "activity", id: compaction.id, kind: "compaction", title: "上下文压缩", status: "completed", ...(summary ? { detail: summary } : {}) });
      }
      return true;
    }
    if (typeof meta?.[META.parent] === "string") return true;
    if (!Array.isArray(update.content)) return false;
    if (text) report?.({ type: kind === "agent_message_chunk" ? "text" : "thinking", text, ...(item === undefined ? {} : { item }) });
    return true;
  }
  protected override describeTool(_title: string, detail: NativeToolDetail | undefined, update: Readonly<Record<string, unknown>>): NativeToolDetail | undefined {
    const meta = record(update._meta), name = meta?.[META.tool], parent = meta?.[META.parent];
    const named = typeof name === "string" && name && detail?.name === undefined ? { name } : {}, under = typeof parent === "string" && parent && detail?.parentId === undefined ? { parentId: parent } : {};
    return Object.keys(named).length + Object.keys(under).length === 0 ? detail : { ...detail, ...named, ...under };
  }
  override get steering(): boolean { return this.declared("steer"); }
  protected override steerRequest(id: NativeConversationId, text: string): { readonly method: string; readonly params: Readonly<Record<string, unknown>> } {
    return { method: STEER, params: { sessionId: id, contentBlocks: [{ type: "text", text }], ...(this.inFlight === null ? {} : { expectedRequestId: this.inFlight }) } };
  }
  /** `{steered: true}` took the words into the running turn's next step; `{steered: false, reason: idle | stale}` took nothing. */
  protected override steerOutcome(response: Readonly<Record<string, unknown>>): SteerOutcome | null {
    return response.steered === true ? "taken" : response.steered === false ? "not_taken" : null;
  }
  /**
   * HarnessControl.rollback: the session goes back to before the earliest of the last `turns` Turns (`checkpoint_revert` to that request's fork point;
   * the history after it stays on its branch, files are not touched). Only Turns this connection ran are known by their request ids: more than that,
   * or a request CodeBuddy Code cannot place, changes nothing (NATIVE_ROLLBACK_UNAVAILABLE).
   */
  async rollback(id: NativeConversationId, turns: number): Promise<void> {
    this.assertOwned(id);
    if (!this.idle) throw new ControlError("INVALID_STATE", "a rollback runs between Turns");
    if (!Number.isSafeInteger(turns) || turns < 1 || turns > this.turns.length) throw new ControlError("NATIVE_ROLLBACK_UNAVAILABLE", "this connection does not know where those Turns began");
    let response: Readonly<Record<string, unknown>>;
    try { response = object(await this.extRequest(ROLLBACK, { sessionId: id, targetRequestId: this.turns[this.turns.length - turns]!, reason: "checkpoint_revert" }), "rollback result"); }
    catch (error) {
      if (error instanceof ControlError && error.code === "REMOTE_ERROR" && (error.remoteCode === -32601 || error.remoteCode === -32602)) throw new ControlError("NATIVE_ROLLBACK_UNAVAILABLE", "CodeBuddy Code refused the rollback");
      throw error;
    }
    if (response.applied !== true) throw new ControlError("NATIVE_ROLLBACK_UNAVAILABLE", "CodeBuddy Code could not place where those Turns began");
    this.turns.splice(this.turns.length - turns);
  }
}
