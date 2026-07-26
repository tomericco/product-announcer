import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
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
import { tenants, linkedinConnections } from "@/db/schema";
import {
  normalizeBaseUrl,
  isOrganizationUrn,
  listLinkedinOrganizations,
  saveLinkedinOrganization,
  saveLinkedinBaseUrl,
  disconnectLinkedin,
} from "@/app/(dashboard)/integrations/linkedin-actions";

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

async function seedConnection(overrides: Partial<typeof linkedinConnections.$inferInsert> = {}, name = TENANT_NAME) {
  const [tenant] = await db.insert(tenants).values({ name }).returning();
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
  return { tenant, connection };
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
  });

  it("saveLinkedinOrganization stores a valid organization urn", async () => {
    const { tenant } = await seedConnection();
    vi.mocked(getServerSession).mockResolvedValue({ user: { tenantId: tenant.id } } as never);

    const formData = new FormData();
    formData.set("urn", "urn:li:organization:456");
    formData.set("name", "Acme Co");
    await saveLinkedinOrganization(formData);

    const row = await rowFor(tenant.id);
    expect(row.organizationUrn).toBe("urn:li:organization:456");
    expect(row.organizationName).toBe("Acme Co");
  });

  it("saveLinkedinOrganization rejects a non-organization urn", async () => {
    const { tenant } = await seedConnection();
    vi.mocked(getServerSession).mockResolvedValue({ user: { tenantId: tenant.id } } as never);

    const formData = new FormData();
    formData.set("urn", "urn:li:person:456");
    formData.set("name", "A Person");
    await expect(saveLinkedinOrganization(formData)).rejects.toThrow("Only company pages can be selected.");

    const row = await rowFor(tenant.id);
    expect(row.organizationUrn).toBeNull();
  });

  it("saveLinkedinOrganization rejects an empty urn", async () => {
    const { tenant } = await seedConnection();
    vi.mocked(getServerSession).mockResolvedValue({ user: { tenantId: tenant.id } } as never);

    const formData = new FormData();
    formData.set("urn", "");
    await expect(saveLinkedinOrganization(formData)).rejects.toThrow("Select an organization.");
  });

  it("saveLinkedinBaseUrl normalizes and stores the base URL", async () => {
    const { tenant } = await seedConnection();
    vi.mocked(getServerSession).mockResolvedValue({ user: { tenantId: tenant.id } } as never);

    const formData = new FormData();
    formData.set("baseUrl", "https://acme.com/changelog");
    await saveLinkedinBaseUrl(formData);

    const row = await rowFor(tenant.id);
    expect(row.baseUrl).toBe("https://acme.com/changelog/");
  });

  it("disconnectLinkedin removes only the session tenant's connection", async () => {
    const { tenant } = await seedConnection(undefined, TENANT_NAME);
    const { tenant: otherTenant } = await seedConnection(undefined, OTHER_TENANT_NAME);
    vi.mocked(getServerSession).mockResolvedValue({ user: { tenantId: tenant.id } } as never);

    await disconnectLinkedin();

    const row = await rowFor(tenant.id);
    expect(row).toBeUndefined();
    const otherRow = await rowFor(otherTenant.id);
    expect(otherRow).toBeDefined();
  });

  it("listLinkedinOrganizations loads the tenant-scoped connection and delegates to listAdminOrganizations", async () => {
    const { tenant } = await seedConnection();
    vi.mocked(getServerSession).mockResolvedValue({ user: { tenantId: tenant.id } } as never);
    vi.mocked(listAdminOrganizations).mockResolvedValue([{ urn: "urn:li:organization:1", name: "Acme" }]);

    const orgs = await listLinkedinOrganizations();

    expect(orgs).toEqual([{ urn: "urn:li:organization:1", name: "Acme" }]);
    expect(listAdminOrganizations).toHaveBeenCalledWith("tok");
  });

  it("listLinkedinOrganizations throws when the tenant has no connection", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT_NAME }).returning();
    vi.mocked(getServerSession).mockResolvedValue({ user: { tenantId: tenant.id } } as never);

    await expect(listLinkedinOrganizations()).rejects.toThrow("LinkedIn is not connected.");
  });
});
