import { isValidElement, lazy, memo, Suspense, useEffect, useLayoutEffect, useReducer, useState } from "react";
import type { ReactNode } from "react";
import { cn } from "../lib/cn.js";
import { rehypeReveal, reveal, type Chunk, type Reveal } from "../lib/turn.js";
import { useReducedMotion } from "../ui/motion.js";
import { CodeBlock } from "./CodeBlock.js";

const MarkdownRenderer = lazy(async () => {
  const [{ default: Markdown }, { default: remarkGfm }, { default: remend }] = await Promise.all([
    import("react-markdown"), import("remark-gfm"), import("remend"),
  ]);
  return {
    default: ({ text, repair, chunks }: { text: string; repair: boolean; chunks: readonly Chunk[] }) => <Markdown skipHtml remarkPlugins={[remarkGfm]} rehypePlugins={chunks.length ? [[rehypeReveal, { chunks }]] : []}
      components={{
        a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
        // Replies never load remote images: the alternative text stands in for one.
        img: ({ alt }) => <span className="image-alt">{alt ? `[图片：${alt}]` : "[图片]"}</span>,
        table: ({ children }) => <div className="table-scroll" tabIndex={0} role="region" aria-label="回复中的表格"><table>{children}</table></div>,
        pre: ({ children }) => {
          const child: ReactNode = Array.isArray(children) ? children[0] : children;
          if (!isValidElement(child)) return <pre>{children}</pre>;
          const props = child.props as { className?: string; children?: ReactNode };
          const language = /language-([\w+#.-]+)/u.exec(props.className ?? "")?.[1];
          return <CodeBlock code={String(props.children ?? "").replace(/\n$/u, "")} language={language} streaming={repair}/>;
        },
      }}>{repair ? remend(text) : text}</Markdown>,
  };
});

/**
 * Renders committed reply text as Markdown. While a Run streams, new text is released at a steady pace and each piece fades
 * in; incomplete syntax is repaired for display only. `caret` adds the 7 px dot at the end of the text while it is being
 * written, faded out in 200 ms once it is done (Motion board #11), and `onShown` hears each committed length once it is
 * shown in full, after the commit that shows it. With reduced motion, text is shown as it arrives.
 * `data-shown` and `data-committed` count the characters displayed and committed.
 */
export const StreamingMarkdown = memo(function StreamingMarkdown({ text, isStreaming, className, caret = false, onShown }: { text: string; isStreaming: boolean; className?: string; caret?: boolean; onShown?: (length: number) => void }) {
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
    const timer = setInterval(() => dispatch({ type: "tick" }), 50);
    return () => clearInterval(timer);
  }, [backlog]);
  // Once streaming ended and every piece has faded in (700 ms), the text renders without the spans.
  const settled = !isStreaming && !backlog && state.chunks.length > 0;
  useEffect(() => {
    if (!settled) return;
    const timer = setTimeout(() => dispatch({ type: "settle" }), 800);
    return () => clearTimeout(timer);
  }, [settled]);
  const behind = shown < text.length, writing = caret && (isStreaming || behind);
  useEffect(() => { if (!behind) onShown?.(text.length); }, [behind, text.length, onShown]);
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
    <Suspense fallback={<p className="whitespace-pre-wrap">{display}</p>}><MarkdownRenderer text={display} repair={repair} chunks={reduced ? [] : state.chunks}/></Suspense>
  </div>;
});
