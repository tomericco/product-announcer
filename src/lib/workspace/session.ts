import { getServerSession, type Session } from "next-auth";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { authOptions } from "./auth";
import { ACTIVE_TENANT_COOKIE, resolveActiveTenant } from "./active-tenant";

export function hasValidSession(session: Session | null): session is Session {
  return Boolean(session?.user?.id);
}

/**
 * The single access-control choke point. Resolves the active workspace from the
 * validated cookie (falling back to the user's earliest workspace) and stamps
 * it onto `session.user.tenantId`/`role`, so every existing tenant-scoped query
 * (`WHERE tenantId = session.user.tenantId`) is automatically membership-checked
 * without changes. A user who belongs to no workspace is signed out.
 */
export async function requireSession(): Promise<Session> {
  const session = await getServerSession(authOptions);
  if (!hasValidSession(session)) {
    redirect("/api/auth/signin");
  }
  const store = await cookies();
  const cookieTenantId = store.get(ACTIVE_TENANT_COOKIE)?.value;
  const active = await resolveActiveTenant(session.user.id, cookieTenantId);
  if (!active) {
    // Valid JWT but no membership (deleted workspace, wiped DB). /api/auth/signout
    // is unguarded and clears the cookie; the next sign-in re-bootstraps.
    redirect("/api/auth/signout");
  }
  session.user.tenantId = active.tenantId;
  session.user.role = active.role;
  return session;
}
