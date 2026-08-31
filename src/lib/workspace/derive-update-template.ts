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
  "1. STRUCTURE is copied verbatim; CONTENT is described, never copied.",
  "   Structure is what is the same in every update: heading text, heading levels, section order, a sign-off.",
  "   Copy those word for word — 'Fixes', \u2018What\u2019s new\u2019, \u2018\u2014 The Acme Team\u2019.",
  "   Content is whatever a particular update happened to be about. Never carry a word of it across. If you",
  "   are writing a phrase that describes something the company shipped, you are copying content.",
  "2. The page reaches you as MARKDOWN, so its real heading levels are intact — reproduce a marked heading",
  "   at the level it came in at. But some companies style their section names without marking them up, so",
  "   a name can arrive as a bare line and still be a section. Decide by RECURRENCE, not by markup:",
  "     A SECTION recurs across entries under the SAME name, in the same place — \u2018Fixes\u2019 under entry after",
  "     entry. Emit it as a heading even if it arrived unmarked; that is what makes it structure.",
  "     A CATEGORY CHIP also recurs, but its VALUE CHANGES from a small fixed set — one entry says",
  "     \u2018Improvement\u2019, the next \u2018New feature\u2019, the next \u2018Fix\u2019. It is classifying the entry, not",
  "     naming a part of it. See rule 3.",
  "3. Ignore the page\u2019s interface. A changelog page carries chrome that is not part of an update: nav",
  "   and footer links, a subscribe prompt, and \u2014 most easily mistaken for content \u2014 a category chip",
  "   rendered beside each entry, a short label like \u2018Improvement\u2019, \u2018New feature\u2019 or \u2018Fix\u2019 repeated",
  "   once per entry. That chip is set from a field in their CMS, not typed by the person writing the",
  "   update, so a template that reserves a slot for it makes every future update open with the bare word",
  "   \u2018Improvement\u2019 on a line of its own. Leave it out.",
  "   Tell a chip from a section by whether the WORDS change: a section is the same word every time, a chip",
  "   cycles through a small set. If you only see one entry and cannot tell, leave it out — a missing",
  "   section costs a writer nothing, a chip slot puts a stray word atop every future update.",
  "4. Where CONTENT goes, write a short description of what belongs there, in braces. It is a brief for",
  "   whoever writes the next update, not an example from the last one. Keep it to a few words.",
  "     Right:  {main feature, plus 1-2 smaller ones}   {one sentence on who this helps}   {the fixes, as bullets}",
  "     Wrong:  {count} Improvements and fixes across the platform",
  "   That wrong example is the failure to understand: \u2018Improvements and fixes across the platform\u2019 is one",
  "   update\u2019s own words, and a template carrying it would stamp that same sentence onto every future update.",
  "   A brace may hold a description OR a reserved name below — never a description wrapped around real copy.",
  `5. These brace names are RESERVED and are filled in automatically: ${ALLOWED_TOKENS}.`,
  "   Use one only where the page shows that literal kind of value in that position, and only for its own",
  "   meaning. The count names are the NUMBER OF CHANGES in an update; {month} and {year} are the period it",
  "   covers. Never reach for one because it is the closest available — writing {count} where a day of the",
  "   month goes puts the number of changes into a date, and ships an update carrying a wrong one.",
  "   There is no day-of-month name. If their titles carry a specific day, that part has no reusable shape:",
  "   use {month} {year}, or leave it to a description.",
  "",
  "THE TITLE LINE.",
  "The first line may be a heading giving the shape their update TITLES take. Describe that shape — do not",
  "reproduce any real title. When you emit it, it must be a single \u2018#\u2019, whatever level the page uses for",
  "entry titles: this line is the title of one update, not a section inside it.",
  "     Right:  \u2018# {main feature, plus 1-2 smaller ones} {month}\u2019   or   \u2018# {month} updates\u2019",
  "     Wrong:  \u2018# Coding sessions: environments, browser use, and updated pricing\u2019 — that is one real title.",
  "If their titles follow no shape at all, omit the line.",
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
 * The only deterministic guard left: a skeleton with nothing under its title is
 * not a template.
 *
 * It USED to strip every brace that was not one of the nine reserved names,
 * because the model kept inventing `{Feature name}`-style tokens and those
 * reached the finished update as literal text. That stripping is gone, and
 * deliberately: a described content slot is now the POINT of a template, not a
 * defect in one. `{main feature, plus 1-2 smaller ones}` is what a template is
 * supposed to say. What changed underneath it is the composer, which now reads
 * an unreserved brace as a brief for what to write there rather than as text to
 * reproduce — see `composeReleasePrompt`.
 *
 * The degenerate check stays. Composition falls back to the pre-template prompt
 * when the body is empty, so persisting a body-less skeleton would only make the
 * settings UI claim a template that does nothing.
 */
export function postProcessTemplate(raw: string): string | null {
  const lines = raw.split("\n").map((line) => line.trimEnd());
  const firstMeaningful = lines.findIndex((line) => line.trim() !== "");
  const body = lines.slice(firstMeaningful + 1).filter((line) => line.trim() !== "");
  if (firstMeaningful === -1 || body.length === 0) return null;

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
