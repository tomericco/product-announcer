import { generateObject } from "ai";
import { z } from "zod";
import { resolveModel, modelId } from "@/lib/ai/model";
import { recordLlmUsage } from "@/lib/ai/llm-usage";

export const CompanyContextSchema = z.object({
  oneLiner: z.string().nullable(),
  category: z.string().nullable(),
  positioning: z.string().nullable(),
  topics: z.array(z.string()),
  competitors: z.array(z.object({ name: z.string(), websiteUrl: z.string().nullable() })),
});

export type DerivedCompanyContext = z.infer<typeof CompanyContextSchema>;

export const EMPTY_COMPANY_CONTEXT: DerivedCompanyContext = {
  oneLiner: null,
  category: null,
  positioning: null,
  topics: [],
  competitors: [],
};

const CONTEXT_SYSTEM = [
  "You read a company's own website and describe the company factually, for use as context by",
  "downstream agents that decide which industry news and competitor moves are relevant to them.",
  "oneLiner: one sentence on what the company does, in their own terms.",
  "category: the market category they compete in, as a short noun phrase.",
  "positioning: what they claim makes them different, and the messages they want to own. Two or three",
  "sentences. This is the yardstick every incoming signal is scored against, so be specific about what",
  "they emphasize rather than generic about their market.",
  "topics: 3-8 subjects in their lane, as short lowercase phrases a person would search for.",
  "competitors: companies they name as alternatives, or that a buyer would obviously compare them to.",
  "Include a website only when the page gives you one or you are certain of it.",
  "Infer only from evidence on the pages. Return null for any prose field the pages do not support, and",
  "an empty array rather than guessing at topics or competitors. Do not repeat marketing superlatives as",
  "fact — describe what they sell and to whom.",
].join(" ");

export function buildCompanyContextPrompt(pageText: string): string {
  return `Here is the text of a company's website. Describe the company.\n\n${pageText}`;
}

/**
 * Drafts a company profile from crawled site text. Returns an empty context
 * rather than throwing: a failed bootstrap must leave onboarding usable, and the
 * caller distinguishes "nothing inferred" from "call failed" by the emptiness.
 */
export async function analyzeCompanyContext(pageText: string, tenantId: string): Promise<DerivedCompanyContext> {
  try {
    const spec = process.env.ONBOARDING_ANALYSIS_MODEL ?? "anthropic/claude-sonnet-4-5";
    const { object, usage } = await generateObject({
      model: resolveModel(spec),
      schema: CompanyContextSchema,
      system: CONTEXT_SYSTEM,
      prompt: buildCompanyContextPrompt(pageText),
    });
    await recordLlmUsage({ tenantId, operation: "company_context_analysis", model: modelId(spec), usage });
    return object;
  } catch {
    return EMPTY_COMPANY_CONTEXT;
  }
}
