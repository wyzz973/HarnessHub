import { Download } from "lucide-react";
import { useEffect, useState } from "react";
import type { HarnessView, InstallCheckView } from "../../../src/contracts/web.js";
import { errorMessage, type GatewayApi } from "../api.js";
import { Dialog } from "../ui/overlay.js";
import { Notice } from "../ui/primitives.js";
import { Checking, CheckFailed, ConfirmBody, ConfirmFooter, Fact, Facts } from "./UpgradeDialog.js";

/** What the terminal's command runs once installed, by this Gateway's PATH (ADR-044). */
export function terminalLine(check: InstallCheckView): string {
  const { command, before, after } = check.terminal;
  if (after === "not-on-path") return `装好的 ${command} 所在目录不在 PATH 上，终端里${before ? `仍运行${before}` : "找不到它"}；HarnessHub 仍能找到并使用它。`;
  if (after === "this") return before ? `安装后，终端里的 ${command} 会改为运行这份新安装（原来运行的是${before}）。` : `安装后，终端里的 ${command} 就是这份新安装。`;
  return `安装后，终端里的 ${command} 仍运行${before ?? "原来那份"}；PATH 里它排在前面。`;
}

/**
 * The official install confirmation (ADR-044): prepares the install (downloads the script, or resolves the exact npm
 * release) and says what runs, where it writes, what else it may change and what the terminal will run; it hands back the
 * prepared install's fingerprint. It changes nothing itself.
 */
export function InstallDialog({ api, harness, onClose, onConfirm }: {
  readonly api: GatewayApi; readonly harness: HarnessView | null; readonly onClose: () => void; readonly onConfirm: (harness: HarnessView, fingerprint: string) => void;
}) {
  const [check, setCheck] = useState<InstallCheckView | null>(null), [failure, setFailure] = useState<string | null>(null), [attempt, setAttempt] = useState(0);
  const id = harness?.id ?? null;
  useEffect(() => {
    if (id === null) return;
    const controller = new AbortController(); setCheck(null); setFailure(null);
    api.installCheck(id, AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]))
      .then(value => { if (!controller.signal.aborted) setCheck(value); }, error => { if (!controller.signal.aborted) setFailure(errorMessage(error)); });
    return () => controller.abort();
  }, [api, id, attempt]);
  const name = harness?.name ?? "Harness";
  return <Dialog open={harness !== null} onOpenChange={open => { if (!open) onClose(); }} title={`安装 ${name}`} description={check ? check.method === "npm" ? "按官网方式，用 npm 安装" : "按官网方式，运行官方安装脚本" : "按官网方式安装"}
    className="install-dialog w-[min(560px,calc(100vw-32px))]">
    <ConfirmBody>
      {failure ? <CheckFailed message={failure} onRetry={() => setAttempt(value => value + 1)}/>
        : check === null ? <Checking>正在准备：下载官方安装脚本或读取 npm 上的版本…</Checking>
        : <>
          {check.blocked ? <Notice tone="red" title="现在不能安装" className="install-blocked">{check.blocked}</Notice> : null}
          <Facts className="install-facts">
            <Fact label="官网命令"><code className="text-[12px]">{check.officialCommand}</code></Fact>
            <Fact label={check.method === "npm" ? "版本" : "脚本来源"}>{check.method === "npm" ? check.source : <span>{check.source}<br/><span className="text-fg-3">SHA-256 {check.sha256}</span></span>}</Fact>
            <Fact label="实际运行"><code className="text-[12px]">{check.runs}</code></Fact>
            {check.prefix ? <Fact label="装到">{check.prefix.label}（{check.prefix.path}）</Fact> : null}
            <Fact label="可写位置">{check.writes.join("、")}；其他位置都不能写。</Fact>
            {check.runtime ? <Fact label="Node.js">{check.runtime.satisfied ? `${check.runtime.found} 满足 ${check.runtime.required}` : `要求 ${check.runtime.required}，${check.runtime.path} 是 ${check.runtime.found ?? "读不出版本"}`}</Fact> : null}
          </Facts>
          {check.shellProfile ? <p className="install-shell m-0 text-ui-sm text-amber">安装脚本可能会在 {check.shellProfile} 里加一行 PATH 设置；HarnessHub 只允许它改这一个文件，并在完成后列出改动。</p> : null}
          {check.configFiles.length ? <p className="install-config m-0 text-ui-sm text-fg-2">官方安装会写 {check.configFiles.join("、")}；完成后只列出改动了哪些设置，不显示其他内容。</p> : null}
          <p className="install-terminal m-0 text-ui-sm text-fg-2">{terminalLine(check)}</p>
          {check.notes.map(note => <p key={note} className="install-note m-0 text-ui-sm text-fg-2">{note}</p>)}
          <p className="m-0 text-caption text-fg-3">安装程序在沙箱里只能写上面列出的位置，但它仍能读取你的家目录并联网，这与在终端运行官网命令相同。确认 15 分钟内有效。</p>
        </>}
    </ConfirmBody>
    <ConfirmFooter>
      <button type="button" className="btn" onClick={onClose}>取消</button>
      <button type="button" className="btn btn-primary" disabled={check === null || check.blocked !== null} onClick={() => { if (harness && check) onConfirm(harness, check.fingerprint); }}><Download size={14}/>安装</button>
    </ConfirmFooter>
  </Dialog>;
}
