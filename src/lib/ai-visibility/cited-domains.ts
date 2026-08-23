import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import {
  aiVisibilityCitations,
  aiVisibilityPrompts,
  aiVisibilityRuns,
  aiVisibilitySamples,
  signals,
} from "@/db/schema";
import { isEligible } from "@/lib/ai-visibility/aggregate";
import { SETTLED_RUN_STATUSES, WINDOW_RUNS } from "@/lib/ai-visibility/metrics";
import type { DomainClass } from "@/lib/ai-visibility/domains";
import { ENGINE_IDS, type EngineId } from "@/lib/ai-visibility/types";

export type CitedDomainRow = {
  domain: string;
  domainClass: DomainClass;
  /** Total citation rows — a domain cited twice in one answer counts twice. */
  citations: number;
  /** Distinct answers citing it. This is the number the share is built on. */
  answers: number;
  /**
   * `answers` as a percentage of the GROUNDED eligible answers in the window.
   *
   * A citation rate, so it takes the citation denominator: an answer the engine
   * wrote without searching cited nothing at all, and including it would deflate
   * every domain's share by however much of the window went ungrounded
   * (ungrounded-answers design, decision 6).
   */
  answerShare: number;
  engines: EngineId[];
  competitorId: string | null;
  /** Of the citing answers, how many never named the tenant. */
  tenantAbsentAnswers: number;
  /**
   * DISTINCT prompts among those answers — the number any "cited on N prompts"
   * rule or sentence must use.
   *
   * At three samples per prompt, `tenantAbsentAnswers` reaches three on a
   * single prompt, so a three-prompt threshold read off it fires on one prompt
   * and the sentence built from it says "3 prompts" about one question.
   */
  tenantAbsentPrompts: number;
  /**
   * One URL actually cited on this domain — the lowest citation position, ties
   * broken alphabetically so the same window always yields the same URL.
   *
   * Callers put this in evidence payloads, whose contract is CITED urls. A
   * synthesised `https://<domain>` homepage is not one: it is a page no engine
   * pointed at, and following it is a dead end for whoever reads the brief.
   */
  sampleUrl: string;
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
  opts: { runs?: number; limit?: number; promptId?: string; includeRunId?: string },
  database: typeof defaultDb = defaultDb
): Promise<CitedDomainRow[]> {
  const runs = await database
    .select({ id: aiVisibilityRuns.id })
    .from(aiVisibilityRuns)
    .where(
      and(
        eq(aiVisibilityRuns.tenantId, tenantId),
        // `SETTLED_RUN_STATUSES` — the same window the tiles, the trend chart
        // and the benchmark read. This used to filter `status = "complete"` by
        // hand, so a cap-paused or stopped run's answers counted everywhere on
        // the page EXCEPT here: the tenant paid for those citations and the one
        // table built out of citations refused to show them.
        //
        // `includeRunId` additionally admits one named run whatever its status.
        // `emitSignals` runs inside `finalizeRun`, before the run it is closing
        // is marked terminal; without this its citations are invisible to the
        // leaderboard and every domain it introduced looks a week old by the
        // time it shows up. Only the named run gets that exemption — a stray
        // `failed` run never does — so the shape stays `or(id, settled)`.
        opts.includeRunId
          ? or(
              eq(aiVisibilityRuns.id, opts.includeRunId),
              inArray(aiVisibilityRuns.status, [...SETTLED_RUN_STATUSES])
            )
          : inArray(aiVisibilityRuns.status, [...SETTLED_RUN_STATUSES])
      )
    )
    .orderBy(desc(aiVisibilityRuns.startedAt))
    .limit(opts.runs ?? WINDOW_RUNS);
  if (runs.length === 0) return [];
  const runIds = runs.map((r) => r.id);

  const samples = await database
    .select({
      id: aiVisibilitySamples.id,
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
    .where(
      and(
        eq(aiVisibilitySamples.tenantId, tenantId),
        inArray(aiVisibilitySamples.runId, runIds),
        ...(opts.promptId ? [eq(aiVisibilitySamples.promptId, opts.promptId)] : [])
      )
    );

  const eligible = new Map<string, { engine: string; promptId: string; tenantMentioned: boolean }>();
  /** The `answerShare` denominator: eligible answers the engine actually searched on. */
  let grounded = 0;
  for (const sample of samples) {
    if (!isEligible(sample, sample)) continue;
    eligible.set(sample.id, {
      engine: sample.engine,
      promptId: sample.promptId,
      tenantMentioned: sample.extraction?.deterministic.tenantMentioned ?? false,
    });
    if (sample.searchUsed) grounded += 1;
  }
  if (eligible.size === 0) return [];

  const citations = await database
    .select({
      sampleId: aiVisibilityCitations.sampleId,
      url: aiVisibilityCitations.url,
      position: aiVisibilityCitations.position,
      domain: aiVisibilityCitations.domain,
      domainClass: aiVisibilityCitations.domainClass,
      competitorId: aiVisibilityCitations.competitorId,
    })
    .from(aiVisibilityCitations)
    .where(inArray(aiVisibilityCitations.sampleId, [...eligible.keys()]))
    // Ordered so `sampleUrl` and the class tally do not depend on scan order.
    .orderBy(asc(aiVisibilityCitations.position), asc(aiVisibilityCitations.url));

  type Acc = {
    domain: string;
    /** class -> how many citation rows carried it. See `dominantClass`. */
    classCounts: Map<string, number>;
    competitorId: string | null;
    citations: number;
    answers: Set<string>;
    engines: Set<string>;
    absent: Set<string>;
    absentPrompts: Set<string>;
    sampleUrl: { url: string; position: number } | null;
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
      absentPrompts: new Set<string>(),
      sampleUrl: null,
    };
    acc.classCounts.set(citation.domainClass, (acc.classCounts.get(citation.domainClass) ?? 0) + 1);
    acc.citations += 1;
    acc.answers.add(citation.sampleId);
    acc.engines.add(sample.engine);
    if (!sample.tenantMentioned) {
      acc.absent.add(citation.sampleId);
      acc.absentPrompts.add(sample.promptId);
    }
    if (
      acc.sampleUrl === null ||
      citation.position < acc.sampleUrl.position ||
      (citation.position === acc.sampleUrl.position && citation.url.localeCompare(acc.sampleUrl.url) < 0)
    ) {
      acc.sampleUrl = { url: citation.url, position: citation.position };
    }
    // A competitor id, once known, wins over a null: classification depends on
    // the competitor list at extraction time, and a domain added to that list
    // mid-window would otherwise report null for its older citations.
    if (citation.competitorId) acc.competitorId = citation.competitorId;
    byDomain.set(citation.domain, acc);
  }

  // Grounded answers, not every eligible answer. `grounded` can only be 0 when
  // no answer in the window searched — and then no citation row exists either,
  // so `byDomain` is empty and nothing divides by it. The `max(1, …)` is belt
  // and braces against a hand-written citation row on an ungrounded sample.
  const denominator = Math.max(1, grounded);

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
      tenantAbsentPrompts: acc.absentPrompts.size,
      sampleUrl: acc.sampleUrl?.url ?? `https://${acc.domain}`,
      tenantAbsent: acc.absent.size === acc.answers.size,
    }))
    .sort((a, b) => b.answers - a.answers || b.citations - a.citations || a.domain.localeCompare(b.domain))
    .slice(0, opts.limit ?? DEFAULT_LIMIT);
}

/**
 * Every domain that has EVER had a `new_cited_domain` signal, window or not.
 *
 * The leaderboard has to tell two silences apart, and they are opposite. A row
 * offers "Propose brief" only while a signal is still resolvable through
 * `listSignals`; when there is none the cell has to say why, and saying the
 * wrong why invents an event. `new_cited_domain` fires on ENTRY — a domain new
 * to the top ten, or newly cited on three prompts where the tenant is absent
 * (rule 8 in `rankTriggers`, gated on `seenBefore`) — so for a source the
 * engines have leaned on steadily for months, the ordinary case is that no
 * signal ever existed. Only a domain that once had one has anything to expire.
 *
 * Deliberately NOT filtered by `signalWindowCondition()`, which is the one
 * question it exists to answer: the 60-day read window is exactly what hides
 * the difference between "expired" and "never happened". Nothing deletes
 * signals today. When the retention job in `lib/signals/window.ts` lands, an
 * aged-out row will eventually disappear from here too and the cell will fall
 * back to the "no signal yet" reading — wrong only in the direction of
 * claiming less than we know.
 */
export async function everSignalledDomains(
  tenantId: string,
  database: typeof defaultDb = defaultDb
): Promise<Set<string>> {
  // Matched on `payload->>'domain'`, never on `externalId`: the key's subject
  // slot holds a promptId on most kinds and a domain on this one, so a prefix
  // match there would be reading a different column's meaning by position
  // (the same reasoning `lib/briefs/query.ts` spells out for `promptId`).
  const rows = await database
    .select({ domain: sql<string | null>`${signals.payload}->>'domain'` })
    .from(signals)
    .where(
      and(
        eq(signals.tenantId, tenantId),
        eq(signals.kind, "ai_visibility"),
        sql`${signals.payload}->>'signalType' = 'new_cited_domain'`
      )
    );

  const domains = new Set<string>();
  for (const row of rows) {
    if (row.domain) domains.add(row.domain);
  }
  return domains;
}
