import { generateObject } from "ai";
import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { atomicUpdates, changeEvents } from "@/db/schema";
import { resolveModel, modelId } from "./model";
import { recordLlmUsage } from "./llm-usage";

type Database = typeof defaultDb;

export type AtomicEvidence = {
  type: "commit" | "pull_request" | "task";
  title: string;
  summary: string | null;
};

export const AtomicSummarySchema = z.object({
  title: z.string(),
  summary: z.string(),
});

const SUMMARY_SYSTEM = [
  "You maintain the one-line description of an atomic update in a product changelog.",
  "You are given the current title and summary plus every change event that now backs it.",
  "Rewrite them so they describe the whole set accurately.",
  "Keep the title a short noun phrase and the summary a single plain sentence about the user-visible benefit.",
  "Stay close to the current wording when it is still accurate — this is an update, not a rewrite.",
].join(" ");

export async function regenerateAtomicSummary(input: {
  tenantId: string;
  current: { title: string; summary: string };
  evidence: AtomicEvidence[];
}): Promise<{ title: string; summary: string } | null> {
  try {
    const spec = process.env.SUMMARY_MODEL ?? "anthropic/claude-haiku-4-5";
    const evidenceBlock = input.evidence
      .map((e) => `- [${e.type}] ${e.title}${e.summary ? ` — ${e.summary}` : ""}`)
      .join("\n");

    const { object, usage } = await generateObject({
      model: resolveModel(spec),
      schema: AtomicSummarySchema,
      system: SUMMARY_SYSTEM,
      prompt: `Current title: ${input.current.title}\nCurrent summary: ${input.current.summary}\n\nChange events:\n${evidenceBlock}`,
    });

    await recordLlmUsage({
      tenantId: input.tenantId,
      operation: "atomic_summary",
      model: modelId(spec),
      usage,
    });

    return { title: object.title.trim(), summary: object.summary.trim() };
  } catch (error) {
    // Keep the existing summary rather than blanking it on a transient error.
    console.error("[regenerate-atomic-summary] regeneration failed:", error);
    return null;
  }
}

/** Regenerates each atomic update whose summary has not been hand-edited. */
export async function refreshAtomicUpdates(
  database: Database,
  tenantId: string,
  atomicUpdateIds: string[]
): Promise<void> {
  for (const id of new Set(atomicUpdateIds)) {
    const [atomic] = await database
      .select()
      .from(atomicUpdates)
      .where(
        and(
          eq(atomicUpdates.id, id),
          eq(atomicUpdates.tenantId, tenantId),
          isNull(atomicUpdates.summaryEditedAt)
        )
      )
      .limit(1);
    if (!atomic) continue;

    const evidenceRows = await database
      .select({
        type: changeEvents.type,
        prTitle: changeEvents.prTitle,
        commitMessage: changeEvents.commitMessage,
        impactSummary: changeEvents.impactSummary,
      })
      .from(changeEvents)
      .where(eq(changeEvents.atomicUpdateId, id));

    const evidence: AtomicEvidence[] = evidenceRows.map((r) => ({
      type: r.type,
      title: r.prTitle ?? r.commitMessage ?? "",
      summary: r.impactSummary,
    }));

    if (evidence.length === 0) continue;

    const next = await regenerateAtomicSummary({
      tenantId,
      current: { title: atomic.title, summary: atomic.summary },
      evidence,
    });
    if (!next) continue;

    await database
      .update(atomicUpdates)
      .set({ title: next.title, summary: next.summary, updatedAt: new Date() })
      // Re-check the freeze: a user may have edited while the model was running.
      .where(and(eq(atomicUpdates.id, id), isNull(atomicUpdates.summaryEditedAt)));
  }
}
