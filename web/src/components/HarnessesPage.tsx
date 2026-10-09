import { Check, ChevronDown, CircleHelp, Layers3, RefreshCw, Search, Terminal } from "lucide-react";
import { useState } from "react";
import type { HarnessView } from "../../../src/contracts/web.js";
import { protocolLabel } from "../api.js";
import { EmptyState, ErrorNotice, Spinner, StatusBadge } from "./common.js";
import { MobileMenu } from "./Sidebar.js";

export function HarnessesPage({ harnesses, scanning, error, onRescan, onDismissError, onMenu, onChoose }: {
  harnesses: readonly HarnessView[]; scanning: boolean; error: string | null; onRescan: () => void; onDismissError: () => void; onMenu: () => void; onChoose: (harness: HarnessView) => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"installed" | "all">("installed");
  const installed = harnesses.filter(row => row.installed || row.controls.some(control => control.available));
  const visible = (filter === "installed" ? installed : harnesses).filter(row => `${row.id} ${row.name}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <section className="management-page" aria-labelledby="harnesses-title"><header className="management-header"><MobileMenu onClick={onMenu}/><div><p className="page-eyebrow">执行你的任务</p><h1 id="harnesses-title">Harnesses</h1></div><button className="button secondary" onClick={onRescan} disabled={scanning}>{scanning ? <Spinner/> : <RefreshCw size={15} aria-hidden="true"/>}{scanning ? "正在检测" : "重新检测"}</button></header>
    <div className="management-body"><p className="page-description">发现本机的 Harness 与控制入口。选择执行者，Provider 和模型由你独立决定。</p>{error ? <ErrorNotice message={error} onDismiss={onDismissError}/> : null}
      <div className="list-toolbar harness-toolbar"><div className="segmented-control" aria-label="Harness 过滤"><button className={filter === "installed" ? "selected" : ""} onClick={() => setFilter("installed")} aria-pressed={filter === "installed"}>本机发现 <span>{installed.length}</span></button><button className={filter === "all" ? "selected" : ""} onClick={() => setFilter("all")} aria-pressed={filter === "all"}>全部目录 <span>{harnesses.length}</span></button></div><label className="search-field"><Search size={15} aria-hidden="true"/><input aria-label="搜索 Harnesses" placeholder="搜索 Harness" value={query} onChange={event => setQuery(event.target.value)}/></label></div>
      {visible.length === 0 ? <EmptyState icon={<Layers3 size={28}/>} title={query ? "没有匹配的 Harness" : filter === "installed" ? "还没有发现本机 Harness" : "目录中还没有 Harness"} action={query ? <button className="button secondary" onClick={() => setQuery("")}>清除搜索</button> : <button className="button secondary" onClick={() => setFilter("all")}>查看全部目录</button>}>{query ? "试试其他名称，或清除搜索条件。" : "安装一个支持的 Harness 后重新检测，就可以在对话中选择它。"}</EmptyState> : <div className="harness-list">{visible.map(harness => {
        const available = harness.controls.some(control => control.available);
        return <article className="harness-row" key={harness.id}><div className="harness-main"><div className="provider-avatar" aria-hidden="true"><Terminal size={20}/></div><div><div className="provider-title"><h2>{harness.name}</h2><StatusBadge tone={available ? "success" : harness.installed ? "warning" : "neutral"}>{available ? "入口已解析" : harness.installed ? "缺少控制入口" : "未发现"}</StatusBadge></div><p>{harness.providerProtocols.length ? harness.providerProtocols.map(protocolLabel).join(" / ") : "使用 Harness 自身配置"}</p></div><button className="button subtle" disabled={!available} onClick={() => onChoose(harness)}><Check size={14} aria-hidden="true"/>用于新对话</button></div><details className="control-details"><summary>控制入口 <span>{harness.controls.length}</span><ChevronDown size={14} aria-hidden="true"/></summary><div>{harness.controls.map(control => <div className="control-detail" key={control.id}><span>{protocolLabel(control.protocol)}</span><code>{control.id}</code><span className={control.available ? "success-text" : "muted"}>{control.available ? "可以尝试连接" : control.reason ?? "目前不可用"}</span></div>)}</div></details></article>;
      })}</div>}
      <div className="management-footnote"><CircleHelp size={15} aria-hidden="true"/><span>找到入口不代表已通过登录、协议握手或真实任务验证。调用失败会在会话中明确显示。</span></div>
    </div>
  </section>;
}
