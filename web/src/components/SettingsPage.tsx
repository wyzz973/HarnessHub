import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { Bell, HardDrive, Keyboard, MessageSquare, Monitor, Moon, Palette, RefreshCw, ScanSearch, Sun, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { HUB_PROGRESS_INSTRUCTIONS } from "../../../src/contracts/table.js";
import type { LoginShellView } from "../../../src/contracts/web.js";
import { errorMessage, GatewayApi } from "../api.js";
import { cn } from "../lib/cn.js";
import { useNotificationChoice } from "../lib/notify.js";
import { DEFAULT_PREFERENCES, type Preferences } from "../lib/prefs.js";
import type { RelayPrefsState } from "../lib/use-relay.js";
import { Segmented, Spinner, Switch } from "../ui/primitives.js";
import { ShortcutList } from "./CommandPalette.js";
import { Card, Section } from "./PageShell.js";

/** One setting: what it is and what it does on the left, its control on the right; wraps under the words when narrow. */
function Row({ title, children, control, className }: { readonly title: ReactNode; readonly children?: ReactNode; readonly control?: ReactNode; readonly className?: string }) {
  return <div className={cn("flex flex-wrap items-center justify-between gap-x-6 gap-y-2.5 px-4 py-3.5", className)}>
    <div className="min-w-[min(240px,100%)] flex-1"><div className="text-ui font-medium">{title}</div>{children ? <div className="mt-0.5 text-ui-sm text-fg-2">{children}</div> : null}</div>
    {control ? <div className="flex max-w-full flex-none items-center">{control}</div> : null}
  </div>;
}
/** A card of settings whose rows are separated by hairlines. */
const ROWS = "divide-y-[0.5px] divide-line";

/**
 * Directories from the login shell's PATH (ADR-040): read only when the user asks, since that runs the shell's login
 * configuration; kept for discovery until the user removes them. Hidden where it is not offered and nothing was added.
 */
function LoginShellPanel({ api, onChanged }: { readonly api: GatewayApi; readonly onChanged: () => void }) {
  const [view, setView] = useState<LoginShellView | null | undefined>(undefined), [busy, setBusy] = useState(false), [problem, setProblem] = useState<string | null>(null);
  useEffect(() => { const controller = new AbortController(); api.loginShell(controller.signal).then(setView, () => setView(null)); return () => controller.abort(); }, [api]);
  if (view === undefined) return <p className="m-0 flex items-center gap-2 px-4 py-3.5 text-ui-sm text-fg-3"><Spinner size={12} label=""/>正在读取发现设置</p>;
  if (view === null || (!view.available && !view.dirs.length)) return <p className="m-0 px-4 py-3.5 text-ui-sm text-fg-3">这个服务没有提供从登录 shell 补充目录（例如在 CI 中，或启动时关闭了它）。</p>;
  const change = (operation: Promise<LoginShellView>) => { setBusy(true); setProblem(null); operation.then(next => { setView(next); onChanged(); }, failure => setProblem(errorMessage(failure))).finally(() => setBusy(false)); };
  return <section className="login-shell-panel flex flex-col gap-3 px-4 py-3.5" aria-label="来自登录 shell 的目录">
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2.5">
      <div className="min-w-[min(240px,100%)] flex-1"><div className="text-ui font-medium">从登录 shell 补充搜索目录</div>
        <p className="m-0 mt-0.5 text-ui-sm text-fg-2">运行你的登录 shell{view.shell ? `（${view.shell} -l）` : ""}读取 PATH，只用来找 Harness。</p></div>
      {view.available ? <button type="button" className="btn flex-none" disabled={busy} onClick={() => change(api.readLoginShell(crypto.randomUUID()))}>{busy ? <Spinner size={13} label=""/> : <RefreshCw size={14} aria-hidden="true"/>}读取并重新检测</button> : null}</div>
    {view.dirs.length ? <ul className="m-0 flex list-none flex-col gap-1 p-0">{view.dirs.map(dir => <li key={dir} className="flex items-center gap-2 rounded-row bg-inset py-1 pr-1 pl-3"><code className="min-w-0 flex-1 text-code break-all">{dir}</code><button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => change(api.removeLoginShellDirectory(dir, crypto.randomUUID()))}>移除</button></li>)}</ul>
      : view.readAt !== null ? <small className="text-ui-sm text-fg-3">登录 shell 的 PATH 没有带来新的目录。</small> : null}
    {problem ? <p className="m-0 text-ui-sm text-red" role="status">{problem}</p> : null}
  </section>;
}

const THEMES: readonly { readonly value: Preferences["theme"]; readonly label: string; readonly icon: typeof Sun }[] = [{ value: "system", label: "跟随系统", icon: Monitor }, { value: "light", label: "浅色", icon: Sun }, { value: "dark", label: "深色", icon: Moon }];
/** The frozen Harnesses' switch (ADR-050), named by this label as well. */
const FROZEN_LABEL = "显示冻结的 Harness（Cursor、Gemini CLI、Pi）";
/** The switch of what a session with the Hub's tools is told about the task list and the wrap-up (`hub.progress`). */
const PROGRESS_LABEL = "让 Harness 显示任务清单和下一步";
const PARTS = [{ id: "appearance", label: "外观", icon: Palette }, { id: "conversation", label: "对话", icon: MessageSquare }, { id: "notifications", label: "通知", icon: Bell },
  { id: "discovery", label: "发现", icon: ScanSearch }, { id: "shortcuts", label: "快捷键", icon: Keyboard }, { id: "data", label: "数据", icon: HardDrive }] as const;
/**
 * Settings (ADR-042 §5, ADR-054; a layer over the page since 2026-11-14, after the settings of T3 Code): appearance and process display of this browser,
 * notifications, discovery on this computer, every shortcut with the way to give it other keys, and where data lives. The parts stand one under the other in one
 * column, and the list on the left goes to each and marks the one in sight; on a narrow screen the column stands alone. Theme and display choices apply at once
 * and stay after a reload. Closing it leaves the page behind it as it was.
 */
export function SettingsDialog({ open, onOpenChange, api, relay, preferences, onPreference, onRescan, scanning }: {
  readonly open: boolean; readonly onOpenChange: (open: boolean) => void;
  readonly api: GatewayApi; readonly relay: RelayPrefsState; readonly preferences: Preferences; readonly onPreference: <K extends keyof Preferences>(key: K, value: Preferences[K]) => void; readonly onRescan: () => void; readonly scanning: boolean;
}) {
  const notify = useNotificationChoice();
  const column = useRef<HTMLDivElement>(null), [part, setPart] = useState<string>(PARTS[0].id);
  // The part in sight: the last one whose head has reached the top of the column (the first until one has).
  const watch = () => {
    const element = column.current;
    if (element === null) return;
    const top = element.getBoundingClientRect().top + 40, ended = element.scrollTop + element.clientHeight >= element.scrollHeight - 2;
    let seen: string = PARTS[0].id;
    for (const row of PARTS) { const head = element.querySelector<HTMLElement>("#settings-" + row.id); if (head !== null && head.getBoundingClientRect().top <= top) seen = row.id; }
    setPart(ended ? PARTS.at(-1)!.id : seen);
  };
  const go = (id: string) => { column.current?.querySelector<HTMLElement>("#settings-" + id)?.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }); setPart(id); };
  return <BaseDialog.Root open={open} onOpenChange={next => onOpenChange(next)}>
    <BaseDialog.Portal>
      <BaseDialog.Backdrop className="backdrop z-[60]"/>
      <BaseDialog.Popup className="dialog-pop settings-pop z-[61] flex h-[min(680px,calc(100dvh-48px))] w-[min(900px,calc(100vw-32px))] overflow-hidden max-sm:h-dvh max-sm:max-h-none max-sm:w-screen max-sm:flex-col max-sm:rounded-none">
        {/* Beside the column on a wide screen; on a narrow one the title, then the parts in a row under it (words only, wrapping, never scrolled sideways). */}
        <nav className="flex w-[204px] flex-none flex-col gap-0.5 bg-sidebar p-3 hairline-r max-sm:w-full max-sm:flex-row max-sm:flex-wrap max-sm:items-center max-sm:border-r-0 max-sm:pt-3 max-sm:pr-12 max-sm:pb-2 max-sm:pl-3 max-sm:hairline-b" aria-label="设置的各部分">
          <BaseDialog.Title render={<h1/>} id="settings-title" className="m-0 flex-none px-2.5 pt-1.5 pb-3 text-panel max-sm:w-full max-sm:px-1 max-sm:pt-0 max-sm:pb-1.5">设置</BaseDialog.Title>
          {PARTS.map(row => <button key={row.id} type="button" className="nav-row w-full flex-none max-sm:w-auto max-sm:px-2" aria-current={part === row.id ? "true" : undefined} onClick={() => go(row.id)}>
            <span className="flex w-4 flex-none justify-center text-fg-2 max-sm:hidden" aria-hidden="true"><row.icon size={16}/></span><span className="min-w-0 flex-1 trunc">{row.label}</span></button>)}
        </nav>
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <BaseDialog.Close className="icon-btn absolute top-3 right-3 z-10 size-7 text-fg-3 max-sm:fixed max-sm:top-2.5" aria-label="关闭设置" title="关闭"><X size={15} strokeWidth={2}/></BaseDialog.Close>
          <div ref={column} className="scroll-area flex min-h-0 flex-1 flex-col gap-8 px-6 pt-5 pb-8 max-sm:px-4" onScroll={watch}>
    <Section title="外观" id="settings-appearance">
      <Card className={ROWS}>
        <Row title="主题" control={<Segmented size="md" label="主题" value={preferences.theme} onChange={value => onPreference("theme", value)}
          options={THEMES.map(theme => ({ value: theme.value, label: <span className="inline-flex items-center gap-1.5"><theme.icon size={14} aria-hidden="true"/>{theme.label}</span> }))}/>}/>
        <Row title="对话字号" control={<Segmented label="对话字号" value={preferences.readingSize} onChange={value => onPreference("readingSize", value)} options={[{ value: "14" as const, label: "小" }, { value: "15" as const, label: "中" }, { value: "16" as const, label: "大" }]}/>}>
          消息和回复的文字大小。</Row>
        <Row title="对话宽度" control={<Segmented label="对话宽度" value={preferences.chatWidth} onChange={value => onPreference("chatWidth", value)} options={[{ value: "standard" as const, label: "标准" }, { value: "wide" as const, label: "宽" }]}/>}>
          宽一些，长代码和表格少折行。</Row>
      </Card>
    </Section>
    <Section title="对话" id="settings-conversation">
      <Card className={ROWS}>
        <Row title="过程显示" control={<Segmented label="默认过程显示" value={preferences.density} onChange={value => onPreference("density", value)}
          options={[{ value: "detailed", label: "每一步" }, { value: "compact", label: "一行小结" }, { value: "failures", label: "只留出错的" }, { value: "answer", label: "只看回答" }]}/>}>
          {preferences.density === "detailed" ? "每个动作一行，都展开。" : preferences.density === "compact" ? "一轮结束后，过程收成一行，可以点开。" : preferences.density === "failures" ? "只显示失败或结果未知的动作。" : "只显示最后说的话；过程在详情栏里。"}</Row>
        <Row title="发送" control={<Segmented label="发送" value={preferences.sendKey} onChange={value => onPreference("sendKey", value)} options={[{ value: "enter" as const, label: "Enter" }, { value: "mod-enter" as const, label: "⌘Enter" }]}/>}>
          {preferences.sendKey === "enter" ? "Enter 发送，⇧Enter 换行。" : "⌘Enter 发送，Enter 换行。"}</Row>
        <Row title="回复进行中时按回车" control={<Segmented label="回复进行中时按回车" value={preferences.whileRunning} onChange={value => onPreference("whileRunning", value)}
          options={[{ value: "queue", label: "留到结束后发" }, { value: "steer", label: "现在就告诉它" }]}/>}>
          ⌘⏎ 做另一种。只有支持中途插话的 Harness 才能现在就告诉它，其余的都留到结束后发。</Row>
        {relay.prefs === null ? null : <Row title="换 Harness 时附上之前的对话" control={<Segmented label="换 Harness 时附上之前的对话" value={relay.prefs.attach} onChange={value => relay.change("attach", value)}
          options={[{ value: "auto", label: "开（默认）", disabled: relay.saving }, { value: "off", label: "关", disabled: relay.saving }]}/>}>
          换过去的第一条消息，自动带上它没看过的部分。
          {relay.problem ? <span className="mt-1 block text-red" role="status">{relay.problem}</span> : null}</Row>}
        {relay.prefs === null ? null : <Row title={PROGRESS_LABEL} control={<Switch checked={relay.prefs.progress === "on"} onChange={value => relay.change("progress", value ? "on" : "off")} disabled={relay.saving} label={PROGRESS_LABEL}/>}>
          任务清单和每轮的小结显示在输入框上方。
          <details className="progress-instructions mt-1.5"><summary className="cursor-pointer text-fg-3">给 Harness 的说明</summary>
            <pre className="m-0 mt-1 rounded-row bg-inset px-3 py-2 text-code whitespace-pre-wrap">{HUB_PROGRESS_INSTRUCTIONS}</pre></details></Row>}
      </Card>
    </Section>
    <Section title="通知" id="settings-notifications">
      <Card className={ROWS}>
        <Row title="系统通知" control={<Switch checked={notify.on} onChange={() => void notify.toggle()} disabled={!notify.supported || notify.blocked} label="系统通知"/>}>
          页面在后台时，有事等你处理或一轮结束会通知，不含对话内容。
          {!notify.supported ? <span className="mt-1 block text-fg-3">这个浏览器不支持通知。</span> : notify.blocked ? <span className="mt-1 block text-fg-3">浏览器已阻止本页的通知，可在浏览器的网站设置中允许。</span> : null}</Row>
      </Card>
    </Section>
    <Section title="发现" id="settings-discovery">
      <Card className={ROWS}>
        <LoginShellPanel api={api} onChanged={onRescan}/>
        <Row title="重新检测" control={<button type="button" className="btn" onClick={onRescan} disabled={scanning}>{scanning ? <Spinner size={13} label=""/> : <RefreshCw size={14} aria-hidden="true"/>}立即检测</button>}>
          在终端里装好或升级 Harness 之后用。</Row>
        {/* Cursor, Gemini CLI and Pi are frozen (ADR-048): listed for new work only when the user asks (ADR-050). */}
        <Row className="frozen-setting" title={FROZEN_LABEL} control={<Switch checked={preferences.showFrozen} onChange={value => onPreference("showFrozen", value)} label={FROZEN_LABEL}/>}>
          不再打磨的 Harness；用过它们的对话照常打开。</Row>
      </Card>
    </Section>
    <Section title="快捷键" id="settings-shortcuts">
      <Card className="px-3 py-3"><ShortcutList editable/></Card>
    </Section>
    <Section title="数据" id="settings-data">
      <Card className={ROWS}>
        <div className="px-4 py-3.5 text-ui-sm text-fg-2">对话和附件保存在这台 Mac 上；各 Harness 的配置和登录留在原处，HarnessHub 不改。</div>
        <Row title="显示偏好" control={<button type="button" className="btn btn-sm" onClick={() => (Object.keys(DEFAULT_PREFERENCES) as (keyof Preferences)[]).forEach(key => onPreference(key, DEFAULT_PREFERENCES[key] as never))}>恢复默认</button>}>
          主题、过程显示和面板回到默认。</Row>
      </Card>
    </Section>
          </div>
        </div>
      </BaseDialog.Popup>
    </BaseDialog.Portal>
  </BaseDialog.Root>;
}
