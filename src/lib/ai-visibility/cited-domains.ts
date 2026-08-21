import { and, desc, eq, inArray } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import {
  aiVisibilityCitations,
  aiVisibilityPrompts,
  aiVisibilityRuns,
  aiVisibilitySamples,
} from "@/db/schema";
import { isEligible } from "@/lib/ai-visibility/aggregate";
import { WINDOW_RUNS } from "@/lib/ai-visibility/metrics";
import type { DomainClass } from "@/lib/ai-visibility/domains";
import { ENGINE_IDS, type EngineId } from "@/lib/ai-visibility/types";

export type CitedDomainRow = {
  domain: string;
  domainClass: DomainClass;
  /** Total citation rows — a domain cited twice in one answer counts twice. */
  citations: number;
  /** Distinct answers citing it. This is the number the share is built on. */
  answers: number;
  /** `answers` as a percentage of eligible answers in the window. */
  answerShare: number;
  engines: EngineId[];
  competitorId: string | null;
  /** Of the citing answers, how many never named the tenant. */
  tenantAbsentAnswers: number;
  /** True when the tenant was named in NONE of the citing answers. */
  tenantAbsent: boolean;
};

/** How many rows the overview table shows before "Show all". */
const DEFAULT_LIMIT = 25;

/**
 * Where the engines got their answers (design §UX row 3, and the evidence
 * behind `new_cited_domain`).
 *
 * Two numbers, deliberately, because they answer different questions.
 * `citations` is how often the domain was cited at all; `answers` is how many
 * distinct answers cited it, and only the second can be turned into a
 * percentage — "cited 40 times" out of 84 answers is meaningless when one
 * answer can cite the same page three times.
 *
 * `tenantAbsentAnswers` is the whole reason a placement brief is worth writing:
 * a domain the engines lean on for questions where nobody names you is a page
 * you are missing from, not merely a popular site.
 *
 * Eligibility is `isEligible` from `aggregate.ts` — the same cut as every rate
 * on the page. A leaderboard built on a different denominator than the tiles
 * above it is how a dashboard loses its reader's trust in one sitting.
 */
export async function citedDomains(
  tenantId: string,
  opts: { runs?: number; limit?: number; promptId?: string },
  database: typeof defaultDb = defaultDb
): Promise<CitedDomainRow[]> {
  const runs = await database
    .select({ id: aiVisibilityRuns.id })
    .from(aiVisibilityRuns)
    .where(and(eq(aiVisibilityRuns.tenantId, tenantId), eq(aiVisibilityRuns.status, "complete")))
    .orderBy(desc(aiVisibilityRuns.startedAt))
    .limit(opts.runs ?? WINDOW_RUNS);
  if (runs.length === 0) return [];
  const runIds = runs.map((r) => r.id);

  const samples = await database
    .select({
      id: aiVisibilitySamples.id,
      engine: aiVisibilitySamples.engine,
      status: aiVisibilitySamples.status,
      flagged: aiVisibilitySamples.flagged,
      extraction: aiVisibilitySamples.extraction,
      branded: aiVisibilityPrompts.branded,
      intent: aiVisibilityPrompts.intent,
    })
    .from(aiVisibilitySamples)
    .innerJoin(aiVisibilityPrompts, eq(aiVisibilitySamples.promptId, aiVisibilityPrompts.id))
    .where(
      and(
        eq(aiVisibilitySamples.tenantId, tenantId),
        inArray(aiVisibilitySamples.runId, runIds),
        ...(opts.promptId ? [eq(aiVisibilitySamples.promptId, opts.promptId)] : [])
      )
    );

  const eligible = new Map<string, { engine: string; tenantMentioned: boolean }>();
  for (const sample of samples) {
    if (!isEligible(sample, sample)) continue;
    eligible.set(sample.id, {
      engine: sample.engine,
      tenantMentioned: sample.extraction?.deterministic.tenantMentioned ?? false,
    });
  }
  if (eligible.size === 0) return [];

  const citations = await database
    .select({
      sampleId: aiVisibilityCitations.sampleId,
      domain: aiVisibilityCitations.domain,
      domainClass: aiVisibilityCitations.domainClass,
      competitorId: aiVisibilityCitations.competitorId,
    })
    .from(aiVisibilityCitations)
    .where(inArray(aiVisibilityCitations.sampleId, [...eligible.keys()]));

  type Acc = {
    domain: string;
    domainClass: string;
    competitorId: string | null;
    citations: number;
    answers: Set<string>;
    engines: Set<string>;
    absent: Set<string>;
  };
  const byDomain = new Map<string, Acc>();

  for (const citation of citations) {
    const sample = eligible.get(citation.sampleId);
    if (!sample) continue;
    const acc = byDomain.get(citation.domain) ?? {
      domain: citation.domain,
      domainClass: citation.domainClass,
      competitorId: citation.competitorId,
      citations: 0,
      answers: new Set<string>(),
      engines: new Set<string>(),
      absent: new Set<string>(),
    };
    acc.citations += 1;
    acc.answers.add(citation.sampleId);
    acc.engines.add(sample.engine);
    if (!sample.tenantMentioned) acc.absent.add(citation.sampleId);
    // A competitor id, once known, wins over a null: classification depends on
    // the competitor list at extraction time, and a domain added to that list
    // mid-window would otherwise report null for its older citations.
    if (citation.competitorId) acc.competitorId = citation.competitorId;
    byDomain.set(citation.domain, acc);
  }

  const denominator = eligible.size;

  return [...byDomain.values()]
    .map((acc) => ({
      domain: acc.domain,
      domainClass: acc.domainClass as DomainClass,
      citations: acc.citations,
      answers: acc.answers.size,
      answerShare: (acc.answers.size / denominator) * 100,
      // Sorted into ENGINE_IDS order rather than insertion order, so the column
      // reads the same on every row.
      engines: ENGINE_IDS.filter((engine) => acc.engines.has(engine)),
      competitorId: acc.competitorId,
      tenantAbsentAnswers: acc.absent.size,
      tenantAbsent: acc.absent.size === acc.answers.size,
    }))
    .sort((a, b) => b.answers - a.answers || b.citations - a.citations || a.domain.localeCompare(b.domain))
    .slice(0, opts.limit ?? DEFAULT_LIMIT);
}
