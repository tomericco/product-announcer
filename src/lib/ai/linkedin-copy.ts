import { generateObject } from "ai";
import { z } from "zod";
import { resolveModel, modelId } from "./model";
import { recordLlmUsage } from "./llm-usage";
import { LINKEDIN_MAX_CHARS } from "@/lib/publishing/linkedin-constants";

// Re-exported so existing server-side callers of this module can keep
// importing the cap alongside `generateLinkedinCopy`. The client-safe
// drafts panel imports the constant directly from
// `@/lib/publishing/linkedin-constants` instead, so that importing it never
// drags this module's server-only `ai` SDK dependency into a client bundle.
export { LINKEDIN_MAX_CHARS };

const LinkedinCopySchema = z.object({ post: z.string() });

export function buildLinkedinCopyPrompt(args: { title: string; body: string }): { system: string; prompt: string } {
  const system = [
    "You write LinkedIn posts for a company page announcing product releases.",
    "Write in the company's voice: a strong first-line hook, then a concise, skimmable summary of what shipped and why it matters to customers.",
    "Plain text only — NO markdown syntax (no #, *, _, backticks, or link markup). Line breaks are fine.",
    `Keep the whole post at or under ${LINKEDIN_MAX_CHARS} characters. Do NOT include a URL — a link is appended automatically.`,
  ].join(" ");

  const prompt = [
    `Release title:\n${args.title}`,
    "",
    `Release notes (markdown):\n${args.body}`,
    "",
    "Write the LinkedIn post.",
  ].join("\n");

  return { system, prompt };
}

export async function generateLinkedinCopy(args: { tenantId: string; title: string; body: string }): Promise<string> {
  const { system, prompt } = buildLinkedinCopyPrompt({ title: args.title, body: args.body });
  const spec = process.env.GENERATION_MODEL ?? "anthropic/claude-sonnet-4-5";

  const result = await generateObject({
    model: resolveModel(spec),
    schema: LinkedinCopySchema,
    system,
    prompt,
  });

  await recordLlmUsage({
    tenantId: args.tenantId,
    operation: "linkedin_copy",
    model: modelId(spec),
    usage: result.usage,
  });

  return result.object.post;
}
