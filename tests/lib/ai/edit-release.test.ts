import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, releases, users, brandProfiles } from "../../../src/db/schema";
import { runWholeEditForRelease } from "../../../src/lib/ai/edit-release";
import type { DraftProgressEvent } from "../../../src/lib/scheduling/draft-progress";
import type { ReviewOutcome } from "../../../src/lib/ai/review-draft";

const TENANT_NAME = "Whole Edit Test Tenant";
const USER_EMAIL = "whole-edit-test@example.com";

async function seed(body = "Original body", title = "Original title") {
  const [tenant] = await db.insert(tenants).values({ name: TENANT_NAME }).returning();
  const [user] = await db.insert(users).values({ email: USER_EMAIL }).returning();
  const [release] = await db.insert(releases).values({ tenantId: tenant.id, title, body }).returning();
  return { tenant, user, release };
}

async function rowFor(releaseId: string) {
  const [row] = await db.select().from(releases).where(eq(releases.id, releaseId));
  return row;
}

describe("runWholeEditForRelease", () => {
  afterEach(async () => {
    const [tenant] = await db.select().from(tenants).where(eq(tenants.name, TENANT_NAME));
    if (tenant) {
      await db.delete(releases).where(eq(releases.tenantId, tenant.id));
      await db.delete(brandProfiles).where(eq(brandProfiles.tenantId, tenant.id));
    }
    await db.delete(users).where(eq(users.email, USER_EMAIL));
    await db.delete(tenants).where(eq(tenants.name, TENANT_NAME));
  });

  it("runs generate→review→save, emits stepped progress, persists the reviewed body, and keeps the title", async () => {
    const { user, release } = await seed();
    const events: DraftProgressEvent[] = [];

    const generateEdit = async () => "generated body";
    const review = async (draft: { title: string; body: string }): Promise<ReviewOutcome> => ({
      finalDraft: { title: draft.title, body: "reviewed body" },
      status: "passed",
      issues: [],
    });

    const result = await runWholeEditForRelease(
      { releaseId: release.id, instruction: "make it shorter", fullBody: "live edited body", editedBy: user.id },
      db,
      (e) => events.push(e),
      { generateEdit, review }
    );

    expect(result).toEqual({ body: "reviewed body" });

    const row = await rowFor(release.id);
    expect(row.body).toBe("reviewed body");
    expect(row.title).toBe("Original title"); // body-only: title never overwritten
    expect(row.bodyEditedAt).not.toBeNull();
    expect(row.editedBy).toBe(user.id);

    const steps = events
      .filter((e): e is Extract<DraftProgressEvent, { type: "step" }> => e.type === "step")
      .map((s) => `${s.key}:${s.status}`);
    expect(steps).toEqual([
      "preparing:start",
      "preparing:done",
      "generating:start",
      "generating:done",
      "reviewing:start",
      "reviewing:done",
      "saving:start",
      "saving:done",
    ]);

    expect(events.at(-1)).toEqual({ type: "done", updateId: release.id, body: "reviewed body" });
  });

  it("returns null and emits an error when the release does not exist", async () => {
    const events: DraftProgressEvent[] = [];
    const result = await runWholeEditForRelease(
      { releaseId: "00000000-0000-0000-0000-000000000000", instruction: "x", fullBody: "y", editedBy: "z" },
      db,
      (e) => events.push(e),
      { generateEdit: async () => "unused", review: async (d) => ({ finalDraft: d, status: "passed", issues: [] }) }
    );
    expect(result).toBeNull();
    expect(events).toEqual([{ type: "error", message: "Update not found." }]);
  });
});
