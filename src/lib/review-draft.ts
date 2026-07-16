import { generateObject } from "ai";
import { z } from "zod";
import type { brandProfiles } from "../db/schema";
import type { UpdateDraft } from "./generation";

type BrandProfileRow = typeof brandProfiles.$inferSelect;

export const ReviewResultSchema = z.object({
  compliant: z.boolean(),
  issues: z.array(z.string()),
  revised: z.object({ title: z.string(), body: z.string() }).nullable(),
});

export type ReviewResult = z.infer<typeof ReviewResultSchema>;

export type ReviewStatus = "passed" | "revised" | "failed" | "error";
export type ReviewOutcome = { finalDraft: UpdateDraft; status: ReviewStatus; issues: string[] };

const REVIEW_SYSTEM = [
  "You are a brand-compliance reviewer for product update announcements.",
  "Check the draft against the brand requirements.",
  "If it fully complies, set compliant true, issues [], revised null.",
  "If it violates any requirement, set compliant false, list the specific issues, and provide a revised",
  "title and body that fix them while keeping the same facts.",
].join(" ");

export function buildReviewPrompt(draft: UpdateDraft, brandProfile: BrandProfileRow): string {
  const rules = [
    brandProfile.tone ? `Tone: ${brandProfile.tone}.` : null,
    brandProfile.readingLevel ? `Reading level: ${brandProfile.readingLevel}.` : null,
    brandProfile.doList.length > 0 ? `Do: ${brandProfile.doList.join("; ")}.` : null,
    brandProfile.dontList.length > 0 ? `Avoid: ${brandProfile.dontList.join("; ")}.` : null,
    brandProfile.examplePhrases.length > 0 ? `Preferred phrasing: ${brandProfile.examplePhrases.join("; ")}.` : null,
  ].filter((line): line is string => Boolean(line));

  const rubric = rules.length > 0 ? rules.join(" ") : "No specific brand requirements are configured.";
  return `Brand requirements:\n${rubric}\n\nDraft to review:\nTitle: ${draft.title}\nBody:\n${draft.body}`;
}

export async function reviewDraft(draft: UpdateDraft, brandProfile: BrandProfileRow): Promise<ReviewResult> {
  const result = await generateObject({
    model: process.env.REVIEW_MODEL ?? "anthropic/claude-sonnet-4-5",
    schema: ReviewResultSchema,
    system: REVIEW_SYSTEM,
    prompt: buildReviewPrompt(draft, brandProfile),
  });
  return result.object;
}

/**
 * Reviews a draft against brand requirements and reconciles the outcome:
 * passed (compliant first try), revised (rewritten and now compliant), failed
 * (still non-compliant after one rewrite), or error (review unavailable after a
 * retry — fail-safe, held as draft). The first review is retried once on error;
 * the re-review of a revision is a single call.
 */
export async function reviewAndReconcile(draft: UpdateDraft, brandProfile: BrandProfileRow): Promise<ReviewOutcome> {
  let first: ReviewResult;
  try {
    first = await reviewDraft(draft, brandProfile);
  } catch {
    try {
      first = await reviewDraft(draft, brandProfile);
    } catch {
      return { finalDraft: draft, status: "error", issues: [] };
    }
  }

  if (first.compliant) return { finalDraft: draft, status: "passed", issues: [] };
  if (!first.revised) return { finalDraft: draft, status: "failed", issues: first.issues };

  const revisedDraft: UpdateDraft = { title: first.revised.title, body: first.revised.body, category: draft.category };

  let second: ReviewResult;
  try {
    second = await reviewDraft(revisedDraft, brandProfile);
  } catch {
    // Re-review failed; keep the revision but hold it (can't confirm compliance).
    return { finalDraft: revisedDraft, status: "failed", issues: first.issues };
  }

  return second.compliant
    ? { finalDraft: revisedDraft, status: "revised", issues: [] }
    : { finalDraft: revisedDraft, status: "failed", issues: second.issues };
}
