"use client";

import { cn } from "@/lib/utils";
import { answerHtml, type AnswerAlias } from "./answer-markdown";

// Re-exported so the two call sites and their tests keep one import path for
// "the answer view and its vocabulary". The pure functions live next door in a
// module with no "use client", because a Server Component may render this
// component but may not CALL anything exported from a client module.
export { segmentAnswer, answerHtml } from "./answer-markdown";
export type { AnswerAlias, AnswerSegment } from "./answer-markdown";

/**
 * The engine's answer as the engine wrote it — markdown rendered, our brand in
 * the accent, tracked competitors outlined.
 *
 * `dangerouslySetInnerHTML`, and the reasons this is safe are load-bearing
 * rather than incidental. The HTML comes from `answerHtml`, which renders
 * through `lib/markdown/render.ts` — raw HTML in the answer is DROPPED, and
 * any href or src outside http(s)/mailto/relative/anchor is blanked — and
 * inserts its `<mark>`s at the text-token level, so a brand name can never
 * land inside a tag, an attribute, a code span or a fenced block. Nothing here
 * concatenates markup with answer text. That distinction is the whole safety
 * argument; see the note on `answerHtml` before changing how the two combine.
 *
 * `.mdx-content` carries the heading, list and code styling the editor already
 * uses (Tailwind's preflight flattens all of it otherwise); `.answer-content`
 * steps the scale down, because this is quoted evidence inside a card rather
 * than a document.
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
  return (
    <div
      className={cn("mdx-content answer-content text-sm", className)}
      dangerouslySetInnerHTML={{ __html: answerHtml(text, aliases) }}
    />
  );
}
