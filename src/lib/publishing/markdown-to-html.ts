import { Marked, type Tokens } from "marked";

// Webflow's Rich Text field sanitizes incoming HTML down to the tags its editor
// supports. Anything else is silently dropped, so we emit only this set rather
// than letting content disappear without a trace:
//   h1-h6, p, strong, em, u, s, a, ul, ol, li, blockquote, br, img
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildRenderer() {
  const marked = new Marked({ gfm: true, breaks: false });

  marked.use({
    renderer: {
      // Webflow renders <pre>/<code> as an empty string. Downgrade to a
      // paragraph with hard breaks so the content survives, approximately.
      code(this: unknown, token: Tokens.Code) {
        const lines = token.text.split("\n").map(escapeHtml).join("<br>");
        return `<p>${lines}</p>\n`;
      },
      codespan(this: unknown, token: Tokens.Codespan) {
        return escapeHtml(token.text);
      },
      // GFM strikethrough (~~text~~) renders as <del> by default. `del` is not
      // in Webflow's allowed tag set, but `s` is — swap it, preserving nested
      // inline formatting (e.g. ~~**bold**~~).
      del(token: Tokens.Del) {
        return `<s>${this.parser.parseInline(token.tokens)}</s>`;
      },
      // GFM tables render as <table>/<thead>/<tr>/<th>/<td>, none of which are
      // in Webflow's allowed set, and unlike code blocks there's no downgrade
      // path upstream. Flatten each row into a <p>, cells joined by " — ",
      // with header cells bolded, so no cell content is lost.
      table(token: Tokens.Table) {
        const renderRow = (cells: Tokens.TableCell[], header: boolean) =>
          cells
            .map((cell) => {
              const text = escapeHtml(cell.text);
              return header ? `<strong>${text}</strong>` : text;
            })
            .join(" — ");

        const lines = [
          renderRow(token.header, true),
          ...token.rows.map((row) => renderRow(row, false)),
        ];

        return lines.map((line) => `<p>${line}</p>\n`).join("");
      },
      // Raw HTML in the source would be stripped by Webflow anyway; drop it here
      // so what we send matches what gets stored.
      html() {
        return "";
      },
    },
  });

  return marked;
}

export function markdownToWebflowHtml(markdown: string): string {
  if (!markdown.trim()) return "";
  const html = buildRenderer().parse(markdown, { async: false }) as string;
  return html.trim();
}

export function containsCodeBlock(markdown: string): boolean {
  // Fenced (``` or ~~~) or indented-by-four code blocks. Inline `code` does not
  // count — Webflow keeps its text content, just not the styling.
  if (/^\s*(```|~~~)/m.test(markdown)) return true;
  return /^(?: {4}|\t)\S/m.test(markdown);
}
