import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import {
  atomicUpdates,
  changeEvents,
  contentPieces,
  briefs,
  briefSignals,
  signals,
  type companyProfiles,
  type systemContentExamples,
  type ResolvedPersona,
} from "@/db/schema";
import type {
  AtomicUpdateForPrompt,
  BriefForPrompt,
  BriefEvidenceForPrompt,
} from "@/lib/ai/compose-prompt";
import { generateBriefDraft, generateReleaseDraft } from "@/lib/ai/generation";
import { briefBody } from "@/lib/briefs/body";
import { prepareGenerationContext } from "@/lib/ai/generation-context";
import { reviewAndReconcile, type ReviewOutcome } from "@/lib/ai/review-draft";
import { validateDraftLinks, type LinkCheck } from "@/lib/ai/validate-links";
import { linkAtomicUpdatesToPiece } from "@/lib/change-events/release-claim";
import { listCompetitors } from "@/lib/workspace/competitors";
import type { DraftStepKey } from "@/lib/drafting/draft-progress";
import { illustratePiece, type IllustrateResult } from "@/lib/images/illustrate";
import type { ContentType } from "@/lib/ai/compose-prompt";

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

/** `generateReleaseDraft`'s shape, as a seam. Positional, matching it exactly. */
export type ReleaseDraftGenerator = (
  items: AtomicUpdateForPrompt[],
  brandProfile: BrandProfileRow,
  personas: ResolvedPersona[],
  examples: ExampleRow[],
  evidence: BriefEvidenceForPrompt[],
  template: string | null
) => Promise<{ title: string; body: string }>;

/** `reviewAndReconcile`'s shape, as a seam. */
export type DraftReviewer = (
  draft: { title: string; body: string },
  brandProfile: BrandProfileRow,
  template: string | null
) => Promise<ReviewOutcome>;

/** `illustratePiece`'s shape, as a seam. */
export type Illustrator = (args: {
  tenantId: string;
  contentPieceId: string;
  title: string;
  body: string;
  contentType: ContentType;
  database?: Database;
}) => Promise<IllustrateResult>;

/**
 * The atomic updates a brief's `shipped_work` signals stand for, re-derived
 * server-side from the brief's own citations. No id reaches this path from a
 * client — the now-retired `/api/atomic-updates/draft` route took a list of ids
 * from the browser and had to intersect it with `getOpenAtomicUpdates` to make
 * it safe; deriving from `brief_signals` removes the untrusted input entirely.
 *
 * Both tenant predicates are load-bearing and separate: a signal is this
 * tenant's, but `signals.atomicUpdateId` is a plain FK that a bad or migrated
 * row could point across the boundary, so the atomic update must be scoped on
 * its own account too.
 *
 * `status = 'open'` + `contentPieceId IS NULL` are exactly
 * `getOpenAtomicUpdates`'s compose-candidate predicates, kept because the
 * signal for an already-composed atomic update stays live (see
 * `syncShippedWorkSignals`) and can be cited by a later brief. Without them
 * this draft would relink shipped work out of the piece already carrying it.
 */
async function loadShippedWorkAtomicUpdates(
  database: Database,
  tenantId: string,
  briefId: string
): Promise<AtomicUpdateForPrompt[]> {
  const rows = await database
    .select({
      id: atomicUpdates.id,
      title: atomicUpdates.title,
      summary: atomicUpdates.summary,
      category: atomicUpdates.category,
      size: atomicUpdates.size,
      sizeEditedAt: atomicUpdates.sizeEditedAt,
      // MAX(COALESCE(...)) across every change event linked to this atomic
      // update — the most recent real-world date among its evidence, which is
      // what dates the template's {month}/{year}. The same aggregate
      // `syncShippedWorkSignals` uses; see its comment for why the type is
      // loose: a raw `sql<>` aggregate is NOT decoded through drizzle's column
      // mapper, so the driver can hand back a string rather than a `Date`.
      latestEvidenceAt: sql<Date | string | null>`max(coalesce(${changeEvents.mergedAt}, ${changeEvents.committedAt}, ${changeEvents.completedAt}, ${changeEvents.releasedAt}))`,
    })
    .from(briefSignals)
    .innerJoin(signals, eq(briefSignals.signalId, signals.id))
    .innerJoin(atomicUpdates, eq(signals.atomicUpdateId, atomicUpdates.id))
    // Tenant-scoped on its own account, not just via the atomic update.
    // `changeEvents.atomicUpdateId` is a plain FK exactly like
    // `signals.atomicUpdateId` above, so a bad or migrated row could point
    // across the boundary and drag another tenant's date into this one's
    // {month}/{year}. Same standard, same guard.
    .leftJoin(
      changeEvents,
      and(eq(changeEvents.atomicUpdateId, atomicUpdates.id), eq(changeEvents.tenantId, tenantId))
    )
    .where(
      and(
        eq(briefSignals.briefId, briefId),
        eq(signals.kind, "shipped_work"),
        eq(signals.tenantId, tenantId),
        eq(atomicUpdates.tenantId, tenantId),
        eq(atomicUpdates.status, "open"),
        isNull(atomicUpdates.contentPieceId)
      )
    )
    // Forced by the aggregate above: every non-aggregated selected column has
    // to be grouped. The join also multiplies rows per change event, so without
    // this an atomic update with three change events would reach the prompt
    // three times.
    .groupBy(
      atomicUpdates.id,
      atomicUpdates.title,
      atomicUpdates.summary,
      atomicUpdates.category,
      atomicUpdates.size,
      atomicUpdates.sizeEditedAt,
      atomicUpdates.createdAt
    )
    // Same-batch atomic updates share createdAt; tie-break on id so the
    // prompt's item order is deterministic (as `getOpenAtomicUpdates` does).
    .orderBy(asc(atomicUpdates.createdAt), asc(atomicUpdates.id));

  return rows.map((row) => ({
    ...row,
    // Normalized here, once, so nothing downstream has to know the aggregate
    // lies about its type.
    latestEvidenceAt: row.latestEvidenceAt ? new Date(row.latestEvidenceAt) : null,
  }));
}

// Names shorter than this match almost anything ("Ax", "Go") and would flag
// nearly every draft — skipping them is deliberate, not an oversight. See
// `findNamedCompanies`.
export const MIN_COMPETITOR_NAME_LENGTH = 3;

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Records which step is in flight so the client's checklist can poll it.
 * Never throws: progress is cosmetic, and a failed progress write must not
 * abort a generation that is otherwise fine. Passing null clears it.
 */
async function setStep(
  database: Database,
  contentPieceId: string,
  step: DraftStepKey | null
): Promise<void> {
  try {
    await database
      .update(contentPieces)
      .set({ generationStep: step })
      .where(eq(contentPieces.id, contentPieceId));
  } catch (e) {
    console.error(`[briefs/draft] failed to record step ${step} for piece ${contentPieceId}:`, e);
  }
}

/**
 * The step a piece carries between "generation was scheduled" and
 * "`generateDraftForPiece` actually started running". It is the first real
 * step, not a synthetic one, so the checklist renders it exactly as it would
 * a moment later.
 */
export const GENERATION_QUEUED_STEP: DraftStepKey = "collecting";

/**
 * Marks a piece as generating BEFORE the work is scheduled, so the server
 * state is already true by the time the scheduling action returns.
 *
 * Without this there is a window — the whole of it a coin flip — between an
 * action returning and `generateDraftForPiece` writing its first step inside
 * `after()`. Any render that lands in that window reads `generationStep` as
 * null and shows an ungenerated brief: on `/drafts/[id]` after an accept, that
 * meant "Awaiting generation" plus a live Generate button for the entire run,
 * one click away from a second overlapping generation. Closing it here rather
 * than with a client-side "I just started one" flag is what makes the fix
 * survive a reload, apply to every surface at once, and keep the narrow
 * `generationStep !== null` mount gate sufficient.
 *
 * The predicates are `generateDraftForPiece`'s own first three guards, and
 * they are why this is an UPDATE with a WHERE rather than a blind write:
 *
 *   - `tenantId` — the security boundary, in the WHERE as always. The id
 *     arrives from a URL.
 *   - `status = 'brief'` — the only legitimate generation target.
 *   - `bodyEditedAt IS NULL` — a hand-edited body is never regenerated.
 *
 * A blind write would stamp "collecting" onto a published or hand-edited piece
 * that `generateDraftForPiece` then refuses without clearing, stranding it
 * displaying a step nothing is running. Matching zero rows instead means an
 * ineligible piece is never marked at all, and the caller learns it was
 * refused synchronously — which is also what lets `generateDraft` report the
 * refusal to the user again instead of swallowing it into a background log.
 *
 * Returns whether the piece was claimed.
 */
export async function queueGeneration(
  contentPieceId: string,
  tenantId: string,
  database: Database = defaultDb
): Promise<boolean> {
  const queued = await database
    .update(contentPieces)
    .set({ generationStep: GENERATION_QUEUED_STEP })
    .where(
      and(
        eq(contentPieces.id, contentPieceId),
        eq(contentPieces.tenantId, tenantId),
        eq(contentPieces.status, "brief"),
        isNull(contentPieces.bodyEditedAt)
      )
    )
    .returning({ id: contentPieces.id });
  return queued.length > 0;
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
 * THE ONE ENTRY POINT for turning evidence into a draft. It forks on
 * `brief.contentType`:
 *
 *   product_update + ≥1 composable shipped_work signal -> release composition
 *   product_update, no such signal                     -> generic brief draft
 *   blog_post / social_post, any evidence              -> generic brief draft
 *
 * The release branch is the old `/api/atomic-updates/draft` pipeline —
 * `generateReleaseDraft` against the tenant's product update template,
 * `reviewAndReconcile`, `validateDraftLinks` — reached from here rather than
 * from a parallel route, because atomic updates are signals, including for
 * drafting. (It carried category-biased few-shot examples until the template
 * replaced them as the structural exemplar.)
 *
 * `generationStep` is cleared on EVERY exit. There are eight:
 *   1. piece not found              — no row exists to carry a step
 *   2. piece not at "brief"         — explicit clear (see `queueGeneration`)
 *   3. body hand-edited             — explicit clear (same reason)
 *   4. no brief linked              — explicit clear ("collecting" is already set)
 *   5. generation/review failure    — cleared in the generationError write
 *   6. success, generic branch      — cleared in the body write
 *   7. success, release branch      — same `draftWrite` literal, inside the tx
 *   8. outer catch                  — cleared in its generationError write
 * The interrupted-generation marker is not an exit: it SETS "generating".
 * "illustrating" is written after review on both branches and is not an
 * exit either: the illustration pass can only warn (see the block above
 * `setStep("saving")`), never fail the draft.
 * The release branch's zero-link throw (see the transaction) is not a ninth
 * exit — it rolls the transaction back and lands in 8 like any other throw.
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
  deps: {
    database?: Database;
    generate?: DraftGenerator;
    generateRelease?: ReleaseDraftGenerator;
    review?: DraftReviewer;
    checkLink?: LinkCheck;
    illustrate?: Illustrator;
  } = {}
): Promise<{ ok: true } | { ok: false; error: string }> {
  const database = deps.database ?? defaultDb;
  const generate = deps.generate ?? generateBriefDraft;
  const generateRelease = deps.generateRelease ?? generateReleaseDraft;
  const review = deps.review ?? reviewAndReconcile;
  const illustrate = deps.illustrate ?? illustratePiece;

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
    //
    // Clears the step on the way out. These two guards used to return before
    // any step had been written, so there was nothing to clear — that stopped
    // being true when `queueGeneration` started marking the piece BEFORE this
    // function runs. `queueGeneration`'s WHERE already refuses an ineligible
    // piece, so in practice it never marks one that lands here; this covers
    // the narrow case where the piece changed status (a publish, a reject)
    // between that write and this read, and the standing invariant that every
    // exit clears the step is worth holding literally rather than by argument.
    if (piece.status !== "brief") {
      await setStep(database, contentPieceId, null);
      return { ok: false, error: `This piece is not awaiting generation (status: ${piece.status}).` };
    }

    // Must happen before the generator is ever invoked — a retry must never
    // clobber words a human already typed.
    if (piece.bodyEditedAt) {
      await setStep(database, contentPieceId, null);
      return { ok: false, error: "This draft has been edited by hand." };
    }

    await setStep(database, contentPieceId, "collecting");

    const [brief] = await database
      .select()
      .from(briefs)
      .where(and(eq(briefs.contentPieceId, piece.id), eq(briefs.tenantId, tenantId)));

    // Every piece this function runs on was created by accepting a brief, so
    // a missing link is a data-integrity anomaly, not a legitimate input —
    // refuse rather than synthesizing a thin, ungrounded commission from the
    // scaffold and silently flipping the piece to "draft" anyway.
    //
    // Unlike the three guards above, "collecting" was already written before
    // this check runs — clear it before returning, or the piece is left
    // permanently displaying a step that is no longer in flight.
    if (!brief) {
      await setStep(database, contentPieceId, null);
      return { ok: false, error: "No brief is linked to this piece." };
    }

    // Through the accessor, never from the fields directly: `briefs.body` is
    // the source of truth once anything has written it, and it is what a human
    // edits. Re-rendering from `angle`/`whyNow`/`keyPoints` here would look
    // identical for an unedited brief and silently discard every edit — the
    // exact failure this indirection exists to prevent.
    const briefForPrompt: BriefForPrompt = {
      title: brief.title,
      body: briefBody(brief),
      contentType: brief.contentType,
      targetLength: brief.targetLength,
    };
    const evidence: BriefEvidenceForPrompt[] = await database
      .select({ title: signals.title, kind: signals.kind, excerpt: signals.excerpt })
      .from(briefSignals)
      .innerJoin(signals, eq(briefSignals.signalId, signals.id))
      .where(eq(briefSignals.briefId, brief.id));

    // THE FORK. `brief.contentType` — what the author chose — selects the
    // release composition. NOT "the evidence is all shipped work": deriving the
    // branch from evidence would give a blog post built from shipped work
    // changelog treatment, which is exactly what `buildSystemPrompt`'s prompt
    // fork exists to prevent.
    //
    // A product_update brief with NO shipped work has no atomic updates to
    // compose from and falls through to the generic path rather than erroring.
    // That is a real case, not a defect: a manually created product-update
    // brief citing only news.
    const releaseItems =
      brief.contentType === "product_update"
        ? await loadShippedWorkAtomicUpdates(database, tenantId, brief.id)
        : [];
    const isRelease = releaseItems.length > 0;

    // Only `shipped_work` signals supply atomic updates. The rest of the
    // brief's evidence still reaches the release prompt as context — nothing is
    // silently dropped — but the shipped-work signals themselves are excluded:
    // they ARE `releaseItems`, and sending both would be the same material
    // twice, once as a change to announce and once as background.
    const releaseContext = evidence.filter((item) => item.kind !== "shipped_work");

    // Generic path: built from the PIECE's own type, so a blog_post piece gets
    // blog-post few-shot examples (the brief's content type and the piece's are
    // expected to match). This only selects examples, though — the system
    // prompt's role line and format/length guidance come from
    // `brief.contentType` inside `composeBriefPrompt`, not from this value.
    //
    // Release path: pinned to "product_update" (which is what the fork above
    // already established the BRIEF asks for). Pinning rather than reusing
    // `piece.type` means a piece whose type has drifted from its brief's still
    // can't pull blog exemplars into a changelog composition. The categories
    // bias that used to sit here went with the release path's few-shot
    // examples — the tenant's own template is the structural exemplar now.
    await setStep(database, contentPieceId, "preparing");
    const { brandProfile, personas, examples } = await prepareGenerationContext(
      tenantId,
      database,
      isRelease ? "product_update" : piece.type
    );

    // Written BEFORE the model call, not after. `generationError: null` on a
    // "brief" piece is otherwise ambiguous between "generation hasn't run
    // yet" and "generation ran and was cut off mid-callback" (a function
    // timeout or worker recycle) — this marker makes an interrupted attempt
    // visibly interrupted instead of indistinguishable from untouched. A
    // successful run below overwrites it with `null` or the competitor
    // warning; the catch block overwrites it with the real failure reason.
    await database
      .update(contentPieces)
      .set({
        generationError: "Generation was interrupted before it finished. Retry to try again.",
        generationStep: "generating",
      })
      .where(eq(contentPieces.id, contentPieceId));

    let result: { title: string; body: string };
    // Non-null only on the release path, which is the only one with a review
    // pass to record.
    let reviewOutcome: ReviewOutcome | null = null;
    try {
      if (isRelease) {
        // One retry before giving up, as the retiring compose run had. Both
        // attempts failing lands in the same catch below as any other
        // generation failure: the piece stays at "brief" with its scaffold, and
        // the atomic updates stay open for the next attempt.
        //  The tenant's product update template, or null when they have none
        //  (every tenant that has not re-imported). Read from the profile the
        //  context prep already loaded rather than re-queried.
        const template = brandProfile.productUpdateTemplate;
        let draft: { title: string; body: string };
        try {
          draft = await generateRelease(releaseItems, brandProfile, personas, examples, releaseContext, template);
        } catch {
          draft = await generateRelease(releaseItems, brandProfile, personas, examples, releaseContext, template);
        }

        // The one step key the generic path never writes, because it has no
        // review pass. The client renders the full DRAFT_STEPS list and marks
        // everything before the stored key as done, so a path that skips a step
        // is fine — this is what makes "reviewing" real.
        await setStep(database, contentPieceId, "reviewing");

        // The RAW template, not the substituted one the composer got.
        //
        // The reviewer is checking shape, and the two versions differ only in
        // the reserved counts and dates — `fillTemplate` leaves every
        // description brace alone. Baking one release's numbers into a
        // structural check is what misfires: a reviewer shown the literal
        // "7 updates in August" starts checking whether the draft says seven,
        // which is a content judgement the composer already made.
        //
        // Raw also gives the reviewer the one comparison that catches this
        // system's worst failure — a template's own brace published verbatim.
        // Seeing `{main feature}` in the template and `{main feature}` in the
        // draft is unmistakable.
        reviewOutcome = await review(draft, brandProfile, template);

        // Validate links on the FINAL body — after review, which may itself
        // rewrite links — so no unresolvable URL is persisted.
        const { body } = await validateDraftLinks(reviewOutcome.finalDraft.body, deps.checkLink);
        result = { title: reviewOutcome.finalDraft.title, body };
      } else {
        result = await generate({ brief: briefForPrompt, evidence, brandProfile, personas, examples });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      try {
        await database
          .update(contentPieces)
          .set({ generationError: message, generationStep: null })
          .where(eq(contentPieces.id, contentPieceId));
      } catch (writeError) {
        console.error(
          `[briefs/draft] failed to record generation error for piece ${contentPieceId}:`,
          writeError
        );
      }
      return { ok: false, error: message };
    }

    // Only product updates are scanned, because only they still forbid naming
    // another company. Blog and social posts were allowed to name companies on
    // 2026-08-06 — warning about a name the prompt explicitly permits would
    // train the reader to ignore the banner, which is worse than not showing it.
    //
    // Still only the tenant's saved competitors list, not every company: a
    // publication, an unlisted competitor or a product brand passes clean. The
    // message says so, so a clean pass does not read as "no company named".
    const scanned = piece.type === "product_update";
    const matches = scanned
      ? findNamedCompanies(
          `${result.title}\n${result.body}`,
          (await listCompetitors(tenantId, database)).map((c) => c.name)
        )
      : [];
    const warnings: string[] = [];
    if (matches.length > 0) {
      warnings.push(
        `This product update may name a company from your competitors list: ${matches.join(", ")}. This only checks names on that list, not every company — review before publishing.`
      );
    }

    // The illustration agent (spec 2026-08-18 §4). Runs on BOTH branches, on
    // the final reviewed body, and blocks draft readiness on purpose: the body
    // is one text column with hand-edit-freeze semantics, so splicing images
    // in after the save would race the human's first edit.
    //
    // Outside the inner try above, deliberately: a thrown plan call or a DB
    // hiccup inside the agent is a WARNING on a real draft, never a failed
    // generation — the words are done and the human should get them.
    //
    // Failed renders are deliberately NOT added to generationError: their rows
    // stay `failed` and the draft page's failed-images notice (Task 7) shows a
    // live count with Retry. A banner copy of the count would go stale the
    // moment a Retry succeeds (generationError only clears on the next
    // body-changing save) and would mark the board card "Flagged copy" for a
    // problem that has nothing to do with the copy.
    // Everything after `result` was set — including the writes below — is
    // still covered by the outer catch for genuine failures.
    await setStep(database, contentPieceId, "illustrating");
    try {
      const illustrated = await illustrate({
        tenantId,
        contentPieceId,
        title: result.title,
        body: result.body,
        contentType: piece.type,
        database,
      });
      result = { title: result.title, body: illustrated.body };
    } catch (e) {
      console.error(`[briefs/draft] illustration failed for piece ${contentPieceId}:`, e);
      warnings.push("Images could not be generated. The draft is complete without them.");
    }

    const generationError = warnings.length > 0 ? warnings.join(" ") : null;

    await setStep(database, contentPieceId, "saving");

    // One timestamp for the body write AND the atomic-update link below — see
    // `composedAt` in the release branch.
    const savedAt = new Date();
    const draftWrite = {
      title: result.title,
      body: result.body,
      status: "draft" as const,
      generatedAt: savedAt,
      generationError,
      generationStep: null,
    };

    if (isRelease) {
      // The link MUST be transactional with the body write. A piece saved with
      // a body while its atomic updates stayed `open` would offer the same
      // shipped work to the next compose run and ship it twice.
      await database.transaction(async (tx) => {
        await tx
          .update(contentPieces)
          .set({
            ...draftWrite,
            // `composedAt` was stamped when the brief was accepted, which is
            // BEFORE this link. Left there, `computeReleaseDelta`'s strict
            // `updatedAt > composedAt` reads every atomic update linked here as
            // a post-compose change — a catch-up banner on a brand-new draft.
            // The link below stamps `updatedAt` with this same value, so the
            // strict `>` correctly excludes them.
            composedAt: savedAt,
            ...(reviewOutcome
              ? {
                  reviewStatus: reviewOutcome.status,
                  reviewIssues: reviewOutcome.issues,
                  reviewedAt: savedAt,
                }
              : {}),
          })
          .where(eq(contentPieces.id, contentPieceId));

        const linked = await linkAtomicUpdatesToPiece(
          {
            tenantId,
            contentPieceId,
            atomicUpdateIds: releaseItems.map((item) => item.id),
            at: savedAt,
          },
          tx
        );

        // Zero linked rows means EVERY atomic update this draft was composed
        // from was claimed by somebody else between the derivation at the top
        // of this function and this write — a window of tens of seconds, the
        // whole generate + review round trip. The competing writers are real:
        // `runIdeationUnsafe` feeds the same in-window signal to every run and
        // nothing marks a signal `used` on accept, so two accepted
        // product_update briefs can cite the same `shipped_work` signal; and
        // `catch-up.ts`'s `linkNewAtomicUpdates` claims the same rows with the
        // same drop-don't-steal predicates.
        //
        // Saving anyway would leave a finished-looking product update
        // announcing shipped work it does not own — the same work announced
        // twice — and `markReleaseAtomicUpdatesReleased` (which matches on
        // `contentPieceId`) would hit 0 rows at publish, stranding those atomic
        // updates in `open` forever. This throw rolls the whole transaction
        // back, which is what the retired `claimReleaseFromAtomicUpdates`'s
        // `EmptyClaimError` did. The piece stays at "brief" with its scaffold
        // and is retriable; a retry re-derives nothing (the rows now fail
        // `contentPieceId IS NULL`) and falls through to the generic branch.
        if (linked === 0) {
          throw new Error("No changes were available to draft.");
        }

        // A PARTIAL link is not the same failure and must not throw: the rows
        // that did link are legitimately this piece's, and rolling them back
        // would throw away a good draft over work that was never ours. But it
        // must not be silent either — the draft now announces fewer changes
        // than it was composed from.
        if (linked < releaseItems.length) {
          console.error(
            `[briefs/draft] piece ${contentPieceId}: only ${linked} of ${releaseItems.length} atomic updates linked; the rest were claimed elsewhere mid-generation`
          );
        }
      });
    } else {
      await database.update(contentPieces).set(draftWrite).where(eq(contentPieces.id, contentPieceId));
    }

    return { ok: true };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[briefs/draft] generateDraftForPiece failed for piece ${contentPieceId}:`, e);
    // Write the REAL reason, exactly as the inner catch does. Everything
    // outside the inner try — `listCompetitors`, the final write, the
    // transaction and its zero-link throw — lands here, and the piece is still
    // carrying the interrupted-generation marker written before the model call.
    // Leaving that in place told the user "Generation was interrupted before it
    // finished" for a failure that was nothing of the sort, while the actual
    // cause went only to the console. Still clears `generationStep` — every
    // exit must, this one included.
    //
    // Wrapped, like the inner one: if this write itself fails, that second
    // failure must not escape in place of the first.
    try {
      await database
        .update(contentPieces)
        .set({ generationError: message, generationStep: null })
        .where(eq(contentPieces.id, contentPieceId));
    } catch (writeError) {
      console.error(
        `[briefs/draft] failed to record generation error for piece ${contentPieceId}:`,
        writeError
      );
    }
    return { ok: false, error: message };
  }
}
