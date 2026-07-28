/**
 * The versional mark glyph: a handwritten "v", traced from Caveat 700.
 *
 * Kept as a plain string, in its own module, because it has two consumers that
 * cannot share a component: <Mark /> in ./logo.tsx, and the static favicon at
 * src/app/icon.svg. Favicons render without webfonts, so the favicon cannot
 * simply set the glyph in Caveat -- it would fall back to a system face.
 *
 * The glyph is deliberately NOT centred on the tile -- it sits small and low
 * to the right, occupying roughly x 10.7-17.1, y 10.0-17.3. That is an
 * intentional design choice, not the side-bearing accident it may look like.
 * Do not "correct" it to centre.
 *
 * Fitted by rasterising the real Caveat glyph, measuring its ink box, and
 * solving a transform so this stroked path lands on the same box. The stroke
 * weight is set independently of that scale: a filled letterform keeps its
 * weight when shrunk, a stroked path does not, so scaling the stroke
 * proportionally left it under a pixel wide at favicon size.
 *
 * src/app/icon.svg must carry these exact values. A test enforces that --
 * see tests/components/brand/mark-path.test.ts.
 */
export const MARK_PATH =
  "M11.56 11.8C11.85 13.34 12.38 14.97 13.1 16.41C14.01 14.63 14.87 12.91 15.59 11.42C15.74 11.13 15.93 10.94 16.17 10.89";

/** Stroke width the glyph is drawn at, in tile units. */
export const MARK_STROKE_WIDTH = 1.8;

/**
 * Tile edge length, and therefore the viewBox. The glyph path is expressed in
 * absolute units, so shrinking this crops the tile tighter around the glyph
 * rather than scaling the glyph down.
 */
export const MARK_TILE_SIZE = 22;

/** Corner radius of the tile, in tile units. */
export const MARK_TILE_RADIUS = 5;

/** Tile fill. Hardcoded, not tokenised: it must not invert with colour mode. */
export const MARK_TILE_FILL = "#1B1A12";
