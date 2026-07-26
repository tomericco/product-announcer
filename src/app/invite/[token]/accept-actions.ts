"use server";

import { redirect } from "next/navigation";
import { requireSession } from "@/lib/workspace/session";
import { setActiveTenant } from "@/lib/workspace/active-tenant";
import { acceptInviteForUser } from "@/lib/workspace/accept-invite";

export async function acceptInvite(token: string): Promise<void> {
  const session = await requireSession();
  const result = await acceptInviteForUser(session.user.id, token);
  // Written as a negated joined/already_member check (rather than the more
  // natural `status === "invalid" || ... === "expired" || ... === "revoked"`)
  // because TS's control-flow analysis doesn't narrow discriminated unions
  // across an if-block whose "throw" arm is a disjunction of literal
  // equality checks against the OTHER variant — confirmed against tsc 5.9.3.
  // This De Morgan-equivalent form narrows `result` to the joined/already_member
  // branch below.
  if (result.status !== "joined" && result.status !== "already_member") {
    // Fall through to the page, which re-validates and renders the error state.
    redirect(`/invite/${token}`);
  }
  // joined or already_member → make the workspace active and land in the app.
  await setActiveTenant(result.tenantId, session.user.id);
  redirect("/");
}
