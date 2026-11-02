// 原型，仅用于测量，不是实现。测量 5：已知秘密精确匹配脱敏的吞吐（1 MiB 文本、50 个秘密值）与夹具漏检数；
// 另测少量形状规则的开销，并用一组对抗用例标出精确匹配本身的边界（这些不计入“应为 0”的漏检数）。
import { normalize, V1_RULES } from "../proto/escape.ts";
import { createRedactor, formsOf } from "../proto/redaction.ts";
import type { KnownSecret, RedactOptions } from "../proto/redaction.ts";
import { sha256hex, tailChars } from "../proto/text.ts";
import { syntheticSecrets, TEST_KEY, text } from "./gen.ts";
import { now, summary } from "./common.ts";

const MiB = 1024 * 1024;
/** 1 MiB 合成文本：中英文与代码混排，每 4 KiB 中间插入一个秘密（轮流用原值、JSON 转义、URL 编码三种形式）。 */
export function corpus(secrets: readonly KnownSecret[]): { text: string; planted: number } {
  const parts: string[] = []; let planted = 0, bytes = 0, i = 0;
  while (bytes < MiB) {
    const s = secrets[i % secrets.length]!.value, form = formsOf(s, "v1")[i % 3] ?? s;
    const chunk = text(2048, i) + " token=" + form + " " + text(2000, i + 1) + "\n";
    parts.push(chunk); bytes += Buffer.byteLength(chunk); planted++; i++;
  }
  return { text: parts.join(""), planted };
}
function leaks(out: string, secrets: readonly KnownSecret[]): number {
  let n = 0;
  for (const s of secrets) for (const f of formsOf(s.value, "v1")) for (let k = out.indexOf(f); k >= 0; k = out.indexOf(f, k + 1)) n++;
  return n;
}
/** 夹具：每个秘密 × 10 种上下文 × 三种形式。期望漏检 0。 */
export function fixture(secrets: readonly KnownSecret[]): { name: string; text: string }[] {
  const cases: { name: string; text: string }[] = [];
  for (const s of secrets) {
    const v = s.value, json = JSON.stringify(v).slice(1, -1), url = encodeURIComponent(v);
    for (const [form, f] of [["raw", v], ["json", json], ["url", url]] as const) {
      cases.push({ name: form + ":cjk-neighbors", text: "密钥是" + f + "。" });
      cases.push({ name: form + ":whole", text: f });
      cases.push({ name: form + ":adjacent-repeat", text: f + f });
      cases.push({ name: form + ":ansi", text: "\u001b[31m" + f + "\u001b[0m" });
      cases.push({ name: form + ":crlf", text: "line1\r\n" + f + "\r\nline3" });
      cases.push({ name: form + ":env", text: "export " + s.name + "=" + f });
      cases.push({ name: form + ":bearer", text: "Authorization: Bearer " + f });
      cases.push({ name: form + ":start-end", text: f + " middle " + f });
    }
    cases.push({ name: "json-document", text: JSON.stringify({ env: { [s.name]: v }, note: "echoed" }) });
    cases.push({ name: "url-query", text: "https://example.invalid/cb?" + s.name.toLowerCase() + "=" + url + "&x=1" });
  }
  // 重叠：B 以 A 为前缀，两者都是已知秘密；最左最长应整段替换 B。
  const a = secrets[0]!.value, b = a + "XYZ123";
  cases.push({ name: "overlap-prefix", text: "x " + b + " y " + a + " z" });
  return cases;
}

export function run(): Record<string, unknown> {
  const secrets = syntheticSecrets(50, 11);
  const { text: big, planted } = corpus(secrets);
  const bigBytes = Buffer.byteLength(big);
  const configs: { name: string; opts: RedactOptions }[] = [];
  for (const engine of ["regex", "aho", "indexof"] as const) for (const view of ["raw", "skeleton"] as const) for (const shapes of [false, true]) configs.push({ name: engine + "/" + view + (shapes ? "+shapes" : ""), opts: { engine, view, shapes } });
  const throughput: Record<string, unknown> = {};
  const outputs = new Map<string, string>();
  for (const c of configs) {
    const r = createRedactor(secrets, TEST_KEY, c.opts);
    for (let i = 0; i < 3; i++) r.redact(big);
    const xs: number[] = []; let out = "";
    for (let i = 0; i < 30; i++) { const t = now(); out = r.redact(big).text; xs.push(now() - t); }
    const s = summary(xs, 2);
    const key = (c.opts.view ?? "") + (c.opts.shapes ? "+s" : "");
    const same = outputs.has(key) ? outputs.get(key) === out : (outputs.set(key, out), true);
    throughput[c.name] = { patterns: r.patterns, msPerMiB: { p50: Number((s.p50 * MiB / bigBytes).toFixed(2)), p95: Number((s.p95 * MiB / bigBytes).toFixed(2)) }, MiBps: Number((bigBytes / MiB / (s.p50 / 1000)).toFixed(1)), leaks: leaks(out, secrets), sameOutputAsRegex: same };
  }
  // 夹具（原型管线：规范化 → 脱敏；默认配置 regex + skeleton + 形状规则；另跑全部配置）
  const fx = fixture(secrets);
  const fixtureResult: Record<string, unknown> = {};
  for (const c of configs) {
    const extra: KnownSecret[] = [...secrets, { name: "LONGER", value: secrets[0]!.value + "XYZ123", label: "较长密钥" }];
    const r = createRedactor(extra, TEST_KEY, c.opts);
    let missed = 0;
    const missedNames: string[] = [];
    for (const k of fx) { const out = r.redact(normalize(k.text, "exec_output", V1_RULES)).text; const n = leaks(out, extra); if (n > 0) { missed += n; if (missedNames.length < 5) missedNames.push(k.name); } }
    fixtureResult[c.name] = { cases: fx.length, missed, missedNames };
  }
  // INV-29 式检查：输出里既没有秘密原值，也没有原值的未加盐 sha256。
  const r0 = createRedactor(secrets, TEST_KEY, {});
  const joined = fx.map(k => r0.redact(normalize(k.text, "exec_output", V1_RULES)).text).join("\n");
  const unsaltedHashHits = secrets.filter(s => joined.includes(sha256hex(s.value))).length;
  return { corpus: { bytes: bigBytes, secrets: secrets.length, planted }, throughput, fixture: fixtureResult, unsaltedHashHits, adversarial: adversarial(secrets) };
}

/** 精确匹配的已知边界（预期会漏，用来说明 v1 三种形式之外还缺什么；不计入“应为 0”）。 */
function adversarial(secrets: readonly KnownSecret[]): Record<string, unknown> {
  const pw = secrets.find(s => s.name === "DB_PASSWORD")!.value, tok = secrets[0]!.value;
  const mid = (s: string): number => Math.floor(s.length / 2);
  const cases: { name: string; text: string; secret: string; pipeline?: "v1-order" | "truncate-first" }[] = [
    { name: "lowercase-percent-encoding", text: "q=" + encodeURIComponent(pw).replace(/%[0-9A-F]{2}/g, m => m.toLowerCase()), secret: pw },
    { name: "form-encoding (+ for space)", text: "q=" + new URLSearchParams({ q: pw }).toString().slice(2), secret: pw },
    { name: "json-escaped-slash (\\/)", text: JSON.stringify({ k: pw }).replace(/\//g, "\\/"), secret: pw },
    { name: "json-unicode-escape (\\u00e9)", text: JSON.stringify(pw).replace(/[\u0080-\uFFFF]/g, c => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")), secret: pw },
    { name: "double-url-encoding", text: encodeURIComponent(encodeURIComponent(pw)), secret: pw },
    { name: "base64", text: Buffer.from(tok).toString("base64"), secret: tok },
    { name: "html-entities", text: pw.replace(/"/g, "&quot;").replace(/&(?!quot;)/g, "&amp;"), secret: pw },
    { name: "split-by-zero-width (U+200B)", text: tok.slice(0, mid(tok)) + "\u200B" + tok.slice(mid(tok)), secret: tok },
    { name: "split-by-NUL, v1 order (redact before C0 removal)", text: tok.slice(0, mid(tok)) + "\u0000" + tok.slice(mid(tok)), secret: tok, pipeline: "v1-order" },
    { name: "split-by-NUL, prototype order (C0 removal first)", text: tok.slice(0, mid(tok)) + "\u0000" + tok.slice(mid(tok)), secret: tok },
    { name: "tail truncation before redaction (cut inside the secret)", text: "x".repeat(50) + tok, secret: tok, pipeline: "truncate-first" },
  ];
  const variants: Record<string, RedactOptions> = { "v1-forms/raw": { view: "raw", shapes: false }, "v1-forms/skeleton": { view: "skeleton", shapes: false }, "extended-forms/skeleton": { view: "skeleton", shapes: false, forms: "extended" }, "v1-forms/skeleton+shapes": { view: "skeleton", shapes: true } };
  const out: Record<string, Record<string, string>> = {};
  for (const c of cases) {
    out[c.name] = {};
    for (const [vn, opts] of Object.entries(variants)) {
      const r = createRedactor(secrets, TEST_KEY, opts);
      let result: string;
      if (c.pipeline === "v1-order") result = normalize(r.redact(c.text).text, "exec_output", V1_RULES);
      else if (c.pipeline === "truncate-first") result = r.redact(tailChars(c.text, 40)).text;
      else result = r.redact(normalize(c.text, "exec_output", V1_RULES)).text;
      // 判定：输出里有原值 → 原值泄漏；没有任何替换标签 → 以编码、切开或片段的形式原样流出；否则已脱敏。
      out[c.name]![vn] = result.includes(c.secret) ? "leak:raw" : !result.includes("〔已脱敏") ? "leak:passed-through" : "redacted";
    }
  }
  return out;
}

if (import.meta.main) console.log(JSON.stringify(run(), null, 2));
