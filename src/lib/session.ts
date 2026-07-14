import { getServerSession, type Session } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "./auth";

export function hasValidSession(session: Session | null): session is Session {
  return Boolean(session?.user?.tenantId);
}

export async function requireSession(): Promise<Session> {
  const session = await getServerSession(authOptions);
  if (!hasValidSession(session)) {
    redirect("/api/auth/signin");
  }
  return session;
}
