import { generateObject } from "ai";
import { z } from "zod";
import { and, eq, isNull, or } from "drizzle-orm";
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
  size: z.enum(["s", "m", "l", "xl"]),
});

const SUMMARY_SYSTEM = [
  "You maintain the one-line description of an atomic update in a product changelog.",
  "You are given the current title and summary plus every change event that now backs it.",
  "Rewrite them so they describe the whole set accurately.",
  "Keep the title a short noun phrase and the summary a single plain sentence about the user-visible benefit.",
  "Stay close to the current wording when it is still accurate — this is an update, not a rewrite.",
  "Also pick a size by USER-FACING SIGNIFICANCE (not amount of code): 's' (a minor fix, tweak, or polish —",
  "small individual user impact), 'm' (a standard improvement or small feature noticeable to users of that",
  "area), 'l' (a significant feature or major improvement worth calling out to many users), 'xl' (a flagship",
  "or headline change — a major new capability or overhaul you would lead an announcement with).",
].join(" ");

export async function regenerateAtomicSummary(input: {
  tenantId: string;
  current: { title: string; summary: string };
  evidence: AtomicEvidence[];
}): Promise<{ title: string; summary: string; size: "s" | "m" | "l" | "xl" } | null> {
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

    return { title: object.title.trim(), summary: object.summary.trim(), size: object.size };
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
          eq(atomicUpdates.status, "open"),
          // Run unless BOTH title/summary and size are frozen.
          or(isNull(atomicUpdates.summaryEditedAt), isNull(atomicUpdates.sizeEditedAt))
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

    const now = new Date();
    // Two independent, self-gated updates: each re-checks its own freeze (and
    // open status) so a concurrent hand-edit mid-model-call suppresses only the
    // field the user touched — and a release claim suppresses both.
    await database
      .update(atomicUpdates)
      .set({ title: next.title, summary: next.summary, updatedAt: now })
      .where(and(eq(atomicUpdates.id, id), eq(atomicUpdates.status, "open"), isNull(atomicUpdates.summaryEditedAt)));
    await database
      .update(atomicUpdates)
      .set({ size: next.size, updatedAt: now })
      .where(and(eq(atomicUpdates.id, id), eq(atomicUpdates.status, "open"), isNull(atomicUpdates.sizeEditedAt)));
  }
}
