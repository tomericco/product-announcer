import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { eq, like } from "drizzle-orm";

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => ({ get: () => undefined, set: () => {} })) }));
vi.mock("@/lib/credentials/encryption", () => ({
  encryptSecret: () => ({ ciphertext: "x", iv: "x", authTag: "x" }),
  decryptSecret: () => "tok",
}));
vi.mock("@/lib/integrations/linkedin/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/integrations/linkedin/client")>();
  return { ...actual, listAdminOrganizations: vi.fn() };
});

import { getServerSession } from "next-auth";
import { listAdminOrganizations } from "@/lib/integrations/linkedin/client";
import { db } from "@/db";
import { tenants, linkedinConnections, users, tenantMembers } from "@/db/schema";
import {
  listLinkedinOrganizations,
  saveLinkedinOrganization,
  saveLinkedinBaseUrl,
  disconnectLinkedin,
} from "@/app/(dashboard)/integrations/linkedin-actions";
import { normalizeBaseUrl, isOrganizationUrn } from "@/app/(dashboard)/integrations/linkedin-helpers";

describe("normalizeBaseUrl", () => {
  it("appends a trailing slash", () => {
    expect(normalizeBaseUrl("https://acme.com/changelog")).toBe("https://acme.com/changelog/");
  });
  it("leaves an existing trailing slash", () => {
    expect(normalizeBaseUrl("https://acme.com/changelog/")).toBe("https://acme.com/changelog/");
  });
  it("rejects a relative or non-http URL", () => {
    expect(() => normalizeBaseUrl("/changelog")).toThrow();
    expect(() => normalizeBaseUrl("ftp://acme.com")).toThrow();
  });
});

describe("isOrganizationUrn", () => {
  it("accepts an organization urn", () => {
    expect(isOrganizationUrn("urn:li:organization:123")).toBe(true);
  });
  it("rejects a personal member urn", () => {
    expect(isOrganizationUrn("urn:li:person:123")).toBe(false);
  });
});

const TENANT_NAME = "LinkedIn Actions Test Tenant";
const OTHER_TENANT_NAME = "LinkedIn Actions Other Tenant";
const USER_EMAIL_PREFIX = "linkedin-actions-test-";

// Each seeded tenant needs its own owner membership so requireSession()'s
// cookie-based active-tenant resolution (Task 3) resolves back to it. Emails
// are randomized per call since a single test can seed two tenants/users.
async function seedMember(tenantId: string) {
  const [user] = await db.insert(users).values({ email: `${USER_EMAIL_PREFIX}${crypto.randomUUID()}@example.com` }).returning();
  await db.insert(tenantMembers).values({ tenantId, userId: user.id, role: "owner" });
  return user;
}

async function seedConnection(overrides: Partial<typeof linkedinConnections.$inferInsert> = {}, name = TENANT_NAME) {
  const [tenant] = await db.insert(tenants).values({ name }).returning();
  const user = await seedMember(tenant.id);
  const [connection] = await db
    .insert(linkedinConnections)
    .values({
      tenantId: tenant.id,
      accessTokenCiphertext: "x",
      accessTokenIv: "x",
      accessTokenAuthTag: "x",
      expiresAt: new Date(Date.now() + 3600_000),
      status: "active",
      ...overrides,
    })
    .returning();
  return { tenant, connection, user };
}

async function rowFor(tenantId: string) {
  const [row] = await db.select().from(linkedinConnections).where(eq(linkedinConnections.tenantId, tenantId));
  return row;
}

describe("linkedin server actions", () => {
  beforeEach(() => {
    vi.mocked(getServerSession).mockReset();
    vi.mocked(listAdminOrganizations).mockReset();
  });

  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT_NAME));
    await db.delete(tenants).where(eq(tenants.name, OTHER_TENANT_NAME));
    await db.delete(users).where(like(users.email, `${USER_EMAIL_PREFIX}%`));
  });

  it("saveLinkedinOrganization stores a valid organization urn", async () => {
    const { tenant, user } = await seedConnection();
    vi.mocked(getServerSession).mockResolvedValue({ user: { tenantId: tenant.id, id: user.id } } as never);

    const formData = new FormData();
    formData.set("urn", "urn:li:organization:456");
    formData.set("name", "Acme Co");
    await saveLinkedinOrganization(formData);

    const row = await rowFor(tenant.id);
    expect(row.organizationUrn).toBe("urn:li:organization:456");
    expect(row.organizationName).toBe("Acme Co");
  });

  it("saveLinkedinOrganization rejects a non-organization urn", async () => {
    const { tenant, user } = await seedConnection();
    vi.mocked(getServerSession).mockResolvedValue({ user: { tenantId: tenant.id, id: user.id } } as never);

    const formData = new FormData();
    formData.set("urn", "urn:li:person:456");
    formData.set("name", "A Person");
    await expect(saveLinkedinOrganization(formData)).rejects.toThrow("Only company pages can be selected.");

    const row = await rowFor(tenant.id);
    expect(row.organizationUrn).toBeNull();
  });

  it("saveLinkedinOrganization rejects an empty urn", async () => {
    const { tenant, user } = await seedConnection();
    vi.mocked(getServerSession).mockResolvedValue({ user: { tenantId: tenant.id, id: user.id } } as never);

    const formData = new FormData();
    formData.set("urn", "");
    await expect(saveLinkedinOrganization(formData)).rejects.toThrow("Select an organization.");
  });

  it("saveLinkedinBaseUrl normalizes and stores the base URL", async () => {
    const { tenant, user } = await seedConnection();
    vi.mocked(getServerSession).mockResolvedValue({ user: { tenantId: tenant.id, id: user.id } } as never);

    const formData = new FormData();
    formData.set("baseUrl", "https://acme.com/changelog");
    await saveLinkedinBaseUrl(formData);

    const row = await rowFor(tenant.id);
    expect(row.baseUrl).toBe("https://acme.com/changelog/");
  });

  it("disconnectLinkedin removes only the session tenant's connection", async () => {
    const { tenant, user } = await seedConnection(undefined, TENANT_NAME);
    const { tenant: otherTenant } = await seedConnection(undefined, OTHER_TENANT_NAME);
    vi.mocked(getServerSession).mockResolvedValue({ user: { tenantId: tenant.id, id: user.id } } as never);

    await disconnectLinkedin();

    const row = await rowFor(tenant.id);
    expect(row).toBeUndefined();
    const otherRow = await rowFor(otherTenant.id);
    expect(otherRow).toBeDefined();
  });

  it("listLinkedinOrganizations loads the tenant-scoped connection and delegates to listAdminOrganizations", async () => {
    const { tenant, user } = await seedConnection();
    vi.mocked(getServerSession).mockResolvedValue({ user: { tenantId: tenant.id, id: user.id } } as never);
    vi.mocked(listAdminOrganizations).mockResolvedValue([{ urn: "urn:li:organization:1", name: "Acme" }]);

    const orgs = await listLinkedinOrganizations();

    expect(orgs).toEqual([{ urn: "urn:li:organization:1", name: "Acme" }]);
    expect(listAdminOrganizations).toHaveBeenCalledWith("tok");
  });

  it("listLinkedinOrganizations throws when the tenant has no connection", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT_NAME }).returning();
    const user = await seedMember(tenant.id);
    vi.mocked(getServerSession).mockResolvedValue({ user: { tenantId: tenant.id, id: user.id } } as never);

    await expect(listLinkedinOrganizations()).rejects.toThrow("LinkedIn is not connected.");
  });
});
