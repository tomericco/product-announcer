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
 * One class for a domain whose citation rows disagree, chosen deterministically.
 *
 * They do disagree in practice: `domainClass` is decided per citation against
 * the competitor list as it stood at extraction time, so a domain classified
 * `publisher` in March and `competitor` in April has both in one window. Taking
 * whichever row the database handed back first made the leaderboard's class
 * column depend on scan order — the same window could render "publisher" on one
 * load and "competitor" on the next.
 *
 * Most-frequent wins, ties broken alphabetically. Frequency rather than
 * most-recent because the row aggregates the whole window, and alphabetical
 * rather than nothing because a tie must still resolve the same way every time.
 */
function dominantClass(counts: Map<string, number>): DomainClass {
  let best: string | null = null;
  let bestCount = 0;
  for (const [name, count] of [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (count > bestCount) {
      best = name;
      bestCount = count;
    }
  }
  return (best ?? "other") as DomainClass;
}

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
 * Eligibility is `isEligible` from `aggregate.ts` — the same SAMPLE CUT as
 * every rate on the page: errored, refused, flagged and brand-check rows are
 * out of both. The WINDOW is a different matter: `runs` defaults to
 * `WINDOW_RUNS` to match the tiles, but callers pass a longer one (the overview
 * asks for 12 so a domain cited once a quarter still appears), and a table over
 * 12 runs sitting under tiles over 4 is only honest if the surface says which
 * span each covers. Callers overriding `runs` must label the table accordingly.
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
    /** class -> how many citation rows carried it. See `dominantClass`. */
    classCounts: Map<string, number>;
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
      classCounts: new Map<string, number>(),
      competitorId: citation.competitorId,
      citations: 0,
      answers: new Set<string>(),
      engines: new Set<string>(),
      absent: new Set<string>(),
    };
    acc.classCounts.set(citation.domainClass, (acc.classCounts.get(citation.domainClass) ?? 0) + 1);
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
      domainClass: dominantClass(acc.classCounts),
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
