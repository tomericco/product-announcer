import { asc, eq } from "drizzle-orm";
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
