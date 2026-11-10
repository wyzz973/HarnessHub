import { ArrowRightLeft, Eraser, Info, X } from "lucide-react";
import { cn } from "../lib/cn.js";
import { compact } from "../lib/format.js";
import { vendorWords, type BannerView, type ChoiceView, type InstallationView, type RelayLine } from "../lib/relay-state.js";
import type { RelayOption, RelayRequest } from "../relay.js";
import { Badge, Notice } from "../ui/primitives.js";

/**
 * What the user chose for the next message alone, and where it was offered (`for`: the line, or the banner's episode): a choice
 * is only meaningful where its words are shown, so it is put away when they go. `option` names the button that holds it, so a
 * second press lets go of it.
 */
export interface RelayNext { readonly request: RelayRequest; readonly for: string; readonly option: string }

const LINE = "relay-card motion-fade-in flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-block bg-subtle py-1.5 pr-1.5 pl-3 text-ui-sm";
const TOGGLE = "btn btn-ghost btn-sm flex-none aria-pressed:bg-accent-soft aria-pressed:text-accent-text";

/** The next message's choice that sends it without the history, offered where something is owed. */
export const SEND_ALONE: RelayNext = { request: { attach: "none" }, for: "owed", option: "none" };
/** The next message's choice that gives the history back after a clear, offered where the context was cleared. */
export const SEND_HISTORY: RelayNext = { request: { attach: "full" }, for: "cleared", option: "full" };

/**
 * The one line above the message box that is about the history (relay-architecture §12.1 T2, T7), quiet and out of the way:
 *  - a refused send waiting for the user's choice (the strict settings): what the Gateway said, and a button for each way forward;
 *    the draft stays;
 *  - what a binding asks the user to look at (a delivery nothing confirmed, a history that could not be checked, a clear not
 *    confirmed, a record that could not be recovered): said once, with the ways to settle it, each a choice for the next message; the
 *    next message goes whatever it says, and a closed one of the same episode does not come back;
 *  - after the original session's context was cleared: that the next message carries no history, with the way to attach it;
 *  - when something is owed to the Harness the conversation is on: what will be handed over, and the way to send without it; the first
 *    time a Harness takes the history it also says where it goes and where to change that (nothing to press, and it goes away
 *    with the message).
 * Nothing is asked by default: the choice and the banner appear only when something was done or is in doubt, the line only informs.
 * `target` is the name of the Harness the conversation is on.
 */
export function RelayCard({ line, choice, banner, target, next, onNext, onChoose, onDismissChoice, onDismissBanner, busy, canSend, intro }: {
  readonly line: RelayLine | null; readonly choice: ChoiceView | null; readonly banner: BannerView | null; readonly target: string;
  readonly next: RelayNext | null; readonly onNext: (next: RelayNext | null) => void;
  readonly onChoose: (option: RelayOption) => void; readonly onDismissChoice: () => void; readonly onDismissBanner: () => void; readonly busy: boolean; readonly canSend: boolean;
  /** The first hand-over to this Harness is about to be sent: the line says where the history goes. */
  readonly intro: boolean;
}) {
  if (choice !== null) {
    return <Notice tone="amber" className="relay-choice" title={choice.title} onDismiss={onDismissChoice}
      action={choice.actions.map(action => <button key={action.option} type="button" data-option={action.option} className={cn("btn btn-sm", action.primary && "btn-primary")}
        disabled={busy || !canSend || (action.option === "acknowledge" && action.title !== undefined)} title={action.title ?? (canSend ? undefined : "先写下要发的内容")} onClick={() => onChoose(action.option)}>{action.label}</button>)}>
      {choice.text}
    </Notice>;
  }
  if (banner !== null) {
    const armed = next !== null && next.for === banner.key ? banner.actions.find(action => action.option === next.option) : undefined;
    return <div className={LINE} role="status" data-relay="attention" data-cause={banner.cause} data-key={banner.key}>
      <Info size={15} className="flex-none text-fg-3" aria-hidden="true"/>
      <span className="min-w-0 flex-1 py-0.5">{armed === undefined ? banner.text : armed.chosen}</span>
      {banner.actions.map(action => <button key={action.option} type="button" className={TOGGLE} data-option={action.option} aria-pressed={armed?.option === action.option}
        onClick={() => onNext(armed?.option === action.option ? null : { request: action.request, for: banner.key, option: action.option })}>{action.label}</button>)}
      <button type="button" className="icon-btn icon-btn-sm flex-none" aria-label="关闭提示" onClick={onDismissBanner}><X size={14}/></button>
    </div>;
  }
  if (line === null) return null;
  if (line.kind === "cleared") {
    const full = next?.option === SEND_HISTORY.option && next.for === SEND_HISTORY.for;
    return <div className={LINE} role="status" data-relay="cleared"><Eraser size={15} className="flex-none text-fg-3" aria-hidden="true"/>
      <span className="min-w-0 flex-1 py-0.5">{full ? "下一条会附上之前对话的交接单" : <><strong className="font-semibold">{target}</strong> 的上下文已清空 · 下一条不附历史</>}</span>
      <button type="button" className={TOGGLE} aria-pressed={full} onClick={() => onNext(full ? null : SEND_HISTORY)}>附上交接单</button></div>;
  }
  const alone = next?.option === SEND_ALONE.option && next.for === SEND_ALONE.for;
  return <div className={LINE} role="status" data-relay={intro && !alone ? "intro" : "owed"}><ArrowRightLeft size={15} className="flex-none text-fg-3" aria-hidden="true"/>
    <span className="min-w-0 flex-1 py-0.5">{alone ? <>这条消息不附交接单，<strong className="font-semibold">{target}</strong> 看不到之前的 {line.runs} 轮</>
      : intro ? <>这条消息会附上之前的对话记录交给 <strong className="font-semibold">{target}</strong>{line.service === null ? "" : `（${vendorWords(line.service)}）`} · 可在设置里改为每次询问</>
      : <>将交给 <strong className="font-semibold">{target}</strong>：{line.runs} 轮{line.tokens === null ? "" : ` · 约 ${compact(line.tokens)} tokens`}</>}
      {line.unverified ? <Badge className="ml-2" title="这个 Harness 的接力还没有在真机上验证过；交接单照常发出，结果如实标注。">未经真机验证</Badge> : null}</span>
    <button type="button" className={TOGGLE} aria-pressed={alone} onClick={() => onNext(alone ? null : SEND_ALONE)}>只发这条消息</button>
  </div>;
}

/**
 * The warning for a workspace the data directory is within reach of (permissive-defaults row 14): a Harness working there can read
 * every conversation. It warns and asks for nothing — the relay goes on — and it can be closed.
 */
export function RelayDataRoot({ onDismiss }: { readonly onDismiss: () => void }) {
  return <Notice tone="amber" className="relay-data-root mx-auto max-w-reading" onDismiss={onDismiss}>
    HarnessHub 的数据目录在这个工作区里，目标 Harness 能直接读到全部对话记录；建议用 --data-dir 把它移到工作区外。
  </Notice>;
}

/**
 * The standing notice for something the installation cannot do for the relay (the relay key file is unusable): why, what it means for
 * the next message, and how to mend it. It is not closed by the user, because the cause stays until it is mended; the message still goes.
 */
export function RelayInstallation({ notice }: { readonly notice: InstallationView }) {
  return <div className="relay-installation" data-relay="installation" data-cause={notice.cause}><Notice tone="amber" className="mx-auto max-w-reading" title={notice.title}>{notice.text}</Notice></div>;
}
