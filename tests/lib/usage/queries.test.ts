import { describe, it, expect, afterEach } from "vitest";
import { db } from "../../../src/db";
import { llmUsage } from "../../../src/db/schema";
import { seedTenant, dropTenant } from "../../helpers/fixtures";
import {
  bucketKeys,
  creditsByFeature,
  creditsByPeriod,
  monthToDateCredits,
  windowStart,
} from "../../../src/lib/usage/queries";

const NAME = "Usage Queries Test Tenant";
const NOW = new Date("2026-08-28T10:00:00Z"); // a Friday; ISO week starts Mon 2026-08-24

afterEach(async () => {
  await dropTenant(NAME);
});

async function seedRow(
  tenantId: string,
  overrides: Partial<typeof llmUsage.$inferInsert> = {}
) {
  await db.insert(llmUsage).values({
    tenantId,
    operation: "generation",
    model: "claude-sonnet-4-5",
    inputTokens: 80,
    outputTokens: 20,
    totalTokens: 100,
    createdAt: new Date("2026-08-28T09:00:00Z"),
    ...overrides,
  });
}

describe("bucketKeys", () => {
  it("produces 30 daily keys ending today (UTC)", () => {
    const keys = bucketKeys("daily", NOW);
    expect(keys).toHaveLength(30);
    expect(keys[29]).toBe("2026-08-28");
    expect(keys[0]).toBe("2026-07-30");
  });

  it("produces 12 weekly keys of ISO Mondays ending this week", () => {
    const keys = bucketKeys("weekly", NOW);
    expect(keys).toHaveLength(12);
    expect(keys[11]).toBe("2026-08-24"); // Monday of NOW's week
    expect(keys[10]).toBe("2026-08-17");
  });

  it("produces 12 monthly keys ending this month", () => {
    const keys = bucketKeys("monthly", NOW);
    expect(keys).toHaveLength(12);
    expect(keys[11]).toBe("2026-08");
    expect(keys[0]).toBe("2025-09");
  });
});

describe("creditsByPeriod", () => {
  it("sums total_tokens per UTC day per feature", async () => {
    const tenant = await seedTenant(NAME);
    await seedRow(tenant.id); // generation, 100, 2026-08-28
    await seedRow(tenant.id, { operation: "brief_draft", totalTokens: 50 }); // same feature
    await seedRow(tenant.id, { operation: "review", totalTokens: 7 });
    // 23:30 UTC on the 27th is already the 28th in the test TZ (Asia/Jerusalem);
    // it must land in the 27th's bucket, because buckets are UTC.
    await seedRow(tenant.id, { createdAt: new Date("2026-08-27T23:30:00Z"), totalTokens: 9 });

    const points = await creditsByPeriod(tenant.id, "daily", NOW);
    const on28 = points.filter((p) => p.bucket === "2026-08-28");
    expect(on28).toContainEqual({ bucket: "2026-08-28", feature: "content_generation", credits: 150 });
    expect(on28).toContainEqual({ bucket: "2026-08-28", feature: "review_revision", credits: 7 });
    expect(points).toContainEqual({ bucket: "2026-08-27", feature: "content_generation", credits: 9 });
  });

  it("excludes ai_visibility_engine rows and rows outside the window", async () => {
    const tenant = await seedTenant(NAME);
    await seedRow(tenant.id, { operation: "ai_visibility_engine", totalTokens: 999_999 });
    await seedRow(tenant.id, { createdAt: new Date("2026-06-01T00:00:00Z"), totalTokens: 888 });
    await seedRow(tenant.id, { totalTokens: 5 });

    const points = await creditsByPeriod(tenant.id, "daily", NOW);
    expect(points.reduce((sum, p) => sum + p.credits, 0)).toBe(5);
  });

  it("counts null-token rows as zero and routes unknown operations to other", async () => {
    const tenant = await seedTenant(NAME);
    await seedRow(tenant.id, { totalTokens: null, inputTokens: null, outputTokens: null });
    await seedRow(tenant.id, { operation: "brand_new_op", totalTokens: 3 });

    const points = await creditsByPeriod(tenant.id, "daily", NOW);
    expect(points).toContainEqual({ bucket: "2026-08-28", feature: "other", credits: 3 });
    const generation = points.find((p) => p.feature === "content_generation");
    expect(generation?.credits ?? 0).toBe(0); // the null row contributed nothing
  });

  it("buckets weekly rows onto their ISO Monday", async () => {
    const tenant = await seedTenant(NAME);
    await seedRow(tenant.id, { createdAt: new Date("2026-08-26T12:00:00Z"), totalTokens: 40 });

    const points = await creditsByPeriod(tenant.id, "weekly", NOW);
    expect(points).toContainEqual({ bucket: "2026-08-24", feature: "content_generation", credits: 40 });
  });

  it("scopes to the tenant", async () => {
    const tenant = await seedTenant(NAME);
    const other = await seedTenant(`${NAME} Neighbour`);
    await seedRow(other.id, { totalTokens: 777 });
    const points = await creditsByPeriod(tenant.id, "daily", NOW);
    expect(points).toHaveLength(0);
    await dropTenant(`${NAME} Neighbour`);
  });
});

describe("creditsByFeature", () => {
  it("totals the window per feature, descending", async () => {
    const tenant = await seedTenant(NAME);
    await seedRow(tenant.id, { totalTokens: 10 });
    await seedRow(tenant.id, { operation: "review", totalTokens: 30 });

    const rows = await creditsByFeature(tenant.id, "daily", NOW);
    expect(rows[0]).toEqual({ feature: "review_revision", credits: 30 });
    expect(rows[1]).toEqual({ feature: "content_generation", credits: 10 });
  });
});

describe("monthToDateCredits", () => {
  it("sums the current UTC calendar month, excluding BYOK rows", async () => {
    const tenant = await seedTenant(NAME);
    await seedRow(tenant.id, { totalTokens: 100 });
    await seedRow(tenant.id, { createdAt: new Date("2026-08-01T00:00:00Z"), totalTokens: 11 });
    await seedRow(tenant.id, { createdAt: new Date("2026-07-31T23:59:00Z"), totalTokens: 500 });
    await seedRow(tenant.id, { operation: "ai_visibility_engine", totalTokens: 9_000 });

    expect(await monthToDateCredits(tenant.id, NOW)).toBe(111);
  });
});

describe("windowStart", () => {
  it("is UTC midnight boundaries for all three granularities", () => {
    expect(windowStart("daily", NOW).toISOString()).toBe("2026-07-30T00:00:00.000Z");
    expect(windowStart("weekly", NOW).toISOString()).toBe("2026-06-08T00:00:00.000Z");
    expect(windowStart("monthly", NOW).toISOString()).toBe("2025-09-01T00:00:00.000Z");
  });
});
