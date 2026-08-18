import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, repos, contentPieces, deliveryAttempts } from "../../src/db/schema";

describe("publish/integrations schema", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, "Publish Schema Test Tenant"));
  });

  it("links a DeliveryAttempt to a ContentPiece", async () => {
    const [tenant] = await db.insert(tenants).values({ name: "Publish Schema Test Tenant" }).returning();
    const [repo] = await db
      .insert(repos)
      .values({ tenantId: tenant.id, githubRepoFullName: "acme/x", githubInstallationId: "1", watchedBranch: "main" })
      .returning();
    const [piece] = await db
      .insert(contentPieces)
      .values({ tenantId: tenant.id, repoId: repo.id, title: "T", body: "B" })
      .returning();

    const [delivery] = await db
      .insert(deliveryAttempts)
      .values({ contentPieceId: piece.id, destination: "webhook" })
      .returning();

    expect(delivery.contentPieceId).toBe(piece.id);
    expect(delivery.status).toBe("pending");
    expect(delivery.attempts).toBe(0);
  });

  it("rejects a second delivery attempt for the same content piece+destination pair", async () => {
    // Backstops the reuse path in dispatchAllDestinations: a select-then-insert
    // race could otherwise create two rows for the same content piece+destination,
    // and a later dispatch would pick an arbitrary one via `limit 1` with no order.
    const [tenant] = await db.insert(tenants).values({ name: "Publish Schema Test Tenant" }).returning();
    const [repo] = await db
      .insert(repos)
      .values({ tenantId: tenant.id, githubRepoFullName: "acme/x", githubInstallationId: "1", watchedBranch: "main" })
      .returning();
    const [piece] = await db
      .insert(contentPieces)
      .values({ tenantId: tenant.id, repoId: repo.id, title: "T", body: "B" })
      .returning();

    await db.insert(deliveryAttempts).values({ contentPieceId: piece.id, destination: "webhook" });

    await expect(
      db.insert(deliveryAttempts).values({ contentPieceId: piece.id, destination: "webhook" })
    ).rejects.toThrow();
  });
});
