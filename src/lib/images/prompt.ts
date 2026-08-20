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
