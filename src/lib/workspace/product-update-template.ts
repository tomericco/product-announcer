/**
 * The product update template: a literal markdown skeleton of the company's own
 * changelog, derived from their updates page and hand-editable in Company
 * settings.
 *
 * Separate from `guidelines` because the two have different jobs. Guidelines are
 * voice — prose, read as advice. The template is structure — an artifact, read
 * as a form to fill. Folding the skeleton into the guidelines document would put
 * it back through the "model describes a format to a model" hop that this whole
 * change exists to remove.
 */

/**
 * Variables a template may contain. All are substituted IN CODE before the
 * prompt is built — the model never sees one and never produces a count or a
 * date itself. Models miscount, and a wrong number in a headline is a visible
 * factual error where a debatable choice of lead is not.
 */
export const TEMPLATE_VARIABLES = [
  "count",
  "count_new",
  "count_improvement",
  "count_fix",
  "count_announcement",
  "count_s",
  "count_rounded",
  "month",
  "year",
] as const;

export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number];

/**
 * Seeded into the editor when a workspace has no template yet, so people edit
 * rather than face a blank page. Deliberately not written to the database on
 * load — the column stays null until the user saves, which is what lets the
 * composer tell "never configured" (fall back to SIZE_GUIDANCE) apart from
 * "configured". Mirrors GUIDELINES_TEMPLATE exactly.
 */
export const DEFAULT_PRODUCT_UPDATE_TEMPLATE = `# What's new in {month}

## Highlights

## Improvements

## Fixes

`;
