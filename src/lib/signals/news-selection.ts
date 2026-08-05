import { generateObject } from "ai";
import { z } from "zod";
import { resolveModel, modelId } from "@/lib/ai/model";
import { recordLlmUsage } from "@/lib/ai/llm-usage";
import type { RelevanceProfile } from "@/lib/signals/relevance";

/**
 * The news agent's selection pass, which replaces the generic `scoreRelevance`
 * for `market_news` only.
 *
 * Relevance alone is the wrong question for news: a generic topic search
 * returns many articles that are all relevant and all worthless — routine
 * funding rounds, incremental version notes, rewrites of a story we already
 * hold. This pass asks the harder question instead, and answers it under a
 * hard cap.
 *
 * Returns a result object and never throws. The caller fails CLOSED on an
 * error: an article that was never judged cannot have passed the bar, and
 * writing it would defeat the cap this module exists to enforce.
 */

/** The hard ceiling on signals one run may write. Enforced in code, not only asked for in the prompt. */
export const MAX_SIGNALS_PER_RUN = 5;

export type NewsCandidate = { title: string; text: string; url: string };

export type NewsSelection = { index: number; score: number; rationale: string; topics: string[] };

export type SelectionResult = { selections: NewsSelection[] } | { error: string };

export const SelectionSchema = z.object({
  /**
   * Answered before the list, deliberately. The quiet-week spike found that a
   * model asked straight for items produces items; one asked first whether the
   * day merits anything will decline when it does not.
   */
  dayAssessment: z.string(),
  selections: z.array(
    z.object({
      index: z.number().int(),
      score: z.number().min(0).max(1),
      rationale: z.string(),
      topics: z.array(z.string()),
    })
  ),
});

/** Matches the shape of `generateObject` actually used here, so a test double can stand in. */
export type SelectionGenerate = (args: {
  model: ReturnType<typeof resolveModel>;
  schema: typeof SelectionSchema;
  system: string;
  prompt: string;
}) => Promise<{
  object: z.infer<typeof SelectionSchema>;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}>;

export type NewsSelectionDeps = { generate?: SelectionGenerate };

function buildSystem(profile: RelevanceProfile): string {
  return [
    `You are the news editor for ${profile.name}.`,
    profile.oneLiner ? `${profile.name} is: ${profile.oneLiner}` : null,
    profile.positioning ? `${profile.name}'s positioning: ${profile.positioning}` : null,
    profile.topics.length > 0 ? `Topics ${profile.name} cares about: ${profile.topics.join(", ")}.` : null,
    `Your job is to pick at most ${MAX_SIGNALS_PER_RUN} items from today's candidates that are genuinely`,
    "worth this company's attention. There is no target number.",
    "",
    "First assess the day in one sentence: is there anything here worth noting at all?",
    "",
    "THE BAR. Select an item only if you would defend it to this company's own audience.",
    "Two things must both be true: it brings a NEW topic or a NEW angle — not a restatement of",
    "something in the already-covered list below — and it is substantial enough that a reader",
    "would be glad they read it.",
    "",
    "Returning an empty list is a correct and common outcome. Most days are routine.",
    "Padding the list is the worst thing you can do: it teaches the reader to ignore the feed,",
    "and that is not recoverable. Two strong items beat five weak ones; zero beats one weak one.",
    "",
    "NEVER qualifying on their own: routine version bumps, incremental feature notes, maintenance",
    "and patch releases, generic market-size statistics and analyst forecasts, listicles and",
    "roundups, press releases with no substance, and any item whose only claim is that it exists",
    "rather than that something happened.",
    "",
    "Score each selection 0–1 on how strongly you would recommend it, echo its exact index, give a",
    "one-sentence rationale, and list the topics it touches. Only use indices you were given.",
  ]
    .filter(Boolean)
    .join(" ");
}

function buildPrompt(candidates: NewsCandidate[], recentTitles: string[]): string {
  const covered =
    recentTitles.length > 0
      ? `Already covered — do NOT select an item that repeats any of these:\n${recentTitles
          .map((t) => `- ${t}`)
          .join("\n")}\n\n`
      : "Nothing has been covered recently.\n\n";

  const numbered = candidates
    .map((c, index) => `[${index}] ${c.title}\n${c.url}\n${c.text}`)
    .join("\n\n");

  return `${covered}Today's candidates:\n\n${numbered}`;
}

export async function selectNewsSignals(
  candidates: NewsCandidate[],
  profile: RelevanceProfile,
  recentTitles: string[],
  tenantId: string,
  deps: NewsSelectionDeps = {}
): Promise<SelectionResult> {
  if (candidates.length === 0) return { selections: [] };

  const generate = deps.generate ?? (generateObject as unknown as SelectionGenerate);

  try {
    const spec = process.env.RELEVANCE_MODEL ?? "anthropic/claude-haiku-4-5";
    const { object, usage } = await generate({
      model: resolveModel(spec),
      schema: SelectionSchema,
      system: buildSystem(profile),
      prompt: buildPrompt(candidates, recentTitles),
    });

    await recordLlmUsage({ tenantId, operation: "news_selection", model: modelId(spec), usage });

    const seen = new Set<number>();
    const selections: NewsSelection[] = [];
    for (const entry of object.selections) {
      // Matched back by the echoed index, never by array position: a model that
      // reorders, omits, or invents must not misattribute a selection to the
      // wrong article.
      if (entry.index < 0 || entry.index >= candidates.length) continue;
      if (seen.has(entry.index)) continue;
      seen.add(entry.index);
      selections.push(entry);
      // Enforced here, not only asked for in the prompt — a model that ignores
      // the instruction must still not be able to exceed the cap.
      if (selections.length === MAX_SIGNALS_PER_RUN) break;
    }

    return { selections };
  } catch (error) {
    return { error: String(error) };
  }
}
