/**
 * USD rounding for AI-visibility money.
 *
 * `monthly_cap_usd` and `cost_usd` are `real` (float4) columns, chosen so
 * Drizzle keeps handing back JavaScript numbers — `numeric` would return
 * strings and that would ripple through the run pipeline, the metrics layer
 * and every chart.
 *
 * A float4 scalar read straight back out is not the problem: Postgres prints
 * it in its shortest round-tripping decimal form, so a cap written as 20.10
 * reads back as exactly 20.1. Arithmetic is. Summing three sample costs of
 * 0.012 in float4 yields 0.036000000312924385, and that is precisely what the
 * month-to-date spend and the `spend >= cap` gate are built out of — so the
 * cap page would show a spend with fifteen decimal places, and a tenant could
 * sit a fraction of a cent the wrong side of their cap.
 *
 * Every USD value that is displayed or compared must therefore pass through
 * `roundUsd`. This is the one place that rounding is defined, so a change to
 * it changes all of them at once.
 */

/** Rounds to cents. The only correct way to turn a float4 USD value into money. */
export function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}
