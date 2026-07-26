import { describe, it, expect, afterEach } from "vitest";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, tenantInvites } from "../../../src/db/schema";
import { createInvite, validateInvite, revokeActiveInvite, getActiveInvite, hashInviteToken } from "../../../src/lib/workspace/invites";

describe("invites", () => {
  let tenantId: string;
  afterEach(async () => {
    if (tenantId) {
      await db.delete(tenantInvites).where(eq(tenantInvites.tenantId, tenantId));
      await db.delete(tenants).where(eq(tenants.id, tenantId));
    }
  });
  async function tenant(name = "Invite Test WS") {
    const [t] = await db.insert(tenants).values({ name }).returning();
    tenantId = t.id;
    return t;
  }
  // Counts rows that actually satisfy "active" (not revoked, not expired) —
  // unlike getActiveInvite's LIMIT 1 select, this proves there is exactly one.
  async function activeInviteCount(tid: string): Promise<number> {
    const rows = await db
      .select({ id: tenantInvites.id })
      .from(tenantInvites)
      .where(
        and(
          eq(tenantInvites.tenantId, tid),
          isNull(tenantInvites.revokedAt),
          gt(tenantInvites.expiresAt, new Date())
        )
      );
    return rows.length;
  }

  it("creates a valid, resolvable invite", async () => {
    const t = await tenant();
    const { token } = await createInvite(t.id, null as unknown as string);
    const res = await validateInvite(token);
    expect(res).toEqual({ status: "valid", tenantId: t.id, tenantName: "Invite Test WS" });
  });

  it("stores only the hash, never the raw token", async () => {
    const t = await tenant();
    const { token } = await createInvite(t.id, null as unknown as string);
    const [row] = await db.select().from(tenantInvites).where(eq(tenantInvites.tenantId, t.id));
    expect(row.tokenHash).toBe(hashInviteToken(token));
    expect(row.tokenHash).not.toBe(token);
  });

  it("regenerating supersedes the previous link", async () => {
    const t = await tenant();
    const first = await createInvite(t.id, null as unknown as string);
    const second = await createInvite(t.id, null as unknown as string);
    expect(await validateInvite(first.token)).toEqual({ status: "revoked" });
    expect((await validateInvite(second.token)).status).toBe("valid");
    expect(await activeInviteCount(t.id)).toBe(1);
  });

  it("converges to exactly one active row under concurrent creates", async () => {
    const t = await tenant();
    const results = await Promise.all([
      createInvite(t.id, null as unknown as string),
      createInvite(t.id, null as unknown as string),
      createInvite(t.id, null as unknown as string),
    ]);
    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(typeof r.token).toBe("string");
    }
    expect(await activeInviteCount(t.id)).toBe(1);
  });

  it("revoking invalidates the active link", async () => {
    const t = await tenant();
    const { token } = await createInvite(t.id, null as unknown as string);
    await revokeActiveInvite(t.id);
    expect(await validateInvite(token)).toEqual({ status: "revoked" });
    expect(await getActiveInvite(t.id)).toBeNull();
  });

  it("reports an expired link", async () => {
    const t = await tenant();
    const { token } = await createInvite(t.id, null as unknown as string);
    const hash = hashInviteToken(token);
    await db.update(tenantInvites).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(tenantInvites.tokenHash, hash));
    expect(await validateInvite(token)).toEqual({ status: "expired" });
  });

  it("reports an unknown token as invalid", async () => {
    expect(await validateInvite("not-a-real-token")).toEqual({ status: "invalid" });
  });
});
