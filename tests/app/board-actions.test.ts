import { describe, it, expect, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, contentPieces } from "../../src/db/schema";

const TENANT_NAME = "Board Actions Test Tenant";
let currentTenantId = "";

// requireSession() returns a NextAuth Session (tenantId lives under `user`) —
// mirror that shape, per the existing actions-test mocking style (see
// tests/app/drafts/reject-delete-actions.test.ts).
vi.mock("../../src/lib/workspace/session", () => ({
  requireSession: vi.fn(async () => ({ user: { tenantId: currentTenantId } })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { moveCard } from "../../src/app/(dashboard)/board/actions";

async function seed(status: "draft" | "review" = "draft") {
  const [tenant] = await db.insert(tenants).values({ name: TENANT_NAME }).returning();
  currentTenantId = tenant.id;
  const [piece] = await db
    .insert(contentPieces)
    .values({ tenantId: tenant.id, title: "T", body: "B", status })
    .returning();
  return { tenant, piece };
}

afterEach(async () => {
  await db.delete(tenants).where(eq(tenants.name, TENANT_NAME));
});

describe("moveCard", () => {
  // `new Date("garbage")` is an Invalid Date, not a thrown error — it is
  // still truthy, so without this check it would sail past
  // moveContentPiece's own "scheduledFor is required" guard and only fail
  // later, inside the write, as an uncaught RangeError from
  // `.toISOString()`. This pins the guard added to moveCard itself.
  it("refuses a move into scheduled carrying an invalid scheduledForIso, and leaves the piece untouched", async () => {
    const { piece } = await seed("review");

    const result = await moveCard(piece.id, "scheduled", "not-a-real-date");

    expect(result.ok).toBe(false);
    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(after.status).toBe("review");
    expect(after.scheduledFor).toBeNull();
  });

  it("accepts a move into scheduled carrying a valid ISO date", async () => {
    const { piece } = await seed("review");
    const when = new Date("2026-09-01T09:00:00Z");

    const result = await moveCard(piece.id, "scheduled", when.toISOString());

    expect(result).toEqual({ ok: true });
    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(after.status).toBe("scheduled");
    expect(after.scheduledFor?.toISOString()).toBe(when.toISOString());
  });
});
