import { redirect } from "next/navigation";
import { requireSession } from "@/lib/workspace/session";
import { isOnboardingComplete } from "@/lib/workspace/onboarding";

export default async function HomePage() {
  const session = await requireSession();
  const complete = await isOnboardingComplete(session.user.tenantId);
  redirect(complete ? "/board" : "/onboarding");
}
