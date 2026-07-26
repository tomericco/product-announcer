import { cookies } from "next/headers";
import { asc, eq } from "drizzle-orm";
import type { Session } from "next-auth";
import { db as defaultDb } from "@/db";
import { tenantMembers } from "@/db/schema";

export const ACTIVE_TENANT_COOKIE = "active_tenant_id";

export type Membership = { tenantId: string; role: "owner" | "member"; createdAt: Date };

export async function listUserMemberships(
  userId: string,
  database: typeof defaultDb = defaultDb
): Promise<Membership[]> {
  return database
    .select({ tenantId: tenantMembers.tenantId, role: tenantMembers.role, createdAt: tenantMembers.createdAt })
    .from(tenantMembers)
    .where(eq(tenantMembers.userId, userId))
    .orderBy(asc(tenantMembers.createdAt), asc(tenantMembers.tenantId));
}

/**
 * Resolve which workspace is "active" for this request. Pure read: it validates
 * the cookie value against real memberships and otherwise falls back to the
 * user's earliest workspace. It NEVER writes a cookie — that would throw during
 * a server-component render. Returns null when the user belongs to nothing.
 */
export async function resolveActiveTenant(
  userId: string,
  cookieTenantId: string | undefined,
  database: typeof defaultDb = defaultDb
): Promise<{ tenantId: string; role: "owner" | "member" } | null> {
  const memberships = await listUserMemberships(userId, database);
  if (memberships.length === 0) return null;

  if (cookieTenantId) {
    const match = memberships.find((m) => m.tenantId === cookieTenantId);
    if (match) return { tenantId: match.tenantId, role: match.role };
  }
  const earliest = memberships[0];
  return { tenantId: earliest.tenantId, role: earliest.role };
}

/**
 * Persist the active workspace. Validates membership first so a forged request
 * can't pin the cookie to a workspace the user doesn't belong to. Call only
 * from a server action or route handler (cookie writes are illegal in render).
 */
export async function setActiveTenant(
  tenantId: string,
  userId: string,
  database: typeof defaultDb = defaultDb
): Promise<void> {
  const [membership] = await database
    .select({ tenantId: tenantMembers.tenantId })
    .from(tenantMembers)
    .where(eq(tenantMembers.tenantId, tenantId))
    .limit(1);
  // Belt-and-suspenders: confirm THIS user is the member, not just that a row exists.
  const mine = await listUserMemberships(userId, database);
  if (!membership || !mine.some((m) => m.tenantId === tenantId)) {
    throw new Error("Cannot activate a workspace you are not a member of.");
  }
  const store = await cookies();
  store.set(ACTIVE_TENANT_COOKIE, tenantId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
  });
}

export function requireRole(session: Session, role: "owner"): void {
  if (role === "owner" && session.user.role !== "owner") {
    throw new Error("This action requires the owner role.");
  }
}
