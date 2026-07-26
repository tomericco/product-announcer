import { db as defaultDb } from "@/db";
import { tenantMembers } from "@/db/schema";
import { validateInvite } from "./invites";

export type AcceptResult =
  | { status: "joined" | "already_member"; tenantId: string }
  | { status: "invalid" | "expired" | "revoked" };

/**
 * Join `userId` to the invite's workspace. Idempotent and concurrency-safe: the
 * composite PK (tenant_id, user_id) plus ON CONFLICT DO NOTHING guarantees a
 * single membership even under simultaneous accepts, and never re-adds an
 * existing member. Does NOT write cookies (safe to call anywhere); the caller
 * activates the workspace.
 */
export async function acceptInviteForUser(
  userId: string,
  rawToken: string,
  database: typeof defaultDb = defaultDb
): Promise<AcceptResult> {
  const validation = await validateInvite(rawToken, database);
  if (validation.status !== "valid") return validation;

  const inserted = await database
    .insert(tenantMembers)
    .values({ tenantId: validation.tenantId, userId, role: "member" })
    .onConflictDoNothing({ target: [tenantMembers.tenantId, tenantMembers.userId] })
    .returning({ tenantId: tenantMembers.tenantId });

  return {
    status: inserted.length > 0 ? "joined" : "already_member",
    tenantId: validation.tenantId,
  };
}
