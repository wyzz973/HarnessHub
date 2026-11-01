import { Popover as BasePopover } from "@base-ui/react/popover";
import { ArrowRight, Check, ChevronDown, Folder, RefreshCw } from "lucide-react";
import { useId, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import type { HarnessReadinessView, HarnessView } from "../../../src/contracts/web.js";
import { cn } from "../lib/cn.js";
import { folderName, homePath } from "../lib/format.js";
import { Popover, PopHead } from "../ui/overlay.js";
import { motionStyle } from "../ui/motion.js";
import { Badge } from "../ui/primitives.js";
import { BrandIcon } from "./BrandIcon.js";
import { readinessStatus } from "./Composer.js";

const SOURCE: Readonly<Record<string, string>> = { managed: "HarnessHub 管理", system: "本机安装", missing: "未安装" };
const TONE = { success: "accent", warning: "amber", danger: "red" } as const;

interface WelcomeProps {
  readonly harnesses: readonly HarnessView[]; readonly readiness: readonly HarnessReadinessView[]; readonly firstUse: boolean; readonly selected: string;
  readonly workspace: string; readonly onWorkspace: (value: string) => void; readonly onChoose: (harness: HarnessView) => void; readonly onSuggest: (text: string) => void;
  readonly onHarnesses: () => void; readonly onSettings: () => void; readonly onRescan: () => void; readonly scanning: boolean; readonly composer: ReactNode;
}
/**
 * The start of a new conversation (Main board): a greeting, who is ready from the latest readiness facts (and who needs the
 * user), the workspace, then the composer. Opening the summary lists every available Agent with its version and state and
 * chooses one. The first time, the summary and the workspace become three steps — what was found, where it works, a first
 * question — with nothing to fill in. Only facts the Gateway gave are shown: no Git branch, nothing estimated.
 */
export function Welcome({ harnesses, readiness, firstUse, selected, workspace, onWorkspace, onChoose, onSuggest, onHarnesses, onSettings, onRescan, scanning, composer }: WelcomeProps) {
  const available = harnesses.filter(harness => harness.controls.some(control => control.available));
  const status = (harness: HarnessView) => {
    const control = harness.controls.find(item => item.id === harness.defaultControlId && item.available) ?? harness.controls.find(item => item.available);
    return readinessStatus(harness, readiness.find(item => item.harnessId === harness.id && item.controlId === control?.id));
  };
  // Needing the user: found but its control entry is not ready, or its latest read said to sign in or failed.
  const attention = harnesses.filter(harness => !available.includes(harness) ? harness.installed : status(harness)?.tone === "warning" || status(harness)?.tone === "danger");
  const ready = available.filter(harness => !attention.includes(harness));
  const found = [...ready, ...attention];
  const missing = harnesses.filter(harness => !harness.installed && !available.includes(harness)).length;
  const [listOpen, setListOpen] = useState(false);
  // Opened from the keyboard (⇧⌘O), the page is simply there (Motion board #37); decided once, so a later pointer event
  // does not start the entrance over.
  const [enter] = useState(() => document.documentElement.dataset.input === "keyboard" ? undefined : "motion-enter");
  const list = (trigger: ReactElement) => <AgentList trigger={trigger} open={listOpen} onOpenChange={setListOpen} harnesses={available} status={status} selected={selected} firstUse={firstUse}
    missing={missing} onChoose={onChoose} onHarnesses={onHarnesses} onSettings={onSettings} onRescan={onRescan} scanning={scanning}/>;
  const attentionText = attention.length === 1 ? `${attention[0]!.name} 需要处理` : attention.length === 2 ? `${attention[0]!.name}、${attention[1]!.name} 需要处理` : `${attention.length} 个 Agent 需要处理`;
  return <div className="welcome mx-auto flex min-h-full w-full max-w-[760px] flex-col justify-center pt-8 pb-[min(150px,16vh)]">
    <h2 className={cn(enter, "m-0 text-center text-[24px] leading-8 font-medium tracking-[-0.02em] text-balance sm:text-greeting sm:leading-[42px]")}>今天想让哪个 Agent 做什么？</h2>
    {firstUse ? <ol className="m-0 mt-6 mb-6 grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-3" aria-label="开始使用">
      <Step index={1} enter={enter} title={found.length ? `找到了 ${found.length} 个 Agent` : "还没有找到 Agent"} text={found.length ? "用你已经装好的，登录和模型都沿用原来的。" : "装好之后点“重新检测”，或从登录 shell 补充目录。"}>
        {found.length ? list(<button type="button" className="agent-summary row -mx-1 flex min-h-[30px] flex-wrap items-center gap-1.5 self-start border-none bg-transparent px-1 py-1" aria-label={`查看找到的 ${found.length} 个 Agent`}>
          {found.slice(0, 8).map(harness => <BrandIcon key={harness.id} brand={harness.id} name={harness.name} size={22} className={cn(!ready.includes(harness) && "opacity-45")}/>)}
          {found.length > 8 ? <span className="text-caption text-fg-3">+{found.length - 8}</span> : null}</button>)
          : <button type="button" className="btn btn-sm self-start" onClick={onRescan} disabled={scanning}><RefreshCw size={12} className={cn(scanning && "spin")} aria-hidden="true"/>重新检测</button>}
      </Step>
      <Step index={2} enter={enter} title="选一个项目文件夹" text="Agent 在这里读写文件。以后每个对话都可以换。">
        <WorkspaceEditor workspace={workspace} onWorkspace={onWorkspace} trigger={<button type="button" className="h-[30px] w-full min-w-0 truncate rounded-row border-none bg-surface px-2.5 text-left text-caption text-fg-2 shadow-hairline transition-[color,background-color] duration-120 ease-standard hover:text-fg" title={workspace}>{homePath(workspace) || "填写工作目录"}</button>}/>
      </Step>
      <Step index={3} enter={enter} title="开始第一段对话" text="给一个现成的问题，回车就能看到效果。">
        <button type="button" className="press h-[30px] self-start rounded-full border-none bg-transparent px-3 text-caption text-fg-2 shadow-[inset_0_0_0_1px_var(--border-strong)] transition-[color,background-color,transform] duration-120 ease-standard hover:bg-subtle hover:text-fg" onClick={() => onSuggest("讲讲这个项目的结构")}>讲讲这个项目的结构</button>
      </Step>
    </ol> : <>
      <div className={cn(enter, "mt-3 mb-7 flex flex-wrap items-center justify-center gap-x-2.5 gap-y-1 text-ui-sm text-fg-3")} style={enter ? motionStyle({ delay: 40 }) : undefined}>
        {/* The summary's own padding is taken back from the row's gaps, so the dot sits 10 px from the words on both sides. */}
        {available.length ? list(<button type="button" className="agent-summary row -mx-1.5 flex h-7 items-center gap-2.5 border-none bg-transparent px-1.5 text-ui-sm text-fg-3 hover:text-fg-2" title="查看本机的 Agent">
          <span className="flex items-center" aria-hidden="true">{found.slice(0, 6).map((harness, index) => <BrandIcon key={harness.id} brand={harness.id} name={harness.name} size={22} className={cn("outline-2 outline-app", index > 0 && "-ml-1.5")}/>)}</span>
          <span>{ready.length} 个 Agent 就绪</span></button>)
          : <span>这台电脑上还没有找到可用的 Agent</span>}
        {attention.length ? <><span aria-hidden="true" className="max-sm:hidden">·</span><button type="button" className="link-btn font-normal text-amber hover:text-amber" onClick={onHarnesses}>{attentionText}</button></>
          : available.length ? null : <><span aria-hidden="true" className="max-sm:hidden">·</span><button type="button" className="link-btn font-normal" onClick={onHarnesses}>查看安装方式</button></>}
      </div>
      <div className="flex items-center gap-0.5 px-2 pb-2">
        <WorkspaceEditor workspace={workspace} onWorkspace={onWorkspace} trigger={<button type="button" className="flex h-[30px] max-w-full min-w-0 items-center gap-1.5 rounded-row border-none bg-transparent px-2 text-ui-sm font-medium text-fg transition-[color,background-color] duration-120 ease-standard hover:bg-subtle data-[popup-open]:bg-subtle" title={workspace}>
          <Folder size={15} className="flex-none text-fg-2" aria-hidden="true"/><span className="min-w-0 truncate">{folderName(workspace) || "选择工作区"}</span><ChevronDown size={12} strokeWidth={2} className="flex-none text-fg-3" aria-hidden="true"/></button>}/>
      </div>
    </>}
    {composer}
  </div>;
}

/** One of the three first steps (Interaction board): its number, what it does, and the one thing to press. */
function Step({ index, enter, title, text, children }: { readonly index: number; readonly enter: string | undefined; readonly title: string; readonly text: string; readonly children: ReactNode }) {
  return <li className={cn(enter, "flex min-w-0 flex-col gap-2.5 rounded-card bg-subtle p-4")} style={enter ? motionStyle({ delay: index * 40 }) : undefined}>
    <span className="text-[11px] leading-4 font-semibold text-accent-text">{index} / 3</span>
    <span className="text-[15px] leading-[22px] font-semibold">{title}</span>
    <span className="text-caption text-fg-2">{text}</span>
    {children}
  </li>;
}

/** The new conversation's workspace: the folder by name, its full path to change in place. */
function WorkspaceEditor({ workspace, onWorkspace, trigger }: { readonly workspace: string; readonly onWorkspace: (value: string) => void; readonly trigger: ReactElement }) {
  const field = useRef<HTMLInputElement>(null), hint = useId();
  const relative = workspace.trim() !== "" && !workspace.startsWith("/") && !/^[A-Za-z]:[\\/]/u.test(workspace);
  return <Popover label="新对话的工作区" side="bottom" align="start" className="w-[420px] max-w-[calc(100vw-24px)]" initialFocus={field} trigger={trigger}>
    <PopHead title="新对话的工作区" closeLabel="完成"/>
    <div className="flex flex-col gap-2 p-3.5">
      <input ref={field} aria-label="新对话工作目录" aria-describedby={hint} value={workspace} onChange={event => onWorkspace(event.target.value)} placeholder="工作目录的绝对路径" className="field mono text-code"
        onKeyDown={event => { if (event.key === "Enter" && !event.nativeEvent.isComposing) event.currentTarget.blur(); }}/>
      <p id={hint} className={cn("m-0 text-caption", relative ? "text-amber" : "text-fg-3")}>{relative ? "需要绝对路径，例如 /Users/you/project。" : "Agent 在这里读写文件。以后每个对话都可以换。"}</p>
    </div>
  </Popover>;
}

/**
 * The Agents found on this computer, listed from the summary: each with its version as a fact (ADR-053), where it came
 * from and its latest readiness; choosing one starts the new conversation with it and returns to the message.
 */
function AgentList({ trigger, open, onOpenChange, harnesses, status, selected, firstUse, missing, onChoose, onHarnesses, onSettings, onRescan, scanning }: {
  readonly trigger: ReactElement; readonly open: boolean; readonly onOpenChange: (open: boolean) => void; readonly harnesses: readonly HarnessView[];
  readonly status: (harness: HarnessView) => ReturnType<typeof readinessStatus>; readonly selected: string; readonly firstUse: boolean; readonly missing: number;
  readonly onChoose: (harness: HarnessView) => void; readonly onHarnesses: () => void; readonly onSettings: () => void; readonly onRescan: () => void; readonly scanning: boolean;
}) {
  const chose = useRef(false), popup = useRef<HTMLDivElement>(null);
  return <BasePopover.Root open={open} onOpenChange={next => { if (next) chose.current = false; onOpenChange(next); }}>
    <BasePopover.Trigger render={trigger}/>
    <BasePopover.Portal>
      <BasePopover.Positioner side="bottom" align="center" sideOffset={8} collisionPadding={12} positionMethod="fixed" className="hh-positioner z-50">
        <BasePopover.Popup aria-label="本机的 Agent" ref={popup} finalFocus={() => {
          const focused = document.activeElement;
          if (focused !== null && focused !== document.body && !popup.current?.contains(focused)) return false;
          return chose.current ? document.getElementById("message-input") : true;
        }}
          className="surface-pop flex max-h-[min(520px,var(--available-height))] w-[380px] max-w-[calc(100vw-24px)] flex-col overflow-hidden">
          <section aria-label="本机发现的 Agent" className="flex min-h-0 flex-col">
            <div className="flex items-baseline justify-between gap-3 px-3.5 pt-3 pb-1.5">
              <h3 className="m-0 text-ui-sm font-semibold">本机可用的 Agent</h3>
              <button type="button" className="link-btn flex items-center gap-1 text-caption" onClick={() => { onOpenChange(false); onHarnesses(); }}>查看全部<ArrowRight size={12} aria-hidden="true"/></button>
            </div>
            {firstUse ? <p className="m-0 px-3.5 pb-2 text-caption text-fg-2">HarnessHub 直接使用它们本机的安装、模型配置和登录状态，不复制、不修改。登录是否有效、额度是否够用，会在第一次使用时由各自核实。</p> : null}
            <div className="scroll-area flex min-h-0 flex-col gap-0.5 p-[5px] pt-0">{harnesses.map(harness => {
              const state = status(harness), version = harness.management.programVersion ?? harness.management.installedVersion;
              return <button key={harness.id} type="button" aria-label={`选择 ${harness.name}`} aria-pressed={selected === harness.id}
                onClick={() => { chose.current = true; onChoose(harness); onOpenChange(false); }}
                className="row flex w-full items-center gap-3 rounded-[9px] border-none bg-transparent px-2.5 py-2 text-left">
                <BrandIcon brand={harness.id} name={harness.name} size={28}/>
                <span className="flex min-w-0 flex-1 flex-col"><strong className="trunc text-ui font-medium">{harness.name}</strong>
                  <span className="trunc text-caption text-fg-3">{[version ?? null, SOURCE[harness.management.source] ?? null].filter(Boolean).join(" · ")}</span></span>
                {state ? <Badge tone={TONE[state.tone]} dot {...(state.title ? { title: state.title } : {})}>{state.label}</Badge> : null}
                <Check size={15} strokeWidth={2.2} className={cn("flex-none text-accent-text", selected !== harness.id && "invisible")} aria-hidden="true"/>
              </button>;
            })}</div>
            {firstUse ? <div className="flex flex-wrap items-center gap-2 px-3.5 py-2.5 text-caption text-fg-2 hairline-t">
              <span className="w-full">没找到你装的某个 Agent？可能它在登录 shell 的 PATH 里，或者是自定义安装。</span>
              <button type="button" className="btn btn-sm" onClick={() => { onOpenChange(false); onSettings(); }}>从登录 shell 补充目录</button>
              <button type="button" className="btn btn-sm" onClick={onRescan} disabled={scanning}><RefreshCw size={12} className={cn(scanning && "spin")} aria-hidden="true"/>重新检测</button>
            </div> : null}
            {missing > 0 ? <p className="m-0 px-3.5 py-2.5 text-caption text-fg-3 hairline-t">另有 {missing} 个 Agent 在目录中但未安装，可以在 Agent 页查看官方安装方式。HarnessHub 不会替你运行安装命令。</p> : null}
          </section>
        </BasePopover.Popup>
      </BasePopover.Positioner>
    </BasePopover.Portal>
  </BasePopover.Root>;
}
