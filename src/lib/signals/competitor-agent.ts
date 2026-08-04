import { eq } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { signals, sources, companyProfiles, tenants, type Source } from "@/db/schema";
import { fetchPageText, MAX_TEXT_CHARS, type PageResult } from "@/lib/workspace/fetch-page";
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
// rewrites an ever-larger JSON blob.
//
// Ordering is last-seen, not insertion-order: every run, hashes still present
// on the page (whether carried over from a prior run or newly confirmed this
// run) are moved to the end of the list; hashes for content no longer on the
// page keep their existing, older position. A block that keeps reappearing on
// every run -- an intro paragraph, a subscribe blurb -- can therefore never be
// evicted no matter how many other hashes accumulate after it. Only hashes
// whose content has actually dropped off the page age toward the front and
// get trimmed first once the cap is hit.
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

  const rawBlocks = extractBlocks(page.text);
  // When the fetched text was truncated at MAX_TEXT_CHARS, the last block may
  // be a fragment cut mid-sentence by the slice -- its hash is an artifact of
  // where the cutoff landed, not a genuine change, and would otherwise be
  // reported as a spurious signal (or watermarked and then look "new" again
  // the moment the cutoff shifts). Drop it here rather than in extractBlocks,
  // which is pure and has no idea its input was cut.
  const wasTruncated = page.text.length === MAX_TEXT_CHARS;
  const blocks = wasTruncated ? rawBlocks.slice(0, -1) : rawBlocks;
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
  let failedWrites = 0;
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
          // Keyed on the fetched page's finalUrl, not source.id. A competitor
          // with no per-page .md variant commonly has several sources (a
          // changelog source, a blog source) all falling back to the same
          // site-wide llms.txt -- discovery has no way to know that ahead of
          // time, since it probes each candidate page independently. Keying
          // on source.id would give those sources' identical fetched content
          // different externalIds and write the same change N times. Keying
          // on finalUrl (where the fetch actually landed, not the URL each
          // source happens to be configured with) means two sources that
          // land on the same content produce the same externalId, so the
          // second write hits onConflictDoNothing and one real change yields
          // one signal. The surviving row's sourceId is whichever source ran
          // first; that's fine, since competitorId is correct either way and
          // it's genuinely the same event.
          externalId: `${page.finalUrl}:${block.hash}`,
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
      failedWrites++;
      console.error(`[competitor-agent] failed to write signal for source ${source.id}, block ${block.hash}:`, error);
      // Not merged into the watermark -- an unwritten block must be retried
      // (re-scored, re-attempted) on the next run rather than silently
      // marked "seen". See lastError below for why this must also be
      // operator-visible, not just logged.
    }
  }

  // Last-seen ordering (see MAX_WATERMARK_HASHES above): hashes carried over
  // from the previous watermark that are still present on this run's page
  // move to the end, alongside the newly-kept hashes (also present, by
  // definition). Hashes for content that has actually dropped off the page
  // keep their old, earlier position and are what the cap below trims first.
  const presentThisRun = new Set(blocks.map((b) => b.hash));
  const stillPresent = seenHashes.filter((h) => presentThisRun.has(h));
  const noLongerPresent = seenHashes.filter((h) => !presentThisRun.has(h));
  const mergedHashes = [...noLongerPresent, ...stillPresent, ...keptHashes].slice(-MAX_WATERMARK_HASHES);

  // The run itself succeeded -- it fetched, extracted, and scored -- so this
  // stays `status: "active"` with `lastSuccessAt` set even when some writes
  // failed. That's different from the fetch-failure branch above, which
  // genuinely cannot reach the competitor at all. But a write failure must
  // still surface *somewhere* an operator can see it: a block that fails to
  // write deterministically (not just transiently) would otherwise be
  // silently re-fetched, re-extracted, re-scored, and re-attempted forever,
  // with nothing but a console.error nobody reads as evidence. `lastError`
  // is that evidence, named with a count so it's actionable rather than
  // just "something went wrong".
  const lastError =
    failedWrites > 0
      ? `${failedWrites} of ${newBlocks.length} new blocks failed to write on "${source.label}"; they will be retried next run`
      : null;

  await updateSourceRun(database, source.id, {
    lastRunAt: now,
    lastSuccessAt: now,
    status: "active",
    lastError,
    watermark: { seenHashes: mergedHashes },
  });

  return { written, dropped, baseline: false };
}
