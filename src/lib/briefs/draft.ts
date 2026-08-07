import { and, eq } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import {
  contentPieces,
  briefs,
  briefSignals,
  signals,
  type companyProfiles,
  type systemContentExamples,
  type ResolvedPersona,
} from "@/db/schema";
import type { BriefForPrompt, BriefEvidenceForPrompt } from "@/lib/ai/compose-prompt";
import { generateBriefDraft } from "@/lib/ai/generation";
import { prepareGenerationContext } from "@/lib/ai/generation-context";
import { listCompetitors } from "@/lib/workspace/competitors";

type Database = typeof defaultDb;
type BrandProfileRow = typeof companyProfiles.$inferSelect;
type ExampleRow = typeof systemContentExamples.$inferSelect;

export type DraftGenerator = (args: {
  brief: BriefForPrompt;
  evidence: BriefEvidenceForPrompt[];
  brandProfile: BrandProfileRow;
  personas?: ResolvedPersona[];
  examples?: ExampleRow[];
}) => Promise<{ title: string; body: string }>;

// Names shorter than this match almost anything ("Ax", "Go") and would flag
// nearly every draft — skipping them is deliberate, not an oversight. See
// `findNamedCompanies`.
export const MIN_COMPETITOR_NAME_LENGTH = 3;

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Scans `text` for any of `names` with no adjacent word character on either
 * side, case-insensitively. Used to warn (never to block — see
 * `generateDraftForPiece`) when a generated draft slips a competitor's name
 * into the copy despite the system prompt telling it not to.
 *
 * Deliberately NOT `\b…\b`: `\b` fires on a word/non-word transition, so a
 * name that is itself all punctuation on one or both ends (e.g. "C++",
 * "(x)") never produces a boundary there and can silently never match in
 * ordinary prose. Explicit negative lookarounds for an adjacent word
 * character give the same "don't match inside another word" protection
 * — "Lilt" still can't match inside "quilted" — while still matching "C++"
 * when it's followed by a space or punctuation. Each name is escaped before
 * being spliced into the pattern so a name containing regex metacharacters
 * can't corrupt it.
 */
export function findNamedCompanies(text: string, names: string[]): string[] {
  const matches: string[] = [];
  for (const name of names) {
    if (name.length < MIN_COMPETITOR_NAME_LENGTH) continue;
    const pattern = new RegExp(`(?<![A-Za-z0-9])${escapeForRegExp(name)}(?![A-Za-z0-9])`, "i");
    if (pattern.test(text)) matches.push(name);
  }
  return matches;
}

/**
 * Generates the real draft body for a content piece that was scaffolded at
 * brief-accept time, and promotes it from "brief" to "draft".
 *
 * A plain exported module, not a server action — both `after()` (on accept)
 * and a human-triggered Generate/retry button call this, and it has to be
 * testable without mocking Next internals.
 *
 * Never throws: every code path — the lookups, context prep, the generator
 * call, and both writes — is covered by an outer `try`/`catch`, so any DB or
 * generator failure resolves to `{ ok: false }` rather than rejecting the
 * caller's promise. Even the failure-recording write itself is guarded: if
 * writing `generationError` after a thrown generation fails too, that second
 * failure is logged and swallowed rather than escaping in its place.
 *
 * Four properties this function is built around:
 *   1. A generation failure must cost the human nothing: the piece stays at
 *      "brief" with its scaffold body intact, so the accept decision survives
 *      and the Generate button can retry.
 *   2. The competitor-name scan WARNS, it never discards a draft. A false
 *      positive that threw away a good draft would be worse than the leak it
 *      guards against.
 *   3. A hand-edited body (`bodyEditedAt` set) is refused before the
 *      generator is ever called — regenerating over a human's own words is
 *      not a retry, it's data loss.
 *   4. Only a piece still at "brief" is a legitimate generation target —
 *      refused before the generator is ever called. Without this, a
 *      "published" or "archived" piece (whose `bodyEditedAt` is often still
 *      null) can be silently regenerated and demoted over content already
 *      dispatched to destinations.
 */
export async function generateDraftForPiece(
  contentPieceId: string,
  tenantId: string,
  deps: { database?: Database; generate?: DraftGenerator } = {}
): Promise<{ ok: true } | { ok: false; error: string }> {
  const database = deps.database ?? defaultDb;
  const generate = deps.generate ?? generateBriefDraft;

  try {
    const [piece] = await database
      .select()
      .from(contentPieces)
      .where(and(eq(contentPieces.id, contentPieceId), eq(contentPieces.tenantId, tenantId)));
    if (!piece) return { ok: false, error: "Content piece not found." };

    // Generation is only ever legitimate on an ungenerated piece. Without
    // this, a piece published straight from a generated draft has
    // `bodyEditedAt === null` (nothing was ever hand-edited), so it sails
    // through the check below — a stray retry or a racing `after()` then
    // rewrites its body and demotes it to "draft" over content already
    // dispatched to destinations. That flip also drops it out of
    // `history/page.tsx` (which filters on `status === "published"`) while
    // `deliveryAttempts` rows keep pointing at a body that no longer exists.
    // "archived" pieces from `rejectDraft` are exposed the same way. This
    // also closes a second bug: a retry that throws on a "draft" piece would
    // otherwise write a failure message into a row whose status makes the UI
    // render it as the amber competitor-name warning.
    if (piece.status !== "brief") {
      return { ok: false, error: `This piece is not awaiting generation (status: ${piece.status}).` };
    }

    // Must happen before the generator is ever invoked — a retry must never
    // clobber words a human already typed.
    if (piece.bodyEditedAt) {
      return { ok: false, error: "This draft has been edited by hand." };
    }

    const [brief] = await database
      .select()
      .from(briefs)
      .where(and(eq(briefs.contentPieceId, piece.id), eq(briefs.tenantId, tenantId)));

    // Every piece this function runs on was created by accepting a brief, so
    // a missing link is a data-integrity anomaly, not a legitimate input —
    // refuse rather than synthesizing a thin, ungrounded commission from the
    // scaffold and silently flipping the piece to "draft" anyway.
    if (!brief) return { ok: false, error: "No brief is linked to this piece." };

    const briefForPrompt: BriefForPrompt = {
      title: brief.title,
      angle: brief.angle,
      whyNow: brief.whyNow,
      keyPoints: brief.keyPoints,
      contentType: brief.contentType,
      targetLength: brief.targetLength,
    };
    const evidence: BriefEvidenceForPrompt[] = await database
      .select({ title: signals.title, kind: signals.kind, excerpt: signals.excerpt })
      .from(briefSignals)
      .innerJoin(signals, eq(briefSignals.signalId, signals.id))
      .where(eq(briefSignals.briefId, brief.id));

    // Built from the PIECE's own type, so a blog_post piece gets blog-post
    // few-shot examples (the brief's content type and the piece's are
    // expected to match). This only selects examples, though — the system
    // prompt's role line and format/length guidance come from
    // `brief.contentType` inside `composeBriefPrompt`, not from this value.
    const { brandProfile, personas, examples } = await prepareGenerationContext(tenantId, database, [], piece.type);

    // Written BEFORE the model call, not after. `generationError: null` on a
    // "brief" piece is otherwise ambiguous between "generation hasn't run
    // yet" and "generation ran and was cut off mid-callback" (a function
    // timeout or worker recycle) — this marker makes an interrupted attempt
    // visibly interrupted instead of indistinguishable from untouched. A
    // successful run below overwrites it with `null` or the competitor
    // warning; the catch block overwrites it with the real failure reason.
    await database
      .update(contentPieces)
      .set({ generationError: "Generation was interrupted before it finished. Retry to try again." })
      .where(eq(contentPieces.id, contentPieceId));

    let result: { title: string; body: string };
    try {
      result = await generate({ brief: briefForPrompt, evidence, brandProfile, personas, examples });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      try {
        await database
          .update(contentPieces)
          .set({ generationError: message })
          .where(eq(contentPieces.id, contentPieceId));
      } catch (writeError) {
        console.error(
          `[briefs/draft] failed to record generation error for piece ${contentPieceId}:`,
          writeError
        );
      }
      return { ok: false, error: message };
    }

    // This only scans for names already saved in this tenant's competitors
    // list, not for any company — the system prompt forbids naming ANY
    // company, but a publication, an unlisted competitor, or a product brand
    // passes this check clean. The message below says so explicitly so a
    // clean pass doesn't read as "no company named".
    const competitorNames = (await listCompetitors(tenantId, database)).map((c) => c.name);
    const matches = findNamedCompanies(`${result.title}\n${result.body}`, competitorNames);
    const generationError =
      matches.length > 0
        ? `This draft may name a company from your competitors list: ${matches.join(", ")}. This only checks names on that list, not every company — review before publishing.`
        : null;

    await database
      .update(contentPieces)
      .set({
        title: result.title,
        body: result.body,
        status: "draft",
        generatedAt: new Date(),
        generationError,
      })
      .where(eq(contentPieces.id, contentPieceId));

    return { ok: true };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[briefs/draft] generateDraftForPiece failed for piece ${contentPieceId}:`, e);
    return { ok: false, error: message };
  }
}
