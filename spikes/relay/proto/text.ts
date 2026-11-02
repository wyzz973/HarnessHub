// 原型，仅用于测量，不是实现。字符计数、est/1 估算器、语言选择、指纹与 ID 编码。
import { createHash } from "node:crypto";
import type { Family, Language, Size } from "./types.ts";

export const ZERO: Size = { ascii: 0, cjk: 0, other: 0 };
export const utf8 = (s: string): number => Buffer.byteLength(s, "utf8");
export function sha256hex(s: string | Uint8Array): string { return createHash("sha256").update(s).digest("hex"); }

/** CJK 记 1 token/字（v1 §6.2）。原型的 CJK 定义：汉字（含扩展与兼容区）、假名、谚文、CJK 标点 U+3000–303F、全角 U+FF00–FFEF。 */
export function isCjk(cp: number): boolean {
  return (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x3000 && cp <= 0x30ff) || (cp >= 0xff00 && cp <= 0xffef) ||
    (cp >= 0xac00 && cp <= 0xd7af) || (cp >= 0x1100 && cp <= 0x11ff) || (cp >= 0x3130 && cp <= 0x318f) || (cp >= 0x31f0 && cp <= 0x31ff) ||
    (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0x20000 && cp <= 0x3134f);
}
/** est/1 的三元组：ASCII 字符数、CJK 字符数、其余字符的 UTF-8 字节数。O(n)，只读 charCode。 */
export function measure(s: string): Size {
  let ascii = 0, cjk = 0, other = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) { ascii++; continue; }
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) { const cp = ((c - 0xd800) << 10) + (d - 0xdc00) + 0x10000; i++; if (isCjk(cp)) cjk++; else other += 4; continue; }
    }
    if (isCjk(c)) cjk++; else other += c < 0x800 ? 2 : 3;
  }
  return { ascii, cjk, other };
}
export function add(a: Size, b: Size): Size { return { ascii: a.ascii + b.ascii, cjk: a.cjk + b.cjk, other: a.other + b.other }; }
export function sub(a: Size, b: Size): Size { return { ascii: a.ascii - b.ascii, cjk: a.cjk - b.cjk, other: a.other - b.other }; }
export function sizeBytes(s: Size): number { return s.ascii + s.other + s.cjk * 3; }

export const FAMILY_FACTOR: Readonly<Record<Family, number>> = { anthropic: 1.3, openai: 1.0, deepseek: 1.0, unknown: 1.3 };
/**
 * est/1（v1 §6.2）：ceil(ascii/3.4 + cjk + other/2.5) × factor(family)。
 * 原型把 factor 放进 ceil 里，结果是整数；v1 写法在 factor=1.3 时得到小数。
 */
export function est(size: Size, family: Family): number {
  return Math.ceil((size.ascii / 3.4 + size.cjk + size.other / 2.5) * FAMILY_FACTOR[family]);
}
export function estText(s: string, family: Family): number { return est(measure(s), family); }
/** 把 token 余量换成字节上限的保守初值：按该文本自己的字节/token 比，向下取整。 */
export function bytesForTokens(text: string, tokens: number, family: Family): number {
  if (tokens <= 0) return 0;
  const t = Math.max(1, estText(text, family));
  return Math.floor(utf8(text) * tokens / t);
}

/** 字母与汉字计数，用于框架语言选择（v1 §5.4）：CJK 占比 ≥20% 选中文；当前输入少于 8 个字母或汉字时按首条用户消息判定。 */
function letters(s: string): { letters: number; cjk: number } {
  let l = 0, c = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (isCjk(cp) && !(cp >= 0x3000 && cp <= 0x303f) && !(cp >= 0xff00 && cp <= 0xffef)) { c++; l++; }
    else if (/\p{L}/u.test(ch)) l++;
  }
  return { letters: l, cjk: c };
}
export function chooseLanguage(current: string, firstUserText: string): Language {
  // 只看前 4,000 个 UTF-16 单元：占比判定不需要全文（原型的取舍）。
  let m = letters(current.slice(0, 4000));
  if (m.letters < 8) m = letters(firstUserText.slice(0, 4000));
  if (m.letters === 0) return "en";
  return m.cjk / m.letters >= 0.2 ? "zh" : "en";
}

// ---------- 截断（按码点，不切开代理对） ----------
export function headChars(s: string, n: number): string {
  if (n <= 0) return "";
  if (s.length <= n) return s;
  let end = n;
  const c = s.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end -= 1;
  return s.slice(0, end);
}
export function tailChars(s: string, n: number): string {
  if (n <= 0) return "";
  if (s.length <= n) return s;
  let start = s.length - n;
  const c = s.charCodeAt(start);
  if (c >= 0xdc00 && c <= 0xdfff) start += 1;
  return s.slice(start);
}
/** UTF-8 字节意义上的头尾截断（v1 §5.3 的 KiB 上限）。 */
export function headBytes(s: string, bytes: number): string {
  if (utf8(s) <= bytes) return s;
  let lo = 0, hi = Math.min(s.length, bytes);
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (utf8(headChars(s, mid)) <= bytes) lo = mid; else hi = mid - 1; }
  return headChars(s, lo);
}
export function tailBytes(s: string, bytes: number): string {
  if (utf8(s) <= bytes) return s;
  let lo = 0, hi = Math.min(s.length, bytes);
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (utf8(tailChars(s, mid)) <= bytes) lo = mid; else hi = mid - 1; }
  return tailChars(s, lo);
}
export function codePoints(s: string): number { let n = 0; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if (!(c >= 0xdc00 && c <= 0xdfff)) n++; } return n; }

// ---------- 指纹与 ID ----------
/** 键排序的 JSON：指纹、清单头与摘要行的哈希都用它，保证与对象构造顺序无关。 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(item => canonicalJson(item === undefined ? null : item)).join(",") + "]";
  const keys = Object.keys(value as Record<string, unknown>).filter(k => (value as Record<string, unknown>)[k] !== undefined).sort();
  return "{" + keys.map(k => JSON.stringify(k) + ":" + canonicalJson((value as Record<string, unknown>)[k])).join(",") + "}";
}
const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";
/** Crockford base32（小写，无 i l o u）。v1 样例 ID 含 0/1/8/9 而无 i/l/o/u，原型据此选这一字母表。 */
export function crockford32(bytes: Uint8Array, chars: number): string {
  let out = "", bits = 0, value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5 && out.length < chars) { out += CROCKFORD[(value >>> (bits - 5)) & 31]; bits -= 5; }
    if (out.length >= chars) break;
    value &= (1 << bits) - 1;
  }
  return out;
}
export function packetIdFrom(headerJson: string): string {
  return "relay-" + crockford32(createHash("sha256").update(headerJson).digest(), 20);
}

// ---------- 确定性伪随机（合成数据与模糊测试用） ----------
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
