import { describe, it, expect, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, llmUsage } from "../../../src/db/schema";
import { recordLlmUsage } from "../../../src/lib/ai/llm-usage";

const NAME = "LLM Usage Test Tenant";

describe("recordLlmUsage", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, NAME));
    vi.restoreAllMocks();
  });

  async function seed() {
    const [tenant] = await db.insert(tenants).values({ name: NAME }).returning();
    return tenant;
  }

  it("writes a row with the operation, model and token counts", async () => {
    const tenant = await seed();

    await recordLlmUsage({
      tenantId: tenant.id,
      operation: "generation",
      model: "claude-sonnet-4-5",
      usage: { inputTokens: 120, outputTokens: 45, totalTokens: 165 },
    });

    const [row] = await db.select().from(llmUsage).where(eq(llmUsage.tenantId, tenant.id));
    expect(row).toMatchObject({
      operation: "generation",
      model: "claude-sonnet-4-5",
      inputTokens: 120,
      outputTokens: 45,
      totalTokens: 165,
    });
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  it("writes nulls when usage is missing or partial", async () => {
    const tenant = await seed();

    await recordLlmUsage({ tenantId: tenant.id, operation: "enrichment", model: "claude-haiku-4-5" });
    await recordLlmUsage({
      tenantId: tenant.id,
      operation: "review",
      model: "claude-sonnet-4-5",
      usage: { inputTokens: 10 },
    });

    const rows = await db.select().from(llmUsage).where(eq(llmUsage.tenantId, tenant.id));
    const missing = rows.find((r) => r.operation === "enrichment")!;
    const partial = rows.find((r) => r.operation === "review")!;

    expect(missing.inputTokens).toBeNull();
    expect(missing.outputTokens).toBeNull();
    expect(missing.totalTokens).toBeNull();
    expect(partial.inputTokens).toBe(10);
    expect(partial.outputTokens).toBeNull();
  });

  it("never throws when the insert fails", async () => {
    // A tenant id that violates the foreign key -- the insert must fail, and the
    // failure must be swallowed so accounting can't break a generation.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      recordLlmUsage({
        tenantId: "00000000-0000-0000-0000-000000000000",
        operation: "generation",
        model: "claude-sonnet-4-5",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      })
    ).resolves.toBeUndefined();

    expect(consoleError).toHaveBeenCalled();
  });

  it("records an image count for image_generation rows and null tokens", async () => {
    const tenant = await seed();

    await recordLlmUsage({
      tenantId: tenant.id,
      operation: "image_generation",
      model: "gpt-image-2",
      imageCount: 1,
    });

    const [row] = await db.select().from(llmUsage).where(eq(llmUsage.tenantId, tenant.id));
    expect(row).toMatchObject({ operation: "image_generation", model: "gpt-image-2", imageCount: 1, inputTokens: null });
  });

  it("stores a null image count on text rows", async () => {
    const tenant = await seed();
    await recordLlmUsage({ tenantId: tenant.id, operation: "illustration_plan", model: "claude-sonnet-4-5", usage: { inputTokens: 5 } });
    const [row] = await db.select().from(llmUsage).where(eq(llmUsage.tenantId, tenant.id));
    expect(row.imageCount).toBeNull();
    expect(row.inputTokens).toBe(5);
  });
});
