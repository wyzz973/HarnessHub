// 原型，仅用于测量，不是实现。v1 §10.2 的第 1 层（已知秘密精确匹配）、少量第 2 层形状规则与第 3 层 HMAC 标签。
// 不实现：键名类规则（masking.ts:11–13 的 KEYED）、熵规则与排除表、误报放行（relay.redaction_overridden）。
import { createHmac } from "node:crypto";
import { EXT_INVISIBLE } from "./escape.ts";

export interface KnownSecret { readonly name: string; readonly value: string; readonly label: string }
export interface RedactOptions {
  /** regex：一个按长度降序的字面量交替式；aho：Aho–Corasick；indexof：逐个 indexOf。三者输出相同。 */
  readonly engine?: "regex" | "aho" | "indexof";
  /** raw：直接在原文上匹配；skeleton：先去掉 C0/DEL 与不可见字符再匹配，命中区间映射回原文（被零宽字符切开的秘密也能命中）。 */
  readonly view?: "raw" | "skeleton";
  readonly shapes?: boolean;
  /** v1：原值、JSON 转义、URL 编码三种形式；extended：另加小写百分号、表单编码（+ 表示空格）、JSON 的 \/ 与 \uXXXX 形式、双重 URL 编码。 */
  readonly forms?: "v1" | "extended";
}
export interface Redaction { readonly text: string; readonly count: number }
export interface Redactor { readonly patterns: number; readonly maxPatternLength: number; redact(text: string): Redaction }

export const MIN_SECRET_LENGTH = 8;   // v1 §10.2：长度 ≥8 的环境值才进入精确匹配
const TAG = (label: string, mac: string): string => "〔已脱敏 · " + label + " · #" + mac + "〕";

export function formsOf(value: string, forms: "v1" | "extended"): string[] {
  const json = JSON.stringify(value).slice(1, -1), url = encodeURIComponent(value);
  const out = [value, json, url];
  if (forms === "extended") {
    out.push(url.replace(/%[0-9A-F]{2}/g, m => m.toLowerCase()));
    out.push(new URLSearchParams({ v: value }).toString().slice(2));
    out.push(json.replace(/\//g, "\\/"));
    out.push(json.replace(/[\u0080-\uFFFF]/g, ch => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0")));
    out.push(encodeURIComponent(url));
  }
  return [...new Set(out)];
}

// ---------- Aho–Corasick（UTF-16 码元；根节点用稠密表，其余用 Map） ----------
class Aho {
  readonly root = new Int32Array(65536);
  readonly next: Map<number, number>[] = [new Map()];
  readonly patterns: readonly string[];
  fail: Int32Array = new Int32Array(1);
  out: Int32Array = new Int32Array(1);
  dict: Int32Array = new Int32Array(1);
  constructor(patterns: readonly string[]) {
    this.patterns = patterns;
    const outList: number[] = [-1];
    for (let p = 0; p < patterns.length; p++) {
      const s = patterns[p]!; let node = 0;
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i), m = this.next[node]!;
        let child = m.get(c);
        if (child === undefined) { child = this.next.length; this.next.push(new Map()); outList.push(-1); m.set(c, child); }
        node = child;
      }
      const prior = outList[node]!;
      if (prior < 0 || patterns[prior]!.length < s.length) outList[node] = p;
    }
    const n = this.next.length;
    this.fail = new Int32Array(n); this.out = Int32Array.from(outList); this.dict = new Int32Array(n);
    for (const [c, child] of this.next[0]!) this.root[c] = child;
    const queue: number[] = [];
    for (const child of this.next[0]!.values()) { this.fail[child] = 0; this.dict[child] = 0; queue.push(child); }
    for (let q = 0; q < queue.length; q++) {
      const node = queue[q]!;
      for (const [c, child] of this.next[node]!) {
        let f = this.fail[node]!;
        while (f !== 0 && !this.next[f]!.has(c)) f = this.fail[f]!;
        const target = f === 0 ? this.root[c]! : this.next[f]!.get(c)!;
        this.fail[child] = target === child ? 0 : target;
        this.dict[child] = this.out[this.fail[child]!]! >= 0 ? this.fail[child]! : this.dict[this.fail[child]!]!;
        queue.push(child);
      }
    }
  }
  /** 返回所有命中 [start, end, pattern]，由调用方取最左最长、不重叠。 */
  scan(text: string): [number, number, number][] {
    const hits: [number, number, number][] = [];
    let state = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (state === 0) { state = this.root[c]!; if (state === 0) continue; }
      else {
        let nextState = this.next[state]!.get(c);
        while (nextState === undefined && state !== 0) { state = this.fail[state]!; nextState = state === 0 ? (this.root[c]! || undefined) : this.next[state]!.get(c); }
        state = nextState ?? 0;
        if (state === 0) continue;
      }
      for (let k = this.out[state]! >= 0 ? state : this.dict[state]!; k !== 0; k = this.dict[k]!) {
        const p = this.out[k]!; if (p >= 0) { const len = this.patterns[p]!.length; hits.push([i + 1 - len, i + 1, p]); }
      }
    }
    return hits;
  }
}

function leftmostLongest(hits: [number, number, number][]): [number, number, number][] {
  hits.sort((a, b) => a[0] - b[0] || (b[1] - b[0]) - (a[1] - a[0]) || a[2] - b[2]);
  const out: [number, number, number][] = []; let end = -1;
  for (const h of hits) if (h[0] >= end) { out.push(h); end = h[1]; }
  return out;
}
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const SKELETON_DROP = new RegExp("[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7F]|" + EXT_INVISIBLE.source, "u");
/**
 * 快速预检（无 u 标志，只看 BMP 码元）：是 SKELETON_DROP 的超集——BMP 里的 \p{Cf} 与其余不可见字符，
 * 加上含 Cf 字符的增补平面的高位代理（U+110BD、U+13430、U+1BCA0、U+1D173、U+E0000 段）。命中才走精确的骨架路径。
 */
const SKELETON_PRECHECK = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F\xAD\u034F\u0600-\u0605\u061C\u06DD\u070F\u0890\u0891\u08E2\u115F\u1160\u17B4\u17B5\u180B-\u180E\u200B-\u200F\u2028-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF9-\uFFFB\uD804\uD80D\uD82F\uD834\uDB40]/;
const SKELETON_DROP_G = new RegExp(SKELETON_DROP.source, "gu");

interface Shape { readonly label: string; readonly re: RegExp; readonly keep?: number }
/** 少量形状规则（取自 masking.ts:15–16、run-diagnostics.ts:14–21 与 v1 §10.2 的列表）。keep：保留的前置分组号。 */
export const SHAPES: readonly Shape[] = [
  { label: "私钥", re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g },
  { label: "Anthropic 密钥", re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g },
  { label: "OpenAI 密钥", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  { label: "GitHub 令牌", re: /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})/g },
  { label: "Slack 令牌", re: /\bxox[abprs]-[A-Za-z0-9-]{8,}/g },
  { label: "AWS 访问密钥", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { label: "Google API 密钥", re: /\bAIza[0-9A-Za-z_-]{20,}/g },
  { label: "Stripe 密钥", re: /\b[rs]k_live_[A-Za-z0-9]{16,}/g },
  { label: "JWT", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { label: "Bearer 令牌", re: /(\b(?:Bearer|Basic)\s+)[A-Za-z0-9._~+/-]{16,}=*/g, keep: 1 },
  { label: "URL 凭据", re: /(https?:\/\/)[^\s/@:"'<>]+:[^\s/@"'<>]+@/g, keep: 1 },
];

export function createRedactor(secrets: readonly KnownSecret[], key: Uint8Array, options: RedactOptions = {}): Redactor {
  const engine = options.engine ?? "regex", view = options.view ?? "skeleton", shapes = options.shapes ?? true, forms = options.forms ?? "v1";
  const mac = (value: string): string => createHmac("sha256", key).update(value).digest("hex").slice(0, 8);
  // 模式按长度降序、再按字典序：交替式里先试长的，得到最左最长；同一个值只出一个标签。
  const entries: { readonly pattern: string; readonly tag: string }[] = [];
  const seen = new Set<string>();
  for (const secret of secrets) {
    if (secret.value.length < MIN_SECRET_LENGTH) continue;
    const tag = TAG(secret.label, mac(secret.value));
    for (const form of formsOf(secret.value, forms)) if (!seen.has(form)) { seen.add(form); entries.push({ pattern: form, tag }); }
  }
  entries.sort((a, b) => b.pattern.length - a.pattern.length || (a.pattern < b.pattern ? -1 : a.pattern > b.pattern ? 1 : 0));
  const patterns = entries.map(e => e.pattern);
  const regex = patterns.length === 0 ? null : new RegExp(patterns.map(escapeRe).join("|"), "g");
  const aho = engine === "aho" && patterns.length > 0 ? new Aho(patterns) : null;
  const maxLen = patterns.reduce((m, p) => Math.max(m, p.length), 0);
  const shapeTags = new Map<string, string>();
  const shapeTag = (label: string, value: string): string => { const k = label + "\u0000" + value; let t = shapeTags.get(k); if (t === undefined) { t = TAG(label, mac(value)); shapeTags.set(k, t); } return t; };

  function spans(text: string): [number, number, number][] {
    if (patterns.length === 0) return [];
    if (engine === "aho") return leftmostLongest(aho!.scan(text));
    if (engine === "indexof") {
      const hits: [number, number, number][] = [];
      for (let p = 0; p < patterns.length; p++) { const s = patterns[p]!; for (let i = text.indexOf(s); i >= 0; i = text.indexOf(s, i + 1)) hits.push([i, i + s.length, p]); }
      return leftmostLongest(hits);
    }
    const hits: [number, number, number][] = [];
    const re = regex!; re.lastIndex = 0;
    for (let m = re.exec(text); m !== null; m = re.exec(text)) hits.push([m.index, m.index + m[0].length, patterns.indexOf(m[0])]);
    return hits;
  }
  function exact(text: string): Redaction {
    if (patterns.length === 0) return { text, count: 0 };
    let hits: [number, number, number][];
    if (view === "skeleton" && SKELETON_PRECHECK.test(text) && SKELETON_DROP.test(text)) {
      // 跳过的字符不参与匹配；命中区间映射回原文，连同中间被跳过的字符一起替换。
      const map = new Int32Array(text.length); let n = 0;
      const parts: string[] = [];
      let last = 0; SKELETON_DROP_G.lastIndex = 0;
      for (let m = SKELETON_DROP_G.exec(text); m !== null; m = SKELETON_DROP_G.exec(text)) {
        for (let i = last; i < m.index; i++) map[n++] = i;
        parts.push(text.slice(last, m.index)); last = m.index + m[0].length;
      }
      for (let i = last; i < text.length; i++) map[n++] = i;
      parts.push(text.slice(last));
      const skel = parts.join("");
      hits = spans(skel).map(([s, e, p]) => [map[s]!, map[e - 1]! + 1, p]);
    } else hits = spans(text);
    if (hits.length === 0) return { text, count: 0 };
    let out = "", at = 0;
    for (const [s, e, p] of hits) { out += text.slice(at, s) + entries[p]!.tag; at = e; }
    return { text: out + text.slice(at), count: hits.length };
  }
  return {
    patterns: patterns.length, maxPatternLength: maxLen,
    redact(text: string): Redaction {
      const first = exact(text);
      if (!shapes) return first;
      let s = first.text, count = first.count;
      for (const shape of SHAPES) {
        shape.re.lastIndex = 0;
        if (!shape.re.test(s)) continue;
        shape.re.lastIndex = 0;
        s = s.replace(shape.re, (whole: string, ...groups: unknown[]) => {
          count++;
          if (shape.keep === undefined) return shapeTag(shape.label, whole);
          const kept = groups[shape.keep - 1] as string;
          return kept + shapeTag(shape.label, whole.slice(kept.length));
        });
      }
      return { text: s, count };
    },
  };
}
