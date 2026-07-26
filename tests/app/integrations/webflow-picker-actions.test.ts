import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { eq, like } from "drizzle-orm";

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => ({ get: () => undefined, set: () => {} })) }));
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
  return { ...actual, getCollection: vi.fn(), listSites: vi.fn() };
});

import { getServerSession } from "next-auth";
import { getCollection, listSites, WebflowApiError } from "@/lib/integrations/webflow/client";
import { db } from "@/db";
import { tenants, webflowConnections, users, tenantMembers, type WebflowFieldMapping } from "@/db/schema";
import {
  saveWebflowSite,
  saveWebflowCollection,
  saveWebflowMapping,
  saveWebflowToken,
} from "@/app/(dashboard)/integrations/actions";

// Regression coverage for a data-loss bug: saveWebflowSite/saveWebflowCollection
// used to write unconditionally, so re-confirming the CURRENT site or
// collection (e.g. opening "Change site" just to check what's wired up, then
// clicking "Use this site" without changing anything) wiped the collection and
// the user's hand-tuned field mapping for no reason. These tests seed a real
// row with a mapping, call the action with the SAME id, and assert the row —
// and the mapping specifically — is untouched. A sibling "different id" case
// per action proves the guard didn't also break the legitimate change path.

const TENANT_NAME = "Webflow Picker No-Op Guard Test Tenant";
const USER_EMAIL_PREFIX = "webflow-picker-actions-test-";

const HAND_TUNED_MAPPING: WebflowFieldMapping = {
  name: { source: "title" },
  slug: { source: "slug" },
  "post-body": { source: "static", value: "Hand-picked value that took forever to configure" },
};

// Each seeded tenant needs its own owner membership so requireSession()'s
// cookie-based active-tenant resolution (Task 3) resolves back to it.
async function seedMember(tenantId: string) {
  const [user] = await db.insert(users).values({ email: `${USER_EMAIL_PREFIX}${crypto.randomUUID()}@example.com` }).returning();
  await db.insert(tenantMembers).values({ tenantId, userId: user.id, role: "owner" });
  return user;
}

async function seedConnection(overrides: Partial<typeof webflowConnections.$inferInsert> = {}) {
  const [tenant] = await db.insert(tenants).values({ name: TENANT_NAME }).returning();
  const user = await seedMember(tenant.id);
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
  return { tenant, connection, user };
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
    await db.delete(users).where(like(users.email, `${USER_EMAIL_PREFIX}%`));
  });

  it("saveWebflowSite: re-selecting the SAME site leaves the row untouched", async () => {
    const { tenant, connection, user } = await seedConnection();
    vi.mocked(getServerSession).mockResolvedValue({ user: { tenantId: tenant.id, id: user.id } } as never);

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
    const { tenant, connection, user } = await seedConnection();
    vi.mocked(getServerSession).mockResolvedValue({ user: { tenantId: tenant.id, id: user.id } } as never);

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
    const { tenant, connection, user } = await seedConnection();
    vi.mocked(getServerSession).mockResolvedValue({ user: { tenantId: tenant.id, id: user.id } } as never);

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
    const { tenant, connection, user } = await seedConnection();
    vi.mocked(getServerSession).mockResolvedValue({ user: { tenantId: tenant.id, id: user.id } } as never);
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
    const { tenant, user } = await seedConnection();
    vi.mocked(getServerSession).mockResolvedValue({ user: { tenantId: tenant.id, id: user.id } } as never);

    const formData = new FormData();
    formData.set("siteId", "site-blog-hub");
    // siteName intentionally omitted.

    // The action returns a result object rather than throwing: a thrown
    // server-action error's message is stripped in a production build before
    // it reaches the client, which would silence this exact validation.
    await expect(saveWebflowSite(formData)).resolves.toEqual({
      ok: false,
      error: '"siteName" is required.',
    });
  });
});

describe("saveWebflowMapping — returns a result object instead of throwing", () => {
  beforeEach(() => {
    vi.mocked(getServerSession).mockReset();
    vi.mocked(getCollection).mockReset();
  });

  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT_NAME));
    await db.delete(users).where(like(users.email, `${USER_EMAIL_PREFIX}%`));
  });

  it("returns { ok: false, error } when a required field is left unmapped, without throwing", async () => {
    const { tenant, connection, user } = await seedConnection();
    vi.mocked(getServerSession).mockResolvedValue({ user: { tenantId: tenant.id, id: user.id } } as never);
    vi.mocked(getCollection).mockResolvedValue({
      id: "collection-blog",
      displayName: "Blog",
      slug: "blog",
      fields: [{ id: "f1", slug: "name", displayName: "Name", type: "PlainText", isRequired: true }],
    });

    const formData = new FormData();
    // "source:name" intentionally omitted, leaving the required field unmapped.

    const result = await saveWebflowMapping(formData);

    expect(result).toEqual({
      ok: false,
      error: '"Name" is required by Webflow but is not mapped.',
    });
    // The row must be untouched by a rejected save.
    const row = await rowFor(connection.id);
    expect(row.fieldMapping).toEqual(HAND_TUNED_MAPPING);
  });

  it("returns { ok: true } and persists the mapping when every required field is mapped", async () => {
    const { tenant, connection, user } = await seedConnection();
    vi.mocked(getServerSession).mockResolvedValue({ user: { tenantId: tenant.id, id: user.id } } as never);
    vi.mocked(getCollection).mockResolvedValue({
      id: "collection-blog",
      displayName: "Blog",
      slug: "blog",
      fields: [{ id: "f1", slug: "name", displayName: "Name", type: "PlainText", isRequired: true }],
    });

    const formData = new FormData();
    formData.set("source:name", "title");
    formData.set("publishMode", "draft");

    const result = await saveWebflowMapping(formData);

    expect(result).toEqual({ ok: true });
    const row = await rowFor(connection.id);
    expect(row.fieldMapping).toEqual({ name: { source: "title" } });
  });
});

describe("saveWebflowToken — returns a result object instead of throwing", () => {
  const TOKEN_TENANT_NAME = "Webflow Token Save Test Tenant";

  beforeEach(() => {
    vi.mocked(getServerSession).mockReset();
    vi.mocked(listSites).mockReset();
  });

  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TOKEN_TENANT_NAME));
    await db.delete(users).where(like(users.email, `${USER_EMAIL_PREFIX}%`));
  });

  it("returns { ok: false, error } with the real message when the token fails validation, and never stores it", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TOKEN_TENANT_NAME }).returning();
    const user = await seedMember(tenant.id);
    vi.mocked(getServerSession).mockResolvedValue({ user: { tenantId: tenant.id, id: user.id } } as never);
    // A bad Site API token: listSites (called to validate before storing)
    // rejects with a WebflowApiError, same as a real 401 from Webflow.
    vi.mocked(listSites).mockRejectedValue(new WebflowApiError(401, "Webflow rejected the request (401)."));

    const formData = new FormData();
    formData.set("token", "bad-token");

    const result = await saveWebflowToken(formData);

    expect(result).toEqual({ ok: false, error: "Webflow rejected the request (401)." });
    const [row] = await db.select().from(webflowConnections).where(eq(webflowConnections.tenantId, tenant.id));
    expect(row).toBeUndefined();
  });

  it("returns { ok: true } and stores the connection when the token validates", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TOKEN_TENANT_NAME }).returning();
    const user = await seedMember(tenant.id);
    vi.mocked(getServerSession).mockResolvedValue({ user: { tenantId: tenant.id, id: user.id } } as never);
    vi.mocked(listSites).mockResolvedValue([{ id: "site-1", displayName: "Marketing" }]);

    const formData = new FormData();
    formData.set("token", "good-token");

    const result = await saveWebflowToken(formData);

    expect(result).toEqual({ ok: true });
    const [row] = await db.select().from(webflowConnections).where(eq(webflowConnections.tenantId, tenant.id));
    expect(row.status).toBe("active");
  });
});
