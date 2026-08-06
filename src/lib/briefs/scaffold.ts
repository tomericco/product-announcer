/**
 * The starting body for an accepted brief.
 *
 * Deterministic and model-free on purpose: real drafting is spec 5c, and
 * `contentPieces.body` is NOT NULL so something has to be written. Key points
 * become headings because they ARE the outline — the schema deliberately has no
 * separate `outline` column.
 */
export function scaffoldBody(brief: { angle: string; whyNow: string; keyPoints: string[] }): string {
  return [brief.angle, "", `Why now: ${brief.whyNow}`, "", ...brief.keyPoints.map((p) => `## ${p}`)]
    .join("\n")
    .trim();
}
