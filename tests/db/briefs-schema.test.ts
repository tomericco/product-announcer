import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, signals, briefs, briefSignals, contentPieces } from "../../src/db/schema";

const TENANT = "Briefs Schema Test Tenant";
// Deliberately in the future. A brief with a past expiry and the default `new`
// status is live prey for a concurrent `expireStaleBriefs` in another test
// file, which would flip its status out from under these assertions.
const FUTURE = () => new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

afterEach(async () => {
  await db.delete(tenants).where(eq(tenants.name, TENANT));
});

async function seed() {
  const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
  return tenant;
}

describe("briefs schema", () => {
  it("stores a brief with its key points and expiry", async () => {
    const tenant = await seed();

    const [brief] = await db
      .insert(briefs)
      .values({
        tenantId: tenant.id,
        origin: "agent",
        contentType: "blog_post",
        title: "Why localization belongs in the design tool",
        angle: "Argue the handoff is the bug, not the translation.",
        whyNow: "Ditto shipped a Figma plugin on 2026-08-04.",
        suggestedChannel: "blog",
        keyPoints: ["One.", "Two.", "Three."],
        score: 0.8,
        lastEvidenceAt: new Date(),
        expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
      })
      .returning();

    expect(brief.status).toBe("new");
    expect(brief.origin).toBe("agent");
    expect(brief.keyPoints).toEqual(["One.", "Two.", "Three."]);
    expect(brief.contentPieceId).toBeNull();
  });

  it("cascades brief_signals when the signal is deleted", async () => {
    const tenant = await seed();
    const [signal] = await db
      .insert(signals)
      .values({
        tenantId: tenant.id,
        kind: "market_news",
        externalId: "https://news.example.com/a",
        title: "A story",
        occurredAt: new Date(),
      })
      .returning();
    const [brief] = await db
      .insert(briefs)
      .values({
        tenantId: tenant.id,
        origin: "agent",
        contentType: "blog_post",
        title: "T",
        angle: "A",
        whyNow: "W",
        suggestedChannel: "blog",
        keyPoints: ["One.", "Two.", "Three."],
        score: 0.5,
        lastEvidenceAt: new Date(),
        expiresAt: FUTURE(),
      })
      .returning();

    await db.insert(briefSignals).values({ briefId: brief.id, signalId: signal.id });
    await db.delete(signals).where(eq(signals.id, signal.id));

    const rows = await db.select().from(briefSignals).where(eq(briefSignals.briefId, brief.id));
    // This cascade is exactly why signals cited by an ACCEPTED brief must be
    // exempt from the eventual 60-day purge — see src/lib/signals/window.ts.
    expect(rows).toHaveLength(0);
  });

  it("refuses two briefs claiming the same content piece", async () => {
    const tenant = await seed();
    const base = {
      tenantId: tenant.id,
      origin: "agent" as const,
      contentType: "blog_post" as const,
      title: "T",
      angle: "A",
      whyNow: "W",
      suggestedChannel: "blog",
      keyPoints: ["One.", "Two.", "Three."],
      score: 0.5,
      lastEvidenceAt: new Date(),
      expiresAt: FUTURE(),
    };
    const [piece] = await db
      .insert(contentPieces)
      .values({ tenantId: tenant.id, type: "blog_post", title: "P", body: "b" })
      .returning();
    const pieceId = piece.id;

    // A real content piece IS needed: contentPieceId carries a foreign key to
    // contentPieces.id, so a random UUID would fail on insert before the
    // partial unique index — the thing actually under test here — ever gets
    // a chance to bite.
    await db.insert(briefs).values({ ...base, contentPieceId: pieceId });

    await expect(db.insert(briefs).values({ ...base, contentPieceId: pieceId })).rejects.toThrow();
  });

  it("permits many briefs with no content piece", async () => {
    const tenant = await seed();
    const base = {
      tenantId: tenant.id,
      origin: "agent" as const,
      contentType: "blog_post" as const,
      title: "T",
      angle: "A",
      whyNow: "W",
      suggestedChannel: "blog",
      keyPoints: ["One.", "Two.", "Three."],
      score: 0.5,
      lastEvidenceAt: new Date(),
      expiresAt: FUTURE(),
    };

    await db.insert(briefs).values(base);
    // Postgres treats NULLs as distinct, so the partial index must not bite here.
    await expect(db.insert(briefs).values(base)).resolves.toBeDefined();
  });
});
