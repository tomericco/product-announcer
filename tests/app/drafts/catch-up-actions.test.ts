import { describe, it, expect, vi, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, releases, users } from "../../../src/db/schema";

const TENANT_NAME = "Catch Up Actions Test Tenant";
const OTHER_TENANT_NAME = "Catch Up Actions Test Tenant (Other)";
const USER_EMAIL = "catch-up-actions-test@example.com";
let currentTenantId = "";
let currentUserId: string | null = null;

// requireSession() returns a NextAuth Session (tenantId lives under `user`) —
// mirror that shape rather than a flat one, per the existing actions-test
// mocking style (see tests/app/atomic-updates-actions.test.ts).
vi.mock("../../../src/lib/workspace/session", () => ({
  requireSession: vi.fn(async () => ({ user: { tenantId: currentTenantId, id: currentUserId } })),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

// The actions must never invoke the real orchestrators (they call the live
// Anthropic API) — mock the whole module so the actions test only proves
// wiring: which function got called, with which releaseId, and that a
// foreign release never reaches either mock at all.
vi.mock("../../../src/lib/change-events/catch-up", () => ({
  catchUpRelease: vi.fn(async () => ({ id: "mock-release" })),
  startOverRelease: vi.fn(async () => ({ id: "mock-release" })),
}));

import { revalidatePath } from "next/cache";
import { catchUpRelease, startOverRelease } from "../../../src/lib/change-events/catch-up";
import { catchUp, startOver } from "../../../src/app/(dashboard)/drafts/[releaseId]/actions";

async function seed() {
  const [tenant] = await db.insert(tenants).values({ name: TENANT_NAME }).returning();
  const [user] = await db.insert(users).values({ email: USER_EMAIL }).returning();
  currentTenantId = tenant.id;
  currentUserId = user.id;
  const [release] = await db
    .insert(releases)
    .values({ tenantId: tenant.id, title: "Original title", body: "Original body" })
    .returning();
  return { tenant, user, release };
}

function formDataFor(releaseId: string) {
  const fd = new FormData();
  fd.set("releaseId", releaseId);
  return fd;
}

describe("catch-up actions (catchUp / startOver)", () => {
  afterEach(async () => {
    vi.clearAllMocks();
    await db.delete(tenants).where(eq(tenants.name, TENANT_NAME));
    await db.delete(tenants).where(eq(tenants.name, OTHER_TENANT_NAME));
    await db.delete(users).where(eq(users.email, USER_EMAIL));
  });

  describe("catchUp", () => {
    it("calls catchUpRelease for the owned release and revalidates its path", async () => {
      const { release } = await seed();

      await catchUp(formDataFor(release.id));

      expect(catchUpRelease).toHaveBeenCalledTimes(1);
      expect(catchUpRelease).toHaveBeenCalledWith(release.id);
      expect(revalidatePath).toHaveBeenCalledWith(`/drafts/${release.id}`);
    });

    it("refuses a foreign release — does not call catchUpRelease", async () => {
      const { release } = await seed();
      const [otherTenant] = await db.insert(tenants).values({ name: OTHER_TENANT_NAME }).returning();
      currentTenantId = otherTenant.id;

      await expect(catchUp(formDataFor(release.id))).rejects.toThrow();

      expect(catchUpRelease).not.toHaveBeenCalled();
      expect(revalidatePath).not.toHaveBeenCalled();
    });
  });

  describe("startOver", () => {
    it("calls startOverRelease for the owned release and revalidates its path", async () => {
      const { release } = await seed();

      await startOver(formDataFor(release.id));

      expect(startOverRelease).toHaveBeenCalledTimes(1);
      expect(startOverRelease).toHaveBeenCalledWith(release.id);
      expect(revalidatePath).toHaveBeenCalledWith(`/drafts/${release.id}`);
    });

    it("refuses a foreign release — does not call startOverRelease", async () => {
      const { release } = await seed();
      const [otherTenant] = await db.insert(tenants).values({ name: OTHER_TENANT_NAME }).returning();
      currentTenantId = otherTenant.id;

      await expect(startOver(formDataFor(release.id))).rejects.toThrow();

      expect(startOverRelease).not.toHaveBeenCalled();
      expect(revalidatePath).not.toHaveBeenCalled();
    });
  });

  // Both regenerate the stored body, so both are gated once a release leaves
  // the draft state. See save-draft.test.ts for the full rationale.
  describe("draft-status gate", () => {
    it("catchUp refuses a published release — does not call catchUpRelease", async () => {
      const { release } = await seed();
      await db
        .update(releases)
        .set({ status: "published", publishedAt: new Date() })
        .where(eq(releases.id, release.id));

      await expect(catchUp(formDataFor(release.id))).rejects.toThrow(/already been published/i);

      expect(catchUpRelease).not.toHaveBeenCalled();
      expect(revalidatePath).not.toHaveBeenCalled();
    });

    it("startOver refuses a rejected release — does not call startOverRelease", async () => {
      const { release } = await seed();
      await db.update(releases).set({ status: "rejected" }).where(eq(releases.id, release.id));

      await expect(startOver(formDataFor(release.id))).rejects.toThrow(/rejected/i);

      expect(startOverRelease).not.toHaveBeenCalled();
      expect(revalidatePath).not.toHaveBeenCalled();
    });
  });
});
