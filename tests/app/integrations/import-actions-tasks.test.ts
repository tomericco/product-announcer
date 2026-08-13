import { describe, it, expect, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, notionConnections, changeEvents } from "../../../src/db/schema";
import { encryptSecret } from "../../../src/lib/credentials/encryption";

const TENANT = "Import Tasks Actions Test Tenant";
let currentTenantId = "";
process.env.CREDENTIALS_ENCRYPTION_KEY = process.env.CREDENTIALS_ENCRYPTION_KEY ?? "a".repeat(64);

vi.mock("../../../src/lib/workspace/session", () => ({
  requireSession: vi.fn(async () => ({ user: { tenantId: currentTenantId, id: "user-1" } })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../../../src/lib/integrations/notion/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/lib/integrations/notion/client")>();
  return {
    ...actual,
    resolveDataSourceId: vi.fn(async () => "ds-1"),
    listDoneTasks: vi.fn(async () => [
      { pageId: "page-1", title: "Fix SSO 502", url: "https://notion.so/page-1", status: "Done", lastEditedTime: "2026-07-25T18:03:00.000Z" },
      { pageId: "page-2", title: "Dark mode", url: "https://notion.so/page-2", status: "Done", lastEditedTime: "2026-07-20T10:00:00.000Z" },
    ]),
    getPageBodyText: vi.fn(async () => "Body detail."),
  };
});
vi.mock("../../../src/lib/change-events/import-notion-tasks", () => ({
  importSelectedTasks: vi.fn(async () => ({ importedCount: 0, eventIds: [] })),
}));

import {
  listImportableTasks,
  importTasks,
  isNotionConnected,
} from "../../../src/app/(dashboard)/integrations/import-actions";
import { importSelectedTasks } from "../../../src/lib/change-events/import-notion-tasks";

async function seedConnection(overrides: Partial<typeof notionConnections.$inferInsert> = {}) {
  const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning({ id: tenants.id });
  currentTenantId = tenant.id;
  const at = encryptSecret("access");
  await db.insert(notionConnections).values({
    tenantId: tenant.id,
    accessTokenCiphertext: at.ciphertext,
    accessTokenIv: at.iv,
    accessTokenAuthTag: at.authTag,
    workspaceId: "ws-1",
    databaseId: "db-1",
    databaseName: "Tasks",
    statusPropertyId: "prop-status",
    statusPropertyName: "Status",
    doneValues: ["Done"],
    status: "active",
    ...overrides,
  });
  return tenant.id;
}

describe("import Notion tasks actions", () => {
  afterEach(async () => {
    vi.mocked(importSelectedTasks).mockClear();
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("returns [] when there is no active Notion connection", async () => {
    await seedConnection({ status: "misconfigured" });
    expect(await listImportableTasks({})).toEqual({ tasks: [] });
  });

  it("lists Done tasks and flags already-imported ones", async () => {
    const tid = await seedConnection();
    // page-1 already ingested as a (non-excluded) change_event
    await db.insert(changeEvents).values({
      tenantId: tid, repoId: null, type: "task", provider: "notion",
      externalId: "page-1", taskTitle: "Fix SSO 502",
    });
    const { tasks } = await listImportableTasks({});
    expect(tasks.map((t) => t.pageId)).toEqual(["page-1", "page-2"]);
    expect(tasks.find((t) => t.pageId === "page-1")!.imported).toBe(true);
    expect(tasks.find((t) => t.pageId === "page-2")!.imported).toBe(false);
  });

  it("applies the since filter against lastEditedTime", async () => {
    await seedConnection();
    const { tasks } = await listImportableTasks({ since: "2026-07-22T00:00:00Z" });
    expect(tasks.map((t) => t.pageId)).toEqual(["page-1"]); // page-2 (07-20) filtered out
  });

  it("delegates to importSelectedTasks with the tenant, selections, and a getBody fn, and returns its count", async () => {
    const tid = await seedConnection();
    vi.mocked(importSelectedTasks).mockResolvedValueOnce({ importedCount: 1, eventIds: ["evt-1"] });

    const selections = [{ pageId: "page-2", title: "Dark mode", url: "https://notion.so/page-2", completedAt: "2026-07-20T10:00:00.000Z" }];
    const { importedCount } = await importTasks({ selections });

    expect(importedCount).toBe(1);
    expect(importSelectedTasks).toHaveBeenCalledTimes(1);
    const [arg, getBody] = vi.mocked(importSelectedTasks).mock.calls[0];
    expect(arg).toEqual({ tenantId: tid, selections });
    expect(typeof getBody).toBe("function");
  });

  it("returns importedCount: 0 without calling importSelectedTasks when there is no active connection", async () => {
    await seedConnection({ status: "misconfigured" });
    const { importedCount } = await importTasks({
      selections: [{ pageId: "page-1", title: "A", url: "u1", completedAt: null }],
    });
    expect(importedCount).toBe(0);
    expect(importSelectedTasks).not.toHaveBeenCalled();
  });

  it("isNotionConnected reflects an active connection", async () => {
    await seedConnection();
    expect(await isNotionConnected()).toBe(true);
  });
});
