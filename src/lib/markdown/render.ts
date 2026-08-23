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

/**
 * marked's own text escaping, reproduced because overriding the `text`
 * renderer replaces it.
 *
 * The "no encode" variant: `&` is escaped only when it does not already start
 * an entity, so `&amp;` in the source survives as one ampersand rather than
 * becoming `&amp;amp;`. Matches marked's default `escape(text, false)`.
 */
export function escapeMarkdownText(text: string): string {
  return text.replace(/[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

/**
 * How to turn one plain-text run into HTML.
 *
 * Receives the RAW text of a markdown text token — never markup, never an
 * attribute value, never the inside of a code span or a fenced block, all of
 * which reach their own renderers. Returns HTML and therefore owns its own
 * escaping: `escapeMarkdownText` is what the default does.
 *
 * This is the seam that lets a caller decorate prose (the AI-visibility answer
 * view wraps tracked brand names in `<mark>`) without ever running a string
 * replace over rendered markup, which is how highlighting corrupts an href or
 * reintroduces the injection this renderer exists to prevent.
 */
export type RenderTextFn = (text: string) => string;

function buildRenderer(renderText?: RenderTextFn) {
  const marked = new Marked({ gfm: true, breaks: false });
  marked.use({
    renderer: {
      // Only reached when a caller asked for it; otherwise marked's default
      // text renderer stands, and this file behaves exactly as it did.
      ...(renderText
        ? {
            text(token: Tokens.Text | Tokens.Escape) {
              // An inline container (a loose list item, a table cell): recurse
              // rather than treating its raw text as a leaf, or the nested
              // emphasis and links inside it would be printed as source.
              if ("tokens" in token && token.tokens) return this.parser.parseInline(token.tokens);
              // Already HTML, produced by a tokenizer this file does not own.
              // Escaping it would print tags; decorating it would be the very
              // string-replace-over-markup this seam exists to avoid.
              if ("escaped" in token && token.escaped) return token.text;
              return renderText(token.text);
            },
          }
        : {}),
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

export function renderMarkdown(markdown: string, options?: { renderText?: RenderTextFn }): string {
  if (!markdown.trim()) return "";
  return (buildRenderer(options?.renderText).parse(markdown, { async: false }) as string).trim();
}
