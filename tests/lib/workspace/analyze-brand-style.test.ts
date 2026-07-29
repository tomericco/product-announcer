import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";

vi.mock("ai", () => ({ generateObject: vi.fn() }));

import { generateObject } from "ai";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, llmUsage } from "../../../src/db/schema";
import { buildAnalysisPrompt, analyzeBrandStyle } from "../../../src/lib/workspace/analyze-brand-style";

const TENANT = "Analyze Brand Style Test Tenant";
let tenantId: string;

describe("buildAnalysisPrompt", () => {
  it("includes the page text", () => {
    expect(buildAnalysisPrompt("We shipped dark mode.")).toContain("We shipped dark mode.");
  });
});

describe("analyzeBrandStyle", () => {
  beforeAll(async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    tenantId = tenant.id;
  });
  afterAll(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });
  beforeEach(() => {
    vi.mocked(generateObject).mockReset();
  });

  it("returns the parsed derived profile", async () => {
    const derived = { guidelines: "## Voice and tone\n\nFriendly and plain.", industry: "SaaS" };
    vi.mocked(generateObject).mockResolvedValue({ object: derived } as never);
    expect(await analyzeBrandStyle("text", tenantId)).toEqual(derived);

    // No `usage` in the mock: the row is still recorded, with null token counts.
    const [row] = await db.select().from(llmUsage).where(eq(llmUsage.tenantId, tenantId));
    expect(row).toMatchObject({ operation: "brand_analysis", inputTokens: null, outputTokens: null, totalTokens: null });
  });

  it("records nothing when the model throws", async () => {
    const before = await db.select().from(llmUsage).where(eq(llmUsage.tenantId, tenantId));
    vi.mocked(generateObject).mockRejectedValue(new Error("model down"));
    await analyzeBrandStyle("text", tenantId);
    const after = await db.select().from(llmUsage).where(eq(llmUsage.tenantId, tenantId));
    expect(after).toHaveLength(before.length);
  });

  it("returns an all-empty derivation on model error", async () => {
    vi.mocked(generateObject).mockRejectedValue(new Error("model down"));
    expect(await analyzeBrandStyle("text", tenantId)).toEqual({ guidelines: null, industry: null });
  });
});
