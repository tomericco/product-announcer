import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { briefSignals, briefs, contentPieces, signals, type Signal } from "@/db/schema";

export type CitedSignal = { id: string; title: string; url: string | null; kind: Signal["kind"] };

/**
 * The evidence cited by one brief — the editor's read, not the list's.
 *
 * `briefId` arrives from the URL and is untrusted, so this is tenant-scoped in
 * its own right rather than trusting a prior tenant check on the brief itself:
 * the join filters on `signals.tenantId`, not `briefs.tenantId`, so a briefId
 * belonging to another tenant returns no rows even if the caller forgot (or
 * got wrong) the brief-level check. `brief_signals` carries no `tenantId` of
 * its own — `signals` is the tenant-scoped side of the join.
 */
export async function listBriefSignals(
  briefId: string,
  tenantId: string,
  database: typeof defaultDb = defaultDb
): Promise<CitedSignal[]> {
  return database
    .select({
      id: signals.id,
      title: signals.title,
      url: signals.url,
      kind: signals.kind,
    })
    .from(briefSignals)
    .innerJoin(signals, eq(signals.id, briefSignals.signalId))
    .where(and(eq(briefSignals.briefId, briefId), eq(signals.tenantId, tenantId)));
}

export type RelatedPiece = { pieceId: string; title: string; status: string; publishedAt: Date | null };

/**
 * The content pieces whose brief cited an `ai_visibility` signal about one
 * prompt — section 4 of the prompt detail page.
 *
 * It lives in the briefs domain rather than in `metrics.ts` because briefs
 * already read signals, so a brief join that reaches a signal's payload is the
 * existing grain; `metrics.ts` reading `briefs`/`brief_signals`/
 * `content_pieces` would make the whole ai-visibility module depend on the
 * briefs domain because one page happens to render both.
 *
 * Matched on `payload->>'promptId'`, NEVER on `externalId`. That key's subject
 * slot holds `promptId ?? competitorId ?? domain ?? "all"`, so a
 * `new_cited_domain` signal puts a DOMAIN where a prompt id would sit and a
 * `competitor_gained` one puts a competitor id there — matching on it would
 * attach a placement brief to whichever prompt id happened to collide. The
 * payload key is null on exactly those rows, which is the right answer.
 *
 * Tenant-scoped on `signals`, the same side of the join `listBriefSignals`
 * trusts, because `promptId` arrives from the URL.
 */
export async function relatedPieces(
  tenantId: string,
  promptId: string,
  database: typeof defaultDb = defaultDb
): Promise<RelatedPiece[]> {
  const rows = await database
    .selectDistinct({
      pieceId: contentPieces.id,
      title: contentPieces.title,
      status: contentPieces.status,
      publishedAt: contentPieces.publishedAt,
    })
    .from(signals)
    .innerJoin(briefSignals, eq(briefSignals.signalId, signals.id))
    .innerJoin(briefs, eq(briefs.id, briefSignals.briefId))
    .innerJoin(contentPieces, eq(contentPieces.id, briefs.contentPieceId))
    .where(
      and(
        eq(signals.tenantId, tenantId),
        eq(signals.kind, "ai_visibility"),
        isNotNull(briefs.contentPieceId),
        sql`${signals.payload}->>'promptId' = ${promptId}`
      )
    )
    // Newest publication first; an unpublished piece sorts last rather than
    // first, which is what `nulls last` buys over drizzle's bare `desc`.
    .orderBy(sql`${contentPieces.publishedAt} desc nulls last`);

  return rows;
}
