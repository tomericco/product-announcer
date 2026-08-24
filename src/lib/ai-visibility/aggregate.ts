import { eq } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import {
  aiVisibilityAggregates,
  aiVisibilityPrompts,
  aiVisibilityRuns,
  aiVisibilitySamples,
} from "@/db/schema";

/**
 * The metric cut, in one place (design §Metrics: "`n` = samples in the cut
 * after excluding errors, flagged rows and brand-check prompts").
 *
 * An answer written WITHOUT a web search is in the cut. It is what a buyer
 * asking that question would read, so it measures what the engine said just as
 * well as a grounded one does; only the citation-family metrics exclude it, and
 * they do that on `search_used` rather than here (ungrounded-answers design).
 *
 * `branded` and `intent === "brand_check"` are both checked. They are the same
 * set by construction — generation marks brand-check prompts branded — but a
 * hand-added prompt can set one without the other, and a branded prompt leaking
 * into share of voice would inflate every number on the page. Cheap belt and
 * braces on the one rule the whole feature's credibility rests on.
 */
export function isEligible(
  sample: { status: string; flagged: boolean },
  prompt: { branded: boolean; intent: string }
): boolean {
  if (sample.status !== "ok") return false;
  if (sample.flagged) return false;
  if (prompt.branded || prompt.intent === "brand_check") return false;
  return true;
}

type Bucket = {
  n: number;
  /** Of `n`, how many ran a search — the citation-family denominator. */
  nGrounded: number;
  tenantMentions: number;
  competitorMentions: Record<string, number>;
  ownCitations: number;
  recommendations: number;
};

const emptyBucket = (): Bucket => ({
  n: 0,
  nGrounded: 0,
  tenantMentions: 0,
  competitorMentions: {},
  ownCitations: 0,
  recommendations: 0,
});

/**
 * Turns one run's samples into COUNT rows, per (run, engine) and per
 * (run, engine, prompt).
 *
 * Counts, never rates — contract decision 4. A rate cannot be summed, and every
 * window on the dashboard is a sum over the last four runs; storing 0.42 here
 * would make the 4-run window an average of averages, which is wrong whenever
 * the runs have different `n`. They always do: engines fail unevenly.
 *
 * An engine row is written even when every sample on that engine failed, so
 * `n = 0` is a recorded fact rather than a missing row. The overview's "–"
 * cells and the partial-failure line both need to tell "the engine answered and
 * nobody named us" apart from "the engine never answered".
 */
export async function computeAggregates(
  runId: string,
  database: typeof defaultDb = defaultDb
): Promise<{ engineRows: number; promptRows: number }> {
  const [run] = await database
    .select({ tenantId: aiVisibilityRuns.tenantId })
    .from(aiVisibilityRuns)
    .where(eq(aiVisibilityRuns.id, runId));
  if (!run) return { engineRows: 0, promptRows: 0 };

  const rows = await database
    .select({
      engine: aiVisibilitySamples.engine,
      promptId: aiVisibilitySamples.promptId,
      status: aiVisibilitySamples.status,
      flagged: aiVisibilitySamples.flagged,
      searchUsed: aiVisibilitySamples.searchUsed,
      extraction: aiVisibilitySamples.extraction,
      branded: aiVisibilityPrompts.branded,
      intent: aiVisibilityPrompts.intent,
    })
    .from(aiVisibilitySamples)
    .innerJoin(aiVisibilityPrompts, eq(aiVisibilitySamples.promptId, aiVisibilityPrompts.id))
    .where(eq(aiVisibilitySamples.runId, runId));

  const byEngine = new Map<string, Bucket>();
  const byPrompt = new Map<string, Bucket>();

  for (const row of rows) {
    // Every engine that has any sample at all gets a row, eligible or not.
    if (!byEngine.has(row.engine)) byEngine.set(row.engine, emptyBucket());
    if (!isEligible(row, row)) continue;

    const promptKey = `${row.engine} ${row.promptId}`;
    if (!byPrompt.has(promptKey)) byPrompt.set(promptKey, emptyBucket());

    const extraction = row.extraction;
    const tenantMentioned = extraction?.deterministic.tenantMentioned ?? false;
    const ownCited = extraction?.deterministic.ownDomainCited ?? false;
    const recommended = extraction?.judged?.level === "recommended";
    // One mention per brand per sample (design §Metrics). Extraction already
    // de-duplicates; a migrated or hand-written row might not.
    const competitorIds = [...new Set(extraction?.deterministic.competitorIds ?? [])];

    for (const bucket of [byEngine.get(row.engine)!, byPrompt.get(promptKey)!]) {
      bucket.n += 1;
      // An engine that answered from memory is in `n` — it said something — but
      // not in `nGrounded`, because it cited nothing and "nothing was cited" is
      // not the same fact as "we were not cited".
      if (row.searchUsed) bucket.nGrounded += 1;
      if (tenantMentioned) bucket.tenantMentions += 1;
      if (ownCited) bucket.ownCitations += 1;
      if (recommended) bucket.recommendations += 1;
      for (const id of competitorIds) {
        bucket.competitorMentions[id] = (bucket.competitorMentions[id] ?? 0) + 1;
      }
    }
  }

  // See the plan's note on why this is not an upsert against the two partial
  // unique indexes.
  await database.delete(aiVisibilityAggregates).where(eq(aiVisibilityAggregates.runId, runId));

  const values: (typeof aiVisibilityAggregates.$inferInsert)[] = [];
  for (const [engine, bucket] of byEngine) {
    values.push({ runId, tenantId: run.tenantId, engine, promptId: null, ...bucket });
  }
  for (const [key, bucket] of byPrompt) {
    const [engine, promptId] = key.split(" ");
    values.push({ runId, tenantId: run.tenantId, engine, promptId, ...bucket });
  }
  if (values.length > 0) await database.insert(aiVisibilityAggregates).values(values);

  return { engineRows: byEngine.size, promptRows: byPrompt.size };
}
