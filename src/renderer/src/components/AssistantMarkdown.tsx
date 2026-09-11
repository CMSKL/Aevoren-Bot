import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

function isAllowedLink(href: string | undefined): boolean {
  if (!href) return false;
  try {
    const protocol = new URL(href).protocol;
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

const markdownComponents: Components = {
  a({ children, href, title }) {
    if (!isAllowedLink(href)) return <span className="markdown-unsafe-link">{children}</span>;
    return (
      <a href={href} title={title} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    );
  },
  table({ children }) {
    return (
      <div className="markdown-table-wrap">
        <table>{children}</table>
      </div>
    );
  },
  img({ alt }) {
    return <span className="markdown-image-alt">[图片：{alt || "未命名"}]</span>;
  },
};

export const AssistantMarkdown = memo(function AssistantMarkdown({ body }: { body: string }): React.JSX.Element {
  return (
    <div className="assistant-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents} skipHtml>
        {body}
      </ReactMarkdown>
    </div>
  );
});
