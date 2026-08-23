/**
 * The one percentage formatter on `/ai-visibility`.
 *
 * Every rate this surface renders arrives already in percentage points
 * (0..100), so this rounds and appends a sign — it does NOT multiply.
 * Multiplying again would print "6200%" and, worse, would look plausible on the
 * day someone changes the scale back.
 *
 * `null` is the display threshold, not a zero. Below the floor the metrics
 * layer returns null for every rate it cannot publish, and printing "0%" there
 * is indistinguishable from a real, terrible score — the single substitution
 * this whole feature is arranged against. One em dash, defined once, so the
 * call sites cannot disagree about what an unknown looks like: they used to be
 * a `Math.round` here, a `toFixed(0)` there, and a hand-rolled `—` in only some
 * of them.
 *
 * Deliberately without `"use client"`: the overview page is a Server Component
 * and the tables under it are client ones, and both sides call this.
 */
export function ratePct(value: number | null): string {
  return value === null ? "—" : `${Math.round(value)}%`;
}
