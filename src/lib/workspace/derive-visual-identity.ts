import { generateObject } from "ai";
import { z } from "zod";
import type { PaletteRole, VisualIdentity } from "@/db/schema";
import { resolveModel, modelId } from "@/lib/ai/model";
import { recordLlmUsage } from "@/lib/ai/llm-usage";
import { fetchPageText, type PageResult } from "@/lib/workspace/fetch-page";
import { DEFAULT_VISUAL_IDENTITY, MAX_PALETTE, MIN_READY_PALETTE } from "@/lib/images/visual-identity";

// Same MAX_SCAN_CHARS posture as fetch-page.ts: fetchPageText already clamps
// `html` to 200KB, but this is exported and a caller may pass raw HTML.
const MAX_SCAN_CHARS = 200_000;
const THEME_COLOR_WEIGHT = 5;
const DEFAULT_MAX_CANDIDATES = 8;

function normalizeHex(raw: string): string | null {
  const hex = raw.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(hex)) return hex;
  if (/^#[0-9a-f]{3}$/.test(hex)) return `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`;
  return null;
}

function rgbToHex(r: number, g: number, b: number): string | null {
  if ([r, g, b].some((c) => !Number.isInteger(c) || c < 0 || c > 255)) return null;
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Candidate palette from a page's markup, most frequent first. Regex over
 * <style> blocks and inline style attributes plus the theme-color meta —
 * deliberately no linked-stylesheet fetches (a second request per sheet and a
 * new SSRF surface for a proposal the user confirms anyway; spec §2 names
 * Brandfetch as the fallback if this disappoints).
 */
export function extractColorCandidates(html: string, max = DEFAULT_MAX_CANDIDATES): string[] {
  const scanned = html.slice(0, MAX_SCAN_CHARS);
  const counts = new Map<string, number>();
  const bump = (hex: string | null, by = 1) => {
    if (hex) counts.set(hex, (counts.get(hex) ?? 0) + by);
  };

  const sources: string[] = [];
  for (const m of scanned.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) sources.push(m[1]);
  for (const m of scanned.matchAll(/\bstyle\s*=\s*["']([^"']*)["']/gi)) sources.push(m[1]);

  for (const css of sources) {
    for (const m of css.matchAll(/#[0-9a-f]{3}\b|#[0-9a-f]{6}\b/gi)) bump(normalizeHex(m[0]));
    for (const m of css.matchAll(/rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/gi)) {
      bump(rgbToHex(Number(m[1]), Number(m[2]), Number(m[3])));
    }
  }

  const theme = scanned.match(/<meta\b[^>]*\bname\s*=\s*["']theme-color["'][^>]*\bcontent\s*=\s*["']([^"']+)["']/i);
  if (theme) bump(normalizeHex(theme[1]), THEME_COLOR_WEIGHT);

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([hex]) => hex);
}

const PaletteRoleSchema = z.enum(["primary", "secondary", "accent", "background", "neutral"]);

export const DerivedVisualIdentitySchema = z.object({
  palette: z.array(z.object({ hex: z.string(), role: PaletteRoleSchema })),
  stylePreset: z.enum(["flat", "geometric", "line_art", "isometric", "gradient", "duotone", "hand_drawn"]),
  moodWords: z.array(z.string()),
});
export type DerivedVisualIdentity = z.infer<typeof DerivedVisualIdentitySchema>;

const ANALYSIS_SYSTEM = [
  "You look at the text of a company's website and the colors most used in its markup, and propose a visual",
  "identity for flat marketing illustrations that would sit naturally on that site.",
  `Pick ${MIN_READY_PALETTE}-${MAX_PALETTE} colors from the candidates (hex, lowercase, #rrggbb) and give each ONE role:`,
  "primary (the dominant brand color), secondary, accent (small highlights), background (the ground most images sit on),",
  "neutral (outlines/shadows). Prefer the candidates; only invent a color if the candidates lack a usable background or neutral.",
  "Choose the style preset that best matches the brand's register, and 2-4 short lowercase mood words.",
].join(" ");

export function buildVisualIdentityPrompt(pageText: string, candidates: string[]): string {
  return [
    `Most-used colors on the site, most frequent first: ${candidates.length > 0 ? candidates.join(", ") : "(none found)"}.`,
    "",
    "Website text:",
    pageText.slice(0, 6000),
  ].join("\n");
}

/** Null on any model failure — the caller falls back to a heuristic palette. */
export async function analyzeVisualIdentity(
  pageText: string,
  candidates: string[],
  tenantId: string
): Promise<DerivedVisualIdentity | null> {
  try {
    const spec = process.env.ONBOARDING_ANALYSIS_MODEL ?? "anthropic/claude-sonnet-4-5";
    const { object, usage } = await generateObject({
      model: resolveModel(spec),
      schema: DerivedVisualIdentitySchema,
      system: ANALYSIS_SYSTEM,
      prompt: buildVisualIdentityPrompt(pageText, candidates),
    });
    await recordLlmUsage({ tenantId, operation: "brand_analysis", model: modelId(spec), usage });
    return object;
  } catch {
    return null;
  }
}

export type DeriveVisualIdentityDeps = {
  scrape?: (url: string) => Promise<PageResult>;
  analyze?: (pageText: string, candidates: string[], tenantId: string) => Promise<DerivedVisualIdentity | null>;
};

const HEURISTIC_ROLES: PaletteRole[] = ["primary", "secondary", "accent", "neutral", "background", "secondary"];

/**
 * Website bootstrap (spec §2): scrape → extract colors → LLM proposal →
 * a full VisualIdentity draft merged over the defaults. Writes NOTHING: the
 * card prefills from this and the user confirms with Save, mirroring
 * `importBrandStyleForTenant`'s derive → prefill → confirm flow.
 */
export async function deriveVisualIdentityFromPage(
  tenantId: string,
  url: string,
  deps: DeriveVisualIdentityDeps = {}
): Promise<{ ok: true; identity: VisualIdentity } | { ok: false; reason: string }> {
  const scrape = deps.scrape ?? fetchPageText;
  const analyze = deps.analyze ?? analyzeVisualIdentity;

  const scraped = await scrape(url);
  if ("error" in scraped) return { ok: false, reason: scraped.error };

  const candidates = extractColorCandidates(scraped.html);
  const proposal = await analyze(scraped.text, candidates, tenantId);

  if (proposal) {
    const palette = proposal.palette
      .map((p) => ({ hex: normalizeHex(p.hex), role: p.role }))
      .filter((p): p is { hex: string; role: PaletteRole } => p.hex !== null)
      .slice(0, MAX_PALETTE);
    if (palette.length > 0) {
      return {
        ok: true,
        identity: {
          ...DEFAULT_VISUAL_IDENTITY,
          palette,
          stylePreset: proposal.stylePreset,
          moodWords: proposal.moodWords.map((w) => w.trim().toLowerCase()).filter(Boolean).slice(0, 4),
        },
      };
    }
  }

  if (candidates.length === 0) return { ok: false, reason: "no-colors" };
  const heuristic = candidates.slice(0, 4).map((hex, i) => ({ hex, role: HEURISTIC_ROLES[i] }));
  return { ok: true, identity: { ...DEFAULT_VISUAL_IDENTITY, palette: heuristic } };
}
