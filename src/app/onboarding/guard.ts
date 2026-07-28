import { redirect } from "next/navigation";
import type { Session } from "next-auth";
import { requireSession } from "@/lib/workspace/session";
import { getOnboardingState } from "@/lib/workspace/onboarding";
import { resolveOnboardingRedirect, type OnboardingStep } from "@/lib/workspace/onboarding-step";

/**
 * Every wizard step page starts with this. Sends finished tenants to the
 * dashboard and anyone who jumped ahead of their stored progress back to the
 * step they are actually on.
 */
export async function guardOnboardingStep(step: OnboardingStep): Promise<Session> {
  const session = await requireSession();
  const { completed, storedStep } = await getOnboardingState(session.user.tenantId);
  const target = resolveOnboardingRedirect({ completed, storedStep, requestedStep: step });
  if (target) redirect(target);
  return session;
}
