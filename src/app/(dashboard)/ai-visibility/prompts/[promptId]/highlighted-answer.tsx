"use client";

import { cn } from "@/lib/utils";

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

/**
 * The raw answer with brands marked: us in the accent (state — the thing the
 * page exists to show), competitors as a plain outline.
 *
 * Rendered as React children. The answer is text from a third-party API, and
 * building a string of `<mark>` tags for `dangerouslySetInnerHTML` would be
 * an injection with an extra step; React escapes every segment for free.
 */
export function HighlightedAnswer({
  text,
  aliases,
  className,
}: {
  text: string;
  aliases: AnswerAlias[];
  className?: string;
}) {
  const segments = segmentAnswer(text, aliases);

  return (
    <p className={cn("text-sm whitespace-pre-wrap", className)}>
      {segments.map((segment, index) =>
        segment.kind === "plain" ? (
          <span key={index}>{segment.text}</span>
        ) : (
          <mark
            key={index}
            title={`${segment.label} (${segment.kind === "tenant" ? "you" : "competitor"})`}
            className={cn(
              "rounded-sm px-0.5",
              segment.kind === "tenant"
                ? "bg-brand-subtle text-brand-subtle-foreground"
                : "border border-border bg-transparent text-foreground"
            )}
          >
            {segment.text}
          </mark>
        )
      )}
    </p>
  );
}
