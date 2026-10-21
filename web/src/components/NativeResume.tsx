import { Check, ChevronRight, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { NativeResumeView } from "../../../src/contracts/web.js";
import { cn } from "../lib/cn.js";

function CopyText({ text, label }: { readonly text: string; readonly label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return <button type="button" className="icon-btn icon-btn-sm native-resume-copy" aria-label={label} title={state === "copied" ? "已复制" : state === "failed" ? "无法使用剪贴板，可选中文本后复制" : label}
    onClick={() => { void navigator.clipboard.writeText(text).then(() => setState("copied"), () => setState("failed")); }}>{state === "copied" ? <Check size={13}/> : <Copy size={13}/>}</button>;
}
function Row({ label, value, copy, title }: { readonly label?: string; readonly value: string; readonly copy: string; readonly title?: string }) {
  return <div className="native-resume-row flex flex-col gap-1" title={title}>
    {label ? <small className="text-[11.5px] text-fg-3">{label}</small> : null}
    <div className="flex items-center gap-1 rounded-lg border border-line bg-subtle py-1 pr-1 pl-2.5"><code className="min-w-0 flex-1 text-[12px] break-all">{value}</code><CopyText text={value} label={copy}/></div>
  </div>;
}
/**
 * How to continue this conversation's native session in the Harness's own program (ADR-039), read once when shown. The
 * interactive command follows the installed program's help; the one-question command is the form a real Turn verified.
 * A program with no interactive form to give (DeepSeek Harness) shows its one-question command as the way to continue.
 * HarnessHub only offers them for copying.
 */
export function NativeResume({ load }: { readonly load: (signal: AbortSignal) => Promise<NativeResumeView | null> }) {
  const [view, setView] = useState<NativeResumeView | null | undefined>(undefined);
  const [once, setOnce] = useState(false);
  const loader = useRef(load);
  useEffect(() => {
    const controller = new AbortController();
    loader.current(controller.signal).then(setView, () => { if (!controller.signal.aborted) setView(null); });
    return () => controller.abort();
  }, []);
  if (!view) return null;
  const note = "native-resume-note m-0 text-[12px] text-fg-3";
  if (view.list) return <small className={note}>在原程序中继续：{view.list}</small>;
  const onceNote = view.onceNote ? <small className={note}>{view.onceNote}</small> : null;
  // What either command means for the workspace and for the two sides' Turns.
  const notes = <>
    <small className={note}>原程序首次在这个目录运行时可能先询问是否信任这个目录；接受会写入它自己的全局配置。</small>
    <small className={note}>在原程序中继续会使两边的回合交错；回到 HarnessHub 继续前，先在原程序中结束。</small>
  </>;
  return <div className="native-resume flex flex-col gap-2" aria-label="在原程序中继续" role="group">
    {view.nativeId ? <Row label="原生会话 ID" value={view.nativeId} copy="复制原生会话 ID"/> : null}
    {view.interactive ? <>
      <Row label="在该对话的工作区目录中运行" value={view.interactive} copy="复制恢复命令" title="交互形式按原程序帮助给出，恢复机制以非交互形式真实验证"/>
      {view.once ? <div>
        <button type="button" aria-expanded={once} onClick={() => setOnce(value => !value)} className="flex items-center gap-1 rounded-md border-none bg-transparent px-1 py-0.5 text-[12px] text-fg-2 hover:bg-hover">
          <ChevronRight size={12} className={cn("transition-transform duration-150", once && "rotate-90")} aria-hidden="true"/>只问一次（已用真实回合验证）</button>
        {once ? <div className="mt-1.5 flex flex-col gap-1"><Row value={view.once} copy="复制只问一次的命令" {...(view.onceNote ? { title: view.onceNote } : {})}/>{onceNote}</div> : null}
      </div> : null}
      {notes}
    </> : view.once ? <>
      <Row label="只问一次（已用真实回合验证）· 在该对话的工作区目录中运行" value={view.once} copy="复制只问一次的命令" {...(view.onceNote ? { title: view.onceNote } : {})}/>
      {onceNote}{notes}
    </> : view.note === "version-unverified" ? <small className={note}>恢复命令未在此版本验证。</small>
      : view.note === "not-verified" ? <small className={note}>这个程序的恢复命令没有经过验证。</small> : null}
  </div>;
}
