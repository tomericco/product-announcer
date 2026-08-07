import { describe, it, expect, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, contentPieces, competitors, companyProfiles } from "../../../src/db/schema";
import { generateDraftForPiece, findNamedCompanies, MIN_COMPETITOR_NAME_LENGTH } from "../../../src/lib/briefs/draft";

const TENANT = "Brief Draft Test Tenant";

afterEach(async () => {
  await db.delete(tenants).where(eq(tenants.name, TENANT));
  vi.restoreAllMocks();
});

async function seedTenant() {
  const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
  await db.insert(companyProfiles).values({ tenantId: tenant.id, topics: [] });
  return tenant;
}

async function seedPiece(tenantId: string, overrides: Partial<typeof contentPieces.$inferInsert> = {}) {
  const [piece] = await db
    .insert(contentPieces)
    .values({
      tenantId,
      type: "blog_post",
      title: "Scaffold title",
      body: "SCAFFOLD BODY",
      status: "brief",
      ...overrides,
    })
    .returning();
  return piece;
}

describe("findNamedCompanies", () => {
  it("matches case-insensitively on a word boundary", () => {
    expect(findNamedCompanies("We admire Phrase a lot.", ["phrase"])).toEqual(["phrase"]);
    expect(findNamedCompanies("A PHRASE-based tool.", ["Phrase"])).toHaveLength(1);
  });

  it("does not match a name inside another word", () => {
    // The reason this function exists rather than a bare `includes`.
    expect(findNamedCompanies("A quilted jacket.", ["Lilt"])).toEqual([]);
    expect(findNamedCompanies("Deposit the cheque.", ["Posit"])).toEqual([]);
  });

  it("skips names too short to match safely", () => {
    const short = "a".repeat(MIN_COMPETITOR_NAME_LENGTH - 1);
    expect(findNamedCompanies(`${short} word here`, [short])).toEqual([]);
  });
});

describe("generateDraftForPiece", () => {
  it("writes the generated draft and promotes the piece to draft", async () => {
    const tenant = await seedTenant();
    const piece = await seedPiece(tenant.id);
    const generate = vi.fn(async () => ({ title: "Real title", body: "Real body." }));

    const result = await generateDraftForPiece(piece.id, tenant.id, { database: db, generate });
    expect(result.ok).toBe(true);

    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(after.status).toBe("draft");
    expect(after.body).toBe("Real body.");
    expect(after.generatedAt).toBeInstanceOf(Date);
    expect(after.generationError).toBeNull();
  });

  it("keeps the scaffold and records the reason when generation throws", async () => {
    const tenant = await seedTenant();
    const piece = await seedPiece(tenant.id);
    const generate = vi.fn(async () => {
      throw new Error("model timeout");
    });

    const result = await generateDraftForPiece(piece.id, tenant.id, { database: db, generate });
    expect(result.ok).toBe(false);

    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    // The human's decision must survive. Status stays "brief" so the Generate
    // button offers a retry, and the scaffold is still there to read.
    expect(after.status).toBe("brief");
    expect(after.body).toBe("SCAFFOLD BODY");
    expect(after.generationError).toContain("model timeout");
    expect(after.generatedAt).toBeNull();
  });

  it("warns but keeps the draft when a competitor name survives into the copy", async () => {
    const tenant = await seedTenant();
    await db.insert(competitors).values({ tenantId: tenant.id, name: "Phrase" });
    const piece = await seedPiece(tenant.id);
    const generate = vi.fn(async () => ({ title: "T", body: "As Phrase showed last week…" }));

    const result = await generateDraftForPiece(piece.id, tenant.id, { database: db, generate });
    expect(result.ok).toBe(true);

    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    // Detection, not blocking. Discarding a good draft on a false positive
    // would be worse than the leak it guards against.
    expect(after.status).toBe("draft");
    expect(after.body).toContain("Phrase");
    expect(after.generationError).toContain("Phrase");
  });

  it("refuses to overwrite a body a human has edited", async () => {
    const tenant = await seedTenant();
    const piece = await seedPiece(tenant.id, { bodyEditedAt: new Date(), body: "HUMAN WORDS" });
    const generate = vi.fn(async () => ({ title: "T", body: "Machine words." }));

    const result = await generateDraftForPiece(piece.id, tenant.id, { database: db, generate });
    expect(result.ok).toBe(false);
    expect(generate).not.toHaveBeenCalled();

    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(after.body).toBe("HUMAN WORDS");
  });

  it("refuses a piece belonging to another tenant", async () => {
    const mine = await seedTenant();
    const [other] = await db.insert(tenants).values({ name: TENANT }).returning();
    const theirs = await seedPiece(other.id);
    const generate = vi.fn(async () => ({ title: "T", body: "B" }));

    const result = await generateDraftForPiece(theirs.id, mine.id, { database: db, generate });
    expect(result.ok).toBe(false);
    expect(generate).not.toHaveBeenCalled();
  });
});
