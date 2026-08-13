import { redirect } from "next/navigation";
import { requireSession } from "@/lib/workspace/session";
import { getOnboardingState } from "@/lib/workspace/onboarding";
import { ONBOARDING_STEP_PATHS, clampStep } from "@/lib/workspace/onboarding-step";

/**
 * Entry point and OAuth return target. GitHub's connect/setup routes resolve
 * returnTo=onboarding to this path, so it must always forward somewhere real.
 */
export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession();
  const { completed, storedStep } = await getOnboardingState(session.user.tenantId);
  if (completed) redirect("/briefs");

  // GitHub's connect/setup routes land here with ?github_connect=error|success.
  // Carry that query string through to the step page — otherwise a real signal
  // (e.g. the app isn't configured) is dropped and the user just sees an
  // unchanged button with no explanation.
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    if (typeof value === "string") params.set(key, value);
    else if (Array.isArray(value) && value[0] !== undefined) params.set(key, value[0]);
  }
  const qs = params.toString();
  const target = ONBOARDING_STEP_PATHS[clampStep(storedStep)];
  redirect(qs ? `${target}?${qs}` : target);
}
