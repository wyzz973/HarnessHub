import type { ContentRef } from "./content.js";
import type { MessageId, RunId } from "./session.js";

/**
 * The HarnessHub protocol, hh/1: what a client reads of a Turn, whichever Harness ran it (docs/proposals/protocol/hub-protocol.html,
 * decided 2026-11-12). A Turn is an ordered list of items from a small fixed vocabulary; every Harness's native events are
 * normalized into it by one shared module, and the interface renders these types and never a Harness's own words.
 */
export const PROTOCOL_VERSION = "hh/1" as const;

/** The one set of states an item is in. `unknown`: the outcome could not be read, which is never shown as completed. */
export const ITEM_STATUSES = ["pending", "running", "waiting", "completed", "failed", "declined", "cancelled", "unknown"] as const;
export type ItemStatus = typeof ITEM_STATUSES[number];

export const ITEM_TYPES = [
  "user_message", "assistant_message", "reasoning",
  "command", "file_read", "file_change", "search", "web", "mcp_tool", "tool", "subagent",
  "plan", "plan_proposal", "recap",
  "approval", "question",
  "notice", "error", "context_event", "switch", "interrupt", "delegation", "artifact",
] as const;
export type ItemType = typeof ITEM_TYPES[number];

/** The items that are actions of the Harness: consecutive ones are shown as one summary line. */
export const WORK_TYPES = ["command", "file_read", "file_change", "search", "web", "mcp_tool", "tool", "subagent"] as const;
export type WorkType = typeof WORK_TYPES[number];

/** What every item carries. `seq` is its place in the Turn, fixed when the item is first seen. */
export interface ItemBase {
  readonly id: string;
  readonly seq: number;
  readonly status: ItemStatus;
  readonly startedAt?: number;
  readonly endedAt?: number;
  /** The subagent item this one happened inside. */
  readonly parentId?: string;
  /** The native side's own name for it (a tool name, an item type), kept as a reference and never as the label. */
  readonly nativeName?: string;
  /** The stored native detail (input, output, diff) a client fetches when the item is opened. */
  readonly detail?: ContentRef;
  /**
   * Added by ADR-057 (optional, so no reader that does not know it changes). A transfer set it when the item's body (its text, a long list)
   * is longer than the transfer carries and was left out: the client fetches the item whole. A stored item never has it.
   */
  readonly bodyOmitted?: true;
  /** ADR-057: the size in bytes of the item's whole text, when the transfer carries none of it or a part. */
  readonly textBytes?: number;
}

export interface UserMessageItem extends ItemBase {
  readonly type: "user_message"; readonly messageId: MessageId;
  /** ADR-057: the message's text, carried by the item; absent where a client reads it by `messageId` from the conversation's messages (the form before the store kept items). */
  readonly text?: string;
}
/** `commentary`: said on the way; `final`: the Turn's answer. The text is the message's. */
export interface AssistantMessageItem extends ItemBase {
  readonly type: "assistant_message"; readonly messageId: MessageId; readonly phase: "commentary" | "final";
  /** ADR-057: the segment's text, carried by the item (see `UserMessageItem.text`). */
  readonly text?: string;
}
/** The thought is whole, however long it is. (`truncated`: written by Gateways before 2026-11-12 that cut it at 64 KiB; the page reads it and says nothing of it.) */
export interface ReasoningItem extends ItemBase { readonly type: "reasoning"; readonly text: string; readonly durationMs?: number; readonly truncated?: true }

/**
 * `command` is what ran, without the shell a Harness wrapped it in; `raw` is the native spelling when it differs. `command` is empty
 * when the native side has not said which command it ran (a DeepSeek Harness `bash` whose stored detail is not readable yet): the
 * client then says a command ran, and never shows an empty line.
 */
export interface CommandItem extends ItemBase { readonly type: "command"; readonly command: string; readonly raw?: string; readonly cwd?: string; readonly exitCode?: number; readonly background?: true }
export interface FileReadItem extends ItemBase { readonly type: "file_read"; readonly path: string | null; readonly range?: { readonly start: number; readonly end?: number } }
export const FILE_OPS = ["create", "modify", "delete", "rename"] as const;
export type FileOp = typeof FILE_OPS[number];
export interface FileChange { readonly path: string; readonly op: FileOp; readonly oldPath?: string; readonly added?: number; readonly removed?: number }
export interface FileChangeItem extends ItemBase { readonly type: "file_change"; readonly changes: readonly FileChange[] }
/** `files`: by name (glob, ls); `content`: inside files (grep). */
export interface SearchItem extends ItemBase { readonly type: "search"; readonly scope: "files" | "content" | "unknown"; readonly query: string | null; readonly path?: string; readonly matches?: number }
export interface WebItem extends ItemBase { readonly type: "web"; readonly action: "search" | "fetch"; readonly query?: string; readonly url?: string; readonly title?: string }
/** `hub`: one of the Hub's own tools (src/contracts/table.ts), which the interface names by what it does. */
export interface McpToolItem extends ItemBase { readonly type: "mcp_tool"; readonly server: string; readonly tool: string; readonly hub?: true }
/** The fallback: a native tool the vocabulary has no type for, shown by its own name and never dropped. */
export interface ToolItem extends ItemBase { readonly type: "tool"; readonly name: string }
export interface SubagentItem extends ItemBase { readonly type: "subagent"; readonly title: string }

export interface PlanStep { readonly text: string; readonly status: "pending" | "in_progress" | "completed"; /** ADR-057: the priority a Harness gave the step; the interface does not show it. */ readonly priority?: "high" | "medium" | "low" }
export interface PlanItem extends ItemBase { readonly type: "plan"; readonly steps: readonly PlanStep[]; readonly explanation?: string }
export interface PlanProposalItem extends ItemBase { readonly type: "plan_proposal"; readonly markdown: string }
export interface RecapItem extends ItemBase { readonly type: "recap"; readonly summary: string; readonly ask?: string; readonly actions?: readonly string[] }

export const APPROVAL_SUBJECTS = ["command", "file_change", "file_read", "network", "tool", "other"] as const;
export const APPROVAL_ROLES = ["allow_once", "allow_session", "allow_always", "deny", "other"] as const;
export type ApprovalRole = typeof APPROVAL_ROLES[number];
export interface ApprovalItem extends ItemBase {
  readonly type: "approval"; readonly subject: typeof APPROVAL_SUBJECTS[number]; readonly title: string;
  readonly options: readonly { readonly id: string; readonly role: ApprovalRole; readonly label: string }[];
  readonly decision?: { readonly role: ApprovalRole; readonly by: "user" | "policy" | "timeout" | "harness"; readonly at: number };
  /** ADR-057: the id of the action item the approval is about, when the Harness names the call. */
  readonly forItem?: string;
}
export interface QuestionItem extends ItemBase {
  readonly type: "question"; readonly title: string; readonly answer?: string;
  /** ADR-057: the answer is a secret (a key, a password): it is never stored, so `answer` is absent whatever was answered. */
  readonly secret?: true;
}

export interface NoticeItem extends ItemBase { readonly type: "notice"; readonly severity: "info" | "warning"; readonly code?: string; readonly text: string; readonly more?: string }
export const ERROR_CLASSES = ["auth", "quota", "rate_limit", "context_overflow", "network", "harness_crash", "permission", "invalid_request", "unknown"] as const;
export type ErrorClass = typeof ERROR_CLASSES[number];
export interface ErrorItem extends ItemBase { readonly type: "error"; readonly class: ErrorClass; readonly code?: string; readonly message: string }
export interface ContextEventItem extends ItemBase { readonly type: "context_event"; readonly kind: "compaction" | "clear" | "rewind" }
/**
 * The executor changed before this Turn, or stayed the same while this message still carried the conversation or went alone
 * though something was owed (then `from` and `to` are the same executor). `context` is what it was given: the whole conversation, what it had missed, the
 * same again, nothing but the user's words, or nothing needed (`native`: the native session it continues already holds the
 * conversation, as when the same Harness runs another model). `unknown`, in `context` and in `session`: the Turn carries no relay
 * facts (one from before the relay kept them), so what was brought and where it ran are not known; never read as `none` or `new`.
 */
export interface SwitchItem extends ItemBase {
  readonly type: "switch"; readonly from: Executor; readonly to: Executor;
  readonly context: "full" | "delta" | "resend" | "none" | "native" | "unknown"; readonly turns?: number;
  readonly session: "new" | "resumed" | "unknown"; readonly delivery?: "sending" | "confirmed" | "unconfirmed" | "not_sent"; readonly packetId?: string;
}
export interface InterruptItem extends ItemBase { readonly type: "interrupt"; readonly by: "user" | "hub" }
export interface DelegationItem extends ItemBase { readonly type: "delegation"; readonly to: Executor; readonly task: string }
export interface ArtifactItem extends ItemBase { readonly type: "artifact"; readonly kind: "file" | "image" | "link"; readonly name: string; readonly content?: ContentRef; readonly uri?: string }

export type WorkItem = CommandItem | FileReadItem | FileChangeItem | SearchItem | WebItem | McpToolItem | ToolItem | SubagentItem;
export type ProtocolItem = UserMessageItem | AssistantMessageItem | ReasoningItem | WorkItem | PlanItem | PlanProposalItem | RecapItem
  | ApprovalItem | QuestionItem | NoticeItem | ErrorItem | ContextEventItem | SwitchItem | InterruptItem | DelegationItem | ArtifactItem;

/** The levels the Hub names; a Harness offers only those its own settings enforce. */
export const PERMISSION_LEVELS = ["plan", "ask", "auto_edit", "auto", "full"] as const;
export type PermissionLevel = typeof PERMISSION_LEVELS[number];
export const EFFORT_LEVELS = ["off", "low", "medium", "high", "max"] as const;
export type EffortLevel = typeof EFFORT_LEVELS[number];

/** A model as the interface shows it: `label` is the Hub's display name, `id` the native identity. */
export interface ModelRef { readonly id: string; readonly label: string; readonly vendor?: string }
/** Who ran a Turn. `harness` is the display name; a model is absent when the Harness chose its own default and did not say which. */
export interface Executor { readonly harnessId: string; readonly harness: string; readonly model?: ModelRef; readonly effort?: EffortLevel; readonly permission?: PermissionLevel }

/**
 * A Turn's usage in one meaning for every Harness: `input` is everything the Turn's model requests read, cached part included
 * (`cachedInput` of it came from the cache); `output` is everything generated, reasoning included. `completeness` says whether
 * the numbers cover the Turn: a client shows no number it does not have, and never a zero in its place.
 *  - `complete`: `input` and `output` are both there and cover the whole Turn.
 *  - `partial`: numbers are there but may cover less than the Turn (the Turn did not end normally, so the last request may be missing,
 *    or only one of the two was reported); a client shows none of them as the Turn's total.
 *  - `unavailable`: the Harness reports no token numbers a Turn can be told by (a DeepSeek Harness reports only its context window;
 *    a Hermes report is its session's running total, which is not a Turn's). `input`, `cachedInput` and `output` are then absent;
 *    `context` and `cost` may still be there.
 * `cost.scope`: `turn` is this Turn's; `session` is the running total of the native session the Turn ran in (what most Harnesses
 * report), which is not the whole conversation when it has run in other native sessions or on other Harnesses; `conversation` is
 * reserved for a total the Hub itself keeps.
 */
export interface TurnUsage {
  readonly completeness: "complete" | "partial" | "unavailable";
  readonly input?: number; readonly cachedInput?: number; readonly output?: number;
  readonly context?: { readonly used: number; readonly size?: number };
  readonly cost?: { readonly amount: number; readonly currency: string; readonly scope: "turn" | "session" | "conversation" };
}

export const TURN_STATUSES = ["queued", "preparing", "running", "waiting", "completed", "failed", "cancelled", "unknown"] as const;
export type TurnStatus = typeof TURN_STATUSES[number];
export const STOP_REASONS = ["end_turn", "user_stopped", "max_tokens", "max_steps", "refusal", "budget", "cleared", "error", "unknown"] as const;
export type StopReason = typeof STOP_REASONS[number];

/** One Turn as a client reads it. `n` counts from 1 in conversation order, the number a handoff and the Hub's tools give it. */
export interface ProtocolTurn {
  readonly version: typeof PROTOCOL_VERSION;
  readonly runId: RunId;
  readonly n: number;
  readonly status: TurnStatus;
  readonly stopReason?: StopReason;
  readonly executor: Executor;
  readonly usage: TurnUsage;
  readonly startedAt?: number;
  readonly durationMs?: number;
  /** ADR-057: the items are in the fixed order a Turn from before the store kept item order is drawn in, not in the order things happened. */
  readonly legacyOrder?: true;
  readonly items: readonly ProtocolItem[];
}
