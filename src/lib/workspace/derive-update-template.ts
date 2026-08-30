import { generateObject } from "ai";
import { z } from "zod";
import { resolveModel, modelId } from "@/lib/ai/model";
import { recordLlmUsage } from "@/lib/ai/llm-usage";
import { TEMPLATE_VARIABLES } from "@/lib/workspace/product-update-template";

export const DerivedTemplateSchema = z.object({ template: z.string().nullable() });

const TEMPLATE_SYSTEM = [
  "You analyze a company's product updates / changelog page and extract the STRUCTURE their updates follow,",
  "as a reusable markdown skeleton.",
  "Emit the skeleton itself, not a description of it. Reproduce their heading levels, section order, and any",
  "sign-off VERBATIM, and leave every section empty — the content of a future update is written elsewhere and",
  "your job is only the shape it will be poured into.",
  "The first line must be a level-1 heading giving the pattern their update TITLES follow. If their titles have",
  "no consistent pattern, omit the H1 entirely rather than inventing one.",
  `Where the page shows a count or a date, use one of these placeholders instead of a literal: ${TEMPLATE_VARIABLES.map((v) => `{${v}}`).join(", ")}.`,
  "{count_rounded} is for the '20+ updates' idiom; {month} and {year} are the period the update covers.",
  "Include no other placeholder and no instructional prose — a reader must be able to fill this in by hand.",
  "Return null if the page shows no consistent structure. An invented template is worse than none.",
].join(" ");

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
