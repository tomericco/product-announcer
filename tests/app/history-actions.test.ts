import { describe, it, expect, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, users, contentPieces, deliveryAttempts } from "../../src/db/schema";
import { writeVariant } from "../../src/lib/publishing/channel-variants";

const TENANT = "History Actions Test Tenant";
let currentTenantId = "";

vi.mock("../../src/lib/workspace/session", () => ({
  requireSession: vi.fn(async () => ({ user: { tenantId: currentTenantId, id: "user-1" } })),
}));

import { getReleaseDetail } from "../../src/app/(dashboard)/history/actions";

async function seed() {
  const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning({ id: tenants.id });
  currentTenantId = tenant.id;
  const [pub] = await db.insert(users).values({ email: "pub@example.com", name: "Pat Publisher" }).returning({ id: users.id });
  const [rel] = await db
    .insert(contentPieces)
    .values({
      tenantId: tenant.id,
      title: "Ship it",
      body: "# Notes\n\nWe **shipped**.",
      status: "published",
      publishedAt: new Date("2026-07-25T10:00:00Z"),
      publishedBy: pub.id,
    })
    .returning({ id: contentPieces.id });
  await writeVariant(db, rel.id, "linkedin", "We shipped 🎉");
  await db.insert(deliveryAttempts).values([
    { contentPieceId: rel.id, destination: "webhook", status: "success" },
    { contentPieceId: rel.id, destination: "webflow", status: "failed", lastError: "401 Unauthorized" },
  ]);
  return { tenantId: tenant.id, releaseId: rel.id };
}

describe("getReleaseDetail", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
    // seed() hardcodes this email across multiple tests in this file; the real
    // Postgres test DB isn't transaction-rolled-back per test (see other
    // tests/**/*.test.ts files), so it must be cleaned up explicitly or the
    // second seed() call in this suite hits users_email_unique.
    await db.delete(users).where(eq(users.email, "pub@example.com"));
  });

  it("returns rendered body, publisher, and all destination statuses", async () => {
    const { releaseId } = await seed();
    const detail = await getReleaseDetail(releaseId);
    expect(detail).not.toBeNull();
    expect(detail!.title).toBe("Ship it");
    expect(detail!.bodyHtml).toContain("<strong>shipped</strong>");
    expect(detail!.linkedinBody).toBe("We shipped 🎉");
    expect(detail!.publishedAt).toBe("2026-07-25T10:00:00.000Z");
    expect(detail!.publisherName).toBe("Pat Publisher");
    const byDest = Object.fromEntries(detail!.destinations.map((d) => [d.destination, d]));
    expect(byDest.webhook).toMatchObject({ status: "success", error: null, label: expect.any(String) });
    expect(byDest.webflow).toMatchObject({ status: "failed", error: "401 Unauthorized" });
  });

  it("returns null for a release owned by another tenant (IDOR guard)", async () => {
    const { releaseId } = await seed();
    currentTenantId = "00000000-0000-0000-0000-000000000000"; // different tenant in session
    expect(await getReleaseDetail(releaseId)).toBeNull();
  });

  it("maps a null publishedBy to publisherName null", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning({ id: tenants.id });
    currentTenantId = tenant.id;
    const [rel] = await db
      .insert(contentPieces)
      .values({ tenantId: tenant.id, title: "Old", body: "x", status: "published", publishedAt: new Date() })
      .returning({ id: contentPieces.id });
    const detail = await getReleaseDetail(rel.id);
    expect(detail!.publisherName).toBeNull();
  });
});
