import { redirect } from "next/navigation";
import { requireSession } from "@/lib/workspace/session";
import { getOnboardingState } from "@/lib/workspace/onboarding";
import { ONBOARDING_STEP_PATHS, clampStep } from "@/lib/workspace/onboarding-step";

/**
 * Entry point and OAuth return target. GitHub's connect/setup routes resolve
 * returnTo=onboarding to this path, so it must always forward somewhere real.
 */
export default async function OnboardingPage() {
  const session = await requireSession();
  const { completed, storedStep } = await getOnboardingState(session.user.tenantId);
  if (completed) redirect("/atomic-updates");
  redirect(ONBOARDING_STEP_PATHS[clampStep(storedStep)]);
}
