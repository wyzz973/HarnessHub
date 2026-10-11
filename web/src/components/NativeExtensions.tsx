import * as Popover from "@radix-ui/react-popover";
import { LoaderCircle, Puzzle, RefreshCw, X } from "lucide-react";
import { useState } from "react";
import type { NativeExtensions } from "../../../src/contracts/control.js";
import { errorMessage } from "../api.js";

const MCP_STATUS: Readonly<Record<string, string>> = { connected: "已连接", starting: "启动中", notStarted: "按需启动", authenticationRequired: "需要登录", failed: "启动失败", cancelled: "已取消", disabled: "已停用" };
const MCP_AUTH: Readonly<Record<string, string>> = { notLoggedIn: "未登录", bearerToken: "令牌", oAuth: "OAuth" };

/**
 * Read-only view of what the selected Harness has loaded: skills, MCP servers and plugins, read on demand from the original
 * installation. Choosing an invocable skill fills its command into the composer; nothing here changes the Harness.
 */
export function NativeExtensionsPanel({ load, onCommand, disabled }: { load: (signal: AbortSignal) => Promise<NativeExtensions | null>; onCommand: (command: string) => void; disabled: boolean }) {
  const [state, setState] = useState<{ loading: boolean; value: NativeExtensions | null | undefined; error: string | null }>({ loading: false, value: undefined, error: null });
  const read = () => {
    setState({ loading: true, value: undefined, error: null });
    const controller = new AbortController();
    load(controller.signal).then(value => setState({ loading: false, value, error: null }), error => setState({ loading: false, value: undefined, error: errorMessage(error) }));
  };
  const value = state.value;
  return <Popover.Root onOpenChange={open => { if (open && state.value === undefined && !state.loading) read(); }}>
    <Popover.Trigger asChild><button type="button" className="composer-settings-trigger" aria-label="原生扩展" title="技能、MCP 与插件" disabled={disabled}><Puzzle size={15}/></button></Popover.Trigger>
    <Popover.Portal><Popover.Content className="composer-settings-panel native-extensions" side="top" align="end" sideOffset={12} collisionPadding={16}>
      <div className="composer-settings-heading"><h3>原生扩展</h3><span>
        <button type="button" className="icon-button" aria-label="重新读取原生扩展" onClick={read} disabled={state.loading}><RefreshCw size={14}/></button>
        <Popover.Close className="icon-button" aria-label="收起原生扩展"><X size={15}/></Popover.Close></span></div>
      {state.loading ? <p className="native-muted"><LoaderCircle size={12} className="spin" aria-hidden="true"/> 正在从本机安装读取…</p> : null}
      {state.error ? <p className="native-muted is-error">{state.error}</p> : null}
      {value === null ? <p className="settings-help">这个 Harness 的接口不提供扩展列表；它的技能与 MCP 提示在“命令”中按原生名称列出。</p> : null}
      {value ? <>
        <details open><summary>技能 <span>{value.skills.length}</span></summary>
          {value.skills.length ? <ul className="extension-list">{value.skills.map(skill => <li key={skill.name}>
            {skill.command && skill.enabled ? <button type="button" className="text-button" onClick={() => onCommand(skill.command!)} title={"/" + skill.command}>{skill.name}</button> : <strong className={skill.enabled ? "" : "is-disabled"}>{skill.name}</strong>}
            {skill.scope ? <small>{skill.scope}</small> : null}{!skill.enabled ? <small>已停用</small> : null}
            {skill.description ? <p>{skill.description}</p> : null}
          </li>)}</ul> : <p className="native-muted">没有技能。</p>}
        </details>
        <details><summary>MCP 服务器 <span>{value.mcpServers.length}</span></summary>
          {value.mcpServers.length ? <ul className="extension-list">{value.mcpServers.map(server => <li key={server.name}>
            <strong>{server.name}</strong><small className={server.failed ? "is-error" : ""}>{server.failed ? "工具读取失败" : (MCP_STATUS[server.status] ?? server.status)}</small>
            {server.auth && MCP_AUTH[server.auth] ? <small>{MCP_AUTH[server.auth]}</small> : null}<small>{server.tools} 个工具</small>
          </li>)}</ul> : <p className="native-muted">没有 MCP 服务器。</p>}
        </details>
        <details><summary>插件与扩展 <span>{value.plugins.length}</span></summary>
          {value.plugins.length ? <ul className="extension-list">{value.plugins.map((plugin, index) => <li key={plugin.name + index}>
            <strong className={plugin.enabled ? "" : "is-disabled"}>{plugin.name}</strong>{plugin.version ? <small>v{plugin.version}</small> : null}{plugin.source ? <small>{plugin.source}</small> : null}{!plugin.enabled ? <small>已停用</small> : null}
          </li>)}</ul> : <p className="native-muted">没有插件。</p>}
        </details>
        {value.truncated ? <p className="settings-help">列表较长，只显示前 512 项。</p> : null}
        <p className="settings-help">读取自本机安装与当前工作区；在 Hub 中只读，启用或安装请在原程序中进行。</p>
      </> : null}
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}
