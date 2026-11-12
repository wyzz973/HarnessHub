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
        <p className="m-0 mt-0.5 text-ui-sm text-fg-2">会执行你的 shell 登录配置{view.shell ? `（${view.shell} -l）` : ""}来读取 PATH；新增的目录只用于发现 Harness，不改变 HarnessHub 自己的环境。只运行列在 /etc/shells 中的 shell：用 Homebrew 等方式安装、没有加入这个文件的 shell 会被拒绝。</p></div>
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
  return <PageShell title="设置" titleId="settings-title" onMenu={onMenu} sidebarHidden={sidebarHidden} onExpandSidebar={onExpandSidebar} onBack={onChat}
    description="外观和通知只影响这个浏览器；发现用的目录由本机服务保存。">
    <Section title="外观">
      <Card className={ROWS}>
        <Row title="主题" control={<Segmented size="md" label="主题" value={preferences.theme} onChange={value => onPreference("theme", value)}
          options={THEMES.map(theme => ({ value: theme.value, label: <span className="inline-flex items-center gap-1.5"><theme.icon size={14} aria-hidden="true"/>{theme.label}</span> }))}/>}>
          跟随系统时，随 macOS 的浅色与深色一起切换；选好后刷新页面也不变。</Row>
      </Card>
    </Section>
    <Section title="对话">
      <Card className={ROWS}>
        <Row title="过程显示" control={<Segmented label="默认过程显示" value={preferences.density} onChange={value => onPreference("density", value)} options={[{ value: "compact", label: "简洁" }, { value: "detailed", label: "详细" }]}/>}>
          简洁：每轮的工具与思考收成一行摘要，失败和未完成的步骤仍写在摘要里。详细：全部展开。</Row>
        {relay.prefs === null ? null : <Row title="换 Harness 时附上之前的对话" control={<Segmented label="换 Harness 时附上之前的对话" value={relay.prefs.attach} onChange={value => relay.change("attach", value)}
          options={[{ value: "auto", label: "开（默认）", disabled: relay.saving }, { value: "off", label: "关", disabled: relay.saving }]}/>}>
          开：对话换到另一个 Harness 后的第一条消息，自动附上它没看过的部分；第一次交给某个 Harness 时，会在输入框上方说明一句。关：消息只发原话，需要时可以在输入框上方逐条选择附上。这项设置属于本机网关，对所有浏览器生效。
          {relay.problem ? <span className="mt-1 block text-red" role="status">{relay.problem}</span> : null}</Row>}
        {relay.prefs === null ? null : <Row title={PROGRESS_LABEL} control={<Switch checked={relay.prefs.progress === "on"} onChange={value => relay.change("progress", value ? "on" : "off")} disabled={relay.saving} label={PROGRESS_LABEL}/>}>
          开（默认）：带 HarnessHub 工具的会话打开时，在 Harness 的系统提示末尾加上下面这段话，让它把任务清单和这一轮的小结、要你拿主意的问题显示在输入框上方；不改你发的消息。现在 Claude Code 和 Codex 有这个入口，其他 Harness 只靠工具自带的说明。改动对之后新开或恢复的原生会话生效。
          <details className="progress-instructions mt-1.5"><summary className="cursor-pointer text-fg-3">追加的内容</summary>
            <pre className="m-0 mt-1 rounded-row bg-inset px-3 py-2 text-code whitespace-pre-wrap">{HUB_PROGRESS_INSTRUCTIONS}</pre></details></Row>}
      </Card>
    </Section>
    <Section title="通知">
      <Card className={ROWS}>
        <Row title="系统通知" control={<Switch checked={notify.on} onChange={() => void notify.toggle()} disabled={!notify.supported || notify.blocked} label="系统通知"/>}>
          页面在后台时：有审批或提问等你时通知并响一声；正在看的对话做完或失败时只通知、不响。在前台时只更新侧栏和标签页标题。通知只写 Harness 的名称、状态、步数和用时，不含对话内容。
          {!notify.supported ? <span className="mt-1 block text-fg-3">这个浏览器不支持通知。</span> : notify.blocked ? <span className="mt-1 block text-fg-3">浏览器已阻止本页的通知，可在浏览器的网站设置中允许。</span> : null}</Row>
      </Card>
    </Section>
    <Section title="发现" description="按各产品的官方命令名和官网安装目录查找本机的 Harness。">
      <Card className={ROWS}>
        <LoginShellPanel api={api} onChanged={onRescan}/>
        <Row title="重新检测" control={<button type="button" className="btn" onClick={onRescan} disabled={scanning}>{scanning ? <Spinner size={13} label=""/> : <RefreshCw size={14} aria-hidden="true"/>}立即检测</button>}>
          页面不在后台定时检测。回到这个页面时，距上次检测超过一分钟会自动再检测一次；在终端里装好或升级之后，也可以立即检测。</Row>
        {/* Cursor, Gemini CLI and Pi are frozen (ADR-048): listed for new work only when the user asks (ADR-050). */}
        <Row className="frozen-setting" title={FROZEN_LABEL} control={<Switch checked={preferences.showFrozen} onChange={value => onPreference("showFrozen", value)} label={FROZEN_LABEL}/>}>
          冻结：保留适配与历史对话，不再打磨；停在它们上面的对话照常打开。</Row>
      </Card>
    </Section>
    <Section title="快捷键" description="在任何页面按 ⌘/ 也能查看。">
      <Card className="px-3 py-3"><ShortcutList/></Card>
    </Section>
    <Section title="数据">
      <Card className={ROWS}>
        <div className="flex flex-col gap-2 px-4 py-3.5 text-ui-sm text-fg-2">
          <p className="m-0">对话、执行记录和附件保存在本机网关的数据目录里。各 Harness 自己的会话、配置和登录状态留在它们原来的位置，HarnessHub 不复制、不修改。</p>
          <p className="m-0">这个浏览器只保存未发送的草稿（关闭标签页后清除）、显示偏好、通知开关，以及每个 Harness 上次用的入口、模型和思考档位，不保存密钥。</p>
        </div>
        <Row title="显示偏好" control={<button type="button" className="btn btn-sm" onClick={() => (Object.keys(DEFAULT_PREFERENCES) as (keyof Preferences)[]).forEach(key => onPreference(key, DEFAULT_PREFERENCES[key] as never))}>恢复默认</button>}>
          主题、过程显示、侧栏、详情面板和冻结 Harness 的显示回到默认。</Row>
      </Card>
    </Section>
  </PageShell>;
}
