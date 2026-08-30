import { generateObject } from "ai";
import { z } from "zod";
import type { companyProfiles } from "@/db/schema";
import type { UpdateDraft } from "./generation";
import { resolveModel, modelId } from "./model";
import { recordLlmUsage } from "./llm-usage";
import type { OnDraftProgress } from "@/lib/drafting/draft-progress";
import {
  fenceGuidelines,
  GROUNDING_RULE,
  NO_INVENTED_LINKS_RULE,
} from "./prompt-rules";

type BrandProfileRow = typeof companyProfiles.$inferSelect;

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

export type ReviewStatus = "passed" | "failed" | "error";
export type ReviewOutcome = { finalDraft: UpdateDraft; status: ReviewStatus; issues: string[] };

const DEFAULT_MAX_ROUNDS = 2;

function reviewModelSpec(): string {
  return process.env.REVIEW_MODEL ?? "anthropic/claude-sonnet-4-5";
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
  "If a template is given, also check whether the draft FOLLOWS it, and name every gap you find specifically",
  "enough for an editor to act on. The template is the shape the company's updates take; the draft should",
  "match its sections, their order, its headings and any sign-off.",
  "Judge only the shape. Which change the draft leads with, and how much space each gets, are editorial",
  "decisions already made — do not second-guess them, and do not ask for content the template cannot tell you",
  "is missing.",
  "If it fully complies, set compliant true and issues [].",
  "If it violates any requirement, set compliant false and list the specific issues to fix.",
  "Do not rewrite the draft — only critique it.",
].join(" ");

export const REVISION_SYSTEM = [
  "You are a product-update editor.",
  "Rewrite the draft to fix the listed brand-compliance issues while keeping the same facts.",
  GROUNDING_RULE,
  NO_INVENTED_LINKS_RULE,
  "Return only the revised title and body.",
].join(" ");

// The framing stays here; only the fence is shared. A tenant with no
// guidelines still needs this fallback sentence, which prompt-rules has no
// business knowing about.
function brandRubric(brandProfile: BrandProfileRow): string {
  return fenceGuidelines(brandProfile.guidelines) ?? "No specific brand requirements are configured.";
}

// Appended verbatim when a template is configured; omitted entirely when it
// isn't, so a tenant with no template sees no template block at all.
function templateBlock(template: string | null): string {
  return template ? `\n\nTemplate the update should follow:\n<template>\n${template}\n</template>` : "";
}

export function buildReviewPrompt(draft: UpdateDraft, brandProfile: BrandProfileRow, template: string | null): string {
  return `Brand requirements:\n${brandRubric(brandProfile)}\n\nDraft to review:\nTitle: ${draft.title}\nBody:\n${draft.body}${templateBlock(template)}`;
}

export function buildRevisionPrompt(
  draft: UpdateDraft,
  issues: string[],
  brandProfile: BrandProfileRow,
  template: string | null
): string {
  const list = issues.map((issue) => `- ${issue}`).join("\n");
  return `Brand requirements:\n${brandRubric(brandProfile)}\n\nDraft to revise:\nTitle: ${draft.title}\nBody:\n${draft.body}\n\nFix these issues:\n${list}${templateBlock(template)}`;
}

export async function reviewDraft(
  draft: UpdateDraft,
  brandProfile: BrandProfileRow,
  template: string | null
): Promise<ReviewCritique> {
  const spec = reviewModelSpec();
  const result = await generateObject({
    model: resolveModel(spec),
    schema: ReviewCritiqueSchema,
    system: REVIEW_SYSTEM,
    prompt: buildReviewPrompt(draft, brandProfile, template),
  });
  await recordLlmUsage({
    tenantId: brandProfile.tenantId,
    operation: "review",
    model: modelId(spec),
    usage: result.usage,
  });
  return result.object;
}

export async function reviseDraft(
  draft: UpdateDraft,
  issues: string[],
  brandProfile: BrandProfileRow,
  template: string | null
): Promise<UpdateDraft> {
  const spec = reviewModelSpec();
  const result = await generateObject({
    model: resolveModel(spec),
    schema: RevisionSchema,
    system: REVISION_SYSTEM,
    prompt: buildRevisionPrompt(draft, issues, brandProfile, template),
  });
  await recordLlmUsage({
    tenantId: brandProfile.tenantId,
    operation: "revision",
    model: modelId(spec),
    usage: result.usage,
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
  template: string | null,
  onProgress?: OnDraftProgress
): Promise<ReviewOutcome> {
  const rounds = reviewMaxRounds();
  let current = draft;

  try {
    onProgress?.({ type: "detail", text: "Reviewing (round 1)" });
    let critique = await withRetry(() => reviewDraft(current, brandProfile, template));
    if (critique.compliant) return { finalDraft: current, status: "passed", issues: [] };

    for (let round = 0; round < rounds; round++) {
      onProgress?.({ type: "detail", text: "Revising" });
      current = await withRetry(() => reviseDraft(current, critique.issues, brandProfile, template));
      onProgress?.({ type: "detail", text: `Reviewing (round ${round + 2})` });
      critique = await withRetry(() => reviewDraft(current, brandProfile, template));
      // A draft that needed a revision is reported the same as one that was
      // clean first time: both are compliant and ready to read. The distinction
      // wasn't actionable (the issues that triggered the rewrite aren't kept),
      // so it only added noise.
      if (critique.compliant) return { finalDraft: current, status: "passed", issues: [] };
    }

    return { finalDraft: current, status: "failed", issues: critique.issues };
  } catch {
    // A review/revise call failed after its retry — hold the most recent draft.
    return { finalDraft: current, status: "error", issues: [] };
  }
}
