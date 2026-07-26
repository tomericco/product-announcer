import { randomBytes, createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { tenantInvites, tenants } from "@/db/schema";

export const INVITE_LINK_TTL_DAYS = Number(process.env.INVITE_LINK_TTL_DAYS ?? "7");

export function hashInviteToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function expiryFromNow(): Date {
  return new Date(Date.now() + INVITE_LINK_TTL_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * Mint a fresh invite link, superseding any currently-active one for the tenant.
 * Returns the raw token exactly once — it is never stored or recoverable.
 */
export async function createInvite(
  tenantId: string,
  createdByUserId: string,
  database: typeof defaultDb = defaultDb
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashInviteToken(token);
  const expiresAt = expiryFromNow();

  // Supersede first so the partial-unique index (one active per tenant) is satisfied.
  await database
    .update(tenantInvites)
    .set({ revokedAt: new Date() })
    .where(and(eq(tenantInvites.tenantId, tenantId), isNull(tenantInvites.revokedAt)));

  await database.insert(tenantInvites).values({
    tenantId,
    tokenHash,
    createdByUserId: createdByUserId ?? null,
    expiresAt,
  });

  return { token, expiresAt };
}

export async function getActiveInvite(
  tenantId: string,
  database: typeof defaultDb = defaultDb
): Promise<{ expiresAt: Date } | null> {
  const [row] = await database
    .select({ expiresAt: tenantInvites.expiresAt })
    .from(tenantInvites)
    .where(and(eq(tenantInvites.tenantId, tenantId), isNull(tenantInvites.revokedAt)))
    .limit(1);
  if (!row) return null;
  if (row.expiresAt.getTime() <= Date.now()) return null;
  return { expiresAt: row.expiresAt };
}

export async function revokeActiveInvite(
  tenantId: string,
  database: typeof defaultDb = defaultDb
): Promise<void> {
  await database
    .update(tenantInvites)
    .set({ revokedAt: new Date() })
    .where(and(eq(tenantInvites.tenantId, tenantId), isNull(tenantInvites.revokedAt)));
}

export type InviteValidation =
  | { status: "valid"; tenantId: string; tenantName: string }
  | { status: "invalid" | "expired" | "revoked" };

export async function validateInvite(
  rawToken: string,
  database: typeof defaultDb = defaultDb
): Promise<InviteValidation> {
  const tokenHash = hashInviteToken(rawToken);
  const [row] = await database
    .select({
      tenantId: tenantInvites.tenantId,
      revokedAt: tenantInvites.revokedAt,
      expiresAt: tenantInvites.expiresAt,
      tenantName: tenants.name,
    })
    .from(tenantInvites)
    .innerJoin(tenants, eq(tenants.id, tenantInvites.tenantId))
    .where(eq(tenantInvites.tokenHash, tokenHash))
    .limit(1);

  if (!row) return { status: "invalid" };
  if (row.revokedAt) return { status: "revoked" };
  if (row.expiresAt.getTime() <= Date.now()) return { status: "expired" };
  return { status: "valid", tenantId: row.tenantId, tenantName: row.tenantName };
}
