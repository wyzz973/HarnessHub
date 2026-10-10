import { lazy, memo, Suspense } from "react";

const MarkdownRenderer = lazy(async () => {
  const [{ default: Markdown }, { default: remarkGfm }, { default: remend }] = await Promise.all([
    import("react-markdown"), import("remark-gfm"), import("remend"),
  ]);
  return {
    default: ({ text, isStreaming }: { text: string; isStreaming: boolean }) => <Markdown skipHtml remarkPlugins={[remarkGfm]}
      components={{
        a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
        img: ({ alt }) => <span className="markdown-image-alt">{alt ? `[图片：${alt}]` : "[图片]"}</span>,
        table: ({ children }) => <div className="markdown-table-scroll" tabIndex={0} role="region" aria-label="回复中的表格"><table>{children}</table></div>,
      }}>{isStreaming ? remend(text) : text}</Markdown>,
  };
});

/** Renders committed text; incomplete syntax repair is display-only while the Run is active. */
export const StreamingMarkdown = memo(function StreamingMarkdown({ text, isStreaming }: { text: string; isStreaming: boolean }) {
  return <div className={`markdown ${isStreaming ? "is-streaming" : ""}`}><Suspense fallback={<p className="plain-response">{text}</p>}><MarkdownRenderer text={text} isStreaming={isStreaming}/></Suspense></div>;
});
