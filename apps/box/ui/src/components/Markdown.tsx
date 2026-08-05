import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * THE render boundary for untrusted markdown: react-markdown
 * with no rehype-raw means raw HTML in a body renders as inert text, and every
 * other string on the page goes through React text nodes. Keep it that way —
 * never add dangerouslySetInnerHTML anywhere in this app.
 */
export function Markdown({ body }: { body: string | null }) {
  if (!body) return null;
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>
        {body}
      </ReactMarkdown>
    </div>
  );
}
