/**
 * Body images join the markdown as plain `![alt](url)` lines (spec §3), so
 * placing one is a text operation on the stored body. Both functions treat
 * ATX H2 lines (`## text`) as anchors and skip anything inside a fenced code
 * block — a "## " inside a code sample is not a section.
 *
 * Matching is by heading TEXT: trimmed, case-insensitive, whole-text (not a
 * prefix). Headings are the one thing the plan step and the retry action can
 * both name later — a line offset would rot the moment a human edits above it.
 */

const H2 = /^##(?!#)\s*(.*?)\s*$/;
const FENCE = /^\s*(```|~~~)/;

function normalize(heading: string): string {
  return heading.trim().toLowerCase();
}

/** Line index of the first H2 whose text matches `heading`, or -1. */
function findHeadingLine(lines: string[], heading: string): number {
  const wanted = normalize(heading);
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (FENCE.test(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = H2.exec(lines[i]);
    if (match && normalize(match[1]) === wanted) return i;
  }
  return -1;
}

export function listH2Headings(markdown: string): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const line of markdown.split("\n")) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = H2.exec(line);
    if (match) out.push(match[1].trim());
  }
  return out;
}

/**
 * Inserts `imageMarkdown` as its own paragraph directly after the FIRST H2
 * whose text matches `heading`. Returns the input unchanged when no heading
 * matches — the caller decides whether that is a failure (the retry action
 * reports it; the agent simply loses that image and keeps the draft).
 */
export function spliceImageAfterHeading(markdown: string, heading: string, imageMarkdown: string): string {
  const lines = markdown.split("\n");
  const at = findHeadingLine(lines, heading);
  if (at === -1) return markdown;
  // `\n\n![alt](url)\n` after the heading line: a blank line closes the
  // heading, the image is its own block, and the trailing newline plus the
  // body's own blank line keeps the following paragraph separate.
  lines.splice(at + 1, 0, "", imageMarkdown);
  return lines.join("\n");
}
