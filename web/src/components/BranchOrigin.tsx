import { ArrowUpRight, ChevronRight, GitBranch, History } from "lucide-react";
import { useId, useState } from "react";
import type { SessionOrigin } from "../../../src/contracts/session.js";
import type { HarnessView } from "../../../src/contracts/web.js";
import type { ConversationView } from "../lib/conversation.js";
import { cn } from "../lib/cn.js";
import { Collapsible } from "../ui/motion.js";
import { MessageAttachments } from "./Attachments.js";
import { BrandIcon } from "./BrandIcon.js";
import { StreamingMarkdown } from "./StreamingMarkdown.js";

/** How the conversation continues natively, stated from the committed native state rather than assumed. */
function nativeNote(session: ConversationView, origin: SessionOrigin): string {
  const state = session.nativeStates?.find(item => item.harnessId === session.selection.harnessId && item.controlId === session.selection.controlId);
  if (origin.kind === "import") {
    if (state?.status === "ready") return "新消息直接发给这个本机会话，它记得自己的全部历史；请不要同时在原程序中继续它。";
    if (state?.status === "unconfirmed") return "本机会话的状态尚未确认；可在 Harness 选择器（⌘J）底部的“高级配置…”中重新建立原生会话。";
    return "这个对话不再使用原来的本机会话：下一条消息会带上下面引用的历史。";
  }
  if (state?.status === "forking") return "正在为分支建立原生会话副本，完成后再处理新消息。";
  if (state?.status === "ready") return "原生会话已分支：新消息在原生副本中继续，原对话不受影响。";
  if (state?.status === "unconfirmed") return "原生分支结果尚未确认；可在 Harness 选择器（⌘J）底部的“高级配置…”中重新建立原生会话。";
  return "这个分支以公共历史继续：下一条消息会带上下面的对话。";
}

/**
 * The quoted history a branch started from, shown before its own messages and never sent again as new input: a quiet card
 * that says where the conversation came from and how it continues natively, with the history behind one disclosure.
 */
export function BranchOrigin({ origin, session, harnesses, onOpenSource }: { origin: SessionOrigin; session: ConversationView; harnesses: readonly HarnessView[]; onOpenSource: ((id: string) => void) | undefined }) {
  const [open, setOpen] = useState(false);
  const history = useId();
  const name = (id: string | undefined) => harnesses.find(row => row.id === id)?.name ?? id ?? "Harness";
  const imported = origin.kind === "import" ? origin : null;
  const earlier = imported && (imported.omitted > 0 || !imported.complete) ? imported.historyRead ? "更早的历史只保留在原程序中" : "原程序没有提供历史" : null;
  return <section className="branch-origin flex flex-col gap-2 rounded-card bg-surface px-4 py-3 shadow-hairline" aria-label={imported ? "接续来源" : "分支来源"}>
    <header className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-ui-sm">
      <span className="flex text-fg-3">{imported ? <BrandIcon brand={imported.harnessId} name={name(imported.harnessId)} size={18}/> : <GitBranch size={16} aria-hidden="true"/>}</span>
      <strong className="min-w-0 font-semibold text-fg">{imported ? "接续本机 " + name(imported.harnessId) + " 会话" + (imported.title ? "「" + imported.title + "」" : "") : "分支自之前的对话"}</strong>
      <small className="text-caption text-fg-3">{origin.kind === "fork" && origin.history.length === 0 ? "分支前的对话在原对话里" : origin.history.length + " 条消息"}{earlier ? " · " + earlier : ""}</small>
      <span className="flex-1"/>
      {origin.kind === "fork" && onOpenSource ? <button type="button" className="link-btn inline-flex items-center gap-1 text-caption" onClick={() => onOpenSource(origin.sessionId)}>打开原对话 <ArrowUpRight size={12} aria-hidden="true"/></button> : null}
    </header>
    <p className="m-0 text-ui-sm text-fg-2" role="status">{nativeNote(session, origin)}</p>
    {origin.history.length ? <div className="flex flex-col">
      <button type="button" aria-expanded={open} aria-controls={history} onClick={() => setOpen(value => !value)} className="row -ml-1.5 flex h-7 items-center gap-1.5 self-start border-none bg-transparent px-1.5 text-ui-sm text-fg-2 hover:bg-subtle">
        {imported ? <History size={14} className="text-fg-3" aria-hidden="true"/> : null}{imported ? "查看本机会话的历史" : "查看分支前的对话"}
        <ChevronRight size={12} strokeWidth={2.2} className={cn("text-fg-3 motion-rotate", open && "rotate-90")} aria-hidden="true"/>
      </button>
      <Collapsible open={open} id={history}><ol className="m-0 mt-2 ml-1 flex list-none flex-col gap-3 border-l border-line-strong p-0 pl-3.5">{origin.history.map((message, index) => <li key={index} className="flex min-w-0 flex-col gap-1">
        <span className="text-caption font-medium text-fg-3">{message.role === "user" ? "你" : name(message.harnessId)}</span>
        {message.attachments?.length ? <MessageAttachments attachments={message.attachments} align="start"/> : null}
        {message.role === "user" ? <p className="m-0 whitespace-pre-wrap break-words text-ui-sm">{message.text}</p> : <StreamingMarkdown text={message.text} isStreaming={false} className="text-ui-sm"/>}
      </li>)}</ol></Collapsible>
    </div> : null}
  </section>;
}
