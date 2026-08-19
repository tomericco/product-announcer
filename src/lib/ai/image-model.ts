import { openai } from "@ai-sdk/openai";

export const IMAGE_MODEL_DEFAULT = "openai/gpt-image-2";

/** Strips a gateway-style "openai/" prefix: "openai/gpt-image-2" -> "gpt-image-2". */
export function imageModelId(spec: string): string {
  return spec.startsWith("openai/") ? spec.slice("openai/".length) : spec;
}

/**
 * Resolves the configured image model, calling OpenAI DIRECTLY via
 * @ai-sdk/openai (billed against OPENAI_API_KEY) — the same no-gateway stance
 * as src/lib/ai/model.ts, and the one documented exception to Anthropic-only
 * (Anthropic has no image model; image spec §1). Swapping models later is an
 * IMAGE_MODEL env change.
 */
export function resolveImageModel(spec: string) {
  return openai.image(imageModelId(spec));
}
