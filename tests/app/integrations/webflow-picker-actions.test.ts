import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
// The no-op-guard branches never touch these, but the "actually changed"
// branches do (saveWebflowSite writes need no token; saveWebflowCollection
// calls getCollection). Stub both so this file stays a pure DB/action test
// and doesn't need a real CREDENTIALS_ENCRYPTION_KEY or network access.
vi.mock("@/lib/credentials/encryption", () => ({
  encryptSecret: () => ({ ciphertext: "x", iv: "x", authTag: "x" }),
  decryptSecret: () => "tok",
}));
vi.mock("@/lib/integrations/webflow/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/integrations/webflow/client")>();
  return { ...actual, getCollection: vi.fn() };
});

import { getServerSession } from "next-auth";
import { getCollection } from "@/lib/integrations/webflow/client";
import { db } from "@/db";
import { tenants, webflowConnections, type WebflowFieldMapping } from "@/db/schema";
import { saveWebflowSite, saveWebflowCollection } from "@/app/(dashboard)/integrations/actions";

// Regression coverage for a data-loss bug: saveWebflowSite/saveWebflowCollection
// used to write unconditionally, so re-confirming the CURRENT site or
// collection (e.g. opening "Change site" just to check what's wired up, then
// clicking "Use this site" without changing anything) wiped the collection and
// the user's hand-tuned field mapping for no reason. These tests seed a real
// row with a mapping, call the action with the SAME id, and assert the row —
// and the mapping specifically — is untouched. A sibling "different id" case
// per action proves the guard didn't also break the legitimate change path.

const TENANT_NAME = "Webflow Picker No-Op Guard Test Tenant";

const HAND_TUNED_MAPPING: WebflowFieldMapping = {
  name: { source: "title" },
  slug: { source: "slug" },
  "post-body": { source: "static", value: "Hand-picked value that took forever to configure" },
};

async function seedConnection(overrides: Partial<typeof webflowConnections.$inferInsert> = {}) {
  const [tenant] = await db.insert(tenants).values({ name: TENANT_NAME }).returning();
  const [connection] = await db
    .insert(webflowConnections)
    .values({
      tenantId: tenant.id,
      tokenCiphertext: "x",
      tokenIv: "x",
      tokenAuthTag: "x",
      siteId: "site-marketing",
      siteName: "Marketing",
      collectionId: "collection-blog",
      collectionName: "Blog",
      fieldMapping: HAND_TUNED_MAPPING,
      publishMode: "draft",
      status: "active",
      ...overrides,
    })
    .returning();
  return { tenant, connection };
}

async function rowFor(connectionId: string) {
  const [row] = await db.select().from(webflowConnections).where(eq(webflowConnections.id, connectionId));
  return row;
}

describe("saveWebflowSite / saveWebflowCollection — no-op guard preserves the mapping", () => {
  beforeEach(() => {
    vi.mocked(getServerSession).mockReset();
    vi.mocked(getCollection).mockReset();
  });

  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT_NAME));
  });

  it("saveWebflowSite: re-selecting the SAME site leaves the row untouched", async () => {
    const { tenant, connection } = await seedConnection();
    vi.mocked(getServerSession).mockResolvedValue({ user: { tenantId: tenant.id } } as never);

    const formData = new FormData();
    formData.set("siteId", "site-marketing");
    formData.set("siteName", "Marketing");

    await saveWebflowSite(formData);

    const row = await rowFor(connection.id);
    expect(row.siteId).toBe("site-marketing");
    expect(row.collectionId).toBe("collection-blog");
    expect(row.collectionName).toBe("Blog");
    expect(row.fieldMapping).toEqual(HAND_TUNED_MAPPING);
  });

  it("saveWebflowSite: selecting a DIFFERENT site still clears the collection and mapping", async () => {
    const { tenant, connection } = await seedConnection();
    vi.mocked(getServerSession).mockResolvedValue({ user: { tenantId: tenant.id } } as never);

    const formData = new FormData();
    formData.set("siteId", "site-blog-hub");
    formData.set("siteName", "Blog Hub");

    await saveWebflowSite(formData);

    const row = await rowFor(connection.id);
    expect(row.siteId).toBe("site-blog-hub");
    expect(row.siteName).toBe("Blog Hub");
    expect(row.collectionId).toBeNull();
    expect(row.collectionName).toBeNull();
    expect(row.fieldMapping).toEqual({});
  });

  it("saveWebflowCollection: re-selecting the SAME collection leaves the row untouched and never calls getCollection", async () => {
    const { tenant, connection } = await seedConnection();
    vi.mocked(getServerSession).mockResolvedValue({ user: { tenantId: tenant.id } } as never);

    const formData = new FormData();
    formData.set("collectionId", "collection-blog");

    await saveWebflowCollection(formData);

    const row = await rowFor(connection.id);
    expect(row.collectionId).toBe("collection-blog");
    expect(row.collectionName).toBe("Blog");
    expect(row.fieldMapping).toEqual(HAND_TUNED_MAPPING);
    expect(getCollection).not.toHaveBeenCalled();
  });

  it("saveWebflowCollection: selecting a DIFFERENT collection re-suggests the mapping for the new schema", async () => {
    const { tenant, connection } = await seedConnection();
    vi.mocked(getServerSession).mockResolvedValue({ user: { tenantId: tenant.id } } as never);
    vi.mocked(getCollection).mockResolvedValue({
      id: "collection-changelog",
      displayName: "Changelog",
      slug: "changelog",
      fields: [{ id: "f1", slug: "name", displayName: "Name", type: "PlainText", isRequired: true }],
    });

    const formData = new FormData();
    formData.set("collectionId", "collection-changelog");

    await saveWebflowCollection(formData);

    const row = await rowFor(connection.id);
    expect(row.collectionId).toBe("collection-changelog");
    expect(row.collectionName).toBe("Changelog");
    expect(row.fieldMapping).not.toEqual(HAND_TUNED_MAPPING);
  });

  it("saveWebflowSite: requires siteName, matching the required-field gate used everywhere else", async () => {
    const { tenant } = await seedConnection();
    vi.mocked(getServerSession).mockResolvedValue({ user: { tenantId: tenant.id } } as never);

    const formData = new FormData();
    formData.set("siteId", "site-blog-hub");
    // siteName intentionally omitted.

    await expect(saveWebflowSite(formData)).rejects.toThrow('"siteName" is required.');
  });
});
