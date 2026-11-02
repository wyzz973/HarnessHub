// 原型，仅用于测量，不是实现。v1 §5.2 N1–N4 与 §10.3 的两个全函数转义器：围栏块与行内字段。
// 每个函数对任意字符串都有定义（不抛错），输出只依赖输入与规则版本。
import { headChars, sha256hex } from "./text.ts";
import type { Language } from "./types.ts";

export interface EscapeRules {
  readonly name: string;
  /** v1：只改写 v1 §5.2 列出的双向与零宽字符；extended：全部 \p{Cf}、U+2028/2029、C1、标签字符、多数变体选择符等。 */
  readonly invisibles: "v1" | "extended";
  /** v1：只给以“〔HarnessHub”“〔交接材料结束”开头的行加前缀；extended：再加增量、重锚、重发的结束行与英文框架行，允许行首空白。 */
  readonly markers: "v1" | "extended";
  /** v1：只改写字面的 “<<<HH-”；extended：容忍大小写、全角与中间空白。 */
  readonly reserved: "v1" | "extended";
  // 以下开关只给模糊测试的变异对照用：故意弄坏一条规则，证明检查能发现。
  readonly brokenFixedFence?: boolean;
  readonly brokenNoReserved?: boolean;
  readonly brokenNoMarkers?: boolean;
  readonly brokenInlineBackticks?: boolean;
  readonly brokenInlineNewlines?: boolean;
}
export const V1_RULES: EscapeRules = { name: "v1", invisibles: "v1", markers: "v1", reserved: "v1" };
export const EXTENDED_RULES: EscapeRules = { name: "extended", invisibles: "extended", markers: "extended", reserved: "extended" };

const C0 = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;
const C0_DEL = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;
export const V1_INVISIBLE = /[\u202A-\u202E\u2066-\u2069\u200B-\u200D\u2060\uFEFF]/g;
export const EXT_INVISIBLE = /[\p{Cf}\u2028\u2029\u0080-\u009F\u034F\u115F\u1160\u17B4\u17B5\u180B-\u180D\u3164\uFE00-\uFE0E\uFFA0\u{E0100}-\u{E01EF}]/gu;
const V1_MARKERS = /^(?=〔HarnessHub|〔交接材料结束)/gm;
const EXT_MARKERS = /^(?=[ \t]*(?:〔HarnessHub|〔交接材料结束|〔交接更新结束|〔重锚结束|〔重发结束|\[HarnessHub|\[End of handoff))/gim;
const V1_RESERVED = /<<<HH-/g;
const EXT_RESERVED = /[<＜﹤]{3}\s*[HhＨｈ]\s*[HhＨｈ]\s*[-－﹣‐‑]/g;
export const QUOTE_PREFIX: Readonly<Record<Language, string>> = { zh: "（引用）", en: "(quoted) " };

function visible(ch: string): string { return "‹U+" + ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0") + "›"; }

/**
 * N1–N3：统一为 LF；exec_output 每行只取最后一个 \r 之后的内容（进度条）；其余文本里孤立的 \r 视为换行；
 * 去掉 \n、\t 以外的 C0（extended 另去 DEL）。脱敏在这一步之后执行（原型顺序，见 README）。
 */
export function normalize(text: string, cls: "exec_output" | "text", rules: EscapeRules): string {
  let s = text.indexOf("\r") < 0 ? text : text.replace(/\r\n/g, "\n");
  if (s.indexOf("\r") >= 0) {
    s = cls === "exec_output" ? s.split("\n").map(line => { const i = line.lastIndexOf("\r"); return i < 0 ? line : line.slice(i + 1); }).join("\n") : s.replace(/\r/g, "\n");
  }
  return s.replace(rules.invisibles === "extended" ? C0_DEL : C0, "");
}
/** N4 与保留串：不可见字符改写为可见的 ‹U+XXXX›；“<<<HH-”改写为“‹‹‹HH-”；以框架标记开头的行加“（引用）”。 */
export function neutralize(text: string, rules: EscapeRules, lang: Language): string {
  let s = text.replace(rules.invisibles === "extended" ? EXT_INVISIBLE : V1_INVISIBLE, visible);
  if (!rules.brokenNoReserved) s = s.replace(rules.reserved === "extended" ? EXT_RESERVED : V1_RESERVED, "‹‹‹HH-");
  if (!rules.brokenNoMarkers) s = s.replace(rules.markers === "extended" ? EXT_MARKERS : V1_MARKERS, QUOTE_PREFIX[lang]);
  return s;
}
export function longestBacktickRun(s: string): number {
  let max = 0, run = 0;
  for (let i = 0; i < s.length; i++) { if (s.charCodeAt(i) === 96) { run++; if (run > max) max = run; } else run = 0; }
  return max;
}
/** 逐字块：```text 围栏，长度 = max(3, 块内最长连续反引号数 + 1)；body 须已 neutralize。indent 用于列表项内的块。 */
export function fence(body: string, rules: EscapeRules, indent = ""): string {
  const n = rules.brokenFixedFence ? 3 : Math.max(3, longestBacktickRun(body) + 1);
  const f = "`".repeat(n);
  const b = body.endsWith("\n") ? body.slice(0, -1) : body;
  const content = indent === "" ? b : b.split("\n").map(line => indent + line).join("\n");
  return indent + f + "text\n" + content + "\n" + indent + f;
}
/** 围栏块转义器：normalize → （调用方脱敏）→ neutralize → fence。这里给已脱敏文本用。 */
export function block(redacted: string, rules: EscapeRules, lang: Language, indent = ""): string {
  return fence(neutralize(redacted, rules, lang), rules, indent);
}
/**
 * 行内字段转义器（路径、分支名、测试名、工具标题、模型名、计划条目）：换行 → ⏎，反引号 → ‘，| → ｜，
 * 行首 # - > 前加“·”，控制字符删除，不可见字符可见化，保留串改写。结果总放在行内代码里（见 README）。
 */
export function inline(text: string, rules: EscapeRules, lang: Language, maxChars = 400): string {
  let s = text.replace(/\r\n?/g, "\n").replace(rules.invisibles === "extended" ? C0_DEL : C0, "");
  if (s.length > maxChars) s = headChars(s, maxChars) + "…";
  if (!rules.brokenInlineNewlines) s = s.replace(/\n/g, "⏎");
  s = neutralize(s, rules, lang);
  if (!rules.brokenInlineBackticks) s = s.replace(/`/g, "‘");
  s = s.replace(/\|/g, "｜");
  if (/^[#>-]/.test(s)) s = "·" + s;
  return s === "" ? "∅" : s;
}
/** 首行：用户原话前 ≤200 字，换行折成空格（v1 §5.1）；只做控制与不可见字符处理和行首标记前缀。 */
export function firstLine(input: string, rules: EscapeRules, lang: Language): string {
  let s = input.replace(/\r\n?|\n/g, " ").replace(rules.invisibles === "extended" ? C0_DEL : C0, "");
  s = headChars(s, 200);
  return neutralize(s, rules, lang);
}
/** 记录区：<<<HH-DATA b BEGIN>>> … <<<HH-DATA b END>>>，b = 区内正文 sha256 的前 8 位。正文里的 <<<HH- 已在槽位转义时改写。 */
export function dataRegion(body: string): string {
  const b = sha256hex(body).slice(0, 8);
  return "<<<HH-DATA " + b + " BEGIN>>>\n" + body + "\n<<<HH-DATA " + b + " END>>>";
}
