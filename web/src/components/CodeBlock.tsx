import { Check, Copy } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import type { HighlighterCore } from "shiki/core";

/** Grammars load one by one on first use; each is its own chunk. */
const GRAMMARS: Readonly<Record<string, () => Promise<{ default: unknown }>>> = {
  typescript: () => import("shiki/dist/langs/typescript.mjs"), tsx: () => import("shiki/dist/langs/tsx.mjs"), javascript: () => import("shiki/dist/langs/javascript.mjs"),
  jsx: () => import("shiki/dist/langs/jsx.mjs"), json: () => import("shiki/dist/langs/json.mjs"), shellscript: () => import("shiki/dist/langs/shellscript.mjs"),
  python: () => import("shiki/dist/langs/python.mjs"), go: () => import("shiki/dist/langs/go.mjs"), rust: () => import("shiki/dist/langs/rust.mjs"),
  java: () => import("shiki/dist/langs/java.mjs"), css: () => import("shiki/dist/langs/css.mjs"), html: () => import("shiki/dist/langs/html.mjs"),
  markdown: () => import("shiki/dist/langs/markdown.mjs"), yaml: () => import("shiki/dist/langs/yaml.mjs"), toml: () => import("shiki/dist/langs/toml.mjs"),
  diff: () => import("shiki/dist/langs/diff.mjs"), sql: () => import("shiki/dist/langs/sql.mjs"), c: () => import("shiki/dist/langs/c.mjs"),
  swift: () => import("shiki/dist/langs/swift.mjs"), kotlin: () => import("shiki/dist/langs/kotlin.mjs"),
};
const ALIASES: Readonly<Record<string, string>> = {
  ts: "typescript", mts: "typescript", cts: "typescript", js: "javascript", mjs: "javascript", cjs: "javascript", sh: "shellscript", bash: "shellscript", zsh: "shellscript",
  shell: "shellscript", console: "shellscript", py: "python", rs: "rust", yml: "yaml", md: "markdown", "c++": "c", cpp: "c", cc: "c", hpp: "c", h: "c", kt: "kotlin", patch: "diff", jsonc: "json", json5: "json",
};
let highlighter: Promise<HighlighterCore> | null = null;
const loaded = new Map<string, Promise<void>>();
/** One highlighter per page, with the JavaScript regex engine (no WebAssembly) and both themes as CSS variables. */
async function highlight(code: string, language: string): Promise<string | null> {
  const name = ALIASES[language] ?? language, grammar = GRAMMARS[name];
  if (!grammar) return null;
  highlighter ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, light, dark] = await Promise.all([
      import("shiki/core"), import("shiki/engine/javascript"), import("shiki/dist/themes/github-light-default.mjs"), import("shiki/dist/themes/github-dark-default.mjs")]);
    return createHighlighterCore({ themes: [light.default as never, dark.default as never], langs: [], engine: createJavaScriptRegexEngine() });
  })();
  const core = await highlighter;
  if (!loaded.has(name)) loaded.set(name, grammar().then(module => core.loadLanguage(module.default as never)));
  await loaded.get(name);
  return core.codeToHtml(code, { lang: name, themes: { light: "github-light-default", dark: "github-dark-default" }, defaultColor: false });
}

/**
 * A fenced code block: plain text first, highlighted once the reply stops streaming. Shiki escapes the code itself, so the
 * markup it returns contains no content from the reply outside text nodes.
 */
export const CodeBlock = memo(function CodeBlock({ code, language, streaming }: { readonly code: string; readonly language: string | undefined; readonly streaming: boolean }) {
  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    setHtml(null);
    if (streaming || !language || code.length > 200_000) return;
    let current = true;
    void highlight(code, language.toLowerCase()).then(value => { if (current) setHtml(value); }, () => {});
    return () => { current = false; };
  }, [code, language, streaming]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const copy = () => { void navigator.clipboard.writeText(code).then(() => { setCopied(true); if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => setCopied(false), 1600); }, () => {}); };
  return <div className="code-block">
    <div className="code-block-head"><span className="mono">{language ?? "text"}</span>
      <button type="button" className="icon-btn icon-btn-sm" aria-label={copied ? "已复制代码" : "复制代码"} onClick={copy}>{copied ? <Check size={13}/> : <Copy size={13}/>}</button></div>
    {html ? <div dangerouslySetInnerHTML={{ __html: html }}/> : <pre><code>{code}</code></pre>}
  </div>;
});
