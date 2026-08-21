import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { aiVisibilityPrompts, type AiVisibilityPrompt } from "@/db/schema";
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
      target: [aiVisibilityPrompts.tenantId, aiVisibilityPrompts.text],
      where: sql`${aiVisibilityPrompts.status} <> 'rejected'`,
    })
    .returning();

  if (!row) return { ok: false, error: "duplicate" };
  return { ok: true, prompt: row };
}
