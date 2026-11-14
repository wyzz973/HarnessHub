import type { Conversation, ConversationReader } from "../contracts/conversation.js";
import type { RunId, SessionId } from "../contracts/session.js";
import { turnSource } from "../contexts/session/domain/turn-source.js";

/**
 * One conversation of a task (2026-11-13). A task is a conversation and everything it delegated, however deep: what several Harnesses do
 * for one piece of work. Each member is told by a short label (stable, made from its identity) so that a Harness can name another
 * conversation of its task to the Hub's tools without knowing an identity.
 */
export interface TaskMember {
  readonly sessionId: SessionId;
  /** `c-` and six characters of the conversation's identity: what the tools take as `conversation`. */
  readonly label: string;
  /** The conversation that delegated this one its work; null for the one the task began in. */
  readonly parent: string | null;
  readonly depth: number;
  readonly harnessId: string; readonly harness: string;
  /** What it was asked: the first words of the user (for a delegated conversation, the task). */
  readonly task: string;
  /** How its latest Turn stands: `running` while one goes on, `empty` before any. */
  readonly status: "running" | "completed" | "failed" | "cancelled" | "unknown" | "empty";
  readonly turns: number;
  /** What its latest finished Turn replied, cut short. */
  readonly reply: string;
  /** The files its Turns changed (the Hub's own record of the workspace where it has one, else what its Harness reported), in the order first changed. */
  readonly files: readonly string[];
  /** Delegated by the Harness of its parent (the Hub's tool), not by the user. */
  readonly by?: "harness";
}

/** What the family is read from: the store, as the web layer holds it. */
export interface FamilyStore extends Pick<ConversationReader, "head" | "turnAt" | "runOrdinal"> {
  get(id: SessionId): Conversation;
  delegatedBy?(id: SessionId): readonly SessionId[];
  edits(id: SessionId): readonly { readonly runId: RunId; readonly seq: number }[];
  item(runId: RunId, seq: number): { readonly fields: unknown } | null;
}

export const taskLabel = (id: SessionId): string => "c-" + id.replace(/^session-/u, "").replace(/-/gu, "").slice(0, 6);
const clip = (text: string, most: number): string => { const flat = text.replace(/\s+/gu, " ").trim(), units = [...flat]; return units.length > most ? units.slice(0, most).join("") + "…" : flat; };

/** The files a conversation's Turns changed, from its edit items (the Hub's record of the workspace, and its Harness's own edits). */
function filesOf(store: FamilyStore, id: SessionId): string[] {
  const files: string[] = [];
  try {
    for (const place of store.edits(id)) {
      const changes = (store.item(place.runId, place.seq)?.fields as { readonly changes?: readonly { readonly path?: unknown }[] } | undefined)?.changes ?? [];
      for (const change of changes) if (typeof change.path === "string" && change.path !== "" && !files.includes(change.path)) files.push(change.path);
    }
  } catch { /* what cannot be read now is left out */ }
  return files;
}

/**
 * The task a conversation belongs to, as its members: the conversation it began in first, then each delegated one under the one that
 * delegated it, oldest first. A conversation that cannot be read is left out, and what it delegated takes its place.
 */
export function taskFamily(store: FamilyStore, id: SessionId, name: (harnessId: string) => string | null): readonly TaskMember[] {
  // Up to where the task began (a chain is short; the bound is against a ring).
  let root = id;
  for (let hops = 0; hops < 16; hops++) { let parent: SessionId | undefined; try { parent = store.get(root).delegation?.parentId; } catch { parent = undefined; } if (parent === undefined) break; root = parent; }
  const members: TaskMember[] = [], seen = new Set<SessionId>();
  const visit = (at: SessionId, parent: SessionId | null, depth: number): void => {
    if (seen.has(at) || members.length >= 64) return;
    seen.add(at);
    let conversation: Conversation;
    // One that is not there (the user erased where the task began, 2026-11-14) leaves its place to what it delegated: the task goes on without it.
    try { conversation = store.get(at); } catch { for (const child of store.delegatedBy?.(at) ?? []) visit(child, parent, depth); return; }
    const last = conversation.runs.at(-1), harnessId = (last ?? conversation).selection.harnessId;
    let task = "", reply = "";
    try {
      const turns = turnSource(store, at);
      task = turns.turn(0)?.user.text ?? "";
      for (let ordinal = conversation.runs.length - 1; ordinal >= 0 && reply === ""; ordinal--) reply = turns.turn(ordinal)?.assistant?.text ?? "";
    } catch { /* told without its words */ }
    const status: TaskMember["status"] = last === undefined ? "empty" : last.status === "completed" || last.status === "failed" || last.status === "cancelled" ? last.status : last.status === "unknown" ? "unknown" : "running";
    members.push({ sessionId: at, label: taskLabel(at), parent: parent === null ? null : taskLabel(parent), depth, harnessId, harness: name(harnessId) ?? harnessId, task: clip(task, 300), status,
      turns: conversation.runs.length, reply: clip(reply, 400), files: filesOf(store, at).slice(0, 40), ...(conversation.delegation?.by === "harness" ? { by: "harness" as const } : {}) });
    for (const child of store.delegatedBy?.(at) ?? []) visit(child, at, depth + 1);
  };
  visit(root, null, 0);
  return members;
}
