import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { companyProfiles, contentImages } from "../../../src/db/schema";
import {
  READY_VISUAL_IDENTITY,
  dropTenant,
  seedContentImage,
  seedContentPiece,
  seedTenant,
  seedVisualIdentity,
} from "../../helpers/fixtures";
import { isVisualIdentityReady } from "../../../src/lib/images/visual-identity";

const TENANT = "Image Fixtures Smoke Test Tenant";

afterEach(async () => {
  await dropTenant(TENANT);
});

describe("image fixtures", () => {
  it("seeds a profile whose visual identity is ready", async () => {
    const tenant = await seedTenant(TENANT);
    await seedVisualIdentity(tenant.id);
    const [profile] = await db.select().from(companyProfiles).where(eq(companyProfiles.tenantId, tenant.id));
    expect(isVisualIdentityReady(profile.visualIdentity)).toBe(true);
    expect(READY_VISUAL_IDENTITY.palette.length).toBeGreaterThanOrEqual(3);
  });

  it("seeds a null visual identity on request, and is idempotent per tenant", async () => {
    const tenant = await seedTenant(TENANT);
    await seedVisualIdentity(tenant.id, null);
    await seedVisualIdentity(tenant.id, READY_VISUAL_IDENTITY);
    const rows = await db.select().from(companyProfiles).where(eq(companyProfiles.tenantId, tenant.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].visualIdentity?.palette).toHaveLength(3);
  });

  it("seeds an image with a render wired as current, and without one", async () => {
    const tenant = await seedTenant(TENANT);
    const piece = await seedContentPiece(tenant.id, { type: "blog_post" });
    const ready = await seedContentImage({ tenantId: tenant.id, contentPieceId: piece.id, role: "cover" });
    expect(ready.render).not.toBeNull();
    const [row] = await db.select().from(contentImages).where(eq(contentImages.id, ready.image.id));
    expect(row.currentRenderId).toBe(ready.render!.id);
    expect(row.status).toBe("ready");

    const failed = await seedContentImage({
      tenantId: tenant.id,
      contentPieceId: piece.id,
      role: "body",
      withRender: false,
      overrides: { status: "failed" },
    });
    expect(failed.render).toBeNull();
    expect(failed.image.currentRenderId).toBeNull();
  });

  it("gives every render a distinct blob url so a body swap is observable", async () => {
    const tenant = await seedTenant(TENANT);
    const a = await seedContentImage({ tenantId: tenant.id, contentPieceId: null, role: "library" });
    const b = await seedContentImage({ tenantId: tenant.id, contentPieceId: null, role: "library" });
    expect(a.render!.blobUrl).not.toBe(b.render!.blobUrl);
    expect(a.render!.blobPathname).not.toBe(b.render!.blobPathname);
  });
});
