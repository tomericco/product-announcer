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

function hasUniqueViolationCode(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "23505"
  );
}

function isUniqueViolation(err: unknown): boolean {
  // node-postgres throws a raw error with `.code`. Drizzle wraps that in a
  // DrizzleQueryError and preserves the original as `.cause`, so check both.
  if (hasUniqueViolationCode(err)) return true;
  const cause = typeof err === "object" && err !== null && "cause" in err ? (err as { cause?: unknown }).cause : undefined;
  return hasUniqueViolationCode(cause);
}

const CREATE_INVITE_MAX_ATTEMPTS = 5;

/**
 * Mint a fresh invite link, superseding any currently-active one for the tenant.
 * Returns the raw token exactly once — it is never stored or recoverable.
 *
 * The supersede (UPDATE) and insert are two separate statements, not one
 * transaction, so two concurrent calls for the same tenant (e.g. a double
 * click on "Generate link") can both pass the UPDATE and then race on the
 * INSERT. The partial unique index `tenant_invites_one_active_per_tenant`
 * (one non-revoked row per tenant) rejects the loser's INSERT with a
 * Postgres unique-violation (23505). Rather than let that propagate as a
 * raw 500, retry the whole supersede+insert on that specific error: the
 * retry's UPDATE will revoke the row the winner just inserted, then its
 * INSERT succeeds. This converges on exactly one active row — last writer
 * wins — and the losing caller simply gets back a token that resolves to a
 * superseded (revoked) link, consistent with mint-on-open semantics.
 */
export async function createInvite(
  tenantId: string,
  createdByUserId: string,
  database: typeof defaultDb = defaultDb
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashInviteToken(token);
  const expiresAt = expiryFromNow();

  for (let attempt = 1; attempt <= CREATE_INVITE_MAX_ATTEMPTS; attempt++) {
    try {
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
    } catch (err: unknown) {
      if (!isUniqueViolation(err) || attempt === CREATE_INVITE_MAX_ATTEMPTS) {
        throw err;
      }
      // Lost the race against a concurrent createInvite for this tenant — retry.
    }
  }

  // Unreachable: the loop above always returns or throws.
  throw new Error("createInvite: exhausted retries");
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
