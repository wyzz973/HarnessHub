import { ArrowUpRight, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { HarnessView, MaintenanceView } from "../../../src/contracts/web.js";
import { errorMessage, type GatewayApi } from "../api.js";
import { Dialog } from "../ui/overlay.js";
import { Notice, Spinner } from "../ui/primitives.js";

/**
 * What the user agreed to in the confirmation: the services to restart, for this exact installation (ADR-043), and for a
 * product upgraded through its documented sequence that its own backup was made first (ADR-052).
 */
export interface UpgradeConsent { readonly restartServices: readonly string[]; readonly fingerprint: string; readonly backupConfirmed?: true }
function channelText(channel: string): string { return ({ npm: "npm 全局安装", "brew-formula": "Homebrew", "brew-cask": "Homebrew", uv: "uv 工具", archive: "本机程序目录", "native-cli": "程序官方更新器" } as Record<string, string>)[channel] ?? "原安装渠道"; }
function Step({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return <li className="flex flex-col gap-1"><strong className="text-[13px] font-semibold">{title}</strong><div className="flex flex-col gap-1 text-[12.5px] text-fg-2">{children}</div></li>;
}
function Command({ children }: { readonly children: string }) { return <code className="block rounded-md bg-subtle px-2.5 py-1.5 text-[12px] break-all">{children}</code>; }

/**
 * The upgrade confirmation (ADR-043): reads what the upgrade would touch, says what it restarts, closes and leaves on the
 * old version, and what blocks it, and hands back the user's consent. A product with a documented upgrade sequence
 * (ADR-052) shows its hops and exact commands, the gateway offline in between, the Doctor's rewrite and the backup it
 * requires: the confirmation then needs the backup confirmed. It changes nothing itself.
 */
export function UpgradeDialog({ api, harness, onClose, onConfirm, onOpenSession }: {
  readonly api: GatewayApi; readonly harness: HarnessView | null; readonly onClose: () => void;
  readonly onConfirm: (harness: HarnessView, consent: UpgradeConsent) => void; readonly onOpenSession: (id: string) => void;
}) {
  const [check, setCheck] = useState<MaintenanceView | null>(null), [failure, setFailure] = useState<string | null>(null), [attempt, setAttempt] = useState(0), [backupConfirmed, setBackupConfirmed] = useState(false);
  const id = harness?.id ?? null;
  useEffect(() => {
    if (id === null) return;
    const controller = new AbortController(); setCheck(null); setFailure(null); setBackupConfirmed(false);
    api.maintenance(id, AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]))
      .then(value => { if (!controller.signal.aborted) setCheck(value); }, error => { if (!controller.signal.aborted) setFailure(errorMessage(error)); });
    return () => controller.abort();
  }, [api, id, attempt]);
  const name = harness?.name ?? "Harness", current = check?.currentVersion ?? harness?.management.programVersion ?? "当前版本", target = check?.targetVersion ?? harness?.management.latestVersion ?? "最新版本";
  const busy = check?.conversations.filter(item => item.busy) ?? [], idle = check?.conversations.filter(item => !item.busy) ?? [], sequence = check?.sequence;
  // A runtime the upgrade starts the new version on must meet its range; one it leaves running only needs it before its own restart.
  // A sequence installs several releases: each hop's range is checked, and an unmet one names its hop.
  const unmet = check === null ? [] : sequence ? sequence.hops.flatMap(hop => hop.runtimes.filter(runtime => !runtime.satisfied).map(runtime => ({ runtime, version: hop.version })))
    : check.runtimes.filter(runtime => !runtime.satisfied).map(runtime => ({ runtime, version: target }));
  const runtimeBlocks = unmet.filter(item => item.runtime.restarted), runtimeWarnings = unmet.filter(item => !item.runtime.restarted);
  const serviceName = (label: string) => check?.restart.find(item => item.label === label)?.name ?? check?.resident.find(item => item.label === label)?.name ?? sequence?.restarts.find(item => item.label === label)?.name ?? label;
  const blocked = busy.length > 0 || (check?.otherUsers.length ?? 0) > 0 || runtimeBlocks.length > 0;
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
            {runtimeBlocks.map(({ runtime, version }) => <span key={version + runtime.path + (runtime.service ?? "")} className="upgrade-runtime mt-1 block">{name} {version} 要求 Node.js {runtime.required}，{runtime.service === null ? `本机运行 ${name} 的` : `${serviceName(runtime.service)}（${runtime.service}）启动用的`} Node.js {runtime.found === null ? "版本读不出来" : `是 ${runtime.found}`}（{runtime.path}）。需要先升级它{runtime.upgradeCommand ? <>，可以运行 <code className="text-[12px]">{runtime.upgradeCommand}</code></> : null}；HarnessHub 不替你升级 Node.js。</span>)}
          </Notice> : null}
          <ol className="m-0 flex list-none flex-col gap-3 p-0">
            {sequence ? <>
              <Step title={`按 ${name} 官方文档的步骤升级（${sequence.hops.length} 跳）`}>
                <span>沿用原来的 {channelText(check.channel)}，依次装入 {sequence.hops.map(hop => hop.version + (hop.bridge ? "（上游要求先经过的中间版本）" : "")).join("、")}，每一跳装好后运行 {name} 自己的 Doctor 迁移配置。HarnessHub 按下面的顺序运行这些命令：</span>
                <code className="block text-[12px] break-all text-fg-3">{check.location}</code>
                <ol className="upgrade-sequence m-0 flex list-decimal flex-col gap-1 pl-5">{sequence.commands.map((command, index) => <li key={index}><Command>{command}</Command></li>)}</ol>
              </Step>
              {sequence.gateway ? <Step title="Gateway 停止到重新启动之间，渠道离线">
                <span className="upgrade-offline">{sequence.gateway.name}（{sequence.gateway.label}，进程 {sequence.gateway.pid}）在第一跳之前由 {name} 自己的命令停止，最后一跳的 Doctor 通过后再由它的命令启动，并核实它重新运行、在端口上监听；期间它连接的渠道（例如微信、飞书）离线。HarnessHub 不用 launchctl kickstart 重启它。</span>
              </Step> : <Step title="Gateway 没有在运行"><span>{name} 的 Gateway 现在不在运行，升级不启动它。</span></Step>}
              {sequence.restarts.length ? <Step title="Gateway 恢复后重启">
                {sequence.restarts.map(service => <span key={service.label} className="flex flex-col gap-1"><span>{service.name}（{service.label}，进程 {service.pid}）由 {name} 自己的命令重启：</span><Command>{service.command}</Command></span>)}
              </Step> : null}
              <Step title="Doctor 会改写配置"><span className="upgrade-doctor">每一跳的 {sequence.doctor.command} 会改写 {sequence.doctor.rewrites.join("、")}。{sequence.doctor.backups}HarnessHub 自己不写入任何配置。</span></Step>
            </> : <>
              <Step title="安装新版本">
                <span>沿用原来的 {channelText(check.channel)}，把 {name} 从 {current} 升级到 {target}。</span>
                <code className="block text-[12px] break-all text-fg-3">{check.location}</code>
              </Step>
              {check.restart.length ? <Step title="重启后台服务">
                {check.restart.map(service => <span key={service.label} className="flex flex-col gap-1"><span>{service.name}（{service.label}，进程 {service.pid}）会在新版本核实后立即重启：</span><Command>{service.command}</Command>
                  {service.portKnown ? null : <span>不知道它监听的端口，重启后只能确认进程在运行。</span>}</span>)}
              </Step> : null}
            </>}
            {idle.length ? <Step title="关闭 HarnessHub 里的空闲进程"><span>{idle.length} 个对话保留的 {name} 进程会先关闭，下次发消息时重新连接。</span></Step> : null}
            {runtimeWarnings.length ? <Step title="重启这些服务之前">
              {runtimeWarnings.map(({ runtime, version }) => <span key={version + runtime.path + (runtime.service ?? "")} className="upgrade-runtime-warning text-amber">{serviceName(runtime.service ?? "")}（{runtime.service}）启动用的 Node.js {runtime.found === null ? "版本读不出来" : `是 ${runtime.found}`}（{runtime.path}），{version} 要求 {runtime.required}。升级后重启它之前，需要先升级这个 Node.js{runtime.upgradeCommand ? `（${runtime.upgradeCommand}）` : ""}。</span>)}
            </Step> : null}
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
          {sequence ? <label className="upgrade-backup flex items-start gap-2 rounded-lg border border-amber-line bg-amber-soft px-3 py-2 text-[12.5px]">
            <input type="checkbox" className="mt-0.5" checked={backupConfirmed} onChange={event => setBackupConfirmed(event.target.checked)}/>
            <span>我已运行 <code className="text-[12px]">{sequence.backupCommand}</code> 并核对了备份。{sequence.rollback}</span>
          </label> : null}
          <p className="m-0 text-[12px] text-fg-3">升级期间 HarnessHub 不会给 {name} 启动新任务；你的{sequence ? "登录和对话历史都保留，配置由 Doctor 迁移" : "模型配置、登录和对话历史都保留"}。</p>
        </>}
    </div>
    <div className="flex justify-end gap-2 px-5 pt-2 pb-5">
      <button type="button" className="btn" onClick={onClose}>取消</button>
      <button type="button" className="btn btn-primary" disabled={check === null || blocked || sequence !== undefined && !backupConfirmed}
        onClick={() => { if (harness && check) onConfirm(harness, { restartServices: check.restart.map(service => service.label), fingerprint: check.fingerprint, ...(sequence ? { backupConfirmed: true as const } : {}) }); }}>
        <ArrowUpRight size={14}/>{check?.restart.length ? `升级并重启 ${check.restart.map(service => service.name).join("、")}` : "升级"}</button>
    </div>
  </Dialog>;
}
