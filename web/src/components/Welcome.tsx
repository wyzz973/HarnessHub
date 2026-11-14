import { ChevronDown, Folder, FolderOpen, GitBranchPlus, MessageCircle } from "lucide-react";
import { useRef, useState } from "react";
import type { ReactNode } from "react";
import type { HarnessReadinessView, HarnessView } from "../../../src/contracts/web.js";
import { cn } from "../lib/cn.js";
import { folderName, homePath } from "../lib/format.js";
import { Menu, Popover } from "../ui/overlay.js";
import { motionStyle } from "../ui/motion.js";
import { Segmented, Spinner, Tip } from "../ui/primitives.js";
import { readinessStatus } from "./Composer.js";

/**
 * Where a new conversation works: in a folder of the user's (a project), or in none (the Gateway gives it one of its own). In a project it may work in a git worktree
 * of its own (`worktree`, the user's decision of 2026-11-14 after T3 Code): a branch and a folder made for it, so Harnesses can change one repository side by side.
 */
export interface Place { readonly scratch: boolean; readonly workspace: string; readonly worktree?: boolean }

interface WelcomeProps {
  readonly harnesses: readonly HarnessView[]; readonly readiness: readonly HarnessReadinessView[];
  readonly place: Place; readonly onPlace: (place: Place) => void;
  /** Folders of earlier conversations, newest first. */
  readonly recents: readonly string[];
  /** Shows the system's folder dialog; null when it was cancelled, a rejection when this computer cannot show one. */
  readonly chooseFolder: (start: string | undefined) => Promise<string | null>;
  readonly onHarnesses: () => void; readonly composer: ReactNode;
}
/**
 * The start of a new conversation: a greeting, the composer, and under it where the conversation works — a quick chat
 * without a folder, or a project folder picked from the recent ones or with the system's own dialog. A Harness that needs
 * the user is said in one line; when all are ready nothing is.
 */
export function Welcome({ harnesses, readiness, place, onPlace, recents, chooseFolder, onHarnesses, composer }: WelcomeProps) {
  const available = harnesses.filter(harness => harness.controls.some(control => control.available));
  const tone = (harness: HarnessView) => {
    const control = harness.controls.find(item => item.id === harness.defaultControlId && item.available) ?? harness.controls.find(item => item.available);
    return readinessStatus(harness, readiness.find(item => item.harnessId === harness.id && item.controlId === control?.id))?.tone;
  };
  // Needing the user: found but its control entry is not ready, or its latest read said to sign in or failed.
  const attention = harnesses.filter(harness => !available.includes(harness) ? harness.installed : tone(harness) === "warning" || tone(harness) === "danger");
  // Opened from the keyboard (⇧⌘O), the page is simply there (Motion board #37); decided once, so a later pointer event
  // does not start the entrance over.
  const [enter] = useState(() => document.documentElement.dataset.input === "keyboard" ? undefined : "motion-enter");
  const note = available.length === 0 ? "这台 Mac 上还没有可用的 Harness" : attention.length === 1 ? `${attention[0]!.name} 需要处理` : attention.length > 1 ? `${attention.length} 个 Harness 需要处理` : null;
  return <div className="welcome mx-auto flex min-h-full w-full max-w-[760px] flex-col justify-center pt-8 pb-[min(150px,16vh)]">
    <h2 className={cn(enter, "m-0 mb-7 text-center text-[24px] leading-8 font-medium tracking-[-0.02em] text-balance sm:text-greeting sm:leading-[42px]")}>今天想让哪个 Harness 做什么？</h2>
    {note ? <p className={cn(enter, "-mt-4 mb-6 text-center text-ui-sm")} style={enter ? motionStyle({ delay: 40 }) : undefined}>
      <button type="button" className={cn("link-btn font-normal", available.length ? "text-amber hover:text-amber" : "")} onClick={onHarnesses}>{note}</button></p> : null}
    {composer}
    <PlacePicker place={place} onPlace={onPlace} recents={recents} chooseFolder={chooseFolder}/>
  </div>;
}

/**
 * Where the new conversation works, in the row under the composer: 临时对话 needs no folder; 项目 names the folder, opens the
 * recent ones, and asks the system's dialog for another. A computer that cannot show the dialog gets a field for the path.
 */
function PlacePicker({ place, onPlace, recents, chooseFolder }: Pick<WelcomeProps, "place" | "onPlace" | "recents" | "chooseFolder">) {
  const [choosing, setChoosing] = useState(false), [typing, setTyping] = useState(false);
  const chip = useRef<HTMLButtonElement>(null), field = useRef<HTMLInputElement>(null);
  const pick = () => {
    if (choosing) return;
    setChoosing(true);
    chooseFolder(place.workspace || undefined).then(path => { if (path !== null) onPlace({ scratch: false, workspace: path }); }, () => setTyping(true)).finally(() => setChoosing(false));
  };
  const folders = [...new Set([place.workspace, ...recents].filter(path => path.trim() !== ""))].slice(0, 8);
  const label = (text: string, icon: ReactNode) => <span className="flex items-center gap-1.5">{icon}{text}</span>;
  return <div className="place-picker mt-2.5 flex min-h-7 flex-wrap items-center gap-x-1.5 gap-y-1 px-1">
    <Segmented label="对话在哪里进行" value={place.scratch ? "scratch" : "project"} onChange={value => onPlace({ ...place, scratch: value === "scratch" })}
      options={[{ value: "scratch", label: label("临时对话", <MessageCircle size={13} aria-hidden="true"/>) }, { value: "project", label: label("项目", <Folder size={13} aria-hidden="true"/>) }]}/>
    {place.scratch ? null : <Menu align="start" className="max-w-[min(420px,calc(100vw-24px))]"
      trigger={<button ref={chip} type="button" aria-label={"项目文件夹：" + (folderName(place.workspace) || "未选择")} title={place.workspace}
        className="motion-fade-in flex h-7 max-w-full min-w-0 items-center gap-1 rounded-row border-none bg-transparent px-2 text-ui-sm text-fg transition-[color,background-color] duration-120 ease-standard hover:bg-subtle data-[popup-open]:bg-subtle">
        <span className="min-w-0 truncate">{folderName(place.workspace) || "选择文件夹"}</span>
        {choosing ? <Spinner size={12} label="正在等你选择文件夹"/> : <ChevronDown size={12} strokeWidth={2} className="flex-none text-fg-3" aria-hidden="true"/>}</button>}
      items={[
        ...folders.map(path => ({ icon: <Folder size={14}/>, label: <span className="block max-w-[200px] truncate">{folderName(path)}</span>,
          hint: <span className="block max-w-[180px] truncate" title={path}>{homePath(path.replace(/\/[^/]*\/*$/u, "")) || "/"}</span>,
          checked: path === place.workspace, onSelect: () => onPlace({ scratch: false, workspace: path }) })),
        ...(folders.length ? [{ separator: true as const }] : []),
        { icon: <FolderOpen size={14}/>, label: "选择文件夹…", onSelect: pick },
      ]}/>}
    {/* Its own worktree, or the folder as it is (the default): the Gateway makes a branch and a folder for the conversation from the repository's current commit. */}
    {place.scratch || !place.workspace ? null : <Tip label={place.worktree ? "新建工作树：开（为这段对话新建分支和文件夹，几家 Harness 可以同时改同一个仓库）" : "新建工作树：关（就在这个文件夹里改）"}>
      <button type="button" className={cn("motion-fade-in flex h-7 flex-none items-center gap-1 rounded-row border-none bg-transparent px-2 text-ui-sm transition-[color,background-color] duration-120 ease-standard hover:bg-subtle",
        place.worktree ? "bg-accent-soft text-accent-text hover:bg-accent-soft" : "text-fg-3")} aria-pressed={place.worktree === true} aria-label="新建工作树" onClick={() => onPlace({ ...place, worktree: !place.worktree })}>
        <GitBranchPlus size={13} aria-hidden="true"/><span>新建工作树</span></button></Tip>}
    <Popover label="项目文件夹的路径" open={typing} onOpenChange={setTyping} anchor={chip} side="bottom" align="start" className="w-[420px] max-w-[calc(100vw-24px)]" initialFocus={field}>
      <form className="flex items-center gap-2 p-2.5" onSubmit={event => {
        event.preventDefault();
        const value = field.current?.value.trim() ?? "";
        if (value.startsWith("/")) { onPlace({ scratch: false, workspace: value }); setTyping(false); }
      }}>
        <input ref={field} aria-label="项目文件夹的路径" defaultValue={place.workspace} placeholder="/Users/you/project" className="field mono min-w-0 flex-1 text-code"/>
        <button type="submit" className="btn btn-primary flex-none">好</button>
      </form>
    </Popover>
  </div>;
}
