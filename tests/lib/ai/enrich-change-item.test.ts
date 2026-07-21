import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from "vitest";

vi.mock("ai", () => ({ generateObject: vi.fn() }));

import { generateObject } from "ai";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, llmUsage } from "../../../src/db/schema";
import { buildEnrichmentPrompt, enrichChangeItem } from "../../../src/lib/ai/enrich-change-item";

const TENANT = "Enrich Change Item Test Tenant";
let tenantId = "00000000-0000-0000-0000-000000000000";

describe("buildEnrichmentPrompt", () => {
  it("includes commit message and diff for commit-sourced items", () => {
    const prompt = buildEnrichmentPrompt({
      tenantId,
      type: "commit",
      repoName: "acme/api",
      commitMessage: "fix export timeout",
      diff: "diff --git a/x b/x\n+fix",
    });
    expect(prompt).toContain("acme/api");
    expect(prompt).toContain("fix export timeout");
    expect(prompt).toContain("diff --git a/x b/x");
  });

  it("includes PR title and description for pr-sourced items", () => {
    const prompt = buildEnrichmentPrompt({
      tenantId,
      type: "pull_request",
      repoName: "acme/web",
      prTitle: "Add dark mode",
      prDescription: "Adds a toggle.",
    });
    expect(prompt).toContain("acme/web");
    expect(prompt).toContain("Add dark mode");
    expect(prompt).toContain("Adds a toggle.");
  });
});

describe("enrichChangeItem", () => {
  // Reset AFTER each test, not before: resetting a mock in beforeEach makes
  // vitest surface an awaited-and-caught rejection as an unhandled error,
  // spuriously failing the fail-open test even though the module catches it.
  beforeAll(async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    tenantId = tenant.id;
  });
  afterAll(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });
  afterEach(() => vi.mocked(generateObject).mockReset());

  it("maps a user-facing model result through", async () => {
    vi.mocked(generateObject).mockResolvedValue({
      object: { userFacing: true, impactSummary: "Exports finish faster", suggestedCategory: "improved", confidence: 0.8 },
    } as never);

    const result = await enrichChangeItem({ tenantId, type: "commit", repoName: "acme/api", commitMessage: "x", diff: "y" });
    expect(result).toEqual({
      userFacing: true,
      impactSummary: "Exports finish faster",
      suggestedCategory: "improved",
      confidence: 0.8,
    });

    // The mock above supplies no `usage` — the row must still be written, with
    // null token counts, rather than the missing usage failing the enrichment.
    const [row] = await db.select().from(llmUsage).where(eq(llmUsage.tenantId, tenantId));
    expect(row).toMatchObject({ operation: "enrichment", inputTokens: null, outputTokens: null, totalTokens: null });
  });

  it("nulls impact and category when the model says not user-facing", async () => {
    vi.mocked(generateObject).mockResolvedValue({
      object: { userFacing: false, impactSummary: "internal refactor", suggestedCategory: "improved", confidence: 0.95 },
    } as never);

    const result = await enrichChangeItem({ tenantId, type: "commit", repoName: "acme/api", commitMessage: "refactor", diff: "z" });
    expect(result).toEqual({ userFacing: false, impactSummary: null, suggestedCategory: null, confidence: 0.95 });
  });

  it("fails open to user-facing when the model throws", async () => {
    vi.mocked(generateObject).mockRejectedValue(new Error("model down"));

    const result = await enrichChangeItem({ tenantId, type: "pull_request", repoName: "acme/web", prTitle: "t", prDescription: "d" });
    expect(result).toEqual({ userFacing: true, impactSummary: null, suggestedCategory: null, confidence: null });
  });
});
