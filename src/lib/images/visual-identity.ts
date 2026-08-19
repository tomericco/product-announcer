import { z } from "zod";
import type { ImageRule, PaletteRole, VisualIdentity } from "@/db/schema";

// Type-only import from the schema above: this module is imported by the
// "use client" Visual identity editor, so it must never pull drizzle in.

export const MAX_PALETTE = 6;
export const MIN_READY_PALETTE = 3;
export const MAX_REFERENCE_IMAGES = 4;
export const MAX_CUSTOM_DESCRIPTORS = 200;
export const MAX_MOOD_WORDS = 4;

export const STYLE_PRESETS = [
  { value: "flat", label: "Flat" },
  { value: "geometric", label: "Geometric" },
  { value: "line_art", label: "Line art" },
  { value: "isometric", label: "Isometric" },
  { value: "gradient", label: "Gradient" },
  { value: "duotone", label: "Duotone" },
  { value: "hand_drawn", label: "Hand-drawn" },
] as const satisfies readonly { value: VisualIdentity["stylePreset"]; label: string }[];

export const BACKGROUND_TREATMENTS = [
  { value: "solid", label: "Solid color" },
  { value: "subtle_pattern", label: "Subtle pattern" },
  { value: "scene", label: "Scene" },
] as const satisfies readonly { value: VisualIdentity["backgroundTreatment"]; label: string }[];

export const TEXTURES = [
  { value: "none", label: "None" },
  { value: "grain", label: "Grain" },
  { value: "paper", label: "Paper" },
  { value: "halftone", label: "Halftone" },
] as const satisfies readonly { value: VisualIdentity["texture"]; label: string }[];

export const PEOPLE_STYLES = [
  { value: "none", label: "No people" },
  { value: "abstract_figures", label: "Abstract figures" },
  { value: "diverse_characters", label: "Diverse characters" },
] as const satisfies readonly { value: VisualIdentity["peopleStyle"]; label: string }[];

export const PALETTE_ROLES = [
  { value: "primary", label: "Primary" },
  { value: "secondary", label: "Secondary" },
  { value: "accent", label: "Accent" },
  { value: "background", label: "Background" },
  { value: "neutral", label: "Neutral" },
] as const satisfies readonly { value: PaletteRole; label: string }[];

/** Spec §2 defaults. The palette has no default — it must be extracted or typed. */
export const DEFAULT_VISUAL_IDENTITY: Omit<VisualIdentity, "palette"> = {
  stylePreset: "flat",
  moodWords: ["clean", "modern"],
  allowTextInImages: false,
  styleReferenceImages: [],
  customStyleDescriptors: "",
  imageGenerationRules: [
    { kind: "dont", text: "no photorealism" },
    { kind: "dont", text: "no stock-photo look" },
    { kind: "dont", text: "no 3D render" },
    { kind: "dont", text: "no clip-art" },
  ],
  backgroundTreatment: "solid",
  texture: "none",
  peopleStyle: "abstract_figures",
  pinStyleToCover: true,
};

// The strongest lever in the prompt (spec §2 research ranking): a fixed
// descriptor phrase per preset keeps every render on tested vocabulary.
const PRESET_PHRASE: Record<VisualIdentity["stylePreset"], string> = {
  flat: "flat vector illustration with clean solid fills and simple shapes",
  geometric: "geometric illustration built from crisp shapes and clean angles",
  line_art: "minimal line-art illustration with consistent stroke weight and sparse fills",
  isometric: "isometric illustration with a consistent 30-degree projection and clean edges",
  gradient: "modern illustration with smooth, subtle gradients and soft shapes",
  duotone: "duotone illustration using two dominant tones with high contrast",
  hand_drawn: "hand-drawn illustration with organic, slightly imperfect lines",
};

const BACKGROUND_PHRASE: Record<VisualIdentity["backgroundTreatment"], string> = {
  solid: "a solid, uniform background",
  subtle_pattern: "a subtle, low-contrast patterned background",
  scene: "a simple environmental scene as the background",
};

const TEXTURE_PHRASE: Record<VisualIdentity["texture"], string> = {
  none: "no texture, perfectly clean fills",
  grain: "a light film-grain texture",
  paper: "a soft paper texture",
  halftone: "a halftone dot texture",
};

const PEOPLE_PHRASE: Record<VisualIdentity["peopleStyle"], string> = {
  none: "no people",
  abstract_figures: "people only as abstract, faceless figures",
  diverse_characters: "diverse stylised characters with simple features",
};

const ROLE_PHRASE: Record<PaletteRole, (hex: string) => string> = {
  primary: (hex) => `${hex} as the primary color`,
  secondary: (hex) => `${hex} as the secondary color`,
  accent: (hex) => `${hex} as an accent`,
  background: (hex) => `${hex} as the background`,
  neutral: (hex) => `${hex} as a neutral for outlines and shadows`,
};

const ROLE_ORDER: PaletteRole[] = ["background", "primary", "secondary", "accent", "neutral"];

/**
 * Turns the identity into ONE prompt paragraph. Generation code consumes only
 * this, so prompt assembly lives in exactly one place. Deterministic: same
 * input, same string — the render row stores the full prompt for
 * reproducibility, so nothing here may depend on time or randomness.
 */
export function compileStyleBlock(vi: VisualIdentity): string {
  const sentences: string[] = [];

  const descriptors = vi.customStyleDescriptors.trim();
  sentences.push(`Style: ${PRESET_PHRASE[vi.stylePreset]}${descriptors ? `; ${descriptors}` : ""}.`);

  if (vi.palette.length > 0) {
    const ordered = [...vi.palette].sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role));
    sentences.push(
      `Palette, used strictly: ${ordered.map((p) => ROLE_PHRASE[p.role](p.hex.toLowerCase())).join(", ")}.`
    );
  }

  if (vi.moodWords.length > 0) sentences.push(`Mood: ${vi.moodWords.join(", ")}.`);
  sentences.push(`Background: ${BACKGROUND_PHRASE[vi.backgroundTreatment]}.`);
  sentences.push(`Texture: ${TEXTURE_PHRASE[vi.texture]}.`);
  sentences.push(`People: ${PEOPLE_PHRASE[vi.peopleStyle]}.`);

  const dos = vi.imageGenerationRules.filter((r) => r.kind === "do").map((r) => r.text.trim()).filter(Boolean);
  const donts = vi.imageGenerationRules.filter((r) => r.kind === "dont").map((r) => r.text.trim()).filter(Boolean);
  if (dos.length > 0) sentences.push(`Always: ${dos.join("; ")}.`);
  if (donts.length > 0) sentences.push(`Never: ${donts.join("; ")}.`);

  // ONE line, always: `customStyleDescriptors` comes from a <Textarea> and rule
  // text is free input, so either can carry newlines, and this block is
  // embedded verbatim in the prompt stored on every render row.
  return sentences.join(" ").replace(/\s+/g, " ").trim();
}

export function isVisualIdentityReady(vi: VisualIdentity | null): boolean {
  return vi !== null && vi.palette.length >= MIN_READY_PALETTE;
}

const HEX = /^#[0-9a-f]{6}$/;

/**
 * Style reference images must be `https://<store-id>.public.blob.vercel-storage.com/…`
 * — the exact host `uploadPng`/`put()` returns (`blob.ts`'s `brandAssetPathname`
 * lives under `tenants/{tenantId}/brand/…` on that same host) and the only host
 * `next.config.ts`'s `images.remotePatterns` allow-lists. Anything else is
 * rejected here rather than trusted as "some URL a tenant typed": `saveVisualIdentity`
 * persists this array verbatim, and `removeStyleReference` later calls `del()`
 * against a pathname derived from it, so an arbitrary host would let one tenant
 * point at (and, via removal, delete) a blob outside this store entirely.
 */
const BLOB_HOST = /\.public\.blob\.vercel-storage\.com$/;
const BLOB_URL_SCHEMA = z.url().refine((s) => {
  try {
    const url = new URL(s);
    return url.protocol === "https:" && BLOB_HOST.test(url.hostname);
  } catch {
    return false;
  }
}, "must be an https URL from this app's blob storage");

const RuleSchema = z.object({
  kind: z.enum(["do", "dont"]),
  text: z.string().transform((s) => s.trim()),
});

const VisualIdentitySchema = z.object({
  palette: z
    .array(
      z.object({
        hex: z
          .string()
          .transform((s) => s.trim().toLowerCase())
          .refine((s) => HEX.test(s), "hex color like #1a73e8"),
        role: z.enum(["primary", "secondary", "accent", "background", "neutral"]),
      })
    )
    .max(MAX_PALETTE),
  stylePreset: z.enum(["flat", "geometric", "line_art", "isometric", "gradient", "duotone", "hand_drawn"]),
  moodWords: z
    .array(z.string())
    .transform((words) => words.map((w) => w.trim()).filter(Boolean).slice(0, MAX_MOOD_WORDS)),
  allowTextInImages: z.boolean(),
  styleReferenceImages: z.array(BLOB_URL_SCHEMA).max(MAX_REFERENCE_IMAGES),
  customStyleDescriptors: z
    .string()
    .transform((s) => s.trim())
    .refine((s) => s.length <= MAX_CUSTOM_DESCRIPTORS, `at most ${MAX_CUSTOM_DESCRIPTORS} characters`),
  imageGenerationRules: z.array(RuleSchema).transform((rules) => rules.filter((r) => r.text.length > 0)),
  backgroundTreatment: z.enum(["solid", "subtle_pattern", "scene"]),
  texture: z.enum(["none", "grain", "paper", "halftone"]),
  peopleStyle: z.enum(["none", "abstract_figures", "diverse_characters"]),
  pinStyleToCover: z.boolean(),
});

/**
 * Validates client input for the save action. A Server Action argument is
 * client input, so this is the same posture as `sanitizePersonas`. Returns
 * null rather than throwing: the action reports "invalid" to the card.
 */
export function parseVisualIdentity(input: unknown): VisualIdentity | null {
  const result = VisualIdentitySchema.safeParse(input);
  if (!result.success) return null;
  // The transforms above already normalised; cast the rule kind back to the
  // schema's ImageRule shape (identical members).
  return result.data as VisualIdentity & { imageGenerationRules: ImageRule[] };
}
