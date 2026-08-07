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
 * Scans `text` for any of `names` as a whole word, case-insensitively. Used to
 * warn (never to block — see `generateDraftForPiece`) when a generated draft
 * slips a competitor's name into the copy despite the system prompt telling it
 * not to.
 *
 * Word-boundary matching, not `includes`: a competitor named "Lilt" must not
 * match inside "quilted", and "Posit" must not match inside "Deposit". Each
 * name is escaped before being spliced into the regex so a name containing
 * regex metacharacters (e.g. "C++") can't corrupt the pattern.
 */
export function findNamedCompanies(text: string, names: string[]): string[] {
  const matches: string[] = [];
  for (const name of names) {
    if (name.length < MIN_COMPETITOR_NAME_LENGTH) continue;
    const pattern = new RegExp(`\\b${escapeForRegExp(name)}\\b`, "i");
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
 * Three properties this function is built around:
 *   1. A generation failure must cost the human nothing: the piece stays at
 *      "brief" with its scaffold body intact, so the accept decision survives
 *      and the Generate button can retry.
 *   2. The competitor-name scan WARNS, it never discards a draft. A false
 *      positive that threw away a good draft would be worse than the leak it
 *      guards against.
 *   3. A hand-edited body (`bodyEditedAt` set) is refused before the
 *      generator is ever called — regenerating over a human's own words is
 *      not a retry, it's data loss.
 */
export async function generateDraftForPiece(
  contentPieceId: string,
  tenantId: string,
  deps: { database?: Database; generate?: DraftGenerator } = {}
): Promise<{ ok: true } | { ok: false; error: string }> {
  const database = deps.database ?? defaultDb;
  const generate = deps.generate ?? generateBriefDraft;

  const [piece] = await database
    .select()
    .from(contentPieces)
    .where(and(eq(contentPieces.id, contentPieceId), eq(contentPieces.tenantId, tenantId)));
  if (!piece) return { ok: false, error: "Content piece not found." };

  // Must happen before the generator is ever invoked — a retry must never
  // clobber words a human already typed.
  if (piece.bodyEditedAt) {
    return { ok: false, error: "This draft has been edited by hand." };
  }

  const [brief] = await database
    .select()
    .from(briefs)
    .where(and(eq(briefs.contentPieceId, piece.id), eq(briefs.tenantId, tenantId)));

  let briefForPrompt: BriefForPrompt;
  let evidence: BriefEvidenceForPrompt[] = [];

  if (brief) {
    briefForPrompt = {
      title: brief.title,
      angle: brief.angle,
      whyNow: brief.whyNow,
      keyPoints: brief.keyPoints,
      contentType: brief.contentType,
      targetLength: brief.targetLength,
    };
    evidence = await database
      .select({ title: signals.title, kind: signals.kind, excerpt: signals.excerpt })
      .from(briefSignals)
      .innerJoin(signals, eq(briefSignals.signalId, signals.id))
      .where(eq(briefSignals.briefId, brief.id));
  } else {
    // No linked brief (should not happen for a piece created via accept, but
    // this function must not throw over it) — fall back to what the piece
    // itself already carries.
    briefForPrompt = {
      title: piece.title,
      angle: piece.body,
      whyNow: "",
      keyPoints: [],
      contentType: piece.type,
      targetLength: null,
    };
  }

  // Built from the PIECE's own type, so a blog_post piece gets blog-post
  // examples and system prompt even if (in the fallback case above) there is
  // no brief to read it from.
  const { brandProfile, personas, examples } = await prepareGenerationContext(tenantId, database, [], piece.type);

  let result: { title: string; body: string };
  try {
    result = await generate({ brief: briefForPrompt, evidence, brandProfile, personas, examples });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await database.update(contentPieces).set({ generationError: message }).where(eq(contentPieces.id, contentPieceId));
    return { ok: false, error: message };
  }

  const competitorNames = (await listCompetitors(tenantId, database)).map((c) => c.name);
  const matches = findNamedCompanies(`${result.title}\n${result.body}`, competitorNames);
  const generationError = matches.length > 0 ? `Draft may reference a competitor: ${matches.join(", ")}.` : null;

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
}
