import { z } from "zod";
import type { BodyIllustrationSetting, ImagePolicy } from "@/db/schema";
import type { ContentType } from "@/lib/ai/compose-prompt";

// Type-only imports above: the /settings Content images form is a Client
// Component and imports the defaults and row list from here.

/** "auto" resolves to this many body illustrations at most (spec §4, §6). */
export const AUTO_BODY_CAP = 3;

/** Spec §6 table. The column stays null until a tenant changes something. */
export const DEFAULT_IMAGE_POLICY: Record<ContentType, { cover: boolean; body: BodyIllustrationSetting }> = {
  blog_post: { cover: true, body: "auto" },
  product_update: { cover: true, body: "off" },
  social_post: { cover: false, body: "off" },
};

/** Row order and labels for the settings card. */
export const IMAGE_POLICY_ROWS: readonly { type: ContentType; label: string }[] = [
  { type: "blog_post", label: "Blog post" },
  { type: "product_update", label: "Product update" },
  { type: "social_post", label: "Social post" },
];

export const BODY_SETTING_OPTIONS: readonly { value: BodyIllustrationSetting; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "auto", label: `Auto (up to ${AUTO_BODY_CAP})` },
  { value: 1, label: "Up to 1" },
  { value: 2, label: "Up to 2" },
  { value: 3, label: "Up to 3" },
];

/**
 * What generation and the editor actually consult: a boolean for the cover and
 * a numeric cap for body illustrations. `null`/missing falls back to the
 * TypeScript defaults, so a tenant who never touched the card gets the table.
 */
export function resolveImagePolicy(policy: ImagePolicy | null, type: ContentType): { cover: boolean; bodyCap: number } {
  const entry = policy?.[type] ?? DEFAULT_IMAGE_POLICY[type];
  const bodyCap = entry.body === "off" ? 0 : entry.body === "auto" ? AUTO_BODY_CAP : entry.body;
  return { cover: entry.cover, bodyCap };
}

const EntrySchema = z.object({
  cover: z.boolean(),
  body: z.union([z.literal("off"), z.literal("auto"), z.literal(1), z.literal(2), z.literal(3)]),
});

const ImagePolicySchema = z
  .object({
    blog_post: EntrySchema.optional(),
    product_update: EntrySchema.optional(),
    social_post: EntrySchema.optional(),
  })
  .strict();

/** Client input for the save action; null when invalid. */
export function parseImagePolicy(input: unknown): ImagePolicy | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const result = ImagePolicySchema.safeParse(input);
  return result.success ? result.data : null;
}
