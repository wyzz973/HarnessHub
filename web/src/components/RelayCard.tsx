import { ArrowRightLeft, Eraser } from "lucide-react";
import { cn } from "../lib/cn.js";
import { compact } from "../lib/format.js";
import type { ChoiceView, RelayLine } from "../lib/relay-state.js";
import type { RelayOption } from "../relay.js";
import { Badge, Notice } from "../ui/primitives.js";
import { RelayIntro } from "./RelayConsent.js";

/** What the next message does about the history, when the user chose something other than the default: the one-shot choices. */
export type RelayNext = "none" | "full" | null;

const LINE = "relay-card motion-fade-in flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-block bg-subtle py-1.5 pr-1.5 pl-3 text-ui-sm";
const TOGGLE = "btn btn-ghost btn-sm flex-none aria-pressed:bg-accent-soft aria-pressed:text-accent-text";

/**
 * The one line above the message box that is about the history (relay-architecture §12.1 T2, T7), quiet and out of the way:
 *  - a refused send waiting for the user's choice: what the Gateway said, and a button for each way forward; the draft stays;
 *  - after the original session's context was cleared: that the next message carries no history, with the way to attach it;
 *  - when something is owed to the Harness the conversation is on: what will be handed over, and the way to send without it.
 * Nothing is asked by default: the first two appear only when something is wrong or was done, the third only informs.
 * `target` is the name of the Harness the conversation is on.
 */
export function RelayCard({ line, choice, target, next, onNext, onChoose, onDismissChoice, busy, canSend, intro }: {
  readonly line: RelayLine | null; readonly choice: ChoiceView | null; readonly target: string; readonly next: RelayNext; readonly onNext: (next: RelayNext) => void;
  readonly onChoose: (option: RelayOption) => void; readonly onDismissChoice: () => void; readonly busy: boolean; readonly canSend: boolean;
  /** Set while the one-time note is still to be shown; the function says it was read. */
  readonly intro: (() => void) | null;
}) {
  if (choice !== null) {
    return <Notice tone="amber" className="relay-choice" title={choice.title} onDismiss={onDismissChoice}
      action={choice.actions.map(action => <button key={action.option} type="button" data-option={action.option} className={cn("btn btn-sm", action.primary && "btn-primary")}
        disabled={busy || !canSend || (action.option === "acknowledge" && action.title !== undefined)} title={action.title ?? (canSend ? undefined : "先写下要发的内容")} onClick={() => onChoose(action.option)}>{action.label}</button>)}>
      {choice.text}
    </Notice>;
  }
  if (line === null) return null;
  if (line.kind === "clear_pending") {
    return <div className={LINE} role="status" data-relay="clear_pending"><Eraser size={15} className="flex-none text-fg-3" aria-hidden="true"/>
      <span className="min-w-0 flex-1 py-0.5"><strong className="font-semibold">{target}</strong> 的上下文清空待确认 · 下一条消息发出前会核对</span></div>;
  }
  if (line.kind === "cleared") {
    const full = next === "full";
    return <div className={LINE} role="status" data-relay="cleared"><Eraser size={15} className="flex-none text-fg-3" aria-hidden="true"/>
      <span className="min-w-0 flex-1 py-0.5">{full ? "下一条会附上之前对话的交接单" : <><strong className="font-semibold">{target}</strong> 的上下文已清空 · 下一条不附历史</>}</span>
      <button type="button" className={TOGGLE} aria-pressed={full} onClick={() => onNext(full ? null : "full")}>附上交接单</button></div>;
  }
  const alone = next === "none";
  return <>
    <div className={LINE} role="status" data-relay="owed"><ArrowRightLeft size={15} className="flex-none text-fg-3" aria-hidden="true"/>
      <span className="min-w-0 flex-1 py-0.5">{alone ? <>这条消息不附交接单，<strong className="font-semibold">{target}</strong> 看不到之前的 {line.runs} 轮</>
        : <>将交给 <strong className="font-semibold">{target}</strong>：{line.runs} 轮{line.tokens === null ? "" : ` · 约 ${compact(line.tokens)} tokens`}</>}
        {line.unverified ? <Badge className="ml-2" title="这个 Harness 的接力还没有在真机上验证过；交接单照常发出，结果如实标注。">未经真机验证</Badge> : null}</span>
      <button type="button" className={TOGGLE} aria-pressed={alone} onClick={() => onNext(alone ? null : "none")}>只发这条消息</button>
    </div>
    {intro === null || alone ? null : <RelayIntro target={target} onDismiss={intro}/>}
  </>;
}
