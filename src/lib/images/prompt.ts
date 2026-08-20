/**
 * One master per image (spec §7): the cover serves hero + og:image +
 * LinkedIn. Both dimensions of BOTH sizes must be exact multiples of 16 —
 * gpt-image-2 rejects any size that isn't with "Invalid size '…'. Width and
 * height must both be divisible by 16." (found in production, 2026-08-20;
 * the nominal 1200x630/1200x900 masters from spec §7 are NOT multiples of
 * 16). 1200 already is (75×16); each height is nudged down to the nearest
 * multiple of 16 — 630→624, 900→896 — rather than changing width, since 1200
 * is the "master width" the rest of the pipeline's comments assume. Both
 * nudges are under 1%, well inside `ASPECT_TOLERANCE` (2%, src/lib/ai/images.ts).
 */
export const IMAGE_SIZES = { cover: "1200x624", body: "1200x896" } as const;
export type ImageSize = (typeof IMAGE_SIZES)[keyof typeof IMAGE_SIZES];

/**
 * The same two shapes as `IMAGE_SIZES`, in `generateImage`'s `{w}:{h}` form —
 * the EXACT reduced ratio of each size (1200:624 → 25:13, 1200:896 → 75:56),
 * not the nominal 40:21/4:3 spec shapes, so this never disagrees with `size`
 * itself. `renderImage` sends BOTH `size` and `aspectRatio` (spec §7, product
 * owner decision 1: covers are generated wide natively and are never
 * cropped) — gpt-image-2 supports flexible sizes, and a provider that ignores
 * one of the two settings reports it in `result.warnings` rather than
 * throwing, so stating the shape twice costs nothing and buys the wide render
 * from providers that only understand ratios.
 */
export const IMAGE_ASPECT_RATIOS = {
  "1200x624": "25:13",
  "1200x896": "75:56",
} as const satisfies Record<ImageSize, `${number}:${number}`>;

export const NO_TEXT_CLAUSE = "No text, letters, words, logos or watermarks.";

/**
 * The house rule on WHAT an image may depict, and the reason both halves of
 * it live here rather than in any one caller: it has to hold for every image
 * this product renders, for every tenant, whichever path produced the
 * concept. Nothing about it is configurable — a tenant's visual identity
 * decides how images LOOK (palette, medium, mood); this decides how the
 * content is READ, which is not a matter of taste.
 *
 * Marketing copy is full of figures of speech — "upstream", "pipeline",
 * "velocity", "unlock", "bridge the gap", "north star". Rendered literally
 * they become an up arrow, a pipe, a speedometer, a padlock, a bridge: the
 * stock-clipart look that reads as machine-made, and worse, says nothing
 * about the product. The fix is to translate the passage into the business,
 * product or engineering situation it is actually about, and draw THAT.
 *
 * Two phrasings because there are two audiences. The agents choosing a
 * concept get {@link NON_LITERAL_DIRECTIVE}, which explains the translation
 * and is where the real work happens. The image model gets
 * {@link NON_LITERAL_CLAUSE} on every compiled prompt — a backstop for
 * concepts that never passed through an agent at all (a prompt someone
 * typed, or a highlighted passage quoted straight into the brief).
 */
export const NON_LITERAL_DIRECTIVE = [
  "NEVER illustrate the wording of the content literally. Read past the vocabulary to the",
  "business, product or engineering situation underneath, and depict that. Words like",
  '"upstream", "pipeline", "velocity", "unlock", "bridge" or "north star" are figures of speech,',
  "not subjects: an upward arrow, a pipe, a speedometer, a padlock, a bridge or a star is a",
  "restatement of the word, not an idea, and reads as generic clipart. Ask what concretely",
  "changes for a company, a team or a system, then choose an object or arrangement from the",
  "world of software, operations and enterprise work that stands for it.",
].join(" ");

/** The compiled-prompt backstop. Deliberately milder than
 * {@link NON_LITERAL_DIRECTIVE}: it also lands on prompts a person typed by
 * hand, where an explicitly named subject IS the idea and must survive. */
export const NON_LITERAL_CLAUSE =
  "Visualise the idea behind this brief in business, product and engineering terms — not a literal picture of the words describing it.";

const COMPOSITION = {
  // Platforms crop edges; keep the subject inside a center safe zone (spec §7).
  cover: "Wide hero composition, subject centered within a safe zone away from the edges, generous negative space.",
  body: "Single-concept illustration, one clear focal subject, uncluttered.",
} as const;

const ASPECT = {
  cover: "Aspect ratio 1.91:1 (1200x624).",
  body: "Aspect ratio 4:3 (1200x896).",
} as const;

/**
 * The fixed template every render uses (spec §4): concept metaphor →
 * non-literal clause → compiled style block → composition → aspect → no-text
 * clause. The result is what gets stored on the render row, so it must be a
 * plain single-line string.
 *
 * The non-literal clause sits directly after the concept, while the concept
 * is still what the model is reading, and before the style block turns the
 * prompt into a description of appearance.
 */
export function buildImagePrompt(a: {
  styleBlock: string;
  concept: string;
  role: "cover" | "body";
  allowText: boolean;
}): string {
  const parts = [a.concept.trim(), NON_LITERAL_CLAUSE, a.styleBlock.trim(), COMPOSITION[a.role], ASPECT[a.role]];
  if (!a.allowText) parts.push(NO_TEXT_CLAUSE);
  return parts
    .filter(Boolean)
    .join(" ")
    .replace(/\s*\n\s*/g, " ");
}
