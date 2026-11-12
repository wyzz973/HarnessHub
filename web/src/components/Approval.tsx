import { CircleHelp, ShieldAlert, ShieldCheck, ShieldX, Square } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { SessionHeadView } from "../../../src/contracts/web.js";
import { remaining, secondsLeft } from "../attention.js";
import { cn } from "../lib/cn.js";
import { useNow } from "../lib/prefs.js";
import { Kbd, StatusDot, Tip } from "../ui/primitives.js";

export type PermissionRequestView = NonNullable<SessionHeadView["permissions"]>[number];
type Request = PermissionRequestView;
type Option = Request["options"][number];
/**
 * An option whose effect outlasts this one request ("always allow", "allow for this session"): the program may record
 * it in its own configuration. These are never bound to a key and can only be clicked (the approver's condition).
 */
export function lastingOption(option: { readonly id: string; readonly name: string }): boolean {
  return /always|session|persist|remember|forever|始终|总是|永久|一直|记住|会话/iu.test(option.id + " " + option.name);
}
/** An option that refuses the request (deny, decline, cancel). */
export function refusingOption(option: { readonly id: string; readonly name: string }): boolean {
  return /reject|deny|decline|cancel|abort|拒绝|取消|中止/iu.test(option.id + " " + option.name);
}
/**
 * Whether a request is an approval of the program's own action, which waits in the composer's place (ADR-054 §5), rather
 * than a question or a form, which stays in its Turn.
 */
export function dockedRequest(request: Pick<Request, "kind" | "input">): boolean { return request.kind !== "question" && request.input === undefined; }
/** The options of an approval in the roles the dock gives them: the one ⏎ allows, the one esc refuses, the click-only ones. */
export function approvalRoles(options: readonly Option[]): { readonly primary: Option | undefined; readonly refuse: Option | undefined; readonly keyed: readonly Option[] } {
  const keyed = options.filter(option => !lastingOption(option)).slice(0, 9);
  return { primary: keyed.find(option => !refusingOption(option)), refuse: keyed.find(refusingOption), keyed };
}
/** What a screen reader hears about the wait: coarse steps, not every second. */
function spokenLeft(seconds: number, text: string): string {
  if (seconds > 60) return text;
  return seconds > 30 ? "不到 1 分钟" : seconds > 10 ? "不到 30 秒" : seconds > 0 ? "不到 10 秒" : "已到期";
}

/**
 * A waiting question (or a form) of the conversation's current Turn, shown in the Turn (ADR-035, ADR-054 §5: questions stay
 * there; approvals wait in the composer's place). It names whose deadline applies and counts it down. While the card has
 * focus (and not one of its fields), the number keys choose the one-time options shown with them.
 */
export function PermissionCard({ request, harness, busy, onDecision }: { readonly request: Request; readonly harness: string; readonly busy: boolean; readonly onDecision: (option: string, input?: string) => void }) {
  const [input, setInput] = useState(request.input?.value ?? "");
  const [now, setNow] = useState(() => Date.now());
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
  return <section tabIndex={-1} onKeyDown={onKeyDown} aria-label={question ? "审批与提问" : "工具审批"}
    className={cn("native-permission motion-enter flex flex-col gap-2.5 rounded-card bg-surface p-3.5 outline-offset-2", request.decided ? "shadow-hairline" : "shadow-[0_0_0_1px_var(--amber-line)]")}>
    <div className="flex items-center gap-2 text-ui-sm">
      <span className={cn("flex h-5 w-5 flex-none items-center justify-center rounded-tag", request.decided ? "bg-subtle text-fg-3" : "bg-amber-soft text-amber")} aria-hidden="true">{question ? <CircleHelp size={13}/> : <ShieldAlert size={13}/>}</span>
      <span className={cn("font-medium", request.decided ? "text-fg-2" : "text-amber")}>{request.decided ? "已决定" : question ? `${harness} 等你回答` : `${harness} 等你批准`}</span>
      <span className="flex-1"/>
      {left ? <><span className={cn("permission-deadline text-caption", urgent ? "font-medium text-amber" : "text-fg-3")} title={left.hint}>{left.source ? `${left.source} · ` : ""}{left.text}</span>
        <span className="sr-only" aria-live="polite">{left.source ? `${left.source} · ` : ""}{spokenLeft(seconds ?? 0, left.text)}</span></> : null}
    </div>
    <strong className="text-ui font-semibold break-words">{request.title}</strong>
    {request.detail ? <p className="m-0 max-h-48 overflow-auto rounded-block bg-inset px-3 py-2 text-ui-sm whitespace-pre-wrap break-words text-fg-2">{request.detail}</p> : null}
    {request.input?.kind === "secret" ? <input type="password" autoComplete="off" aria-label={request.title} className="field" value={input} disabled={disabled} onChange={event => setInput(event.target.value)}/>
      : request.input ? <textarea aria-label={request.title} className="field" value={input} rows={request.input.kind === "editor" ? 6 : 2} disabled={disabled} onChange={event => setInput(event.target.value)}/> : null}
    <div className="flex flex-wrap items-center gap-2">
      {request.options.map((option, index) => {
        const key = keyed.indexOf(option), primary = index === 0 && !refusingOption(option);
        return <button type="button" key={option.id} aria-label={option.name} disabled={disabled} onClick={() => decide(option.id)} {...(key >= 0 ? { "aria-keyshortcuts": String(key + 1) } : {})}
          className={cn("btn btn-sm press", primary ? "btn-primary" : refusingOption(option) ? "btn-ghost" : "")}>
          {option.name}{key >= 0 && !request.decided ? <Kbd variant="hint" className="ml-0.5 font-mono">{key + 1}</Kbd> : null}
        </button>;
      })}
    </div>
    {request.decided ? <small className="text-caption text-fg-3">决定已记录，等待 {harness} 继续。</small>
      : keyed.length ? <small className="text-caption text-fg-3">选中这张卡片后可按 <Kbd>1</Kbd>{keyed.length > 1 ? <>–<Kbd>{keyed.length}</Kbd></> : null} 选择；会长期生效的选项只能点击。</small> : null}
  </section>;
}

/** How long after the dock took focus away from the composer a key is still taken as meant for the composer, and ignored. */
const TYPING_GUARD_MS = 500;
/**
 * An approval waiting in the composer's place (ADR-054 §5, DeepSeek Harness's placement): what asks and whose deadline
 * applies, the command as the program wrote it, the scope of any option that lasts, and the decisions. ⏎ allows once and
 * esc refuses while the dock has focus; the number keys choose the one-time options (shown to keyboard users); options
 * that last are click-only. When it takes the composer's place while the composer had focus, it takes the focus, and for
 * a moment ignores keys still meant for the message being typed; the same when its conversation opens from an action on
 * the page it replaced, whose focus went away with that page. `onDecision` says whether the key or the pointer decided,
 * since actions from the keyboard finish without animation (Motion board #37).
 */
export function ApprovalDock({ request, harness, busy, onDecision, onStop, stopDisabled = false, waiting = 1, policy, focus = null }: {
  readonly request: Request; readonly harness: string; readonly busy: boolean; readonly onDecision: (option: string, keyboard: boolean) => void;
  /** Stops the current reply; the approval then closes with it. */
  readonly onStop?: (() => void) | undefined; readonly stopDisabled?: boolean;
  /** How many approvals of this conversation wait, this one included; the oldest is shown first. */
  readonly waiting?: number;
  /** The program's approval rule that asked, by its own name, when the native configuration reports it. */
  readonly policy?: string | undefined;
  /**
   * Whether to take the focus when shown: "guarded" when it takes the composer's focus, or the focus of the page its
   * conversation replaced (keys for a moment are still taken as meant for the message or that page), "plain" when the
   * previous request in the dock had it, null to leave it where it is.
   */
  readonly focus?: "guarded" | "plain" | null;
}) {
  const section = useRef<HTMLElement>(null);
  const guard = useRef(0);
  const now = useNow(request.expiresAt !== undefined && !request.decided);
  const left = request.expiresAt === undefined || request.decided ? null : remaining(request, now);
  const seconds = request.expiresAt === undefined ? null : secondsLeft(request.expiresAt, now);
  const { primary, refuse, keyed } = approvalRoles(request.options);
  const lasting = request.options.filter(lastingOption);
  const others = keyed.filter(option => option !== primary && !refusingOption(option));
  const refusals = keyed.filter(refusingOption);
  const disabled = busy || request.decided;
  useLayoutEffect(() => {
    if (focus === null) return;
    section.current?.focus({ preventScroll: true });
    if (focus === "guarded") guard.current = Date.now() + TYPING_GUARD_MS;
  }, [request.id]);
  const decide = (option: Option, keyboard: boolean) => { if (!disabled) onDecision(option.id, keyboard); };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (disabled || event.metaKey || event.ctrlKey || event.altKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, select, [contenteditable=true]")) return;
    const early = Date.now() < guard.current || event.repeat;
    if (event.key === "Escape" && refuse) { event.preventDefault(); event.stopPropagation(); if (!early) decide(refuse, true); return; }
    // ⏎ on a focused button presses that button; on the dock itself it allows once.
    if (event.key === "Enter" && target === event.currentTarget && primary) { event.preventDefault(); if (!early) decide(primary, true); return; }
    const index = Number(event.key) - 1;
    if (event.key.length === 1 && Number.isInteger(index) && index >= 0 && index < keyed.length) { event.preventDefault(); if (!early) decide(keyed[index]!, true); }
  };
  const urgent = seconds !== null && seconds <= 60;
  const button = (option: Option, tone: "primary" | "ghost" | "plain") => {
    const key = keyed.indexOf(option);
    // One-time options carry their number (shown to keyboard users, G054-FR8); ⏎ and esc are shown as the board shows them.
    // Hidden, the number keeps its room (`decision-key`): a pointer press hides it, and the decision pressed must not move.
    // Pressed, a decision keeps the room it was pressed in under the pointer (`decision`), though it scales to .97 (#31).
    // On a phone the decisions fill the lines they wrap onto, so the primary is never left alone at one end.
    return <button key={option.id} type="button" aria-label={option.name} disabled={disabled} onClick={() => decide(option, false)}
      aria-keyshortcuts={[key >= 0 ? String(key + 1) : "", option === primary ? "Enter" : "", option === refuse ? "Escape" : ""].filter(Boolean).join(" ") || undefined}
      className={cn("decision btn press max-sm:grow", tone === "primary" ? "btn-primary px-3.5" : tone === "ghost" ? "btn-ghost" : "")}>
      {key >= 0 ? <span aria-hidden="true" className="kbd-hint decision-key font-mono">{key + 1}</span> : null}
      <span>{option.name}</span>
      {option === primary ? <Kbd variant="hint">⏎</Kbd> : option === refuse ? <Kbd variant="hint">esc</Kbd> : null}
    </button>;
  };
  // Pointing at the dock is a choice to act on it: the keys are meant for it from then on. Focused from the keyboard it shows
  // the product's focus ring (2 px, accent text, at once), which follows its 28 px corners; from the pointer it shows none.
  return <section ref={section} id="approval-dock" tabIndex={-1} onKeyDown={onKeyDown} onPointerDown={() => { guard.current = 0; }} aria-label="工具审批" aria-describedby="approval-dock-title"
    className="approval-dock flex flex-col gap-3 rounded-composer pt-4 pr-4 pb-3 pl-[18px]">
    <div className="flex items-start gap-3">
      <span className="flex h-[34px] w-[34px] flex-none items-center justify-center rounded-[11px] bg-amber-soft text-amber" aria-hidden="true"><ShieldAlert size={18}/></span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {/* The state in the words the header and the Turn use (Interaction board: 等你批准). */}
        <strong id="approval-dock-title" className="text-ui font-semibold">{harness} 等你批准</strong>
        <span className="text-caption text-fg-3">
          {policy ? <>来自 {harness} 的“{policy}”策略 · </> : null}
          {left ? <span className={cn("permission-deadline", urgent && "font-medium text-amber")} title={left.hint}>{left.source ? `${left.source} · ` : ""}{left.text}</span> : `${harness} 会一直等你决定`}
        </span>
        {left ? <span className="sr-only" aria-live="polite">{left.source ? `${left.source} · ` : ""}{spokenLeft(seconds ?? 0, left.text)}</span> : null}
      </div>
      {waiting > 1 ? <span className="badge badge-amber flex-none" title="这个对话里等你处理的审批，按到达的先后显示">还有 {waiting - 1} 个</span> : null}
    </div>
    <div className="flex flex-col gap-1 rounded-block bg-inset px-3 py-2.5">
      <span className="mono text-[13px] leading-5 break-all whitespace-pre-wrap text-fg">{request.title}</span>
      {request.detail ? <span className="max-h-[7.5rem] overflow-auto text-caption whitespace-pre-wrap break-words text-fg-3">{request.detail}</span> : null}
    </div>
    {lasting.length ? <p className="m-0 text-caption text-fg-3">选{lasting.map(option => `“${option.name}”`).join("或")}后，{harness} 会按它自己的规则记住这个决定，之后同类请求可能不再询问。这类选项不绑快捷键，只能点选。</p> : null}
    {/* The decisions keep to the right, the primary last, also when they wrap on a narrow screen. */}
    <div className="flex flex-wrap items-center justify-end gap-2">
      {onStop ? <Tip label="停止当前回复（⌘.）" side="top"><button type="button" className="btn btn-ghost -ml-1.5 mr-auto px-2.5" aria-label="停止当前回复" disabled={stopDisabled} onClick={onStop}>
        <Square size={10} fill="currentColor" aria-hidden="true"/><span>停止</span></button></Tip> : null}
      {refusals.map(option => button(option, "ghost"))}
      {lasting.map(option => button(option, "plain"))}
      {others.map(option => button(option, "plain"))}
      {primary ? button(primary, "primary") : null}
    </div>
  </section>;
}

/**
 * What the user decided on an approval, as this page sent it: the option and its role in the dock ("once" is the one ⏎
 * allows). `null` option when it was decided elsewhere and this page does not know how.
 */
export interface Decision { readonly title: string; readonly option: { readonly id: string; readonly name: string; readonly role: "once" | "refuse" | "other" } | null; readonly harness: string }
/** The role an option played in its approval, for the line written back. */
export function decisionRole(options: readonly Option[], id: string): "once" | "refuse" | "other" {
  const { primary, refuse } = approvalRoles(options);
  return primary?.id === id ? "once" : refuse?.id === id || options.some(option => option.id === id && refusingOption(option)) ? "refuse" : "other";
}
/**
 * The one line an approval leaves in its Turn once decided (Motion board #21: it fades in, 200 ms). Allowing and refusing
 * say so with the request's own title; a decision made elsewhere says only that it was handled.
 */
export function DecisionLine({ decision }: { readonly decision: Decision }) {
  const option = decision.option, refused = option?.role === "refuse";
  const text = option === null ? `这次审批已处理，等待 ${decision.harness} 继续：` : refused ? "你拒绝了：" : option.role === "once" ? "你允许了一次：" : `你选择了“${option.name}”：`;
  const Icon = refused ? ShieldX : ShieldCheck;
  return <p className="approval-result motion-fade-in m-0 flex min-w-0 items-center gap-2 text-ui-sm text-fg-3" role="status">
    <Icon size={15} className="flex-none" aria-hidden="true"/><span className="min-w-0 truncate" title={decision.title}>{text}<span className="mono text-[12.5px]">{decision.title}</span></span>
  </p>;
}
/**
 * The mark a Turn keeps while its approval waits in the composer's place (Conversation board, decision F): the Turn's one
 * amber line, drawn once for the Turn's waiting approvals; the process line above it keeps its grey. A button, so a click
 * or ⏎ moves the focus to the approval.
 */
export function DockedMarker() {
  return <button type="button" className="docked-approval flex items-center gap-2 self-start rounded-row border-none bg-transparent px-0 text-ui-sm text-amber"
    onClick={() => document.getElementById("approval-dock")?.focus()}>
    <StatusDot tone="wait"/>等你批准，请求停在下方输入框的位置
  </button>;
}
