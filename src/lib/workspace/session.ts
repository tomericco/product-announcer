import { getServerSession, type Session } from "next-auth";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { authOptions } from "./auth";
import { db as defaultDb } from "@/db";
import { tenants } from "@/db/schema";

export function hasValidSession(session: Session | null): session is Session {
  return Boolean(session?.user?.tenantId);
}

// A session's JWT can outlive the tenant row it points at (a deleted tenant,
// a database restored from an older backup, a wiped dev database). The app
// uses the JWT session strategy with no database adapter, so the token
// itself never notices — it keeps carrying the stale tenantId for the life
// of the cookie. A single indexed primary-key lookup is cheap enough to run
// on every guarded request.
export async function tenantExists(tenantId: string, database: typeof defaultDb = defaultDb): Promise<boolean> {
  const [row] = await database.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  return Boolean(row);
}

export async function requireSession(): Promise<Session> {
  const session = await getServerSession(authOptions);
  if (!hasValidSession(session)) {
    redirect("/api/auth/signin");
  }
  if (!(await tenantExists(session.user.tenantId))) {
    // The user still holds a valid JWT, so redirecting to the signin page
    // would just bounce them back here (already-authenticated) and loop.
    // /api/auth/signout is unguarded (not wrapped by requireSession or any
    // layout that is) and its GET renders NextAuth's confirm page, which
    // clears the session cookie once confirmed — the next sign-in re-runs
    // tenant bootstrap and the user recovers on their own.
    redirect("/api/auth/signout");
  }
  return session;
}
