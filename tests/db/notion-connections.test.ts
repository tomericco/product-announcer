import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, notionConnections, changeEvents } from "../../src/db/schema";

const TENANT = "Notion Connections Schema Test Tenant";

async function seedTenant(): Promise<string> {
  const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning({ id: tenants.id });
  return tenant.id;
}

describe("notion_connections schema", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("stores a connection with encrypted-token columns and done values", async () => {
    const tenantId = await seedTenant();
    const [row] = await db
      .insert(notionConnections)
      .values({
        tenantId,
        accessTokenCiphertext: "aa",
        accessTokenIv: "bb",
        accessTokenAuthTag: "cc",
        workspaceId: "ws-1",
        databaseId: "db-1",
        databaseName: "Tasks",
        statusPropertyId: "prop-1",
        statusPropertyName: "Status",
        doneValues: ["Done", "Shipped"],
        status: "active",
      })
      .returning();
    expect(row.status).toBe("active");
    expect(row.doneValues).toEqual(["Done", "Shipped"]);
    expect(row.refreshTokenCiphertext).toBeNull();
  });

  it("allows a change_event with a null repoId (Notion task)", async () => {
    const tenantId = await seedTenant();
    const [row] = await db
      .insert(changeEvents)
      .values({
        tenantId,
        repoId: null,
        type: "task",
        provider: "notion",
        externalId: "page-123",
        taskTitle: "Add dark mode",
        taskDescription: "Users can toggle a dark theme.",
      })
      .returning({ id: changeEvents.id, repoId: changeEvents.repoId });
    expect(row.repoId).toBeNull();
  });
});
