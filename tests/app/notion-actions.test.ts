import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, notionConnections } from "../../src/db/schema";
import { encryptSecret } from "../../src/lib/credentials/encryption";

const TENANT = "Notion Actions Test Tenant";
/** File-unique: the Notion webhook route selects connections by workspace id
 * with no tenant scope, so a shared id makes these rows part of another
 * file's fan-out. See tests/app/api/webhooks/notion/route.test.ts. */
const WORKSPACE = "ws-notion-actions";
let currentTenantId = "";
process.env.CREDENTIALS_ENCRYPTION_KEY = process.env.CREDENTIALS_ENCRYPTION_KEY ?? "a".repeat(64);

vi.mock("../../src/lib/workspace/session", () => ({
  requireSession: vi.fn(async () => ({ user: { tenantId: currentTenantId, id: "user-1" } })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../../src/lib/integrations/notion/client", () => ({
  getDatabaseProperties: vi.fn(async () => [
    { id: "s1", name: "Status", type: "status", options: [{ id: "o1", name: "Done" }, { id: "o2", name: "In progress" }] },
  ]),
  listDatabases: vi.fn(async () => [{ id: "db1", title: "Tasks" }]),
}));

import { saveNotionDatabase, saveNotionCompletion, disconnectNotion } from "../../src/app/(dashboard)/integrations/notion-actions";

async function seed(status: "misconfigured" | "active" = "misconfigured", overrides = {}) {
  const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning({ id: tenants.id });
  currentTenantId = tenant.id;
  const at = encryptSecret("access");
  await db.insert(notionConnections).values({
    tenantId: tenant.id,
    accessTokenCiphertext: at.ciphertext,
    accessTokenIv: at.iv,
    accessTokenAuthTag: at.authTag,
    workspaceId: WORKSPACE,
    status,
    ...overrides,
  });
}

function formData(entries: Record<string, string | string[]>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) {
    if (Array.isArray(v)) v.forEach((item) => fd.append(k, item));
    else fd.set(k, v);
  }
  return fd;
}

describe("notion connect-flow actions", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("saves the selected database and clears any prior completion mapping", async () => {
    await seed("active", { databaseId: "old", statusPropertyId: "old-prop", doneValues: ["X"] });
    const result = await saveNotionDatabase(formData({ databaseId: "db1", databaseName: "Tasks" }));
    expect(result).toEqual({ ok: true });
    const [conn] = await db.select().from(notionConnections).where(eq(notionConnections.tenantId, currentTenantId));
    expect(conn.databaseId).toBe("db1");
    expect(conn.statusPropertyId).toBeNull();
    expect(conn.doneValues).toEqual([]);
    expect(conn.status).toBe("misconfigured");
  });

  it("saves the completion mapping and flips the connection to active", async () => {
    await seed("misconfigured", { databaseId: "db1", databaseName: "Tasks" });
    const result = await saveNotionCompletion(
      formData({ statusPropertyId: "s1", statusPropertyName: "Status", doneValues: ["Done"] })
    );
    expect(result).toEqual({ ok: true });
    const [conn] = await db.select().from(notionConnections).where(eq(notionConnections.tenantId, currentTenantId));
    expect(conn.statusPropertyId).toBe("s1");
    expect(conn.doneValues).toEqual(["Done"]);
    expect(conn.status).toBe("active");
  });

  it("rejects a completion save with no done values", async () => {
    await seed("misconfigured", { databaseId: "db1", databaseName: "Tasks" });
    const result = await saveNotionCompletion(formData({ statusPropertyId: "s1", statusPropertyName: "Status" }));
    expect(result.ok).toBe(false);
  });

  it("disconnect deletes the connection", async () => {
    await seed("active", { databaseId: "db1" });
    await disconnectNotion();
    const rows = await db.select().from(notionConnections).where(eq(notionConnections.tenantId, currentTenantId));
    expect(rows).toHaveLength(0);
  });
});
