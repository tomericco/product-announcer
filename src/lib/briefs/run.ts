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
  const rows = await listSignals(tenantId, { minScore: IDEATION_MIN_SCORE, from }, database);
  const ideationSignals: IdeationSignal[] = rows.map((s) => ({
    id: s.id,
    kind: s.kind,
    occurredAt: s.occurredAt,
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

  // Dismissal is training data: the reason and the note are what teach the next
  // run what this team does not want, which is what makes the tool feel like a
  // copilot rather than a generator.
  const context: IdeationContext = {
    covered: acceptedRows.map((r) => r.title),
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

  if ("error" in outcome) return empty;

  const now = new Date();
  const expiresAt = new Date(now.getTime() + BRIEF_TTL_DAYS * 24 * 60 * 60 * 1000);
  let proposed = 0;
  let extended = 0;

  for (const action of outcome.actions) {
    if (action.type === "extend") {
      await database
        .update(briefs)
        .set({ lastEvidenceAt: now, updatedAt: now })
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
