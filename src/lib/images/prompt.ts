/** One master per image (spec §7): the cover serves hero + og:image + LinkedIn. */
export const IMAGE_SIZES = { cover: "1200x630", body: "1200x900" } as const;
export type ImageSize = (typeof IMAGE_SIZES)[keyof typeof IMAGE_SIZES];

/**
 * The same two shapes as `IMAGE_SIZES`, in `generateImage`'s `{w}:{h}` form.
 * `renderImage` sends BOTH `size` and `aspectRatio` (spec §7, product owner
 * decision 1: covers are generated at 1200×630 natively and are never
 * cropped) — gpt-image-2 supports flexible sizes, and a provider that ignores
 * one of the two settings reports it in `result.warnings` rather than
 * throwing, so stating the shape twice costs nothing and buys the wide render
 * from providers that only understand ratios.
 */
export const IMAGE_ASPECT_RATIOS = {
  "1200x630": "40:21",
  "1200x900": "4:3",
} as const satisfies Record<ImageSize, `${number}:${number}`>;

export const NO_TEXT_CLAUSE = "No text, letters, words, logos or watermarks.";

const COMPOSITION = {
  // Platforms crop edges; keep the subject inside a center safe zone (spec §7).
  cover: "Wide hero composition, subject centered within a safe zone away from the edges, generous negative space.",
  body: "Single-concept illustration, one clear focal subject, uncluttered.",
} as const;

const ASPECT = {
  cover: "Aspect ratio 1.91:1 (1200x630).",
  body: "Aspect ratio 4:3 (1200x900).",
} as const;

/**
 * The fixed template every render uses (spec §4): concept metaphor → compiled
 * style block → composition → aspect → no-text clause. The result is what gets
 * stored on the render row, so it must be a plain single-line string.
 */
export function buildImagePrompt(a: {
  styleBlock: string;
  concept: string;
  role: "cover" | "body";
  allowText: boolean;
}): string {
  const parts = [a.concept.trim(), a.styleBlock.trim(), COMPOSITION[a.role], ASPECT[a.role]];
  if (!a.allowText) parts.push(NO_TEXT_CLAUSE);
  return parts
    .filter(Boolean)
    .join(" ")
    .replace(/\s*\n\s*/g, " ");
}
