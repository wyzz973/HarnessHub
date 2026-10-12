import { ChevronRight, Puzzle, RefreshCw } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";
import type { NativeExtensions } from "../../../src/contracts/control.js";
import { errorMessage } from "../api.js";
import { cn } from "../lib/cn.js";
import { Popover, PopHead } from "../ui/overlay.js";
import { Spinner } from "../ui/primitives.js";

const MCP_STATUS: Readonly<Record<string, string>> = { connected: "已连接", starting: "启动中", notStarted: "按需启动", authenticationRequired: "需要登录", failed: "启动失败", cancelled: "已取消", disabled: "已停用" };
const MCP_AUTH: Readonly<Record<string, string>> = { notLoggedIn: "未登录", bearerToken: "令牌", oAuth: "OAuth" };

function Section({ title, count, defaultOpen = false, children }: { readonly title: string; readonly count: number; readonly defaultOpen?: boolean; readonly children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return <div>
    <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)} className="flex w-full items-center gap-1.5 rounded-md border-none bg-transparent px-1.5 py-1 text-left text-[12.5px] font-medium hover:bg-hover">
      <ChevronRight size={12} className={cn("text-fg-3 transition-transform duration-150", open && "rotate-90")} aria-hidden="true"/>{title}<span className="text-fg-3">{count}</span></button>
    {open ? <div className="enter px-1.5 pt-1 pb-2">{children}</div> : null}
  </div>;
}
/**
 * Read-only view of what the selected Harness has loaded: skills, MCP servers and plugins, read on demand from the original
 * installation. Choosing an invocable skill fills its command into the composer; nothing here changes the Harness.
 */
export function NativeExtensionsPanel({ load, onCommand, disabled }: { load: (signal: AbortSignal) => Promise<NativeExtensions | null>; onCommand: (command: string) => void; disabled: boolean }) {
  const [state, setState] = useState<{ loading: boolean; value: NativeExtensions | null | undefined; error: string | null }>({ loading: false, value: undefined, error: null });
  const read = () => {
    setState({ loading: true, value: undefined, error: null });
    load(new AbortController().signal).then(value => setState({ loading: false, value, error: null }), error => setState({ loading: false, value: undefined, error: errorMessage(error) }));
  };
  const value = state.value;
  const row = "flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-1 text-[12.5px]";
  return <Popover label="原生扩展" side="top" align="end" className="native-extensions w-[380px] max-w-[calc(100vw-24px)]"
    onOpenChange={open => { if (open && state.value === undefined && !state.loading) read(); }}
    trigger={<button type="button" className="icon-btn" aria-label="原生扩展" title="技能、MCP 与插件" disabled={disabled}><Puzzle size={16}/></button>}>
    <PopHead title="原生扩展" closeLabel="收起原生扩展"><button type="button" className="icon-btn icon-btn-sm" aria-label="重新读取原生扩展" onClick={read} disabled={state.loading}><RefreshCw size={13}/></button></PopHead>
    <div className="flex flex-col gap-1 p-2">
      {state.loading ? <p className="m-0 flex items-center gap-1.5 px-1.5 text-[12.5px] text-fg-3"><Spinner size={12}/> 正在从本机安装读取…</p> : null}
      {state.error ? <p className="m-0 px-1.5 text-[12.5px] text-red">{state.error}</p> : null}
      {value === null ? <p className="m-0 px-1.5 text-[12.5px] text-fg-2">这个 Harness 的接口不提供扩展列表；它的技能与 MCP 提示在“命令”中按原生名称列出。</p> : null}
      {value ? <>
        <Section title="技能" count={value.skills.length} defaultOpen>
          {value.skills.length ? <ul className="m-0 list-none p-0">{value.skills.map(skill => <li key={skill.name} className={row}>
            {skill.command && skill.enabled ? <button type="button" className="link-btn" onClick={() => onCommand(skill.command!)} title={"/" + skill.command}>{skill.name}</button> : <strong className={cn("font-medium", !skill.enabled && "text-fg-3 line-through")}>{skill.name}</strong>}
            {skill.scope ? <small className="text-fg-3">{skill.scope}</small> : null}{!skill.enabled ? <small className="text-fg-3">已停用</small> : null}
            {skill.description ? <p className="m-0 w-full text-[12px] text-fg-2">{skill.description}</p> : null}
          </li>)}</ul> : <p className="m-0 text-[12.5px] text-fg-3">没有技能。</p>}
        </Section>
        <Section title="MCP 服务器" count={value.mcpServers.length}>
          {value.mcpServers.length ? <ul className="m-0 list-none p-0">{value.mcpServers.map(server => <li key={server.name} className={row}>
            <strong className="font-medium">{server.name}</strong><small className={server.failed ? "text-red" : "text-fg-3"}>{server.failed ? "工具读取失败" : (MCP_STATUS[server.status] ?? server.status)}</small>
            {server.auth && MCP_AUTH[server.auth] ? <small className="text-fg-3">{MCP_AUTH[server.auth]}</small> : null}<small className="text-fg-3">{server.tools} 个工具</small>
          </li>)}</ul> : <p className="m-0 text-[12.5px] text-fg-3">没有 MCP 服务器。</p>}
        </Section>
        <Section title="插件与扩展" count={value.plugins.length}>
          {value.plugins.length ? <ul className="m-0 list-none p-0">{value.plugins.map((plugin, index) => <li key={plugin.name + index} className={row}>
            <strong className={cn("font-medium", !plugin.enabled && "text-fg-3")}>{plugin.name}</strong>{plugin.version ? <small className="text-fg-3">v{plugin.version}</small> : null}{plugin.source ? <small className="text-fg-3">{plugin.source}</small> : null}{!plugin.enabled ? <small className="text-fg-3">已停用</small> : null}
          </li>)}</ul> : <p className="m-0 text-[12.5px] text-fg-3">没有插件。</p>}
        </Section>
        {value.truncated ? <p className="m-0 px-1.5 text-[12px] text-fg-3">列表较长，只显示前 512 项。</p> : null}
        <p className="m-0 border-t border-line px-1.5 pt-2 text-[12px] text-fg-3">读取自本机安装与当前工作区；在 Hub 中只读，启用或安装请在原程序中进行。</p>
      </> : null}
    </div>
  </Popover>;
}
