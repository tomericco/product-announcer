import { generateObject } from "ai";
import { z } from "zod";
import { db as defaultDb } from "@/db";
import { resolveModel, modelId } from "@/lib/ai/model";
import { recordLlmUsage } from "@/lib/ai/llm-usage";
import type { DbClient } from "@/lib/publishing/destinations/types";
import { NON_LITERAL_DIRECTIVE } from "@/lib/images/prompt";

export type ImageSuggestion = { concept: string; altText: string };

const SuggestionSchema = z.object({
  concept: z.string().min(1),
  altText: z.string().max(125),
});

export function buildSuggestPrompt(a: { title: string; surroundingMarkdown: string; role: "cover" | "body" }) {
  const system = [
    "You propose ONE flat, illustrative marketing graphic for a piece of content.",
    a.role === "cover"
      ? "This is the cover image for the whole piece: one visual metaphor for its main idea, composed for a wide 1.91:1 hero with the subject centered."
      : "This is a body illustration for one section: a single-concept visual metaphor for what that section is about.",
    "Describe WHAT the image shows — subject, metaphor, arrangement — in one to three sentences. Never describe style, colours, or medium; those are fixed by the brand.",
    NON_LITERAL_DIRECTIVE,
    "The image must contain no text, letters, words, logos or UI screenshots. Do not depict real people or brands.",
    "altText: one sentence, at most 125 characters, describing the meaning (not the style), without the words 'image of'.",
  ].join(" ");
  const prompt = [`Title:\n${a.title}`, "", `Section (markdown):\n${a.surroundingMarkdown}`, "", "Propose the image."].join("\n");
  return { system, prompt };
}

export async function suggestImageConcept(
  a: { tenantId: string; title: string; surroundingMarkdown: string; role: "cover" | "body"; database?: DbClient },
  deps: { generate?: typeof generateObject } = {}
): Promise<ImageSuggestion> {
  const generate = deps.generate ?? generateObject;
  const database = a.database ?? defaultDb;
  const spec = process.env.GENERATION_MODEL ?? "anthropic/claude-sonnet-4-5";
  const { system, prompt } = buildSuggestPrompt(a);

  const result = await generate({ model: resolveModel(spec), schema: SuggestionSchema, system, prompt });

  await recordLlmUsage(
    { tenantId: a.tenantId, operation: "illustration_plan", model: modelId(spec), usage: result.usage },
    database
  );

  return { concept: result.object.concept.trim(), altText: result.object.altText.trim() };
}
