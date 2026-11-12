import { CircleDashed, PencilLine } from "lucide-react";
import { memo, useLayoutEffect, useState } from "react";
import type { ReactNode } from "react";
import type { PublicMessage, PublicRun } from "../../../src/contracts/session.js";
import { cn } from "../lib/cn.js";
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

/** Your message: a light grey bubble on the right of the reading column (Conversation board), with the way to edit it again. */
export const UserMessage = memo(function UserMessage({ message, run, onEdit }: {
  readonly message: PublicMessage; readonly run: PublicRun | undefined; readonly onEdit: (text: string) => void;
}) {
  // Whether it rises into place (Motion board #15) is the conversation's call: ChatPage wraps a message that arrived after
  // the conversation opened, so a message never rises twice and history never moves.
  return <article className="message user-message group flex flex-col items-end gap-1.5">
    {run?.attachments?.length ? <MessageAttachments attachments={run.attachments}/> : null}
    <div className="flex w-full min-w-0 items-end justify-end gap-1">
      <div className="flex h-7 flex-none items-center transition-opacity duration-150 [@media(hover:hover)]:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
        <ActionButton label="放回输入框" onClick={() => onEdit(message.text)}><PencilLine size={14}/></ActionButton>
      </div>
      <div className="max-w-[82%] min-w-0 rounded-[18px] bg-subtle px-[15px] py-2.5 text-reading leading-6 whitespace-pre-wrap break-words text-fg"><span className="sr-only">你：</span>{message.text}</div>
    </div>
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
