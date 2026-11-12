import { frontmatter, text } from "./formats.js";
import { userTextProblem } from "./instruction-blocks.js";

/**
 * A skill the user writes in HarnessHub (ADR-045 §7, step 5: commands become shared skills): a name, the one-paragraph
 * description every Harness shows and routes by, and the body. It is written as `~/.agents/skills/<name>/SKILL.md`.
 */
export interface SkillText { readonly description: string; readonly body: string }
/** The agentskills name rule, which is also the folder's name. */
export const SKILL_TEXT_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
export const SKILL_TEXT_BYTES = 8 * 1024 * 1024;

/** The texts as stored and written: trimmed, line breaks LF. */
export function canonicalSkillText(input: SkillText): SkillText { return { description: input.description.trim(), body: input.body.replace(/\r\n/gu, "\n").trim() }; }
/**
 * Why a skill cannot be written from these texts, or null: its name, its description (one paragraph), or its body —
 * which may not hold `` !`…` `` or a ```` ```! ```` block, since OpenCode runs those as shell commands, unasked, when the skill
 * is used as a command. Argument placeholders (`$0`, `$1`, `$ARGUMENTS`, `{{args}}`) are allowed; they differ by Harness.
 */
export function skillTextProblem(name: string, input: SkillText, homes: readonly string[]): string | null {
  if (!SKILL_TEXT_NAME.test(name) || name.length > 64) return "名字只能用小写字母、数字和 -（不能以 - 开头或结尾，不能连续），最多 64 个字符";
  const { description, body } = canonicalSkillText(input);
  if (description === "") return "要写说明：各 Harness 按说明决定什么时候用它";
  if (/\n/u.test(description) || description.length > 1024) return "说明只能是一段（不换行），最多 1024 个字符";
  const descriptionProblem = userTextProblem(description, homes);
  if (descriptionProblem !== null) return "说明" + descriptionProblem;
  if (body === "") return "要写正文";
  if (Buffer.byteLength(body, "utf8") > SKILL_TEXT_BYTES) return "正文最多 8 MiB";
  if (body.includes("!`") || /^```!/mu.test(body)) return "正文不能含 !`…` 或 ```! 代码块：OpenCode 把技能当命令用时会不经确认直接执行它们";
  const bodyProblem = userTextProblem(body, homes);
  return bodyProblem === null ? null : "正文" + bodyProblem;
}
/** The SKILL.md HarnessHub writes: a frontmatter of `name` and `description` (double-quoted, as JSON escapes it), then the body. */
export function renderSkillText(name: string, input: SkillText): string {
  const { description, body } = canonicalSkillText(input);
  return "---\nname: " + name + "\ndescription: " + JSON.stringify(description) + "\n---\n\n" + body + "\n";
}
/** A SKILL.md read back as texts, or null when its frontmatter does not parse or lacks a description. */
export function readSkillText(fileText: string): SkillText | null {
  const head = frontmatter(fileText);
  if (!head.found || head.value === null) return null;
  const description = text(head.value.description);
  if (description === null) return null;
  return { description, body: fileText.replace(/^﻿?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/u, "").replace(/\r\n/gu, "\n").trim() };
}
