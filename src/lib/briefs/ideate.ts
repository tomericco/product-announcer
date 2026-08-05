import { generateObject } from "ai";
import { z } from "zod";
import { resolveModel, modelId } from "@/lib/ai/model";
import { recordLlmUsage } from "@/lib/ai/llm-usage";
import type { RelevanceProfile } from "@/lib/signals/relevance";

/**
 * The brief agent's one model call.
 *
 * Everything about its shape is a spike result, not a preference. Two spikes
 * are recorded in the design doc: the first established that an agent given a
 * company profile and real signals produces briefs a content lead would accept;
 * the second established that it will manufacture work on a quiet week unless
 * the prompt explicitly licenses silence. The second is the one that shaped
 * this file.
 *
 * Returns a result object and never throws. The caller writes nothing on an
 * error, because a run nobody judged has proposed nothing.
 */

/** Six uncapped briefs overflowed a 4096 default in the spike. */
export const MAX_IDEATION_OUTPUT_TOKENS = 8_000;

export type IdeationSignal = {
  id: string;
  kind: string;
  occurredAt: Date;
  title: string;
  excerpt: string | null;
};

export type OpenBrief = { id: string; title: string; angle: string };

export type IdeationContext = { covered: string[]; rejected: string[] };

export type ProposedBrief = {
  contentType: "product_update" | "blog_post" | "social_post";
  title: string;
  angle: string;
  whyNow: string;
  audience: string | null;
  keyPoints: string[];
  targetLength: number | null;
  suggestedChannel: string;
  evidenceSignalIds: string[];
  score: number;
  scoreRationale: string;
};

export type IdeationAction =
  | { type: "propose"; brief: ProposedBrief }
  | { type: "extend"; briefId: string; evidenceSignalIds: string[] };

export type IdeationResult = { assessment: string; actions: IdeationAction[] } | { error: string };

const ProposedBriefSchema = z.object({
  contentType: z.enum(["product_update", "blog_post", "social_post"]),
  title: z.string(),
  angle: z.string(),
  whyNow: z.string(),
  audience: z.string().nullish(),
  // 3-5, one sentence each. The spike measured 6.5 points averaging 27 words
  // when uncapped — something a writer skims rather than reads, and double the
  // output tokens of the highest-volume call in the system.
  keyPoints: z.array(z.string()).min(3).max(5),
  targetLength: z.number().int().nullish(),
  suggestedChannel: z.string(),
  evidenceSignalIds: z.array(z.string()),
  score: z.number(),
  scoreRationale: z.string(),
});

export const IdeationSchema = z.object({
  /**
   * Answered BEFORE the actions, deliberately. This ordering is the whole fix
   * from the quiet-week spike: asked straight for briefs the model returns
   * briefs, including on a week whose only material was a dependency bump and
   * a maintenance patch. Asked first whether the period merits anything, it
   * will say no. Do not move this below `actions`.
   */
  assessment: z.string(),
  actions: z.array(
    z.discriminatedUnion("type", [
      z.object({ type: z.literal("propose"), brief: ProposedBriefSchema }),
      z.object({
        type: z.literal("extend"),
        briefId: z.string(),
        evidenceSignalIds: z.array(z.string()),
      }),
    ])
  ),
});

export type IdeationGenerate = (args: {
  model: ReturnType<typeof resolveModel>;
  schema: typeof IdeationSchema;
  system: string;
  prompt: string;
  maxOutputTokens: number;
}) => Promise<{
  object: z.infer<typeof IdeationSchema>;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}>;

export type IdeateDeps = { generate?: IdeationGenerate };

function buildSystem(profile: RelevanceProfile): string {
  return [
    `You are the content strategist for ${profile.name}.`,
    profile.oneLiner ? `${profile.name} is: ${profile.oneLiner}` : null,
    profile.positioning ? `${profile.name}'s positioning: ${profile.positioning}` : null,
    profile.topics.length > 0 ? `Topics ${profile.name} cares about: ${profile.topics.join(", ")}.` : null,
    "",
    "Read everything that has happened recently and decide what — if anything —",
    "this company should publish.",
    "",
    "First, in one sentence, assess the period: is there anything here genuinely",
    "worth publishing about?",
    "",
    "Then propose whatever clears the bar. There is no target number.",
    "",
    "THE BAR. Propose a brief only if you would defend it in an editorial meeting",
    "to a skeptical head of marketing. If the honest answer to 'why are we",
    "publishing this?' is 'because it is Tuesday', it does not clear the bar.",
    "",
    "Most periods are quiet. Returning an empty list is a correct and common",
    "outcome, and it is the RIGHT answer when nothing of substance happened. A",
    "company that publishes nothing this week loses nothing. A company that",
    "publishes filler teaches its audience to ignore it, and that is not",
    "recoverable. Two strong briefs beat six padded ones; zero beats one padded.",
    "",
    "WHAT NEVER CLEARS THE BAR ALONE: routine version bumps, dependency updates,",
    "patch and maintenance releases, generic market-size statistics and analyst",
    "forecasts, a competitor's cosmetic or non-functional change, and anything",
    "whose why-now is 'this exists' rather than 'this happened'.",
    "",
    "FOR EACH BRIEF THAT DOES CLEAR IT:",
    "1. FAVOUR CLUSTERS. A brief joining two or more signals — especially across",
    "   different kinds, such as a competitor move beside something you shipped —",
    "   is almost always stronger than one restating a single changelog entry.",
    "2. THE SWAP TEST. If the brief would read exactly the same with a",
    "   competitor's name swapped in, it is worthless. Do not propose it.",
    "3. WHY-NOW MUST BE REAL. Point at something dated in the evidence. 'AI is a",
    "   big topic right now' is not a why-now.",
    "4. NO DUPLICATE ANGLES.",
    "5. MATCH TYPE TO SUBSTANCE. product_update for shipped work worth announcing,",
    "   blog_post for an argument needing room, social_post for one sharp point.",
    "6. KEY POINTS ARE A COMMISSION, NOT A DRAFT. Three to five, one sentence each.",
    "7. Only cite signal ids you were given.",
    "",
    "EXTENDING RATHER THAN REPEATING. You are shown the briefs already awaiting a",
    "decision. If new evidence supports one of those rather than justifying a",
    "separate piece, return an `extend` action naming its id instead of proposing",
    "a near-duplicate. An inbox that repeats itself within a week stops being read.",
  ]
    .filter((l) => l !== null)
    .join("\n");
}

function buildPrompt(
  signals: IdeationSignal[],
  openBriefs: OpenBrief[],
  context: IdeationContext,
): string {
  const sig = signals
    .map(
      (s) =>
        `[${s.id}] (${s.kind}, ${s.occurredAt.toISOString().slice(0, 10)})\n  ${s.title}\n  ${s.excerpt ?? "(no excerpt)"}`
    )
    .join("\n\n");

  const open =
    openBriefs.length > 0
      ? openBriefs.map((b) => `[${b.id}] ${b.title} — ${b.angle}`).join("\n")
      : "(none)";

  const covered = context.covered.length > 0 ? context.covered.map((c) => `- ${c}`).join("\n") : "(nothing yet)";
  const rejected =
    context.rejected.length > 0 ? context.rejected.map((r) => `- ${r}`).join("\n") : "(nothing yet)";

  return [
    "## Signals",
    "",
    sig,
    "",
    "## Briefs already awaiting a decision (extend these rather than repeating them)",
    "",
    open,
    "",
    "## Already covered — do not propose these again",
    "",
    covered,
    "",
    "## Previously rejected by this team, with their reasons — learn from these",
    "",
    rejected,
  ].join("\n");
}

export async function ideate(
  args: {
    signals: IdeationSignal[];
    openBriefs: OpenBrief[];
    context: IdeationContext;
    profile: RelevanceProfile;
    tenantId: string;
  },
  deps: IdeateDeps = {}
): Promise<IdeationResult> {
  if (args.signals.length === 0) return { assessment: "No signals in the window.", actions: [] };

  const generate = deps.generate ?? (generateObject as unknown as IdeationGenerate);

  try {
    const spec = process.env.IDEATION_MODEL ?? "anthropic/claude-sonnet-4-5";
    const { object, usage } = await generate({
      model: resolveModel(spec),
      schema: IdeationSchema,
      system: buildSystem(args.profile),
      prompt: buildPrompt(args.signals, args.openBriefs, args.context),
      maxOutputTokens: MAX_IDEATION_OUTPUT_TOKENS,
    });

    await recordLlmUsage({ tenantId: args.tenantId, operation: "ideation", model: modelId(spec), usage });

    const knownSignals = new Set(args.signals.map((s) => s.id));
    const knownBriefs = new Set(args.openBriefs.map((b) => b.id));
    const actions: IdeationAction[] = [];

    for (const action of object.actions) {
      if (action.type === "extend") {
        // An extend naming a brief we did not send has nothing to attach to.
        if (!knownBriefs.has(action.briefId)) continue;
        const ids = action.evidenceSignalIds.filter((id) => knownSignals.has(id));
        if (ids.length === 0) continue;
        actions.push({ type: "extend", briefId: action.briefId, evidenceSignalIds: ids });
        continue;
      }

      const ids = action.brief.evidenceSignalIds.filter((id) => knownSignals.has(id));
      // A brief whose evidence was entirely invented is not a brief. Stripping
      // phantom ids is enough when at least one real signal survives; when none
      // does, there is nothing for a human to check the claim against.
      if (ids.length === 0) continue;
      actions.push({
        type: "propose",
        brief: {
          ...action.brief,
          audience: action.brief.audience ?? null,
          targetLength: action.brief.targetLength ?? null,
          evidenceSignalIds: ids,
        },
      });
    }

    return { assessment: object.assessment, actions };
  } catch (error) {
    return { error: String(error) };
  }
}
