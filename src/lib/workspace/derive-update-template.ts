import { generateObject } from "ai";
import { z } from "zod";
import { resolveModel, modelId } from "@/lib/ai/model";
import { recordLlmUsage } from "@/lib/ai/llm-usage";
import { TEMPLATE_VARIABLES } from "@/lib/workspace/product-update-template";

export const DerivedTemplateSchema = z.object({ template: z.string().nullable() });

const ALLOWED_TOKENS = TEMPLATE_VARIABLES.map((v) => `{${v}}`).join(", ");

/**
 * Every rule here is a failure measured against real changelog pages on
 * 2026-08-31 (Linear, Resend), not a guess. In order:
 *
 *  1. The model invented its own placeholder vocabulary — `{Feature name}`,
 *     `{Main announcement paragraph}`, `{Video player section if applicable}`.
 *     Those are fatal downstream: `substituteVariables` replaces only the nine
 *     known names and deliberately leaves any other `{token}` alone as author
 *     text, so they reach the composer inside a block it is told to reproduce
 *     exactly. Hence the closed-set rule, stated twice and with an example.
 *  2. It described ONE entry rather than the recurring shape — Linear's
 *     "## Keyboard shortcuts" is a section of a single update. The page is
 *     truncated to 12k characters, so it often sees only one or two entries,
 *     and has to be told to generalise and to say so when it cannot.
 *  3. It emitted `# {title}` and nothing else for Resend. That template is
 *     worse than none: it has no body, so composition falls back to the
 *     pre-template prompt anyway, while the UI reports a template configured.
 *     Null is the honest answer, and `postProcess` enforces it.
 *  4. Titles that are just feature names have no pattern to capture, and an H1
 *     of `# {title}` says nothing. Only emit one when the titles genuinely
 *     share a shape.
 */
const TEMPLATE_SYSTEM = [
  "You extract the reusable STRUCTURE of a company's product updates from their changelog page,",
  "and return it as a markdown skeleton.",
  "",
  "You are describing the shape MANY of their updates share, not transcribing one of them.",
  "Most changelogs that show the text of their updates DO have a recurring shape — a way they open, a couple",
  "of standing sections, sometimes a sign-off. Find it and return it. Producing a skeleton is the expected",
  "outcome, not a judgement call you have to earn.",
  "",
  "The page is often truncated, so you may see only one or two entries in full. That is enough: take the",
  "parts that plausibly recur — the headings, the ordering, the sign-off — and drop the parts that are",
  "obviously that one update's content. A section like 'Keyboard shortcuts' or 'Migration notes' that fits a",
  "single release is content, not structure. Dropping an uncertain SECTION is right; declining to produce a",
  "skeleton because some sections were uncertain is not.",
  "",
  "OUTPUT RULES.",
  "1. Emit the skeleton itself, never a description of it. Reproduce their heading text, section order, and",
  "   any sign-off verbatim.",
  "   Every section name must be written as a markdown heading ('## Fixes'), even when the page shows it as",
  "   bold, capitals, or plain text. You are reading extracted text with the original markup removed, so you",
  "   cannot see how a section name was styled — a section name emitted as a bare line reads as content",
  "   later, not as structure, which is the one thing this skeleton exists to carry.",
  "2. Your ENTIRE output consists of only three kinds of line: heading lines, text the company repeats",
  "   verbatim in every update (a sign-off like '— The Acme Team'), and blank lines. There are no body",
  "   lines. A section is its heading and nothing else — the words under it are written later by someone",
  "   holding the actual changes, who does not need your example of them.",
  "   If you find yourself writing a line that describes what belongs somewhere — a noun phrase in braces,",
  "   a parenthetical, a sample sentence — delete that line. It is not part of the skeleton.",
  `3. The ONLY placeholders you may write are: ${ALLOWED_TOKENS}. Never invent another one.`,
  "   Writing something like {Feature name} or {Main announcement paragraph} is the single worst thing you",
  "   can do here: those survive into the finished update as literal text. If you want to indicate what goes",
  "   in a section, do nothing — the empty section already says it.",
  "4. Each placeholder means one specific thing and may be used for nothing else. The count placeholders are",
  "   the NUMBER OF CHANGES in an update; {month} and {year} are the period it covers. Never reach for a",
  "   placeholder because it is the closest available — writing {count} where a day of the month goes puts",
  "   the number of changes into a date, and the result is a real update published with a wrong date on it.",
  "   There is no day-of-month placeholder. If their titles carry a specific day, that part of the title has",
  "   no reusable pattern: use {month} {year} alone, or omit the title line.",
  "5. Use a placeholder only where the page shows that literal kind of value in that literal position. If",
  "   their headings carry no counts or dates, use no placeholders at all.",
  "",
  "THE TITLE LINE.",
  "The first line may be a heading giving the pattern their update TITLES follow — but only when their",
  "titles genuinely share a shape, such as a month, a release number, or a fixed prefix. When you emit it,",
  "it must be a single '#', whatever heading level the page itself uses for entry titles — this line is the",
  "title of one update, not a section inside it.",
  "If their titles are simply the names of what shipped, they have no pattern: omit the H1 entirely.",
  "Never write an H1 that is a bare placeholder standing in for the whole title.",
  "",
  "WHEN TO RETURN NULL — two narrow cases, not a general escape hatch.",
  "First: the page does not show the BODY of any update. Some changelog pages are only an index — a list of",
  "release titles linking elsewhere. There is no structure to read off a list of links, and a skeleton",
  "invented from one would be fiction.",
  "Second: the only thing you could produce is a title line with no sections beneath it. That is not a",
  "template; it does nothing downstream.",
  "Outside those two cases, return a skeleton. If you can see updates and they have any shape at all, that",
  "shape is the answer.",
].join("\n");

/**
 * Deterministic backstop for the two rules the prompt can only ask for.
 *
 * Asking a model not to invent placeholders reduced them but did not eliminate
 * them (a probe run produced `{title}`, which is not one of the nine), and an
 * unknown token is invisible downstream by design — `substituteVariables`
 * passes it through as author text. So unknown tokens are stripped here, where
 * the rule can actually be enforced. Stripping rather than rejecting is
 * deliberate: the token is noise inside an otherwise usable skeleton, and
 * removing it leaves exactly the empty section the prompt asked for.
 *
 * Then the degenerate case: a skeleton with no body left is not a template.
 * Composition already falls back to the pre-template prompt when the body is
 * empty, so persisting one would only mean the settings UI claims a template
 * that does nothing. Null says the true thing.
 */
export function postProcessTemplate(raw: string): string | null {
  const allowed = new Set<string>(TEMPLATE_VARIABLES);
  // The trailing `[ \t]*,?` takes a separator that only existed to join this
  // token to its neighbour. Without it, a model writing `{month} {day}, {year}`
  // leaves `{month} , {year}` once `{day}` goes — punctuation the composer is
  // then told to reproduce exactly.
  const stripped = raw
    .replace(/\{([^}\n]*)\}[ \t]*,?/g, (match, name: string) =>
      allowed.has(name.trim()) ? match : ""
    )
    .replace(/[ \t]{2,}/g, " ");

  // Stripping a token out of a line usually leaves debris behind — an empty
  // heading (`## `), or separator punctuation that only made sense between the
  // tokens it joined (`## {month} , {year}` once `{day}` goes). A line that
  // carried a token and now carries no letters or digits is debris, so it goes
  // entirely rather than surviving as noise the composer is told to reproduce.
  const lines = stripped
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line, index) => {
      const before = raw.split("\n")[index] ?? "";
      if (before === line) return true;
      return /[a-z0-9]/i.test(line.replace(/^#+/, ""));
    });
  // Anything that is not the leading H1 and not blank: a heading, a sign-off,
  // a bullet. One such line is enough to make the skeleton worth keeping.
  const firstMeaningful = lines.findIndex((line) => line.trim() !== "");
  const body = lines.slice(firstMeaningful + 1).filter((line) => line.trim() !== "");
  if (firstMeaningful === -1 || body.length === 0) return null;

  // Collapse the runs of blank lines that stripping tends to leave behind.
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function buildTemplatePrompt(pageText: string): string {
  return `Here is the text of a company's product updates / changelog page. Extract the markdown skeleton their updates follow.\n\n${pageText}`;
}

export async function deriveUpdateTemplate(pageText: string, tenantId: string): Promise<string | null> {
  try {
    const spec = process.env.ONBOARDING_ANALYSIS_MODEL ?? "anthropic/claude-sonnet-4-5";
    const { object, usage } = await generateObject({
      model: resolveModel(spec),
      schema: DerivedTemplateSchema,
      system: TEMPLATE_SYSTEM,
      prompt: buildTemplatePrompt(pageText),
    });
    await recordLlmUsage({ tenantId, operation: "template_derivation", model: modelId(spec), usage });
    // A whitespace-only template folds to null at the source, same reasoning
    // as importBrandStyleForTenant's guidelines/industry normalization: a
    // blank string reads as "configured" to both the write guard below and
    // the editor's `?? DEFAULT` seeding. Checked without mutating the value —
    // unlike guidelines/industry, a template's whitespace (indentation, blank
    // lines between sections) is significant and must survive verbatim.
    const template = object.template;
    return template && template.trim() ? template : null;
  } catch {
    // Matches analyzeBrandStyle: a failed derivation is "no template", which
    // falls back to behaviour we already understand. Never throw — this runs
    // inside onboarding.
    return null;
  }
}
