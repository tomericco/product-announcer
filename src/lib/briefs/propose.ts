import { generateObject } from "ai";
import { z } from "zod";
import { resolveModel, modelId } from "@/lib/ai/model";
import { recordLlmUsage } from "@/lib/ai/llm-usage";
import type { RelevanceProfile } from "@/lib/signals/relevance";
import { ProposedBriefSchema, type ProposedBrief } from "@/lib/briefs/ideate";

/**
 * Proposes exactly one brief from signals a human has already chosen.
 *
 * This is deliberately NOT `ideate`. `ideate`'s prompt asks the model to
 * decide whether anything is worth publishing at all, and on real data it has
 * twice, correctly, declined to propose anything — a refusal that is exactly
 * right for an agent scanning a thin signal pool on its own. But a human who
 * selected these signals by hand has already made that editorial call; asking
 * the model to re-litigate it here would just reproduce the same refusal in a
 * place it routes around. So the system prompt below states plainly that the
 * decision is made and asks only for the brief that commissions the piece —
 * it must never carry ideate's "decide if anything" framing or "THE BAR"
 * language back in.
 *
 * Returns a result object and never throws: this path exists for when the
 * agent is not helping, and a stalled proposal must never block a human from
 * writing the brief themselves.
 */

/** A manual selection is smaller than ideate's window; ten is plenty for a prompt. */
export const MAX_PROPOSAL_SIGNALS = 10;

/** One brief needs far less than ideate's 8,000, which budgets for up to six. */
export const MAX_PROPOSAL_OUTPUT_TOKENS = 2_000;

export type ProposalInput = {
  id: string;
  kind: string;
  title: string;
  excerpt: string | null;
  occurredAt: Date | null;
};

// The human's selection is authoritative. `evidenceSignalIds` is omitted from
// the schema itself — not merely stripped from the response afterwards — so
// the model has no field to fill in even if it tried.
const ProposalSchema = ProposedBriefSchema.omit({ evidenceSignalIds: true });

export type ProposalResult =
  | { ok: true; brief: Omit<ProposedBrief, "evidenceSignalIds"> }
  | { ok: false; error: string };

export type ProposalGenerate = (args: {
  model: ReturnType<typeof resolveModel>;
  schema: typeof ProposalSchema;
  system: string;
  prompt: string;
  maxOutputTokens: number;
}) => Promise<{
  object: z.infer<typeof ProposalSchema>;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}>;

export type ProposeDeps = { generate?: ProposalGenerate };

function buildSystem(profile: RelevanceProfile): string {
  return [
    `You are the content strategist for ${profile.name}.`,
    profile.oneLiner ? `${profile.name} is: ${profile.oneLiner}` : null,
    profile.positioning ? `${profile.name}'s positioning: ${profile.positioning}` : null,
    profile.topics.length > 0 ? `Topics ${profile.name} cares about: ${profile.topics.join(", ")}.` : null,
    "",
    "A person on the content team has ALREADY chosen the signals below and already",
    "decided this company should publish something about them. That editorial",
    "judgement is made — it is not yours to revisit.",
    "",
    "Write the brief that commissions the piece. Do not assess whether the material",
    "merits publishing, do not propose alternatives, and do not decline.",
    "",
    "CRAFT RULES.",
    "1. THE ANGLE MUST BE CONCRETE. If the brief would read exactly the same with a",
    "   competitor's name swapped in, sharpen it.",
    "2. WHY-NOW MUST BE GROUNDED IN THE SIGNALS GIVEN below — point at something",
    "   specific in them, not a generic industry trend.",
    "3. KEY POINTS ARE A COMMISSION, NOT A DRAFT. Three to five, one sentence each.",
    "4. MATCH TYPE TO SUBSTANCE. product_update for shipped work worth announcing,",
    "   blog_post for an argument needing room, social_post for one sharp point.",
    "5. SCORE IS A DECIMAL BETWEEN 0 AND 1 — for example 0.72, never 7.2 or 72.",
    "   It is your confidence in the brief, and it is compared directly against",
    "   scores from other briefs, so a value on any other scale is not merely",
    "   imprecise, it outranks everything else permanently.",
  ]
    .filter((l) => l !== null)
    .join("\n");
}

function buildPrompt(signals: ProposalInput[]): string {
  // Same "publication date unknown" honesty as ideate: a signal with no known
  // date is never rendered with today's, which would hand the model a false
  // why-now to repeat as fact.
  const sig = signals
    .map(
      (s) =>
        `[${s.id}] (${s.kind}, ${s.occurredAt ? s.occurredAt.toISOString().slice(0, 10) : "publication date unknown"})\n  ${s.title}\n  ${s.excerpt ?? "(no excerpt)"}`
    )
    .join("\n\n");

  return ["## Signals chosen for this brief", "", sig].join("\n");
}

export async function proposeBriefFromSignals(
  args: { signals: ProposalInput[]; profile: RelevanceProfile; tenantId: string },
  deps: ProposeDeps = {}
): Promise<ProposalResult> {
  try {
    if (args.signals.length === 0) {
      return { ok: false, error: "Select at least one signal before proposing a brief." };
    }

    const generate = deps.generate ?? (generateObject as unknown as ProposalGenerate);
    const signals = args.signals.slice(0, MAX_PROPOSAL_SIGNALS);

    const spec = process.env.IDEATION_MODEL ?? "anthropic/claude-sonnet-4-5";
    const { object, usage } = await generate({
      model: resolveModel(spec),
      schema: ProposalSchema,
      system: buildSystem(args.profile),
      prompt: buildPrompt(signals),
      maxOutputTokens: MAX_PROPOSAL_OUTPUT_TOKENS,
    });

    await recordLlmUsage({ tenantId: args.tenantId, operation: "brief_proposal", model: modelId(spec), usage });

    // Built field-by-field rather than spread. `generate` is caller-injected
    // and its result is not guaranteed to have been schema-validated (a test
    // double can hand back anything, including a hallucinated
    // `evidenceSignalIds`) — spreading would let that leak straight through
    // the one guard this module exists to enforce.
    return {
      ok: true,
      brief: {
        contentType: object.contentType,
        title: object.title,
        angle: object.angle,
        whyNow: object.whyNow,
        audience: object.audience ?? null,
        keyPoints: object.keyPoints,
        targetLength: object.targetLength ?? null,
        suggestedChannel: object.suggestedChannel,
        // Clamped, because an instruction is not an enforcement. A live run
        // returned 8.2 on a 0-1 field: the inbox orders by score DESC, so one
        // out-of-scale value silently outranks every agent brief forever, and
        // nothing about the row looks wrong. The prompt states the range; this
        // makes it true.
        score: Math.min(1, Math.max(0, object.score)),
        scoreRationale: object.scoreRationale,
      },
    };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}
