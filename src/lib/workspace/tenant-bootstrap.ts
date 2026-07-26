import { eq } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { tenants, tenantMembers, users } from "@/db/schema";
import { deriveDefaultTenantName } from "./tenant";

export type OAuthProvider = "github" | "google";

export type SessionTenantInfo = {
  userId: string;
  tenantId: string;
  role: "owner" | "member";
};

export type OAuthUserInput = {
  email: string;
  emailVerified: boolean;
  name?: string | null;
  provider: OAuthProvider;
  providerAccountId: string;
};

/**
 * Provider-agnostic sign-in bootstrap.
 *
 * Users are keyed by their unique, verified email so the same person signing in
 * with a second provider lands on the same account instead of a duplicate. A
 * user with no workspace gets a default one (owner). Existing memberships are
 * left untouched (signing in never removes you from a workspace).
 */
export async function getOrCreateUserFromOAuth(
  input: OAuthUserInput,
  database: typeof defaultDb = defaultDb
): Promise<SessionTenantInfo> {
  // Security: only ever trust/link an identity whose email the provider has
  // verified. Otherwise an attacker could register an unverified address that
  // collides with a victim's email and take over their account.
  if (!input.emailVerified) {
    throw new Error(`Refusing ${input.provider} sign-in: email address is not verified.`);
  }

  // Link by email (the cross-provider key). Fall back to provider id for the
  // rare case where a row exists without an email match.
  const [existingByEmail] = await database.select().from(users).where(eq(users.email, input.email)).limit(1);

  let userId: string;
  if (existingByEmail) {
    userId = existingByEmail.id;
    // Attach this provider's id if the account doesn't have it yet.
    const currentProviderId =
      input.provider === "github" ? existingByEmail.githubId : existingByEmail.googleId;
    if (!currentProviderId) {
      await database.update(users).set({ [input.provider === "github" ? "githubId" : "googleId"]: input.providerAccountId }).where(eq(users.id, userId));
    }
  } else {
    const [created] = await database
      .insert(users)
      .values({
        email: input.email,
        name: input.name ?? null,
        [input.provider === "github" ? "githubId" : "googleId"]: input.providerAccountId,
      })
      .returning({ id: users.id });
    userId = created.id;
  }

  const [existingMembership] = await database
    .select()
    .from(tenantMembers)
    .where(eq(tenantMembers.userId, userId))
    .limit(1);

  if (existingMembership) {
    return { userId, tenantId: existingMembership.tenantId, role: existingMembership.role };
  }

  const [tenant] = await database
    .insert(tenants)
    .values({ name: deriveDefaultTenantName(input.email) })
    .returning({ id: tenants.id });

  await database.insert(tenantMembers).values({ tenantId: tenant.id, userId, role: "owner" });

  return { userId, tenantId: tenant.id, role: "owner" };
}
