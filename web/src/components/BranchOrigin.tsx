import { ArrowUpRight, GitBranch, History } from "lucide-react";
import type { SessionOrigin } from "../../../src/contracts/session.js";
import type { HarnessView, SessionView } from "../../../src/contracts/web.js";
import { MessageAttachments } from "./Attachments.js";
import { StreamingMarkdown } from "./StreamingMarkdown.js";

/** How the conversation continues natively, stated from the committed native state rather than assumed. */
function nativeNote(session: SessionView, origin: SessionOrigin): string {
  const state = session.nativeStates?.find(item => item.harnessId === session.selection.harnessId && item.controlId === session.selection.controlId);
  if (origin.kind === "import") {
    if (state?.status === "ready") return "新消息直接发给这个本机会话，它记得自己的全部历史；请不要同时在原程序中继续它。";
    if (state?.status === "unconfirmed") return "本机会话的状态尚未确认；可在高级配置中重新建立原生会话。";
    return "这个对话不再使用原来的本机会话：下一条消息会带上下面引用的历史。";
  }
  if (state?.status === "forking") return "正在为分支建立原生会话副本，完成后再处理新消息。";
  if (state?.status === "ready") return "原生会话已分支：新消息在原生副本中继续，原对话不受影响。";
  if (state?.status === "unconfirmed") return "原生分支结果尚未确认；可在高级配置中重新建立原生会话。";
  return "这个分支以公共历史继续：下一条消息会带上下面的对话。";
}

/** The quoted history a branch started from, shown before its own messages and never sent again as new input. */
export function BranchOrigin({ origin, session, harnesses, onOpenSource }: { origin: SessionOrigin; session: SessionView; harnesses: readonly HarnessView[]; onOpenSource: ((id: string) => void) | undefined }) {
  const name = (id: string | undefined) => harnesses.find(row => row.id === id)?.name ?? id ?? "Harness";
  const imported = origin.kind === "import" ? origin : null;
  const earlier = imported && (imported.omitted > 0 || !imported.complete) ? imported.historyRead ? "更早的历史只保留在原程序中" : "原程序没有提供历史" : null;
  return <section className="branch-origin" aria-label={imported ? "接续来源" : "分支来源"}>
    <header>
      {imported ? <History size={14} aria-hidden="true"/> : <GitBranch size={14} aria-hidden="true"/>}
      <strong>{imported ? "接续本机 " + name(imported.harnessId) + " 会话" + (imported.title ? "「" + imported.title + "」" : "") : "分支自之前的对话"}</strong>
      <small>{origin.history.length} 条消息{earlier ? " · " + earlier : ""}</small>
      {origin.kind === "fork" && onOpenSource ? <button type="button" className="text-button" onClick={() => onOpenSource(origin.sessionId)}>打开原对话 <ArrowUpRight size={12} aria-hidden="true"/></button> : null}
    </header>
    <p className="branch-native" role="status">{nativeNote(session, origin)}</p>
    {origin.history.length ? <details>
      <summary>{imported ? "查看本机会话的历史" : "查看分支前的对话"}</summary>
      <ol className="branch-history">{origin.history.map((message, index) => <li key={index} className={`branch-message is-${message.role}`}>
        <span className="branch-role">{message.role === "user" ? "你" : name(message.harnessId)}</span>
        {message.attachments?.length ? <MessageAttachments attachments={message.attachments}/> : null}
        {message.role === "user" ? <p>{message.text}</p> : <StreamingMarkdown text={message.text} isStreaming={false}/>}
      </li>)}</ol>
    </details> : null}
  </section>;
}
