import { and, desc, eq } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { briefs, briefSignals, companyProfiles, tenants } from "@/db/schema";
import { listSignals } from "@/lib/signals/query";
import type { RelevanceProfile } from "@/lib/signals/relevance";
import {
  ideate,
  type IdeationContext,
  type IdeationResult,
  type IdeationSignal,
  type OpenBrief,
} from "./ideate";

/**
 * How far back ideation looks, on `occurredAt`. Narrower than the 60-day
 * retention window in `signals/window.ts` on purpose: "what is recent enough to
 * write about" is a different question from "how long do we keep the row".
 */
export const IDEATION_WINDOW_DAYS = 30;

/**
 * Signals below this relevance are not worth the strategist's attention.
 * `listSignals` deliberately lets NULL scores through this filter — null means
 * scoring FAILED, not "scored zero", and a silently dropped failure is exactly
 * what the signals browser exists to surface.
 */
export const IDEATION_MIN_SCORE = 0.3;

/** How long a brief waits for a decision before the sweep expires it. */
export const BRIEF_TTL_DAYS = 14;

/** Caps how much covered/rejected history reaches the prompt. */
export const MAX_CONTEXT_ITEMS = 20;

/**
 * Ceiling on how many signals reach the one model call.
 *
 * This is the only model input in the codebase that would otherwise be
 * unbounded; every sibling caps its own deliberately (`MAX_CANDIDATES_PER_RUN`
 * 20, `MAX_TOPICS_PER_RUN` 5, `MAX_SIGNALS_PER_RUN` 5). Thirty days of an
 * active tenant is up to 5 news signals a day plus every changed competitor
 * block plus every shipped update — the low hundreds. Competitor signals make
 * that worse than the count suggests: `competitor-agent.ts` writes
 * `excerpt: block.text` with no length cap, while news excerpts are capped at
 * 500 characters. Left unbounded the request eventually overflows the context
 * window, `generateObject` throws, and `ideate` turns that into a silent
 * `{ error }`.
 *
 * 120 is generous for a real fortnight of activity while keeping the worst
 * case far short of the window. The rows arrive `desc(occurredAt)`, so
 * slicing keeps the freshest — the ones a why-now can actually point at.
 */
export const MAX_IDEATION_SIGNALS = 120;

/**
 * How close `occurredAt` and `createdAt` must be for the date to be first-seen
 * rather than real.
 *
 * They are never byte-identical even when they mean the same instant:
 * `runNewsSource` computes its fallback `now` in JS before the insert, while
 * `createdAt` defaults to the database's own `now()`. The gap is the write
 * round-trip plus whatever clock skew exists between the app and Postgres. A
 * minute swallows both with room to spare, and cannot swallow a real one: a
 * general-index article dated within a minute of when we first saw it does not
 * exist — the fastest anything reaches this pipeline is the next daily cron.
 */
const FIRST_SEEN_TOLERANCE_MS = 60_000;

/**
 * The signal's real publication date, or null when all we have is when we first
 * saw it.
 *
 * Only `market_news` can lie here, and only since the news agent moved to
 * Tavily's general index: an article whose own HTML carries no date is written
 * with `occurredAt = now`. `listSignals` orders `desc(occurredAt)`, so those
 * undated rows sort to the FRONT, and `ideate` would render each as
 * "(market_news, <today>)" while asking the strategist to build a why-now on
 * dated evidence. A two-year-old evergreen guide could produce a brief whose
 * `whyNow` asserts recency, and a human reads that as fact.
 *
 * Deliberately scoped to `market_news`. A `competitor_move` also carries
 * first-seen time, but there it is the truth: diffing only observes forward
 * changes, so a block that is new on this run genuinely appeared since the last
 * one (see `runCompetitorSource`). Blanking those would throw away a real date.
 *
 * Derived rather than stored because no schema change is warranted for this:
 * the row already holds both timestamps, and their near-equality IS the record
 * that the date was defaulted.
 */
function publicationDateOf(signal: { kind: string; occurredAt: Date; createdAt: Date }): Date | null {
  if (signal.kind !== "market_news") return signal.occurredAt;
  const gap = Math.abs(signal.occurredAt.getTime() - signal.createdAt.getTime());
  return gap <= FIRST_SEEN_TOLERANCE_MS ? null : signal.occurredAt;
}

type IdeateFn = typeof ideate;

export type IdeationRunDeps = { ideateFn?: IdeateFn; database?: typeof defaultDb };

export type IdeationRunResult = {
  proposed: number;
  extended: number;
  /** The model's one-line judgement of the period. Null when the call failed. */
  assessment: string | null;
};

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

/**
 * One tenant's ideation run.
 *
 * Writes nothing when the model call fails: a run nobody judged has proposed
 * nothing, and inventing briefs from a failure is the opposite of what the
 * human-gated model is for.
 */
export async function runIdeation(tenantId: string, deps: IdeationRunDeps = {}): Promise<IdeationRunResult> {
  const database = deps.database ?? defaultDb;
  const ideateFn = deps.ideateFn ?? ideate;

  const empty: IdeationRunResult = { proposed: 0, extended: 0, assessment: null };

  const profile = await loadProfile(tenantId, database);

  const from = new Date(Date.now() - IDEATION_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  // `includeStale` is deliberately omitted, so `listSignals` excludes stale
  // rows: a stale `shipped_work` signal is work that was withdrawn, and
  // briefing about something that no longer ships is worse than saying nothing.
  const rows = await listSignals(tenantId, { minScore: IDEATION_MIN_SCORE, from }, database);
  const ideationSignals: IdeationSignal[] = rows.slice(0, MAX_IDEATION_SIGNALS).map((s) => ({
    id: s.id,
    kind: s.kind,
    occurredAt: publicationDateOf(s),
    title: s.title,
    excerpt: s.excerpt,
  }));

  // Only `new` briefs can be extended. Accepted and dismissed ones become
  // context instead — offering a dismissed brief for extension would let the
  // team's own rejection come straight back next run.
  const openRows = await database
    .select({ id: briefs.id, title: briefs.title, angle: briefs.angle })
    .from(briefs)
    .where(and(eq(briefs.tenantId, tenantId), eq(briefs.status, "new")))
    .orderBy(desc(briefs.lastEvidenceAt));
  const openBriefs: OpenBrief[] = openRows;

  const acceptedRows = await database
    .select({ title: briefs.title })
    .from(briefs)
    .where(and(eq(briefs.tenantId, tenantId), eq(briefs.status, "accepted")))
    .orderBy(desc(briefs.acceptedAt))
    .limit(MAX_CONTEXT_ITEMS);

  const dismissedRows = await database
    .select({ title: briefs.title, reason: briefs.dismissReason, note: briefs.dismissNote })
    .from(briefs)
    .where(and(eq(briefs.tenantId, tenantId), eq(briefs.status, "dismissed")))
    .orderBy(desc(briefs.dismissedAt))
    .limit(MAX_CONTEXT_ITEMS);

  // Expired briefs would otherwise fall out of every dedupe channel: `open`
  // takes `new`, `covered` takes `accepted`, `rejected` takes `dismissed`. With
  // a 14-day TTL and a 30-day window, an expired brief's evidence stays in the
  // window for a fortnight after it expires — with nothing to remember it was
  // ever proposed, so the model proposes it again. They ride the covered
  // channel, labelled, because "do not repeat this" is the same instruction;
  // the label is what stops the model reading an undecided brief as published
  // work.
  const expiredRows = await database
    .select({ title: briefs.title })
    .from(briefs)
    .where(and(eq(briefs.tenantId, tenantId), eq(briefs.status, "expired")))
    .orderBy(desc(briefs.expiresAt))
    .limit(MAX_CONTEXT_ITEMS);

  // The two share one budget, and neither may starve the other: each is
  // guaranteed half, and whatever the other leaves unused is handed back.
  const acceptedTitles = acceptedRows.map((r) => r.title);
  const expiredTitles = expiredRows.map((r) => `${r.title} (proposed before and expired without a decision)`);
  const expiredKept = expiredTitles.slice(
    0,
    Math.max(Math.floor(MAX_CONTEXT_ITEMS / 2), MAX_CONTEXT_ITEMS - acceptedTitles.length)
  );
  const acceptedKept = acceptedTitles.slice(0, MAX_CONTEXT_ITEMS - expiredKept.length);

  // Dismissal is training data: the reason and the note are what teach the next
  // run what this team does not want, which is what makes the tool feel like a
  // copilot rather than a generator.
  const context: IdeationContext = {
    covered: [...acceptedKept, ...expiredKept],
    rejected: dismissedRows.map((r) =>
      [r.title, r.reason ? `(${r.reason})` : null, r.note].filter(Boolean).join(" ")
    ),
  };

  const outcome: IdeationResult = await ideateFn({
    signals: ideationSignals,
    openBriefs,
    context,
    profile,
    tenantId,
  });

  if ("error" in outcome) {
    // Without this line a permanently broken ideation — a bad API key, a schema
    // validation failure, a context overflow — is indistinguishable from a
    // genuinely quiet company: the cron reports ok, no brief appears, and
    // nothing is written anywhere. The whole product promise is that an empty
    // inbox means "nothing was worth saying", so a failure that looks like
    // silence is the worst failure this system has. Every sibling producer logs
    // its swallowed errors the same way.
    console.error(`[ideation] failed for tenant ${tenantId}:`, outcome.error);
    return empty;
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + BRIEF_TTL_DAYS * 24 * 60 * 60 * 1000);
  let proposed = 0;
  let extended = 0;

  for (const action of outcome.actions) {
    if (action.type === "extend") {
      await database
        .update(briefs)
        // `expiresAt` moves with `lastEvidenceAt`, or extension would be
        // cosmetic: `expireStaleBriefs` filters on `expiresAt` alone, so a
        // brief extended on day 13 would still expire on day 14 while it was
        // visibly still gathering support. A brief the world keeps supplying
        // evidence for has earned another full TTL.
        .set({ lastEvidenceAt: now, expiresAt, updatedAt: now })
        .where(and(eq(briefs.id, action.briefId), eq(briefs.tenantId, tenantId)));
      await database
        .insert(briefSignals)
        .values(action.evidenceSignalIds.map((signalId) => ({ briefId: action.briefId, signalId })))
        // The PK on (briefId, signalId) makes re-attaching the same evidence a
        // no-op rather than an error — a later run legitimately sees the same
        // signal again.
        .onConflictDoNothing();
      extended++;
      continue;
    }

    const b = action.brief;
    const [inserted] = await database
      .insert(briefs)
      .values({
        tenantId,
        origin: "agent",
        contentType: b.contentType,
        title: b.title,
        angle: b.angle,
        whyNow: b.whyNow,
        suggestedChannel: b.suggestedChannel,
        audience: b.audience,
        keyPoints: b.keyPoints,
        targetLength: b.targetLength,
        score: b.score,
        scoreRationale: b.scoreRationale,
        lastEvidenceAt: now,
        expiresAt,
      })
      .returning({ id: briefs.id });

    await database
      .insert(briefSignals)
      // Null addedBy marks agent-attached evidence; a human attaching one sets it.
      .values(b.evidenceSignalIds.map((signalId) => ({ briefId: inserted.id, signalId })))
      .onConflictDoNothing();
    proposed++;
  }

  return { proposed, extended, assessment: outcome.assessment };
}
