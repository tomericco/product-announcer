import { TEMPLATE_VARIABLES } from "@/lib/workspace/product-update-template";

export type ParsedTemplate = {
  /** The H1's text, without the leading `# `. Null when the template has none. */
  titlePattern: string | null;
  bodySkeleton: string;
};

/**
 * Splits a template into its title pattern and body skeleton.
 *
 * The title is the first heading, but ONLY when it sits structurally above
 * everything that follows — i.e. every other heading in the document is
 * deeper. That rule, rather than "the first line starts with a single #",
 * because the level a company uses for an update's title is theirs to choose:
 * a page whose entries are headed `## …` yields a template headed `## …`, and
 * insisting on `#` there silently produced templates with no title pattern at
 * all while the derivation looked like it had worked.
 *
 * The comparison is what keeps a section from being mistaken for a title. A
 * template opening `## Highlights` followed by `## Fixes` has no title: those
 * are peers, and promoting the first would drop a real section AND fabricate a
 * title pattern out of it. Same-level headings anywhere below mean the first
 * one is a section.
 *
 * A heading that is the document's only heading is a title, since there are no
 * peers to contradict it — that is the common shape for a company whose entries
 * are a headline over prose.
 */
export function parseTemplate(template: string): ParsedTemplate {
  const trimmed = template.trim();
  const lines = trimmed.split("\n");
  const firstIndex = lines.findIndex((line) => line.trim() !== "");
  if (firstIndex === -1) return { titlePattern: null, bodySkeleton: "" };

  const heading = /^(#{1,6})\s+(.+)$/.exec(lines[firstIndex].trim());
  if (!heading) return { titlePattern: null, bodySkeleton: trimmed };

  const level = heading[1].length;
  const hasPeerBelow = lines
    .slice(firstIndex + 1)
    .some((line) => {
      const other = /^(#{1,6})\s+/.exec(line.trim());
      return other !== null && other[1].length <= level;
    });
  if (hasPeerBelow) return { titlePattern: null, bodySkeleton: trimmed };

  return {
    titlePattern: heading[2].trim(),
    bodySkeleton: lines.slice(firstIndex + 1).join("\n").trim(),
  };
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
    // Day of the month, no padding — "August 3, 2026", the way a changelog
    // writes a date. Reserved rather than left to a description because a
    // company that dates its titles to the day would otherwise get a brace the
    // composer has to invent a number for, and a published update carrying a
    // wrong date is exactly the failure these reserved names exist to prevent.
    day: String(period.getUTCDate()),
    year: String(period.getUTCFullYear()),
  };

  let out = template;
  for (const name of TEMPLATE_VARIABLES) {
    out = out.split(`{${name}}`).join(values[name]);
  }
  return out;
}
