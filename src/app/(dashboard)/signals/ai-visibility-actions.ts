"use server";

import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { signals, tenants } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { signalWindowCondition } from "@/lib/signals/window";
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

/** Same guard, same shape, as `/ai-visibility`'s actions and `signals/params.ts`. */
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
 * The evidence behind one `ai_visibility` signal, for the dialog on
 * `/signals`. One row by id, in `readSignalEvidence`'s shape — the id comes
 * from the browser and is untrusted, so the tenant is in the WHERE clause and
 * another tenant's id simply matches nothing and returns null, the same
 * undistinguished handling that keeps this from leaking cross-tenant
 * existence.
 *
 * `signalWindowCondition()` keeps the browser's 60-day guarantee without
 * reading the whole window: a signal old enough to have aged out of the
 * browser has evidence nobody should still be acting on, and the dialog's
 * "may have aged out" copy is that designed behaviour speaking. Status is
 * deliberately NOT filtered — the browser can show stale rows, and a stale
 * row's Evidence button must open its evidence rather than the empty state.
 *
 * No revalidate: nothing here writes.
 */
export async function loadAiVisibilityEvidence(
  signalId: string
): Promise<AiVisibilityEvidenceView | null> {
  const session = await requireSession();
  // A Server Action argument is client input whatever TypeScript says, and this
  // one goes straight into a comparison against a `uuid` column: a non-uuid
  // makes Postgres raise 22P02 out of the action, so the dialog gets an
  // exception instead of the empty state it is built to show. `null` is the
  // same undistinguished miss another tenant's id already gets.
  const id = uuidOrNull(signalId);
  if (id === null) return null;
  const [signal] = await db
    .select({ title: signals.title, payload: signals.payload })
    .from(signals)
    .where(
      and(
        eq(signals.id, id),
        eq(signals.tenantId, session.user.tenantId),
        eq(signals.kind, "ai_visibility"),
        signalWindowCondition()
      )
    )
    .limit(1);
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
