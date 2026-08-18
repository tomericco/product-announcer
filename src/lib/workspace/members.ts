import { and, asc, eq } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { tenantMembers, users, contentPieces } from "@/db/schema";

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
 * Remove a member from a workspace by deleting their membership row, and
 * clear `assignedTo` on any of this tenant's content pieces that named them
 * — the user keeps their other workspaces and their history elsewhere is
 * untouched, but a board card left pointing at a membership that no longer
 * exists would render "Unassigned" (card.tsx resolves assignedTo against the
 * live member list) while its `<Select value>` still names a user with no
 * matching item.
 *
 * Both writes run in one transaction: a crash between them must not leave a
 * removed membership with its assignments still dangling.
 *
 * Callers must already have authorized this as an owner action (via
 * requireRole). The self-removal guard here means the acting owner always
 * remains, so a workspace can never be left without an owner through this path.
 * Deleting a non-member is a harmless no-op (and touches no content pieces).
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

  return database.transaction(async (tx) => {
    const deleted = await tx
      .delete(tenantMembers)
      .where(and(eq(tenantMembers.tenantId, tenantId), eq(tenantMembers.userId, targetUserId)))
      .returning({ userId: tenantMembers.userId });

    if (deleted.length > 0) {
      await tx
        .update(contentPieces)
        .set({ assignedTo: null })
        .where(and(eq(contentPieces.tenantId, tenantId), eq(contentPieces.assignedTo, targetUserId)));
    }

    return { removed: deleted.length > 0 };
  });
}
