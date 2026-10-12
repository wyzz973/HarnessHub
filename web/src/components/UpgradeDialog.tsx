import { ArrowUpRight, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { HarnessView, MaintenanceView } from "../../../src/contracts/web.js";
import { errorMessage, type GatewayApi } from "../api.js";
import { Dialog } from "../ui/overlay.js";
import { Notice, Spinner } from "../ui/primitives.js";

/** What the user agreed to in the confirmation: the services to restart, for this exact installation (ADR-043). */
export interface UpgradeConsent { readonly restartServices: readonly string[]; readonly fingerprint: string }
/** Whole months between two calendar versions (`YYYY.M.D…`); null when either is not one. */
export function calendarGap(from: string | null, to: string | null): number | null {
  const months = (value: string | null): number | null => { const match = value === null ? null : /^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:$|[.-])/u.exec(value); return match ? Number(match[1]) * 12 + Number(match[2]) - 1 : null; };
  const start = months(from), end = months(to);
  return start === null || end === null || end < start ? null : end - start;
}
function channelText(channel: string): string { return ({ npm: "npm 全局安装", "brew-formula": "Homebrew", "brew-cask": "Homebrew", uv: "uv 工具", archive: "本机程序目录", "native-cli": "程序官方更新器" } as Record<string, string>)[channel] ?? "原安装渠道"; }
function Step({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return <li className="flex flex-col gap-1"><strong className="text-[13px] font-semibold">{title}</strong><div className="flex flex-col gap-1 text-[12.5px] text-fg-2">{children}</div></li>;
}
function Command({ children }: { readonly children: string }) { return <code className="block rounded-md bg-subtle px-2.5 py-1.5 text-[12px] break-all">{children}</code>; }

/**
 * The upgrade confirmation (ADR-043): reads what the upgrade would touch, says what it restarts, closes and leaves on the
 * old version, and what blocks it, and hands back the user's consent. It changes nothing itself.
 */
export function UpgradeDialog({ api, harness, onClose, onConfirm, onOpenSession }: {
  readonly api: GatewayApi; readonly harness: HarnessView | null; readonly onClose: () => void;
  readonly onConfirm: (harness: HarnessView, consent: UpgradeConsent) => void; readonly onOpenSession: (id: string) => void;
}) {
  const [check, setCheck] = useState<MaintenanceView | null>(null), [failure, setFailure] = useState<string | null>(null), [attempt, setAttempt] = useState(0);
  const id = harness?.id ?? null;
  useEffect(() => {
    if (id === null) return;
    const controller = new AbortController(); setCheck(null); setFailure(null);
    api.maintenance(id, AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]))
      .then(value => { if (!controller.signal.aborted) setCheck(value); }, error => { if (!controller.signal.aborted) setFailure(errorMessage(error)); });
    return () => controller.abort();
  }, [api, id, attempt]);
  const name = harness?.name ?? "Harness", current = check?.currentVersion ?? harness?.management.programVersion ?? "当前版本", target = check?.targetVersion ?? harness?.management.latestVersion ?? "最新版本";
  const busy = check?.conversations.filter(item => item.busy) ?? [], idle = check?.conversations.filter(item => !item.busy) ?? [];
  const runtime = check?.runtime && !check.runtime.satisfied ? check.runtime : null;
  const blocked = busy.length > 0 || (check?.otherUsers.length ?? 0) > 0 || runtime !== null;
  const gap = calendarGap(check?.currentVersion ?? null, check?.targetVersion ?? null);
  const left = check ? [...check.resident, ...check.processes.map(item => ({ label: null, name: item.name, pid: item.pid, restartCommand: null }))] : [];
  return <Dialog open={harness !== null} onOpenChange={open => { if (!open) onClose(); }} title={`升级 ${name}`} description={`${current} → ${target}`} className="upgrade-dialog w-[min(560px,calc(100vw-32px))]">
    <div className="scroll-area flex max-h-[min(64dvh,560px)] flex-col gap-3 px-5 pt-3 pb-2">
      {failure ? <Notice tone="red" action={<button type="button" className="btn btn-sm" onClick={() => setAttempt(value => value + 1)}><RefreshCw size={13}/>重新检查</button>}>{failure}</Notice>
        : check === null ? <p className="m-0 flex items-center gap-2 text-[13px] text-fg-2"><Spinner size={14}/>正在检查哪些程序在使用 {name}…</p>
        : <>
          {blocked ? <Notice tone="red" title="现在不能升级">
            {busy.length ? <span className="block">有 {busy.length} 个对话正在使用 {name}（正在回复或等你处理），等它们结束或停止后再升级：</span> : null}
            {busy.map(item => <button key={item.sessionId} type="button" className="mt-1 block max-w-full truncate border-none bg-transparent p-0 text-left text-[12.5px] text-accent-text underline" onClick={() => onOpenSession(item.sessionId)}>{item.title}</button>)}
            {check.otherUsers.length ? <span className="mt-1 block">另一个 HarnessHub 进程（进程 {check.otherUsers.map(item => item.pid).join("、")}）正在使用 {name}，等它结束后再升级。</span> : null}
            {runtime ? <span className="upgrade-runtime mt-1 block">{name} {target} 要求 Node.js {runtime.required}，本机运行 {name} 的 Node.js {runtime.found === null ? "版本读不出来" : `是 ${runtime.found}`}（{runtime.path}）。需要先升级 Node.js，HarnessHub 不替你升级它。</span> : null}
          </Notice> : null}
          <ol className="m-0 flex list-none flex-col gap-3 p-0">
            <Step title="安装新版本">
              <span>沿用原来的 {channelText(check.channel)}，把 {name} 从 {current} 升级到 {target}。</span>
              <code className="block text-[12px] break-all text-fg-3">{check.location}</code>
              {gap !== null && gap >= 2 ? <span className="text-amber">两个版本相隔约 {gap} 个月，变化可能较多。</span> : null}
              {check.target?.state === "unverified" ? <span className="text-amber">HarnessHub 对 {name} 的接入是在 {check.target.program} 上验证的；{target} 还没有验证，部分能力可能需要适配。</span> : null}
            </Step>
            {check.restart.length ? <Step title="重启后台服务">
              {check.restart.map(service => <span key={service.label} className="flex flex-col gap-1"><span>{service.name}（{service.label}，进程 {service.pid}）会在新版本核实后立即重启：</span><Command>{service.command}</Command>
                {service.portKnown ? null : <span>不知道它监听的端口，重启后只能确认进程在运行。</span>}</span>)}
            </Step> : null}
            {idle.length ? <Step title="关闭 HarnessHub 里的空闲进程"><span>{idle.length} 个对话保留的 {name} 进程会先关闭，下次发消息时重新连接。</span></Step> : null}
            {left.length ? <Step title="这些程序不会被关闭">
              <span>它们继续使用旧版本，重开后才用新版本：</span>
              <ul className="m-0 flex list-disc flex-col gap-0.5 pl-5">{left.map(item => <li key={item.pid}>{item.name}{item.label && item.label !== item.name ? `（${item.label}，进程 ${item.pid}）` : `（进程 ${item.pid}）`}{item.restartCommand ? <>，升级后可运行 <code className="text-[12px]">{item.restartCommand}</code></> : null}</li>)}</ul>
            </Step> : null}
            {check.servicesKnown ? null : <Step title="后台服务"><span>这台电脑上 HarnessHub 不重启后台服务。{name} 如果有常驻服务，升级后需要你自己重启。</span></Step>}
            {check.staleRecords ? <Step title="清除旧记录"><span>还会清除 {check.staleRecords} 条已结束的 HarnessHub 进程留下的使用记录。</span></Step> : null}
          </ol>
          {check.plugins.length ? <p className="m-0 text-[12.5px] text-fg-2">已安装的插件：{check.plugins.join("、")}。新版本可能不兼容它们。</p> : null}
          {check.notes.length ? <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-[12.5px] text-fg-2">{check.notes.map(note => <li key={note}>{note}</li>)}</ul> : null}
          {check.rollback ? <div className="flex flex-col gap-1 text-[12.5px] text-fg-2"><span>要退回 {current}，先运行：</span><Command>{check.rollback}</Command>{check.restart.length ? <span>再运行上面的重启命令。</span> : null}</div> : null}
          <p className="m-0 text-[12px] text-fg-3">升级期间 HarnessHub 不会给 {name} 启动新任务；你的模型配置、登录和对话历史都保留。</p>
        </>}
    </div>
    <div className="flex justify-end gap-2 px-5 pt-2 pb-5">
      <button type="button" className="btn" onClick={onClose}>取消</button>
      <button type="button" className="btn btn-primary" disabled={check === null || blocked} onClick={() => { if (harness && check) onConfirm(harness, { restartServices: check.restart.map(service => service.label), fingerprint: check.fingerprint }); }}>
        <ArrowUpRight size={14}/>{check?.restart.length ? `升级并重启 ${check.restart.map(service => service.name).join("、")}` : "升级"}</button>
    </div>
  </Dialog>;
}
