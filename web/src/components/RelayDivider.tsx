import { Fragment } from "react";
import { cn } from "../lib/cn.js";
import { evidenceWords, type ShownHandover } from "../lib/relay-state.js";
import { motionStyle } from "../ui/motion.js";
import { StatusDot } from "../ui/primitives.js";
import { BrandIcon } from "./BrandIcon.js";
import { useEntrance } from "./Turn.js";

/** The sentence of a hand-over in three parts, the Harness's name between the other two so that it can be set in bold. */
function sentence(state: ShownHandover, target: string): readonly [string, string, string] {
  const packet = state.kind === "unknown" || state.kind === "not_recorded" ? "" : state.number === null ? "交接单" : `交接单 #${state.number}`;
  switch (state.kind) {
    case "taken": return ["从这里起由 ", target, ` 接手 · ${state.how}`];
    case "pending": return ["交给 ", target, ` · ${packet} · 送达中`];
    case "started": return ["交给 ", target, ` · ${packet} · 已开始回复，送达待确认`];
    case "unknown": return state.replied ? ["", target, " 已回复，但没有确认收到交接单；下一条消息会再附上一次"] : ["没有确认 ", target, " 收到交接单；下一条消息会再附上一次"];
    case "not_recorded": return ["交接单没有送达 ", target, "（它在收到前拒绝了这条消息），下一条消息会补上"];
  }
}
const DOT = { pending: "run", started: "run", unknown: "idle", not_recorded: "fail" } as const;
/** The longest piece of a sentence that is kept whole when it wraps (a name, "交接单（标准）", "#1"); a longer one wraps as text does. */
const WHOLE = 24;
/**
 * The sentence as drawn: it wraps at its " · " joints before it wraps inside a short piece, so a narrow column breaks
 * "从这里起由 Codex 接手 · 新会话 · 交接单（标准） · #1" before a "·", never through "交接单".
 */
function Drawn({ before, bold, after }: { readonly before: string; readonly bold: string; readonly after: string }) {
  const [head = "", ...rest] = after.split(" · ");
  // The joint stays with the piece after it, so a line breaks before a "·" and never leaves one at its end.
  const whole = (text: string) => <span className={text.length <= WHOLE ? "whitespace-nowrap" : undefined}>{"· " + text}</span>;
  return <>{before.length + bold.length + head.length <= WHOLE ? <span className="whitespace-nowrap">{before}<strong className="font-semibold text-fg">{bold}</strong>{head}</span> : <>{before}<strong className="font-semibold text-fg">{bold}</strong>{head}</>}
    {rest.map((piece, index) => <Fragment key={index}> {whole(piece)}</Fragment>)}</>;
}

/**
 * Where the conversation went to another Harness, drawn by what is known (relay-architecture §12.1 T5): a hairline with a
 * pill in its middle, as the page always drew a hand-over, but the pill says "从这里起由 X 接手" only once the packet is known to be
 * in the original program's history. Until then it says it was handed over and is on its way; when that is not confirmed or
 * the packet did not arrive, it says that, and what happens next. It comes in only if it is news, like any hand-over.
 */
export function RelayDivider({ state, from, to, name, onView, onRevert, revertDisabled }: {
  readonly state: ShownHandover; readonly from: string; readonly to: string; readonly name: (id: string) => string;
  readonly onView?: ((packetId: string) => void) | undefined; readonly onRevert?: (() => void) | undefined; readonly revertDisabled?: boolean | undefined;
}) {
  const entering = useEntrance(state.fresh), target = name(to), [before, bold, after] = sentence(state, target);
  const packetId = state.packetId;
  const revert = state.kind === "taken" ? onRevert : undefined;
  const line = (side: "left" | "right") => <span className={cn("h-[.5px] min-w-3 flex-1 bg-line-strong", side === "left" ? "origin-right" : "origin-left", entering && "motion-line-grow")} style={entering ? motionStyle({ delay: 120 }) : undefined}/>;
  const proof = state.kind === "taken" ? evidenceWords(state.evidence) : null;
  // The links at the right are matched on the left by what is not drawn, so the pill stays in the middle of the column where there is room.
  const links: string[] = [...(packetId !== null && onView ? ["查看交接单"] : []), ...(revert ? ["改回"] : [])];
  // On a narrow screen the separator takes a row of its own and its links the row under it, centred; wide, they share the row.
  return <div className="switch-divider relay-divider flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 sm:flex-nowrap" data-handover={state.kind} {...(state.kind === "taken" && state.evidence ? { "data-evidence": state.evidence } : {})}>
    {links.length ? <span aria-hidden="true" className="invisible flex flex-none gap-3 text-caption font-medium max-sm:hidden">{links.map(text => <span key={text}>{text}</span>)}</span> : null}
    <div role="separator" aria-label={before + bold + after} className="flex min-w-0 flex-1 items-center gap-3 text-caption text-fg-3 max-sm:basis-full">
      {line("left")}
      <span className={cn("flex min-h-[30px] min-w-0 items-center gap-[7px] rounded-[15px] bg-surface py-[3px] pr-3 pl-[7px] shadow-hairline", entering && "motion-fade-in")} {...(proof ? { title: "送达证据：" + proof } : {})}>
        {state.kind === "taken" && from !== to ? <>
          <BrandIcon brand={from} name={name(from)} size={18}/>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-none" aria-hidden="true">
            <path pathLength={1} className={entering ? "motion-draw" : undefined} style={entering ? motionStyle({ duration: 160, delay: 100 }) : undefined} d="M5 12h14M12 5l7 7-7 7"/></svg>
        </> : null}
        <span className={cn("flex flex-none", entering && "motion-pop-in")} style={entering ? motionStyle({ delay: 220, scaleFrom: .6 }) : undefined}><BrandIcon brand={to} name={target} size={18}/></span>
        {state.kind === "taken" ? null : <StatusDot tone={DOT[state.kind]} live={state.kind === "pending" || state.kind === "started"}/>}
        <span className="min-w-0 leading-[18px]"><Drawn before={before} bold={bold} after={after}/></span>
      </span>
      {line("right")}
    </div>
    {links.length ? <span className="flex flex-none items-center gap-3 max-sm:basis-full max-sm:justify-center">
      {packetId !== null && onView ? <button type="button" className="link-btn flex-none text-caption" onClick={() => onView(packetId)}>查看交接单</button> : null}
      {revert ? <button type="button" className="link-btn flex-none text-caption" disabled={revertDisabled} onClick={revert}>改回</button> : null}
    </span> : null}
  </div>;
}
