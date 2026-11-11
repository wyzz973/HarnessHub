import { ArrowRightLeft, Info, X } from "lucide-react";
import { cn } from "../lib/cn.js";
import { compact } from "../lib/format.js";
import type { BannerView, InstallationView, RelayLine } from "../lib/relay-state.js";
import type { RelayRequest } from "../relay.js";
import { Notice } from "../ui/primitives.js";

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
/** The next message's choice that attaches the history to it, offered where the setting does not attach it by itself. */
export const SEND_WITH: RelayNext = { request: { attach: "full" }, for: "off", option: "full" };

/**
 * The one line above the message box that is about the history, quiet and out of the way:
 *  - what a binding asks the user to look at (a packet nothing confirmed, or a conversation cleared whose earlier part can be attached
 *    to the next message): said once, with the way to settle it, a choice for the next message; the next message goes whatever it
 *    says, and a closed one of the same episode does not come back;
 *  - when something is owed to the Harness the conversation is on: what will be handed over, and the way to send without it; the first
 *    time a Harness takes the history it also says where it goes (nothing to press, and it goes away with the message);
 *  - when the installation's setting does not hand the earlier conversation over by itself: that the message goes with the words
 *    alone, and the way to attach it.
 * Nothing is asked: the banner appears only when something was done or is in doubt, the line only informs. `target` is the name of
 * the Harness the conversation is on.
 */
export function RelayCard({ line, banner, target, next, onNext, onDismissBanner }: {
  readonly line: RelayLine | null; readonly banner: BannerView | null; readonly target: string;
  readonly next: RelayNext | null; readonly onNext: (next: RelayNext | null) => void; readonly onDismissBanner: () => void;
}) {
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
  if (line.off) {
    const full = next?.option === SEND_WITH.option && next.for === SEND_WITH.for;
    return <div className={LINE} role="status" data-relay="off"><ArrowRightLeft size={15} className="flex-none text-fg-3" aria-hidden="true"/>
      <span className="min-w-0 flex-1 py-0.5">{full ? <>这条消息会附上之前的对话记录交给 <strong className="font-semibold">{target}</strong></>
        : <>设置里关了“换 Harness 时附上之前的对话”：这条只发原话，<strong className="font-semibold">{target}</strong> 看不到之前的 {line.runs} 轮</>}</span>
      <button type="button" className={TOGGLE} aria-pressed={full} onClick={() => onNext(full ? null : SEND_WITH)}>附上之前的对话</button>
    </div>;
  }
  const alone = next?.option === SEND_ALONE.option && next.for === SEND_ALONE.for;
  return <div className={LINE} role="status" data-relay={line.first && !alone ? "intro" : "owed"}><ArrowRightLeft size={15} className="flex-none text-fg-3" aria-hidden="true"/>
    <span className="min-w-0 flex-1 py-0.5">{alone ? <>这条消息不附交接单，<strong className="font-semibold">{target}</strong> 看不到之前的 {line.runs} 轮</>
      : line.first ? <>这条消息会附上之前的对话记录交给 <strong className="font-semibold">{target}</strong> · 可在设置里关闭</>
      : <>将交给 <strong className="font-semibold">{target}</strong>：{line.runs} 轮{line.tokens === null ? "" : ` · 约 ${compact(line.tokens)} tokens`}</>}</span>
    <button type="button" className={TOGGLE} aria-pressed={alone} onClick={() => onNext(alone ? null : SEND_ALONE)}>只发这条消息</button>
  </div>;
}

/**
 * The standing notice for something the installation cannot do for the relay (the relay key file is unusable): why, what it means for
 * the next message, and how to mend it. It is not closed by the user, because the cause stays until it is mended; the message still goes.
 */
export function RelayInstallation({ notice }: { readonly notice: InstallationView }) {
  return <div className="relay-installation" data-relay="installation" data-cause={notice.cause}><Notice tone="amber" className="mx-auto max-w-reading" title={notice.title}>{notice.text}</Notice></div>;
}
