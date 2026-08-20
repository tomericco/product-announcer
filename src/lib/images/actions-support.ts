import { slugForImage } from "@/lib/images/blob";
import { ASPECT_TOLERANCE } from "@/lib/ai/images";

/**
 * Pure helpers behind the image server actions. They live here rather than
 * in the `"use server"` files because those may export only async functions,
 * and these are what the node tests pin.
 */

/** The prompt stored on a render produced by "Describe a change": the
 * previous render's prompt, then the instruction as an `Edit:` line. */
export function editPromptHistory(previous: string, instruction: string): string {
  return `${previous.trimEnd()}\n\nEdit: ${instruction.trim()}`;
}

/**
 * What may be uploaded is defined ONCE, in Plan 1's `blob.ts`, because the
 * Visual identity card uploads through it too (product owner decision 3).
 * Re-exported here so the editor actions keep importing from one module.
 */
export { UPLOAD_MAX_BYTES, UPLOAD_MIME_TYPES, validateUploadFile } from "@/lib/images/blob";

/** Spec §2 alt policy: one sentence, ≤125 chars, meaning not style, no
 * "image of". Written from the concept we authored, never vision-captioned. */
export function altFromConcept(concept: string): string {
  const trimmed = concept.trim();
  if (!trimmed) return "";
  const firstSentence = trimmed.split(/(?<=[.!?])\s+/)[0] ?? trimmed;
  const withoutPrefix = firstSentence.replace(/^(an?\s+)?(image|illustration|picture|photo)\s+of\s+/i, "");
  const capitalised = withoutPrefix.charAt(0).toUpperCase() + withoutPrefix.slice(1);
  const noTrailingStop = capitalised.replace(/[.!?]+$/, "");
  return noTrailingStop.length > 125 ? noTrailingStop.slice(0, 125).trimEnd() : noTrailingStop;
}

/** How much of a highlighted passage is worth sending as the subject. Long
 * enough for a full paragraph or two, short enough that the concept doesn't
 * drown the style block that follows it in the compiled prompt. */
export const SELECTION_CONTEXT_LIMIT = 1200;

/** Markdown that carries no meaning once the text is a prose brief for an
 * image model — image embeds especially, whose blob URLs would otherwise be
 * read as part of the subject. */
function flattenForPrompt(markdown: string): string {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_`>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The subject an image generated FROM A SELECTION is rendered against.
 *
 * The highlighted passage is the brief and the post's title is the context
 * around it, so "generate an image from this" works with nothing typed at
 * all. Anything the user DID type is layered on top rather than replacing
 * that — it arrives last, as the direction that refines the passage.
 *
 * Returns "" only when there is genuinely nothing to depict; the caller
 * treats that as "describe what the image should show".
 */
export function selectionImageConcept(a: { title: string; selection: string; instruction?: string }): string {
  const passage = flattenForPrompt(a.selection).slice(0, SELECTION_CONTEXT_LIMIT).trim();
  const instruction = a.instruction?.trim() ?? "";
  if (!passage) return instruction;

  const title = a.title.trim();
  const context = title ? ` from the post "${title}"` : "";
  const brief = `An illustration of this passage${context}: "${passage}"`;
  return instruction ? `${brief}. Direction: ${instruction}` : brief;
}

/**
 * The short human label for an image generated from a selection with nothing
 * typed. It is what the row records as its concept — the alt text, the blob
 * slug and the library caption all come off it — so it has to be the
 * passage's opening words, never the whole quoted brief.
 */
export function selectionImageLabel(selection: string, maxChars = 80): string {
  const flat = flattenForPrompt(selection);
  if (flat.length <= maxChars) return flat;
  const clipped = flat.slice(0, maxChars);
  // Prefer a word boundary, but only when one is close enough to the end
  // that the label doesn't lose most of its content to the trim.
  const lastSpace = clipped.lastIndexOf(" ");
  return `${(lastSpace > maxChars * 0.6 ? clipped.slice(0, lastSpace) : clipped).trimEnd()}…`;
}

const HEADING_LINE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

/**
 * The markdown the "Suggest prompt" call reads: the section under
 * `heading` (through the next heading of the same or a higher level), or the
 * head of the document when there is no heading above the caret or it can't
 * be found. Capped at `maxChars` so a long section can't blow the prompt up.
 */
export function sliceAroundHeading(markdown: string, heading: string | null, maxChars = 1500): string {
  const lines = markdown.split("\n");
  const wanted = heading?.trim().toLowerCase() ?? "";
  let start = -1;
  let level = 0;
  if (wanted) {
    for (let i = 0; i < lines.length; i++) {
      const m = HEADING_LINE.exec(lines[i]);
      if (m && m[2].trim().toLowerCase() === wanted) {
        start = i;
        level = m[1].length;
        break;
      }
    }
  }
  if (start === -1) return markdown.slice(0, maxChars).trim();
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = HEADING_LINE.exec(lines[i]);
    if (m && m[1].length <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n").slice(0, maxChars).trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Removes every `![alt](url)` whose url is in `urls`. A line that becomes
 * empty is dropped together with one adjacent blank line, so deleting an
 * image doesn't leave a double blank; inline references just vanish.
 */
export function stripImageFromMarkdown(markdown: string, urls: string[]): string {
  if (urls.length === 0) return markdown;
  const alternation = urls.map(escapeRegExp).join("|");
  const inline = new RegExp(`!\\[[^\\]]*\\]\\((?:${alternation})(?:\\s+"[^"]*")?\\)`, "g");
  const lines = markdown.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inline.test(line)) {
      out.push(line);
      inline.lastIndex = 0;
      continue;
    }
    inline.lastIndex = 0;
    const stripped = line.replace(inline, "");
    if (stripped.trim().length > 0) {
      out.push(stripped);
      continue;
    }
    // Whole line was the image: drop it and the blank line that followed it
    // (if any) so the surrounding paragraphs keep a single blank between them.
    if (i + 1 < lines.length && lines[i + 1].trim() === "") i++;
  }
  return out.join("\n");
}

/**
 * Blob pathname slug. Delegates to Plan 1's `slugForImage` rather than
 * re-deriving one from `slugify`: `slugify` is the PUBLIC CMS slug (200 chars,
 * `"update"` fallback) and a second, subtly different image slug would put two
 * naming rules on one `imagePathname` argument. One function, one 40-char cap,
 * one `"image"` fallback — and one place where the path-traversal guarantee is
 * tested (tests/lib/images/blob.test.ts).
 */
export function imageSlug(text: string): string {
  return slugForImage(text);
}

export function sizeForRole(role: "cover" | "body" | "library"): "1200x624" | "1200x896" {
  return role === "cover" ? "1200x624" : "1200x896";
}

/**
 * How far off the cover's 1.91:1 shape (1200×624 — gpt-image-2 requires
 * multiples of 16, see prompt.ts's IMAGE_SIZES doc comment) a render may be
 * before "From library" excludes it from the cover slot (spec §5b open
 * question, resolved as option (a): the cover picker never offers a
 * body-shaped render, since reuse pastes the existing blob with no new
 * render — a mismatched shape would ship distorted/cropped into LinkedIn and
 * OG, which product owner decision 1 forbids doing ourselves).
 *
 * Reuses `ASPECT_TOLERANCE` (`src/lib/ai/images.ts`) — the render guard's own
 * tolerance — rather than a second, independently-maintained number, so this
 * filter and the generation guard can never drift apart.
 */
const COVER_ASPECT = 1200 / 624;

export function isCoverShaped(width: number, height: number): boolean {
  return Math.abs(width / height - COVER_ASPECT) / COVER_ASPECT <= ASPECT_TOLERANCE;
}
