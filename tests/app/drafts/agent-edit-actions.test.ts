import { describe, it, expect, vi, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, contentPieces, users } from "../../../src/db/schema";

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
  const [release] = await db.insert(contentPieces).values({ tenantId: tenant.id, title: "T", body }).returning();
  return { tenant, release };
}
async function rowFor(id: string) {
  const [row] = await db.select().from(contentPieces).where(eq(contentPieces.id, id));
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
      contentPieceId: release.id,
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
    const [foreign] = await db.insert(contentPieces).values({ tenantId: other.id, title: "X", body: "b" }).returning();
    await expect(
      requestAgentEdit({ contentPieceId: foreign.id, mode: "whole", instruction: "x", fullBody: "b" })
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
    await saveDraftBody({ contentPieceId: release.id, body: "Agent-revised body" });
    const row = await rowFor(release.id);
    expect(row.body).toBe("Agent-revised body");
    expect(row.title).toBe("T");
    expect(row.bodyEditedAt).not.toBeNull();
  });

  it("keeps the existing body when handed a blank one (blank-guard)", async () => {
    const { release } = await seed("Original body");
    await saveDraftBody({ contentPieceId: release.id, body: "   " });
    const row = await rowFor(release.id);
    expect(row.body).toBe("Original body");
    expect(row.bodyEditedAt).toBeNull();
  });
});

// See the equivalent block in save-draft.test.ts for why these paths are gated
// server-side rather than only hidden in the UI.
describe("draft-status gate", () => {
  afterEach(async () => {
    editReleaseBody.mockClear();
    await db.delete(tenants).where(eq(tenants.name, TENANT_NAME));
    await db.delete(users).where(eq(users.email, USER_EMAIL));
  });

  it("requestAgentEdit refuses a published release and never calls the agent", async () => {
    const { release } = await seed();
    await db
      .update(contentPieces)
      .set({ status: "published", publishedAt: new Date() })
      .where(eq(contentPieces.id, release.id));

    await expect(
      requestAgentEdit({ contentPieceId: release.id, mode: "whole", instruction: "x", fullBody: "b" })
    ).rejects.toThrow(/already been published/i);
    // The gate must precede the LLM call — otherwise a stale tab burns tokens
    // producing text that can never be saved.
    expect(editReleaseBody).not.toHaveBeenCalled();
  });

  it("saveDraftBody refuses a published release and leaves its body untouched", async () => {
    const { release } = await seed("Published body");
    await db
      .update(contentPieces)
      .set({ status: "published", publishedAt: new Date() })
      .where(eq(contentPieces.id, release.id));

    await expect(saveDraftBody({ contentPieceId: release.id, body: "Hijacked body" })).rejects.toThrow(
      /already been published/i
    );

    const row = await rowFor(release.id);
    expect(row.body).toBe("Published body");
  });

  it("saveDraftBody refuses an archived piece", async () => {
    const { release } = await seed("Archived body");
    await db.update(contentPieces).set({ status: "archived" }).where(eq(contentPieces.id, release.id));

    await expect(saveDraftBody({ contentPieceId: release.id, body: "Hijacked body" })).rejects.toThrow(
      /archived/i
    );

    const row = await rowFor(release.id);
    expect(row.body).toBe("Archived body");
  });
});
