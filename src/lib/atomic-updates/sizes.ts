/**
 * Size bands, most significant FIRST. This order is load-bearing twice: it is
 * the order the composer lists changes in, and it is what `SIZE_RUBRIC` (in
 * `src/lib/ai/prompt-rules.ts`) describes to the model. One array, so the two
 * can never disagree.
 *
 * `signal` marks whether the reconciler in `src/lib/signals/shipped-work.ts`
 * treats a change as worth surfacing to a competitor-facing signal: `xs` and
 * `xxs` are below that floor (see `SIZES_BELOW_SIGNAL_FLOOR`) but remain
 * visible everywhere else on the Company page — badge, select, filter.
 */
export const SIZE_BANDS = [
  {
    key: "xl",
    gloss: "a flagship or headline change — a major new capability or overhaul you would lead an announcement with",
    signal: true,
  },
  {
    key: "l",
    gloss: "a significant feature or major improvement worth calling out to many users",
    signal: true,
  },
  {
    key: "m",
    gloss: "a standard improvement or small feature noticeable to users of that area",
    signal: true,
  },
  {
    key: "s",
    gloss:
      "a minor fix, tweak, or polish that a user of that spot would notice and welcome — worth one line in a smaller-fixes list",
    signal: true,
  },
  {
    key: "xs",
    gloss:
      "a negligible user-facing change — a single copy or wording tweak, a pixel-level visual nudge, or a fix for an edge case almost nobody hits; not worth its own line",
    signal: false,
  },
  {
    key: "xxs",
    gloss: "nothing any user could notice — an internal refactor, dependency or tooling bump, test or CI change, logging, code comments, or a typo in code",
    signal: false,
  },
] as const;

export type SizeKey = (typeof SIZE_BANDS)[number]["key"];

/**
 * The same keys, in the same order, for callers that need a runtime array
 * rather than the full band objects — `z.enum` and the URL-param whitelist
 * being the two real ones. Derived from `SIZE_BANDS` rather than re-spelled,
 * so there is exactly one place (besides the pg enum literal in `schema.ts`,
 * which can't import from here — see that file's comment) the six keys are
 * written out.
 */
export const SIZE_KEYS = SIZE_BANDS.map((band) => band.key);

/**
 * Least significant first — the reverse of `SIZE_KEYS`. Select menus for size
 * read bottom-up (xxs, then up to xl) so the visual order matches
 * significance; kept here rather than reversed at each call site so there is
 * one place that does the reversing.
 */
export const ASCENDING_SIZE_KEYS = [...SIZE_KEYS].reverse();

/** Descending significance. The composer sorts its item list on this. */
export const SIZE_RANK: Record<SizeKey, number> = Object.fromEntries(
  SIZE_BANDS.map((band, index) => [band.key, SIZE_BANDS.length - index])
) as Record<SizeKey, number>;

/**
 * The bands below the signal floor — excluded by the shipped-work reconciler
 * (`src/lib/signals/shipped-work.ts`) when it decides what counts as a
 * signal-worthy change. Derived from each band's `signal` flag rather than
 * spelled out again, so a future band can't update one without the other.
 */
export const SIZES_BELOW_SIGNAL_FLOOR: SizeKey[] = SIZE_BANDS.filter((band) => !band.signal).map(
  (band) => band.key
);
