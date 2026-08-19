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

export function sizeForRole(role: "cover" | "body" | "library"): "1200x630" | "1200x900" {
  return role === "cover" ? "1200x630" : "1200x900";
}

/**
 * How far off the cover's 1.91:1 shape (1200×630) a render may be before
 * "From library" excludes it from the cover slot (spec §5b open question,
 * resolved as option (a): the cover picker never offers a body-shaped
 * render, since reuse pastes the existing blob with no new render — a
 * mismatched shape would ship distorted/cropped into LinkedIn and OG, which
 * product owner decision 1 forbids doing ourselves).
 *
 * Reuses `ASPECT_TOLERANCE` (`src/lib/ai/images.ts`) — the render guard's own
 * tolerance — rather than a second, independently-maintained number, so this
 * filter and the generation guard can never drift apart.
 */
const COVER_ASPECT = 1200 / 630;

export function isCoverShaped(width: number, height: number): boolean {
  return Math.abs(width / height - COVER_ASPECT) / COVER_ASPECT <= ASPECT_TOLERANCE;
}
