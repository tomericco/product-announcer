import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, contentPieces, users, brandProfiles, atomicUpdates } from "../../../src/db/schema";
import { runExtractForRelease } from "../../../src/lib/ai/extract-release";
import type { DraftProgressEvent } from "../../../src/lib/scheduling/draft-progress";
import type { ReviewOutcome } from "../../../src/lib/ai/review-draft";

const TENANT_NAME = "Extract Release Test Tenant";
const USER_EMAIL = "extract-release-test@example.com";

const SOURCE_BODY = "Kept paragraph.\n\nExtracted paragraph.";
const REMAINING = "Kept paragraph.";

async function seed(body = SOURCE_BODY) {
  const [tenant] = await db.insert(tenants).values({ name: TENANT_NAME }).returning();
  const [user] = await db.insert(users).values({ email: USER_EMAIL }).returning();
  const [release] = await db
    .insert(contentPieces)
    .values({ tenantId: tenant.id, title: "Source title", body })
    .returning();
  return { tenant, user, release };
}

async function rowFor(releaseId: string) {
  const [row] = await db.select().from(contentPieces).where(eq(contentPieces.id, releaseId));
  return row;
}

async function releasesFor(tenantId: string) {
  return db.select().from(contentPieces).where(eq(contentPieces.tenantId, tenantId));
}

const generateDraft = async () => ({ title: "Generated title", body: "generated body" });
const review = async (draft: { title: string; body: string }): Promise<ReviewOutcome> => ({
  finalDraft: { title: draft.title, body: "reviewed body" },
  status: "passed",
  issues: [],
});

describe("runExtractForRelease", () => {
  afterEach(async () => {
    const [tenant] = await db.select().from(tenants).where(eq(tenants.name, TENANT_NAME));
    if (tenant) {
      await db.delete(atomicUpdates).where(eq(atomicUpdates.tenantId, tenant.id));
      await db.delete(contentPieces).where(eq(contentPieces.tenantId, tenant.id));
      await db.delete(brandProfiles).where(eq(brandProfiles.tenantId, tenant.id));
    }
    await db.delete(users).where(eq(users.email, USER_EMAIL));
    await db.delete(tenants).where(eq(tenants.name, TENANT_NAME));
  });

  it("creates the new draft and rewrites the source body in one pass, emitting stepped progress", async () => {
    const { tenant, user, release } = await seed();
    const events: DraftProgressEvent[] = [];

    const result = await runExtractForRelease(
      {
        contentPieceId: release.id,
        excerpt: "Extracted paragraph.",
        remainingBody: REMAINING,
        instruction: "keep it short",
        editedBy: user.id,
      },
      db,
      (e) => events.push(e),
      { generateDraft, review }
    );

    expect(result).not.toBeNull();
    expect(result!.title).toBe("Generated title");

    const created = await rowFor(result!.contentPieceId);
    expect(created.title).toBe("Generated title");
    expect(created.body).toBe("reviewed body");
    expect(created.tenantId).toBe(tenant.id);
    expect(created.status).toBe("draft");
    expect(created.reviewStatus).toBe("passed");
    expect(created.editedBy).toBe(user.id);

    // The new draft claims no atomic updates — by design.
    const linked = await db
      .select()
      .from(atomicUpdates)
      .where(eq(atomicUpdates.contentPieceId, created.id));
    expect(linked).toHaveLength(0);

    const source = await rowFor(release.id);
    expect(source.body).toBe(REMAINING);
    expect(source.title).toBe("Source title"); // never touched
    expect(source.bodyEditedAt).not.toBeNull();
    expect(source.editedBy).toBe(user.id);

    const steps = events
      .filter((e): e is Extract<DraftProgressEvent, { type: "step" }> => e.type === "step")
      .map((s) => `${s.key}:${s.status}`);
    expect(steps).toEqual([
      "preparing:start",
      "preparing:done",
      "generating:start",
      "generating:done",
      "reviewing:start",
      "reviewing:done",
      "saving:start",
      "saving:done",
    ]);
    expect(events.at(-1)).toEqual({ type: "done", updateId: created.id });
  });

  it("refuses to extract the entire body and writes nothing", async () => {
    const { tenant, release } = await seed();
    const events: DraftProgressEvent[] = [];

    const result = await runExtractForRelease(
      {
        contentPieceId: release.id,
        excerpt: SOURCE_BODY,
        remainingBody: "   ",
        instruction: "",
        editedBy: "00000000-0000-0000-0000-000000000000",
      },
      db,
      (e) => events.push(e),
      { generateDraft, review }
    );

    expect(result).toBeNull();
    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(await releasesFor(tenant.id)).toHaveLength(1);
    expect((await rowFor(release.id)).body).toBe(SOURCE_BODY);
  });

  it("leaves the source untouched and creates nothing when generation fails", async () => {
    const { tenant, user, release } = await seed();
    const failing = async () => {
      throw new Error("model exploded");
    };

    await expect(
      runExtractForRelease(
        {
          contentPieceId: release.id,
          excerpt: "Extracted paragraph.",
          remainingBody: REMAINING,
          instruction: "",
          editedBy: user.id,
        },
        db,
        undefined,
        { generateDraft: failing, review }
      )
    ).rejects.toThrow("model exploded");

    expect(await releasesFor(tenant.id)).toHaveLength(1);
    const source = await rowFor(release.id);
    expect(source.body).toBe(SOURCE_BODY);
    expect(source.bodyEditedAt).toBeNull();
  });

  it("returns null for a content piece that does not exist", async () => {
    const events: DraftProgressEvent[] = [];
    const result = await runExtractForRelease(
      {
        contentPieceId: "00000000-0000-0000-0000-000000000000",
        excerpt: "x",
        remainingBody: "y",
        instruction: "",
        editedBy: "00000000-0000-0000-0000-000000000000",
      },
      db,
      (e) => events.push(e),
      { generateDraft, review }
    );
    expect(result).toBeNull();
    expect(events.some((e) => e.type === "error")).toBe(true);
  });
});
