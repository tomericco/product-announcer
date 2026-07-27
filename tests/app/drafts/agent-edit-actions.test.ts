import { describe, it, expect, vi, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, releases, users } from "../../../src/db/schema";

const TENANT_NAME = "Agent Edit Test Tenant";
const OTHER_NAME = "Agent Edit Other Tenant";
const USER_EMAIL = "agent-edit-test@example.com";
let currentTenantId = "";
let currentUserId: string | null = null;

vi.mock("../../../src/lib/workspace/session", () => ({
  requireSession: vi.fn(async () => ({ user: { tenantId: currentTenantId, id: currentUserId } })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

const editReleaseBody = vi.fn(async (..._args: unknown[]) => "revised text");
vi.mock("../../../src/lib/ai/edit", () => ({ editReleaseBody: (...a: unknown[]) => editReleaseBody(...a) }));

import { requestAgentEdit, saveDraftBody } from "../../../src/app/(dashboard)/drafts/[releaseId]/actions";

async function seed(body = "Original body") {
  const [tenant] = await db.insert(tenants).values({ name: TENANT_NAME }).returning();
  const [user] = await db.insert(users).values({ email: USER_EMAIL }).returning();
  currentTenantId = tenant.id;
  currentUserId = user.id;
  const [release] = await db.insert(releases).values({ tenantId: tenant.id, title: "T", body }).returning();
  return { tenant, release };
}
async function rowFor(id: string) {
  const [row] = await db.select().from(releases).where(eq(releases.id, id));
  return row;
}

describe("requestAgentEdit", () => {
  afterEach(async () => {
    editReleaseBody.mockClear();
    await db.delete(tenants).where(eq(tenants.name, TENANT_NAME));
    await db.delete(tenants).where(eq(tenants.name, OTHER_NAME));
    await db.delete(users).where(eq(users.email, USER_EMAIL));
  });

  it("returns the agent text for an owned release and passes the live body through", async () => {
    const { release } = await seed();
    const result = await requestAgentEdit({
      releaseId: release.id,
      mode: "selection",
      instruction: "punchier",
      fullBody: "live edited body",
      excerpt: "old",
    });
    expect(result).toEqual({ text: "revised text" });
    expect(editReleaseBody).toHaveBeenCalledTimes(1);
    expect(editReleaseBody.mock.calls[0][0]).toMatchObject({
      mode: "selection",
      instruction: "punchier",
      currentBody: "live edited body",
      excerpt: "old",
    });
  });

  it("refuses a foreign release and never calls the agent", async () => {
    await seed();
    const [other] = await db.insert(tenants).values({ name: OTHER_NAME }).returning();
    const [foreign] = await db.insert(releases).values({ tenantId: other.id, title: "X", body: "b" }).returning();
    await expect(
      requestAgentEdit({ releaseId: foreign.id, mode: "whole", instruction: "x", fullBody: "b" })
    ).rejects.toThrow();
    expect(editReleaseBody).not.toHaveBeenCalled();
  });
});

describe("saveDraftBody", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT_NAME));
    await db.delete(users).where(eq(users.email, USER_EMAIL));
  });

  it("updates only the body and stamps bodyEditedAt, leaving the title intact", async () => {
    const { release } = await seed("Original body");
    await saveDraftBody({ releaseId: release.id, body: "Agent-revised body" });
    const row = await rowFor(release.id);
    expect(row.body).toBe("Agent-revised body");
    expect(row.title).toBe("T");
    expect(row.bodyEditedAt).not.toBeNull();
  });

  it("keeps the existing body when handed a blank one (blank-guard)", async () => {
    const { release } = await seed("Original body");
    await saveDraftBody({ releaseId: release.id, body: "   " });
    const row = await rowFor(release.id);
    expect(row.body).toBe("Original body");
    expect(row.bodyEditedAt).toBeNull();
  });
});
