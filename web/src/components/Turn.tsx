import { ChevronLeft, ChevronRight, CircleDashed, Pencil, PencilLine } from "lucide-react";
import { memo, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { PublicMessage, PublicRun } from "../../../src/contracts/session.js";
import { cn } from "../lib/cn.js";
import { messageTime } from "../lib/format.js";
import { noteMount } from "../lib/turn.js";
import type { LiveStatus, QueueNotice } from "../lib/protocol/live.js";
import { Spinner, StatusDot, Tip } from "../ui/primitives.js";
import { MessageAttachments } from "./Attachments.js";

/*
 * The small parts a Turn is made of that the protocol Turn (ProtocolTurn.tsx) shares with the rest of the page: whether something
 * entering is news, the symbol of a state, the buttons under a reply, your message and the explanation of a queued Turn.
 */

/**
 * Whether this element is news (ADR-054 §3: motion only says what happened). Decided once, before the first paint: things
 * drawn with the rest of a page stay still; a Turn just started and a hand-over just made come in. (A message of yours
 * rises by the conversation's own rule, ChatPage's, which knows what arrived after it opened.)
 */
export function useEntrance(fresh: boolean): boolean {
  const [entering, setEntering] = useState(false);
  useLayoutEffect(() => { if (noteMount(fresh)) setEntering(true); }, []);
  return entering;
}
/**
 * The symbol of a state (Icons board), 15 px: the arc while working, dashed before it starts, and a still grey dot while
 * the Turn waits for you: for an approval whatever its step (ruling J), for a question with no step in progress (decision
 * F). The amber of waiting belongs to the Turn's one marker line.
 */
export function LiveIcon({ tone, className }: { readonly tone: LiveStatus["tone"]; readonly className?: string | undefined }) {
  return <span className={cn("flex size-[15px] flex-none items-center justify-center", className)}>
    {tone === "run" ? <Spinner size={15} tone="run" label=""/> : tone === "wait" ? <StatusDot tone="idle"/> : <CircleDashed size={15} className="text-fg-3" aria-hidden="true"/>}
  </span>;
}
export function ActionButton({ label, onClick, children, pressed }: { readonly label: string; readonly onClick: () => void; readonly children: ReactNode; readonly pressed?: boolean }) {
  return <Tip label={label} side="bottom"><button type="button" className="icon-btn message-action size-7 text-fg-3" aria-label={label} {...(pressed === undefined ? {} : { "aria-pressed": pressed })} onClick={onClick}>{children}</button></Tip>;
}

/** Where a Turn stands among the alternatives of its place (its message edited and sent again, its reply tried again). */
export interface TurnBranchView { readonly n: number; readonly of: number; readonly prev: string | null; readonly next: string | null }
/** What a message of yours can do on its branch: send it again edited, move among the alternatives. `busy`: a Turn goes on, and neither is taken now (said, not hidden). */
export interface UserMessageBranching {
  readonly branch?: TurnBranchView | undefined;
  readonly onResend?: ((text: string) => void) | undefined;
  readonly onSelectBranch?: ((runId: string) => void) | undefined;
  readonly busy?: boolean;
}
const BUSY = "回合进行中：等这一轮结束或先停止它，再改发或切换分支";

/**
 * Your message: a light grey bubble on the right of the reading column (Conversation board), with the way to edit it again and — when pointed at — when it was sent.
 * A long one (pasted material) shows its start and opens whole when asked, so the answer under it is not a screen away (both after T3 Code).
 */
export const UserMessage = memo(function UserMessage({ message, run, onEdit, branching, steered }: {
  readonly message: PublicMessage; readonly run: PublicRun | undefined; readonly onEdit: (text: string) => void; readonly branching?: UserMessageBranching | undefined;
  /**
   * Words the user gave a Turn while it ran (2026-11-14): they stand where the Harness took them, when they were said, and say what became of them while that is not
   * plain — being given to it, or not known to have reached it, or not given because the Turn stopped first. They have no attachments and no branch of their own.
   */
  readonly steered?: { readonly status: string; readonly at?: number | undefined } | undefined;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const branch = branching?.branch, busy = branching?.busy === true;
  const bubble = useRef<HTMLDivElement>(null), [long, setLong] = useState(false), [whole, setWhole] = useState(false);
  useLayoutEffect(() => { const element = bubble.current; if (element !== null) setLong(element.scrollHeight > 352); }, [message.text, editing === null]);
  const sent = steered !== undefined ? steered.at : run?.timing?.acceptedAt;
  const note = steered === undefined ? null : steered.status === "pending" || steered.status === "running" ? "正在告诉它…" : steered.status === "unknown" ? "不确定它收到没有"
    : steered.status === "cancelled" || steered.status === "failed" ? "这一轮先停了，没交给它" : null;
  // Whether it rises into place (Motion board #15) is the conversation's call: ChatPage wraps a message that arrived after
  // the conversation opened, so a message never rises twice and history never moves.
  if (editing !== null && branching?.onResend) {
    const send = () => { const text = editing.trim(); if (text === "" || busy) return; branching.onResend!(editing); setEditing(null); };
    return <article className="message user-message flex flex-col items-end gap-1.5" aria-label="改发这条消息">
      <div className="flex w-full max-w-[85%] min-w-0 flex-col gap-2 rounded-card bg-subtle px-3 py-2">
        <textarea className="branch-edit min-h-20 w-full resize-y bg-transparent text-reading leading-6 text-fg outline-none" aria-label="改发的内容" autoFocus value={editing}
          onChange={event => setEditing(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); send(); } else if (event.key === "Escape") setEditing(null); }}/>
        <div className="flex items-center justify-end gap-2">
          <small className="mr-auto text-caption text-fg-3">{busy ? BUSY : "从这里开一个分支重发，原来的回合留在另一个分支上"}</small>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(null)}>取消</button>
          <button type="button" className="btn btn-primary btn-sm branch-send" disabled={busy || editing.trim() === ""} onClick={send}>发送</button>
        </div>
      </div>
    </article>;
  }
  return <article className="message user-message group flex flex-col items-end gap-1.5">
    {steered === undefined && run?.attachments?.length ? <MessageAttachments attachments={run.attachments}/> : null}
    <div className="flex w-full min-w-0 items-end justify-end gap-1">
      <div className="flex h-7 flex-none items-center transition-opacity duration-150 [@media(hover:hover)]:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
        {/* Drawn from an attribute: when it was sent is beside the message, not part of its words (a selection or a copy takes the message alone). */}
        {sent !== undefined ? <time className="message-time mr-1.5 text-caption whitespace-nowrap text-fg-3 tabular-nums" dateTime={new Date(sent).toISOString()} title={new Date(sent).toLocaleString()} data-time={messageTime(sent)}/> : null}
        <ActionButton label="放回输入框" onClick={() => onEdit(message.text)}><PencilLine size={14}/></ActionButton>
        {branching?.onResend ? <ActionButton label={busy ? BUSY : "编辑并重发"} onClick={() => { if (!busy) setEditing(message.text); }}><Pencil size={14}/></ActionButton> : null}
      </div>
      <div ref={bubble} className={cn("user-bubble max-w-[85%] min-w-0 rounded-card bg-subtle px-3 py-2 text-reading whitespace-pre-wrap break-words text-fg transition-colors hover:bg-hover",
        long && !whole && "max-h-[264px] overflow-hidden [mask-image:linear-gradient(#000_calc(100%-64px),transparent)]")} {...(long ? { "data-long": whole ? "whole" : "cut" } : {})}><span className="sr-only">你：</span>{message.text}</div>
    </div>
    {long ? <button type="button" className="link-btn -mt-0.5 text-caption" aria-expanded={whole} onClick={() => setWhole(value => !value)}>{whole ? "收起" : "显示全部"}</button> : null}
    {note !== null ? <span className="steer-note -mt-0.5 text-caption text-fg-3" role="status">{note}</span> : null}
    {branch !== undefined ? <div className="branch-nav flex items-center gap-0.5 text-caption text-fg-3" role="group" aria-label={"第 " + branch.n + " 个分支，共 " + branch.of + " 个"}>
      <Tip label={busy ? BUSY : "上一个分支"} side="bottom"><button type="button" className="icon-btn size-6" aria-label="上一个分支" disabled={branch.prev === null || busy || !branching?.onSelectBranch}
        onClick={() => { if (branch.prev !== null) branching?.onSelectBranch?.(branch.prev); }}><ChevronLeft size={14}/></button></Tip>
      <span className="tabular-nums">{branch.n}/{branch.of}</span>
      <Tip label={busy ? BUSY : "下一个分支"} side="bottom"><button type="button" className="icon-btn size-6" aria-label="下一个分支" disabled={branch.next === null || busy || !branching?.onSelectBranch}
        onClick={() => { if (branch.next !== null) branching?.onSelectBranch?.(branch.next); }}><ChevronRight size={14}/></button></Tip>
    </div> : null}
  </article>;
});

/**
 * The actions of a queued Turn: it waits for a slot, which has no deadline of its own, and may be cancelled.
 */
export function QueuedTurn({ queue }: { readonly queue: QueueNotice }) {
  return <div className="queued-turn -mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 pl-[22px] text-caption text-fg-3">
    <small className="text-caption" title="同时执行的对话数设了上限；排在前面的回合结束，位置就会空出来。">没有单独的等待期限，按发送先后轮到。</small>
    {queue.onCancel ? <button type="button" className="link-btn text-caption" disabled={queue.cancelling} onClick={queue.onCancel}>{queue.cancelling ? "正在取消…" : "取消排队"}</button> : null}
  </div>;
}
