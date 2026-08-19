import { describe, it, expect, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { companyProfiles } from "../../src/db/schema";
import { seedTenant, dropTenant } from "../helpers/fixtures";

let currentTenantId = "";
vi.mock("../../src/lib/workspace/session", () => ({
  requireSession: vi.fn(async () => ({ user: { tenantId: currentTenantId, id: "user-1", role: "owner" } })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { saveImagePolicy } from "../../src/app/(dashboard)/settings/actions";

const TENANT = "Image Policy Actions Test Tenant";

afterEach(async () => {
  await dropTenant(TENANT);
});

describe("saveImagePolicy", () => {
  it("persists a valid policy on the tenant's profile", async () => {
    const tenant = await seedTenant(TENANT);
    currentTenantId = tenant.id;

    expect(
      await saveImagePolicy({ blog_post: { cover: true, body: 2 }, product_update: { cover: false, body: "off" }, social_post: { cover: false, body: "off" } })
    ).toEqual({ ok: true });

    const [profile] = await db.select().from(companyProfiles).where(eq(companyProfiles.tenantId, tenant.id));
    expect(profile.imagePolicy).toEqual({
      blog_post: { cover: true, body: 2 },
      product_update: { cover: false, body: "off" },
      social_post: { cover: false, body: "off" },
    });
  });

  it("rejects an invalid policy without writing", async () => {
    const tenant = await seedTenant(TENANT);
    currentTenantId = tenant.id;
    expect(await saveImagePolicy({ blog_post: { cover: true, body: 9 } })).toEqual({ ok: false, reason: "invalid" });
    const [profile] = await db.select().from(companyProfiles).where(eq(companyProfiles.tenantId, tenant.id));
    expect(profile?.imagePolicy ?? null).toBeNull();
  });
});
