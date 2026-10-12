import { CircleHelp, ShieldAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { SessionView } from "../../../src/contracts/web.js";
import { remaining, secondsLeft } from "../attention.js";
import { cn } from "../lib/cn.js";
import { Kbd } from "../ui/primitives.js";

type Request = NonNullable<SessionView["permissions"]>[number];
/**
 * An option whose effect outlasts this one request ("always allow", "allow for this session"): the program may record
 * it in its own configuration. These are never bound to number keys and can only be clicked (the approver's condition).
 */
export function lastingOption(option: { readonly id: string; readonly name: string }): boolean {
  return /always|session|persist|remember|forever|始终|总是|永久|一直|记住|会话/iu.test(option.id + " " + option.name);
}
function refusing(option: { readonly id: string; readonly name: string }): boolean {
  return /reject|deny|decline|cancel|abort|拒绝|取消|中止/iu.test(option.id + " " + option.name);
}
/** What a screen reader hears about the wait: coarse steps, not every second. */
function spokenLeft(seconds: number, text: string): string {
  if (seconds > 60) return text;
  return seconds > 30 ? "不到 1 分钟" : seconds > 10 ? "不到 30 秒" : seconds > 0 ? "不到 10 秒" : "已到期";
}

/**
 * A waiting approval or question of the conversation's current Turn, shown in the conversation (ADR-035, ADR-042). It
 * names whose deadline applies and counts it down. While the card has focus (and not one of its fields), the number keys
 * choose the one-time options shown with them.
 */
export function PermissionCard({ request, harness, busy, onDecision }: { readonly request: Request; readonly harness: string; readonly busy: boolean; readonly onDecision: (option: string, input?: string) => void }) {
  const [input, setInput] = useState(request.input?.value ?? "");
  const [now, setNow] = useState(() => Date.now());
  const card = useRef<HTMLElement>(null);
  useEffect(() => { if (request.expiresAt === undefined || request.decided) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [request.expiresAt, request.decided]);
  const left = request.expiresAt === undefined || request.decided ? null : remaining(request, now);
  const seconds = request.expiresAt === undefined ? null : secondsLeft(request.expiresAt, now);
  const question = request.kind === "question" || request.input !== undefined;
  const keyed = request.options.filter(option => !lastingOption(option)).slice(0, 9);
  const disabled = busy || request.decided;
  const decide = (id: string) => onDecision(id, request.input && id === "submit" ? input : undefined);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (disabled || event.metaKey || event.ctrlKey || event.altKey || event.nativeEvent.isComposing) return;
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, select, [contenteditable=true]")) return;
    const index = Number(event.key) - 1;
    if (Number.isInteger(index) && index >= 0 && index < keyed.length) { event.preventDefault(); decide(keyed[index]!.id); }
  };
  const urgent = seconds !== null && seconds <= 60;
  return <section ref={card} tabIndex={-1} onKeyDown={onKeyDown} aria-label={request.input ? "Harness 交互" : "工具审批"}
    className={cn("native-permission enter flex flex-col gap-2.5 rounded-xl border bg-surface p-3.5 shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-accent",
      request.decided ? "border-line" : "border-amber-line")}>
    <div className="flex items-center gap-2 text-[12.5px]">
      <span className={cn("flex h-5 w-5 flex-none items-center justify-center rounded-md", request.decided ? "bg-subtle text-fg-3" : "bg-amber-soft text-amber")} aria-hidden="true">{question ? <CircleHelp size={13}/> : <ShieldAlert size={13}/>}</span>
      <span className={cn("font-medium", request.decided ? "text-fg-2" : "text-amber")}>{request.decided ? "已决定" : question ? `${harness} 在等你回答` : `${harness} 在等你审批`}</span>
      <span className="flex-1"/>
      {left ? <><span className={cn("permission-deadline font-medium tabular-nums", urgent ? "text-red" : "text-fg-2")} title={left.hint}>{left.source ? `${left.source} · ` : ""}{left.text}</span>
        <span className="sr-only" aria-live="polite">{left.source ? `${left.source} · ` : ""}{spokenLeft(seconds ?? 0, left.text)}</span></> : null}
    </div>
    <strong className="text-[14px] font-semibold break-words">{request.title}</strong>
    {request.detail ? <p className="m-0 max-h-48 overflow-auto rounded-lg bg-subtle px-3 py-2 text-[12.5px] whitespace-pre-wrap break-words text-fg-2">{request.detail}</p> : null}
    {request.input?.kind === "secret" ? <input type="password" autoComplete="off" aria-label={request.title} className="field" value={input} disabled={disabled} onChange={event => setInput(event.target.value)}/>
      : request.input ? <textarea aria-label={request.title} className="field" value={input} rows={request.input.kind === "editor" ? 6 : 2} disabled={disabled} onChange={event => setInput(event.target.value)}/> : null}
    <div className="flex flex-wrap items-center gap-2">
      {request.options.map((option, index) => {
        const key = keyed.indexOf(option), primary = index === 0 && !refusing(option);
        return <button type="button" key={option.id} disabled={disabled} onClick={() => decide(option.id)}
          className={cn("btn btn-sm", primary ? "btn-primary" : refusing(option) ? "btn-danger" : "")}>
          {option.name}{key >= 0 && !request.decided ? <span aria-hidden="true" className={cn("ml-0.5 font-mono text-[10.5px]", primary ? "opacity-60" : "text-fg-3")}>{key + 1}</span> : null}
        </button>;
      })}
    </div>
    {request.decided ? <small className="text-[12px] text-fg-3">决定已记录，等待 Harness 继续。</small>
      : keyed.length ? <small className="text-[11.5px] text-fg-3">选中这张卡片后可按 <Kbd>1</Kbd>{keyed.length > 1 ? <>–<Kbd>{keyed.length}</Kbd></> : null} 选择；会长期生效的选项只能点击。</small> : null}
  </section>;
}
