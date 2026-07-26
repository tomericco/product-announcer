import { and, asc, eq } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { tenantMembers, users } from "@/db/schema";

export type WorkspaceMember = {
  userId: string;
  email: string;
  name: string | null;
  role: "owner" | "member";
  createdAt: Date;
};

export async function listWorkspaceMembers(
  tenantId: string,
  database: typeof defaultDb = defaultDb
): Promise<WorkspaceMember[]> {
  return database
    .select({
      userId: users.id,
      email: users.email,
      name: users.name,
      role: tenantMembers.role,
      createdAt: tenantMembers.createdAt,
    })
    .from(tenantMembers)
    .innerJoin(users, eq(users.id, tenantMembers.userId))
    .where(eq(tenantMembers.tenantId, tenantId))
    // owners before members, then oldest first.
    .orderBy(asc(tenantMembers.role), asc(tenantMembers.createdAt));
}

/**
 * Remove a member from a workspace by deleting their membership row. Only the
 * membership is removed — the user keeps their other workspaces, and no
 * tenant-scoped data is touched (domain data belongs to the tenant, not the
 * user).
 *
 * Callers must already have authorized this as an owner action (via
 * requireRole). The self-removal guard here means the acting owner always
 * remains, so a workspace can never be left without an owner through this path.
 * Deleting a non-member is a harmless no-op.
 */
export async function removeWorkspaceMember(
  tenantId: string,
  actingUserId: string,
  targetUserId: string,
  database: typeof defaultDb = defaultDb
): Promise<{ removed: boolean }> {
  if (actingUserId === targetUserId) {
    throw new Error("You can't remove yourself from the workspace.");
  }

  const deleted = await database
    .delete(tenantMembers)
    .where(and(eq(tenantMembers.tenantId, tenantId), eq(tenantMembers.userId, targetUserId)))
    .returning({ userId: tenantMembers.userId });

  return { removed: deleted.length > 0 };
}
