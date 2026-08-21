"use server";

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { tenants } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { listSignals } from "@/lib/signals/query";
import { listCompetitors } from "@/lib/workspace/competitors";
import { buildAliases } from "@/lib/ai-visibility/aliases";
import type { AnswerAlias } from "../ai-visibility/prompts/[promptId]/highlighted-answer";

export type AiVisibilityEvidenceView = {
  promptId: string | null;
  promptText: string;
  engineLabel: string;
  modelId: string | null;
  runDateLabel: string;
  samples: string;
  excerpt: string | null;
  citedUrls: { url: string; domain: string; domainClass: string }[];
  aliases: AnswerAlias[];
};

const DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

/**
 * The evidence behind one `ai_visibility` signal, for the dialog on
 * `/signals`. Tenant-scoped from the session and never from the id the
 * browser sends: `listSignals` already filters on the session's tenant (plus
 * the 60-day window), so another tenant's id simply matches nothing and
 * returns null — the same undistinguished handling `readSignalEvidence`
 * documents, so this cannot leak cross-tenant existence either.
 *
 * `includeStale: true` because the browser itself can show stale rows, and a
 * stale signal's Evidence button must open its evidence rather than the
 * "aged out" empty state. The 60-day window still applies and is not a filter
 * any caller can widen: a signal old enough to have left the browser has
 * evidence nobody should still be acting on.
 *
 * No revalidate: nothing here writes.
 */
export async function loadAiVisibilityEvidence(
  signalId: string
): Promise<AiVisibilityEvidenceView | null> {
  const session = await requireSession();
  const rows = await listSignals(session.user.tenantId, {
    kind: "ai_visibility",
    includeStale: true,
  });
  const signal = rows.find((row) => row.id === signalId);
  const payload = signal?.payload;
  if (!signal || !payload) return null;

  const [competitors, tenantRows] = await Promise.all([
    listCompetitors(session.user.tenantId),
    // The tenant's NAME, not the company profile: `profile.category` is the
    // market ("Issue tracking software"), and marking it "you" while never
    // marking the actual brand is the exact wrong highlight.
    db.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, session.user.tenantId)),
  ]);
  const tenantName = tenantRows[0]?.name ?? "";

  return {
    promptId: payload.promptId ?? null,
    promptText: payload.promptText ?? signal.title,
    engineLabel: payload.engineLabel ?? "All engines",
    modelId: payload.modelId ?? null,
    runDateLabel: DATE_FORMAT.format(new Date(payload.runDate)),
    samples: payload.samples,
    excerpt: payload.excerpt ?? null,
    citedUrls: payload.citedUrls ?? [],
    // The same highlight the prompt detail page uses, so the excerpt reads
    // identically in both places: `buildAliases(name)` per brand — the same
    // spellings D4's extractor counted. Built here (server), passed as data.
    aliases: [
      ...buildAliases(tenantName).map((name) => ({
        name,
        kind: "tenant" as const,
        label: tenantName,
      })),
      ...competitors.flatMap((competitor) =>
        buildAliases(competitor.name).map((name) => ({
          name,
          kind: "competitor" as const,
          label: competitor.name,
        }))
      ),
    ],
  };
}
