"use server";

import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { competitors, signals, sources } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { signalWindowCondition } from "@/lib/signals/window";
import { toRegistrableDomain } from "@/lib/ai-visibility/domains";

/**
 * A page this signal is based on. `label` is what to show; `url` is where it
 * goes. `role` says WHICH page it is, because a signal can cite more than one
 * and they are not interchangeable — "article" is the thing itself, "source"
 * is the watched page or search source it came out of.
 */
export type SourceEvidenceLink = {
  role: "article" | "source";
  label: string;
  url: string;
  domain: string | null;
};

export type SourceEvidenceView = {
  title: string;
  kindLabel: string;
  occurredAtLabel: string;
  excerpt: string | null;
  topics: string[];
  relevanceScore: number | null;
  relevanceRationale: string | null;
  competitorName: string | null;
  sourceLabel: string | null;
  links: SourceEvidenceLink[];
};

/** Same guard, same shape, as `ai-visibility-actions.ts` and `signals/params.ts`. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidOrNull(value: unknown): string | null {
  return typeof value === "string" && UUID_RE.test(value) ? value : null;
}

const DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

/**
 * The kinds this dialog covers: the ones whose evidence IS a web page.
 * `shipped_work` (an atomic update and its change events) and `ai_visibility`
 * (a payload) have their own components; there is nothing shared to factor
 * out, only the same "Evidence" affordance in the same visual language.
 */
const LINK_BACKED_KINDS = ["market_news", "competitor_move", "manual"] as const;

const KIND_LABEL: Record<(typeof LINK_BACKED_KINDS)[number], string> = {
  market_news: "Market news",
  competitor_move: "Competitor move",
  manual: "Manual",
};

/**
 * Only a URL that will be rendered as an `href` and is honestly fetchable.
 *
 * `signals.url` is third-party data on every kind this dialog serves — a
 * Tavily search result, a competitor's own page, or a hand-typed field on the
 * manual form — so it gets the same treatment `toRegistrableDomain` documents
 * for cited URLs: `javascript://evil.com/%0aalert(1)` parses as an ordinary
 * URL with a perfectly good hostname, and dropping the scheme check would
 * keep the payload. React refusing to render it today is a framework
 * internal, not a decision this code made.
 */
export function safeHttpUrl(value: string | null): string | null {
  if (!value) return null;
  const raw = value.trim();
  if (!/^https?:\/\//i.test(raw)) return null;
  try {
    new URL(raw);
  } catch {
    return null;
  }
  return raw;
}

/**
 * The pages behind one link-backed signal, for the evidence dialog on
 * `/signals`.
 *
 * `signals.url` already holds the page every one of these kinds is based on —
 * the article URL for `market_news`, the watched page for `competitor_move`,
 * whatever was typed for `manual` — so nothing new is stored to answer "where
 * did this come from"; it was simply never rendered anywhere but as the row
 * title's own (visually unmarked) link. This reads it, plus the source row
 * behind it, and returns both as explicit links.
 *
 * The `source` link is deliberately separate from the `article` one rather
 * than deduped away when a source has a URL: for `competitor_move` the two
 * genuinely differ in meaning (the changed page vs. the source we watch), and
 * for `market_news` the source has no URL at all — it is a topic search — so
 * only the article is ever offered.
 *
 * Tenant-scoped in the WHERE clause and windowed by `signalWindowCondition()`
 * for the same reasons as `loadAiVisibilityEvidence`: a `signalId` off the
 * browser is untrusted, another tenant's id matches nothing and comes back
 * `null` undistinguished from a miss, and a signal that has aged out of the
 * browser has evidence nobody should still be acting on. Status is NOT
 * filtered — a stale row's Evidence button must open its evidence.
 *
 * No revalidate: nothing here writes.
 */
export async function loadSourceEvidence(signalId: string): Promise<SourceEvidenceView | null> {
  const session = await requireSession();
  const id = uuidOrNull(signalId);
  if (id === null) return null;

  const [signal] = await db
    .select({
      kind: signals.kind,
      title: signals.title,
      url: signals.url,
      excerpt: signals.excerpt,
      occurredAt: signals.occurredAt,
      fetchedUrl: signals.fetchedUrl,
      topics: signals.topics,
      relevanceScore: signals.relevanceScore,
      relevanceRationale: signals.relevanceRationale,
      sourceId: signals.sourceId,
      competitorId: signals.competitorId,
    })
    .from(signals)
    .where(
      and(
        eq(signals.id, id),
        eq(signals.tenantId, session.user.tenantId),
        inArray(signals.kind, [...LINK_BACKED_KINDS]),
        signalWindowCondition()
      )
    )
    .limit(1);

  if (!signal) return null;

  // Both joins are tenant-scoped again rather than trusting the foreign key:
  // the columns are `ON DELETE SET NULL`, so a stale id is a miss, and a miss
  // must render as "no source" rather than as an error.
  const [sourceRows, competitorRows] = await Promise.all([
    signal.sourceId
      ? db
          .select({ label: sources.label, url: sources.url, agentUrl: sources.agentUrl })
          .from(sources)
          .where(and(eq(sources.id, signal.sourceId), eq(sources.tenantId, session.user.tenantId)))
          .limit(1)
      : Promise.resolve([]),
    signal.competitorId
      ? db
          .select({ name: competitors.name })
          .from(competitors)
          .where(and(eq(competitors.id, signal.competitorId), eq(competitors.tenantId, session.user.tenantId)))
          .limit(1)
      : Promise.resolve([]),
  ]);

  const source = sourceRows[0] ?? null;
  const links: SourceEvidenceLink[] = [];

  const articleUrl = safeHttpUrl(signal.url);
  if (articleUrl) {
    links.push({
      role: "article",
      label: signal.kind === "competitor_move" ? "Page that changed" : "Article",
      url: articleUrl,
      domain: toRegistrableDomain(articleUrl),
    });
  }

  // The page the fetch actually landed on — the `.md` variant or llms.txt a
  // competitor publishes for machines — so a human checking the signal against
  // its evidence reads the same text the agent did rather than something
  // else. `signals.fetchedUrl` is the recorded answer; the source's own
  // agentUrl/url is the fallback for rows written before that column existed,
  // and is the same page in every case but a source reconfigured since.
  const sourceUrl = safeHttpUrl(signal.fetchedUrl ?? source?.agentUrl ?? source?.url ?? null);
  if (sourceUrl && sourceUrl !== articleUrl) {
    links.push({
      role: "source",
      label: source?.label ? `Page fetched — ${source.label}` : "Page fetched",
      url: sourceUrl,
      domain: toRegistrableDomain(sourceUrl),
    });
  }

  return {
    title: signal.title,
    kindLabel: KIND_LABEL[signal.kind as (typeof LINK_BACKED_KINDS)[number]],
    occurredAtLabel: DATE_FORMAT.format(signal.occurredAt),
    excerpt: signal.excerpt,
    topics: signal.topics,
    relevanceScore: signal.relevanceScore,
    relevanceRationale: signal.relevanceRationale,
    competitorName: competitorRows[0]?.name ?? null,
    sourceLabel: source?.label ?? null,
    links,
  };
}
