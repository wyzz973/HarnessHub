import { ArrowRight, Bug, FolderOpen, FolderSearch, RefreshCw, SquareTerminal } from "lucide-react";
import type { ReactNode } from "react";
import type { HarnessReadinessView, HarnessView } from "../../../src/contracts/web.js";
import { cn } from "../lib/cn.js";
import { Badge, LogoMark } from "../ui/primitives.js";
import { BrandIcon } from "./BrandIcon.js";
import { readinessStatus } from "./Composer.js";

const SOURCE: Readonly<Record<string, string>> = { managed: "HarnessHub 管理", system: "本机安装", missing: "未安装" };

/**
 * A new conversation: what to ask, which Harness answers and where it works. On first use it also says what was found on
 * this computer, and that each Harness keeps its own installation, configuration and sign-in.
 */
export function Welcome({ harnesses, readiness, firstUse, selected, workspace, onWorkspace, onChoose, onSuggest, onHarnesses, onSettings, onRescan, scanning, composer }: {
  readonly harnesses: readonly HarnessView[]; readonly readiness: readonly HarnessReadinessView[]; readonly firstUse: boolean; readonly selected: string;
  readonly workspace: string; readonly onWorkspace: (value: string) => void; readonly onChoose: (harness: HarnessView) => void; readonly onSuggest: (text: string) => void;
  readonly onHarnesses: () => void; readonly onSettings: () => void; readonly onRescan: () => void; readonly scanning: boolean; readonly composer: ReactNode;
}) {
  const available = harnesses.filter(harness => harness.controls.some(control => control.available));
  const missing = harnesses.length - available.length;
  return <div className="welcome mx-auto flex w-full max-w-[760px] flex-col gap-6 px-1 pt-[min(12vh,96px)] pb-10">
    <div className="enter flex flex-col items-center gap-3 text-center">
      <LogoMark size={36}/>
      <h2 className="m-0 text-[22px] font-semibold tracking-[-0.015em] sm:text-[26px]">今天想让哪个 Agent 做什么？</h2>
      <p className="m-0 max-w-[520px] text-[13.5px] text-fg-2">每个 Agent 都用它在这台电脑上的安装、模型配置和登录状态。对话中途可以换人接手，历史一直在这里。</p>
    </div>
    <div className="flex flex-col gap-2">
      {composer}
      <label className="flex min-w-0 items-center gap-2 self-start rounded-lg px-2 py-1 text-[12.5px] text-fg-2 hover:bg-hover" title={workspace}>
        <FolderOpen size={14} className="flex-none text-fg-3" aria-hidden="true"/><span className="flex-none">工作区</span>
        <input aria-label="新对话工作目录" value={workspace} onChange={event => onWorkspace(event.target.value)} placeholder="工作目录的绝对路径" className="mono w-[min(460px,60vw)] min-w-0 border-none bg-transparent text-[12.5px] text-fg outline-none"/>
      </label>
    </div>
    <div className="flex flex-wrap justify-center gap-2">
      {[{ text: "理解一个项目", icon: FolderSearch }, { text: "帮我完成实现", icon: SquareTerminal }, { text: "排查一个问题", icon: Bug }].map(({ text, icon: Icon }) =>
        <button key={text} type="button" onClick={() => onSuggest(text)} className="flex h-8 items-center gap-1.5 rounded-full border border-line bg-surface px-3 text-[12.5px] text-fg-2 shadow-sm hover:bg-hover hover:text-fg"><Icon size={14} aria-hidden="true"/>{text}</button>)}
    </div>
    <section className="flex flex-col gap-2.5" aria-label="本机发现的 Harness">
      <div className="flex items-baseline justify-between gap-3 px-1">
        <h3 className="m-0 text-[13px] font-semibold">{firstUse ? `在这台电脑上找到 ${available.length} 个 Harness` : "本机可用"}</h3>
        <button type="button" className="link-btn text-[12.5px]" onClick={onHarnesses}>查看全部 <ArrowRight size={12} className="inline" aria-hidden="true"/></button>
      </div>
      {firstUse ? <p className="m-0 px-1 text-[12.5px] text-fg-2">HarnessHub 直接使用它们本机的安装、模型配置和登录状态，不复制、不修改。登录是否有效、额度是否够用，会在第一次使用时由各自核实。</p> : null}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">{available.map(harness => {
        const control = harness.controls.find(item => item.id === harness.defaultControlId && item.available) ?? harness.controls.find(item => item.available);
        const status = readinessStatus(harness, readiness.find(item => item.harnessId === harness.id && item.controlId === control?.id));
        const version = harness.management.programVersion ?? harness.management.installedVersion;
        return <button key={harness.id} type="button" aria-label={`选择 ${harness.name}`} aria-pressed={selected === harness.id} onClick={() => onChoose(harness)}
          className={cn("flex items-center gap-3 rounded-xl border bg-surface px-3 py-2.5 text-left shadow-sm transition-[border-color,box-shadow] duration-150 hover:border-line-strong", selected === harness.id ? "border-accent ring-2 ring-accent-soft" : "border-line")}>
          <BrandIcon brand={harness.id} name={harness.name} size={28}/>
          <span className="flex min-w-0 flex-1 flex-col"><strong className="trunc text-[13.5px] font-semibold">{harness.name}</strong>
            <span className="trunc text-[12px] text-fg-3">{[version ? "v" + version : null, SOURCE[harness.management.source] ?? null].filter(Boolean).join(" · ")}</span></span>
          {status ? <Badge tone={status.tone === "success" ? "green" : status.tone === "warning" ? "amber" : "red"} dot {...(status.title ? { title: status.title } : {})}>{status.label}</Badge> : null}
        </button>;
      })}</div>
      {firstUse ? <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-dashed border-line-strong px-3.5 py-2.5 text-[12.5px] text-fg-2">
        <span className="min-w-0 flex-1">没找到你装的某个 Harness？可能它在登录 shell 的 PATH 里，或者是自定义安装。</span>
        <button type="button" className="btn btn-sm" onClick={onSettings}>从登录 shell 补充目录</button>
        <button type="button" className="btn btn-sm" onClick={onRescan} disabled={scanning}><RefreshCw size={12} className={cn(scanning && "spin")} aria-hidden="true"/>重新检测</button>
      </div> : null}
      {missing > 0 ? <p className="m-0 px-1 text-[12px] text-fg-3">另有 {missing} 个 Harness 在目录中但未安装，可以在“我的 Agent”里查看官方安装方式。HarnessHub 不会替你运行安装命令。</p> : null}
    </section>
  </div>;
}
