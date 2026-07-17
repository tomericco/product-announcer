import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { tenants } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";

export async function GET(request: NextRequest) {
  const session = await requireSession();

  const installationId = request.nextUrl.searchParams.get("installation_id");
  const state = request.nextUrl.searchParams.get("state");
  const [tenantIdFromState, returnTo] = (state ?? "").split("|");

  if (!installationId || tenantIdFromState !== session.user.tenantId) {
    return NextResponse.redirect(new URL("/?github_connect=error", request.url));
  }

  await db
    .update(tenants)
    .set({ githubInstallationId: installationId })
    .where(eq(tenants.id, session.user.tenantId));

  const destination = returnTo === "settings" ? "/settings" : "/onboarding";
  return NextResponse.redirect(new URL(`${destination}?github_connect=success`, request.url));
}
