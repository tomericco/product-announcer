import { eq } from "drizzle-orm";
import { db as defaultDb } from "../db";
import { tenants, tenantMembers, users } from "../db/schema";
import { deriveDefaultTenantName } from "./tenant";

export type SessionTenantInfo = {
  userId: string;
  tenantId: string;
  role: "owner" | "member";
};

export async function getOrCreateTenantForUser(
  input: { email: string; name?: string | null; githubId: string },
  database: typeof defaultDb = defaultDb
): Promise<SessionTenantInfo> {
  const existingUsers = await database.select().from(users).where(eq(users.githubId, input.githubId)).limit(1);

  const userId =
    existingUsers.length > 0
      ? existingUsers[0].id
      : (
          await database
            .insert(users)
            .values({ email: input.email, name: input.name ?? null, githubId: input.githubId })
            .returning({ id: users.id })
        )[0].id;

  const existingMemberships = await database
    .select()
    .from(tenantMembers)
    .where(eq(tenantMembers.userId, userId))
    .limit(1);

  if (existingMemberships.length > 0) {
    const membership = existingMemberships[0];
    return { userId, tenantId: membership.tenantId, role: membership.role };
  }

  const [tenant] = await database
    .insert(tenants)
    .values({ name: deriveDefaultTenantName(input.email) })
    .returning({ id: tenants.id });

  await database.insert(tenantMembers).values({
    tenantId: tenant.id,
    userId,
    role: "owner",
  });

  return { userId, tenantId: tenant.id, role: "owner" };
}
