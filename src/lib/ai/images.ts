import { generateImage } from "ai";
import type { DbClient } from "@/lib/publishing/destinations/types";
import { recordLlmUsage } from "@/lib/ai/llm-usage";
import { IMAGE_MODEL_DEFAULT, imageModelId, resolveImageModel } from "@/lib/ai/image-model";
import { imageDimensions } from "@/lib/images/compress";
import { IMAGE_ASPECT_RATIOS, IMAGE_SIZES, type ImageSize } from "@/lib/images/prompt";

export type RenderImageArgs = {
  tenantId: string;
  /** The FULL prompt, style block already included (buildImagePrompt). */
  prompt: string;
  /** cover | body master sizes; sent as BOTH `size` and `aspectRatio`. */
  size: ImageSize;
  /** Style references — blob URLs or bytes. Passed via prompt {images, text}. */
  referenceImages?: (string | Buffer)[];
  /** When set: image+instruction edit; `prompt` is the instruction. */
  editOf?: string | Buffer;
  /**
   * Measures what came back and re-asks once if the shape is off by more than
   * ASPECT_TOLERANCE. Never crops — see the block above. Defaults to `true`
   * whenever `size` is `IMAGE_SIZES.cover` (the only size product owner
   * decision 1 requires this for) — a caller rendering a cover does not need
   * to remember to opt in, and only an explicit `false` turns the guard off
   * for a cover-sized render. Bodies default to `false` unless passed `true`.
   */
  enforceAspect?: boolean;
  database?: DbClient;
};

/** How far off 1.91:1 a cover may be before we ask again. 2% ≈ 1.87–1.94:1. */
export const ASPECT_TOLERANCE = 0.02;

/** Injectable for tests. `generate` is `ai`'s generateImage; `fetchImpl` downloads URL references. */
export type RenderImageDeps = {
  generate?: typeof generateImage;
  fetchImpl?: typeof fetch;
};

async function toBytes(ref: string | Buffer, fetchImpl: typeof fetch): Promise<Buffer> {
  if (Buffer.isBuffer(ref)) return ref;
  const res = await fetchImpl(ref);
  if (!res.ok) throw new Error(`Failed to fetch reference image (${res.status}): ${ref}`);
  return Buffer.from(await res.arrayBuffer());
}

/** The shape `size` asks for, as a number. "1200x630" -> 1.904…  */
function targetAspect(size: ImageSize): number {
  const [width, height] = size.split("x").map(Number);
  return width / height;
}

/**
 * How far the bytes deviate from `wanted`, as a fraction. `null` means the
 * bytes could not be measured at all — the guard then stands down rather than
 * failing a render over a missing metadata read.
 */
async function aspectDeviation(png: Buffer, wanted: number): Promise<number | null> {
  try {
    const { width, height } = await imageDimensions(png);
    return Math.abs(width / height - wanted) / wanted;
  } catch (error) {
    console.warn("[ai/images] could not measure the rendered image; storing it as-is:", error);
    return null;
  }
}

/**
 * The single seam every render goes through (spec §1): prompt + references
 * in, raw PNG bytes out, one `image_generation` usage row per call. Callers
 * compress (`compressPng`) and upload (`uploadPng`) — this function knows
 * nothing about Blob or the database beyond accounting.
 *
 * References are downloaded to bytes here rather than passed as URLs so the
 * provider's edits endpoint (multipart) always receives file data regardless
 * of how it treats URL files.
 *
 * The request states the shape twice — `size` (exact pixels) and
 * `aspectRatio` — because gpt-image-2 supports flexible sizes and a provider
 * that honours only one of the two still returns the right shape. With
 * `enforceAspect` (covers), the answer is measured and re-asked for once if it
 * is off; a still-wrong second answer is returned as-is with its true
 * dimensions. NOTHING here or downstream crops (product owner, 2026-08-19).
 */
export async function renderImage(args: RenderImageArgs, deps: RenderImageDeps = {}): Promise<Buffer> {
  const generate = deps.generate ?? generateImage;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const spec = process.env.IMAGE_MODEL ?? IMAGE_MODEL_DEFAULT;
  const model = resolveImageModel(spec);

  let prompt: Parameters<typeof generateImage>[0]["prompt"];
  if (args.editOf !== undefined) {
    prompt = { images: [await toBytes(args.editOf, fetchImpl)], text: args.prompt };
  } else if (args.referenceImages && args.referenceImages.length > 0) {
    const images = await Promise.all(args.referenceImages.map((r) => toBytes(r, fetchImpl)));
    prompt = { images, text: args.prompt };
  } else {
    prompt = args.prompt;
  }

  /** One billed render: the model call plus its usage row. */
  const renderOnce = async (): Promise<Buffer> => {
    const result = await generate({
      model,
      prompt,
      size: args.size,
      aspectRatio: IMAGE_ASPECT_RATIOS[args.size],
      n: 1,
    });

    // Surfaces provider-reported problems with the request itself (e.g. a
    // provider that silently ignores `aspectRatio` and pushes a warning
    // instead of failing) — previously dropped on the floor, which is exactly
    // how a real, known @ai-sdk/openai warning here went unnoticed.
    if (Array.isArray(result.warnings) && result.warnings.length > 0) {
      console.warn("[ai/images] generateImage warnings:", result.warnings);
    }

    await recordLlmUsage(
      {
        tenantId: args.tenantId,
        operation: "image_generation",
        model: imageModelId(spec),
        usage: {
          inputTokens: result.usage?.inputTokens,
          outputTokens: result.usage?.outputTokens,
          totalTokens: result.usage?.totalTokens,
        },
        imageCount: 1,
      },
      args.database
    );

    return Buffer.from(result.images[0].uint8Array);
  };

  const first = await renderOnce();
  // Defaults to on for a cover-sized render (product owner decision 1: covers
  // are never cropped, so a caller that forgets to pass `enforceAspect: true`
  // must not silently lose the guard) — an explicit `false` still opts out.
  const shouldEnforceAspect = args.enforceAspect ?? args.size === IMAGE_SIZES.cover;
  if (!shouldEnforceAspect) return first;

  const wanted = targetAspect(args.size);
  const deviation = await aspectDeviation(first, wanted);
  if (deviation === null || deviation <= ASPECT_TOLERANCE) return first;

  console.warn(
    `[ai/images] cover render came back off ${args.size} by ${(deviation * 100).toFixed(1)}%; retrying once with the identical, unmodified request`
  );
  const second = await renderOnce();
  const secondDeviation = await aspectDeviation(second, wanted);
  if (secondDeviation !== null && secondDeviation > ASPECT_TOLERANCE) {
    // Store the truth. Cropping to 1200x630 would cut detail the concept put
    // there on purpose, and lying about width/height would break every
    // downstream consumer (Plan 4 publishes these numbers verbatim).
    console.warn(
      `[ai/images] cover render is still off ${args.size} after one retry; storing it as-is with its true dimensions (no crop)`
    );
  }
  return second;
}
