import { ArrowUpRight, Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import type { HarnessView, InstallationUpgradeCheckView, InstallationView } from "../../../src/contracts/web.js";
import { errorMessage, type GatewayApi } from "../api.js";
import { Dialog, useClosingValue } from "../ui/overlay.js";
import { Notice } from "../ui/primitives.js";
import { Checking, CheckFailed, Command, ConfirmBody, ConfirmFooter, Fact, Facts, SessionLink } from "./UpgradeDialog.js";

/**
 * The button of an installation's upgrade in the user's terms: an update the product picks itself is "立即更新", one the
 * terminal runs is "更新方式", and a newer version the channel reported is named ("升级到 2.1.305", ADR-044).
 */
export function upgradeLabel(installation: InstallationView): string {
  if (installation.upgrade === "self-update" || installation.upgrade === "rerun") return "立即更新";
  if (installation.upgrade === "terminal") return "更新方式";
  const latest = installation.latest?.version;
  return latest && latest !== installation.version ? `升级到 ${latest}` : "升级";
}

/** A command the user runs in a terminal, with a way to copy it. */
function TerminalCommand({ command }: { readonly command: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => { if (state === "idle") return; const timer = setTimeout(() => setState("idle"), 1600); return () => clearTimeout(timer); }, [state]);
  return <div className="flex items-start gap-2 rounded-control bg-inset py-1.5 pr-1.5 pl-3">
    <code className="upgrade-terminal-command min-w-0 flex-1 py-[3px] text-[12px] leading-5 wrap-anywhere">{command}</code>
    <button type="button" className="icon-btn icon-btn-sm text-fg-3" aria-label="复制命令" title={state === "copied" ? "已复制" : state === "failed" ? "无法使用剪贴板，可选中文本后复制" : "复制命令"}
      onClick={() => { void navigator.clipboard.writeText(command).then(() => setState("copied"), () => setState("failed")); }}>{state === "copied" ? <Check size={14}/> : <Copy size={14}/>}</button>
  </div>;
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
  // Its words keep the Harness and installation while the dialog closes (useClosingValue).
  const shownInstallation = useClosingValue(installation);
  const name = useClosingValue(harness)?.name ?? "Harness", what = shownInstallation?.role === "adapter" ? `${name} 的接入口 ${shownInstallation.command}` : name;
  const update = check ? check.kind === "self-update" || check.kind === "rerun" : shownInstallation?.upgrade === "self-update" || shownInstallation?.upgrade === "rerun";
  const busy = check?.conversations.filter(item => item.busy) ?? [], idle = check?.conversations.filter(item => !item.busy) ?? [];
  return <Dialog open={harness !== null && installation !== null} onOpenChange={open => { if (!open) onClose(); }} title={`${update ? "更新" : "升级"} ${what}`}
    description={`${shownInstallation?.label ?? ""}${shownInstallation?.version ? ` · ${shownInstallation.version}` : ""}`} className="upgrade-installation-dialog w-[min(560px,calc(100vw-32px))]">
    <ConfirmBody>
      {failure ? <CheckFailed message={failure} onRetry={() => setAttempt(value => value + 1)}/>
        : check === null ? <Checking>正在准备：读取最新版本、运行 Homebrew 预演或下载官方脚本…</Checking>
        : check.terminal ? <>
          <p className="m-0 text-ui-sm text-fg-2">{check.terminal.explains}</p>
          <TerminalCommand command={check.terminal.command}/>
          {check.notes.map(note => <Notice key={note} tone="amber">{note}</Notice>)}
          <p className="m-0 text-caption text-fg-3">运行完成后，在 Harness 页点“重新检测”即可看到新版本。</p>
        </>
        : <>
          {check.blocked ? <Notice tone="red" title="现在不能升级" className="upgrade-blocked">
            <span className="block">{check.blocked}</span>
            {busy.map(item => <SessionLink key={item.sessionId} title={item.title} onOpen={() => onOpenSession(item.sessionId)}/>)}
          </Notice> : null}
          <Facts className="upgrade-facts">
            <Fact label="版本">{check.current ?? "版本未记录"} → {check.target ?? "由更新程序决定"}{check.prerelease ? <span className="badge ml-1.5" title="渠道当前的 latest 就是预发布版">预发布版</span> : null}</Fact>
            <Fact label="实际运行"><code className="text-[12px]">{check.runs}</code></Fact>
            {check.script ? <Fact label="脚本来源"><span>{check.script.source}<br/><span className="text-fg-3">SHA-256 {check.script.sha256}</span></span></Fact> : null}
            <Fact label="可写位置">{check.writes.join("、")}{check.channel === "brew-formula" || check.channel === "brew-cask" ? "、Homebrew 的临时目录和缓存" : ""}；其他位置都不能写。</Fact>
            {check.runtime ? <Fact label="Node.js">{check.runtime.satisfied ? `${check.runtime.found} 满足 ${check.runtime.required}` : `要求 ${check.runtime.required}，${check.runtime.path} 是 ${check.runtime.found ?? "读不出版本"}`}</Fact> : null}
          </Facts>
          {check.dependencies.length ? <div className="upgrade-dependencies flex flex-col gap-1.5 text-ui-sm text-fg-2"><span>Homebrew 会一并处理：</span>
            <ul className="m-0 flex list-none flex-col gap-1 p-0">{check.dependencies.map(line => <li key={line}><Command>{line}</Command></li>)}</ul></div> : null}
          {check.sharedRuntimes.length ? <Notice tone="red" className="upgrade-shared-runtime">会一并升级共享运行时：{check.sharedRuntimes.join("、")}。所有用它运行的程序（例如 npm 全局安装的程序，包括 OpenClaw 网关）下次启动都会用新版本；请确认后再升级。</Notice> : null}
          {check.shellProfile ? <p className="m-0 text-ui-sm text-amber">官方脚本可能会在 {check.shellProfile} 里加一行 PATH 设置；HarnessHub 只允许它改这一个文件，并在完成后列出改动。</p> : null}
          {check.configFiles.length ? <p className="m-0 text-ui-sm text-fg-2">更新程序会写 {check.configFiles.join("、")}；完成后只列出改动了哪些设置，不显示其他内容。</p> : null}
          {idle.length ? <p className="upgrade-idle m-0 text-ui-sm text-fg-2">{idle.length} 个对话保留的 {name} 进程会先关闭，下次发消息时重新连接。</p> : null}
          {check.processes.length ? <Notice tone="amber">这些程序正在运行这份安装，不会被关闭，重开后才用新版本：{check.processes.map(item => `${item.name}（进程 ${item.pid}）`).join("、")}。</Notice> : null}
          {check.notes.map(note => <p key={note} className="upgrade-note m-0 text-ui-sm text-fg-2">{note}</p>)}
          <p className="m-0 text-caption text-fg-3">升级沿用这份安装自己的渠道，不改模型配置、登录和对话。确认 15 分钟内有效。</p>
        </>}
    </ConfirmBody>
    <ConfirmFooter>
      <button type="button" className="btn" onClick={onClose}>{check?.terminal ? "关闭" : "取消"}</button>
      {check?.terminal ? null : <button type="button" className="btn btn-primary" disabled={check === null || check.blocked !== null}
        onClick={() => { if (harness && installation && check) onConfirm(harness, installation, check.fingerprint); }}><ArrowUpRight size={14}/>{update ? "立即更新" : "升级"}</button>}
    </ConfirmFooter>
  </Dialog>;
}
