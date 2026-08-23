import { escapeMarkdownText, renderMarkdown } from "@/lib/markdown/render";

/**
 * Turning one engine answer into displayable HTML, brands marked.
 *
 * Deliberately NOT in `highlighted-answer.tsx`, and this file deliberately has
 * no `"use client"` directive: these are pure functions, and a function
 * exported from a client module is a client *reference* that a Server
 * Component cannot call (see `sparkline-points.ts`, and the boundary test that
 * pins it). The component beside it imports these; so may anything on the
 * server that needs the same HTML.
 */

export type AnswerAlias = { name: string; kind: "tenant" | "competitor"; label: string };
export type AnswerSegment = { text: string; kind: "plain" | "tenant" | "competitor"; label?: string };

const WORD_CHAR = /[A-Za-z0-9]/;

/**
 * Whether `index` sits inside a URL. Scans back to the nearest whitespace and
 * asks whether that token looks like a link.
 *
 * The alias table applies the same rule during extraction, and it matters
 * just as much here: "lokalise.com" in a citation is not the engine naming
 * Lokalise in its answer, and highlighting it would make a citation look
 * like a mention to anyone reading the raw text to check our arithmetic.
 */
function insideUrl(text: string, index: number): boolean {
  let start = index;
  while (start > 0 && !/\s/.test(text[start - 1])) start -= 1;
  let end = index;
  while (end < text.length && !/\s/.test(text[end])) end += 1;
  const token = text.slice(start, end);
  return token.includes("://") || token.startsWith("www.") || /^[\w.-]+\.(com|io|ai|org|net|co)\b/i.test(token);
}

/**
 * Splits an answer into plain and marked segments.
 *
 * Three rules, each of which is a bug when dropped:
 * - **Word boundaries.** "Versionality" is not a mention of Versional.
 * - **Longest match wins.** With both "Phrase" and "Phrase TMS" tracked, the
 *   answer names one product, and marking the shorter one leaves " TMS"
 *   dangling outside the highlight.
 * - **Never inside a URL.** See `insideUrl`.
 *
 * Matching is case-insensitive; the ANSWER's own casing is preserved in the
 * output, because the segment text is sliced from the answer rather than
 * taken from the alias.
 *
 * `indexOf`, never a constructed `RegExp`: a brand name is tenant-supplied
 * text, and "C++" or "Node.js" compiled into a pattern is either a syntax
 * error or a matcher for something else entirely.
 */
export function segmentAnswer(text: string, aliases: AnswerAlias[]): AnswerSegment[] {
  const lower = text.toLowerCase();

  type Match = { start: number; end: number; alias: AnswerAlias };
  const matches: Match[] = [];

  for (const alias of aliases) {
    const needle = alias.name.toLowerCase();
    if (!needle) continue;
    let from = 0;
    for (;;) {
      const start = lower.indexOf(needle, from);
      if (start === -1) break;
      const end = start + needle.length;
      from = start + 1;

      const before = start > 0 ? text[start - 1] : "";
      const after = end < text.length ? text[end] : "";
      if (before && WORD_CHAR.test(before)) continue;
      if (after && WORD_CHAR.test(after)) continue;
      if (insideUrl(text, start)) continue;

      matches.push({ start, end, alias });
    }
  }

  // Earliest first; on a tie the longest wins, and the tenant wins a tie of
  // equal length so an ambiguous name is never silently attributed to a
  // competitor.
  matches.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    const lengthDelta = b.end - b.start - (a.end - a.start);
    if (lengthDelta !== 0) return lengthDelta;
    if (a.alias.kind !== b.alias.kind) return a.alias.kind === "tenant" ? -1 : 1;
    return 0;
  });

  const segments: AnswerSegment[] = [];
  let cursor = 0;
  for (const match of matches) {
    // Overlaps the previous accepted match — dropped, not truncated.
    if (match.start < cursor) continue;
    // No empty plain segment between two adjacent marks.
    if (match.start > cursor) segments.push({ text: text.slice(cursor, match.start), kind: "plain" });
    segments.push({
      text: text.slice(match.start, match.end),
      kind: match.alias.kind,
      label: match.alias.label,
    });
    cursor = match.end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), kind: "plain" });
  return segments;
}

/** Us in the accent (state — the thing the page exists to show), competitors as a plain outline. */
const MARK_CLASS: Record<"tenant" | "competitor", string> = {
  tenant: "rounded-sm px-0.5 bg-brand-subtle text-brand-subtle-foreground",
  competitor: "rounded-sm px-0.5 border border-border bg-transparent text-foreground",
};

/** Attribute-value escaping for the one attribute here that carries tenant text. */
function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** The marked-up form of one run of prose. */
function markSegments(text: string, aliases: AnswerAlias[]): string {
  return segmentAnswer(text, aliases)
    .map((segment) => {
      const body = escapeMarkdownText(segment.text);
      if (segment.kind === "plain") return body;
      const title = escapeAttribute(`${segment.label ?? segment.text} (${segment.kind === "tenant" ? "you" : "competitor"})`);
      return `<mark title="${title}" class="${MARK_CLASS[segment.kind]}">${body}</mark>`;
    })
    .join("");
}

/**
 * One engine answer as HTML: markdown structure rendered, tracked brands
 * marked, everything else inert.
 *
 * Engine answers ARE markdown — a real one opens
 * `## 1. Dedicated UX content management` and lists `- **Ditto** — …` — and
 * the prompt detail page is the one place a marketer goes to understand why a
 * number moved. Printing `##` and `**` at them there is printing the source of
 * the document instead of the document.
 *
 * The two halves are combined at the TEXT-TOKEN level, which is the only safe
 * way to do it:
 *
 * - `renderMarkdown` owns the structure. It drops raw HTML (`<script>`,
 *   `<img onerror>`) and blanks any href or src that is not
 *   http(s)/mailto/relative/anchor, which is what makes its output safe for
 *   `dangerouslySetInnerHTML`.
 * - `segmentAnswer` owns the marks, and only ever sees plain prose runs.
 *   Rendering markdown and THEN string-replacing brand names across the result
 *   is the version of this that corrupts an href, marks a name inside a code
 *   span, and — because a mark is markup — hands an attacker a way back into
 *   the tag soup. `renderMarkdown`'s `renderText` seam never exposes markup,
 *   an attribute, a code span or a fenced block, so no alias can land inside
 *   one.
 *
 * Escaping belongs to this function because the seam returns HTML:
 * `escapeMarkdownText` is exactly what marked's default text renderer does,
 * so plain prose comes out byte-identical to `renderMarkdown` without marks.
 *
 * One known, accepted degradation: matching runs against the raw token text,
 * so a brand whose name contains a character that arrives as an HTML entity in
 * the source (`M&amp;S`) is not matched. That is a missed highlight, never a
 * wrong one, and the alias table has the same blind spot upstream.
 */
export function answerHtml(text: string, aliases: AnswerAlias[]): string {
  return renderMarkdown(text, { renderText: (raw) => markSegments(raw, aliases) });
}
