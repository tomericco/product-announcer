import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { aiVisibilityPrompts, aiVisibilitySamples, type AiVisibilityPrompt } from "@/db/schema";
import { isUniqueViolation } from "@/db/errors";
import { PROMPT_INTENTS, type PromptIntent } from "@/lib/ai-visibility/types";

/**
 * The hard ceiling on prompts a run may ask.
 *
 * This is the cost dial, not a tidiness rule: 30 prompts × 4 engines × 3
 * samples is ~360 calls a week, which is the $20/tenant/month target. Raising
 * it raises the bill linearly. Proposals and paused prompts do NOT count —
 * neither costs anything until a human activates it.
 */
export const MAX_ACTIVE_PROMPTS = 30;

/** Long enough for a real buyer question, short enough that the bad-prompt check has teeth. */
export const MAX_PROMPT_CHARS = 300;

export type PromptStatus = "proposed" | "active" | "paused" | "rejected";
export type PromptOrigin = "generated" | "user";

export type PromptFilters = {
  status?: PromptStatus | PromptStatus[];
  intent?: PromptIntent;
  persona?: string;
  competitorId?: string;
};

export type CreatePromptInput = {
  text: string;
  intent: PromptIntent;
  persona?: string | null;
  competitorId?: string | null;
  branded?: boolean;
  origin?: PromptOrigin;
  cluster?: string | null;
  /** `active` for a hand-added prompt, `proposed` for a generated suggestion. */
  status?: "proposed" | "active";
  flagReason?: string | null;
};

export type CreatePromptResult =
  | { ok: true; prompt: AiVisibilityPrompt }
  | { ok: false; error: "cap" | "duplicate" | "invalid" };

/**
 * The one place prompt text is cleaned, so the unique index sees a stable key.
 *
 * Whitespace is collapsed before storage because "best  trackers" and "best
 * trackers" are the same question to every engine, and storing both would
 * split one prompt's history in two while passing the unique index.
 *
 * Case is deliberately NOT folded here. "Best issue trackers" is the same
 * question as "best issue trackers" and must not become a second prompt, but
 * that is enforced by the unique index on `textNormalized`, not by rewriting
 * what the human typed — a prompt list that silently lowercases the tenant's
 * own capitalisation looks broken.
 */
export function normalizePromptText(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.replace(/\s+/g, " ").trim();
  if (text.length < 3 || text.length > MAX_PROMPT_CHARS) return null;
  return text;
}

function isIntent(value: string): value is PromptIntent {
  return (PROMPT_INTENTS as readonly string[]).includes(value);
}

export async function listPrompts(
  tenantId: string,
  filters: PromptFilters = {},
  database: typeof defaultDb = defaultDb
): Promise<AiVisibilityPrompt[]> {
  const conditions = [eq(aiVisibilityPrompts.tenantId, tenantId)];

  if (filters.status !== undefined) {
    const statuses = Array.isArray(filters.status) ? filters.status : [filters.status];
    // `inArray` with an empty list is not valid SQL, and "filter by nothing"
    // means nothing matches, not everything.
    if (statuses.length === 0) return [];
    conditions.push(inArray(aiVisibilityPrompts.status, statuses));
  }
  if (filters.intent) conditions.push(eq(aiVisibilityPrompts.intent, filters.intent));
  if (filters.persona) conditions.push(eq(aiVisibilityPrompts.persona, filters.persona));
  if (filters.competitorId) conditions.push(eq(aiVisibilityPrompts.competitorId, filters.competitorId));

  return database
    .select()
    .from(aiVisibilityPrompts)
    .where(and(...conditions))
    // Id breaks ties: a multi-row insert stamps one `now()` across the batch,
    // and the prompts editor must not reshuffle between renders.
    .orderBy(asc(aiVisibilityPrompts.createdAt), asc(aiVisibilityPrompts.id));
}

/** One prompt plus the row that replaced it, which is not a column on the prompt itself. */
export type PromptDetail = AiVisibilityPrompt & { supersededById: string | null };

/**
 * One prompt by id, for the detail page.
 *
 * `tenantId` first and in the WHERE clause, not checked afterwards: the id
 * comes out of a URL, and a scoped query cannot leak another workspace's
 * wording even by accident.
 *
 * Returns null for "no such prompt" and "not yours" alike, undistinguished —
 * the page turns either into `notFound()`, and telling the two apart would
 * confirm the existence of a row the caller may not see.
 */
export async function getPrompt(
  tenantId: string,
  promptId: string,
  database: typeof defaultDb = defaultDb
): Promise<PromptDetail | null> {
  const [prompt] = await database
    .select()
    .from(aiVisibilityPrompts)
    .where(and(eq(aiVisibilityPrompts.tenantId, tenantId), eq(aiVisibilityPrompts.id, promptId)))
    .limit(1);
  if (!prompt) return null;

  // The forward link. `supersedesId` points backwards, so a paused prompt has
  // no column saying what replaced it — this is the other half of "the detail
  // page links both ways".
  const [successor] = await database
    .select({ id: aiVisibilityPrompts.id })
    .from(aiVisibilityPrompts)
    .where(
      and(eq(aiVisibilityPrompts.tenantId, tenantId), eq(aiVisibilityPrompts.supersedesId, prompt.id))
    )
    .limit(1);

  return { ...prompt, supersededById: successor?.id ?? null };
}

export async function countActivePrompts(
  tenantId: string,
  database: typeof defaultDb = defaultDb
): Promise<number> {
  const [row] = await database
    .select({ value: count() })
    .from(aiVisibilityPrompts)
    .where(and(eq(aiVisibilityPrompts.tenantId, tenantId), eq(aiVisibilityPrompts.status, "active")));
  return row?.value ?? 0;
}

/**
 * Adds one prompt.
 *
 * The cap is checked with a read followed by a write, which is not atomic. Two
 * concurrent adds could therefore land at 31. Accepted: a workspace is a
 * handful of people who are not racing each other through this form, the
 * overshoot is one prompt, and `planRun` reads the active set again anyway. A
 * lock here would be the only lock in the codebase.
 */
export async function createPrompt(
  tenantId: string,
  input: CreatePromptInput,
  database: typeof defaultDb = defaultDb
): Promise<CreatePromptResult> {
  const text = normalizePromptText(input.text);
  if (text === null) return { ok: false, error: "invalid" };
  if (typeof input.intent !== "string" || !isIntent(input.intent)) return { ok: false, error: "invalid" };

  const status: "proposed" | "active" = input.status ?? "active";
  if (status === "active") {
    const active = await countActivePrompts(tenantId, database);
    if (active >= MAX_ACTIVE_PROMPTS) return { ok: false, error: "cap" };
  }

  const [row] = await database
    .insert(aiVisibilityPrompts)
    .values({
      tenantId,
      text,
      intent: input.intent,
      persona: input.persona ?? null,
      competitorId: input.competitorId ?? null,
      branded: input.branded ?? false,
      origin: input.origin ?? "user",
      status,
      cluster: input.cluster ?? null,
      flagReason: input.flagReason ?? null,
      approvedAt: status === "active" ? new Date() : null,
    })
    // The partial unique needs its own predicate repeated here, or Postgres
    // cannot tell which index the ON CONFLICT refers to.
    .onConflictDoNothing({
      target: [aiVisibilityPrompts.tenantId, aiVisibilityPrompts.textNormalized],
      where: sql`${aiVisibilityPrompts.status} <> 'rejected'`,
    })
    .returning();

  if (!row) return { ok: false, error: "duplicate" };
  return { ok: true, prompt: row };
}

export type ApproveProposalsInput = {
  approveIds: string[];
  rejectIds: string[];
  /** Wording the reviewer retyped in the suggestions section before approving. */
  edits?: { promptId: string; text: string }[];
  approvedBy?: string | null;
};

export type ApproveProposalsResult =
  | { ok: true; approved: number; rejected: number }
  | { ok: false; error: "cap"; available: number; requested: number }
  | { ok: false; error: "invalid" | "duplicate" };

/**
 * Commits one review of the suggestions section: approve the checked rows,
 * store the unchecked ones as rejected negatives, apply any inline edits.
 *
 * Batch with exclusions rather than one accept per row — thirty individual
 * accepts is the complaint the spec names (Peec). Rejected rows are kept, not
 * deleted: the next generation reads them as negatives, the same way brief
 * dismiss-reasons feed ideation.
 *
 * Edits are applied IN PLACE, deliberately unlike `editPrompt`. That
 * function's new-row-plus-supersede rule exists so a prompt's history stays
 * attached to the wording that produced it — and a `proposed` row has no
 * history, because nothing has ever run against it. Superseding here would
 * leave a paused ghost per typo fix, and rejecting-then-recreating would
 * poison the negatives feed with a prompt the human actually wanted.
 *
 * The cap is checked against the still-`proposed` slice of the batch before
 * anything is written — a re-submitted stale form full of already-active ids
 * no-ops instead of bouncing off a spurious cap error — and every write runs
 * in one transaction, so a batch that does not fit (or whose edits collide)
 * changes nothing at all rather than applying the first N.
 */
export async function approveProposals(
  tenantId: string,
  input: ApproveProposalsInput,
  database: typeof defaultDb = defaultDb
): Promise<ApproveProposalsResult> {
  const approveIds = [...new Set(input.approveIds)];
  // Approval wins if an id somehow arrives in both lists.
  const approveSet = new Set(approveIds);
  const rejectIds = [...new Set(input.rejectIds)].filter((id) => !approveSet.has(id));

  // Shape-validated before any write. A wording collision is caught by the
  // unique index inside the transaction below, which rolls the whole batch
  // back — neither kind of bad edit can half-apply a batch.
  const edits: { promptId: string; text: string }[] = [];
  for (const edit of input.edits ?? []) {
    if (!approveSet.has(edit.promptId)) continue;
    const text = normalizePromptText(edit.text);
    if (text === null) return { ok: false, error: "invalid" };
    edits.push({ promptId: edit.promptId, text });
  }

  if (approveIds.length > 0) {
    // Only rows still awaiting review count against the cap. A replayed
    // stale form (ids already active or rejected) falls through to the
    // status-guarded updates below and no-ops, instead of erroring here.
    const pending = await database
      .select({ id: aiVisibilityPrompts.id })
      .from(aiVisibilityPrompts)
      .where(
        and(
          eq(aiVisibilityPrompts.tenantId, tenantId),
          inArray(aiVisibilityPrompts.id, approveIds),
          eq(aiVisibilityPrompts.status, "proposed")
        )
      );
    if (pending.length > 0) {
      const active = await countActivePrompts(tenantId, database);
      const available = Math.max(MAX_ACTIVE_PROMPTS - active, 0);
      if (pending.length > available) {
        return { ok: false, error: "cap", available, requested: pending.length };
      }
    }
  }

  const now = new Date();
  try {
    // One transaction for the whole review: every edit, approval and
    // rejection lands, or none of them do.
    return await database.transaction(async (tx) => {
      // Rejections run FIRST, before the edits. A rejected row leaves the
      // partial unique index, so retyping an approved proposal into the
      // wording of one being turned down in the same batch is a legitimate
      // review — two near-duplicate suggestions, keep the better wording, drop
      // the other. Editing first would collide with a row this very batch is
      // about to take out of the index, and bounce the whole review.
      let rejected = 0;
      if (rejectIds.length > 0) {
        const rows = await tx
          .update(aiVisibilityPrompts)
          .set({ status: "rejected" })
          .where(
            and(
              eq(aiVisibilityPrompts.tenantId, tenantId),
              inArray(aiVisibilityPrompts.id, rejectIds),
              eq(aiVisibilityPrompts.status, "proposed")
            )
          )
          .returning({ id: aiVisibilityPrompts.id });
        rejected = rows.length;
      }

      for (const edit of edits) {
        await tx
          .update(aiVisibilityPrompts)
          .set({ text: edit.text })
          .where(
            and(
              eq(aiVisibilityPrompts.tenantId, tenantId),
              eq(aiVisibilityPrompts.id, edit.promptId),
              // Only a proposal may be rewritten in place.
              eq(aiVisibilityPrompts.status, "proposed")
            )
          );
      }

      let approved = 0;
      if (approveIds.length > 0) {
        const rows = await tx
          .update(aiVisibilityPrompts)
          .set({ status: "active", approvedAt: now, approvedBy: input.approvedBy ?? null, pausedAt: null })
          .where(
            and(
              eq(aiVisibilityPrompts.tenantId, tenantId),
              inArray(aiVisibilityPrompts.id, approveIds),
              // Re-submitting a stale form must not re-approve or resurrect
              // anything: only rows still awaiting review move.
              eq(aiVisibilityPrompts.status, "proposed")
            )
          )
          .returning({ id: aiVisibilityPrompts.id });
        approved = rows.length;
      }

      return { ok: true as const, approved, rejected };
    });
  } catch (error) {
    // Only a unique violation means what the user-facing "duplicate" says: the
    // partial unique index fired on an edit, because the reviewer retyped a
    // suggestion into the exact wording of a prompt they already have. Either
    // way the transaction rolled back, so nothing — not even the earlier edits
    // in the batch — was written.
    //
    // Everything else rethrows. A connection loss, a deadlock, a statement
    // timeout or a bug in here is not the reviewer's wording, and telling them
    // it is sends them to edit text that was never the problem.
    if (isUniqueViolation(error)) return { ok: false, error: "duplicate" };
    throw error;
  }
}

/**
 * Takes a prompt out of the run set without losing anything.
 *
 * Only an `active` prompt can be paused, so a stale toggle cannot resurrect a
 * rejected proposal into a paused one.
 */
export async function pausePrompt(
  tenantId: string,
  promptId: string,
  database: typeof defaultDb = defaultDb
): Promise<{ ok: true } | { ok: false; error: "not_found" }> {
  const rows = await database
    .update(aiVisibilityPrompts)
    .set({ status: "paused", pausedAt: new Date() })
    .where(
      and(
        eq(aiVisibilityPrompts.tenantId, tenantId),
        eq(aiVisibilityPrompts.id, promptId),
        eq(aiVisibilityPrompts.status, "active")
      )
    )
    .returning({ id: aiVisibilityPrompts.id });
  return rows.length > 0 ? { ok: true } : { ok: false, error: "not_found" };
}

/** The cap applies on the way back in, or pausing would be a way around it. */
export async function resumePrompt(
  tenantId: string,
  promptId: string,
  database: typeof defaultDb = defaultDb
): Promise<{ ok: true } | { ok: false; error: "not_found" | "cap" }> {
  const [prompt] = await database
    .select({ id: aiVisibilityPrompts.id })
    .from(aiVisibilityPrompts)
    .where(
      and(
        eq(aiVisibilityPrompts.tenantId, tenantId),
        eq(aiVisibilityPrompts.id, promptId),
        eq(aiVisibilityPrompts.status, "paused")
      )
    )
    .limit(1);
  if (!prompt) return { ok: false, error: "not_found" };

  const active = await countActivePrompts(tenantId, database);
  if (active >= MAX_ACTIVE_PROMPTS) return { ok: false, error: "cap" };

  await database
    .update(aiVisibilityPrompts)
    .set({ status: "active", pausedAt: null })
    .where(and(eq(aiVisibilityPrompts.tenantId, tenantId), eq(aiVisibilityPrompts.id, prompt.id)));
  return { ok: true };
}

/**
 * Rewording a prompt creates a NEW prompt and pauses the old one.
 *
 * Never a text update: twelve weeks of samples sit behind the old wording, and
 * a sparkline that silently changes what question it charts is a lie. The two
 * rows link through `supersedesId` and the detail page walks it both ways.
 *
 * Only `active` and `paused` prompts get here. A `proposed` row is edited in
 * place by `approveProposals` — it has nothing behind it to protect — and a
 * `rejected` row is a negative, not a prompt.
 *
 * Both writes run in ONE transaction. The insert has to come first — the old
 * row is what the new one points at — and a tenant left with the successor
 * inserted but the predecessor never paused would be one over the cap with
 * both wordings running, which is the exact state the supersede rule exists to
 * prevent.
 *
 * `flagReason` carries over unchanged. Re-judging the wording belongs to
 * whatever recomputes quality, not to the edit: silently clearing the badge
 * here would tell the tenant their rewrite fixed a problem nothing checked.
 */
export async function editPrompt(
  tenantId: string,
  promptId: string,
  rawText: string,
  database: typeof defaultDb = defaultDb
): Promise<{ ok: true; prompt: AiVisibilityPrompt } | { ok: false; error: "not_found" | "duplicate" | "invalid" }> {
  const text = normalizePromptText(rawText);
  if (text === null) return { ok: false, error: "invalid" };

  const [existing] = await database
    .select()
    .from(aiVisibilityPrompts)
    .where(and(eq(aiVisibilityPrompts.tenantId, tenantId), eq(aiVisibilityPrompts.id, promptId)))
    .limit(1);
  if (!existing) return { ok: false, error: "not_found" };
  if (existing.status !== "active" && existing.status !== "paused") return { ok: false, error: "not_found" };

  // Whitespace-only changes are not edits. Superseding here would leave a
  // paused ghost and a fresh, empty sparkline for the same question.
  if (existing.text === text) return { ok: true, prompt: existing };

  // Neither is a change of capitalisation. Engines are asked the same question
  // either way, so the history behind it stays valid — and superseding would
  // collide with the case-insensitive unique index anyway, reporting the
  // tenant's own prompt back to them as a duplicate. Fix the display text in
  // place and keep the row.
  if (existing.text.toLowerCase() === text.toLowerCase()) {
    const [renamed] = await database
      .update(aiVisibilityPrompts)
      .set({ text })
      .where(and(eq(aiVisibilityPrompts.tenantId, tenantId), eq(aiVisibilityPrompts.id, existing.id)))
      .returning();
    return { ok: true, prompt: renamed };
  }

  return database.transaction(async (tx) => {
    const [row] = await tx
      .insert(aiVisibilityPrompts)
      .values({
        tenantId,
        text,
        intent: existing.intent,
        persona: existing.persona,
        competitorId: existing.competitorId,
        branded: existing.branded,
        // A human typed this wording, whatever produced the original.
        origin: "user",
        status: existing.status,
        cluster: existing.cluster,
        supersedesId: existing.id,
        approvedAt: existing.approvedAt,
        approvedBy: existing.approvedBy,
        pausedAt: existing.status === "paused" ? new Date() : null,
        flagReason: existing.flagReason,
      })
      .onConflictDoNothing({
        target: [aiVisibilityPrompts.tenantId, aiVisibilityPrompts.textNormalized],
        where: sql`${aiVisibilityPrompts.status} <> 'rejected'`,
      })
      .returning();
    // Nothing has been written yet, so returning here commits an empty
    // transaction rather than needing a rollback.
    if (!row) return { ok: false as const, error: "duplicate" as const };

    await tx
      .update(aiVisibilityPrompts)
      .set({ status: "paused", pausedAt: new Date() })
      .where(and(eq(aiVisibilityPrompts.tenantId, tenantId), eq(aiVisibilityPrompts.id, existing.id)));

    return { ok: true as const, prompt: row };
  });
}

/**
 * Deletes a prompt only while it has no history.
 *
 * Once one sample exists the prompt is the label on twelve weeks of numbers,
 * and pausing is the honest operation. The UI hides Delete and says why rather
 * than offering it and failing.
 */
export async function deletePrompt(
  tenantId: string,
  promptId: string,
  database: typeof defaultDb = defaultDb
): Promise<{ ok: true } | { ok: false; error: "not_found" | "has_samples" }> {
  const [prompt] = await database
    .select({ id: aiVisibilityPrompts.id })
    .from(aiVisibilityPrompts)
    .where(and(eq(aiVisibilityPrompts.tenantId, tenantId), eq(aiVisibilityPrompts.id, promptId)))
    .limit(1);
  if (!prompt) return { ok: false, error: "not_found" };

  const [samples] = await database
    .select({ value: count() })
    .from(aiVisibilitySamples)
    .where(
      and(eq(aiVisibilitySamples.tenantId, tenantId), eq(aiVisibilitySamples.promptId, promptId))
    );
  if ((samples?.value ?? 0) > 0) return { ok: false, error: "has_samples" };

  await database
    .delete(aiVisibilityPrompts)
    .where(and(eq(aiVisibilityPrompts.tenantId, tenantId), eq(aiVisibilityPrompts.id, promptId)));
  return { ok: true };
}
