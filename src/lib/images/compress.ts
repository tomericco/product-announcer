import sharp from "sharp";

/**
 * The hard ceiling on EVERY PNG we store — generated renders and user uploads
 * alike (product owner, 2026-08-19). One ceiling on one code path is the only
 * way spec §8's "guaranteed by the compression pass" is true of uploads too:
 * `uploadImageFile` (Plan 3) accepts 10 MB of JPEG and pushes it through this
 * same function.
 */
export const MAX_IMAGE_BYTES = 1_000_000;

/**
 * What the destinations themselves allow: Webflow rehosts at most 4 MB
 * (spec §8) and LinkedIn's Images API at most 5 MB. Kept exported as the
 * external contract this module's own, much lower ceiling satisfies — nothing
 * enforces it separately, because nothing needs to.
 */
export const MAX_DELIVERABLE_BYTES = 4 * 1024 * 1024;

/**
 * Palette sizes tried in order before touching the width. Fewer colours is a
 * free win on flat marketing graphics and barely visible on photographs at
 * this scale.
 */
const PALETTE_STEPS = [256, 128, 64] as const;
/** Last resort, applied only after the palette steps: shrink and re-encode. */
const WIDTH_STEP_FACTOR = 0.85;
const MAX_WIDTH_STEPS = 4;
const MIN_WIDTH = 400;

async function encode(input: Buffer, width: number, colors: number) {
  const { data, info } = await sharp(input)
    // Width only — `withoutEnlargement` keeps a small source small, and the
    // height follows the source ratio. This is the no-crop guarantee: nothing
    // in this file may ever pass `height`, `fit`, `extend` or `extract`.
    .resize({ width, withoutEnlargement: true })
    .png({ palette: true, colors, compressionLevel: 9, effort: 7 })
    .toBuffer({ resolveWithObject: true });
  return { png: data, width: info.width, height: info.height };
}

/**
 * The mandatory pass before every Blob `put()` (spec §7). Models emit multi-MB
 * PNGs; a resize to the target width plus a palette-quantized PNG turns the
 * Hobby plan's ~300 storable images into thousands. PNG, never WebP: LinkedIn's
 * image API rejects WebP and flat graphics quantize well.
 *
 * Two invariants (product owner decisions 1 and 2):
 * - **The aspect ratio is never changed.** No crop, no extend, ever.
 * - **The result is ≤ MAX_IMAGE_BYTES**, or the smallest of a bounded set of
 *   attempts. It never throws for being too big: a slightly-over image beats a
 *   failed draft, and the one caller that could produce one (a photograph
 *   upload) still lands far under Webflow's 4 MB.
 */
export async function compressPng(input: Buffer, maxWidth: number): Promise<{ png: Buffer; width: number; height: number }> {
  // Throws for bytes sharp cannot read — the guard that stops a renamed
  // non-image upload from reaching Blob.
  const meta = await sharp(input).metadata();
  let width = Math.min(maxWidth, meta.width ?? maxWidth);

  let best = await encode(input, width, PALETTE_STEPS[0]);
  if (best.png.byteLength <= MAX_IMAGE_BYTES) return best;

  for (const colors of PALETTE_STEPS.slice(1)) {
    const candidate = await encode(input, width, colors);
    if (candidate.png.byteLength < best.png.byteLength) best = candidate;
    if (best.png.byteLength <= MAX_IMAGE_BYTES) return best;
  }

  for (let step = 0; step < MAX_WIDTH_STEPS; step++) {
    const next = Math.max(MIN_WIDTH, Math.round(width * WIDTH_STEP_FACTOR));
    if (next === width) break;
    width = next;
    const candidate = await encode(input, width, PALETTE_STEPS[PALETTE_STEPS.length - 1]);
    if (candidate.png.byteLength < best.png.byteLength) best = candidate;
    if (best.png.byteLength <= MAX_IMAGE_BYTES) return best;
  }

  console.warn(
    `[images/compress] could not get below ${MAX_IMAGE_BYTES} bytes after ${PALETTE_STEPS.length + MAX_WIDTH_STEPS} attempts; storing ${best.png.byteLength} bytes at ${best.width}x${best.height}`
  );
  return best;
}

/**
 * The real pixel dimensions of some bytes. Used by `renderImage`'s cover
 * aspect guard (Task 9) — it lives here so `sharp` is imported in exactly one
 * module. Throws on unparseable bytes; the guard treats that as "cannot
 * measure" and stores as-is.
 */
export async function imageDimensions(input: Buffer): Promise<{ width: number; height: number }> {
  const meta = await sharp(input).metadata();
  if (!meta.width || !meta.height) throw new Error("Image has no readable dimensions");
  return { width: meta.width, height: meta.height };
}
