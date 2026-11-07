import { ArrowUpRight, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { HarnessView, MaintenanceView } from "../../../src/contracts/web.js";
import { errorMessage, type GatewayApi } from "../api.js";
import { cn } from "../lib/cn.js";
import { Dialog, useClosingValue } from "../ui/overlay.js";
import { Notice, Spinner } from "../ui/primitives.js";

/*
 * The parts every maintenance confirmation shares (ADR-043, ADR-044): a body that scrolls between the title and the
 * buttons, the facts of the check in a hairline box, the steps on a quiet rail like the Agent board's task timeline,
 * commands in the recessed code color, and the buttons below it. They are spaced as the capability dialogs are, after
 * the Capabilities board's write preview, so every confirmation reads as one family. The dialog itself grows from .98
 * over a fading scrim in 200 ms (Motion board #28), appears at once from the keyboard, and only fades when motion is
 * reduced.
 */

/**
 * The scrolling middle of a confirmation: what the check found, 18 px under the title block, 12 px between blocks. A body
 * taller than its limit scrolls; its blocks never shrink, so one that clips its overflow is never squeezed into hiding
 * what the user is asked to confirm.
 */
export function ConfirmBody({ children }: { readonly children: ReactNode }) {
  return <div className="scroll-area flex max-h-[min(64dvh,560px)] flex-col gap-3 px-5 pt-[18px] pb-3 [&>*]:shrink-0">{children}</div>;
}
/** The buttons of a confirmation, 14 px below the body and 18 px above the edge, with no rule: the way out first, the action last. */
export function ConfirmFooter({ children }: { readonly children: ReactNode }) {
  return <div className="flex flex-wrap items-center justify-end gap-2 px-5 pt-3.5 pb-[18px]">{children}</div>;
}
/** What a confirmation says while its check runs. */
export function Checking({ children }: { readonly children: ReactNode }) {
  return <p className="m-0 flex items-center gap-2 text-ui-sm text-fg-2" role="status"><Spinner size={14} label=""/>{children}</p>;
}
/** A check that could not be made, with the one way forward: making it again. */
export function CheckFailed({ message, onRetry }: { readonly message: string; readonly onRetry: () => void }) {
  return <Notice tone="red" action={<button type="button" className="btn btn-sm" onClick={onRetry}><RefreshCw size={13}/>重新检查</button>}>{message}</Notice>;
}
/** The facts a check found, two columns wide in a hairline box. */
export function Facts({ className, children }: { readonly className?: string; readonly children: ReactNode }) {
  return <dl className={cn("m-0 grid grid-cols-[84px_minmax(0,1fr)] gap-x-3 gap-y-2 rounded-block hairline px-3.5 py-3", className)}>{children}</dl>;
}
export function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return <><dt className="text-caption leading-5 text-fg-3">{label}</dt><dd className="m-0 min-w-0 text-ui-sm wrap-anywhere">{children}</dd></>;
}
/** A command exactly as it runs, or as the user would run it. */
export function Command({ children, className }: { readonly children: string; readonly className?: string }) {
  return <code className={cn("block rounded-control bg-inset px-3 py-2 text-[12px] leading-5 wrap-anywhere", className)}>{children}</code>;
}
/** What the action does, step by step. */
export function Steps({ children }: { readonly children: ReactNode }) { return <ol className="confirm-steps m-0 flex list-none flex-col p-0">{children}</ol>; }
/** One step on the rail; `mark="warn"` puts an amber dot on a step that waits for something the user does first. */
export function Step({ title, children, mark = "plain" }: { readonly title: string; readonly children: ReactNode; readonly mark?: "plain" | "warn" }) {
  return <li className="group/step flex gap-3">
    <div className="flex w-3 flex-none flex-col items-center pt-[6px]" aria-hidden="true">
      <span className={cn("size-[9px] flex-none rounded-full", mark === "warn" ? "bg-amber-dot" : "shadow-[inset_0_0_0_1.5px_var(--border-strong)]")}/>
      <span className="mt-1 w-[1.5px] flex-1 rounded-[1px] bg-line-strong group-last/step:hidden"/>
    </div>
    <div className="flex min-w-0 flex-1 flex-col gap-1.5 pb-4 group-last/step:pb-0">
      <strong className="text-ui-sm font-semibold">{title}</strong>
      <div className="flex min-w-0 flex-col gap-1.5 text-ui-sm text-fg-2">{children}</div>
    </div>
  </li>;
}
/** A conversation that blocks the action, opened from the confirmation. */
export function SessionLink({ title, onOpen }: { readonly title: string; readonly onOpen: () => void }) {
  return <button type="button" className="link-btn mt-1 block max-w-full truncate text-left text-ui-sm font-normal underline underline-offset-2" onClick={onOpen}>{title}</button>;
}

/**
 * What the user agreed to in the confirmation: the services to restart, for this exact installation (ADR-043), and for a
 * product upgraded through its documented sequence that its own backup was made first (ADR-052).
 */
export interface UpgradeConsent { readonly restartServices: readonly string[]; readonly fingerprint: string; readonly backupConfirmed?: true }
function channelText(channel: string): string { return ({ npm: "npm 全局安装", "brew-formula": "Homebrew", "brew-cask": "Homebrew", uv: "uv 工具", archive: "本机程序目录", "native-cli": "程序官方更新器" } as Record<string, string>)[channel] ?? "原安装渠道"; }

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
  // Its words keep the Harness while the dialog closes (useClosingValue).
  const shown = useClosingValue(harness);
  const name = shown?.name ?? "Harness", current = check?.currentVersion ?? shown?.management.programVersion ?? "当前版本", target = check?.targetVersion ?? shown?.management.latestVersion ?? "最新版本";
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
    <ConfirmBody>
      {failure ? <CheckFailed message={failure} onRetry={() => setAttempt(value => value + 1)}/>
        : check === null ? <Checking>正在检查哪些程序在使用 {name}…</Checking>
        : <>
          {blocked ? <Notice tone="red" title="现在不能升级">
            {busy.length ? <span className="block">有 {busy.length} 个对话正在使用 {name}（正在回复或等你处理），等它们结束或停止后再升级：</span> : null}
            {busy.map(item => <SessionLink key={item.sessionId} title={item.title} onOpen={() => onOpenSession(item.sessionId)}/>)}
            {check.otherUsers.length ? <span className="mt-1 block">另一个 HarnessHub 进程（进程 {check.otherUsers.map(item => item.pid).join("、")}）正在使用 {name}，等它结束后再升级。</span> : null}
            {runtimeBlocks.map(({ runtime, version }) => <span key={version + runtime.path + (runtime.service ?? "")} className="upgrade-runtime mt-1 block">{name} {version} 要求 Node.js {runtime.required}，{runtime.service === null ? `本机运行 ${name} 的` : `${serviceName(runtime.service)}（${runtime.service}）启动用的`} Node.js {runtime.found === null ? "版本读不出来" : `是 ${runtime.found}`}（{runtime.path}）。需要先升级它{runtime.upgradeCommand ? <>，可以运行 <code className="text-[12px]">{runtime.upgradeCommand}</code></> : null}；HarnessHub 不替你升级 Node.js。</span>)}
          </Notice> : null}
          <Steps>
            {sequence ? <>
              <Step title={`按 ${name} 官方文档的步骤升级（${sequence.hops.length} 跳）`}>
                <span>沿用原来的 {channelText(check.channel)}，依次装入 {sequence.hops.map(hop => hop.version + (hop.bridge ? "（上游要求先经过的中间版本）" : "")).join("、")}，每一跳装好后运行 {name} 自己的 Doctor 迁移配置。HarnessHub 按下面的顺序运行这些命令：</span>
                <code className="block text-[12px] wrap-anywhere text-fg-3">{check.location}</code>
                <ol className="upgrade-sequence m-0 flex list-decimal flex-col gap-1.5 pl-5 marker:text-caption marker:text-fg-3">{sequence.commands.map((command, index) => <li key={index}><Command>{command}</Command></li>)}</ol>
              </Step>
              {sequence.gateway ? <Step title="Gateway 停止到重新启动之间，渠道离线">
                <span className="upgrade-offline">{sequence.gateway.name}（{sequence.gateway.label}，进程 {sequence.gateway.pid}）在第一跳之前由 {name} 自己的命令停止，最后一跳的 Doctor 通过后再由它的命令启动，并核实它重新运行、在端口上监听；期间它连接的渠道（例如微信、飞书）离线。HarnessHub 不用 launchctl kickstart 重启它。</span>
              </Step> : <Step title="Gateway 没有在运行"><span>{name} 的 Gateway 现在不在运行，升级不启动它。</span></Step>}
              {sequence.restarts.length ? <Step title="Gateway 恢复后重启">
                {sequence.restarts.map(service => <span key={service.label} className="flex flex-col gap-1.5"><span>{service.name}（{service.label}，进程 {service.pid}）由 {name} 自己的命令重启：</span><Command>{service.command}</Command></span>)}
              </Step> : null}
              <Step title="Doctor 会改写配置"><span className="upgrade-doctor">每一跳的 {sequence.doctor.command} 会改写 {sequence.doctor.rewrites.join("、")}。{sequence.doctor.backups}HarnessHub 自己不写入任何配置。</span></Step>
            </> : <>
              <Step title="安装新版本">
                <span>沿用原来的 {channelText(check.channel)}，把 {name} 从 {current} 升级到 {target}。</span>
                <code className="block text-[12px] wrap-anywhere text-fg-3">{check.location}</code>
              </Step>
              {check.restart.length ? <Step title="重启后台服务">
                {check.restart.map(service => <span key={service.label} className="flex flex-col gap-1.5"><span>{service.name}（{service.label}，进程 {service.pid}）会在新版本核实后立即重启：</span><Command>{service.command}</Command>
                  {service.portKnown ? null : <span>不知道它监听的端口，重启后只能确认进程在运行。</span>}</span>)}
              </Step> : null}
            </>}
            {idle.length ? <Step title="关闭 HarnessHub 里的空闲进程"><span>{idle.length} 个对话保留的 {name} 进程会先关闭，下次发消息时重新连接。</span></Step> : null}
            {runtimeWarnings.length ? <Step title="重启这些服务之前" mark="warn">
              {runtimeWarnings.map(({ runtime, version }) => <span key={version + runtime.path + (runtime.service ?? "")} className="upgrade-runtime-warning text-amber">{serviceName(runtime.service ?? "")}（{runtime.service}）启动用的 Node.js {runtime.found === null ? "版本读不出来" : `是 ${runtime.found}`}（{runtime.path}），{version} 要求 {runtime.required}。升级后重启它之前，需要先升级这个 Node.js{runtime.upgradeCommand ? `（${runtime.upgradeCommand}）` : ""}。</span>)}
            </Step> : null}
            {left.length ? <Step title="这些程序不会被关闭">
              <span>它们继续使用旧版本，重开后才用新版本：</span>
              <ul className="m-0 flex list-disc flex-col gap-1 pl-5 marker:text-fg-3">{left.map(item => <li key={item.pid}>{item.name}{item.label && item.label !== item.name ? `（${item.label}，进程 ${item.pid}）` : `（进程 ${item.pid}）`}{item.restartCommand ? <>，升级后可运行 <code className="text-[12px]">{item.restartCommand}</code></> : null}</li>)}</ul>
            </Step> : null}
            {check.servicesKnown ? null : <Step title="后台服务"><span>这台电脑上 HarnessHub 不重启后台服务。{name} 如果有常驻服务，升级后需要你自己重启。</span></Step>}
            {check.staleRecords ? <Step title="清除旧记录"><span>还会清除 {check.staleRecords} 条已结束的 HarnessHub 进程留下的使用记录。</span></Step> : null}
          </Steps>
          {check.plugins.length ? <p className="m-0 text-ui-sm text-fg-2">已安装的插件：{check.plugins.join("、")}。新版本可能不兼容它们。</p> : null}
          {check.notes.length ? <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-ui-sm text-fg-2 marker:text-fg-3">{check.notes.map(note => <li key={note}>{note}</li>)}</ul> : null}
          {check.rollback ? <div className="flex flex-col gap-1.5 text-ui-sm text-fg-2"><span>要退回 {current}，先运行：</span><Command>{check.rollback}</Command>{check.restart.length ? <span>再运行上面的重启命令。</span> : null}</div> : null}
          {sequence ? <label className="upgrade-backup flex cursor-pointer items-start gap-2.5 rounded-block bg-amber-soft px-3.5 py-3 text-ui-sm">
            <input type="checkbox" className="mt-[3px] size-[15px] flex-none cursor-pointer accent-accent" checked={backupConfirmed} onChange={event => setBackupConfirmed(event.target.checked)}/>
            <span>我已运行 <code className="text-[12px]">{sequence.backupCommand}</code> 并核对了备份。{sequence.rollback}</span>
          </label> : null}
          <p className="m-0 text-caption text-fg-3">升级期间 HarnessHub 不会给 {name} 启动新任务；你的{sequence ? "登录和对话历史都保留，配置由 Doctor 迁移" : "模型配置、登录和对话历史都保留"}。</p>
        </>}
    </ConfirmBody>
    <ConfirmFooter>
      <button type="button" className="btn" onClick={onClose}>取消</button>
      <button type="button" className="btn btn-primary" disabled={check === null || blocked || sequence !== undefined && !backupConfirmed}
        onClick={() => { if (harness && check) onConfirm(harness, { restartServices: check.restart.map(service => service.label), fingerprint: check.fingerprint, ...(sequence ? { backupConfirmed: true as const } : {}) }); }}>
        <ArrowUpRight size={14}/>{check?.restart.length ? `升级并重启 ${check.restart.map(service => service.name).join("、")}` : "升级"}</button>
    </ConfirmFooter>
  </Dialog>;
}
