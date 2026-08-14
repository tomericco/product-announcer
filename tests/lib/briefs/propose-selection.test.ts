import { describe, it, expect, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, signals } from "../../../src/db/schema";

const TENANT = "Propose Selection Test Tenant";
const OTHER_TENANT = "Propose Selection Other Tenant";

vi.mock("../../../src/lib/ai/llm-usage", () => ({ recordLlmUsage: vi.fn(async () => {}) }));

import { proposeBriefForSelection } from "../../../src/lib/briefs/propose-selection";

afterEach(async () => {
  await db.delete(tenants).where(eq(tenants.name, TENANT));
  await db.delete(tenants).where(eq(tenants.name, OTHER_TENANT));
  vi.clearAllMocks();
});

async function seedTenant(name: string) {
  const [tenant] = await db.insert(tenants).values({ name }).returning();
  return tenant;
}

async function seedSignal(tenantId: string, title = "Evidence") {
  const [row] = await db
    .insert(signals)
    .values({ tenantId, kind: "manual", externalId: crypto.randomUUID(), title, occurredAt: new Date() })
    .returning();
  return row;
}

const GOOD_PROPOSAL = {
  contentType: "blog_post" as const,
  title: "A proposed title",
  angle: "A sharp angle",
  whyNow: "Because of the signal",
  audience: null,
  keyPoints: ["One.", "Two.", "Three."],
  targetLength: 700,
  suggestedChannel: "blog",
  score: 0.7,
  scoreRationale: "Strong evidence, clear angle.",
};

describe("proposeBriefForSelection", () => {
  it("resolves the signal tenant-scoped and maps a successful proposal onto ManualBriefInput's shape", async () => {
    const tenant = await seedTenant(TENANT);
    const signal = await seedSignal(tenant.id);

    const generate = vi.fn(async () => ({ object: GOOD_PROPOSAL, usage: {} }));
    const result = await proposeBriefForSelection(tenant.id, [signal.id], { generate: generate as never });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input).toEqual({
      contentType: "blog_post",
      title: "A proposed title",
      angle: "A sharp angle",
      whyNow: "Because of the signal",
      keyPoints: ["One.", "Two.", "Three."],
      suggestedChannel: "blog",
      targetLength: 700,
      audience: null,
      score: 0.7,
      scoreRationale: "Strong evidence, clear angle.",
      signalIds: [signal.id],
    });
  });

  it("refuses another tenant's signal ids, asserted by id, and never lets its title reach the model", async () => {
    const mine = await seedTenant(TENANT);
    const theirs = await seedTenant(OTHER_TENANT);
    const theirSignal = await seedSignal(theirs.id, "Their secret title");

    const generate = vi.fn(async () => ({ object: GOOD_PROPOSAL, usage: {} }));
    const result = await proposeBriefForSelection(mine.id, [theirSignal.id], { generate: generate as never });

    expect(result.ok).toBe(false);
    // The strongest form of this claim: the model was never even asked,
    // because the other tenant's signal never resolved under `mine.id` — not
    // merely "the result doesn't mention it," which a lucky model output
    // could satisfy by accident.
    expect(generate).not.toHaveBeenCalled();
  });

  it("returns the model's reason on a proposal failure", async () => {
    const tenant = await seedTenant(TENANT);
    const signal = await seedSignal(tenant.id);

    const generate = vi.fn(async () => {
      throw new Error("model timeout");
    });
    const result = await proposeBriefForSelection(tenant.id, [signal.id], { generate: generate as never });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("model timeout");
  });
});
