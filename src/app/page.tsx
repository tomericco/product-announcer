import { redirect } from "next/navigation";
import { requireSession } from "@/lib/session";
import { isOnboardingComplete } from "@/lib/onboarding";

export default async function HomePage() {
  const session = await requireSession();
  const complete = await isOnboardingComplete(session.user.tenantId);
  redirect(complete ? "/pending" : "/onboarding");
}
