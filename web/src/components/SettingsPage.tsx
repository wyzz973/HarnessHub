import { Monitor, Moon, RefreshCw, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import type { LoginShellView } from "../../../src/contracts/web.js";
import { errorMessage, GatewayApi } from "../api.js";
import { cn } from "../lib/cn.js";
import { DEFAULT_PREFERENCES, type Preferences } from "../lib/prefs.js";
import { Kbd, Spinner } from "../ui/primitives.js";
import { Card, PageShell, Section } from "./PageShell.js";
import { NotifyToggle } from "./Sidebar.js";

/**
 * Directories from the login shell's PATH (ADR-040): read only when the user asks, since that runs the shell's login
 * configuration; kept for discovery until the user removes them. Hidden where it is not offered and nothing was added.
 */
function LoginShellPanel({ api, onChanged }: { readonly api: GatewayApi; readonly onChanged: () => void }) {
  const [view, setView] = useState<LoginShellView | null | undefined>(undefined), [busy, setBusy] = useState(false), [problem, setProblem] = useState<string | null>(null);
  useEffect(() => { const controller = new AbortController(); api.loginShell(controller.signal).then(setView, () => setView(null)); return () => controller.abort(); }, [api]);
  if (view === undefined) return <p className="m-0 flex items-center gap-2 text-[12.5px] text-fg-3"><Spinner size={12}/>正在读取发现设置</p>;
  if (view === null || (!view.available && !view.dirs.length)) return <p className="m-0 text-[12.5px] text-fg-3">这个服务没有提供从登录 shell 补充目录（例如在 CI 中、在 Windows 上，或启动时关闭了它）。</p>;
  const change = (operation: Promise<LoginShellView>) => { setBusy(true); setProblem(null); operation.then(next => { setView(next); onChanged(); }, failure => setProblem(errorMessage(failure))).finally(() => setBusy(false)); };
  return <section className="login-shell-panel flex flex-col gap-3" aria-label="来自登录 shell 的目录">
    <div className="flex flex-wrap items-start gap-3"><div className="min-w-0 flex-1"><strong className="text-[13.5px] font-semibold">从登录 shell 补充搜索目录</strong>
      <p className="m-0 mt-1 text-[12.5px] text-fg-2">会执行你的 shell 登录配置{view.shell ? `（${view.shell} -l）` : ""}来读取 PATH；新增的目录只用于发现 Harness，不改变 HarnessHub 自己的环境。只运行列在 /etc/shells 中的 shell：用 Homebrew 等方式安装、没有加入这个文件的 shell 会被拒绝。</p></div>
      {view.available ? <button type="button" className="btn" disabled={busy} onClick={() => change(api.readLoginShell(crypto.randomUUID()))}>{busy ? <Spinner size={13}/> : <RefreshCw size={14}/>}读取并重新检测</button> : null}</div>
    {view.dirs.length ? <ul className="m-0 flex list-none flex-col gap-1 p-0">{view.dirs.map(dir => <li key={dir} className="flex items-center gap-2 rounded-lg border border-line px-3 py-2"><code className="min-w-0 flex-1 text-[12px] break-all">{dir}</code><button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => change(api.removeLoginShellDirectory(dir, crypto.randomUUID()))}>移除</button></li>)}</ul>
      : view.readAt !== null ? <small className="text-[12.5px] text-fg-3">登录 shell 的 PATH 没有带来新的目录。</small> : null}
    {problem ? <p className="m-0 text-[12.5px] text-red" role="status">{problem}</p> : null}
  </section>;
}

const THEMES: readonly { readonly id: Preferences["theme"]; readonly label: string; readonly icon: typeof Sun }[] = [{ id: "system", label: "跟随系统", icon: Monitor }, { id: "light", label: "浅色", icon: Sun }, { id: "dark", label: "深色", icon: Moon }];
/** Display preferences of this browser, notifications, discovery and where data lives. */
export function SettingsPage({ api, preferences, onPreference, onRescan, scanning, onMenu, sidebarHidden, onExpandSidebar, onChat }: {
  readonly api: GatewayApi; readonly preferences: Preferences; readonly onPreference: <K extends keyof Preferences>(key: K, value: Preferences[K]) => void; readonly onRescan: () => void; readonly scanning: boolean;
  readonly onMenu: () => void; readonly sidebarHidden: boolean; readonly onExpandSidebar: () => void; readonly onChat: () => void;
}) {
  const row = "flex flex-wrap items-center justify-between gap-3 px-4 py-3.5";
  return <PageShell title="设置" titleId="settings-title" onMenu={onMenu} sidebarHidden={sidebarHidden} onExpandSidebar={onExpandSidebar} onBack={onChat}>
    <Section title="外观" description="只影响这个浏览器。">
      <div className="grid grid-cols-3 gap-2.5" role="radiogroup" aria-label="主题">{THEMES.map(theme => <button key={theme.id} type="button" role="radio" aria-checked={preferences.theme === theme.id} onClick={() => onPreference("theme", theme.id)}
        className={cn("flex flex-col items-start gap-2.5 rounded-xl border bg-surface p-3 text-left shadow-sm transition-[border-color,box-shadow] duration-150", preferences.theme === theme.id ? "border-accent ring-2 ring-accent-soft" : "border-line hover:border-line-strong")}>
        <span className={cn("flex h-14 w-full overflow-hidden rounded-lg border border-line", theme.id === "dark" ? "bg-[#141413]" : theme.id === "light" ? "bg-[#F7F6F3]" : "bg-[linear-gradient(90deg,#F7F6F3_50%,#141413_50%)]")} aria-hidden="true">
          <span className={cn("m-2 h-3 w-10 rounded", theme.id === "dark" ? "bg-[#2B2A27]" : "bg-[#E3E0DA]")}/></span>
        <span className="flex items-center gap-1.5 text-[13px] font-medium"><theme.icon size={14} aria-hidden="true"/>{theme.label}</span></button>)}</div>
    </Section>
    <Section title="对话">
      <Card>
        <div className={row}><div className="min-w-0"><strong className="block text-[13.5px] font-medium">过程显示</strong><small className="text-[12.5px] text-fg-2">简洁：每轮的工具与思考折叠成一行摘要，失败和未完成的步骤仍会写在摘要里。详细：全部展开。</small></div>
          <div className="segmented" role="group" aria-label="默认过程显示"><button type="button" aria-pressed={preferences.density === "compact"} onClick={() => onPreference("density", "compact")}>简洁</button><button type="button" aria-pressed={preferences.density === "detailed"} onClick={() => onPreference("density", "detailed")}>详细</button></div></div>
        <div className={cn(row, "border-t border-line")}><div className="min-w-0"><strong className="block text-[13.5px] font-medium">侧栏分组</strong><small className="text-[12.5px] text-fg-2">按状态时，等你处理和进行中的对话排在最前。</small></div>
          <div className="segmented" role="group" aria-label="侧栏分组">{(["status", "harness", "workspace"] as const).map(value => <button key={value} type="button" aria-pressed={preferences.groupBy === value} onClick={() => onPreference("groupBy", value)}>{value === "status" ? "状态" : value === "harness" ? "Harness" : "工作区"}</button>)}</div></div>
      </Card>
    </Section>
    <Section title="通知" description="页面在后台时，有审批或提问会通知你。通知只写 Harness 名称和剩余时间，不含对话内容。">
      <Card className={row}><span className="text-[13px] text-fg-2">浏览器通知需要你在这里开启，浏览器会询问一次。</span><NotifyToggle withLabel/></Card>
    </Section>
    <Section title="发现" description="HarnessHub 按各产品的官方命令名和标准安装目录查找本机的 Harness，也读取启动时给出的发现清单中的自定义入口。">
      <Card className="flex flex-col gap-4 p-4">
        <LoginShellPanel api={api} onChanged={onRescan}/>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3.5"><small className="text-[12.5px] text-fg-2">安装或升级了某个 Harness 之后，重新检测一次即可看到。</small><button type="button" className="btn" onClick={onRescan} disabled={scanning}>{scanning ? <Spinner size={13}/> : <RefreshCw size={14}/>}重新检测本机入口</button></div>
      </Card>
    </Section>
    <Section title="快捷键">
      <Card className="grid grid-cols-1 gap-x-6 gap-y-2.5 p-4 text-[13px] sm:grid-cols-2">{[["新对话", "⇧⌘O"], ["搜索与命令", "⌘K"], ["快捷键", "⌘/"], ["详情栏", "⌘."], ["收起侧栏", "⌘B"], ["停止当前回复", "Esc"]].map(([label, keys]) => <div key={label} className="flex items-center justify-between gap-3"><span className="text-fg-2">{label}</span><Kbd>{keys}</Kbd></div>)}</Card>
    </Section>
    <Section title="数据">
      <Card className="flex flex-col gap-3 p-4 text-[12.5px] text-fg-2">
        <p className="m-0">对话、执行记录和附件保存在本机网关的数据目录中。各 Harness 自己的会话、配置和登录状态保留在它们原来的位置，HarnessHub 不复制、不修改。</p>
        <p className="m-0">这个浏览器只保存未发送的草稿（关闭标签页后清除）和显示偏好，不保存密钥。</p>
        <div><button type="button" className="btn btn-sm" onClick={() => (Object.keys(DEFAULT_PREFERENCES) as (keyof Preferences)[]).forEach(key => onPreference(key, DEFAULT_PREFERENCES[key] as never))}>恢复默认显示偏好</button></div>
      </Card>
    </Section>
  </PageShell>;
}
