import { Monitor, Moon, RefreshCw, Sun } from "lucide-react";
import { useEffect, useState } from "react";
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
import { Card, PageShell, Section } from "./PageShell.js";

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
/**
 * Settings (ADR-042 §5, ADR-054): appearance and process display of this browser, notifications, discovery on this
 * computer, every shortcut, and where data lives. Theme and display choices apply at once and stay after a reload.
 */
export function SettingsPage({ api, relay, preferences, onPreference, onRescan, scanning, onMenu, sidebarHidden, onExpandSidebar, onChat }: {
  readonly api: GatewayApi; readonly relay: RelayPrefsState; readonly preferences: Preferences; readonly onPreference: <K extends keyof Preferences>(key: K, value: Preferences[K]) => void; readonly onRescan: () => void; readonly scanning: boolean;
  readonly onMenu: () => void; readonly sidebarHidden: boolean; readonly onExpandSidebar: () => void; readonly onChat: () => void;
}) {
  const notify = useNotificationChoice();
  return <PageShell title="设置" titleId="settings-title" onMenu={onMenu} sidebarHidden={sidebarHidden} onExpandSidebar={onExpandSidebar} onBack={onChat}>
    <Section title="外观">
      <Card className={ROWS}>
        <Row title="主题" control={<Segmented size="md" label="主题" value={preferences.theme} onChange={value => onPreference("theme", value)}
          options={THEMES.map(theme => ({ value: theme.value, label: <span className="inline-flex items-center gap-1.5"><theme.icon size={14} aria-hidden="true"/>{theme.label}</span> }))}/>}/>
      </Card>
    </Section>
    <Section title="对话">
      <Card className={ROWS}>
        <Row title="过程显示" control={<Segmented label="默认过程显示" value={preferences.density} onChange={value => onPreference("density", value)} options={[{ value: "compact", label: "简洁" }, { value: "detailed", label: "详细" }]}/>}>
          简洁时，每轮的动作收成一行摘要。</Row>
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
    <Section title="通知">
      <Card className={ROWS}>
        <Row title="系统通知" control={<Switch checked={notify.on} onChange={() => void notify.toggle()} disabled={!notify.supported || notify.blocked} label="系统通知"/>}>
          页面在后台时，有事等你处理或一轮结束会通知，不含对话内容。
          {!notify.supported ? <span className="mt-1 block text-fg-3">这个浏览器不支持通知。</span> : notify.blocked ? <span className="mt-1 block text-fg-3">浏览器已阻止本页的通知，可在浏览器的网站设置中允许。</span> : null}</Row>
      </Card>
    </Section>
    <Section title="发现">
      <Card className={ROWS}>
        <LoginShellPanel api={api} onChanged={onRescan}/>
        <Row title="重新检测" control={<button type="button" className="btn" onClick={onRescan} disabled={scanning}>{scanning ? <Spinner size={13} label=""/> : <RefreshCw size={14} aria-hidden="true"/>}立即检测</button>}>
          在终端里装好或升级 Harness 之后用。</Row>
        {/* Cursor, Gemini CLI and Pi are frozen (ADR-048): listed for new work only when the user asks (ADR-050). */}
        <Row className="frozen-setting" title={FROZEN_LABEL} control={<Switch checked={preferences.showFrozen} onChange={value => onPreference("showFrozen", value)} label={FROZEN_LABEL}/>}>
          不再打磨的 Harness；用过它们的对话照常打开。</Row>
      </Card>
    </Section>
    <Section title="快捷键">
      <Card className="px-3 py-3"><ShortcutList/></Card>
    </Section>
    <Section title="数据">
      <Card className={ROWS}>
        <div className="px-4 py-3.5 text-ui-sm text-fg-2">对话和附件保存在这台 Mac 上；各 Harness 的配置和登录留在原处，HarnessHub 不改。</div>
        <Row title="显示偏好" control={<button type="button" className="btn btn-sm" onClick={() => (Object.keys(DEFAULT_PREFERENCES) as (keyof Preferences)[]).forEach(key => onPreference(key, DEFAULT_PREFERENCES[key] as never))}>恢复默认</button>}>
          主题、过程显示和面板回到默认。</Row>
      </Card>
    </Section>
  </PageShell>;
}
