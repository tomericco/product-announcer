import { generateObject } from "ai";
import { z } from "zod";
import { resolveModel, modelId } from "@/lib/ai/model";
import { recordLlmUsage } from "@/lib/ai/llm-usage";
import { GUIDELINES_HEADINGS } from "@/lib/workspace/guidelines-template";

export const DerivedBrandProfileSchema = z.object({
  guidelines: z.string().nullable(),
  industry: z.string().nullable(),
});

export type DerivedBrandProfile = z.infer<typeof DerivedBrandProfileSchema>;

const EMPTY: DerivedBrandProfile = { guidelines: null, industry: null };

const ANALYSIS_SYSTEM = [
  "You analyze a company's product updates / changelog page to infer how they communicate product updates,",
  "then write their communication guidelines as a Markdown document a person on their team could edit.",
  `Use exactly these level-2 headings, in this order: ${GUIDELINES_HEADINGS.map((h) => `## ${h}`).join(", ")}.`,
  "Under each, write concrete, actionable guidance in their own terms — short paragraphs under the prose",
  "headings, bullet lists under Do and Don't. Cover voice and register, typical length and structure, how an",
  "update opens and closes, and signature vocabulary they actually use.",
  "Also determine whether updates end with a sign-off / signature and by whom (a person, a role, or a team, e.g.",
  "\"— The Acme Team\" or \"— Jane, Head of Product\"). If they do, add a \"## Sign-off\" section quoting it verbatim;",
  "if updates deliberately never sign off, add a bullet under Don't saying not to add a sign-off. Only assert a",
  "signature when there is clear evidence on the page.",
  "Infer only from evidence on the page. Omit a heading entirely rather than inventing guidance for it, and",
  "return null for guidelines if the page gives you nothing to go on.",
  "Separately, infer the company's industry, or null if you cannot.",
].join(" ");

export function buildAnalysisPrompt(pageText: string): string {
  return `Here is the text of a company's product updates / changelog page. Write their product-update communication guidelines.\n\n${pageText}`;
}

export async function analyzeBrandStyle(pageText: string, tenantId: string): Promise<DerivedBrandProfile> {
  try {
    const spec = process.env.ONBOARDING_ANALYSIS_MODEL ?? "anthropic/claude-sonnet-4-5";
    const { object, usage } = await generateObject({
      model: resolveModel(spec),
      schema: DerivedBrandProfileSchema,
      system: ANALYSIS_SYSTEM,
      prompt: buildAnalysisPrompt(pageText),
    });
    await recordLlmUsage({
      tenantId,
      operation: "brand_analysis",
      model: modelId(spec),
      usage,
    });
    return object;
  } catch {
    return EMPTY;
  }
}
