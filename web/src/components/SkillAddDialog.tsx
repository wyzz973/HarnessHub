import { Download, Search } from "lucide-react";
import { useEffect, useState } from "react";
import type { SkillSourceListing } from "../../../src/contracts/capabilities.js";
import { errorMessage, type GatewayApi } from "../api.js";
import { Dialog } from "../ui/overlay.js";
import { Badge, Notice, Spinner } from "../ui/primitives.js";
import { DIALOG_BODY, DIALOG_FOOT, type ChangeRequest } from "./CapabilityChangeDialog.js";

const STATE_LABEL: Readonly<Record<SkillSourceListing["skills"][number]["state"], string>> = { new: "可添加", installed: "已安装", conflict: "同名冲突", refused: "不能安装" };
/** Blue for what can be added, amber for a clash the user has to settle, grey for the rest (ADR-054 §1). */
const STATE_TONE: Readonly<Record<SkillSourceListing["skills"][number]["state"], "accent" | "amber" | "neutral">> = { new: "accent", installed: "neutral", conflict: "amber", refused: "neutral" };
function size(bytes: number): string { return bytes < 1024 ? bytes + " B" : bytes < 1024 * 1024 ? (bytes / 1024).toFixed(1) + " KB" : (bytes / 1024 / 1024).toFixed(1) + " MB"; }

/**
 * Adding skills from a GitHub repository (ADR-045 §4): the repository is read first and its skills listed with what each
 * holds; the chosen ones then go to the usual confirmation, which shows the folders before anything is written.
 */
export function SkillAddDialog({ api, open, onClose, onChange }: { readonly api: GatewayApi; readonly open: boolean; readonly onClose: () => void; readonly onChange: (request: ChangeRequest) => void }) {
  const [source, setSource] = useState(""), [listing, setListing] = useState<SkillSourceListing | null>(null), [busy, setBusy] = useState(false), [failure, setFailure] = useState<string | null>(null);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => { if (!open) { setListing(null); setFailure(null); setChosen(new Set()); setBusy(false); } }, [open]);
  const read = () => {
    if (!source.trim() || busy) return;
    setBusy(true); setFailure(null); setListing(null); setChosen(new Set());
    api.listSkillSource(source.trim()).then(value => { setBusy(false); setListing(value); setChosen(new Set(value.skills.filter(skill => skill.state === "new" && skill.installName !== null).map(skill => skill.installName!))); },
      error => { setBusy(false); setFailure(errorMessage(error)); });
  };
  const add = () => {
    if (listing === null || !chosen.size) return;
    const names = [...chosen], title = names.length === 1 ? "添加技能 " + names[0] : "添加 " + names.length + " 个技能";
    onChange({ title, verb: "添加", on: null, icon: "add", done: names.length === 1 ? "已添加技能 " + names[0] : "已添加 " + names.length + " 个技能", load: () => api.checkSkillAdd(listing.id, names) });
    onClose();
  };
  const toggle = (name: string) => setChosen(current => { const next = new Set(current); if (next.has(name)) next.delete(name); else next.add(name); return next; });
  return <Dialog open={open} onOpenChange={value => { if (!value && !busy) onClose(); }} title="从 GitHub 添加技能" description="技能放进共享目录 ~/.agents/skills，各 Agent 按自己的方式读取。" className="skill-add-dialog w-[min(640px,calc(100vw-32px))]">
    <div className={DIALOG_BODY}>
      <form className="flex gap-2" onSubmit={event => { event.preventDefault(); read(); }}>
        <label className="flex h-[34px] min-w-0 flex-1 items-center gap-2 rounded-control bg-surface px-2.5 text-fg-3 shadow-[inset_0_0_0_1px_var(--border-strong)] focus-within:shadow-[inset_0_0_0_1px_var(--accent),0_0_0_3px_var(--accent-soft)]">
          <Search size={15} className="flex-none" aria-hidden="true"/>
          <input className="h-full min-w-0 flex-1 border-0 bg-transparent p-0 text-ui-sm text-fg outline-none placeholder:text-placeholder" aria-label="GitHub 仓库" placeholder="owner/repo 或 https://github.com/owner/repo" value={source} onChange={event => setSource(event.target.value)}/></label>
        <button type="submit" className="btn" disabled={busy || !source.trim()}>{busy ? <Spinner size={13} label=""/> : null}读取</button>
      </form>
      <p className="m-0 text-caption text-fg-3">只读取 GitHub 上的公开仓库，不使用任何令牌。metadata.json、.git 等不会复制，与 npx skills 一致。</p>
      {failure ? <Notice tone="red">{failure}</Notice> : null}
      {busy ? <p className="m-0 flex items-center gap-2 text-fg-2" role="status"><Spinner size={14} label=""/>正在下载并读取仓库…</p> : null}
      {listing ? <>
        <p className="m-0 text-caption text-fg-2"><span className="break-all">{listing.repository}</span>{listing.ref ? " · " + listing.ref : ""} · <code>{listing.commit.slice(0, 12)}</code> · 找到 {listing.skills.length} 个技能</p>
        {listing.skills.length === 0 ? <Notice tone="neutral">这个仓库里没有找到技能（带 SKILL.md 的文件夹）。</Notice>
          : <ul className="skill-source-list m-0 flex list-none flex-col overflow-hidden rounded-block p-0 shadow-[inset_0_0_0_1px_var(--border)]">{listing.skills.map(skill => {
          const selectable = skill.state === "new" && skill.installName !== null;
          return <li key={skill.folder} className="flex items-start gap-2.5 px-3 py-2.5 [&+&]:hairline-t">
            <input type="checkbox" className="mt-[3px] size-3.5 flex-none accent-accent" aria-label={"选择 " + skill.name} disabled={!selectable} checked={selectable && chosen.has(skill.installName!)} onChange={() => toggle(skill.installName!)}/>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5"><strong className="font-medium break-all">{skill.name}</strong><Badge tone={STATE_TONE[skill.state]}>{STATE_LABEL[skill.state]}</Badge>
                <code className="min-w-0 text-caption break-all text-fg-3">{skill.folder || "（仓库根目录）"}</code></span>
              {skill.description ? <span className="text-fg-2">{skill.description}</span> : null}
              <span className="text-caption text-fg-3">{skill.files} 个文件 · {size(skill.bytes)}{skill.executables ? " · 含 " + skill.executables + " 个可执行文件" : ""}{skill.plugin ? " · 带插件清单" : ""}{skill.installName && skill.installName !== skill.name ? " · 文件夹名 " + skill.installName : ""}</span>
              {skill.reason ? <span className={skill.state === "conflict" ? "text-caption text-amber" : "text-caption text-fg-2"}>{skill.reason}</span> : null}
            </span></li>;
        })}</ul>}
      </> : null}
    </div>
    <div className={DIALOG_FOOT}>
      <button type="button" className="btn" disabled={busy} onClick={onClose}>取消</button>
      <button type="button" className="btn btn-primary" disabled={listing === null || !chosen.size || busy} onClick={add}><Download size={14}/>添加所选（{chosen.size}）</button>
    </div>
  </Dialog>;
}
