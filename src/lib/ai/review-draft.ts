import { generateObject } from "ai";
import { z } from "zod";
import type { brandProfiles } from "@/db/schema";
import type { UpdateDraft } from "./generation";
import { resolveModel } from "./model";
import type { OnDraftProgress } from "@/lib/scheduling/draft-progress";

type BrandProfileRow = typeof brandProfiles.$inferSelect;

export const ReviewCritiqueSchema = z.object({
  compliant: z.boolean(),
  issues: z.array(z.string()),
});
export type ReviewCritique = z.infer<typeof ReviewCritiqueSchema>;

export const RevisionSchema = z.object({
  title: z.string(),
  body: z.string(),
});
export type Revision = z.infer<typeof RevisionSchema>;

export type ReviewStatus = "passed" | "revised" | "failed" | "error";
export type ReviewOutcome = { finalDraft: UpdateDraft; status: ReviewStatus; issues: string[] };

const DEFAULT_MAX_ROUNDS = 2;

function reviewModel() {
  return resolveModel(process.env.REVIEW_MODEL ?? "anthropic/claude-sonnet-4-5");
}

// Default when unset; any non-positive/invalid value clamps to 0 (pure gate).
function reviewMaxRounds(): number {
  const raw = process.env.REVIEW_MAX_ROUNDS;
  if (raw === undefined) return DEFAULT_MAX_ROUNDS;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// One retry on error; a second failure propagates to the caller.
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch {
    return await fn();
  }
}

const REVIEW_SYSTEM = [
  "You are a brand-compliance reviewer for product update announcements.",
  "Check the draft against the brand requirements.",
  "If it fully complies, set compliant true and issues [].",
  "If it violates any requirement, set compliant false and list the specific issues to fix.",
  "Do not rewrite the draft — only critique it.",
].join(" ");

const REVISION_SYSTEM = [
  "You are a product-update editor.",
  "Rewrite the draft to fix the listed brand-compliance issues while keeping the same facts.",
  "Return only the revised title and body.",
].join(" ");

function brandRubric(brandProfile: BrandProfileRow): string {
  const rules = [
    brandProfile.tone ? `Tone: ${brandProfile.tone}.` : null,
    brandProfile.readingLevel ? `Reading level: ${brandProfile.readingLevel}.` : null,
    brandProfile.doList.length > 0 ? `Do: ${brandProfile.doList.join("; ")}.` : null,
    brandProfile.dontList.length > 0 ? `Avoid: ${brandProfile.dontList.join("; ")}.` : null,
    brandProfile.examplePhrases.length > 0 ? `Preferred phrasing: ${brandProfile.examplePhrases.join("; ")}.` : null,
  ].filter((line): line is string => Boolean(line));

  return rules.length > 0 ? rules.join(" ") : "No specific brand requirements are configured.";
}

export function buildReviewPrompt(draft: UpdateDraft, brandProfile: BrandProfileRow): string {
  return `Brand requirements:\n${brandRubric(brandProfile)}\n\nDraft to review:\nTitle: ${draft.title}\nBody:\n${draft.body}`;
}

export function buildRevisionPrompt(draft: UpdateDraft, issues: string[], brandProfile: BrandProfileRow): string {
  const list = issues.map((issue) => `- ${issue}`).join("\n");
  return `Brand requirements:\n${brandRubric(brandProfile)}\n\nDraft to revise:\nTitle: ${draft.title}\nBody:\n${draft.body}\n\nFix these issues:\n${list}`;
}

export async function reviewDraft(draft: UpdateDraft, brandProfile: BrandProfileRow): Promise<ReviewCritique> {
  const result = await generateObject({
    model: reviewModel(),
    schema: ReviewCritiqueSchema,
    system: REVIEW_SYSTEM,
    prompt: buildReviewPrompt(draft, brandProfile),
  });
  return result.object;
}

export async function reviseDraft(
  draft: UpdateDraft,
  issues: string[],
  brandProfile: BrandProfileRow
): Promise<UpdateDraft> {
  const result = await generateObject({
    model: reviewModel(),
    schema: RevisionSchema,
    system: REVISION_SYSTEM,
    prompt: buildRevisionPrompt(draft, issues, brandProfile),
  });
  return { title: result.object.title, body: result.object.body };
}

/**
 * Feedback-remediation loop. Critiques the draft; if non-compliant, revises it
 * from the specific issues and re-reviews, iterating up to REVIEW_MAX_ROUNDS
 * (default 2). Outcomes: passed (compliant first review), revised (compliant
 * after ≥1 round), failed (still non-compliant at the cap — holds the last
 * revision + last issues), error (a review/revise call failed after its retry —
 * holds the most recent draft, fail-safe). Every call is retried once on error.
 */
export async function reviewAndReconcile(
  draft: UpdateDraft,
  brandProfile: BrandProfileRow,
  onProgress?: OnDraftProgress
): Promise<ReviewOutcome> {
  const rounds = reviewMaxRounds();
  let current = draft;

  try {
    onProgress?.({ type: "detail", text: "Reviewing (round 1)" });
    let critique = await withRetry(() => reviewDraft(current, brandProfile));
    if (critique.compliant) return { finalDraft: current, status: "passed", issues: [] };

    for (let round = 0; round < rounds; round++) {
      onProgress?.({ type: "detail", text: "Revising" });
      current = await withRetry(() => reviseDraft(current, critique.issues, brandProfile));
      onProgress?.({ type: "detail", text: `Reviewing (round ${round + 2})` });
      critique = await withRetry(() => reviewDraft(current, brandProfile));
      if (critique.compliant) return { finalDraft: current, status: "revised", issues: [] };
    }

    return { finalDraft: current, status: "failed", issues: critique.issues };
  } catch {
    // A review/revise call failed after its retry — hold the most recent draft.
    return { finalDraft: current, status: "error", issues: [] };
  }
}
