import { describe, it, expect, vi, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants } from "../../../src/db/schema";

const deleteBlobs = vi.fn(async (_p: string[]) => {});
vi.mock("../../../src/lib/images/blob", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/lib/images/blob")>();
  return { ...actual, deleteBlobs: (p: string[]) => deleteBlobs(p) };
});

import { MAX_RENDER_HISTORY, createImage, addRender, deleteImage, getImage } from "../../../src/lib/images/store";
import { seedTenant, dropTenant } from "../../helpers/fixtures";

const TENANT = "Store Shared Blob Test Tenant";
const SHARED_PATH = "tenants/x/library-shared.png";

/** Every pathname distinct except the one under test. */
function renderArgs(imageId: string, n: number) {
  return { imageId, prompt: `p${n}`, blobUrl: `https://blob/r${n}.png`, blobPathname: `tenants/x/r${n}.png`, width: 10, height: 10, bytes: 1, model: "m" };
}

async function seedShared() {
  const tenant = await seedTenant(TENANT);
  const a = await createImage({ tenantId: tenant.id, contentPieceId: null, role: "library", concept: "c", altText: "a", sourceKind: "generated" });
  const b = await createImage({ tenantId: tenant.id, contentPieceId: null, role: "library", concept: "c", altText: "a", sourceKind: "generated" });
  const shared = { prompt: "p", blobUrl: "https://blob/shared.png", blobPathname: SHARED_PATH, width: 10, height: 10, bytes: 1, model: "m" };
  await addRender({ imageId: a.id, ...shared });
  await addRender({ imageId: b.id, ...shared });
  return { tenant, a, b };
}

/** Every pathname `deleteBlobs` was asked to remove across all calls so far. */
function deletedPaths(): string[] {
  return deleteBlobs.mock.calls.flatMap((c) => c[0]);
}

afterEach(async () => {
  deleteBlobs.mockClear();
  await dropTenant(TENANT);
});

describe("deleteImage with a blob shared by another render", () => {
  it("does not del() a pathname another image still references, then does once it is the last", async () => {
    const { tenant, a, b } = await seedShared();

    expect(await deleteImage(tenant.id, a.id)).toEqual({ ok: true });
    // Absolute, not positional: works whether the guard passes [] or skips the
    // call entirely when the list is empty (read Plan 1's deleteImage first).
    expect(deletedPaths()).not.toContain(SHARED_PATH);

    expect(await deleteImage(tenant.id, b.id)).toEqual({ ok: true });
    expect(deletedPaths()).toContain(SHARED_PATH);
  });

  it("still deletes the deleted image's OWN unshared blobs while sparing the shared one", async () => {
    const { tenant, a } = await seedShared();
    await addRender(renderArgs(a.id, 1));

    expect(await deleteImage(tenant.id, a.id)).toEqual({ ok: true });

    expect(deletedPaths()).toContain("tenants/x/r1.png");
    expect(deletedPaths()).not.toContain(SHARED_PATH);
  });
});

/**
 * The prune path is the OTHER `deleteBlobs` call site this task changes, and
 * it is the one that fires without anybody asking — every regeneration past
 * the history cap. A guard applied only to `deleteImage` would leave a
 * "From library" cover pointing at a blob a body image's sixth regeneration
 * quietly deleted, and nothing would surface it until the published page
 * 404s the image.
 */
describe("addRender pruning with a blob shared by another render", () => {
  it("prunes the row but keeps the blob when another image's render still points at it", async () => {
    const { tenant, a, b } = await seedShared();

    // `a` now has the shared render as its oldest. Push it past the cap.
    for (let n = 1; n <= MAX_RENDER_HISTORY; n++) await addRender(renderArgs(a.id, n));

    const loaded = await getImage(tenant.id, a.id);
    expect(loaded?.renders).toHaveLength(MAX_RENDER_HISTORY);
    expect(loaded?.renders.some((r) => r.blobPathname === SHARED_PATH)).toBe(false);
    // Row pruned, blob spared — `b` still uses it.
    expect(deletedPaths()).not.toContain(SHARED_PATH);
    expect((await getImage(tenant.id, b.id))?.current?.blobPathname).toBe(SHARED_PATH);
  });

  it("deletes a pruned blob normally when nothing else references it", async () => {
    const tenant = await seedTenant(TENANT);
    const image = await createImage({ tenantId: tenant.id, contentPieceId: null, role: "library", concept: "c", altText: "a", sourceKind: "generated" });
    for (let n = 1; n <= MAX_RENDER_HISTORY + 1; n++) await addRender(renderArgs(image.id, n));
    expect(deletedPaths()).toEqual(["tenants/x/r1.png"]);
  });
});
