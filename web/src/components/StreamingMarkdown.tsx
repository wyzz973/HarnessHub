import { createContext, isValidElement, lazy, memo, Suspense, useContext, useEffect, useLayoutEffect, useReducer, useState } from "react";
import type { ReactNode } from "react";
import type { Components } from "react-markdown";
import { cn } from "../lib/cn.js";
import { rehypeReveal, reveal, type Chunk, type Reveal } from "../lib/turn.js";
import { useReducedMotion } from "../ui/motion.js";
import { CodeBlock } from "./CodeBlock.js";

/** Whether the text being drawn is still arriving: read by the code blocks, which are drawn by one component for every render. */
const Arriving = createContext(false);
function Pre({ children }: { readonly children?: ReactNode }) {
  const arriving = useContext(Arriving), child: ReactNode = Array.isArray(children) ? children[0] : children;
  if (!isValidElement(child)) return <pre>{children}</pre>;
  const props = child.props as { className?: string; children?: ReactNode };
  const language = /language-([\w+#.-]+)/u.exec(props.className ?? "")?.[1];
  return <CodeBlock code={String(props.children ?? "").replace(/\n$/u, "")} language={language} streaming={arriving}/>;
}
// One set for every render: a component made afresh each time is a new type to React, and every link, table and code block of a reply would be
// taken down and put up again at each release of streamed text (twenty times a second), fading in again and losing where it was scrolled.
const COMPONENTS: Components = {
  a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
  // Replies never load remote images: the alternative text stands in for one.
  img: ({ alt }) => <span className="image-alt">{alt ? `[图片：${alt}]` : "[图片]"}</span>,
  table: ({ children }) => <div className="table-scroll" tabIndex={0} role="region" aria-label="回复中的表格"><table>{children}</table></div>,
  pre: Pre,
};
const NO_CHUNKS: readonly Chunk[] = [];

const BAR_LINE = /^ {0,3}\|/u, DASHES = /^ {0,3}\|[ \t:|-]*$/u, FENCE = /^ {0,3}(`{3,}|~{3,})/u;
const columns = (line: string): string[] => line.trim().replace(/^\|/u, "").replace(/\|$/u, "").split("|");
/**
 * Arriving text without the first lines of a table that is not one yet: its header, and the row of dashes while that has fewer columns. Shown,
 * they would be a line of bars that jumps into a table a moment later; held back, the table comes in whole. Bars inside a code block are code.
 */
export function withoutOpeningTable(text: string): string {
  const end = text.endsWith("\n") ? text.length - 1 : text.length, last = text.lastIndexOf("\n", end - 1) + 1, line = text.slice(last, end);
  if (!BAR_LINE.test(line)) return text;
  const lineBefore = (at: number): { readonly from: number; readonly text: string } | null => { if (at === 0) return null; const from = text.lastIndexOf("\n", at - 2) + 1; return { from, text: text.slice(from, at - 1) }; };
  const previous = lineBefore(last);
  let from: number;
  if (previous === null || previous.text.trim() === "") from = last;
  else if (DASHES.test(line) && BAR_LINE.test(previous.text) && !DASHES.test(previous.text) && (lineBefore(previous.from)?.text.trim() ?? "") === ""
    && (columns(line).length < columns(previous.text).length || !columns(line).at(-1)!.includes("-"))) from = previous.from;
  else return text;
  let open = false;
  for (const each of text.slice(0, from).split("\n")) if (FENCE.test(each)) open = !open;
  return open ? text : text.slice(0, from);
}

// The renderer's modules are asked for as the page starts, not when the first reply is drawn: a conversation opened a moment later is
// drawn as Markdown at once, instead of showing its raw marks until the modules arrive.
const rendererModules = Promise.all([import("react-markdown"), import("remark-gfm"), import("remend")]);
const MarkdownRenderer = lazy(async () => {
  const [{ default: Markdown }, { default: remarkGfm }, { default: remend }] = await rendererModules;
  const remark = [remarkGfm];
  return {
    // Drawn again only when what it shows has changed, not when the dot at the end of the text comes or goes.
    default: memo(function Rendered({ text, repair, chunks }: { text: string; repair: boolean; chunks: readonly Chunk[] }) {
      return <Arriving.Provider value={repair}><Markdown skipHtml remarkPlugins={remark} rehypePlugins={chunks.length ? [[rehypeReveal, { chunks }]] : []} components={COMPONENTS}>{repair ? remend(withoutOpeningTable(text)) : text}</Markdown></Arriving.Provider>;
    }),
  };
});

/**
 * Renders committed reply text as Markdown. While a Run streams, new text is released at a steady pace and each piece fades
 * in; incomplete syntax is repaired for display only. `caret` adds the 7 px dot at the end of the text while it is being
 * written, faded out in 200 ms once it is done (Motion board #11), and `onShown` hears each committed length once it is
 * shown in full, after the commit that shows it (with `shownId`, which text that was). With reduced motion, text is shown as it arrives.
 * `data-shown` and `data-committed` count the characters displayed and committed.
 */
export const StreamingMarkdown = memo(function StreamingMarkdown({ text, isStreaming, className, caret = false, onShown, shownId }: { text: string; isStreaming: boolean; className?: string; caret?: boolean; onShown?: (length: number, id?: string) => void; shownId?: string }) {
  const reduced = useReducedMotion();
  const [state, dispatch] = useReducer(reveal, text, (initial): Reveal => ({ text: initial, shown: initial.length, rate: 0, chunks: [], at: performance.now() }));
  // A new commit is taken in before paint, so a replaced text is never shown cut at the old length.
  // Past 20,000 committed characters each release would parse the whole reply again 20 times a second: it shows at once.
  useLayoutEffect(() => { dispatch({ type: "arrive", text, at: performance.now(), animate: isStreaming && !reduced && text.length <= 20_000 }); }, [text, isStreaming, reduced]);
  // Reduced motion shows whatever has arrived, at once.
  useLayoutEffect(() => { if (reduced) dispatch({ type: "flush" }); }, [reduced]);
  const current = state.text === text, shown = current ? state.shown : text.startsWith(state.text) ? Math.min(state.shown, text.length) : text.length;
  const backlog = current && state.shown < state.text.length;
  useEffect(() => {
    if (!backlog) return;
    const timer = setInterval(() => dispatch({ type: "tick", closing: !isStreaming }), 50);
    return () => clearInterval(timer);
  }, [backlog, isStreaming]);
  // Once streaming ended and every piece has faded in (700 ms), the text renders without the spans.
  const settled = !isStreaming && !backlog && state.chunks.length > 0;
  useEffect(() => {
    if (!settled) return;
    const timer = setTimeout(() => dispatch({ type: "settle" }), 800);
    return () => clearTimeout(timer);
  }, [settled]);
  const behind = shown < text.length, writing = caret && (isStreaming || behind);
  useEffect(() => { if (!behind) onShown?.(text.length, shownId); }, [behind, text.length, onShown, shownId]);
  const [fading, setFading] = useState(false);
  const [wasWriting, setWasWriting] = useState(writing);
  if (wasWriting !== writing) { setWasWriting(writing); setFading(!writing); }
  useEffect(() => {
    if (!fading) return;
    const timer = setTimeout(() => setFading(false), 200);
    return () => clearTimeout(timer);
  }, [fading]);
  const display = shown < text.length ? text.slice(0, shown) : text, repair = isStreaming || shown < text.length;
  return <div className={cn("markdown", repair && "is-streaming", (writing || fading) && "caret-host", className)} {...(fading ? { "data-done": "" } : {})} data-shown={display.length} data-committed={text.length}>
    <Suspense fallback={<p className="whitespace-pre-wrap">{display}</p>}><MarkdownRenderer text={display} repair={repair} chunks={reduced ? NO_CHUNKS : state.chunks}/></Suspense>
  </div>;
});
