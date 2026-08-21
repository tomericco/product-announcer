import { describe, it, expect, afterEach } from "vitest";
import { db } from "../../../src/db";
import { briefSignals, briefs, contentPieces, signals } from "../../../src/db/schema";
import { relatedPieces } from "../../../src/lib/briefs/query";
import { seedTenant, dropTenant } from "../../helpers/fixtures";

const TENANT = "Related Pieces Test Tenant";
const OTHER_TENANT = "Related Pieces Other Tenant";

const PROMPT_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_PROMPT_ID = "44444444-4444-4444-8444-444444444444";

afterEach(async () => {
  await dropTenant(TENANT);
  await dropTenant(OTHER_TENANT);
});

async function seedPiece(
  tenantId: string,
  overrides: Partial<typeof contentPieces.$inferInsert> = {}
) {
  const [piece] = await db
    .insert(contentPieces)
    .values({ tenantId, title: "A piece", body: "body", ...overrides })
    .returning();
  return piece;
}

async function seedBrief(tenantId: string, contentPieceId: string | null) {
  const [brief] = await db
    .insert(briefs)
    .values({
      tenantId,
      origin: "agent",
      contentType: "blog_post",
      title: "A title",
      angle: "An angle",
      whyNow: "Because",
      suggestedChannel: "blog",
      score: 0.8,
      lastEvidenceAt: new Date(),
      contentPieceId,
    })
    .returning();
  return brief;
}

async function seedSignal(
  tenantId: string,
  externalId: string,
  payload: Record<string, unknown> | null
) {
  const [signal] = await db
    .insert(signals)
    .values({
      tenantId,
      kind: "ai_visibility",
      externalId,
      title: "Not named on a buyer question",
      occurredAt: new Date(),
      payload: payload as never,
    })
    .returning();
  return signal;
}

describe("relatedPieces", () => {
  it("finds pieces whose brief cited a signal for THIS prompt", async () => {
    const tenant = await seedTenant(TENANT);
    const piece = await seedPiece(tenant.id, {
      title: "Why teams pick us",
      publishedAt: new Date("2026-06-10T00:00:00.000Z"),
      status: "published",
    });
    const brief = await seedBrief(tenant.id, piece.id);
    const signal = await seedSignal(tenant.id, `ai_visibility:lost_mention:${PROMPT_ID}:openai`, {
      signalType: "lost_mention",
      promptId: PROMPT_ID,
      runId: "run-1",
      runDate: new Date().toISOString(),
      samples: "0 of 3",
    });
    await db.insert(briefSignals).values({ briefId: brief.id, signalId: signal.id });

    const rows = await relatedPieces(tenant.id, PROMPT_ID, db);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ pieceId: piece.id, title: "Why teams pick us", status: "published" });
    expect(rows[0].publishedAt?.toISOString()).toBe("2026-06-10T00:00:00.000Z");
  });

  it("matches on payload->>'promptId', never on externalId", async () => {
    // `externalId`'s subject slot holds promptId ?? competitorId ?? domain ??
    // "all" (F1's scheme), so a domain-level signal puts a DOMAIN where a
    // promptId would sit. Matching there would attach a placement brief to
    // whichever prompt id happened to collide; `payload->>'promptId'` is null
    // on exactly those rows, which is the correct answer.
    const tenant = await seedTenant(TENANT);
    const piece = await seedPiece(tenant.id, { title: "A placement brief's piece" });
    const brief = await seedBrief(tenant.id, piece.id);
    const signal = await seedSignal(tenant.id, `ai_visibility:new_cited_domain:${PROMPT_ID}:all`, {
      signalType: "new_cited_domain",
      domain: "g2.com",
      runId: "run-1",
      runDate: new Date().toISOString(),
      samples: "7 answers",
    });
    await db.insert(briefSignals).values({ briefId: brief.id, signalId: signal.id });

    expect(await relatedPieces(tenant.id, PROMPT_ID, db)).toEqual([]);
  });

  it("returns another tenant's pieces never, even for a promptId that exists there", async () => {
    const tenant = await seedTenant(TENANT);
    const other = await seedTenant(OTHER_TENANT);
    const piece = await seedPiece(other.id, { title: "Not yours" });
    const brief = await seedBrief(other.id, piece.id);
    const signal = await seedSignal(other.id, `ai_visibility:lost_mention:${PROMPT_ID}:openai`, {
      signalType: "lost_mention",
      promptId: PROMPT_ID,
      runId: "run-1",
      runDate: new Date().toISOString(),
      samples: "0 of 3",
    });
    await db.insert(briefSignals).values({ briefId: brief.id, signalId: signal.id });

    expect(await relatedPieces(tenant.id, PROMPT_ID, db)).toEqual([]);
  });

  it("returns [] rather than throwing for a prompt no brief has cited", async () => {
    const tenant = await seedTenant(TENANT);

    expect(await relatedPieces(tenant.id, OTHER_PROMPT_ID, db)).toEqual([]);
  });

  it("lists a piece once even when two of its brief's signals name the prompt", async () => {
    const tenant = await seedTenant(TENANT);
    const piece = await seedPiece(tenant.id, { title: "Cited twice" });
    const brief = await seedBrief(tenant.id, piece.id);
    for (const engine of ["openai", "gemini"]) {
      const signal = await seedSignal(tenant.id, `ai_visibility:lost_mention:${PROMPT_ID}:${engine}`, {
        signalType: "lost_mention",
        promptId: PROMPT_ID,
        engine,
        runId: "run-1",
        runDate: new Date().toISOString(),
        samples: "0 of 3",
      });
      await db.insert(briefSignals).values({ briefId: brief.id, signalId: signal.id });
    }

    expect(await relatedPieces(tenant.id, PROMPT_ID, db)).toHaveLength(1);
  });

  it("ignores a brief that was never accepted into a piece", async () => {
    const tenant = await seedTenant(TENANT);
    const brief = await seedBrief(tenant.id, null);
    const signal = await seedSignal(tenant.id, `ai_visibility:gap_vs_competitor:${PROMPT_ID}:openai`, {
      signalType: "gap_vs_competitor",
      promptId: PROMPT_ID,
      runId: "run-1",
      runDate: new Date().toISOString(),
      samples: "0 of 3",
    });
    await db.insert(briefSignals).values({ briefId: brief.id, signalId: signal.id });

    expect(await relatedPieces(tenant.id, PROMPT_ID, db)).toEqual([]);
  });
});
