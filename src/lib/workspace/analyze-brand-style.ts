import { generateObject } from "ai";
import { z } from "zod";

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
  "Infer only from evidence on the page. Leave a string field null and a list empty when you cannot infer it.",
].join(" ");

export function buildAnalysisPrompt(pageText: string): string {
  return `Here is the text of a company's product updates / changelog page. Infer their brand writing style.\n\n${pageText}`;
}

export async function analyzeBrandStyle(pageText: string): Promise<DerivedBrandProfile> {
  try {
    const { object } = await generateObject({
      model: process.env.ONBOARDING_ANALYSIS_MODEL ?? "anthropic/claude-sonnet-4-5",
      schema: DerivedBrandProfileSchema,
      system: ANALYSIS_SYSTEM,
      prompt: buildAnalysisPrompt(pageText),
    });
    return object;
  } catch {
    return EMPTY;
  }
}
