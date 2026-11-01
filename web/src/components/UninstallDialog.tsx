import { Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { HarnessView, InstallationView, UninstallCheckView } from "../../../src/contracts/web.js";
import { errorMessage, type GatewayApi } from "../api.js";
import { Dialog } from "../ui/overlay.js";
import { Notice } from "../ui/primitives.js";
import { Checking, CheckFailed, Command, ConfirmBody, ConfirmFooter, SessionLink, Step, Steps } from "./UpgradeDialog.js";

/** What the user agreed to in the uninstall confirmation: the services to stop, for this exact installation (ADR-044). */
export interface UninstallConsent { readonly stopServices: readonly string[]; readonly fingerprint: string }

/**
 * The uninstall confirmation (ADR-044): reads what removing one installation would run, delete, stop and keep, and what
 * blocks it, and hands back the user's consent. It changes nothing itself.
 */
export function UninstallDialog({ api, harness, installation, onClose, onConfirm, onOpenSession }: {
  readonly api: GatewayApi; readonly harness: HarnessView | null; readonly installation: InstallationView | null; readonly onClose: () => void;
  readonly onConfirm: (harness: HarnessView, installation: InstallationView, consent: UninstallConsent) => void; readonly onOpenSession: (id: string) => void;
}) {
  const [check, setCheck] = useState<UninstallCheckView | null>(null), [failure, setFailure] = useState<string | null>(null), [attempt, setAttempt] = useState(0);
  const id = harness?.id ?? null, ref = installation?.ref ?? null;
  useEffect(() => {
    if (id === null || ref === null) return;
    const controller = new AbortController(); setCheck(null); setFailure(null);
    api.uninstallCheck(id, ref, AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]))
      .then(value => { if (!controller.signal.aborted) setCheck(value); }, error => { if (!controller.signal.aborted) setFailure(errorMessage(error)); });
    return () => controller.abort();
  }, [api, id, ref, attempt]);
  const name = harness?.name ?? "Agent", what = installation?.role === "adapter" ? `${name} 的接入口 ${installation.command}` : name;
  const busy = check?.conversations.filter(item => item.busy) ?? [], idle = check?.conversations.filter(item => !item.busy) ?? [];
  const blocked = busy.length > 0 || (check?.otherUsers.length ?? 0) > 0 || (check?.undeclaredServices.length ?? 0) > 0 || (check?.resident.length ?? 0) > 0;
  const after = check?.after;
  return <Dialog open={harness !== null && installation !== null} onOpenChange={open => { if (!open) onClose(); }} title={`卸载 ${what}`}
    description={`${installation?.label ?? ""}${installation?.version ? ` · ${installation.version}` : ""}`} className="uninstall-dialog w-[min(560px,calc(100vw-32px))]">
    <ConfirmBody>
      {failure ? <CheckFailed message={failure} onRetry={() => setAttempt(value => value + 1)}/>
        : check === null ? <Checking>正在检查哪些程序在使用这份安装…</Checking>
        : <>
          {blocked ? <Notice tone="red" title="现在不能卸载">
            {busy.length ? <span className="block">有 {busy.length} 个对话正在使用 {name}（正在回复或等你处理），等它们结束或停止后再卸载：</span> : null}
            {busy.map(item => <SessionLink key={item.sessionId} title={item.title} onOpen={() => onOpenSession(item.sessionId)}/>)}
            {check.otherUsers.length ? <span className="mt-1 block">另一个 HarnessHub 进程（进程 {check.otherUsers.map(item => item.pid).join("、")}）正在使用 {name}，等它结束后再卸载。</span> : null}
            {check.undeclaredServices.map(service => <span key={service.label} className="uninstall-undeclared mt-1 block">后台服务 {service.label}（进程 {service.pid}）在运行这份安装，HarnessHub 不知道怎样按产品的方式停止它。请先在终端停止它，再卸载。</span>)}
            {check.resident.map(program => <span key={program.pid} className="uninstall-resident mt-1 block">{program.name}（进程 {program.pid}）正在运行{program.stop ? `，先运行 ${program.stop} 停止它` : "，先停止它"}，再卸载。</span>)}
          </Notice> : null}
          <Steps>
            {check.services.length ? <Step title="先停止并注销后台服务">
              {check.services.map(service => <div key={service.label} className="uninstall-service flex flex-col gap-1.5">
                <span>{service.name}（{service.label}，进程 {service.pid}）按产品自己的命令停止并注销：</span>
                {service.commands.map(command => <Command key={command}>{command}</Command>)}
                <span className="text-amber">{service.interrupts}</span></div>)}
              <span>服务注册会被移除；重新安装后需要再安装服务。</span>
            </Step> : null}
            {idle.length ? <Step title="关闭空闲进程"><span>{idle.length} 个对话保留的 {name} 进程会先关闭。</span></Step> : null}
            <Step title="删除程序">
              {check.commands.map(command => <Command key={command}>{command}</Command>)}
              {check.removes.length ? <ul className="uninstall-removes m-0 flex list-none flex-col gap-1 p-0">{check.removes.map(path => <li key={path}><code className="text-[12px] wrap-anywhere">{path}</code></li>)}</ul> : null}
              {check.documented ? null : <span>官网没有写卸载方法，这里按官方安装脚本的布局删除它写入的文件。</span>}
              {check.skipped.map(item => <span key={item.path}>保留 <code className="text-[12px]">{item.path}</code>：{item.reason}。</span>)}
            </Step>
          </Steps>
          {check.kept.length ? <p className="uninstall-kept m-0 text-ui-sm text-fg-2">配置、登录和会话数据保留：{check.kept.join("、")}。</p> : <p className="uninstall-kept m-0 text-ui-sm text-fg-2">配置、登录和会话数据保留。</p>}
          {check.processes.length ? <Notice tone="amber">这些程序正在运行这份安装，不会被关闭；卸载后它们可能出错，建议先退出：{check.processes.map(item => `${item.name}（进程 ${item.pid}）`).join("、")}。</Notice> : null}
          {check.localChanges ? <Notice tone="amber">安装目录里有 {check.localChanges} 处本地改动，卸载会一并删除。</Notice> : null}
          <p className="uninstall-after m-0 text-ui-sm text-fg-2">{after?.kind === "next" ? `卸载后，HarnessHub 改用${after.label}${after.version ? ` 的 ${after.version}` : ""}。`
            : after?.kind === "none" ? installation?.role === "adapter" ? `卸载后，${name} 的接入口不可用，可以在 Agent 页重新安装。` : `卸载后，${name} 在 HarnessHub 里显示为未安装。`
            : "HarnessHub 当前使用的不是这一份，卸载不影响 HarnessHub 的对话。"}</p>
        </>}
    </ConfirmBody>
    <ConfirmFooter>
      <button type="button" className="btn" onClick={onClose}>取消</button>
      <button type="button" className="btn btn-danger" disabled={check === null || blocked}
        onClick={() => { if (harness && installation && check) onConfirm(harness, installation, { stopServices: check.services.map(service => service.label), fingerprint: check.fingerprint }); }}>
        <Trash2 size={14}/>{check?.services.length ? "停止服务并卸载" : "卸载"}</button>
    </ConfirmFooter>
  </Dialog>;
}
