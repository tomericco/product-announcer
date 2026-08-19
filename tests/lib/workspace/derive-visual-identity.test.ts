import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

vi.mock("ai", () => ({ generateObject: vi.fn() }));

import { generateObject } from "ai";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { llmUsage } from "../../../src/db/schema";
import { seedTenant, dropTenant } from "../../helpers/fixtures";
import {
  extractColorCandidates,
  analyzeVisualIdentity,
  deriveVisualIdentityFromPage,
} from "../../../src/lib/workspace/derive-visual-identity";
import { DEFAULT_VISUAL_IDENTITY } from "../../../src/lib/images/visual-identity";

const TENANT = "Derive Visual Identity Test Tenant";
let tenantId: string;

const HTML = `
<html><head>
<meta name="theme-color" content="#1A73E8">
<style>
  body { background: #FFF; color: #202124; }
  .btn { background: #1a73e8; border-color: #1a73e8; }
  .accent { color: rgb(251, 188, 4); }
</style>
</head><body>
<div style="color:#202124;background:#fff">Hello</div>
<p style="border: 1px solid #202124">World</p>
</body></html>`;

describe("extractColorCandidates", () => {
  it("normalises hex and rgb(), weights theme-color, and orders by frequency", () => {
    const colors = extractColorCandidates(HTML);
    expect(colors[0]).toBe("#1a73e8"); // 2 in css + theme-color weight
    expect(colors).toContain("#ffffff");
    expect(colors).toContain("#202124");
    expect(colors).toContain("#fbbc04");
    expect(new Set(colors).size).toBe(colors.length);
    expect(colors.indexOf("#202124")).toBeLessThan(colors.indexOf("#fbbc04"));
  });

  it("caps the list and returns [] for colorless html", () => {
    expect(extractColorCandidates(HTML, 2)).toHaveLength(2);
    expect(extractColorCandidates("<p>no colors</p>")).toEqual([]);
  });
});

describe("analyzeVisualIdentity / deriveVisualIdentityFromPage", () => {
  beforeAll(async () => {
    tenantId = (await seedTenant(TENANT)).id;
  });
  afterAll(async () => {
    await dropTenant(TENANT);
  });
  beforeEach(() => {
    vi.mocked(generateObject).mockReset();
  });

  it("returns the model's proposal and records brand_analysis usage", async () => {
    const proposal = {
      palette: [{ hex: "#1a73e8", role: "primary" }, { hex: "#ffffff", role: "background" }, { hex: "#fbbc04", role: "accent" }],
      stylePreset: "flat",
      moodWords: ["bold", "friendly"],
    };
    vi.mocked(generateObject).mockResolvedValue({ object: proposal, usage: { inputTokens: 3 } } as never);
    expect(await analyzeVisualIdentity("page text", ["#1a73e8"], tenantId)).toEqual(proposal);
    const rows = await db.select().from(llmUsage).where(eq(llmUsage.tenantId, tenantId));
    expect(rows.at(-1)).toMatchObject({ operation: "brand_analysis", inputTokens: 3 });
  });

  it("returns null when the model throws", async () => {
    vi.mocked(generateObject).mockRejectedValue(new Error("down"));
    expect(await analyzeVisualIdentity("t", [], tenantId)).toBeNull();
  });

  it("derives a full identity: proposal merged over the defaults", async () => {
    const scrape = vi.fn(async () => ({ text: "We build calm tools", html: HTML, finalUrl: "https://x.y/", contentType: "text/html", truncated: false }));
    const analyze = vi.fn(async (_pageText: string, _candidates: string[]) => ({
      palette: [{ hex: "#1a73e8", role: "primary" as const }, { hex: "#ffffff", role: "background" as const }, { hex: "#fbbc04", role: "accent" as const }],
      stylePreset: "geometric" as const,
      moodWords: ["calm"],
    }));

    const result = await deriveVisualIdentityFromPage(tenantId, "https://x.y", { scrape, analyze });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.identity.stylePreset).toBe("geometric");
    expect(result.identity.moodWords).toEqual(["calm"]);
    expect(result.identity.palette).toHaveLength(3);
    expect(result.identity.imageGenerationRules).toEqual(DEFAULT_VISUAL_IDENTITY.imageGenerationRules);
    expect(result.identity.pinStyleToCover).toBe(true);
    // The analyzer got the extracted candidates.
    expect(analyze.mock.calls[0][1]).toContain("#1a73e8");
  });

  it("falls back to a heuristic palette from the extracted colors when the model fails", async () => {
    const scrape = vi.fn(async () => ({ text: "t", html: HTML, finalUrl: "https://x.y/", contentType: "text/html", truncated: false }));
    const analyze = vi.fn(async () => null);
    const result = await deriveVisualIdentityFromPage(tenantId, "https://x.y", { scrape, analyze });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.identity.stylePreset).toBe("flat");
    expect(result.identity.palette.map((p) => p.hex)).toEqual(extractColorCandidates(HTML, 4));
    expect(result.identity.palette.map((p) => p.role)).toEqual(["primary", "secondary", "accent", "neutral"]);
  });

  it("reports the scrape error", async () => {
    const scrape = vi.fn(async () => ({ error: "blocked" as const }));
    expect(await deriveVisualIdentityFromPage(tenantId, "http://10.0.0.1", { scrape })).toEqual({ ok: false, reason: "blocked" });
  });

  it("reports no-colors when the page yields nothing and the model fails", async () => {
    const scrape = vi.fn(async () => ({ text: "t", html: "<p>plain</p>", finalUrl: "https://x.y/", contentType: "text/html", truncated: false }));
    const analyze = vi.fn(async () => null);
    expect(await deriveVisualIdentityFromPage(tenantId, "https://x.y", { scrape, analyze })).toEqual({ ok: false, reason: "no-colors" });
  });
});
