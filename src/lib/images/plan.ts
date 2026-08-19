import { generateObject } from "ai";
import { z } from "zod";
import { db as defaultDb } from "@/db";
import { resolveModel, modelId } from "@/lib/ai/model";
import { recordLlmUsage, type TokenUsage } from "@/lib/ai/llm-usage";
import { buildImagePrompt } from "@/lib/images/prompt";
import { listH2Headings } from "@/lib/images/splice";
import type { DbClient } from "@/lib/publishing/destinations/types";

/**
 * Stage 1 of the illustration agent (spec §4): the TEXT model reads the
 * finished draft and decides what to illustrate and where. It returns
 * concepts, anchor headings and alt text only. The image prompt for each
 * entry is assembled here in code by `buildImagePrompt` from the concept and
 * the compiled style block — the model never sees or writes the style block,
 * so prompt assembly stays in one place (spec §2).
 */

export type IllustrationPlan = {
  cover: { concept: string; prompt: string; altText: string } | null;
  body: { anchorHeading: string; concept: string; prompt: string; altText: string }[];
};

/** Alt text policy (spec §2): one sentence, ≤125 chars, meaning not style. */
export const MAX_ALT_TEXT_LENGTH = 125;

/** A cover plus at most three body entries is a few hundred tokens; 1,500 bounds a runaway. */
export const MAX_PLAN_OUTPUT_TOKENS = 1_500;

// No `prompt` field: the model has nothing to fill in there even if it tried.
export const PlanSchema = z.object({
  cover: z.object({ concept: z.string(), altText: z.string() }).nullable(),
  body: z.array(z.object({ anchorHeading: z.string(), concept: z.string(), altText: z.string() })),
});

export type PlanGenerate = (args: {
  model: ReturnType<typeof resolveModel>;
  schema: typeof PlanSchema;
  system: string;
  prompt: string;
  maxOutputTokens: number;
}) => Promise<{ object: z.infer<typeof PlanSchema>; usage?: TokenUsage }>;

export type PlanDeps = { generate?: PlanGenerate };

function buildSystem(args: { wantCover: boolean; bodyCap: number }): string {
  return [
    "You plan the illustrations for a piece of marketing content that has already been written.",
    "You do NOT write image prompts and you do NOT describe visual style. Another step renders",
    "each concept in the company's fixed brand style, so never mention colours, palette, medium,",
    "lighting, composition, or artistic style. Describe only WHAT the image depicts: a concrete",
    "visual metaphor for the idea in that section.",
    "",
    "RULES.",
    `1. BODY IMAGES: at most ${args.bodyCap}. Aim for roughly one image per two H2 sections, and go`,
    "   UNDER that whenever a section has nothing worth visualising. NEVER PAD to the limit — an",
    "   image that merely decorates is worse than no image. Return an empty body list when nothing",
    "   earns one.",
    "2. ANCHORS: every body image names one H2 heading from the list given, copied verbatim. The",
    "   image is placed directly after that heading, before the section's first paragraph.",
    "3. PLACEMENT:",
    args.wantCover
      ? "   - The piece opens with a cover image above the title. Never anchor a body image to the first H2 when the text before it is a short intro — that is a double hero. No second hero."
      : "   - There is no cover image on this piece.",
    "   - Never anchor two images to neighbouring short sections; keep roughly 150 words of text",
    "     between images.",
    "   - Never anchor an image to a closing, summary, conclusion, next-steps or call-to-action section.",
    "4. CONCEPT FIRST: each concept is one or two sentences naming a concrete subject and what it is",
    '   doing — for example "three interlocking gears, one glowing, lifting a stack of documents".',
    "   No text, labels, numbers, logos or brand marks in the depiction.",
    "5. ALT TEXT: one sentence, at most 125 characters, saying what the image MEANS for a reader who",
    '   cannot see it. Never start with "image of" or "illustration of". Derived from the concept,',
    "   never from style.",
    args.wantCover
      ? "6. COVER: exactly one concept for a wide hero image that captures the piece as a whole — its thesis, not any one section. Keep the subject centred; the edges may be cropped."
      : "6. COVER: this piece has no cover. Return null for cover.",
  ].join("\n");
}

function buildPrompt(args: { title: string; body: string; headings: string[] }): string {
  return [
    `## Title`,
    args.title,
    "",
    "## H2 headings you may anchor to (copy verbatim)",
    args.headings.length > 0 ? args.headings.map((h) => `- ${h}`).join("\n") : "(none — return an empty body list)",
    "",
    "## Body (markdown)",
    args.body,
  ].join("\n");
}

/**
 * Enforces the alt policy on whatever came back: strips a leading
 * "image of"/"illustration of"/"picture of", capitalises, and truncates.
 * An instruction is not an enforcement (see `proposeBriefFromSignals`'s
 * score clamp for the precedent).
 */
export function normalizeAltText(raw: string): string {
  let text = raw.trim().replace(/^(an?\s+)?(image|illustration|picture|graphic|drawing)\s+of\s+/i, "");
  if (text.length > 0) text = text[0].toUpperCase() + text.slice(1);
  if (text.length > MAX_ALT_TEXT_LENGTH) text = text.slice(0, MAX_ALT_TEXT_LENGTH).replace(/\s+\S*$/, "").trimEnd();
  return text;
}

export async function planIllustrations(
  args: {
    tenantId: string;
    title: string;
    body: string;
    wantCover: boolean;
    bodyCap: number;
    styleBlock: string;
    allowText?: boolean;
    database?: DbClient;
  },
  deps: PlanDeps = {}
): Promise<IllustrationPlan> {
  const bodyCap = Math.max(0, Math.floor(args.bodyCap));
  if (!args.wantCover && bodyCap === 0) return { cover: null, body: [] };

  const generate = deps.generate ?? (generateObject as unknown as PlanGenerate);
  const headings = listH2Headings(args.body);
  const allowText = args.allowText ?? false;

  const spec = process.env.GENERATION_MODEL ?? "anthropic/claude-sonnet-4-5";
  const { object, usage } = await generate({
    model: resolveModel(spec),
    schema: PlanSchema,
    system: buildSystem({ wantCover: args.wantCover, bodyCap }),
    prompt: buildPrompt({ title: args.title, body: args.body, headings }),
    maxOutputTokens: MAX_PLAN_OUTPUT_TOKENS,
  });

  await recordLlmUsage(
    { tenantId: args.tenantId, operation: "illustration_plan", model: modelId(spec), usage },
    args.database ?? defaultDb
  );

  // Post-validation. `generate` is caller-injected and the model is a model:
  // an anchor that is not an H2 in the body cannot be placed, a repeat anchor
  // would stack two images under one heading, and the cap is the cap. The
  // canonical heading text (as written in the body) is stored, not the model's
  // spelling of it, so the splice and the retry match exactly.
  const byNormalized = new Map(headings.map((h) => [h.trim().toLowerCase(), h] as const));
  const seen = new Set<string>();
  const body: IllustrationPlan["body"] = [];
  for (const entry of object.body) {
    const key = entry.anchorHeading.trim().toLowerCase();
    const canonical = byNormalized.get(key);
    if (canonical === undefined || seen.has(key)) continue;
    seen.add(key);
    body.push({
      anchorHeading: canonical,
      concept: entry.concept.trim(),
      altText: normalizeAltText(entry.altText),
      prompt: buildImagePrompt({ styleBlock: args.styleBlock, concept: entry.concept.trim(), role: "body", allowText }),
    });
    if (body.length >= bodyCap) break;
  }

  const cover =
    args.wantCover && object.cover
      ? {
          concept: object.cover.concept.trim(),
          altText: normalizeAltText(object.cover.altText),
          prompt: buildImagePrompt({ styleBlock: args.styleBlock, concept: object.cover.concept.trim(), role: "cover", allowText }),
        }
      : null;

  return { cover, body };
}
