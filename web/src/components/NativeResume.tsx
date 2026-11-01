import { Check, ChevronRight, Copy } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { NativeResumeView } from "../../../src/contracts/web.js";
import { cn } from "../lib/cn.js";
import { Collapsible } from "../ui/motion.js";

function CopyText({ text, label }: { readonly text: string; readonly label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return <button type="button" className={cn("icon-btn icon-btn-sm native-resume-copy flex-none", state === "failed" ? "text-red" : "text-fg-3")} aria-label={label} title={state === "copied" ? "已复制" : state === "failed" ? "无法使用剪贴板，可选中文本后复制" : label}
    onClick={() => { void navigator.clipboard.writeText(text).then(() => setState("copied"), () => setState("failed")); }}>{state === "copied" ? <Check size={14}/> : <Copy size={14}/>}</button>;
}
/** One command or identifier, in the inset of code (radius 10), with its copy button. */
function Row({ label, value, copy, title }: { readonly label?: string; readonly value: string; readonly copy: string; readonly title?: string }) {
  return <div className="native-resume-row flex flex-col gap-1" title={title}>
    {label ? <small className="text-caption text-fg-3">{label}</small> : null}
    <div className="flex items-center gap-1 rounded-control bg-inset py-1 pr-1 pl-2.5 shadow-[inset_0_0_0_.5px_var(--border)]"><code className="min-w-0 flex-1 text-code break-all text-fg">{value}</code><CopyText text={value} label={copy}/></div>
  </div>;
}
/**
 * How to continue this conversation's native session in the Harness's own program (ADR-039), read once when shown and
 * given for whatever version is installed (ADR-053). The interactive command follows the program's help; the one-question
 * command is the program's own, with the note it depends on. A program with no interactive form to give (DeepSeek
 * Harness) shows its one-question command as the way to continue; one with no command to give shows its identifier and
 * says so. HarnessHub only offers them for copying.
 */
export function NativeResume({ load }: { readonly load: (signal: AbortSignal) => Promise<NativeResumeView | null> }) {
  const [view, setView] = useState<NativeResumeView | null | undefined>(undefined);
  const [once, setOnce] = useState(false);
  const loader = useRef(load), onceId = useId();
  useEffect(() => {
    const controller = new AbortController();
    loader.current(controller.signal).then(setView, () => { if (!controller.signal.aborted) setView(null); });
    return () => controller.abort();
  }, []);
  if (!view) return null;
  const note = "native-resume-note m-0 text-caption text-fg-3";
  if (view.list) return <small className={note}>在原程序中继续：{view.list}</small>;
  const onceNote = view.onceNote ? <small className={note}>{view.onceNote}</small> : null;
  // What either command means for the workspace and for the two sides' Turns.
  const notes = <>
    <small className={note}>原程序首次在这个目录运行时可能先询问是否信任这个目录；接受会写入它自己的全局配置。</small>
    <small className={note}>在原程序中继续会使两边的回合交错；回到 HarnessHub 继续前，先在原程序中结束。</small>
  </>;
  return <div className="native-resume flex flex-col gap-2.5" aria-label="在原程序中继续" role="group">
    {view.nativeId ? <Row label="原生会话 ID" value={view.nativeId} copy="复制原生会话 ID"/> : null}
    {view.interactive ? <>
      <Row label="在该对话的工作区目录中运行" value={view.interactive} copy="复制恢复命令" title="交互形式按原程序帮助给出"/>
      {view.once ? <div className="flex flex-col">
        <button type="button" aria-expanded={once} aria-controls={onceId} onClick={() => setOnce(value => !value)} className="row flex h-7 items-center gap-1 self-start border-none bg-transparent px-1.5 text-caption text-fg-2">
          <ChevronRight size={12} strokeWidth={2.2} className={cn("text-fg-3 motion-rotate", once && "rotate-90")} aria-hidden="true"/>只问一次</button>
        <Collapsible open={once} id={onceId}><div className="mt-1.5 flex flex-col gap-1"><Row value={view.once} copy="复制只问一次的命令" {...(view.onceNote ? { title: view.onceNote } : {})}/>{onceNote}</div></Collapsible>
      </div> : null}
      {notes}
    </> : view.once ? <>
      <Row label="只问一次 · 在该对话的工作区目录中运行" value={view.once} copy="复制只问一次的命令" {...(view.onceNote ? { title: view.onceNote } : {})}/>
      {onceNote}{notes}
    </> : view.note === "no-command" ? <small className={note}>这个程序没有可给出的续接命令。</small> : null}
  </div>;
}
