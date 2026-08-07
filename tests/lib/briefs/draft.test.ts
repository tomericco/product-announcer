import { describe, it, expect, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import {
  tenants,
  contentPieces,
  competitors,
  companyProfiles,
  briefs,
  briefSignals,
  signals,
} from "../../../src/db/schema";
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

/**
 * Every content piece `generateDraftForPiece` runs on was created by
 * accepting a brief, so the real path requires a `briefs` row whose
 * `contentPieceId` points back at the piece, plus at least one cited signal
 * joined through `brief_signals` — this is what a real accepted brief looks
 * like, and it's what the earlier round of this task never seeded.
 */
async function seedPieceWithBrief(
  tenantId: string,
  pieceOverrides: Partial<typeof contentPieces.$inferInsert> = {},
  briefOverrides: Partial<typeof briefs.$inferInsert> = {}
) {
  const piece = await seedPiece(tenantId, pieceOverrides);

  const [brief] = await db
    .insert(briefs)
    .values({
      tenantId,
      origin: "agent",
      contentType: "blog_post",
      title: "Brief title",
      angle: "The real angle from the brief.",
      whyNow: "Because the market just shifted.",
      suggestedChannel: "blog",
      keyPoints: ["First point.", "Second point."],
      score: 0.8,
      status: "accepted",
      contentPieceId: piece.id,
      // NOT NULL, no default — omitting either gives an opaque 23502.
      lastEvidenceAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
      ...briefOverrides,
    })
    .returning();

  const [signal] = await db
    .insert(signals)
    .values({
      tenantId,
      kind: "market_news",
      externalId: `evidence-${brief.id}`,
      title: "Cited signal title",
      excerpt: "Cited signal excerpt.",
      occurredAt: new Date(),
    })
    .returning();

  await db.insert(briefSignals).values({ briefId: brief.id, signalId: signal.id });

  return { piece, brief, signal };
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

  it("matches a name that ends in punctuation", () => {
    // \b never fires between two non-word characters (e.g. "+" and a
    // trailing space), so a plain \b...\b wrapper would silently never match
    // "C++" here — the exact worked example this function's own docstring
    // uses.
    expect(findNamedCompanies("We love C++ a lot.", ["C++"])).toEqual(["C++"]);
    expect(findNamedCompanies("We compared C++, then Rust.", ["C++"])).toEqual(["C++"]);
  });

  it("matches a name wrapped entirely in punctuation", () => {
    expect(findNamedCompanies("Use the (x) helper.", ["(x)"])).toEqual(["(x)"]);
  });
});

describe("generateDraftForPiece", () => {
  it("writes the generated draft and promotes the piece to draft", async () => {
    const tenant = await seedTenant();
    const { piece } = await seedPieceWithBrief(tenant.id);
    const generate = vi.fn(async () => ({ title: "Real title", body: "Real body." }));

    const result = await generateDraftForPiece(piece.id, tenant.id, { database: db, generate });
    expect(result.ok).toBe(true);

    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(after.status).toBe("draft");
    expect(after.body).toBe("Real body.");
    expect(after.generatedAt).toBeInstanceOf(Date);
    expect(after.generationError).toBeNull();
  });

  it("sends the brief's own angle, key points, and cited evidence to the generator", async () => {
    const tenant = await seedTenant();
    const { piece, brief, signal } = await seedPieceWithBrief(tenant.id, undefined, {
      angle: "A very specific angle.",
      whyNow: "A very specific reason.",
      keyPoints: ["Alpha point.", "Beta point."],
      targetLength: 500,
    });
    const generate = vi.fn(async () => ({ title: "Real title", body: "Real body." }));

    const result = await generateDraftForPiece(piece.id, tenant.id, { database: db, generate });
    expect(result.ok).toBe(true);

    // The mocked generator ignores its arguments to produce a result — this
    // is the test that actually verifies the commission handed to it is
    // assembled from the brief, not synthesized from the scaffold.
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        brief: expect.objectContaining({
          title: brief.title,
          angle: "A very specific angle.",
          whyNow: "A very specific reason.",
          keyPoints: ["Alpha point.", "Beta point."],
          contentType: brief.contentType,
          targetLength: 500,
        }),
        evidence: [
          expect.objectContaining({
            title: signal.title,
            kind: signal.kind,
            excerpt: signal.excerpt,
          }),
        ],
      })
    );
  });

  it("keeps the scaffold and records the reason when generation throws", async () => {
    const tenant = await seedTenant();
    const { piece } = await seedPieceWithBrief(tenant.id);
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

  it("warns but keeps the draft when a competitor is named in a PRODUCT UPDATE", async () => {
    const tenant = await seedTenant();
    await db.insert(competitors).values({ tenantId: tenant.id, name: "Phrase" });
    const { piece } = await seedPieceWithBrief(tenant.id, { type: "product_update" });
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

  it("does NOT warn when a competitor is named in a blog post", async () => {
    const tenant = await seedTenant();
    await db.insert(competitors).values({ tenantId: tenant.id, name: "Phrase" });
    const { piece } = await seedPieceWithBrief(tenant.id, { type: "blog_post" });
    const generate = vi.fn(async () => ({ title: "T", body: "As Phrase showed last week…" }));

    const result = await generateDraftForPiece(piece.id, tenant.id, { database: db, generate });
    expect(result.ok).toBe(true);

    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    // Blog and social posts were allowed to name companies on 2026-08-06.
    // Warning about something the prompt explicitly permits would train the
    // reader to ignore the banner, which is worse than not showing it.
    expect(after.body).toContain("Phrase");
    expect(after.generationError).toBeNull();
  });

  it("refuses when no brief is linked to the piece", async () => {
    const tenant = await seedTenant();
    // Plain seedPiece — no accompanying briefs row, unlike every other test
    // in this suite. This is the data-integrity anomaly path: a piece should
    // never exist without the brief that produced it, and the earlier round
    // of this task silently fell back to the scaffold here instead of
    // refusing.
    const piece = await seedPiece(tenant.id);
    const generate = vi.fn(async () => ({ title: "T", body: "B" }));

    const result = await generateDraftForPiece(piece.id, tenant.id, { database: db, generate });
    expect(result.ok).toBe(false);
    expect(generate).not.toHaveBeenCalled();

    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(after.status).toBe("brief");
    expect(after.body).toBe("SCAFFOLD BODY");
  });

  it("refuses to overwrite a body a human has edited", async () => {
    const tenant = await seedTenant();
    // Linked to a real brief (unlike the bare seedPiece used by the
    // no-linked-brief test above) so this test isolates the bodyEditedAt
    // guard specifically — without a linked brief, a broken bodyEditedAt
    // check would still return ok:false via the missing-brief guard instead,
    // masking a real regression here.
    const { piece } = await seedPieceWithBrief(tenant.id, { bodyEditedAt: new Date(), body: "HUMAN WORDS" });
    const generate = vi.fn(async () => ({ title: "T", body: "Machine words." }));

    const result = await generateDraftForPiece(piece.id, tenant.id, { database: db, generate });
    expect(result.ok).toBe(false);
    expect(generate).not.toHaveBeenCalled();

    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(after.body).toBe("HUMAN WORDS");
  });

  it("refuses to regenerate a published piece, and never calls the generator", async () => {
    const tenant = await seedTenant();
    const { piece } = await seedPieceWithBrief(tenant.id, {
      status: "published",
      body: "SHIPPED BODY",
      publishedAt: new Date(),
    });
    const generate = vi.fn(async () => ({ title: "Rewritten title", body: "Rewritten body." }));

    const result = await generateDraftForPiece(piece.id, tenant.id, { database: db, generate });
    expect(result.ok).toBe(false);
    expect(generate).not.toHaveBeenCalled();

    // The bug this guards: a published piece generated straight from a draft
    // has bodyEditedAt === null, so without a status check it sails through
    // that guard and gets silently rewritten and demoted.
    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(after.status).toBe("published");
    expect(after.body).toBe("SHIPPED BODY");
    expect(after.publishedAt).not.toBeNull();
  });

  it("refuses to regenerate an archived piece, and never calls the generator", async () => {
    const tenant = await seedTenant();
    const { piece } = await seedPieceWithBrief(tenant.id, { status: "archived", body: "ARCHIVED BODY" });
    const generate = vi.fn(async () => ({ title: "Rewritten title", body: "Rewritten body." }));

    const result = await generateDraftForPiece(piece.id, tenant.id, { database: db, generate });
    expect(result.ok).toBe(false);
    expect(generate).not.toHaveBeenCalled();

    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(after.status).toBe("archived");
    expect(after.body).toBe("ARCHIVED BODY");
  });

  it("records an interruption marker before calling the model", async () => {
    const tenant = await seedTenant();
    const { piece } = await seedPieceWithBrief(tenant.id);
    let generationErrorDuringCall: string | null | undefined;
    const generate = vi.fn(async () => {
      // Read the row from inside the mocked generator — this is the one
      // moment that stands in for "the model call is in flight", which is
      // exactly when a marker recorded only AFTER the call would still be
      // absent.
      const [current] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
      generationErrorDuringCall = current.generationError;
      return { title: "T", body: "B" };
    });

    const result = await generateDraftForPiece(piece.id, tenant.id, { database: db, generate });
    expect(result.ok).toBe(true);
    expect(generationErrorDuringCall).toMatch(/interrupted/i);

    // And a successful run still overwrites the marker with null afterwards.
    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(after.generationError).toBeNull();
  });

  it("refuses a piece belonging to another tenant", async () => {
    const mine = await seedTenant();
    const [other] = await db.insert(tenants).values({ name: TENANT }).returning();
    const theirs = await seedPiece(other.id);
    const generate = vi.fn(async () => ({ title: "T", body: "B" }));

    const result = await generateDraftForPiece(theirs.id, mine.id, { database: db, generate });
    expect(result.ok).toBe(false);
    expect(generate).not.toHaveBeenCalled();
    // Specifically the tenant-scoped "not found" — not the no-linked-brief
    // refusal that would ALSO fire here if the piece-level tenant predicate
    // were dropped (this piece has no brief either), which would otherwise
    // let this test pass for the wrong reason and mask a real regression.
    if (!result.ok) expect(result.error).toBe("Content piece not found.");
  });
});
