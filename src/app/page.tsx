import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/workspace/auth";
import { hasValidSession, requireSession } from "@/lib/workspace/session";
import { isOnboardingComplete } from "@/lib/workspace/onboarding";
import { LandingPage } from "@/components/marketing/landing-page";

/**
 * `/`: public marketing page for signed-out visitors, dashboard entry point
 * for everyone else. Checked ourselves rather than calling requireSession()
 * unconditionally, because requireSession() redirects straight to /signin on
 * a missing session -- which is exactly the behaviour we need to *not* have
 * here. A valid session still goes through requireSession() for the real
 * tenant-resolution/work-email-required logic, unchanged from before.
 */
export default async function HomePage() {
  const session = await getServerSession(authOptions);
  if (!hasValidSession(session)) {
    return <LandingPage />;
  }

  const authedSession = await requireSession();
  const complete = await isOnboardingComplete(authedSession.user.tenantId);
  redirect(complete ? "/board" : "/onboarding");
}
