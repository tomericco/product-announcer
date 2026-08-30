import { TEMPLATE_VARIABLES } from "@/lib/workspace/product-update-template";

export type ParsedTemplate = {
  /** The H1's text, without the leading `# `. Null when the template has none. */
  titlePattern: string | null;
  bodySkeleton: string;
};

/**
 * Splits a template into its title pattern and body skeleton.
 *
 * Only a LEADING H1 counts — a template whose first content line is `## …`
 * leaves the title untemplated (generated as it was before this feature), which
 * is the degradation path for a derivation that only recovered body structure.
 * A later H1 is body content and must survive as-is, so this deliberately does
 * not scan the whole document for one.
 */
export function parseTemplate(template: string): ParsedTemplate {
  const trimmed = template.trim();
  const newline = trimmed.indexOf("\n");
  const firstLine = newline === -1 ? trimmed : trimmed.slice(0, newline);
  const h1 = /^#\s+(.+)$/.exec(firstLine);
  if (!h1) return { titlePattern: null, bodySkeleton: trimmed };
  const rest = newline === -1 ? "" : trimmed.slice(newline + 1);
  return { titlePattern: h1[1].trim(), bodySkeleton: rest.trim() };
}

export type TemplateFacts = {
  items: { category: string | null; size: string | null }[];
  /** The most recent real-world date across the items' evidence. */
  latestEvidenceAt: Date | null;
  /** Injectable for tests; the composition date otherwise. */
  now?: Date;
};

/**
 * Rounds down to the nearest ten for the "20+ updates" idiom: 23 and 29 both
 * give 20, which is what makes the `+` honest. Below ten it returns the exact
 * count — "0+ updates" is absurd, and a template using this form in a thin
 * month should read oddly rather than lie.
 */
export function roundDownToTen(count: number): number {
  return count < 10 ? count : Math.floor(count / 10) * 10;
}

/**
 * Replaces every recognised `{variable}` with its value.
 *
 * Substitution happens IN CODE, before the prompt is built, because a wrong
 * number in a headline is a visible factual error and models miscount. The
 * model never sees one of these placeholders.
 *
 * An unrecognised `{token}` is left untouched and treated as the template
 * author's own literal text. A template is a human-edited document and must
 * never fail to render because someone wrote a brace.
 */
export function substituteVariables(template: string, facts: TemplateFacts): string {
  const now = facts.now ?? new Date();
  const count = facts.items.length;
  const byCategory = (key: string) => facts.items.filter((i) => i.category === key).length;
  // The period is the work's, not the publication's: a changelog published on
  // 2 September covering August work says August.
  const period = facts.latestEvidenceAt ?? now;

  const values: Record<string, string> = {
    count: String(count),
    count_new: String(byCategory("new")),
    count_improvement: String(byCategory("improvement")),
    count_fix: String(byCategory("fix")),
    count_announcement: String(byCategory("announcement")),
    count_s: String(facts.items.filter((i) => i.size === "s").length),
    count_rounded: String(roundDownToTen(count)),
    month: period.toLocaleString("en-US", { month: "long", timeZone: "UTC" }),
    year: String(period.getUTCFullYear()),
  };

  let out = template;
  for (const name of TEMPLATE_VARIABLES) {
    out = out.split(`{${name}}`).join(values[name]);
  }
  return out;
}
