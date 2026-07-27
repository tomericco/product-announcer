import { Marked, type Tokens } from "marked";

// Read-only Markdown → HTML for display, distinct from markdownToWebflowHtml
// (which downgrades code/tables for Webflow). Renders full Markdown but, like
// that renderer, drops raw HTML; additionally it blanks any link/image href
// that isn't http(s)/mailto/relative/anchor, so the output is safe for
// dangerouslySetInnerHTML without adding a sanitizer dependency. The relative
// alternative excludes a leading `//` (protocol-relative), which browsers
// resolve to an arbitrary off-site host — an open-redirect otherwise.
const SAFE_HREF = /^(https?:\/\/|mailto:|#|\/(?!\/))/i;

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
      // Images bypass the `link` override entirely — apply the same
      // SAFE_HREF allowlist to `src` (blanking javascript:/data:/protocol-
      // relative URLs) so an image can't be used to smuggle an unsafe URL.
      image(token: Tokens.Image) {
        const src = SAFE_HREF.test(token.href ?? "") ? escapeAttr(token.href) : "";
        const title = token.title ? ` title="${escapeAttr(token.title)}"` : "";
        const alt = escapeAttr(token.text ?? "");
        return `<img src="${src}" alt="${alt}"${title}>`;
      },
    },
  });
  return marked;
}

export function renderMarkdown(markdown: string): string {
  if (!markdown.trim()) return "";
  return (buildRenderer().parse(markdown, { async: false }) as string).trim();
}
