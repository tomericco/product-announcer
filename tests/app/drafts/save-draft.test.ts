import { describe, it, expect, vi, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, contentPieces, users } from "../../../src/db/schema";

const TENANT_NAME = "Save Draft Test Tenant";
const USER_EMAIL = "save-draft-test@example.com";
let currentTenantId = "";
let currentUserId: string | null = null;

// requireSession() returns a NextAuth Session (tenantId lives under `user`) —
// mirror that shape rather than a flat one, per the existing actions-test
// mocking style (see tests/app/atomic-updates-actions.test.ts).
vi.mock("../../../src/lib/workspace/session", () => ({
  requireSession: vi.fn(async () => ({ user: { tenantId: currentTenantId, id: currentUserId } })),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

import { saveDraft } from "../../../src/app/(dashboard)/drafts/actions";

async function seed(body = "Original body") {
  const [tenant] = await db.insert(tenants).values({ name: TENANT_NAME }).returning();
  const [user] = await db.insert(users).values({ email: USER_EMAIL }).returning();
  currentTenantId = tenant.id;
  currentUserId = user.id;
  const [release] = await db
    .insert(contentPieces)
    .values({ tenantId: tenant.id, title: "Original title", body })
    .returning();
  return { tenant, user, release };
}

async function rowFor(releaseId: string) {
  const [row] = await db.select().from(contentPieces).where(eq(contentPieces.id, releaseId));
  return row;
}

function formDataFor(releaseId: string, title: string, body: string) {
  const fd = new FormData();
  fd.set("contentPieceId", releaseId);
  fd.set("title", title);
  fd.set("body", body);
  return fd;
}

describe("saveDraft bodyEditedAt stamping", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT_NAME));
    await db.delete(users).where(eq(users.email, USER_EMAIL));
  });

  it("stamps bodyEditedAt when the saved body actually changes", async () => {
    const { release } = await seed("Original body");
    expect(release.bodyEditedAt).toBeNull();

    await saveDraft(formDataFor(release.id, "Original title", "Edited body"));

    const row = await rowFor(release.id);
    expect(row.body).toBe("Edited body");
    expect(row.bodyEditedAt).not.toBeNull();
  });

  it("does not stamp bodyEditedAt when the saved body is unchanged", async () => {
    const { release } = await seed("Original body");

    await saveDraft(formDataFor(release.id, "A new title", "Original body"));

    const row = await rowFor(release.id);
    expect(row.title).toBe("A new title");
    expect(row.body).toBe("Original body");
    expect(row.bodyEditedAt).toBeNull();
  });

  it("does not stamp bodyEditedAt when the blank-guard discards a blank submission", async () => {
    const { release } = await seed("Original body");

    // resolveBody() falls back to the existing body when the submitted body
    // is blank but the draft already had real content — that fallback must
    // not count as an edit.
    await saveDraft(formDataFor(release.id, "Original title", "   "));

    const row = await rowFor(release.id);
    expect(row.body).toBe("Original body");
    expect(row.bodyEditedAt).toBeNull();
  });
});

// A release that has left the draft state must not have its stored body
// rewritten: publishing already delivered that text to users, and rejecting
// handed the atomic updates back to the pool. The drafts list only renders
// drafts, so these are reachable only from a stale tab, a bookmark, or a
// crafted request — which is exactly why the guard belongs server-side.
describe("saveDraft draft-status gate", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT_NAME));
    await db.delete(users).where(eq(users.email, USER_EMAIL));
  });

  it("refuses a published release and leaves its body untouched", async () => {
    const { release } = await seed("Published body");
    await db
      .update(contentPieces)
      .set({ status: "published", publishedAt: new Date() })
      .where(eq(contentPieces.id, release.id));

    await expect(saveDraft(formDataFor(release.id, "Hijacked title", "Hijacked body"))).rejects.toThrow(
      /already been published/i
    );

    const row = await rowFor(release.id);
    expect(row.body).toBe("Published body");
    expect(row.title).toBe("Original title");
  });

  it("refuses an archived piece and leaves its body untouched", async () => {
    const { release } = await seed("Archived body");
    await db.update(contentPieces).set({ status: "archived" }).where(eq(contentPieces.id, release.id));

    await expect(saveDraft(formDataFor(release.id, "Hijacked title", "Hijacked body"))).rejects.toThrow(
      /archived/i
    );

    const row = await rowFor(release.id);
    expect(row.body).toBe("Archived body");
    expect(row.title).toBe("Original title");
  });
});
