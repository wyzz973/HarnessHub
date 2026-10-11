import { ArrowUpRight, GitBranch } from "lucide-react";
import type { SessionOrigin } from "../../../src/contracts/session.js";
import type { HarnessView, SessionView } from "../../../src/contracts/web.js";
import { MessageAttachments } from "./Attachments.js";
import { StreamingMarkdown } from "./StreamingMarkdown.js";

/** How the branch continues natively, stated from the committed native state rather than assumed. */
function nativeNote(session: SessionView): string {
  const state = session.nativeStates?.find(item => item.harnessId === session.selection.harnessId && item.controlId === session.selection.controlId);
  if (state?.status === "forking") return "正在为分支建立原生会话副本，完成后再处理新消息。";
  if (state?.status === "ready") return "原生会话已分支：新消息在原生副本中继续，原对话不受影响。";
  if (state?.status === "unconfirmed") return "原生分支结果尚未确认；可在高级配置中重新建立原生会话。";
  return "这个分支以公共历史继续：下一条消息会带上下面的对话。";
}

/** The quoted history a branch started from, shown before its own messages and never sent again as new input. */
export function BranchOrigin({ origin, session, harnesses, onOpenSource }: { origin: SessionOrigin; session: SessionView; harnesses: readonly HarnessView[]; onOpenSource: ((id: string) => void) | undefined }) {
  const name = (id: string | undefined) => harnesses.find(row => row.id === id)?.name ?? id ?? "Harness";
  return <section className="branch-origin" aria-label="分支来源">
    <header>
      <GitBranch size={14} aria-hidden="true"/>
      <strong>分支自之前的对话</strong>
      <small>{origin.history.length} 条消息</small>
      {onOpenSource ? <button type="button" className="text-button" onClick={() => onOpenSource(origin.sessionId)}>打开原对话 <ArrowUpRight size={12} aria-hidden="true"/></button> : null}
    </header>
    <p className="branch-native" role="status">{nativeNote(session)}</p>
    <details>
      <summary>查看分支前的对话</summary>
      <ol className="branch-history">{origin.history.map((message, index) => <li key={index} className={`branch-message is-${message.role}`}>
        <span className="branch-role">{message.role === "user" ? "你" : name(message.harnessId)}</span>
        {message.attachments?.length ? <MessageAttachments attachments={message.attachments}/> : null}
        {message.role === "user" ? <p>{message.text}</p> : <StreamingMarkdown text={message.text} isStreaming={false}/>}
      </li>)}</ol>
    </details>
  </section>;
}
