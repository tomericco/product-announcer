import { NextResponse } from "next/server";
import { requireSession } from "@/lib/workspace/session";
import { buildAuthorizeUrl } from "@/lib/integrations/notion/oauth";

export async function GET() {
  const session = await requireSession();
  // state carries the tenant id (verified in the callback against the session)
  // and where to return the user, mirroring the GitHub setup route's state.
  return NextResponse.redirect(buildAuthorizeUrl(`${session.user.tenantId}|integrations`));
}
