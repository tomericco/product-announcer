import { eq } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { signals, sources, companyProfiles, tenants, type Source } from "@/db/schema";
import { fetchPageText, type PageResult } from "@/lib/workspace/fetch-page";
import { extractBlocks } from "@/lib/signals/agent-page";
import { scoreRelevance, type RelevanceProfile, type ScorableItem, type ScoredItem, type RelevanceDeps } from "@/lib/signals/relevance";

type FetchPage = (url: string) => Promise<PageResult>;
type ScoreFn = (
  items: ScorableItem[],
  profile: RelevanceProfile,
  tenantId: string,
  deps?: RelevanceDeps
) => Promise<ScoredItem[]>;

export type CompetitorAgentDeps = {
  fetchPage?: FetchPage;
  score?: ScoreFn;
  database?: typeof defaultDb;
};

export type CompetitorRunResult = { written: number; dropped: number; baseline: boolean };

// A block below this score is judged "not interesting" and is dropped
// (uncounted) rather than written. A null score is a scoring *failure*, not a
// low score -- those are always written regardless of this floor, so a human
// sees them in the browser instead of the miss being silent.
const RELEVANCE_FLOOR = 0.3;

// Caps how many hashes a source's watermark carries. Without a cap, a
// long-running source's watermark grows without bound and every run reads and
// rewrites an ever-larger JSON blob. Hashes are appended in block order as
// they're confirmed seen, so slicing from the end keeps the most recent ~1000
// and drops the oldest first.
const MAX_WATERMARK_HASHES = 1000;

type Watermark = { seenHashes?: unknown };

function readSeenHashes(watermark: unknown): string[] {
  const seen = (watermark as Watermark | null | undefined)?.seenHashes;
  return Array.isArray(seen) ? seen.filter((h): h is string => typeof h === "string") : [];
}

async function loadProfile(tenantId: string, database: typeof defaultDb): Promise<RelevanceProfile> {
  const [tenant] = await database.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, tenantId));
  const [profile] = await database.select().from(companyProfiles).where(eq(companyProfiles.tenantId, tenantId));

  return {
    name: tenant?.name ?? "",
    oneLiner: profile?.oneLiner ?? null,
    positioning: profile?.positioning ?? null,
    topics: profile?.topics ?? [],
  };
}

type SourceRunUpdate = {
  lastRunAt: Date;
  lastSuccessAt?: Date;
  status: "active" | "failing";
  lastError: string | null;
  watermark?: { seenHashes: string[] };
};

async function updateSourceRun(database: typeof defaultDb, sourceId: string, update: SourceRunUpdate): Promise<void> {
  await database.update(sources).set(update).where(eq(sources.id, sourceId));
}

/**
 * One source, one run: fetch the best available representation of a watched
 * competitor page, split it into blocks, work out which blocks are new since
 * last time, score those, and write signals for the ones worth keeping.
 *
 * The first run of a source is a baseline -- with no prior watermark, every
 * block on the page looks "new", and treating them that way would dump a
 * competitor's entire back catalogue into the signals browser as today-dated
 * moves. So a baseline only records hashes and returns; it does not score
 * (that would burn a model call on an archive nobody asked to see) and it
 * writes nothing.
 *
 * `occurredAt` on every written signal is first-seen time (now), not a date
 * parsed out of the page. Diffing only ever observes forward changes, so a
 * block that is new on this run genuinely appeared since the last one --
 * unlike the shipped-work reconciler, which has to derive `occurredAt` from
 * change events because a year of history can be imported in one shot.
 *
 * Fetches `source.agentUrl` when discovery found one, `source.url` otherwise
 * -- both through the injected `fetchPage`, since a competitor's page is
 * attacker-influenced input by definition. Written signals always carry
 * `source.url` (the human-readable page), never the agent-facing variant or
 * the fetch's `finalUrl`, so a person clicking through from the signals
 * browser lands somewhere readable.
 */
export async function runCompetitorSource(source: Source, deps: CompetitorAgentDeps = {}): Promise<CompetitorRunResult> {
  const fetchPage = deps.fetchPage ?? fetchPageText;
  const score = deps.score ?? scoreRelevance;
  const database = deps.database ?? defaultDb;

  const now = new Date();
  const fetchUrl = source.agentUrl ?? source.url;

  const page = fetchUrl ? await fetchPage(fetchUrl) : ({ error: "invalid-url" } as const);

  if ("error" in page) {
    await updateSourceRun(database, source.id, {
      lastRunAt: now,
      status: "failing",
      lastError: page.error,
    });
    return { written: 0, dropped: 0, baseline: false };
  }

  const blocks = extractBlocks(page.text);
  const seenHashes = readSeenHashes(source.watermark);
  const isBaseline = seenHashes.length === 0;

  if (isBaseline) {
    const cappedHashes = blocks.map((b) => b.hash).slice(-MAX_WATERMARK_HASHES);
    await updateSourceRun(database, source.id, {
      lastRunAt: now,
      lastSuccessAt: now,
      status: "active",
      lastError: null,
      watermark: { seenHashes: cappedHashes },
    });
    return { written: 0, dropped: 0, baseline: true };
  }

  const seen = new Set(seenHashes);
  const newBlocks = blocks.filter((b) => !seen.has(b.hash));

  if (newBlocks.length === 0) {
    await updateSourceRun(database, source.id, {
      lastRunAt: now,
      lastSuccessAt: now,
      status: "active",
      lastError: null,
    });
    return { written: 0, dropped: 0, baseline: false };
  }

  const profile = await loadProfile(source.tenantId, database);
  const items: ScorableItem[] = newBlocks.map((b) => ({ title: b.title, text: b.text, url: source.url ?? null }));
  const scored = await score(items, profile, source.tenantId, {});

  let written = 0;
  let dropped = 0;
  const keptHashes: string[] = [];

  for (let i = 0; i < newBlocks.length; i++) {
    const block = newBlocks[i];
    const result = scored[i];
    const belowFloor = result.score !== null && result.score < RELEVANCE_FLOOR;

    if (belowFloor) {
      dropped++;
      keptHashes.push(block.hash);
      continue;
    }

    try {
      await database
        .insert(signals)
        .values({
          tenantId: source.tenantId,
          sourceId: source.id,
          kind: "competitor_move",
          externalId: `${source.id}:${block.hash}`,
          url: source.url,
          title: block.title,
          excerpt: block.text,
          // First-seen time -- see the function doc for why this is correct
          // here and not a parsed publish date.
          occurredAt: now,
          competitorId: source.competitorId,
          relevanceScore: result.score,
          relevanceRationale: result.rationale,
          topics: result.topics,
        })
        .onConflictDoNothing({ target: [signals.tenantId, signals.kind, signals.externalId] });
      written++;
      keptHashes.push(block.hash);
    } catch (error) {
      console.error(`[competitor-agent] failed to write signal for source ${source.id}, block ${block.hash}:`, error);
      // Not merged into the watermark -- an unwritten block must be retried
      // on the next run rather than silently marked "seen".
    }
  }

  const mergedHashes = [...seenHashes, ...keptHashes].slice(-MAX_WATERMARK_HASHES);

  await updateSourceRun(database, source.id, {
    lastRunAt: now,
    lastSuccessAt: now,
    status: "active",
    lastError: null,
    watermark: { seenHashes: mergedHashes },
  });

  return { written, dropped, baseline: false };
}
