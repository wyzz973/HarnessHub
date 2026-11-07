import { useEffect, useState } from "react";
import type { SkillTextView } from "../../../src/contracts/capabilities.js";
import { Dialog } from "../ui/overlay.js";
import { DIALOG_BODY, DIALOG_FOOT, Field } from "./CapabilityChangeDialog.js";

/**
 * Writing a skill from text (ADR-045 step 5: commands become shared skills): its name (new skills only), the
 * one-paragraph description and the body. Nothing is written here: the texts go to the usual check and confirmation.
 */
export function SkillTextDialog({ editing, onClose, onSubmit }: { readonly editing: { readonly name: string | null; readonly text: SkillTextView } | null; readonly onClose: () => void;
  readonly onSubmit: (name: string, text: SkillTextView) => void }) {
  const [name, setName] = useState(""), [description, setDescription] = useState(""), [body, setBody] = useState("");
  useEffect(() => { if (editing === null) return; setName(editing.name ?? ""); setDescription(editing.text.description); setBody(editing.text.body); }, [editing]);
  return <Dialog open={editing !== null} onOpenChange={open => { if (!open) onClose(); }} title={editing?.name ? "编辑技能 " + editing.name : "新建技能"}
    description="写进共享目录 ~/.agents/skills，本机所有 Harness 都读得到；Claude Code、OpenCode、Cursor 把它列成 / 命令，Codex 用 $名字 调用。" className="skill-text-dialog w-[min(640px,calc(100vw-32px))]">
    <div className={DIALOG_BODY}>
      {editing?.name ? null : <Field label="名字（小写字母、数字和 -，也是文件夹名）"><input className="field" aria-label="技能名字" value={name} placeholder="standup-notes" onChange={event => setName(event.target.value)}/></Field>}
      <Field label="说明（一段；各 Harness 按它决定什么时候用）"><input className="field" aria-label="技能说明" value={description} onChange={event => setDescription(event.target.value)}/></Field>
      <Field label="正文（家目录写成 ~；不能含 !`…`）"><textarea className="field min-h-[180px] font-mono text-code" aria-label="技能正文" value={body} onChange={event => setBody(event.target.value)}/></Field>
      <p className="m-0 text-caption text-fg-3">参数占位符各家不同：Claude Code 的 $0 是第一个参数，OpenCode、Cursor 的 $1 才是；Codex 的技能没有参数。</p>
    </div>
    <div className={DIALOG_FOOT}>
      <button type="button" className="btn" onClick={onClose}>取消</button>
      <button type="button" className="btn btn-primary" onClick={() => onSubmit(editing?.name ?? name.trim(), { description, body })}>检查改动</button>
    </div>
  </Dialog>;
}
