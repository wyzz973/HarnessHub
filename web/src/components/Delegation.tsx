import { ArrowUpRight, Check, CornerUpLeft } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { HarnessView, SessionSummary } from "../../../src/contracts/web.js";
import { errorMessage } from "../api.js";
import { cn } from "../lib/cn.js";
import { Dialog } from "../ui/overlay.js";
import { SwapText } from "../ui/motion.js";
import { Spinner, StatusDot } from "../ui/primitives.js";
import { BrandIcon } from "./BrandIcon.js";

const LAST_KEY = "harnesshub:delegate-harness";
function lastTarget(): string | null { try { return localStorage.getItem(LAST_KEY); } catch { return null; } }

/**
 * Hands a part of the conversation's work to another Harness (2026-11-13): which one, and what to do. It works in a conversation
 * of its own that starts from this one's history; this conversation goes on meanwhile.
 */
export function DelegateDialog({ open, onClose, harnesses, current, onDelegate }: {
  readonly open: boolean; readonly onClose: () => void;
  /** The Harnesses that can take it now. */
  readonly harnesses: readonly HarnessView[];
  /** The conversation's own Harness: another one is offered first. */
  readonly current: string;
  readonly onDelegate: (harness: HarnessView, text: string) => Promise<void>;
}) {
  const [chosen, setChosen] = useState<string | null>(null), [text, setText] = useState(""), [busy, setBusy] = useState(false), [problem, setProblem] = useState<string | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  // Offered first: the one delegated to last, else one other than the conversation's own.
  const preferred = harnesses.find(harness => harness.id === lastTarget()) ?? harnesses.find(harness => harness.id !== current) ?? harnesses[0];
  const target = harnesses.find(harness => harness.id === chosen) ?? preferred;
  useEffect(() => { if (open) { setProblem(null); setBusy(false); } }, [open]);
  const submit = () => {
    if (target === undefined || text.trim() === "" || busy) return;
    setBusy(true); setProblem(null);
    onDelegate(target, text).then(() => { try { localStorage.setItem(LAST_KEY, target.id); } catch { /* a convenience */ } setText(""); onClose(); },
      (failure: unknown) => setProblem(errorMessage(failure))).finally(() => setBusy(false));
  };
  return <Dialog open={open} onOpenChange={next => { if (!next && !busy) onClose(); }} title="委派" className="w-[520px]" initialFocus={field}>
    <div className="flex flex-col gap-3 px-5 pt-4 pb-5">
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="交给哪个 Harness">
        {harnesses.map(harness => { const on = harness.id === target?.id; return <button key={harness.id} type="button" role="radio" aria-checked={on} onClick={() => setChosen(harness.id)}
          className={cn("press flex h-8 items-center gap-1.5 rounded-control border-none pr-2.5 pl-1.5 text-ui-sm transition-[color,background-color,box-shadow] duration-120 ease-standard",
            on ? "bg-accent-soft text-fg shadow-[inset_0_0_0_1px_var(--accent)]" : "bg-subtle text-fg-2 hover:bg-hover hover:text-fg")}>
          <BrandIcon brand={harness.id} name={harness.name} size={18}/>{harness.name}</button>; })}
      </div>
      <textarea ref={field} value={text} onChange={event => setText(event.target.value)} rows={4} placeholder={target ? `让 ${target.name} 做什么？` : "做什么？"} aria-label="委派的任务"
        className="field min-h-24 resize-y py-2 leading-5" onKeyDown={event => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); } }}/>
      {problem ? <p className="m-0 text-caption text-red" role="alert">{problem}</p> : null}
      <div className="flex items-center justify-end gap-2">
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={onClose}>取消</button>
        <button type="button" className="btn btn-primary" disabled={busy || target === undefined || text.trim() === ""} aria-keyshortcuts="Meta+Enter" onClick={submit}>{busy ? <Spinner size={13} label="" className="text-on-accent"/> : null}委派</button>
      </div>
    </div>
  </Dialog>;
}

/** What a delegated conversation came to: its latest Turn's state, the wrap-up its Harness gave (when it gave one) and its reply. */
export interface DelegationResult { readonly runId: string | null; readonly status: string | null; readonly summary: string | null; readonly reply: string }

/**
 * The work this conversation handed to other Harnesses at one place of it: each as a card that says who has it, what was asked and how it
 * stands, and opens the conversation it runs in. What it came to goes to this conversation's Harness with your next message (the Gateway
 * puts it before your words); the card says once it has, and until then offers to have that Harness carry on right away.
 */
export function DelegationCards({ items, harness, load, onOpen, onReport, reportTo, busy, told }: {
  readonly items: readonly SessionSummary[]; readonly harness: (id: string) => string;
  readonly load: (id: string, signal: AbortSignal) => Promise<DelegationResult>;
  readonly onOpen: (id: string) => void;
  /** Sends a message into this conversation; absent when it cannot take one now. */
  readonly onReport?: ((text: string) => void) | undefined;
  /** The Harness of this conversation, which the outcome goes to. */
  readonly reportTo: string; readonly busy: boolean;
  /** Whether the outcome of that Turn of that conversation has gone to this conversation's Harness. */
  readonly told: (id: string, runId: string) => boolean;
}) {
  if (items.length === 0) return null;
  return <div className="delegations flex flex-col gap-2">{items.map(item => <DelegationCard key={item.id} item={item} name={harness(item.selection.harnessId)} load={load} onOpen={() => onOpen(item.id)}
    onReport={onReport} reportTo={reportTo} busy={busy} told={runId => told(item.id, runId)}/>)}</div>;
}

function DelegationCard({ item, name, load, onOpen, onReport, reportTo, busy, told }: {
  readonly item: SessionSummary; readonly name: string; readonly load: (id: string, signal: AbortSignal) => Promise<DelegationResult>; readonly onOpen: () => void;
  readonly onReport?: ((text: string) => void) | undefined; readonly reportTo: string; readonly busy: boolean; readonly told: (runId: string) => boolean;
}) {
  const running = item.activeRunId !== null;
  const [result, setResult] = useState<DelegationResult | null>(null), [sent, setSent] = useState(false);
  // What it came to is read when it stands still, and again whenever it has moved on.
  useEffect(() => {
    if (running) return;
    const controller = new AbortController();
    load(item.id, controller.signal).then(value => { if (!controller.signal.aborted) setResult(value); }, () => { /* the card keeps what it has */ });
    return () => controller.abort();
  }, [item.id, item.updatedSeq, running, load]);
  const failed = !running && (result?.status === "failed" || result?.status === "unknown"), stopped = !running && result?.status === "cancelled";
  const state = running ? "进行中" : failed ? "失败" : stopped ? "已停止" : result === null ? "" : "已完成";
  const said = running ? null : result?.summary || result?.reply || null;
  const known = !running && result !== null && result.runId !== null && told(result.runId);
  // The outcome goes with the message (the Gateway puts it before these words): the message only asks to carry on.
  const report = () => { if (onReport === undefined || result === null) return; onReport(`看一下 ${name} 的委派结果，然后接着做。`); setSent(true); };
  return <section className="delegation card motion-enter flex min-w-0 flex-col gap-1.5 px-3.5 py-3 text-ui-sm" aria-label={"委派给 " + name}>
    <div className="flex min-w-0 items-center gap-2">
      <BrandIcon brand={item.selection.harnessId} name={name} size={18}/>
      <span className="min-w-0 flex-1 trunc"><span className="text-fg-3">{item.parent?.by === "harness" ? reportTo + " 委派给 " : "委派给 "}</span><span className="font-medium">{name}</span></span>
      {state ? <span className={cn("flex flex-none items-center gap-1.5 text-caption", failed ? "text-red" : "text-fg-3")}>{running ? <StatusDot tone="run"/> : null}<SwapText text={state} shimmer={running}/></span> : null}
    </div>
    <p className="m-0 line-clamp-2 break-words text-fg-2" title={item.title}>{item.title}</p>
    {said ? <p className="delegation-result m-0 line-clamp-4 border-t border-line pt-2 break-words whitespace-pre-wrap text-fg">{said}</p> : null}
    <div className="-mb-0.5 -ml-1.5 flex flex-wrap items-center gap-1">
      <button type="button" className="btn btn-ghost btn-sm" onClick={onOpen}><ArrowUpRight size={13}/>打开</button>
      {known ? <span className="ml-1 flex items-center gap-1 text-caption text-fg-3"><Check size={12} aria-hidden="true"/>已告知 {reportTo}</span>
        : !running && result !== null && onReport !== undefined && !sent ? <button type="button" className="btn btn-ghost btn-sm" disabled={busy} title={"下一条消息会带上这个结果；点这里让 " + reportTo + " 现在就接着做"} onClick={report}><CornerUpLeft size={13}/>让 {reportTo} 接着做</button> : null}
    </div>
  </section>;
}
