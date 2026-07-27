import { Marked, type Tokens } from "marked";

// Read-only Markdown → HTML for display, distinct from markdownToWebflowHtml
// (which downgrades code/tables for Webflow). Renders full Markdown but, like
// that renderer, drops raw HTML; additionally it blanks any link href that
// isn't http(s)/mailto/relative/anchor, so the output is safe for
// dangerouslySetInnerHTML without adding a sanitizer dependency.
const SAFE_HREF = /^(https?:\/\/|mailto:|\/|#)/i;

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function buildRenderer() {
  const marked = new Marked({ gfm: true, breaks: false });
  marked.use({
    renderer: {
      // Drop raw HTML blocks/inline (e.g. <script>, <img onerror>). Same stance
      // as markdown-to-html.ts.
      html() {
        return "";
      },
      // marked v18 does not sanitize hrefs; blank anything that isn't a safe
      // scheme (blocks javascript:/data:), preserving the visible link text.
      link(token: Tokens.Link) {
        const href = SAFE_HREF.test(token.href ?? "") ? escapeAttr(token.href) : "";
        const title = token.title ? ` title="${escapeAttr(token.title)}"` : "";
        const text = this.parser.parseInline(token.tokens);
        return `<a href="${href}"${title} target="_blank" rel="noopener noreferrer">${text}</a>`;
      },
    },
  });
  return marked;
}

export function renderMarkdown(markdown: string): string {
  if (!markdown.trim()) return "";
  return (buildRenderer().parse(markdown, { async: false }) as string).trim();
}
