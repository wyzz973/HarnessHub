import { isValidElement, lazy, memo, Suspense } from "react";
import type { ReactNode } from "react";
import { CodeBlock } from "./CodeBlock.js";

const MarkdownRenderer = lazy(async () => {
  const [{ default: Markdown }, { default: remarkGfm }, { default: remend }] = await Promise.all([
    import("react-markdown"), import("remark-gfm"), import("remend"),
  ]);
  return {
    default: ({ text, isStreaming }: { text: string; isStreaming: boolean }) => <Markdown skipHtml remarkPlugins={[remarkGfm]}
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
          return <CodeBlock code={String(props.children ?? "").replace(/\n$/u, "")} language={language} streaming={isStreaming}/>;
        },
      }}>{isStreaming ? remend(text) : text}</Markdown>,
  };
});

/** Renders committed text; incomplete syntax repair is display-only while the Run is active. */
export const StreamingMarkdown = memo(function StreamingMarkdown({ text, isStreaming, className }: { text: string; isStreaming: boolean; className?: string }) {
  return <div className={"markdown" + (isStreaming ? " is-streaming" : "") + (className ? " " + className : "")}><Suspense fallback={<p className="whitespace-pre-wrap">{text}</p>}><MarkdownRenderer text={text} isStreaming={isStreaming}/></Suspense></div>;
});
