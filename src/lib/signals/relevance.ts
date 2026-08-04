import { generateObject } from "ai";
import { z } from "zod";
import { resolveModel, modelId } from "@/lib/ai/model";
import { recordLlmUsage } from "@/lib/ai/llm-usage";

export type ScorableItem = { title: string; text: string; url: string | null };

export type ScoredItem = { score: number | null; rationale: string; topics: string[] };

/**
 * The subset of the company profile relevance scoring needs. Not the full
 * `companyProfiles` row — `name` comes from the tenant, not that table.
 */
export type RelevanceProfile = {
  name: string;
  oneLiner: string | null;
  positioning: string | null;
  topics: string[];
};

export const RelevanceSchema = z.object({
  scores: z.array(
    z.object({
      index: z.number().int(),
      score: z.number().min(0).max(1),
      rationale: z.string(),
      topics: z.array(z.string()),
    })
  ),
});

const UNSCORED_RATIONALE = "Relevance scoring failed for this item.";

/** Matches the shape of `generateObject` actually used here, so a test double can stand in for it. */
export type RelevanceGenerate = (args: {
  model: ReturnType<typeof resolveModel>;
  schema: typeof RelevanceSchema;
  system: string;
  prompt: string;
}) => Promise<{
  object: z.infer<typeof RelevanceSchema>;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}>;

export type RelevanceDeps = { generate?: RelevanceGenerate };

function buildRelevanceSystem(profile: RelevanceProfile): string {
  return [
    `You score how relevant each numbered item is to ${profile.name}'s competitive intelligence.`,
    profile.oneLiner ? `${profile.name} is: ${profile.oneLiner}` : null,
    profile.positioning ? `${profile.name}'s positioning: ${profile.positioning}` : null,
    profile.topics.length > 0 ? `Topics ${profile.name} cares about: ${profile.topics.join(", ")}.` : null,
    "Score each item from 0 (irrelevant — cosmetic, routine, or off-topic) to 1 (highly relevant — a",
    "direct competitive capability, positioning, or topic match).",
    "For each item, echo its exact index and give a one-sentence rationale and any topics it touches.",
    "Score every item you are given, and only the items you are given.",
  ]
    .filter(Boolean)
    .join(" ");
}

function buildRelevancePrompt(items: ScorableItem[]): string {
  const numbered = items
    .map((item, index) => `[${index}] ${item.title}\n${item.text}${item.url ? `\n${item.url}` : ""}`)
    .join("\n\n");
  return `Score the relevance of these items:\n\n${numbered}`;
}

/**
 * Scores a run's worth of new blocks against a company's positioning and
 * topics in a single batched LLM call.
 *
 * Results are matched back to `items` by the model-returned `index`, never by
 * array position — a model that returns scores out of order, omits one, or
 * invents one must not misattribute a score to the wrong item. The result is
 * built by starting from an all-unscored array and filling in only the
 * in-range indices the model actually returned, so an omitted index stays
 * unscored (not zero) and a phantom index is silently dropped.
 *
 * Fails open: a thrown error (bad response, network, rate limit) leaves every
 * item unscored rather than dropping any of them. A missed competitor move is
 * invisible; an unscored row in the signals browser (`listSignals`'s
 * null-score carve-out) announces itself instead.
 */
export async function scoreRelevance(
  items: ScorableItem[],
  profile: RelevanceProfile,
  tenantId: string,
  deps: RelevanceDeps = {}
): Promise<ScoredItem[]> {
  if (items.length === 0) return [];

  const generate = deps.generate ?? (generateObject as unknown as RelevanceGenerate);

  const unscored: ScoredItem[] = items.map(() => ({
    score: null,
    rationale: UNSCORED_RATIONALE,
    topics: [],
  }));

  try {
    const spec = process.env.RELEVANCE_MODEL ?? "anthropic/claude-haiku-4-5";
    const { object, usage } = await generate({
      model: resolveModel(spec),
      schema: RelevanceSchema,
      system: buildRelevanceSystem(profile),
      prompt: buildRelevancePrompt(items),
    });

    await recordLlmUsage({
      tenantId,
      operation: "signal_relevance",
      model: modelId(spec),
      usage,
    });

    const result = [...unscored];
    for (const entry of object.scores) {
      if (entry.index < 0 || entry.index >= items.length) continue;
      result[entry.index] = {
        score: entry.score,
        rationale: entry.rationale,
        topics: entry.topics,
      };
    }
    return result;
  } catch {
    // Fail open: never drop an item because the classifier errored.
    return unscored;
  }
}
