import { generateObject } from "ai";
import { z } from "zod";
import type { companyProfiles, ResolvedPersona, systemContentExamples } from "@/db/schema";
import { composeScopedEditPrompt, composeWholeEditPrompt } from "./compose-prompt";
import { resolveModel, modelId } from "./model";
import { recordLlmUsage } from "./llm-usage";

type BrandProfileRow = typeof companyProfiles.$inferSelect;
type ExampleRow = typeof systemContentExamples.$inferSelect;

const EditResultSchema = z.object({ text: z.string() });

/**
 * Strips a single wrapping code-fence or matching quote pair the model may add
 * around the returned text, so a surgical replacement doesn't inject stray
 * Markdown into the middle of the body.
 */
export function stripWrapping(raw: string): string {
  let text = raw.trim();
  const fence = text.match(/^```[^\n]*\n([\s\S]*?)\n```$/);
  if (fence) text = fence[1].trim();
  if (
    text.length >= 2 &&
    ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))
  ) {
    text = text.slice(1, -1);
  }
  return text;
}

/**
 * Single-call agent edit of a draft body. In `selection` mode it returns just
 * the revised excerpt (spliced back in place client-side); in `whole` mode it
 * returns the full revised body. Mirrors `generateReleaseDraft`'s model
 * resolution and usage recording.
 */
export async function editReleaseBody(args: {
  mode: "selection" | "whole";
  instruction: string;
  currentBody: string;
  excerpt: string;
  brandProfile: BrandProfileRow;
  personas?: ResolvedPersona[];
  examples?: ExampleRow[];
}): Promise<string> {
  const personas = args.personas ?? [];
  const examples = args.examples ?? [];

  const { system, prompt } =
    args.mode === "selection"
      ? composeScopedEditPrompt({
          fullBody: args.currentBody,
          excerpt: args.excerpt,
          instruction: args.instruction,
          brandProfile: args.brandProfile,
          personas,
          examples,
        })
      : composeWholeEditPrompt({
          currentBody: args.currentBody,
          instruction: args.instruction,
          brandProfile: args.brandProfile,
          personas,
          examples,
        });

  const spec = process.env.GENERATION_MODEL ?? "anthropic/claude-sonnet-4-5";
  const result = await generateObject({
    model: resolveModel(spec),
    schema: EditResultSchema,
    system,
    prompt,
  });

  await recordLlmUsage({
    tenantId: args.brandProfile.tenantId,
    operation: "generation",
    model: modelId(spec),
    usage: result.usage,
  });

  return stripWrapping(result.object.text);
}
