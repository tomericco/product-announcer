import { generateObject } from "ai";
import { z } from "zod";
import { resolveModel, modelId } from "@/lib/ai/model";
import { recordLlmUsage } from "@/lib/ai/llm-usage";

export const DerivedBrandProfileSchema = z.object({
  tone: z.string().nullable(),
  readingLevel: z.string().nullable(),
  doList: z.array(z.string()),
  dontList: z.array(z.string()),
  examplePhrases: z.array(z.string()),
  industry: z.string().nullable(),
  updatesStyleSummary: z.string().nullable(),
});

export type DerivedBrandProfile = z.infer<typeof DerivedBrandProfileSchema>;

const EMPTY: DerivedBrandProfile = {
  tone: null, readingLevel: null, doList: [], dontList: [], examplePhrases: [], industry: null, updatesStyleSummary: null,
};

const ANALYSIS_SYSTEM = [
  "You analyze a company's product updates / changelog page to infer their brand writing style.",
  "Derive: tone (a few adjectives), readingLevel (e.g. simple / general / technical), doList and dontList",
  "(concrete writing guidelines), examplePhrases (short signature phrases they actually use), industry,",
  "and updatesStyleSummary (a 1-3 sentence description of how they structure updates — length, sections, voice).",
  "Also determine whether updates end with a sign-off / signature and by whom (a person, a role, or a team, e.g.",
  "\"— The Acme Team\" or \"— Jane, Head of Product\"). If they do, add a doList guideline capturing it verbatim",
  "(e.g. \"Sign off each update with '— The Acme Team'\"); if updates deliberately never sign off, add a dontList",
  "guideline saying not to add a sign-off. Only assert a signature when there is clear evidence on the page.",
  "Infer only from evidence on the page. Leave a string field null and a list empty when you cannot infer it.",
].join(" ");

export function buildAnalysisPrompt(pageText: string): string {
  return `Here is the text of a company's product updates / changelog page. Infer their brand writing style.\n\n${pageText}`;
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
