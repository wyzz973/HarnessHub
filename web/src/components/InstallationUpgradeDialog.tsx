import { ArrowUpRight, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { HarnessView, InstallationUpgradeCheckView, InstallationView } from "../../../src/contracts/web.js";
import { errorMessage, type GatewayApi } from "../api.js";
import { Dialog } from "../ui/overlay.js";
import { Notice, Spinner } from "../ui/primitives.js";

function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return <><dt className="text-fg-3">{label}</dt><dd className="m-0 min-w-0 break-all">{children}</dd></>;
}
/** The button of an installation's upgrade in the user's terms: an update the product picks itself is "立即更新" (ADR-044). */
export function upgradeLabel(installation: InstallationView): string {
  if (installation.upgrade === "self-update" || installation.upgrade === "rerun") return "立即更新";
  if (installation.upgrade === "terminal") return "更新方式";
  const latest = installation.latest?.version;
  return latest && latest !== installation.version ? `升级到 v${latest}` : "升级";
}

/**
 * The confirmation of upgrading one installation through its channel (ADR-044): prepares the upgrade (the exact release,
 * Homebrew's dry run, or the official script) and says what runs, where it writes, what else Homebrew changes, who uses
 * the installation and what blocks it; it hands back the prepared upgrade's fingerprint. It changes nothing itself.
 */
export function InstallationUpgradeDialog({ api, harness, installation, onClose, onConfirm, onOpenSession }: {
  readonly api: GatewayApi; readonly harness: HarnessView | null; readonly installation: InstallationView | null; readonly onClose: () => void;
  readonly onConfirm: (harness: HarnessView, installation: InstallationView, fingerprint: string) => void; readonly onOpenSession: (id: string) => void;
}) {
  const [check, setCheck] = useState<InstallationUpgradeCheckView | null>(null), [failure, setFailure] = useState<string | null>(null), [attempt, setAttempt] = useState(0);
  const id = harness?.id ?? null, ref = installation?.ref ?? null;
  useEffect(() => {
    if (id === null || ref === null) return;
    const controller = new AbortController(); setCheck(null); setFailure(null);
    // A Homebrew dry run may take a minute; a release or script is read from the network.
    api.upgradeCheck(id, ref, AbortSignal.any([controller.signal, AbortSignal.timeout(150_000)]))
      .then(value => { if (!controller.signal.aborted) setCheck(value); }, error => { if (!controller.signal.aborted) setFailure(errorMessage(error)); });
    return () => controller.abort();
  }, [api, id, ref, attempt]);
  const name = harness?.name ?? "Harness", what = installation?.role === "adapter" ? `${name} 的接入口 ${installation.command}` : name;
  const update = check ? check.kind === "self-update" || check.kind === "rerun" : installation?.upgrade === "self-update" || installation?.upgrade === "rerun";
  const busy = check?.conversations.filter(item => item.busy) ?? [], idle = check?.conversations.filter(item => !item.busy) ?? [];
  const fact = "grid grid-cols-[84px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[12.5px]";
  return <Dialog open={harness !== null && installation !== null} onOpenChange={open => { if (!open) onClose(); }} title={`${update ? "更新" : "升级"} ${what}`}
    description={`${installation?.label ?? ""}${installation?.version ? ` · v${installation.version}` : ""}`} className="upgrade-installation-dialog w-[min(560px,calc(100vw-32px))]">
    <div className="scroll-area flex max-h-[min(64dvh,560px)] flex-col gap-3 px-5 pt-3 pb-2">
      {failure ? <Notice tone="red" action={<button type="button" className="btn btn-sm" onClick={() => setAttempt(value => value + 1)}><RefreshCw size={13}/>重新检查</button>}>{failure}</Notice>
        : check === null ? <p className="m-0 flex items-center gap-2 text-[13px] text-fg-2"><Spinner size={14}/>正在准备：读取最新版本、运行 Homebrew 预演或下载官方脚本…</p>
        : check.terminal ? <>
          <p className="m-0 text-[12.5px] text-fg-2">{check.terminal.explains}</p>
          <code className="upgrade-terminal-command block rounded-md bg-subtle px-2.5 py-2 text-[12px] break-all">{check.terminal.command}</code>
          {check.notes.map(note => <Notice key={note} tone="amber">{note}</Notice>)}
          <p className="m-0 text-[12px] text-fg-3">运行完成后，在“我的 Agent”里重新检测即可看到新版本。</p>
        </>
        : <>
          {check.blocked ? <Notice tone="red" title="现在不能升级" className="upgrade-blocked">
            <span className="block">{check.blocked}</span>
            {busy.map(item => <button key={item.sessionId} type="button" className="mt-1 block max-w-full truncate border-none bg-transparent p-0 text-left text-[12.5px] text-accent-text underline" onClick={() => onOpenSession(item.sessionId)}>{item.title}</button>)}
          </Notice> : null}
          <dl className={`upgrade-facts m-0 ${fact}`}>
            <Fact label="版本">{check.current ?? "版本未记录"} → {check.target ?? "由更新程序决定"}{check.prerelease ? <span className="ml-1.5 badge" title="渠道当前的 latest 就是预发布版">预发布版</span> : null}</Fact>
            <Fact label="实际运行"><code className="text-[12px]">{check.runs}</code></Fact>
            {check.script ? <Fact label="脚本来源"><span>{check.script.source}<br/><span className="text-fg-3">SHA-256 {check.script.sha256}</span></span></Fact> : null}
            <Fact label="可写位置">{check.writes.join("、")}{check.channel === "brew-formula" || check.channel === "brew-cask" ? "、Homebrew 的临时目录和缓存" : ""}；其他位置都不能写。</Fact>
            {check.runtime ? <Fact label="Node.js">{check.runtime.satisfied ? `${check.runtime.found} 满足 ${check.runtime.required}` : `要求 ${check.runtime.required}，${check.runtime.path} 是 ${check.runtime.found ?? "读不出版本"}`}</Fact> : null}
          </dl>
          {check.dependencies.length ? <div className="upgrade-dependencies flex flex-col gap-1 text-[12.5px] text-fg-2"><span>Homebrew 会一并处理：</span>
            <ul className="m-0 flex list-none flex-col gap-0.5 p-0">{check.dependencies.map(line => <li key={line}><code className="text-[12px]">{line}</code></li>)}</ul></div> : null}
          {check.sharedRuntimes.length ? <Notice tone="red" className="upgrade-shared-runtime">会一并升级共享运行时：{check.sharedRuntimes.join("、")}。所有用它运行的程序（例如 npm 全局安装的程序，包括 OpenClaw 网关）下次启动都会用新版本；请确认后再升级。</Notice> : null}
          {check.shellProfile ? <p className="m-0 text-[12.5px] text-amber">官方脚本可能会在 {check.shellProfile} 里加一行 PATH 设置；HarnessHub 只允许它改这一个文件，并在完成后列出改动。</p> : null}
          {check.configFiles.length ? <p className="m-0 text-[12.5px] text-fg-2">更新程序会写 {check.configFiles.join("、")}；完成后只列出改动了哪些设置，不显示其他内容。</p> : null}
          {idle.length ? <p className="upgrade-idle m-0 text-[12.5px] text-fg-2">{idle.length} 个对话保留的 {name} 进程会先关闭，下次发消息时重新连接。</p> : null}
          {check.processes.length ? <Notice tone="amber">这些程序正在运行这份安装，不会被关闭，重开后才用新版本：{check.processes.map(item => `${item.name}（进程 ${item.pid}）`).join("、")}。</Notice> : null}
          {check.notes.map(note => <p key={note} className="upgrade-note m-0 text-[12.5px] text-fg-2">{note}</p>)}
          <p className="m-0 text-[12px] text-fg-3">升级沿用这份安装自己的渠道，不改模型配置、登录和对话。确认 15 分钟内有效。</p>
        </>}
    </div>
    <div className="flex justify-end gap-2 border-t border-line px-5 py-3">
      <button type="button" className="btn" onClick={onClose}>{check?.terminal ? "关闭" : "取消"}</button>
      {check?.terminal ? null : <button type="button" className="btn btn-primary" disabled={check === null || check.blocked !== null}
        onClick={() => { if (harness && installation && check) onConfirm(harness, installation, check.fingerprint); }}><ArrowUpRight size={14}/>{update ? "立即更新" : "升级"}</button>}
    </div>
  </Dialog>;
}
