import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { NativeResumeView } from "../../../src/contracts/web.js";

function CopyText({ text, label }: { readonly text: string; readonly label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return <button type="button" className="message-action native-resume-copy" aria-label={label} title={state === "copied" ? "已复制" : state === "failed" ? "无法使用剪贴板，可选中文本后复制" : label}
    onClick={() => { void navigator.clipboard.writeText(text).then(() => setState("copied"), () => setState("failed")); }}>{state === "copied" ? <Check size={13}/> : <Copy size={13}/>}</button>;
}
/**
 * How to continue this conversation's native session in the Harness's own program (ADR-039), read once when shown. The
 * interactive command follows the installed program's help; the one-question command is the form a real Turn verified.
 * HarnessHub only offers them for copying.
 */
export function NativeResume({ load }: { readonly load: (signal: AbortSignal) => Promise<NativeResumeView | null> }) {
  const [view, setView] = useState<NativeResumeView | null | undefined>(undefined);
  const loader = useRef(load);
  useEffect(() => {
    const controller = new AbortController();
    loader.current(controller.signal).then(setView, () => { if (!controller.signal.aborted) setView(null); });
    return () => controller.abort();
  }, []);
  if (!view) return null;
  if (view.list) return <small className="native-resume-note">在原程序中继续：{view.list}</small>;
  return <div className="native-resume" aria-label="在原程序中继续">
    {view.nativeId ? <div className="native-resume-row"><small>原生会话 ID</small><code>{view.nativeId}</code><CopyText text={view.nativeId} label="复制原生会话 ID"/></div> : null}
    {view.interactive ? <>
      <div className="native-resume-row" title="交互形式按原程序帮助给出，恢复机制以非交互形式真实验证"><small>在该对话的工作区目录中运行</small><code>{view.interactive}</code><CopyText text={view.interactive} label="复制恢复命令"/></div>
      {view.once ? <details className="native-resume-once"><summary>只问一次（已用真实回合验证）</summary><div className="native-resume-row"><code>{view.once}</code><CopyText text={view.once} label="复制只问一次的命令"/></div></details> : null}
      <small className="native-resume-note">原程序首次在这个目录运行时可能先询问是否信任这个目录；接受会写入它自己的全局配置。</small>
      <small className="native-resume-note">在原程序中继续会使两边的回合交错；回到 HarnessHub 继续前，先在原程序中结束。</small>
    </> : view.note === "version-unverified" ? <small className="native-resume-note">恢复命令未在此版本验证。</small>
      : view.note === "not-verified" ? <small className="native-resume-note">这个程序的恢复命令没有经过验证。</small> : null}
  </div>;
}
