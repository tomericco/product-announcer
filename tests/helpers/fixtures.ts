import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants } from "../../src/db/schema";
import {
  aiVisibilityEngineKeys,
  companyProfiles,
  contentImages,
  contentPieces,
  imageRenders,
  type ContentImage,
  type ImageRender,
  type ImageRole,
  type VisualIdentity,
} from "../../src/db/schema";
import { DEFAULT_VISUAL_IDENTITY } from "../../src/lib/images/visual-identity";
import { encryptSecret } from "../../src/lib/credentials/encryption";
import { ENGINE_IDS, type EngineId } from "../../src/lib/ai-visibility/types";

/**
 * Seeds a tenant by name. The name is the cleanup key — `dropTenant` deletes
 * by it and every child row cascades — so each test file must use a name
 * unique to that file, or two files running against this shared Postgres will
 * delete each other's fixtures mid-run.
 */
export async function seedTenant(name: string) {
  const [tenant] = await db.insert(tenants).values({ name }).returning();
  return tenant;
}

/** Teardown counterpart. Cascades to every table keyed on the tenant. */
export async function dropTenant(name: string) {
  await db.delete(tenants).where(eq(tenants.name, name));
}

/**
 * A visual identity that passes `isVisualIdentityReady` (>= 3 palette
 * colours). Every test that needs generation to be *allowed* uses this one, so
 * a change to the readiness rule breaks one constant, not twenty files.
 */
export const READY_VISUAL_IDENTITY: VisualIdentity = {
  ...DEFAULT_VISUAL_IDENTITY,
  palette: [
    { hex: "#112233", role: "primary" },
    { hex: "#445566", role: "secondary" },
    { hex: "#ffffff", role: "background" },
  ],
};

export async function seedCompanyProfile(
  tenantId: string,
  overrides: Partial<typeof companyProfiles.$inferInsert> = {}
) {
  const [profile] = await db
    .insert(companyProfiles)
    .values({ tenantId, topics: [], ...overrides })
    .returning();
  return profile;
}

/**
 * Upserts the tenant's profile with a visual identity. Pass `null` for the
 * "tenant has not set up visual identity yet" case — the row still exists, so
 * `getOrCreateCompanyProfile` does not create a second one.
 */
export async function seedVisualIdentity(tenantId: string, identity: VisualIdentity | null = READY_VISUAL_IDENTITY) {
  const existing = await db.select().from(companyProfiles).where(eq(companyProfiles.tenantId, tenantId)).limit(1);
  if (existing.length > 0) {
    const [updated] = await db
      .update(companyProfiles)
      .set({ visualIdentity: identity })
      .where(eq(companyProfiles.tenantId, tenantId))
      .returning();
    return updated;
  }
  return seedCompanyProfile(tenantId, { visualIdentity: identity });
}

export async function seedContentPiece(
  tenantId: string,
  overrides: Partial<typeof contentPieces.$inferInsert> = {}
) {
  const [piece] = await db
    .insert(contentPieces)
    .values({ tenantId, type: "blog_post", title: "Test piece", body: "# Test piece\n\n## A\n\nText.", ...overrides })
    .returning();
  return piece;
}

// Unique per process so two images in one test never share a blob URL by
// accident — several assertions turn on "the body's URL changed".
let renderCounter = 0;

/**
 * Seeds a `content_images` row and (by default) one `image_renders` row wired
 * as its `currentRenderId` with `status: "ready"` — i.e. exactly the state
 * Plan 1's `addRender` leaves behind, without going near the model or Blob.
 */
export async function seedContentImage(a: {
  tenantId: string;
  contentPieceId?: string | null;
  role?: ImageRole;
  withRender?: boolean;
  overrides?: Partial<typeof contentImages.$inferInsert>;
  renderOverrides?: Partial<typeof imageRenders.$inferInsert>;
}): Promise<{ image: ContentImage; render: ImageRender | null }> {
  const role = a.role ?? "body";
  const [image] = await db
    .insert(contentImages)
    .values({
      tenantId: a.tenantId,
      contentPieceId: a.contentPieceId ?? null,
      role,
      concept: "a lighthouse beam over a data grid",
      altText: "Lighthouse beam over a grid of tiles",
      sourceKind: "generated",
      status: a.withRender === false ? "pending" : "ready",
      ...a.overrides,
    })
    .returning();

  if (a.withRender === false) return { image, render: null };

  const n = ++renderCounter;
  const [render] = await db
    .insert(imageRenders)
    .values({
      imageId: image.id,
      prompt: "FULL PROMPT",
      blobUrl: `https://blob.example/seed-${n}.png`,
      blobPathname: `tenants/seed/seed-${n}.png`,
      width: role === "cover" ? 1200 : 1200,
      height: role === "cover" ? 630 : 900,
      bytes: 1024,
      model: "gpt-image-2",
      ...a.renderOverrides,
    })
    .returning();

  const [wired] = await db
    .update(contentImages)
    .set({ currentRenderId: render.id })
    .where(eq(contentImages.id, image.id))
    .returning();
  return { image: wired, render };
}

/**
 * A verified, enabled engine key — the state BYOK requires before a run can be
 * planned at all.
 *
 * Nearly every AI-visibility test needs one now: `effectiveEngines` intersects
 * the tenant's chosen engines with the engines holding a verified key, with no
 * fallback when that is empty, so a tenant with no key row plans nothing. The
 * plaintext is a recognisable fake — never a real-looking secret — and it is
 * encrypted through the same `encryptSecret` production uses, so a test that
 * asserts "the run sent the tenant's key" is asserting against the real
 * decrypt path rather than a stub.
 */
export async function seedEngineKey(
  tenantId: string,
  engine: EngineId,
  overrides: Partial<typeof aiVisibilityEngineKeys.$inferInsert> = {}
) {
  const key = overrides.keyCiphertext ? "" : `test-${engine}-key-0000`;
  const encrypted = key ? encryptSecret(key) : null;
  const [row] = await db
    .insert(aiVisibilityEngineKeys)
    .values({
      tenantId,
      engine,
      ...(encrypted
        ? {
            keyCiphertext: encrypted.ciphertext,
            keyIv: encrypted.iv,
            keyAuthTag: encrypted.authTag,
          }
        : { keyCiphertext: "", keyIv: "", keyAuthTag: "" }),
      last4: key.slice(-4),
      status: "verified",
      enabled: true,
      verifiedAt: new Date(),
      ...overrides,
    })
    .onConflictDoUpdate({
      target: [aiVisibilityEngineKeys.tenantId, aiVisibilityEngineKeys.engine],
      set: { status: "verified", enabled: true, ...overrides },
    })
    .returning();
  return { row, key };
}

/** Every engine keyed at once — the ordinary "this tenant is fully connected" state. */
export async function seedAllEngineKeys(tenantId: string) {
  for (const engine of ENGINE_IDS) await seedEngineKey(tenantId, engine);
}
