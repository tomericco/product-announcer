export type OnboardingStep = 1 | 2 | 3 | 4;

export const ONBOARDING_STEP_PATHS: Record<OnboardingStep, string> = {
  1: "/onboarding/workspace",
  2: "/onboarding/brand",
  3: "/onboarding/connect",
  4: "/onboarding/schedule",
};

export const LAST_ONBOARDING_STEP: OnboardingStep = 4;

/** Coerce anything the column could hold into a real step. */
export function clampStep(value: number): OnboardingStep {
  if (!Number.isFinite(value) || value <= 1) return 1;
  if (value >= LAST_ONBOARDING_STEP) return LAST_ONBOARDING_STEP;
  return Math.floor(value) as OnboardingStep;
}

/**
 * Where a request for `requestedStep` should go: a path to redirect to, or null
 * to render the step.
 *
 * Going BACK is allowed (the routes are real URLs and the browser Back button is
 * the only way back through the wizard); jumping AHEAD is not, since a later
 * step's screen assumes the earlier answers exist.
 */
export function resolveOnboardingRedirect({
  completed,
  storedStep,
  requestedStep,
}: {
  completed: boolean;
  storedStep: number;
  requestedStep: OnboardingStep;
}): string | null {
  if (completed) return "/board";
  const stored = clampStep(storedStep);
  if (stored < requestedStep) return ONBOARDING_STEP_PATHS[stored];
  return null;
}
